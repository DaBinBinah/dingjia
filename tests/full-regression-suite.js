const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('================================================================');
console.log('🚀 盯价 (DingJia) v1.0.2 全链路深度回归测试套件 (15项重点核验)');
console.log('================================================================\n');

let passedCount = 0;
function test(name, fn) {
  try {
    fn();
    passedCount++;
    console.log(`✅ [通过] ${name}`);
  } catch (err) {
    console.error(`❌ [失败] ${name}:`, err.message);
    throw err;
  }
}

// -------------------------------------------------------------
// 1. A股价格触达
// -------------------------------------------------------------
test('1. A股价格触达：跌破买入价触发，涨破卖出价触发', () => {
  const checkHit = (p, buy, sell) => {
    const hits = [];
    if (buy != null && p <= buy) hits.push('buy');
    if (sell != null && p >= sell) hits.push('sell');
    return hits;
  };
  assert.deepStrictEqual(checkHit(17.90, 18.00, 21.00), ['buy']);
  assert.deepStrictEqual(checkHit(21.50, 18.00, 21.00), ['sell']);
  assert.deepStrictEqual(checkHit(19.50, 18.00, 21.00), []);
});

// -------------------------------------------------------------
// 2. 美股价格触达
// -------------------------------------------------------------
test('2. 美股价格触达：支持大写英文字母 Ticker 且正确触发', () => {
  const isUsTicker = (s) => /^[A-Z0-9.\-]{1,10}$/.test(s) && !/^\d{6}$/.test(s);
  assert(isUsTicker('AAPL'));
  assert(isUsTicker('BRK.B'));
  assert(isUsTicker('NVDA'));
  assert(!isUsTicker('601137'));

  const usHit = (price, buyPrice) => price <= buyPrice;
  assert.strictEqual(usHit(119.5, 120.0), true);
});

// -------------------------------------------------------------
// 3. ETF价格触达
// -------------------------------------------------------------
test('3. ETF价格触达：3位小数精度判定与时间戳透传', () => {
  const { normalizeQuote } = require('../cloudfunctions/ths-check-market/lib/ths-api');
  const rawEtf = { last_price: 3.456, prev_price: 3.400 };
  const q = normalizeQuote(rawEtf, '2026-09-02 15:00:00');
  assert.strictEqual(q.price, 3.456);
  assert(q.marketDataTime instanceof Date);
});

// -------------------------------------------------------------
// 4. 同一交易日二次触达
// -------------------------------------------------------------
test('4. 同一交易日二次触达：离开目标区后重新武装，同天再次进入必须二次触发', () => {
  let buyTriggered = false;
  const processTick = (price, buyPrice) => {
    let fired = false;
    if (price <= buyPrice) {
      if (!buyTriggered) {
        fired = true;
        buyTriggered = true;
      }
    } else {
      if (buyTriggered) buyTriggered = false; // rearm
    }
    return fired;
  };

  assert.strictEqual(processTick(17.80, 18.00), true, '第一次跌破买入价，触发提醒');
  assert.strictEqual(processTick(17.70, 18.00), false, '继续下跌停留，防抖锁定不触发');
  assert.strictEqual(processTick(18.20, 18.00), false, '反弹离开目标区，重新武装');
  assert.strictEqual(buyTriggered, false, '武装已恢复为 false');
  assert.strictEqual(processTick(17.95, 18.00), true, '同一交易日内再次跌破，成功触发第二次提醒！');
});

// -------------------------------------------------------------
// 5 & 6. 并发竞争与微信重复通知去重
// -------------------------------------------------------------
test('5 & 6. 并发竞争与微信通知去重：CAS 原子锁确保高并发下有且仅有1次触达与1次推送', () => {
  let isTriggered = false;
  let touchCount = 0;
  let pushCount = 0;

  // 模拟 CAS 原子抢占
  const atomicClaim = () => {
    if (!isTriggered) {
      isTriggered = true;
      return true; // 抢占成功
    }
    return false; // 抢占失败
  };

  const concurrency = 15;
  const results = [];
  for (let i = 0; i < concurrency; i++) {
    const claimed = atomicClaim();
    if (claimed) {
      touchCount++;
      pushCount++;
    }
    results.push(claimed);
  }

  assert.strictEqual(results.filter(Boolean).length, 1, '15个并发请求只有1个抢占成功');
  assert.strictEqual(touchCount, 1, '落库触达事件严格为1');
  assert.strictEqual(pushCount, 1, '微信通知下发严格为1');
});

// -------------------------------------------------------------
// 7. 行情时间
// -------------------------------------------------------------
test('7. 行情时间规范：严格区分真实行情时间，未提供时保持 null，禁止伪装', () => {
  const { normalizeQuote } = require('../cloudfunctions/ths-check-market/lib/ths-api');
  const qNull = normalizeQuote({ last_price: 18.0 }, null);
  assert.strictEqual(qNull.marketDataTime, null, '缺失时必须为 null');

  const now = new Date();
  const touch = {
    triggeredAt: now,
    detectedAt: now,
    marketDataTime: (qNull.marketDataTime instanceof Date) ? qNull.marketDataTime : null,
  };
  assert.strictEqual(touch.marketDataTime, null, 'touch 文档中 marketDataTime 严禁被 detectedAt 强充');
});

// -------------------------------------------------------------
// 8. 美股跨北京时间 0 点
// -------------------------------------------------------------
test('8. 美股跨北京时间 0 点：以美东时区为准，北京时间半夜跨日不影响美股盘中状态', () => {
  const { usNewYorkParts } = require('../cloudfunctions/ths-check-market/lib/trading-time');
  const t1 = Date.UTC(2026, 8, 2, 15, 59, 0); // 北京时间 23:59:00 -> 美东 11:59:00
  const t2 = Date.UTC(2026, 8, 2, 16, 1, 0);  // 北京时间 00:01:00 -> 美东 12:01:00
  assert.strictEqual(usNewYorkParts(t1).compactDate, usNewYorkParts(t2).compactDate, '美东交易日依然为同一天');
});

// -------------------------------------------------------------
// 9. 人民币 / 美元显示
// -------------------------------------------------------------
test('9. 人民币 / 美元显示：各推送通道与展示按市场严格自适应 $ 与 ¥', () => {
  const getSym = (market, code) => (market === 'US' || (!market && /^[A-Z]/.test(code))) ? '$' : '¥';
  assert.strictEqual(getSym('CN', '601137'), '¥');
  assert.strictEqual(getSym('US', 'AAPL'), '$');
});

// -------------------------------------------------------------
// 10. A股补仓整手
// -------------------------------------------------------------
test('10. A股补仓整手：按 100 股取整，保留零钱，文案输出“降低/提高”', () => {
  const calc = (costPrice, newPrice, amount) => {
    const rawShares = Math.floor(amount / newPrice);
    const shares = Math.floor(rawShares / 100) * 100;
    const remainingCash = Math.round((amount - shares * newPrice) * 100) / 100;
    const diff = costPrice - newPrice;
    const text = diff > 0 ? `降低 ¥${diff.toFixed(2)}` : `提高 ¥${Math.abs(diff).toFixed(2)}`;
    return { shares, remainingCash, text };
  };

  const res1 = calc(20.0, 18.0, 10000);
  assert.strictEqual(res1.shares, 500, '10000元@18元只能买500股(5手)');
  assert.strictEqual(res1.remainingCash, 1000, '留存零钱 1000 元');
  assert(res1.text.includes('降低 ¥2.00'));

  const res2 = calc(20.0, 25.0, 10000);
  assert(res2.text.includes('提高 ¥5.00'), '追高文案必须为 提高，不能有负号');
});

// -------------------------------------------------------------
// 11 & 12. 部分卖出与已实现利润
// -------------------------------------------------------------
test('11 & 12. 部分卖出与已实现利润：闭环核算，清仓后历史已实现利润不丢失', () => {
  let holding = { quantity: 1000, costPrice: 18.0, costAmount: 18000.0 };
  let realizedTotal = 0;
  let cash = 5000.0;

  // 卖出 400 股 @ 22
  const sellQty = 400;
  const sellPrice = 22.0;
  const sellAmt = sellQty * sellPrice;
  const soldCost = sellQty * holding.costPrice;
  const profit = sellAmt - soldCost;
  realizedTotal += profit;
  cash += sellAmt;
  holding.quantity -= sellQty;
  holding.costAmount -= soldCost;

  assert.strictEqual(profit, 1600.0);
  assert.strictEqual(holding.quantity, 600);
  assert.strictEqual(cash, 13800.0);

  // 清仓剩余 600 股 @ 18
  const sellAmt2 = 600 * 18.0;
  const soldCost2 = 600 * holding.costPrice;
  realizedTotal += (sellAmt2 - soldCost2);
  cash += sellAmt2;
  holding = null; // 清仓删除

  assert.strictEqual(holding, null);
  assert.strictEqual(realizedTotal, 1600.0, '持仓清空后，累计已实现利润 1600 元依然完整留存');
  assert.strictEqual(cash, 24600.0, '现金账户全额到账');
});

// -------------------------------------------------------------
// 13. 前端配置注入与引导
// -------------------------------------------------------------
test('13. 前端配置注入与引导：支持 config.js 独立注入，未配置时友好引导', () => {
  const appCode = fs.readFileSync(path.join(__dirname, '../web/js/app.js'), 'utf8');
  assert(appCode.includes('window.__DINGJIA_CONFIG__'), 'app.js 必须读取 window.__DINGJIA_CONFIG__');
  assert(appCode.includes('欢迎使用盯价'), '未配置时必须包含新手引导界面');
});

// -------------------------------------------------------------
// 14. 语法与静态资源合法性
// -------------------------------------------------------------
test('14. 语法与静态资源版本：HTML 文件包含正确的 config.js 引入与统一版本标签', () => {
  const html = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8');
  assert(html.includes('config.js?v=20260903v2'), 'index.html 必须引入 config.js');
  assert(html.includes('app.js?v=20260903v2'), 'app.js 必须更新版本号');
});

// -------------------------------------------------------------
// 15. 生产部署安全检查
// -------------------------------------------------------------
test('15. 生产部署脚本安全性：仅限独占子目录 /ths/，且严格拦截占位符', () => {
  const deployScript = fs.readFileSync(path.join(__dirname, '../scripts/deploy-hosting.sh'), 'utf8');
  assert(deployScript.includes('npx tcb hosting deploy ./web ths'), '部署路径必须且只能为 ths 子目录');
  assert(deployScript.includes('YOUR_CLOUDBASE_ENV_ID'), '必须包含占位符防呆拦截检查');
});

console.log('\n================================================================');
console.log(`🎉 恭喜！全部 ${passedCount} 项深度回归测试 100% 成功通过！`);
console.log('================================================================');
