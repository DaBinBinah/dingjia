/**
 * ths-get-plans —— 读取投资计划与执行对比
 */
const cloud = require('@cloudbase/node-sdk');
const { assertAccess } = require('./lib/access-guard');

const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
const db = app.database();

const PLANS_COLL = 'ths_plans';
const HOLDINGS_COLL = 'ths_holdings';
const WATCH_COLL = 'ths_watchlist';

async function ensureCollections() {
  try { await db.createCollection(PLANS_COLL); } catch (_) {}
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

  try {
    let plansSnap;
    try {
      plansSnap = code
        ? await db.collection(PLANS_COLL).where({ code }).get()
        : await db.collection(PLANS_COLL).orderBy('updatedAt', 'desc').get();
    } catch (e) {
      if (e && (e.code === 'DATABASE_COLLECTION_NOT_EXIST' || /Db or Table not exist/i.test(e.message))) {
        await ensureCollections();
        plansSnap = { data: [] };
      } else {
        throw e;
      }
    }

    const plans = plansSnap.data || [];

    // 读取持仓与监控信息以计算【计划 vs 实际】
    const [holdingsSnap, watchSnap] = await Promise.all([
      db.collection(HOLDINGS_COLL).get().catch(() => ({ data: [] })),
      db.collection(WATCH_COLL).get().catch(() => ({ data: [] })),
    ]);

    const holdingMap = new Map();
    for (const h of holdingsSnap.data || []) if (h.code) holdingMap.set(h.code, h);

    const watchMap = new Map();
    for (const w of watchSnap.data || []) if (w.code) watchMap.set(w.code, w);

    const items = plans.map((p) => {
      const h = holdingMap.get(p.code);
      const w = watchMap.get(p.code);

      const targetQty = Number(p.targetQuantity) || null;
      const currentQty = h ? Number(h.quantity) || 0 : 0;
      const qtyGap = targetQty !== null ? Math.max(0, targetQty - currentQty) : null;
      const qtyProgress = targetQty !== null && targetQty > 0 ? round((currentQty / targetQty) * 100, 1) : null;

      // 计划买入价 vs 实际买入均价偏离度
      let planBuyPrice = null;
      if (Array.isArray(p.buyLevels) && p.buyLevels.length && p.buyLevels[0].price) {
        planBuyPrice = Number(p.buyLevels[0].price);
      } else if (w && w.buyPrice != null) {
        planBuyPrice = w.buyPrice;
      }

      let costPrice = h && h.costPrice != null ? Number(h.costPrice) : null;
      let buyPriceDeviationPct = null;
      if (planBuyPrice && costPrice) {
        buyPriceDeviationPct = round(((costPrice - planBuyPrice) / planBuyPrice) * 100, 2);
      }

      return {
        _id: p._id,
        code: p.code,
        type: p.type || (w ? w.type : h ? h.type : 'stock'),
        name: p.name || (w ? w.name : h ? h.name : p.code),
        reasons: Array.isArray(p.reasons) ? p.reasons : [],
        customReason: p.customReason || '',
        targetQuantity: targetQty,
        currentQuantity: currentQty,
        quantityGap: qtyGap,
        quantityProgress: qtyProgress,
        plannedAmount: Number(p.plannedAmount) || null,
        buyLevels: Array.isArray(p.buyLevels) ? p.buyLevels : [],
        sellLevels: Array.isArray(p.sellLevels) ? p.sellLevels : [],
        note: p.note || '',
        // 计划 vs 实际
        planBuyPrice,
        actualCostPrice: costPrice,
        buyPriceDeviationPct,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      };
    });

    return { ok: true, items, plan: items.length && code ? items[0] : null };
  } catch (e) {
    return { ok: false, error: `读取投资计划失败: ${e.message}` };
  }
};
