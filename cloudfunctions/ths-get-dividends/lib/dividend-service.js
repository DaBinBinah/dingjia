/**
 * 分红服务模块 (DividendService)
 */
const { fetchCorporateActions, toThsCode } = require('./ths-api');
const { beijingParts, isTradingDay, getTradingDaysBetween, getPrevTradingDay } = require('./trading-time');

const DIVIDEND_COLL = 'ths_dividends';

function round(val, decimals = 2) {
  if (typeof val !== 'number' || !Number.isFinite(val)) return null;
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

function normalizeDividendItems(type, rawItems = [], tradingDays = null, holidays = []) {
  if (!Array.isArray(rawItems)) return [];
  const list = [];

  if (type === 'stock') {
    for (const it of rawItems) {
      const dps = Number(it.dividend_per_share) || 0;
      if (dps <= 0) continue;
      const exMs = Number(it.ex_date_ms);
      if (!Number.isFinite(exMs) || exMs <= 0) continue;

      const exParts = beijingParts(exMs);
      const exDividendDate = exParts.dateStr;
      const rec = getPrevTradingDay(exMs, tradingDays, holidays);
      const recordDateMs = rec.ms;
      const recordDate = rec.dateStr;
      const paymentDateMs = exMs;
      const paymentDate = exDividendDate;

      list.push({
        fiscalYear: exParts.year,
        dividendPerShare: round(dps, 4),
        perShareBonus: Number(it.per_share_bonus) || 0,
        recordDate,
        recordDateMs,
        exDividendDate,
        exDateMs: exMs,
        paymentDate,
        paymentDateMs,
        announcementDate: null,
      });
    }
  } else if (type === 'etf') {
    for (const it of rawItems) {
      const perTen = Number(it.per_ten_cash_before_tax) || Number(it.per_ten_cash_after_tax) || 0;
      const dps = perTen > 0 ? perTen / 10 : 0;
      if (dps <= 0) continue;

      const exMs = Number(it.ex_dividend_date_ms) || null;
      let recMs = Number(it.registration_date_ms) || null;
      if (!recMs && exMs) {
        recMs = getPrevTradingDay(exMs, tradingDays, holidays).ms;
      }
      const payMs = Number(it.payment_date_ms) || exMs || recMs;
      const pubMs = Number(it.publish_date_ms) || null;

      const recParts = recMs ? beijingParts(recMs) : null;
      const exParts = exMs ? beijingParts(exMs) : null;
      const payParts = payMs ? beijingParts(payMs) : null;
      const pubParts = pubMs ? beijingParts(pubMs) : null;

      list.push({
        fiscalYear: recParts ? recParts.year : exParts ? exParts.year : beijingParts().year,
        dividendPerShare: round(dps, 4),
        perShareBonus: 0,
        recordDate: recParts ? recParts.dateStr : null,
        recordDateMs: recMs,
        exDividendDate: exParts ? exParts.dateStr : null,
        exDateMs: exMs,
        paymentDate: payParts ? payParts.dateStr : null,
        paymentDateMs: payMs,
        announcementDate: pubParts ? pubParts.dateStr : null,
      });
    }
  }

  list.sort((a, b) => (b.exDateMs || b.recordDateMs || 0) - (a.exDateMs || a.recordDateMs || 0));
  return list;
}

function calculateDividendStats(items = []) {
  if (!items.length) {
    return {
      consecutiveYears: 0,
      sum3y: null,
      sum5y: null,
      lastAmount: null,
      yoyChange: null,
      stability: 'insufficient',
      stabilityLabel: '数据不足',
    };
  }

  const currentYear = beijingParts().year;
  const yearMap = new Map();
  for (const it of items) {
    const y = it.fiscalYear;
    yearMap.set(y, (yearMap.get(y) || 0) + it.dividendPerShare);
  }

  let consecutiveYears = 0;
  let checkYear = currentYear;
  if (!yearMap.has(checkYear)) checkYear = currentYear - 1;
  while (yearMap.has(checkYear) && yearMap.get(checkYear) > 0) {
    consecutiveYears++;
    checkYear--;
  }

  let sum3y = 0;
  let sum5y = 0;
  for (let i = 0; i < 5; i++) {
    const y = currentYear - i;
    const amt = yearMap.get(y) || 0;
    if (i < 3) sum3y += amt;
    sum5y += amt;
  }

  const lastItem = items[0];
  const lastAmount = lastItem ? lastItem.dividendPerShare : null;
  let yoyChange = null;
  if (items.length >= 2) {
    const prevItem = items[1];
    if (prevItem && prevItem.dividendPerShare > 0) {
      yoyChange = round(((lastItem.dividendPerShare - prevItem.dividendPerShare) / prevItem.dividendPerShare) * 100, 2);
    }
  }

  let stability = 'insufficient';
  let stabilityLabel = '数据不足';
  if (items.length >= 3) {
    if (consecutiveYears >= 3) {
      const recent3 = [yearMap.get(currentYear) || 0, yearMap.get(currentYear - 1) || 0, yearMap.get(currentYear - 2) || 0].filter(
        (x) => x > 0
      );
      const isDeclining = recent3.length >= 2 && recent3[0] < recent3[1] * 0.7;
      if (isDeclining) {
        stability = 'volatile';
        stabilityLabel = '分红波动';
      } else {
        stability = 'stable';
        stabilityLabel = '分红稳定';
      }
    } else if (consecutiveYears === 0 && items.length >= 2) {
      stability = 'interrupted';
      stabilityLabel = '分红中断';
    } else {
      stability = 'volatile';
      stabilityLabel = '分红波动';
    }
  } else if (items.length > 0) {
    stability = 'insufficient';
    stabilityLabel = '数据较少';
  }

  return {
    consecutiveYears,
    sum3y: round(sum3y, 4),
    sum5y: round(sum5y, 4),
    lastAmount: round(lastAmount, 4),
    yoyChange,
    stability,
    stabilityLabel,
  };
}

function buildDividendSummary(type, code, items, currentPrice = null, buyPrice = null, tradingDays = null, holidays = []) {
  const stats = calculateDividendStats(items);
  const nowMs = Date.now();
  const latest = items[0] || null;

  let tradingDaysLeft = null;
  let isToday = false;
  let isPassed = false;
  let dividendYield = null;
  let buyDividendYield = null;

  if (latest && latest.recordDateMs) {
    tradingDaysLeft = getTradingDaysBetween(nowMs, latest.recordDateMs, tradingDays, holidays);
    isToday = tradingDaysLeft === 0;
    isPassed = tradingDaysLeft < 0;

    if (typeof currentPrice === 'number' && currentPrice > 0 && latest.dividendPerShare > 0) {
      dividendYield = round((latest.dividendPerShare / currentPrice) * 100, 2);
    }
    if (typeof buyPrice === 'number' && buyPrice > 0 && latest.dividendPerShare > 0) {
      buyDividendYield = round((latest.dividendPerShare / buyPrice) * 100, 2);
    }
  }

  return {
    type,
    code,
    hasDividend: items.length > 0,
    items,
    latest,
    tradingDaysLeft,
    isToday,
    isPassed,
    dividendYield,
    buyDividendYield,
    stats,
    source: '同花顺金融数据服务',
    sourceUpdatedAt: new Date().toISOString(),
  };
}

async function getDividendData(db, type, code, { currentPrice = null, buyPrice = null, tradingDays = null, holidays = [] } = {}) {
  const thsCode = toThsCode(type, code);
  if (!thsCode) return null;

  const today = beijingParts().compactDate;
  try {
    const snap = await db.collection(DIVIDEND_COLL).doc(thsCode).get();
    const doc = Array.isArray(snap.data) ? snap.data[0] : snap.data;
    if (doc && doc.date === today && Array.isArray(doc.items)) {
      return buildDividendSummary(type, code, doc.items, currentPrice, buyPrice, tradingDays, holidays);
    }
  } catch (_) {
    // 缓存未命中
  }

  try {
    const raw = await fetchCorporateActions(type, thsCode);
    const items = normalizeDividendItems(type, raw, tradingDays, holidays);
    const docToCache = {
      type,
      code,
      thsCode,
      date: today,
      items,
      stats: calculateDividendStats(items),
      updatedAt: new Date(),
    };
    db.collection(DIVIDEND_COLL).doc(thsCode).set(docToCache).catch(() => {});
    return buildDividendSummary(type, code, items, currentPrice, buyPrice, tradingDays, holidays);
  } catch (e) {
    return {
      type,
      code,
      hasDividend: false,
      items: [],
      latest: null,
      error: e.message,
    };
  }
}

module.exports = {
  DIVIDEND_COLL,
  normalizeDividendItems,
  calculateDividendStats,
  buildDividendSummary,
  getDividendData,
};
