/**
 * ths-get-market-overview —— 大盘核心指数行情（中国市场四大指数 + 美国市场四大指数）
 */
const cloud = require('@cloudbase/node-sdk');
const { fetchQuotes } = require('./lib/ths-api');
const { fetchUsIndices } = require('./lib/yahoo-api');
const { getTradingPhase, getUsTradingPhase, beijingParts } = require('./lib/trading-time');
const { assertAccess } = require('./lib/access-guard');

const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
const db = app.database();

/**
 * 中国 A 股四大核心市场基准指数
 */
const CN_BENCHMARKS = [
  { code: '000001.SH', symbol: '000001.SH', name: '上证指数', shortName: '沪指', fullName: '沪指（上证指数）', securityType: 'INDEX', market: 'CN' },
  { code: '399001.SZ', symbol: '399001.SZ', name: '深证成指', shortName: '深指', fullName: '深指（深证成指）', securityType: 'INDEX', market: 'CN' },
  { code: '399006.SZ', symbol: '399006.SZ', name: '创业板指', shortName: '创指', fullName: '创指（创业板指）', securityType: 'INDEX', market: 'CN' },
  { code: '000688.SH', symbol: '000688.SH', name: '科创50', shortName: '科创50', fullName: '科创50', securityType: 'INDEX', market: 'CN' },
  { code: '000300.SH', symbol: '000300.SH', name: '沪深300', shortName: '沪深300', fullName: '沪深300', securityType: 'INDEX', market: 'CN' },
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
  const cnPhase = getTradingPhase({ nowMs });
  const usPhase = getUsTradingPhase(nowMs);

  // 并行获取中国市场指数与美国市场指数，互相独立容错
  const [cnResult, usResult] = await Promise.allSettled([
    (async () => {
      const codes = CN_BENCHMARKS.map((b) => b.code);
      const { quotes, failures } = await fetchQuotes('stock', codes);
      let maxSourceTs = 0;

      const indices = CN_BENCHMARKS.map((b) => {
        const q = quotes[b.code] || null;
        if (!q || q.price == null) {
          return {
            symbol: b.code,
            code: b.code,
            name: b.name,
            shortName: b.shortName,
            fullName: b.fullName,
            price: null,
            change: null,
            changePercent: null,
            prevPrice: null,
            securityType: 'INDEX',
            market: 'CN',
            currency: 'CNY',
            updateTime: null,
            error: (failures && failures[b.code]) || '暂无数据',
          };
        }

        if (q.sourceTimestamp && q.sourceTimestamp > maxSourceTs) {
          maxSourceTs = q.sourceTimestamp;
        }

        return {
          symbol: b.code,
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
          securityType: 'INDEX',
          market: 'CN',
          currency: 'CNY',
          updateTime: formatTime(q.sourceTimestamp || nowMs),
          sourceTimestamp: q.sourceTimestamp || nowMs,
        };
      });

      const sh = indices.find((i) => i.code === '000001.SH') || null;
      const sz = indices.find((i) => i.code === '399001.SZ') || null;
      const cyb = indices.find((i) => i.code === '399006.SZ') || null;
      const kc50 = indices.find((i) => i.code === '000688.SH') || null;
      const hs300 = indices.find((i) => i.code === '000300.SH') || null;

      const coreIndices = [sh, sz, cyb, kc50].filter(Boolean);

      return {
        market: 'CN',
        phase: cnPhase,
        updateTime: formatTime(maxSourceTs || nowMs),
        indices: coreIndices,
        allIndices: indices,
        sh,
        sz,
        cyb,
        kc50,
        hs300,
      };
    })(),
    (async () => {
      const usIndices = await fetchUsIndices();
      return {
        market: 'US',
        phase: usPhase,
        timezone: 'America/New_York',
        updateTime: new Date().toISOString().slice(11, 19),
        dataSource: 'Yahoo Finance',
        indices: usIndices,
      };
    })(),
  ]);

  const cnData = cnResult.status === 'fulfilled' ? cnResult.value : {
    market: 'CN',
    phase: cnPhase,
    updateTime: formatTime(nowMs),
    indices: [],
    error: cnResult.reason?.message || '中国市场指数获取异常',
  };

  const usData = usResult.status === 'fulfilled' ? usResult.value : {
    market: 'US',
    phase: usPhase,
    timezone: 'America/New_York',
    updateTime: new Date().toISOString().slice(11, 19),
    dataSource: 'Yahoo Finance',
    indices: [],
    error: usResult.reason?.message || '美国市场指数获取异常',
  };

  return {
    ok: true,
    serverTime: nowMs,
    // 🇨🇳 中国市场
    cn: cnData,
    // 🇺🇸 美国市场
    us: usData,
    // 向后兼容旧字段
    phase: cnData.phase,
    updateTime: cnData.updateTime,
    indices: cnData.indices || [],
    allIndices: cnData.allIndices || [],
    sh: cnData.sh || null,
    sz: cnData.sz || null,
    cyb: cnData.cyb || null,
    kc50: cnData.kc50 || null,
    hs300: cnData.hs300 || null,
  };
};
