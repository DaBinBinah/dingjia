/**
 * ths-update-holding —— 更新持仓记录
 */
const cloud = require('@cloudbase/node-sdk');
const { assertAccess } = require('./lib/access-guard');

const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
const db = app.database();
const HOLDINGS_COLL = 'ths_holdings';

function round(val, decimals = 2) {
  if (typeof val !== 'number' || !Number.isFinite(val)) return null;
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

exports.main = async (event = {}) => {
  const denied = assertAccess(event);
  if (denied) return denied;

  const id = String(event._id || '').trim();
  if (!id) return { ok: false, error: '缺少 _id' };

  try {
    const snap = await db.collection(HOLDINGS_COLL).doc(id).get();
    const cur = Array.isArray(snap.data) ? snap.data[0] : snap.data;
    if (!cur) return { ok: false, error: '持仓记录不存在' };

    const patch = { updatedAt: new Date() };

    if (event.name !== undefined && String(event.name).trim()) {
      patch.name = String(event.name).trim();
    }

    let qty = cur.quantity;
    if (event.quantity !== undefined) {
      const q = Number(event.quantity);
      if (!Number.isFinite(q) || q <= 0) return { ok: false, error: '持仓数量必须大于 0' };
      qty = Math.floor(q);
      patch.quantity = qty;
    }

    let costP = cur.costPrice;
    if (event.costPrice !== undefined) {
      const p = Number(event.costPrice);
      if (!Number.isFinite(p) || p <= 0) return { ok: false, error: '持仓成本价必须大于 0' };
      costP = round(p, 4);
      patch.costPrice = costP;
    }

    patch.costAmount = round(qty * costP, 2);

    if (event.buyDate !== undefined) {
      patch.buyDate = event.buyDate ? String(event.buyDate).trim() : null;
    }
    if (event.accountName !== undefined) {
      patch.accountName = String(event.accountName || '默认账户').trim();
    }
    if (event.targetQuantity !== undefined) {
      patch.targetQuantity = Number.isFinite(Number(event.targetQuantity)) ? Math.floor(Number(event.targetQuantity)) : null;
    }
    if (event.plannedAmount !== undefined) {
      patch.plannedAmount = Number.isFinite(Number(event.plannedAmount)) ? round(Number(event.plannedAmount), 2) : null;
    }
    if (event.note !== undefined) {
      patch.note = String(event.note || '').trim();
    }

    await db.collection(HOLDINGS_COLL).doc(id).update(patch);
    return { ok: true, _id: id, patch };
  } catch (e) {
    return { ok: false, error: `更新持仓失败：${e.message}` };
  }
};
