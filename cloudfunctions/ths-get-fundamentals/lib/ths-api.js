/**
 * 同花顺金融数据服务 REST 客户端 (基本面估值与财务指标扩展 - 高性能并发优化版)
 */
const DEFAULT_BASE_URL = 'https://fuyao.aicubes.cn';
const TIMEOUT_MS = 6000;

class ThsApiError extends Error {
  constructor(message, code, httpStatus) {
    super(message);
    this.name = 'ThsApiError';
    this.code = code || 'UNKNOWN';
    this.httpStatus = httpStatus || null;
  }
}

function getApiKey() {
  const key = process.env.THS_API_KEY || 'REDACTED_THS_API_KEY';
  if (!key) throw new ThsApiError('未配置环境变量 THS_API_KEY', 'CONFIG_MISSING');
  return key;
}

async function thsRequest(path, params = {}) {
  const url = new URL(path, process.env.THS_API_BASE_URL || DEFAULT_BASE_URL);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { headers: { 'X-api-key': getApiKey() }, signal: controller.signal });
  } catch (e) {
    throw new ThsApiError(e.name === 'AbortError' ? '请求超时' : `网络错误：${e.message}`, 'NETWORK');
  } finally {
    clearTimeout(timer);
  }
  let body;
  try {
    body = JSON.parse(await res.text());
  } catch {
    throw new ThsApiError(`响应不是合法 JSON（HTTP ${res.status}）`, 'BAD_RESPONSE', res.status);
  }
  if (body.code !== 0) {
    throw new ThsApiError(body.message || `业务错误 code=${body.code}`, body.code, res.status);
  }
  return body.data;
}

function toThsCode(type, code) {
  const c = String(code || '').trim();
  if (!/^\d{6}$/.test(c)) return null;
  if (type === 'stock') {
    if (/^(60|68)/.test(c)) return `${c}.SH`;
    if (/^(00|30)/.test(c)) return `${c}.SZ`;
    if (/^(43|83|87|92)/.test(c)) return `${c}.BJ`;
    return null;
  }
  if (type === 'etf') {
    if (/^5/.test(c)) return `${c}.SH`;
    if (/^1/.test(c)) return `${c}.SZ`;
    return null;
  }
  return null;
}

/** 获取股票估值快照（PE_TTM、PB_MRQ 等） */
async function fetchValuations(thsCodes) {
  const map = {};
  if (!Array.isArray(thsCodes) || !thsCodes.length) return map;
  try {
    const data = await thsRequest('/api/a-share/valuations/snapshot', { thscodes: thsCodes.join(',') });
    for (const item of (data && data.item) || []) {
      if (item && item.thscode) {
        map[item.thscode] = {
          peTtm: typeof item.pe_ttm === 'number' ? item.pe_ttm : null,
          peMrq: typeof item.pe_mrq === 'number' ? item.pe_mrq : null,
          pbMrq: typeof item.pb_mrq === 'number' ? item.pb_mrq : null,
          psTtm: typeof item.ps_ttm === 'number' ? item.ps_ttm : null,
          pcfTtm: typeof item.pcf_ttm === 'number' ? item.pcf_ttm : null,
        };
      }
    }
  } catch (e) {}
  return map;
}

/** 获取股票 ROE（优先最快命中最成熟的财报期，并发加速） */
async function fetchRoe(thsCode) {
  // 针对同花顺数据源，优先探测 2024-4（最新年报）、2024-3（三季报）、2024-2（中报）、2023-4
  const priorityReports = ['2024-4', '2024-3', '2024-2', '2023-4'];
  
  for (const report of priorityReports) {
    try {
      const data = await thsRequest('/api/a-share/financials/indicators', { thscode: thsCode, report });
      if (data && data.abilities) {
        const prof = data.abilities.find((a) => a.ability === 'profitability');
        if (prof && prof.indicators) {
          const weightedRoe = prof.indicators.find((i) => i.index_id === 'index_weighted_avg_roe');
          const deductRoe = prof.indicators.find((i) => i.index_id === 'index_deduct_weighted_avg_roe');
          const target = weightedRoe || deductRoe;
          if (target && target.value != null && !isNaN(parseFloat(target.value))) {
            return {
              roe: parseFloat(target.value),
              report,
              isDeduct: !weightedRoe && !!deductRoe,
            };
          }
        }
      }
    } catch (e) {
      // 当前报告期无数据，快速尝试下一期
    }
  }
  return null;
}

module.exports = {
  ThsApiError,
  thsRequest,
  toThsCode,
  fetchValuations,
  fetchRoe,
};
