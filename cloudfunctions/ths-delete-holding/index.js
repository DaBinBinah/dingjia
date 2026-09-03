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

    // 若标记为清仓卖出（isSell = true 且提供了有效 sellPrice），自动结转已实现利润并回款至现金账户
    if (event.isSell && Number(event.sellPrice) > 0) {
      const sellPrice = Number(event.sellPrice);
      const sellQty = cur.quantity;
      const sellAmount = Math.round(sellQty * sellPrice * 100) / 100;
      const soldCost = cur.costAmount || Math.round(sellQty * cur.costPrice * 100) / 100;
      const realizedPnL = Math.round((sellAmount - soldCost) * 100) / 100;
      const now = new Date();

      const isUs = cur.market === 'US' || (!cur.market && cur.code && /^[A-Z0-9.\-]{1,10}$/.test(cur.code) && !/^\d{6}$/.test(cur.code));
      const currency = isUs ? 'USD' : 'CNY';

      try {
        await db.collection('ths_transactions').add({
          holdingId: id,
          type: 'SELL',
          market: isUs ? 'US' : 'CN',
          currency,
          code: cur.code,
          thsCode: cur.thsCode || cur.code,
          name: cur.name,
          sellPrice,
          sellQuantity: sellQty,
          sellAmount,
          costPrice: cur.costPrice,
          costAmount: soldCost,
          realizedPnL,
          remainingQuantity: 0,
          note: String(event.note || '清仓卖出').trim(),
          createdAt: now,
        });

        const accSnap = await db.collection('ths_accounts').where({ currency }).limit(1).get();
        if (accSnap.data && accSnap.data.length > 0) {
          const acc = accSnap.data[0];
          const newCash = Math.round(((Number(acc.availableCash) || 0) + sellAmount) * 100) / 100;
          const newInvested = Math.max(0, Math.round(((Number(acc.totalInvested) || 0) - soldCost) * 100) / 100);
          await db.collection('ths_accounts').doc(acc._id).update({
            availableCash: newCash,
            totalInvested: newInvested,
            updatedAt: now,
          });
        }
      } catch (errTx) {
        console.error('清仓结转流水异常:', errTx.message);
      }
    }

    await db.collection(HOLDINGS_COLL).doc(id).remove();
    return { ok: true, _id: id, deleted: cur };
  } catch (e) {
    return { ok: false, error: `删除持仓失败：${e.message}` };
  }
};
