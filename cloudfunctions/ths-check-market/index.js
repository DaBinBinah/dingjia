/**
 * ths-check-market —— 价格监控与分红雷达核心
 *
 * 触发：定时触发器（每 10 秒，内部按配置的监控间隔节流）或前端手动调用（event.force=true
 * 可在非交易时间强制拉取一次，用于手动刷新）。
 *
 * 流程：
 * 1. 读取开启的标的 → 按类型批量取行情
 * 2. 价格穿越判断 → 生成价格提醒 → CAS 原子更新标的状态 → AlertService 分发
 * 3. 分红雷达检查 → 计算股权登记日交易日倒计时 → 分红关键节点提醒(10D/5D/3D/1D/TODAY) → AlertService 分发
 * 4. 记录扫描元数据 (scan_state)
 *
 * 红线：本函数只做「获取行情/分红 → 判断价格/日期 → 发出提醒」，全代码库不存在任何
 *       买入/卖出/委托/撤单等交易逻辑。
 */
const cloud = require('@cloudbase/node-sdk');
const { fetchQuotes, fetchTradingDays } = require('./lib/ths-api');
const { fetchUsQuotes, normalizeUsSymbol } = require('./lib/yahoo-api');
const {
  beijingParts,
  getTradingPhase,
  isTradingTime,
  usNewYorkParts,
  getUsTradingPhase,
  isUsTradingTime,
  getTradingDaysBetween,
} = require('./lib/trading-time');
const alertService = require('./lib/alert-service');
const dividendService = require('./lib/dividend-service');
const { assertAccess } = require('./lib/access-guard');

const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
const db = app.database();

const WATCH_COLL = 'ths_watchlist';
const ALERTS_COLL = 'ths_alerts';
const CONFIG_COLL = 'ths_config';
const TOUCH_COLL = 'ths_price_touches';

async function loadSettings() {
  const snap = await db.collection(CONFIG_COLL).where({ key: 'settings' }).limit(1).get();
  const doc = (snap.data && snap.data[0]) || {};
  return {
    monitorIntervalSec: Math.max(10, Math.min(3600, Number(doc.monitorIntervalSec) || 30)),
    holidays: Array.isArray(doc.holidays) ? doc.holidays : [],
  };
}

/** 交易日历缓存：每个北京日只调一次接口，结果存 ths_config.trading_days 文档 */
async function resolveTradingDays(nowMs) {
  const today = beijingParts(nowMs).compactDate;
  const coll = db.collection(CONFIG_COLL);
  const snap = await coll.where({ key: 'trading_days' }).limit(1).get();
  const cache = (snap.data && snap.data[0]) || null;
  if (cache && cache.date === today && Array.isArray(cache.days)) return new Set(cache.days);

  const days = await fetchTradingDays();
  if (!days) return null; // 接口失败 → getTradingPhase 退化为仅星期判断
  const arr = [...days];
  if (cache) await coll.doc(cache._id).update({ date: today, days: arr }).catch(() => {});
  else await coll.add({ key: 'trading_days', date: today, days: arr }).catch(() => {});
  return new Set(arr);
}

exports.main = async (event = {}) => {
  const denied = assertAccess(event);
  if (denied) return denied;

  const isTimer = event.Type === 'Timer' || event.TriggerType === 'Timer';
  const force = !isTimer && event.force === true;
  const startedAt = Date.now();
  const cycleId = `scan_${startedAt}_${Math.random().toString(36).slice(2, 8)}`;

  const settings = await loadSettings();
  const today = beijingParts(startedAt).compactDate;
  const tradingDays = await resolveTradingDays(startedAt).catch(() => null);
  const phase = getTradingPhase({ holidays: settings.holidays, tradingDays, nowMs: startedAt });
  const usPhase = getUsTradingPhase(startedAt);

  const isCnTrading = force || isTradingTime(phase);
  const isUsTrading = force || isUsTradingTime(usPhase);

  // 非交易时间：如果两个市场均未开市且非强制刷新，直接跳过
  if (!isCnTrading && !isUsTrading) {
    return { ok: true, skipped: true, reason: 'non-trading-time', phase, usPhase };
  }

  // 定时路径按配置间隔节流（手动 force 不节流，供用户即时刷新）
  if (!force) {
    const stateSnap = await db.collection(CONFIG_COLL).where({ key: 'scan_state' }).limit(1).get();
    const state = (stateSnap.data && stateSnap.data[0]) || null;
    const intervalMs = settings.monitorIntervalSec * 1000;
    if (state && state.lastScanAt && startedAt - state.lastScanAt < intervalMs - 500) {
      return { ok: true, skipped: true, reason: 'throttled', phase, usPhase };
    }
  }

  const watchSnap = await db.collection(WATCH_COLL).where({ enabled: true }).get();
  const watches = (watchSnap.data || []).filter((w) => w && (w.thsCode || w.code));

  const result = {
    ok: true,
    phase,
    usPhase,
    scanned: watches.length,
    alertsCreated: 0,
    dividendAlertsCreated: 0,
    priceErrors: 0,
    results: [],
    serverTime: startedAt,
  };
  if (!watches.length) return result;

  const quoteMap = {}; // thsCode -> {price, changePercent, prevPrice, ...}
  const failMap = {}; // thsCode -> 失败原因

  // 1. 中国市场 (CN) 标的并发获取（同花顺 API）
  const cnWatches = watches.filter((w) => (w.market || 'CN') === 'CN');
  if (isCnTrading && cnWatches.length) {
    const groups = { stock: [], etf: [] };
    for (const w of cnWatches) {
      const t = w.type || 'stock';
      if (!groups[t]) groups[t] = [];
      groups[t].push(w);
    }
    for (const [type, list] of Object.entries(groups)) {
      if (!list.length) continue;
      try {
        const { quotes, failures } = await fetchQuotes(type, list.map((w) => w.thsCode));
        Object.assign(quoteMap, quotes);
        Object.assign(failMap, failures);
      } catch (e) {
        for (const w of list) failMap[w.thsCode] = e.message;
      }
    }
  }

  // 2. 美国市场 (US) 标的并发获取（Yahoo Finance API）
  const usWatches = watches.filter((w) => w.market === 'US');
  if (isUsTrading && usWatches.length) {
    try {
      const usSymbols = usWatches.map((w) => w.thsCode || w.code);
      const { quotes, failures } = await fetchUsQuotes(usSymbols);
      Object.assign(quoteMap, quotes);
      Object.assign(failMap, failures);
    } catch (e) {
      for (const w of usWatches) failMap[w.thsCode || w.code] = e.message;
    }
  }

  const now = new Date(startedAt);

  for (const w of watches) {
    const key = w.thsCode || w.code;
    const isUs = w.market === 'US';
    // 若当前市场处于休市且未取行情，跳过该标的处理
    if (isUs && !isUsTrading && !quoteMap[key]) continue;
    if (!isUs && !isCnTrading && !quoteMap[key]) continue;

    const quote = quoteMap[key];
    if (!quote) {
      // 行情失败：仅记录错误标记，不更新价格、不做触发判断，绝不中断其他标的
      const reason = failMap[key] || '行情为空';
      result.priceErrors++;
      result.results.push({ code: w.code, market: w.market || 'CN', ok: false, error: reason });
      await db.collection(WATCH_COLL).doc(w._id).update({ quoteError: reason, lastFetchTime: now }).catch(() => {});
      continue;
    }

    const price = quote.price;
    const prev = typeof w.currentPrice === 'number' ? w.currentPrice : null;
    const triggers = []; // 本次要触发的价格提醒类型
    const rearm = {}; // 需要复位（重新武装）的触发标记

    // 跨日重置与当日提醒状态判定
    const lastDate = w.lastFetchTime ? beijingParts(new Date(w.lastFetchTime).getTime()).compactDate : null;
    const isNewTradingDay = lastDate !== today;

    const buyAlertDate = w.lastBuyAlertTime ? beijingParts(new Date(w.lastBuyAlertTime).getTime()).compactDate : null;
    const sellAlertDate = w.lastSellAlertTime ? beijingParts(new Date(w.lastSellAlertTime).getTime()).compactDate : null;
    const buySentToday = buyAlertDate === today;
    const sellSentToday = sellAlertDate === today;

    const buyTriggerLocked = event.rearmAll ? false : (buySentToday || (Boolean(w.buyTriggered) && !isNewTradingDay && Boolean(w.lastBuyAlertTime)));
    const sellTriggerLocked = event.rearmAll ? false : (sellSentToday || (Boolean(w.sellTriggered) && !isNewTradingDay && Boolean(w.lastSellAlertTime)));

    if (prev === null) {
      // 首次观测：若已越过阈值且未锁定，产生首次触达快照与提醒
      if (w.buyPrice != null && price <= w.buyPrice && !buyTriggerLocked) triggers.push('buy');
      if (w.sellPrice != null && price >= w.sellPrice && !sellTriggerLocked) triggers.push('sell');
    } else {
      // 买入线：处于买入目标区且当日未发过（或未加锁）时触发；回升到上方后自动重新武装
      if (w.buyPrice != null) {
        if (!buyTriggerLocked && price <= w.buyPrice) triggers.push('buy');
        else if (w.buyTriggered && price > w.buyPrice) rearm.buyTriggered = false;
      }
      // 卖出线：处于卖出目标区且当日未发过（或未加锁）时触发；回落到下方后自动重新武装
      if (w.sellPrice != null) {
        if (!sellTriggerLocked && price >= w.sellPrice) triggers.push('sell');
        else if (w.sellTriggered && price < w.sellPrice) rearm.sellTriggered = false;
      }
    }

    const baseUpdate = {
      previousPrice: prev,
      currentPrice: price,
      changePercent: quote.changePercent,
      quoteError: null,
      lastFetchTime: now,
      updatedAt: now,
    };

    try {
      if (triggers.length) {
        const upd = { ...baseUpdate, ...rearm };
        for (const t of triggers) {
          upd[`${t}Triggered`] = true;
          upd[t === 'buy' ? 'lastBuyAlertTime' : 'lastSellAlertTime'] = now;
          if (!w[`${t}AchievedAt`]) upd[`${t}AchievedAt`] = now;
          upd.lastTouch = {
            alertType: t,
            targetPrice: t === 'buy' ? w.buyPrice : w.sellPrice,
            triggerPrice: price,
            triggeredAt: now,
            status: 'ACTIVE',
          };
        }
        let claimed = false;
        try {
          const res = await db.collection(WATCH_COLL).doc(w._id).update(upd);
          const updatedCount = Number(
            res && (res.updated != null ? res.updated : res.stats && res.stats.updated != null ? res.stats.updated : 0)
          );
          claimed = updatedCount === 1;
        } catch (_) {}
        if (claimed) {
          for (const t of triggers) {
            const targetP = t === 'buy' ? w.buyPrice : w.sellPrice;
            const isUs = w.market === 'US';
            const touchDoc = {
              watchId: w._id,
              market: isUs ? 'US' : 'CN',
              securityType: w.securityType || (w.type === 'etf' ? 'ETF' : 'STOCK'),
              currency: isUs ? 'USD' : 'CNY',
              timezone: isUs ? 'America/New_York' : 'Asia/Shanghai',
              dataSource: isUs ? 'YAHOO' : 'THS',
              code: w.code,
              name: w.name,
              type: w.type,
              thsCode: w.thsCode || w.code,
              alertType: t,
              targetPrice: targetP,
              triggerPrice: price,
              previousPrice: prev,
              currentPrice: price,
              dayChangePercent: quote.changePercent,
              dayHigh: quote.dayHigh,
              dayLow: quote.dayLow,
              volume: quote.volume,
              turnover: quote.turnover,
              triggeredAt: now,
              detectedAt: now,
              marketDataTime: quote.marketDataTime || now,
              triggerCycleId: cycleId,
              status: 'ACTIVE',
              notificationStatus: 'PENDING',
              source: 'THS_REST_SNAPSHOT',
              createdAt: now,
            };

            // 1. 先保存触达快照（即使通知失败触达历史也绝对不丢）
            let touchId = null;
            try {
              const tRes = await db.collection(TOUCH_COLL).add(touchDoc);
              touchId = tRes.id || (tRes._id);
            } catch (_) {}

            // 2. 发送提醒
            let saved = false;
            let notifErr = null;
            try {
              const alert = alertService.buildAlert(w, t, price, now);
              saved = await alertService.dispatch(db, ALERTS_COLL, alert, w);
            } catch (ne) {
              notifErr = ne.message;
            }

            if (saved) result.alertsCreated++;

            // 3. 回填通知状态
            if (touchId) {
              await db.collection(TOUCH_COLL).doc(touchId).update({
                notificationStatus: saved ? 'SENT' : 'FAILED',
                notificationError: notifErr,
                notifiedAt: new Date(),
              }).catch(() => {});
            }
          }
          result.results.push({ code: w.code, ok: true, triggered: triggers });
        } else {
          result.results.push({ code: w.code, ok: true, note: '并发扫描已处理' });
        }
      } else {
        // 如果离开了目标区域，更新 lastTouch 状态为 RETURNED
        const extraTouchUpd = {};
        if (rearm.buyTriggered === false || rearm.sellTriggered === false) {
          extraTouchUpd['lastTouch.status'] = 'RETURNED';
          // 异步标记触达记录已回落
          db.collection(TOUCH_COLL).where({ watchId: w._id, status: 'ACTIVE' }).update({ status: 'RETURNED' }).catch(() => {});
        }
        await db.collection(WATCH_COLL).doc(w._id).update({ ...baseUpdate, ...rearm, ...extraTouchUpd });
        result.results.push({ code: w.code, ok: true });
      }

      // ---------------- 分红雷达检查 ----------------
      try {
        const divInfo = await dividendService.getDividendData(db, w.type, w.code, {
          currentPrice: price,
          buyPrice: w.buyPrice,
          tradingDays,
          holidays: settings.holidays,
        });

        if (divInfo && divInfo.latest && divInfo.latest.recordDateMs && divInfo.latest.dividendPerShare > 0) {
          const daysLeft = divInfo.tradingDaysLeft;
          let targetAlertType = null;
          if (daysLeft === 10) targetAlertType = 'DIVIDEND_10D';
          else if (daysLeft === 5) targetAlertType = 'DIVIDEND_5D';
          else if (daysLeft === 3) targetAlertType = 'DIVIDEND_3D';
          else if (daysLeft === 1) targetAlertType = 'DIVIDEND_1D';
          else if (daysLeft === 0) targetAlertType = 'DIVIDEND_TODAY';

          if (targetAlertType && w.lastDividendAlertType !== targetAlertType) {
            const divAlert = alertService.buildDividendAlert(w, targetAlertType, {
              ...divInfo.latest,
              tradingDaysLeft: daysLeft,
            }, now);
            const saved = await alertService.dispatch(db, ALERTS_COLL, divAlert, w);
            if (saved) {
              result.dividendAlertsCreated++;
              await db.collection(WATCH_COLL).doc(w._id).update({
                lastDividendAlertType: targetAlertType,
                lastDividendAlertTime: now,
                updatedAt: now,
              }).catch(() => {});
            }
          }
        }
      } catch (divErr) {
        // 单个标的分红检查失败不影响主流程
        console.error(`[ths-check-market] 分红检查异常 (${w.code}):`, divErr.message);
      }
    } catch (e) {
      result.results.push({ code: w.code, ok: false, error: `状态更新失败：${e.message}` });
    }
  }

  // 记录扫描状态：供节流与前端状态栏使用
  const scanState = {
    lastScanAt: startedAt,
    lastScanOk: result.priceErrors === 0,
    lastAlerts: result.alertsCreated + result.dividendAlertsCreated,
  };
  const stateSnap = await db.collection(CONFIG_COLL).where({ key: 'scan_state' }).limit(1).get();
  const stateDoc = (stateSnap.data && stateSnap.data[0]) || null;
  if (stateDoc) await db.collection(CONFIG_COLL).doc(stateDoc._id).update(scanState).catch(() => {});
  else await db.collection(CONFIG_COLL).add({ key: 'scan_state', ...scanState }).catch(() => {});

  return result;
};
