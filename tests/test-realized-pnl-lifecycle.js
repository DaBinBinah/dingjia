const assert = require('assert');

console.log('--- 开始已实现利润与完整交易资金闭环测试 (P1-5) ---');

function round(val, decimals = 2) {
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

// 模拟数据库环境
let dbHoldings = {
  h1: { _id: 'h1', code: '601137', name: '博威合金', quantity: 1000, costPrice: 18.0, costAmount: 18000.0, market: 'CN', currency: 'CNY' }
};
let dbTransactions = [];
let dbAccount = { currency: 'CNY', availableCash: 10000.0, totalInvested: 18000.0 };

// 模拟卖出结算核心算法
function executeSell(holdingId, sellQty, sellPrice) {
  const cur = dbHoldings[holdingId];
  assert(cur, '持仓必须存在');
  assert(sellQty <= cur.quantity, '卖出数量不得大于持有量');

  const sellAmount = round(sellQty * sellPrice, 2);
  const soldCost = round(sellQty * cur.costPrice, 2);
  const realizedPnL = round(sellAmount - soldCost, 2);
  const remainingQty = cur.quantity - sellQty;

  // 1. 记录流水
  const tx = {
    holdingId,
    type: 'SELL',
    market: cur.market,
    currency: cur.currency,
    code: cur.code,
    name: cur.name,
    sellPrice,
    sellQuantity: sellQty,
    sellAmount,
    costPrice: cur.costPrice,
    costAmount: soldCost,
    realizedPnL,
    remainingQuantity: remainingQty,
    createdAt: new Date(),
  };
  dbTransactions.push(tx);

  // 2. 更新或清仓持仓
  if (remainingQty > 0) {
    cur.quantity = remainingQty;
    cur.costAmount = round(remainingQty * cur.costPrice, 2);
  } else {
    delete dbHoldings[holdingId];
  }

  // 3. 现金回款与本金减少
  dbAccount.availableCash = round(dbAccount.availableCash + sellAmount, 2);
  dbAccount.totalInvested = Math.max(0, round(dbAccount.totalInvested - soldCost, 2));

  return { sellAmount, soldCost, realizedPnL, remainingQty };
}

// 步骤 1：部分卖出 400 股 @ 22 元 (盈利)
const sell1 = executeSell('h1', 400, 22.0);
console.log('第 1 次卖出 (减仓):', sell1);
assert.strictEqual(sell1.sellAmount, 8800.0, '回收现金 8800 元');
assert.strictEqual(sell1.realizedPnL, 1600.0, '实现利润 1600 元');
assert.strictEqual(sell1.remainingQty, 600, '剩余持仓 600 股');
assert.strictEqual(dbHoldings.h1.costAmount, 10800.0, '剩余持仓成本 10800 元');
assert.strictEqual(dbAccount.availableCash, 18800.0, '现金账户从 10000 变为 18800');

// 步骤 2：清仓卖出剩余 600 股 @ 20 元 (微利)
const sell2 = executeSell('h1', 600, 20.0);
console.log('第 2 次卖出 (清仓):', sell2);
assert.strictEqual(sell2.sellAmount, 12000.0, '回收现金 12000 元');
assert.strictEqual(sell2.realizedPnL, 1200.0, '实现利润 1200 元');
assert.strictEqual(sell2.remainingQty, 0, '持仓已清空');
assert.strictEqual(dbHoldings.h1, undefined, '持仓文档已安全清除');
assert.strictEqual(dbAccount.availableCash, 30800.0, '现金账户变为 30800 元 (原现金10000 + 卖出回款20800)');

// 步骤 3：模拟在持仓已删除的情况下，计算总看板
let totalRealizedPnL = 0;
for (const tx of dbTransactions) {
  if (tx.type === 'SELL') totalRealizedPnL += tx.realizedPnL;
}
totalRealizedPnL = round(totalRealizedPnL, 2);

console.log('清仓后历史累计已实现利润:', totalRealizedPnL);
assert.strictEqual(totalRealizedPnL, 2800.0, '历史累计已实现利润严格等于 1600 + 1200 = 2800 元');
assert.strictEqual(dbTransactions.length, 2, '流水记录完整保留两条');

console.log('✅ P1-5 已实现利润、部分卖出、现金回款与完整资金闭环测试 100% 通过！');
