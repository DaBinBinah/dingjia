/**
 * ths-update-plan —— 创建或更新投资计划
 */
const cloud = require('@cloudbase/node-sdk');
const { assertAccess } = require('./lib/access-guard');

const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
const db = app.database();

const PLANS_COLL = 'ths_plans';

async function ensureCollections() {
  try { await db.createCollection(PLANS_COLL); } catch (_) {}
}

exports.main = async (event = {}) => {
  const denied = assertAccess(event);
  if (denied) return denied;

  const code = event.code ? String(event.code).trim() : null;
  if (!code || !/^\d{6}$/.test(code)) {
    return { ok: false, error: '证券代码必须为 6 位数字' };
  }

  const name = String(event.name || '').trim();
  const type = event.type === 'etf' ? 'etf' : 'stock';
  const targetQuantity = event.targetQuantity != null ? Math.max(0, parseInt(event.targetQuantity, 10)) : null;
  const plannedAmount = event.plannedAmount != null ? Math.max(0, Number(event.plannedAmount)) : null;
  const reasons = Array.isArray(event.reasons) ? event.reasons.map((r) => String(r).trim()).filter(Boolean) : [];
  const customReason = String(event.customReason || '').trim().slice(0, 200);
  const note = String(event.note || '').trim().slice(0, 1000);

  // 多档买入与卖出计划
  const buyLevels = Array.isArray(event.buyLevels)
    ? event.buyLevels
        .map((l) => ({ price: Number(l.price) || 0, amount: Number(l.amount) || 0 }))
        .filter((l) => l.price > 0)
    : [];

  const sellLevels = Array.isArray(event.sellLevels)
    ? event.sellLevels
        .map((l) => ({ price: Number(l.price) || 0, percent: Number(l.percent) || 0 }))
        .filter((l) => l.price > 0)
    : [];

  const now = new Date();

  try {
    let existSnap;
    try {
      existSnap = await db.collection(PLANS_COLL).where({ code }).limit(1).get();
    } catch (e) {
      if (e && (e.code === 'DATABASE_COLLECTION_NOT_EXIST' || /Db or Table not exist/i.test(e.message))) {
        await ensureCollections();
        existSnap = { data: [] };
      } else {
        throw e;
      }
    }

    const exist = (existSnap.data && existSnap.data[0]) || null;
    const doc = {
      code,
      name,
      type,
      targetQuantity,
      plannedAmount,
      reasons,
      customReason,
      buyLevels,
      sellLevels,
      note,
      updatedAt: now,
    };

    let id;
    if (exist) {
      id = exist._id;
      await db.collection(PLANS_COLL).doc(id).update(doc);
    } else {
      doc.createdAt = now;
      const res = await db.collection(PLANS_COLL).add(doc);
      id = res.id;
    }

    return { ok: true, id, doc: { _id: id, ...doc } };
  } catch (e) {
    return { ok: false, error: `保存投资计划失败: ${e.message}` };
  }
};
