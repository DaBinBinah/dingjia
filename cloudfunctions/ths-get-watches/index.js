/**
 * ths-get-watches —— 监控列表 + 统计 + 行情状态元信息
 * 返回全部标的（含暂停中的），按创建时间倒序；只读。
 * 输入：{ accessCode? }
 */
const cloud = require('@cloudbase/node-sdk');
const { beijingParts, getTradingPhase, getTradingDaysBetween } = require('./lib/trading-time');
const { assertAccess } = require('./lib/access-guard');

const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
const db = app.database();

const WATCH_COLL = 'ths_watchlist';
const ALERTS_COLL = 'ths_alerts';
const CONFIG_COLL = 'ths_config';
const DIVIDEND_COLL = 'ths_dividends';

exports.main = async (event = {}) => {
  const denied = assertAccess(event);
  if (denied) return denied;

  try {
    const nowMs = Date.now();
    const [watchSnap, settingsSnap, stateSnap, daysSnap] = await Promise.all([
      db.collection(WATCH_COLL).orderBy('createdAt', 'desc').limit(200).get(),
      db.collection(CONFIG_COLL).where({ key: 'settings' }).limit(1).get(),
      db.collection(CONFIG_COLL).where({ key: 'scan_state' }).limit(1).get(),
      db.collection(CONFIG_COLL).where({ key: 'trading_days' }).limit(1).get(),
    ]);

    const settingsDoc = (settingsSnap.data && settingsSnap.data[0]) || {};
    const stateDoc = (stateSnap.data && stateSnap.data[0]) || null;
    const daysDoc = (daysSnap.data && daysSnap.data[0]) || null;

    const today = beijingParts(nowMs).compactDate;
    const tradingDays =
      daysDoc && daysDoc.date === today && Array.isArray(daysDoc.days)
        ? new Set(daysDoc.days)
        : null;
    const phase = getTradingPhase({
      holidays: Array.isArray(settingsDoc.holidays) ? settingsDoc.holidays : [],
      tradingDays,
      nowMs,
    });

    const watches = (watchSnap.data || []).map((w) => ({
      _id: w._id,
      type: w.type,
      code: w.code,
      thsCode: w.thsCode,
      name: w.name,
      buyPrice: w.buyPrice != null ? w.buyPrice : null,
      sellPrice: w.sellPrice != null ? w.sellPrice : null,
      targetPrice: w.targetPrice != null ? w.targetPrice : null,
      buyDiscount: w.buyDiscount != null ? w.buyDiscount : null,
      sellDiscount: w.sellDiscount != null ? w.sellDiscount : null,
      enabled: !!w.enabled,
      currentPrice: typeof w.currentPrice === 'number' ? w.currentPrice : null,
      previousPrice: typeof w.previousPrice === 'number' ? w.previousPrice : null,
      changePercent: typeof w.changePercent === 'number' ? w.changePercent : null,
      buyTriggered: !!w.buyTriggered,
      sellTriggered: !!w.sellTriggered,
      buyAchievedAt: w.buyAchievedAt || null,
      sellAchievedAt: w.sellAchievedAt || null,
      lastBuyAlertTime: w.lastBuyAlertTime || null,
      lastSellAlertTime: w.lastSellAlertTime || null,
      lastDividendAlertType: w.lastDividendAlertType || null,
      lastDividendAlertTime: w.lastDividendAlertTime || null,
      quoteError: w.quoteError || null,
      lastFetchTime: w.lastFetchTime || null,
      createdAt: w.createdAt || null,
      updatedAt: w.updatedAt || null,
    }));

    // 今日提醒数（北京日 0 点起）
    const p = beijingParts(nowMs);
    const startOfTodayMs = Date.UTC(p.year, p.month - 1, p.day) - 8 * 3600 * 1000;
    let alertsToday = null;
    try {
      const c = await db
        .collection(ALERTS_COLL)
        .where({ createdAt: db.command.gte(new Date(startOfTodayMs)) })
        .count();
      alertsToday = c.total || 0;
    } catch (_) {
      alertsToday = null;
    }

    // 即将分红数量统计（从分红缓存集合统计未过除息日或登记日近期的标的）
    let dividendUpcoming = 0;
    try {
      const divSnap = await db.collection(DIVIDEND_COLL).limit(100).get();
      const divDocs = divSnap.data || [];
      const enabledCodes = new Set(watches.filter((w) => w.enabled).map((w) => w.thsCode));
      for (const d of divDocs) {
        if (!enabledCodes.has(d.thsCode)) continue;
        const items = d.items || [];
        const latest = items[0];
        if (latest && latest.recordDateMs) {
          const daysLeft = getTradingDaysBetween(nowMs, latest.recordDateMs, tradingDays, settingsDoc.holidays);
          if (daysLeft >= 0 && daysLeft <= 20) {
            dividendUpcoming++;
          }
        }
      }
    } catch (_) {
      dividendUpcoming = 0;
    }

    const enabled = watches.filter((w) => w.enabled);
    const stats = {
      monitoring: enabled.length,
      alertsToday,
      buyOpportunities: enabled.filter(
        (w) => w.buyPrice != null && w.currentPrice != null && w.currentPrice <= w.buyPrice
      ).length,
      sellOpportunities: enabled.filter(
        (w) => w.sellPrice != null && w.currentPrice != null && w.currentPrice >= w.sellPrice
      ).length,
      dividendUpcoming,
    };

    return {
      ok: true,
      watches,
      stats,
      phase,
      serverTime: nowMs,
      settings: {
        monitorIntervalSec: Math.max(10, Math.min(3600, Number(settingsDoc.monitorIntervalSec) || 30)),
        notify: {
          webhook: !!(process.env.THS_WEBHOOK_URL && process.env.THS_WEBHOOK_URL.trim()),
          wechat: !!(
            (process.env.THS_WECHAT_MP_APPID && process.env.THS_WECHAT_MP_SECRET && process.env.THS_WECHAT_MP_TEMPLATE_ID) ||
            (process.env.THS_WECHAT_SENDKEY && process.env.THS_WECHAT_SENDKEY.trim()) ||
            (process.env.THS_WECHAT_PUSHPLUS_TOKEN && process.env.THS_WECHAT_PUSHPLUS_TOKEN.trim())
          ),
          wechatProvider: (process.env.THS_WECHAT_MP_APPID && process.env.THS_WECHAT_MP_SECRET && process.env.THS_WECHAT_MP_TEMPLATE_ID)
            ? 'wechat_mp'
            : (process.env.THS_WECHAT_SENDKEY && process.env.THS_WECHAT_SENDKEY.trim())
              ? 'serverchan'
              : (process.env.THS_WECHAT_PUSHPLUS_TOKEN && process.env.THS_WECHAT_PUSHPLUS_TOKEN.trim())
                ? 'pushplus'
                : null,
          configured: !!(process.env.THS_WEBHOOK_URL && process.env.THS_WEBHOOK_URL.trim()) ||
            !!(process.env.THS_WECHAT_MP_APPID && process.env.THS_WECHAT_MP_SECRET && process.env.THS_WECHAT_MP_TEMPLATE_ID) ||
            !!(process.env.THS_WECHAT_SENDKEY && process.env.THS_WECHAT_SENDKEY.trim()) ||
            !!(process.env.THS_WECHAT_PUSHPLUS_TOKEN && process.env.THS_WECHAT_PUSHPLUS_TOKEN.trim()),
        },
      },
      scanState: stateDoc
        ? {
            lastScanAt: stateDoc.lastScanAt || null,
            lastScanOk: stateDoc.lastScanOk !== false,
          }
        : null,
    };
  } catch (e) {
    return { ok: false, error: `读取监控列表失败：${e.message}` };
  }
};
