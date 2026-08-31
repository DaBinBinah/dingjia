/**
 * ths-get-market-overview —— 大盘基准指数（沪深300、上证指数、深证成指、创业板指）行情与对比基准
 */
const cloud = require('@cloudbase/node-sdk');
const { fetchQuotes, thsRequest } = require('./lib/ths-api');
const { assertAccess } = require('./lib/access-guard');

const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
const db = app.database();

const CACHE_COLL = 'ths_history_cache';

const BENCHMARKS = [
  { code: '000300.SH', name: '沪深300' },
  { code: '000001.SH', name: '上证指数' },
  { code: '399001.SZ', name: '深证成指' },
  { code: '399006.SZ', name: '创业板指' },
];

function round(val, decimals = 2) {
  if (typeof val !== 'number' || !Number.isFinite(val)) return null;
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

exports.main = async (event = {}) => {
  const denied = assertAccess(event);
  if (denied) return denied;

  try {
    const codes = BENCHMARKS.map((b) => b.code);
    const { quotes } = await fetchQuotes('stock', codes);

    const indices = BENCHMARKS.map((b) => {
      const q = quotes[b.code] || {};
      return {
        code: b.code,
        name: b.name,
        price: q.price != null ? round(q.price, 2) : null,
        changePercent: q.changePercent != null ? round(q.changePercent, 2) : null,
        prevPrice: q.prevPrice != null ? round(q.prevPrice, 2) : null,
      };
    });

    const hs300 = indices.find((i) => i.code === '000300.SH') || null;
    const sh = indices.find((i) => i.code === '000001.SH') || null;

    return {
      ok: true,
      indices,
      hs300,
      sh,
      serverTime: Date.now(),
    };
  } catch (e) {
    return { ok: false, error: `读取市场大盘概览失败: ${e.message}` };
  }
};
