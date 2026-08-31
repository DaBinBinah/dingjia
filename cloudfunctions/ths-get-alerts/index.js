/**
 * ths-get-alerts —— 提醒记录（倒序分页）
 * 输入：{ filter?: 'all'|'buy'|'sell', limit?: 1-100, offset?, accessCode? }
 */
const cloud = require('@cloudbase/node-sdk');
const { assertAccess } = require('./lib/access-guard');

const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
const db = app.database();
const ALERTS_COLL = 'ths_alerts';

exports.main = async (event = {}) => {
  const denied = assertAccess(event);
  if (denied) return denied;

  try {
    const filter = ['all', 'buy', 'sell'].includes(event.filter) ? event.filter : 'all';
    const limit = Math.max(1, Math.min(100, Number(event.limit) || 50));
    const offset = Math.max(0, Number(event.offset) || 0);

    let query = db.collection(ALERTS_COLL);
    if (filter !== 'all') query = query.where({ alertType: filter });

    const snap = await query.orderBy('createdAt', 'desc').skip(offset).limit(limit).get();
    const items = (snap.data || []).map((a) => ({
      _id: a._id,
      watchId: a.watchId || null,
      type: a.type,
      code: a.code,
      name: a.name,
      alertType: a.alertType,
      triggerPrice: typeof a.triggerPrice === 'number' ? a.triggerPrice : null,
      currentPrice: typeof a.currentPrice === 'number' ? a.currentPrice : null,
      createdAt: a.createdAt || null,
    }));

    return { ok: true, filter, limit, offset, items, hasMore: items.length === limit };
  } catch (e) {
    return { ok: false, error: `读取提醒记录失败：${e.message}` };
  }
};
