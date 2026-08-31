/**
 * 同花顺金融数据服务 REST 客户端 (基本面估值与财务指标扩展)
 */
const DEFAULT_BASE_URL = 'https://fuyao.aicubes.cn';
const TIMEOUT_MS = 8000;

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

/** 获取股票 ROE（加权平均净资产收益率） */
async function fetchRoe(thsCode) {
  const currentYear = new Date().getFullYear();
  // 遍历近 2 年的报告期（Q4, Q3, Q2, Q1）
  const reports = [
    `${currentYear}-4`, `${currentYear}-3`, `${currentYear}-2`, `${currentYear}-1`,
    `${currentYear - 1}-4`, `${currentYear - 1}-3`, `${currentYear - 1}-2`, `${currentYear - 1}-1`
  ];
  for (const report of reports) {
    try {
      const data = await thsRequest('/api/a-share/financials/indicators', { thscode: thsCode, report });
      if (data && data.abilities) {
        const prof = data.abilities.find((a) => a.ability === 'profitability');
        if (prof && prof.indicators) {
          const weightedRoe = prof.indicators.find((i) => i.index_id === 'index_weighted_avg_roe');
          const deductRoe = prof.indicators.find((i) => i.index_id === 'index_deduct_weighted_avg_roe');
          const target = weightedRoe || deductRoe;
          if (target && target.value != null && !isNaN(parseFloat(target.value))) {
            const roeVal = parseFloat(target.value);
            return {
              roe: roeVal,
              report,
              isDeduct: !weightedRoe && !!deductRoe,
            };
          }
        }
      }
    } catch (e) {
      // 忽略单个报告期未出的错误，继续尝试下一个
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
