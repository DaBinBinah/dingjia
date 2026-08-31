/**
 * ths-get-price-touches —— 查询目标价格精确触达历史、统计与触达后表现
 */
const cloud = require('@cloudbase/node-sdk');
const { fetchQuotes, toThsCode } = require('./lib/ths-api');
const { assertAccess } = require('./lib/access-guard');

const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
const db = app.database();
const _ = db.command;

const TOUCH_COLL = 'ths_price_touches';
const HOLDINGS_COLL = 'ths_holdings';
const WATCH_COLL = 'ths_watchlist';

async function ensureCollections() {
  try { await db.createCollection(TOUCH_COLL); } catch (_) {}
}

function round(val, decimals = 2) {
  if (typeof val !== 'number' || !Number.isFinite(val)) return null;
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

exports.main = async (event = {}) => {
  const denied = assertAccess(event);
  if (denied) return denied;

  const code = event.code ? String(event.code).trim() : null;
  const alertType = event.alertType; // 'buy' | 'sell' | 'all'
  const timeRange = event.timeRange || 'all'; // 'today' | '7d' | '30d' | 'all'
  const limit = Math.min(100, Math.max(1, parseInt(event.limit, 10) || 50));

  try {
    const query = {};
    if (code) query.code = code;
    if (alertType && ['buy', 'sell'].includes(alertType)) query.alertType = alertType;

    const now = Date.now();
    if (timeRange === 'today') {
      const todayStart = new Date(new Date(now + 8 * 3600 * 1000).setUTCHours(0, 0, 0, 0) - 8 * 3600 * 1000);
      query.triggeredAt = _.gte(todayStart);
    } else if (timeRange === '7d') {
      query.triggeredAt = _.gte(new Date(now - 7 * 86400000));
    } else if (timeRange === '30d') {
      query.triggeredAt = _.gte(new Date(now - 30 * 86400000));
    }

    let snap;
    try {
      snap = await db.collection(TOUCH_COLL).where(query).orderBy('triggeredAt', 'desc').limit(limit).get();
    } catch (e) {
      if (e && (e.code === 'DATABASE_COLLECTION_NOT_EXIST' || /Db or Table not exist/i.test(e.message))) {
        await ensureCollections();
        snap = { data: [] };
      } else {
        throw e;
      }
    }

    const touches = snap.data || [];

    // 获取对应标的的当前持仓与现价以计算触达后表现和触达理论收益
    let holding = null;
    let watch = null;
    let curPrice = null;

    if (code) {
      const [hSnap, wSnap] = await Promise.all([
        db.collection(HOLDINGS_COLL).where({ code }).limit(1).get().catch(() => ({ data: [] })),
        db.collection(WATCH_COLL).where({ code }).limit(1).get().catch(() => ({ data: [] })),
      ]);
      holding = (hSnap.data && hSnap.data[0]) || null;
      watch = (wSnap.data && wSnap.data[0]) || null;

      const type = (watch && watch.type) || (holding && holding.type) || 'stock';
      const tc = toThsCode(type, code);
      if (tc) {
        try {
          const qRes = await fetchQuotes(type, [tc]);
          if (qRes.quotes && qRes.quotes[tc]) {
            curPrice = qRes.quotes[tc].price;
          }
        } catch (_) {}
      }
      if (curPrice === null && watch && typeof watch.currentPrice === 'number') {
        curPrice = watch.currentPrice;
      }

      // 如果当前处于目标价格区间但历史记录为空，自动补全首个检测触达事件
      if (touches.length === 0 && watch && curPrice !== null) {
        const inSell = watch.sellPrice != null && curPrice >= watch.sellPrice;
        const inBuy = watch.buyPrice != null && curPrice <= watch.buyPrice;
        if (inSell || inBuy) {
          const alertTypeAuto = inSell ? 'sell' : 'buy';
          const targetP = inSell ? watch.sellPrice : watch.buyPrice;
          const detectedTime = watch.lastSellAlertTime ? new Date(watch.lastSellAlertTime) : (watch.lastFetchTime ? new Date(watch.lastFetchTime) : new Date());
          const autoTouchDoc = {
            watchId: watch._id,
            code: watch.code,
            name: watch.name,
            type: watch.type,
            thsCode: watch.thsCode,
            alertType: alertTypeAuto,
            targetPrice: targetP,
            triggerPrice: curPrice,
            previousPrice: watch.previousPrice || curPrice,
            currentPrice: curPrice,
            dayChangePercent: watch.changePercent || 0,
            triggeredAt: detectedTime,
            detectedAt: detectedTime,
            marketDataTime: detectedTime,
            triggerCycleId: `cycle_${watch.code}_${alertTypeAuto}_${detectedTime.getTime()}`,
            status: 'ACTIVE',
            notificationStatus: 'SENT',
            source: 'INITIAL_DETECTION',
            createdAt: detectedTime,
          };
          db.collection(TOUCH_COLL).add(autoTouchDoc).catch(() => {});
          touches.push(autoTouchDoc);
        }
      }
    }

    // 格式化输出与触达后表现测算
    const items = touches.map((t) => {
      const trigP = Number(t.triggerPrice) || Number(t.currentPrice) || 0;
      let postTouchDiff = null;
      let postTouchReturnPct = null;

      if (curPrice !== null && trigP > 0) {
        postTouchDiff = round(curPrice - trigP, t.type === 'etf' ? 3 : 2);
        postTouchReturnPct = round(((curPrice - trigP) / trigP) * 100, 2);
      }

      let theoreticalProfit = null;
      if (holding && holding.quantity > 0 && holding.costPrice > 0) {
        theoreticalProfit = round((trigP - holding.costPrice) * holding.quantity, 2);
      }

      return {
        _id: t._id,
        watchId: t.watchId,
        code: t.code,
        name: t.name,
        type: t.type,
        alertType: t.alertType,
        targetPrice: t.targetPrice,
        triggerPrice: trigP,
        previousPrice: t.previousPrice,
        currentPriceAtTouch: t.currentPrice,
        dayChangePercent: t.dayChangePercent,
        dayHigh: t.dayHigh,
        dayLow: t.dayLow,
        volume: t.volume,
        turnover: t.turnover,
        triggeredAt: t.triggeredAt,
        detectedAt: t.detectedAt || t.triggeredAt,
        marketDataTime: t.marketDataTime,
        status: t.status || 'ACTIVE',
        notificationStatus: t.notificationStatus || 'SENT',
        readAt: t.readAt || null,
        // 动态追踪
        currentPriceNow: curPrice,
        postTouchDiff,
        postTouchReturnPct,
        theoreticalProfit,
      };
    });

    // 统计频次
    const stats = {
      totalTouches: items.length,
      buyTouches: items.filter((x) => x.alertType === 'buy').length,
      sellTouches: items.filter((x) => x.alertType === 'sell').length,
      latestTouch: items.length ? items[0] : null,
      last30dCount: items.filter((x) => new Date(x.triggeredAt).getTime() >= now - 30 * 86400000).length,
    };

    return {
      ok: true,
      items,
      stats,
      serverTime: now,
    };
  } catch (e) {
    return { ok: false, error: `读取触达历史失败: ${e.message}` };
  }
};
