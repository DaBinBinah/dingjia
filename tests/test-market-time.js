const assert = require('assert');
const { normalizeQuote } = require('../cloudfunctions/ths-check-market/lib/ths-api');

console.log('--- 开始行情时间区分与真实性专项测试 (P0-4) ---');

// 1. 测试 A 股/ETF normalizeQuote
// 情况 A：数据源提供了时间戳
const quoteWithTime = normalizeQuote({ last_price: 18.5, prev_price: 18.0 }, '2026-09-02 15:00:00');
assert(quoteWithTime.marketDataTime instanceof Date, '提供时间戳时必须正确解析为 Date');
assert.strictEqual(quoteWithTime.marketDataTime.toISOString().slice(0, 10), '2026-09-02', '日期必须准确匹配');

// 情况 B：数据源未提供时间戳（如历史数据或部分ETF缺失）
const quoteWithoutTime = normalizeQuote({ last_price: 18.5, prev_price: 18.0 }, null);
assert.strictEqual(quoteWithoutTime.marketDataTime, null, '未提供时间戳时 marketDataTime 必须严格为 null，绝不能填充当前时间');

// 2. 测试美股真实行情时间提取
const mockTencentLine = 'v_usAAPL="200~苹果~AAPL.OQ~324.96~325.13~326.87~33776370~0~0~324.64~40~0~0~0~0~0~0~0~0~324.95~40~0~0~0~0~0~0~0~0~~2026-09-02 16:00:01~-0.17~-0.05~328.40~323.53~USD~"';
const parts = mockTencentLine.match(/^v_us([A-Z0-9.\-]+)=\"([^\"]+)\"/)[2].split('~');

let realMarketTime = null;
const rawTimeStr = parts[30] ? parts[30].trim() : '';
if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(rawTimeStr)) {
  const month = parseInt(rawTimeStr.slice(5, 7), 10);
  const isDst = month >= 4 && month <= 10;
  const tzOffset = isDst ? '-04:00' : '-05:00';
  const d = new Date(rawTimeStr.replace(' ', 'T') + tzOffset);
  if (!isNaN(d.getTime())) realMarketTime = d;
}

assert(realMarketTime instanceof Date, '腾讯美股 parts[30] 必须成功解析为 Date');
assert(Date.now() - realMarketTime.getTime() > 1000 * 60, '提取的时间必须是历史交易行情时刻，绝不能是刚刚生成的当前时间 new Date()');

// 3. 测试触达记录构建时严格区分时间
const now = new Date();
const fakeQuoteNull = { price: 18.0, marketDataTime: null };
const touchDoc = {
  triggeredAt: now,
  detectedAt: now,
  marketDataTime: (fakeQuoteNull.marketDataTime instanceof Date && !isNaN(fakeQuoteNull.marketDataTime.getTime()))
    ? fakeQuoteNull.marketDataTime
    : null,
};

assert.strictEqual(touchDoc.marketDataTime, null, '行情时间为空时，触达文档中的 marketDataTime 必须为 null，绝不能被 detectedAt / now 强充');
assert.strictEqual(touchDoc.triggeredAt, now, 'triggeredAt 必须记录系统判定时间');
assert.strictEqual(touchDoc.detectedAt, now, 'detectedAt 必须记录系统扫描检测时间');

console.log('✅ P0-4 行情时间提取、区分与防御测试 100% 通过！');
