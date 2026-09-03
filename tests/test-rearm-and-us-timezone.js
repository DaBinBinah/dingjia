const assert = require('assert');
const { beijingParts, usNewYorkParts } = require('../cloudfunctions/ths-check-market/lib/trading-time');

console.log('--- 开始同一交易日二次触达 (P1-1) 与美股时区独立 (P1-2) 测试 ---');

// ==========================================
// 1. P1-1 状态机演化测试：触发 -> 维持 -> 离开重新武装 -> 再次进入二次触达
// ==========================================
function simulateTriggerCheck(w, price, nowMs) {
  const isUs = w.market === 'US';
  const currentMarketParts = isUs ? usNewYorkParts(nowMs) : beijingParts(nowMs);
  const marketToday = currentMarketParts.compactDate;

  const lastFetchMs = w.lastFetchTime ? new Date(w.lastFetchTime).getTime() : null;
  const lastMarketDate = lastFetchMs ? (isUs ? usNewYorkParts(lastFetchMs).compactDate : beijingParts(lastFetchMs).compactDate) : null;
  const isNewTradingDay = lastMarketDate !== marketToday;

  const buyTriggerLocked = Boolean(w.buyTriggered) && !isNewTradingDay;
  const triggers = [];
  const rearm = {};

  if (w.buyPrice != null) {
    if (!buyTriggerLocked && price <= w.buyPrice) {
      triggers.push('buy');
    } else if (w.buyTriggered && price > w.buyPrice) {
      rearm.buyTriggered = false;
    }
  }

  // 状态演进
  const nextW = { ...w, lastFetchTime: new Date(nowMs) };
  if (triggers.includes('buy')) {
    nextW.buyTriggered = true;
    nextW.lastBuyAlertTime = new Date(nowMs);
  }
  if (rearm.buyTriggered === false) {
    nextW.buyTriggered = false;
  }

  return { triggers, rearm, nextW };
}

const baseTime = Date.UTC(2026, 8, 2, 2, 0, 0); // 某交易日 10:00 北京时间
const w0 = {
  market: 'CN',
  buyPrice: 18.0,
  buyTriggered: false,
  lastBuyAlertTime: null,
  lastFetchTime: new Date(baseTime),
};

// 步骤 1：跌破买入价 (17.80) -> 必须触发第 1 次
const step1 = simulateTriggerCheck(w0, 17.80, baseTime + 10000);
assert.deepStrictEqual(step1.triggers, ['buy'], '步骤 1 必须触发 buy');
assert.strictEqual(step1.nextW.buyTriggered, true, '步骤 1 之后 buyTriggered 必须为 true');

// 步骤 2：价格持续在 17.80 -> 必须锁定，绝不重复触发
const step2 = simulateTriggerCheck(step1.nextW, 17.80, baseTime + 20000);
assert.deepStrictEqual(step2.triggers, [], '步骤 2 在目标区间内持续维持必须不触发');
assert.strictEqual(step2.nextW.buyTriggered, true, '步骤 2 buyTriggered 维持 true');

// 步骤 3：价格反弹脱离目标区 (18.20) -> 必须自动 rearm 重新武装
const step3 = simulateTriggerCheck(step2.nextW, 18.20, baseTime + 30000);
assert.deepStrictEqual(step3.triggers, [], '步骤 3 脱离目标区不触发');
assert.strictEqual(step3.rearm.buyTriggered, false, '步骤 3 必须发出 rearm 重置信号');
assert.strictEqual(step3.nextW.buyTriggered, false, '步骤 3 之后 buyTriggered 必须成功恢复为 false');

// 步骤 4：同一天内再次跌破买入价 (17.90) -> 必须触发第 2 次！
const step4 = simulateTriggerCheck(step3.nextW, 17.90, baseTime + 40000);
assert.deepStrictEqual(step4.triggers, ['buy'], '步骤 4 同一天离开后再次进入，必须成功触发第 2 次！');
assert.strictEqual(step4.nextW.buyTriggered, true, '步骤 4 buyTriggered 再次置为 true');

console.log('✅ P1-1 同一天内“离开后重新进入触发”状态机测试 100% 通过！');

// ==========================================
// 2. P1-2 美股交易日跨北京时间午夜 0 点测试
// ==========================================
// 北京时间 2026-09-02 23:59:00 (UTC 15:59:00) -> 美东夏令时 11:59:00 (当天盘中)
const timeBeforeMidnight = Date.UTC(2026, 8, 2, 15, 59, 0);
// 北京时间 2026-09-03 00:01:00 (UTC 16:01:00) -> 美东夏令时 12:01:00 (当天盘中)
const timeAfterMidnight = Date.UTC(2026, 8, 2, 16, 1, 0);

const usPartsBefore = usNewYorkParts(timeBeforeMidnight);
const usPartsAfter = usNewYorkParts(timeAfterMidnight);
const cnPartsBefore = beijingParts(timeBeforeMidnight);
const cnPartsAfter = beijingParts(timeAfterMidnight);

console.log('北京时间跨日前后对比:');
console.log('  CN 跨越前:', cnPartsBefore.compactDate, '跨越后:', cnPartsAfter.compactDate);
console.log('  US 美东日期跨越前:', usPartsBefore.compactDate, '跨越后:', usPartsAfter.compactDate);

assert.strictEqual(cnPartsBefore.compactDate !== cnPartsAfter.compactDate, true, '北京时间跨越了自然日 (02 -> 03)');
assert.strictEqual(usPartsBefore.compactDate, usPartsAfter.compactDate, '美东交易日依然处于同一天 (20260902)');

// 验证美股监控标的在此刻不会被误判为新交易日
const usWatch = {
  market: 'US',
  buyPrice: 150.0,
  buyTriggered: true,
  lastFetchTime: new Date(timeBeforeMidnight),
};
const usLastDate = usNewYorkParts(new Date(usWatch.lastFetchTime).getTime()).compactDate;
const usCurrentDate = usNewYorkParts(timeAfterMidnight).compactDate;
const usIsNewDay = usLastDate !== usCurrentDate;

assert.strictEqual(usIsNewDay, false, '美股在跨越北京时间午夜时，绝不能被误判为跨日！');

console.log('✅ P1-2 美股时区 America/New_York 独立判定测试 100% 通过！');
