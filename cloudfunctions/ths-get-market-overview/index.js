/**
 * ths-get-market-overview —— 大盘基准指数（沪深300、上证指数、深证成指、创业板指）行情与对比基准
 */
const cloud = require('@cloudbase/node-sdk');
const { fetchQuotes } = require('./lib/ths-api');
const { getTradingPhase, beijingParts } = require('./lib/trading-time');
const { assertAccess } = require('./lib/access-guard');

const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
const db = app.database();

/**
 * 中国 A 股四大核心市场基准指数（严格遵循官方代码与标准全称/通俗简称）
 */
const BENCHMARKS = [
  { code: '000001.SH', name: '上证指数', shortName: '沪指', fullName: '沪指（上证指数）' },
  { code: '399001.SZ', name: '深证成指', shortName: '深指', fullName: '深指（深证成指）' },
  { code: '399006.SZ', name: '创业板指', shortName: '创指', fullName: '创指（创业板指）' },
  { code: '000688.SH', name: '科创50', shortName: '科创50', fullName: '科创50' },
  { code: '000300.SH', name: '沪深300', shortName: '沪深300', fullName: '沪深300' },
];

function round(val, decimals = 2) {
  if (typeof val !== 'number' || !Number.isFinite(val)) return null;
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

function formatTime(ts) {
  if (!ts) return null;
  const d = new Date(ts + 8 * 3600000);
  return d.toISOString().slice(11, 19);
}

exports.main = async (event = {}) => {
  const denied = assertAccess(event);
  if (denied) return denied;

  const nowMs = Date.now();
  const phase = getTradingPhase({ nowMs });

  try {
    const codes = BENCHMARKS.map((b) => b.code);
    const { quotes, failures } = await fetchQuotes('stock', codes);

    let maxSourceTs = 0;

    const indices = BENCHMARKS.map((b) => {
      const q = quotes[b.code] || null;
      if (!q || q.price == null) {
        return {
          code: b.code,
          name: b.name,
          shortName: b.shortName,
          fullName: b.fullName,
          price: null,
          change: null,
          changePercent: null,
          prevPrice: null,
          updateTime: null,
          error: (failures && failures[b.code]) || '暂无数据',
        };
      }

      if (q.sourceTimestamp && q.sourceTimestamp > maxSourceTs) {
        maxSourceTs = q.sourceTimestamp;
      }

      return {
        code: b.code,
        name: b.name,
        shortName: b.shortName,
        fullName: b.fullName,
        price: round(q.price, 2),
        change: q.change != null ? round(q.change, 2) : null,
        changePercent: q.changePercent != null ? round(q.changePercent, 2) : null,
        prevPrice: q.prevPrice != null ? round(q.prevPrice, 2) : null,
        openPrice: q.openPrice != null ? round(q.openPrice, 2) : null,
        dayHigh: q.dayHigh != null ? round(q.dayHigh, 2) : null,
        dayLow: q.dayLow != null ? round(q.dayLow, 2) : null,
        updateTime: formatTime(q.sourceTimestamp || nowMs),
        sourceTimestamp: q.sourceTimestamp || nowMs,
      };
    });

    const sh = indices.find((i) => i.code === '000001.SH') || null;
    const sz = indices.find((i) => i.code === '399001.SZ') || null;
    const cyb = indices.find((i) => i.code === '399006.SZ') || null;
    const kc50 = indices.find((i) => i.code === '000688.SH') || null;
    const hs300 = indices.find((i) => i.code === '000300.SH') || null;

    // 前四大核心指数
    const coreIndices = [sh, sz, cyb, kc50].filter(Boolean);

    return {
      ok: true,
      indices: coreIndices,
      allIndices: indices,
      sh,
      sz,
      cyb,
      kc50,
      hs300,
      phase,
      updateTime: formatTime(maxSourceTs || nowMs),
      serverTime: nowMs,
    };
  } catch (e) {
    return { ok: false, error: `读取市场大盘概览失败: ${e.message}` };
  }
};
