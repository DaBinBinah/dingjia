/**
 * ths-get-alerts —— 提醒记录（倒序分页）
 * 输入：{ filter?: 'all'|'buy'|'sell'|'dividend', limit?: 1-100, offset?, accessCode? }
 */
const cloud = require('@cloudbase/node-sdk');
const { assertAccess } = require('./lib/access-guard');

const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
const db = app.database();
const _ = db.command;
const ALERTS_COLL = 'ths_alerts';

const DIVIDEND_ALERT_TYPES = ['DIVIDEND_10D', 'DIVIDEND_5D', 'DIVIDEND_3D', 'DIVIDEND_1D', 'DIVIDEND_TODAY'];

exports.main = async (event = {}) => {
  const denied = assertAccess(event);
  if (denied) return denied;

  try {
    const filter = ['all', 'buy', 'sell', 'dividend'].includes(event.filter) ? event.filter : 'all';
    const limit = Math.max(1, Math.min(100, Number(event.limit) || 50));
    const offset = Math.max(0, Number(event.offset) || 0);

    let query = db.collection(ALERTS_COLL);
    if (filter === 'buy' || filter === 'sell') {
      query = query.where({ alertType: filter });
    } else if (filter === 'dividend') {
      query = query.where({ alertType: _.in(DIVIDEND_ALERT_TYPES) });
    }

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
      dividendPerShare: typeof a.dividendPerShare === 'number' ? a.dividendPerShare : null,
      recordDate: a.recordDate || null,
      exDividendDate: a.exDividendDate || null,
      paymentDate: a.paymentDate || null,
      tradingDaysLeft: typeof a.tradingDaysLeft === 'number' ? a.tradingDaysLeft : null,
      createdAt: a.createdAt || null,
    }));

    return { ok: true, filter, limit, offset, items, hasMore: items.length === limit };
  } catch (e) {
    return { ok: false, error: `读取提醒记录失败：${e.message}` };
  }
};
