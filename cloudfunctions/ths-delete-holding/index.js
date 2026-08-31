/**
 * ths-delete-holding —— 删除持仓记录
 */
const cloud = require('@cloudbase/node-sdk');
const { assertAccess } = require('./lib/access-guard');

const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
const db = app.database();
const HOLDINGS_COLL = 'ths_holdings';

exports.main = async (event = {}) => {
  const denied = assertAccess(event);
  if (denied) return denied;

  const id = String(event._id || '').trim();
  if (!id) return { ok: false, error: '缺少 _id' };

  try {
    const snap = await db.collection(HOLDINGS_COLL).doc(id).get();
    const cur = Array.isArray(snap.data) ? snap.data[0] : snap.data;
    if (!cur) return { ok: false, error: '持仓记录不存在' };

    await db.collection(HOLDINGS_COLL).doc(id).remove();
    return { ok: true, _id: id, deleted: cur };
  } catch (e) {
    return { ok: false, error: `删除持仓失败：${e.message}` };
  }
};
