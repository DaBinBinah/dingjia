/**
 * A 股交易时间判断（东八区；中国无夏令时，固定 +8 偏移）
 * 交易时段：09:30–11:30、13:00–15:00，周一至周五
 */
const CST_OFFSET_MS = 8 * 3600 * 1000;

function pad(n) {
  return String(n).padStart(2, '0');
}

function beijingParts(nowMs = Date.now()) {
  const d = new Date(nowMs + CST_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: d.getUTCDay(), // 0=周日 … 6=周六
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    dateStr: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    compactDate: `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`,
  };
}

/**
 * 当前交易阶段
 * @param {Object} opts
 * @param {string[]}   opts.holidays    额外节假日列表（YYYY-MM-DD），交易日历接口失败时的兜底
 * @param {Set|null}   opts.tradingDays 交易日历（'YYYYMMDD' 集合）；null 表示日历不可用，退化为星期判断
 * @param {number}     opts.nowMs
 * @returns {'trading'|'lunch-break'|'pre-open'|'closed'|'weekend'|'holiday'}
 */
function getTradingPhase({ holidays = [], tradingDays = null, nowMs = Date.now() } = {}) {
  const p = beijingParts(nowMs);
  if (Array.isArray(holidays) && holidays.includes(p.dateStr)) return 'holiday';
  if (p.weekday === 0 || p.weekday === 6) return 'weekend';
  if (tradingDays && !tradingDays.has(p.compactDate)) return 'holiday';
  const m = p.minutes;
  if (m >= 570 && m < 690) return 'trading'; // 09:30–11:30
  if (m >= 690 && m < 780) return 'lunch-break'; // 11:30–13:00
  if (m >= 780 && m < 900) return 'trading'; // 13:00–15:00
  if (m < 570) return 'pre-open';
  return 'closed';
}

function isTradingTime(phase) {
  return phase === 'trading';
}

module.exports = { CST_OFFSET_MS, beijingParts, getTradingPhase, isTradingTime };
