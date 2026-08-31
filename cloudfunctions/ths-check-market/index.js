/**
 * ths-check-market —— 价格监控核心
 *
 * 触发：定时触发器（每 10 秒，内部按配置的监控间隔节流）或前端手动调用（event.force=true
 * 可在非交易时间强制拉取一次，用于手动刷新）。
 *
 * 流程：读取开启的标的 → 按类型批量取行情 → 价格穿越判断 → 生成提醒 →
 *       原子更新标的状态 → AlertService 分发通知。
 *
 * 红线：本函数只做「获取行情 → 判断价格 → 发出提醒」，全代码库不存在任何
 *       买入/卖出/委托/撤单等交易逻辑。
 */
const cloud = require('@cloudbase/node-sdk');
const { fetchQuotes, fetchTradingDays } = require('./lib/ths-api');
const { beijingParts, getTradingPhase, isTradingTime } = require('./lib/trading-time');
const alertService = require('./lib/alert-service');
const { assertAccess } = require('./lib/access-guard');

const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
const db = app.database();

const WATCH_COLL = 'ths_watchlist';
const ALERTS_COLL = 'ths_alerts';
const CONFIG_COLL = 'ths_config';

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

  const settings = await loadSettings();
  const tradingDays = await resolveTradingDays(startedAt).catch(() => null);
  const phase = getTradingPhase({ holidays: settings.holidays, tradingDays, nowMs: startedAt });

  // 非交易时间：定时路径直接跳过，不产生任何行情 API 调用
  if (!force && !isTradingTime(phase)) {
    return { ok: true, skipped: true, reason: 'non-trading-time', phase };
  }

  // 定时路径按配置间隔节流（手动 force 不节流，供用户即时刷新）
  if (!force) {
    const stateSnap = await db.collection(CONFIG_COLL).where({ key: 'scan_state' }).limit(1).get();
    const state = (stateSnap.data && stateSnap.data[0]) || null;
    const intervalMs = settings.monitorIntervalSec * 1000;
    if (state && state.lastScanAt && startedAt - state.lastScanAt < intervalMs - 500) {
      return { ok: true, skipped: true, reason: 'throttled', phase };
    }
  }

  const watchSnap = await db.collection(WATCH_COLL).where({ enabled: true }).get();
  const watches = (watchSnap.data || []).filter((w) => w && w.thsCode);

  const result = {
    ok: true,
    phase,
    scanned: watches.length,
    alertsCreated: 0,
    priceErrors: 0,
    results: [],
    serverTime: startedAt,
  };
  if (!watches.length) return result;

  // 按类型分组取行情；单个类型整体失败不影响另一类型
  const groups = { stock: [], etf: [] };
  for (const w of watches) {
    if (!groups[w.type]) groups[w.type] = [];
    groups[w.type].push(w);
  }
  const quoteMap = {}; // thsCode -> {price, changePercent, prevPrice}
  const failMap = {}; // thsCode -> 失败原因
  for (const [type, list] of Object.entries(groups)) {
    if (!list.length) continue;
    const { quotes, failures } = await fetchQuotes(type, list.map((w) => w.thsCode));
    Object.assign(quoteMap, quotes);
    Object.assign(failMap, failures);
  }

  const now = new Date(startedAt);

  for (const w of watches) {
    const quote = quoteMap[w.thsCode];
    if (!quote) {
      // 行情失败：仅记录错误标记，不更新价格、不做触发判断，绝不中断其他标的
      const reason = failMap[w.thsCode] || '行情为空';
      result.priceErrors++;
      result.results.push({ code: w.code, ok: false, error: reason });
      await db.collection(WATCH_COLL).doc(w._id).update({ quoteError: reason, lastFetchTime: now }).catch(() => {});
      continue;
    }

    const price = quote.price;
    const prev = typeof w.currentPrice === 'number' ? w.currentPrice : null;
    const triggers = []; // 本次要触发的提醒类型
    const rearm = {}; // 需要复位（重新武装）的触发标记

    if (prev === null) {
      // 首次观测：只初始化状态；若已越过阈值且从未触发过，补发一次（视为进入区间）
      if (w.buyPrice != null && price <= w.buyPrice && !w.buyTriggered) triggers.push('buy');
      if (w.sellPrice != null && price >= w.sellPrice && !w.sellTriggered) triggers.push('sell');
    } else {
      // 买入线：仅「从线上方穿越到线下方」触发一次；回到上方后自动重新武装
      if (w.buyPrice != null) {
        if (!w.buyTriggered && prev > w.buyPrice && price <= w.buyPrice) triggers.push('buy');
        else if (w.buyTriggered && price > w.buyPrice) rearm.buyTriggered = false;
      }
      // 卖出线：仅「从下方穿越到上方」触发一次；回到下方后自动重新武装
      if (w.sellPrice != null) {
        if (!w.sellTriggered && prev < w.sellPrice && price >= w.sellPrice) triggers.push('sell');
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
        // 原子抢占：仅当触发标记仍为 false 时更新才生效，防止定时器与手动刷新并发导致重复提醒
        const cond = { _id: w._id };
        const upd = { ...baseUpdate, ...rearm };
        for (const t of triggers) {
          cond[`${t}Triggered`] = false;
          upd[`${t}Triggered`] = true;
          upd[t === 'buy' ? 'lastBuyAlertTime' : 'lastSellAlertTime'] = now;
          // 「已完成」记录（一次性）：曾达成过就永久保留，供前端已达成分类筛选；
          // 仅编辑价格线/代码时由 ths-update-watch 重置
          if (!w[`${t}AchievedAt`]) upd[`${t}AchievedAt`] = now;
        }
        const res = await db.collection(WATCH_COLL).where(cond).update(upd);
        // node-sdk 返回结构随版本不同：{updated: N} 或 {stats: {updated: N}}，两者都兼容
        const updatedCount = Number(
          res && (res.updated != null ? res.updated : res.stats && res.stats.updated != null ? res.stats.updated : 0)
        );
        const claimed = updatedCount === 1;
        if (claimed) {
          for (const t of triggers) {
            const alert = alertService.buildAlert(w, t, price, now);
            const saved = await alertService.dispatch(db, ALERTS_COLL, alert, w);
            if (saved) result.alertsCreated++;
          }
          result.results.push({ code: w.code, ok: true, triggered: triggers });
        } else {
          result.results.push({ code: w.code, ok: true, note: '并发扫描已处理' });
        }
      } else {
        await db.collection(WATCH_COLL).doc(w._id).update({ ...baseUpdate, ...rearm });
        result.results.push({ code: w.code, ok: true });
      }
    } catch (e) {
      result.results.push({ code: w.code, ok: false, error: `状态更新失败：${e.message}` });
    }
  }

  // 记录扫描状态：供节流与前端状态栏使用
  const scanState = {
    lastScanAt: startedAt,
    lastScanOk: result.priceErrors === 0,
    lastAlerts: result.alertsCreated,
  };
  const stateSnap = await db.collection(CONFIG_COLL).where({ key: 'scan_state' }).limit(1).get();
  const stateDoc = (stateSnap.data && stateSnap.data[0]) || null;
  if (stateDoc) await db.collection(CONFIG_COLL).doc(stateDoc._id).update(scanState).catch(() => {});
  else await db.collection(CONFIG_COLL).add({ key: 'scan_state', ...scanState }).catch(() => {});

  return result;
};
