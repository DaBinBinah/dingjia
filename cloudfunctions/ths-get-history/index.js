/**
 * ths-get-history —— 历史行情、年度涨跌（YTD）、年内高低点与多周期统计
 *
 * 双模式：
 *   mode=detail（详情页）：{ type, code }
 *     → { ok, thsCode, items:[{d,c}...升序], y2025, y2026, base2025, base2026, last, lastDate,
 *         yearHigh, yearLow, r5d, r10d, r20d, stats20d, statsAll }
 *   mode=perf（首页批量）：{ list: [{type, code}] }
 *     → { ok, perf: { [thsCode]: {y2025, y2026, base2025, base2026, last, lastDate, yearHigh, yearLow, r5d, r10d, r20d} } }
 *
 * 数据来源：同花顺历史 K 线端点（股票 /api/a-share/prices/historical，前复权；
 * ETF /api/fund/market/historical），只取真实数据，绝不伪造。
 *
 * 缓存：ths_history_cache 集合按 thsCode 存「当日」序列（北京日）；同一天内重复读取
 * 不产生任何行情 API 请求，跨天自动重建。
 */
const cloud = require('@cloudbase/node-sdk');
const { thsRequest, toThsCode } = require('./lib/ths-api');
const { fetchUsHistory, normalizeUsSymbol } = require('./lib/yahoo-api');
const { assertAccess } = require('./lib/access-guard');

const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
const db = app.database();

const CACHE_COLL = 'ths_history_cache';
const START_MS = Date.UTC(2023, 11, 15);
const MAX_POINTS = 8000;
const PERF_CONCURRENCY = 5;
const YEARS = [2025, 2026];

function beijingYear(ms) {
  return new Date(ms + 8 * 3600 * 1000).getUTCFullYear();
}

function beijingCompact() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

function round(val, decimals = 2) {
  if (typeof val !== 'number' || !Number.isFinite(val)) return null;
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

/** 拉取历史日线原始数据（升序去重） */
async function fetchHistoryItems(type, thsCode, startMs, endMs) {
  if (type === 'etf') {
    const data = await thsRequest('/api/fund/market/historical', {
      thscode: thsCode,
      interval: '1d',
      start: startMs,
      end: endMs,
    });
    return (data && data.item) || [];
  }
  const all = new Map();
  let offset = 0;
  for (let page = 0; page < 60; page++) {
    const data = await thsRequest('/api/a-share/prices/historical', {
      thscode: thsCode,
      interval: '1d',
      start: startMs,
      end: endMs,
      adjust: 'forward',
      offset,
    });
    const items = (data && data.item) || [];
    for (const it of items) if (it && it.date_ms) all.set(it.date_ms, it);
    if (!items.length) break;
    offset += items.length;
    if (all.size >= MAX_POINTS) break;
  }
  return [...all.values()];
}

const { getTradingPhase, beijingParts, getUsTradingPhase } = require('./lib/trading-time');

/** 取序列：当日缓存命中直接返回，否则拉取并写缓存 */
async function getSeries(type, code, livePrice = null, market = 'CN') {
  const isUs = market === 'US' || (/^[A-Z0-9.\-]{1,10}$/.test(code) && !/^\d{6}$/.test(code));
  let thsCode = '';
  let cacheKey = '';

  if (isUs) {
    thsCode = normalizeUsSymbol(code);
    cacheKey = `US_${thsCode}`;
  } else {
    thsCode = toThsCode(type, code);
    if (!thsCode) throw new Error('代码无法识别');
    cacheKey = thsCode;
  }

  const nowMs = Date.now();
  const todayParts = beijingParts(nowMs);
  const todayCompact = todayParts.compactDate;
  const phase = isUs ? getUsTradingPhase(nowMs) : getTradingPhase({ nowMs });
  const isClosed = isUs ? (phase === 'closed' || phase === 'weekend') : (phase === 'closed' || phase === 'weekend' || phase === 'holiday');

  let raw = null;
  try {
    const snap = await db.collection(CACHE_COLL).doc(cacheKey).get();
    const doc = Array.isArray(snap.data) ? snap.data[0] : snap.data;
    if (doc && doc.date === todayCompact && Array.isArray(doc.items) && doc.items.length) {
      raw = doc.items;
    }
  } catch (_) {
    // 缓存未命中
  }

  if (!raw) {
    if (isUs) {
      const usData = await fetchUsHistory(thsCode, '2y', '1d');
      raw = (usData.items || []).map((it) => ({
        d: it.date_ms,
        c: round(it.close_price, 2),
        h: round(it.high_price, 2),
        l: round(it.low_price, 2),
      })).sort((a, b) => a.d - b.d);
    } else {
      const fetched = await fetchHistoryItems(type, thsCode, START_MS, nowMs);
      raw = fetched
        .filter((it) => typeof it.close_price === 'number')
        .map((it) => ({
          d: it.date_ms,
          c: round(it.close_price, type === 'etf' ? 3 : 2),
          h: round(typeof it.high_price === 'number' ? it.high_price : it.close_price, type === 'etf' ? 3 : 2),
          l: round(typeof it.low_price === 'number' ? it.low_price : it.close_price, type === 'etf' ? 3 : 2),
        }))
        .sort((a, b) => a.d - b.d);
    }

    if (raw.length) {
      db.collection(CACHE_COLL)
        .doc(cacheKey)
        .set({ market: isUs ? 'US' : 'CN', type, thsCode, date: todayCompact, items: raw, updatedAt: new Date() })
        .catch(() => {});
    }
  }

  // 区分盘中未收盘 vs 盘后已收盘：
  // 1. 若当前仍处于盘中交易时段（未收盘），历史收盘日K线序列排除当天的未完成行情
  // 2. 若当前已收盘，当天作为已完成交易日保留，且收盘价与实时最新价对齐
  const items = [];
  for (const it of raw) {
    const itParts = beijingParts(it.d);
    const isToday = itParts.compactDate === todayCompact;
    if (isToday) {
      if (!isClosed) {
        // 盘中未收盘：不作为历史收盘日K线
        continue;
      } else if (typeof livePrice === 'number' && livePrice > 0) {
        // 已收盘：确保与最终收盘价严格对齐
        items.push({
          d: it.d,
          c: round(livePrice, type === 'etf' ? 3 : 2),
          h: round(typeof it.h === 'number' ? it.h : livePrice, type === 'etf' ? 3 : 2),
          l: round(typeof it.l === 'number' ? it.l : livePrice, type === 'etf' ? 3 : 2),
        });
        continue;
      }
    }
    items.push({
      d: it.d,
      c: it.c,
      h: typeof it.h === 'number' ? it.h : it.c,
      l: typeof it.l === 'number' ? it.l : it.c,
    });
  }

  return { thsCode, items, phase, isClosed };
}

/** 计算日线统计指标（上涨/下跌/持平天数、概率、最大单日涨跌幅） */
function calculateIntervalStats(sliceItems) {
  if (!sliceItems || sliceItems.length < 2) {
    return { upDays: 0, downDays: 0, flatDays: 0, upProb: null, maxUp: null, maxDown: null };
  }
  let upDays = 0;
  let downDays = 0;
  let flatDays = 0;
  let maxUp = null;
  let maxDown = null;

  for (let i = 1; i < sliceItems.length; i++) {
    const prev = sliceItems[i - 1].c;
    const cur = sliceItems[i].c;
    if (prev <= 0) continue;
    const pct = ((cur - prev) / prev) * 100;
    if (pct > 0.0001) {
      upDays++;
      if (maxUp === null || pct > maxUp) maxUp = pct;
    } else if (pct < -0.0001) {
      downDays++;
      if (maxDown === null || pct < maxDown) maxDown = pct;
    } else {
      flatDays++;
    }
  }
  const total = upDays + downDays + flatDays;
  const upProb = total > 0 ? round((upDays / total) * 100, 1) : null;
  return {
    upDays,
    downDays,
    flatDays,
    upProb,
    maxUp: round(maxUp, 2),
    maxDown: round(maxDown, 2),
  };
}

/** 计算 52 周滚动极值与距离百分比（以当前时间为基准向前滚动 52 周 = 364 天） */
function calc52WeeksMetrics(items, { type = 'stock', livePrice = null, intradayHigh = null, intradayLow = null, isClosed = true, nowMs = Date.now() } = {}) {
  const start52wMs = nowMs - 52 * 7 * 86400 * 1000;
  const startDateStr = new Date(start52wMs + 8 * 3600000).toISOString().slice(0, 10);
  const endDateStr = new Date(nowMs + 8 * 3600000).toISOString().slice(0, 10);

  const emptyOut = {
    high: null,
    low: null,
    distHigh: null,
    distLow: null,
    currentPrice: typeof livePrice === 'number' ? round(livePrice, type === 'etf' ? 3 : 2) : null,
    tradeDays: 0,
    startDate: startDateStr,
    endDate: endDateStr,
    sufficient: false,
    reason: '当前暂无历史行情数据',
    intraday: !isClosed,
  };

  if (!items || !items.length) return emptyOut;

  // 1. 过滤 52 周有效历史日K
  const items52w = items.filter((it) => it.d >= start52wMs);
  const tradeDays = items52w.length;

  // 2. 数据充足性检查（正常一年 240~245 交易日，若少于 100 天则为上市不满 52 周的新标的）
  if (tradeDays < 100) {
    let high = null;
    let low = null;
    if (tradeDays > 0) {
      high = items52w[0].h || items52w[0].c;
      low = items52w[0].l || items52w[0].c;
      for (const it of items52w) {
        const h = it.h || it.c;
        const l = it.l || it.c;
        if (h > high) high = h;
        if (l < low) low = l;
      }
    }
    return {
      high: high != null ? round(high, type === 'etf' ? 3 : 2) : null,
      low: low != null ? round(low, type === 'etf' ? 3 : 2) : null,
      distHigh: null,
      distLow: null,
      currentPrice: typeof livePrice === 'number' ? round(livePrice, type === 'etf' ? 3 : 2) : (items.length ? items[items.length - 1].c : null),
      tradeDays,
      startDate: startDateStr,
      endDate: endDateStr,
      sufficient: false,
      reason: '当前历史数据不足52周',
      intraday: !isClosed,
    };
  }

  // 3. 统计 52 周最高价与最低价
  let high = items52w[0].h || items52w[0].c;
  let low = items52w[0].l || items52w[0].c;
  for (const it of items52w) {
    const h = it.h || it.c;
    const l = it.l || it.c;
    if (h > high) high = h;
    if (l < low) low = l;
  }

  // 4. 若当前处于交易时段（未收盘），合并盘中实时最高价、最低价与最新价
  if (!isClosed) {
    if (typeof intradayHigh === 'number' && intradayHigh > high) high = intradayHigh;
    else if (typeof livePrice === 'number' && livePrice > high) high = livePrice;

    if (typeof intradayLow === 'number' && intradayLow > 0 && intradayLow < low) low = intradayLow;
    else if (typeof livePrice === 'number' && livePrice > 0 && livePrice < low) low = livePrice;
  }

  high = round(high, type === 'etf' ? 3 : 2);
  low = round(low, type === 'etf' ? 3 : 2);

  // 5. 计算当前价格与距离 52 周最高/最低的百分比
  const cur = typeof livePrice === 'number' && livePrice > 0
    ? round(livePrice, type === 'etf' ? 3 : 2)
    : (items.length ? items[items.length - 1].c : null);

  let distHigh = null;
  let distLow = null;
  if (cur != null && high != null && high > 0) {
    distHigh = round(((cur - high) / high) * 100, 2);
  }
  if (cur != null && low != null && low > 0) {
    distLow = round(((cur - low) / low) * 100, 2);
  }

  return {
    high,
    low,
    distHigh,
    distLow,
    currentPrice: cur,
    tradeDays,
    startDate: startDateStr,
    endDate: endDateStr,
    sufficient: true,
    reason: null,
    intraday: !isClosed,
  };
}

/** 全面计算年度 YTD、年内高低点、近 5/10/20 日表现及统计 */
function calcHistoryMetrics(items, opts = {}) {
  const out = {
    y2025: null,
    y2026: null,
    base2025: null,
    base2026: null,
    last: null,
    lastDate: null,
    yearHigh: null,
    yearLow: null,
    r5d: null,
    r10d: null,
    r20d: null,
    stats20d: null,
    statsAll: null,
    w52: null,
  };
  if (!items || !items.length) return out;

  const len = items.length;
  const last = items[len - 1];
  out.last = last.c;
  out.lastDate = last.d;

  // 1. 年度 YTD
  for (const year of YEARS) {
    const first = items.find((it) => beijingYear(it.d) === year);
    if (first && first.c > 0) {
      out['y' + year] = round(((last.c - first.c) / first.c) * 100, 2);
      out['base' + year] = first.c;
    }
  }

  // 2. 2026 年内最高价与最低价
  const items2026 = items.filter((it) => beijingYear(it.d) === 2026);
  if (items2026.length) {
    let high = items2026[0].h || items2026[0].c;
    let low = items2026[0].l || items2026[0].c;
    for (const it of items2026) {
      const h = it.h || it.c;
      const l = it.l || it.c;
      if (h > high) high = h;
      if (l < low) low = l;
    }
    out.yearHigh = round(high, (opts && opts.type === 'etf') ? 3 : 2);
    out.yearLow = round(low, (opts && opts.type === 'etf') ? 3 : 2);
  }

  // 3. 近 5 日 / 10 日 / 20 日表现
  if (len >= 6) {
    const base5 = items[len - 6].c;
    if (base5 > 0) out.r5d = round(((last.c - base5) / base5) * 100, 2);
  }
  if (len >= 11) {
    const base10 = items[len - 11].c;
    if (base10 > 0) out.r10d = round(((last.c - base10) / base10) * 100, 2);
  }
  if (len >= 21) {
    const base20 = items[len - 21].c;
    if (base20 > 0) out.r20d = round(((last.c - base20) / base20) * 100, 2);
  }

  // 4. 近 20 个交易日统计
  const recent20 = items.slice(-21);
  out.stats20d = calculateIntervalStats(recent20);
  out.statsAll = calculateIntervalStats(items);

  // 5. 近 52 周滚动极值与百分比
  out.w52 = calc52WeeksMetrics(items, opts);

  return out;
}

exports.main = async (event = {}) => {
  const denied = assertAccess(event);
  if (denied) return denied;

  try {
    if (event.mode === 'detail') {
      const type = String(event.type || '');
      const code = String(event.code || '').trim();
      const market = String(event.market || 'CN').trim().toUpperCase() === 'US' ? 'US' : 'CN';
      if (!['stock', 'etf'].includes(type)) return { ok: false, error: '类型必须为 stock 或 etf' };
      const livePrice = typeof event.currentPrice === 'number' ? event.currentPrice : null;
      const intradayHigh = typeof event.dayHigh === 'number' ? event.dayHigh : null;
      const intradayLow = typeof event.dayLow === 'number' ? event.dayLow : null;

      const { thsCode, items, phase, isClosed } = await getSeries(type, code, livePrice, market);
      const metrics = calcHistoryMetrics(items, {
        type,
        livePrice,
        intradayHigh,
        intradayLow,
        isClosed,
      });

      return { ok: true, market, thsCode, items, ...metrics, phase, isClosed, empty: items.length === 0 };
    }

    // perf 批量模式：分批并发
    const list = Array.isArray(event.list) ? event.list.slice(0, 300) : [];
    const perf = {};
    for (let i = 0; i < list.length; i += PERF_CONCURRENCY) {
      await Promise.all(
        list.slice(i, i + PERF_CONCURRENCY).map(async (item) => {
          try {
            const type = String(item.type || '');
            const market = String(item.market || 'CN').trim().toUpperCase() === 'US' ? 'US' : 'CN';
            const { thsCode, items } = await getSeries(type, String(item.code || '').trim(), null, market);
            perf[thsCode] = calcHistoryMetrics(items, {
              type,
              livePrice: typeof item.currentPrice === 'number' ? item.currentPrice : null,
            });
          } catch (e) {
            perf[String(item.code || '')] = { y2025: null, y2026: null, error: e.message };
          }
        })
      );
    }
    return { ok: true, perf };
  } catch (e) {
    return { ok: false, error: e.message };
  }
};
