/**
 * A 股交易时间判断（东八区；中国无夏令时，固定 +8 偏移）
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

function isTradingDay(dateVal, tradingDays = null, holidays = []) {
  let ms;
  if (typeof dateVal === 'number') {
    ms = dateVal;
  } else if (typeof dateVal === 'string') {
    const s = dateVal.replace(/\D/g, '');
    if (s.length === 8) {
      const y = parseInt(s.slice(0, 4), 10);
      const m = parseInt(s.slice(4, 6), 10) - 1;
      const d = parseInt(s.slice(6, 8), 10);
      ms = Date.UTC(y, m, d) - CST_OFFSET_MS;
    } else {
      ms = new Date(dateVal).getTime();
    }
  } else if (dateVal instanceof Date) {
    ms = dateVal.getTime();
  }
  if (!Number.isFinite(ms)) return false;
  const p = beijingParts(ms);
  if (Array.isArray(holidays) && holidays.includes(p.dateStr)) return false;
  if (p.weekday === 0 || p.weekday === 6) return false;
  if (tradingDays && tradingDays instanceof Set && tradingDays.size > 0) {
    return tradingDays.has(p.compactDate);
  }
  return true;
}

function getTradingDaysBetween(fromVal, toVal, tradingDays = null, holidays = []) {
  const fromP = beijingParts(typeof fromVal === 'number' ? fromVal : new Date(fromVal).getTime());
  const toP = beijingParts(typeof toVal === 'number' ? toVal : new Date(toVal).getTime());
  if (fromP.compactDate === toP.compactDate) return 0;

  const fromMs = Date.UTC(fromP.year, fromP.month - 1, fromP.day);
  const toMs = Date.UTC(toP.year, toP.month - 1, toP.day);

  if (toMs < fromMs) {
    let count = 0;
    let cur = fromMs - 86400000;
    while (cur >= toMs) {
      if (isTradingDay(cur - CST_OFFSET_MS, tradingDays, holidays)) count++;
      cur -= 86400000;
    }
    return -count;
  }

  let count = 0;
  let cur = fromMs + 86400000;
  while (cur <= toMs) {
    if (isTradingDay(cur - CST_OFFSET_MS, tradingDays, holidays)) count++;
    cur += 86400000;
  }
  return count;
}

function getPrevTradingDay(targetVal, tradingDays = null, holidays = []) {
  const p = beijingParts(typeof targetVal === 'number' ? targetVal : new Date(targetVal).getTime());
  let curUtc = Date.UTC(p.year, p.month - 1, p.day) - 86400000;
  for (let i = 0; i < 30; i++) {
    const curMs = curUtc - CST_OFFSET_MS;
    if (isTradingDay(curMs, tradingDays, holidays)) {
      const prevP = beijingParts(curMs);
      return {
        ms: curMs,
        dateStr: prevP.dateStr,
        compactDate: prevP.compactDate,
      };
    }
    curUtc -= 86400000;
  }
  const fallbackP = beijingParts(curUtc - CST_OFFSET_MS);
  return {
    ms: curUtc - CST_OFFSET_MS,
    dateStr: fallbackP.dateStr,
    compactDate: fallbackP.compactDate,
  };
}

module.exports = {
  CST_OFFSET_MS,
  beijingParts,
  getTradingPhase,
  isTradingTime,
  isTradingDay,
  getTradingDaysBetween,
  getPrevTradingDay,
};
