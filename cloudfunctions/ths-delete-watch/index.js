/**
 * ths-delete-watch —— 删除监控标的
 * 提醒记录（ths_alerts）保留作为历史档案，其中的 code/name 为冗余字段，删除标的后仍可读。
 * 输入：{ _id, accessCode? }
 */
const cloud = require('@cloudbase/node-sdk');
const { assertAccess } = require('./lib/access-guard');

const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
const db = app.database();
const WATCH_COLL = 'ths_watchlist';

exports.main = async (event = {}) => {
  const denied = assertAccess(event);
  if (denied) return denied;

  try {
    const id = String(event._id || '');
    if (!id) return { ok: false, error: '缺少 _id' };
    const res = await db.collection(WATCH_COLL).doc(id).remove();
    const deleted = Number(res && (res.deleted != null ? res.deleted : res.stats ? res.stats.deleted : 0));
    if (deleted === 0) return { ok: false, error: '标的不存在或已删除' };
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: `删除失败：${e.message}` };
  }
};
