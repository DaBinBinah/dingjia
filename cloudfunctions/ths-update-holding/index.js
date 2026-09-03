/**
 * ths-update-holding —— 更新持仓记录
 */
const cloud = require('@cloudbase/node-sdk');
const { assertAccess } = require('./lib/access-guard');

const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
const db = app.database();
const HOLDINGS_COLL = 'ths_holdings';
const TX_COLL = 'ths_transactions';
const ACCOUNTS_COLL = 'ths_accounts';

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

    // ==============================================
    // 卖出操作（部分卖出或清仓）：结转已实现利润与现金回流
    // ==============================================
    if (event.action === 'sell' || (event.sellQuantity !== undefined && event.sellPrice !== undefined)) {
      const sellQty = Math.floor(Number(event.sellQuantity));
      const sellPrice = Number(event.sellPrice);
      if (!Number.isFinite(sellQty) || sellQty <= 0) return { ok: false, error: '卖出数量必须大于 0' };
      if (!Number.isFinite(sellPrice) || sellPrice <= 0) return { ok: false, error: '卖出价格必须大于 0' };
      if (sellQty > cur.quantity) return { ok: false, error: `卖出数量 (${sellQty}) 不能大于当前持有数量 (${cur.quantity})` };

      const sellAmount = round(sellQty * sellPrice, 2);
      const soldCost = round(sellQty * cur.costPrice, 2);
      const realizedPnL = round(sellAmount - soldCost, 2);
      const remainingQty = cur.quantity - sellQty;
      const now = new Date();

      const isUs = cur.market === 'US' || (!cur.market && cur.code && /^[A-Z0-9.\-]{1,10}$/.test(cur.code) && !/^\d{6}$/.test(cur.code));
      const currency = isUs ? 'USD' : 'CNY';

      // 1. 记录交易流水至 ths_transactions
      const txDoc = {
        holdingId: id,
        type: 'SELL',
        market: isUs ? 'US' : 'CN',
        currency,
        code: cur.code,
        thsCode: cur.thsCode || cur.code,
        name: cur.name,
        sellPrice: round(sellPrice, isUs ? 2 : (cur.type === 'etf' ? 3 : 2)),
        sellQuantity: sellQty,
        sellAmount,
        costPrice: cur.costPrice,
        costAmount: soldCost,
        realizedPnL,
        remainingQuantity: remainingQty,
        note: String(event.note || '卖出平仓').trim(),
        createdAt: now,
      };

      try {
        await db.createCollection(TX_COLL).catch(() => {});
        await db.collection(TX_COLL).add(txDoc);
      } catch (errTx) {
        console.error('记录交易流水异常:', errTx.message);
      }

      // 2. 更新或删除持仓记录
      if (remainingQty > 0) {
        const newCostAmount = round(remainingQty * cur.costPrice, 2);
        await db.collection(HOLDINGS_COLL).doc(id).update({
          quantity: remainingQty,
          costAmount: newCostAmount,
          updatedAt: now,
        });
      } else {
        await db.collection(HOLDINGS_COLL).doc(id).remove();
      }

      // 3. 回款至现金账户
      try {
        const accSnap = await db.collection(ACCOUNTS_COLL).where({ currency }).limit(1).get();
        if (accSnap.data && accSnap.data.length > 0) {
          const acc = accSnap.data[0];
          const newCash = round((Number(acc.availableCash) || 0) + sellAmount, 2);
          const newInvested = Math.max(0, round((Number(acc.totalInvested) || 0) - soldCost, 2));
          await db.collection(ACCOUNTS_COLL).doc(acc._id).update({
            availableCash: newCash,
            totalInvested: newInvested,
            updatedAt: now,
          });
        } else {
          await db.collection(ACCOUNTS_COLL).add({
            accountName: isUs ? '美股默认账户' : 'A股默认账户',
            currency,
            availableCash: sellAmount,
            totalInvested: 0,
            createdAt: now,
            updatedAt: now,
          });
        }
      } catch (errAcc) {
        console.error('更新现金账户异常:', errAcc.message);
      }

      return {
        ok: true,
        action: 'sell',
        sellQuantity: sellQty,
        sellPrice,
        sellAmount,
        realizedPnL,
        remainingQuantity: remainingQty,
        isClosed: remainingQty === 0,
      };
    }

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
