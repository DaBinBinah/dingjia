/**
 * 同花顺金融数据服务 REST 客户端
 * 契约来源：https://fuyao.aicubes.cn 官方文档（2026-08 逐字段核对）
 * - 认证：请求头 X-api-key（来自环境变量 THS_API_KEY，绝不进入前端）
 * - 成功条件：HTTP 200 且信封 code === 0；data 在业务错误时为 null
 * - 股票快照支持逗号批量；ETF 快照仅接受单个 thscode
 */
const DEFAULT_BASE_URL = 'https://fuyao.aicubes.cn';
const TIMEOUT_MS = 8000;
const STOCK_BATCH_SIZE = 100;

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

/** 6 位数字代码 → 带市场后缀的 thscode；无法识别返回 null */
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

function normalizeQuote(raw, sourceTimestamp) {
  if (!raw || typeof raw.last_price !== 'number') return null;
  const price = raw.last_price;
  let changePercent = null;
  if (typeof raw.price_change_ratio_pct === 'number') {
    changePercent = raw.price_change_ratio_pct;
  } else if (typeof raw.prev_price === 'number' && raw.prev_price > 0) {
    changePercent = ((price - raw.prev_price) / raw.prev_price) * 100;
  }
  return {
    price,
    changePercent,
    prevPrice: typeof raw.prev_price === 'number' ? raw.prev_price : null,
    openPrice: typeof raw.open_price === 'number' ? raw.open_price : null,
    dayHigh: typeof raw.high_price === 'number' ? raw.high_price : null,
    dayLow: typeof raw.low_price === 'number' ? raw.low_price : null,
    volume: typeof raw.volume === 'number' ? raw.volume : null,
    turnover: typeof raw.turnover === 'number' ? raw.turnover : null,
    marketDataTime: sourceTimestamp ? new Date(sourceTimestamp) : null,
  };
}

/**
 * 按类型获取行情快照。
 * 股票走批量端点（每批最多 100 只）；ETF 官方端点仅支持单个，逐只请求，串行以避免限流。
 */
async function fetchQuotes(type, thsCodes) {
  const quotes = {};
  const failures = {};
  if (!Array.isArray(thsCodes) || !thsCodes.length) return { quotes, failures };

  if (type === 'stock') {
    for (let i = 0; i < thsCodes.length; i += STOCK_BATCH_SIZE) {
      const batch = thsCodes.slice(i, i + STOCK_BATCH_SIZE);
      try {
        const data = await thsRequest('/api/a-share/prices/snapshot', { thscodes: batch.join(',') });
        const got = new Set();
        const srcTs = data && data.timestamp;
        for (const item of (data && data.item) || []) {
          const q = normalizeQuote(item, srcTs);
          if (q) {
            quotes[item.thscode] = q;
            got.add(item.thscode);
          }
        }
        for (const code of batch) if (!got.has(code)) failures[code] = '行情为空或标的不存在';
      } catch (e) {
        if (batch.length > 1) {
          const CONCURRENCY = 5;
          for (let j = 0; j < batch.length; j += CONCURRENCY) {
            await Promise.all(
              batch.slice(j, j + CONCURRENCY).map(async (code) => {
                try {
                  const data = await thsRequest('/api/a-share/prices/snapshot', { thscodes: code });
                  const item = (data && data.item && data.item[0]) || null;
                  const q = normalizeQuote(item, data && data.timestamp);
                  if (q) quotes[code] = q;
                  else failures[code] = '行情为空或标的不存在';
                } catch (e2) {
                  failures[code] = e2.message;
                }
              })
            );
          }
        } else {
          failures[batch[0]] = e.message;
        }
      }
    }
    return { quotes, failures };
  }

  if (type === 'etf') {
    for (const code of thsCodes) {
      try {
        const data = await thsRequest('/api/fund/market/snapshot', { thscode: code });
        const item = (data && data.item && data.item[0]) || null;
        const q = normalizeQuote(item);
        if (q) quotes[code] = q;
        else failures[code] = '行情为空';
      } catch (e) {
        failures[code] = e.message;
      }
    }
    return { quotes, failures };
  }

  for (const code of thsCodes) failures[code] = `不支持的类型：${type}`;
  return { quotes, failures };
}

/** 按代码搜索标的名称（快照不含名称，此端点用于补全）；失败返回 null，不影响主流程 */
async function searchTickerName(q) {
  try {
    const data = await thsRequest('/api/meta/tickers/search', { q, limit: 1 });
    const item = (data && data.item && data.item[0]) || null;
    return item ? item.name : null;
  } catch {
    return null;
  }
}

/**
 * 查询 A 股近一年交易日序列
 * @returns {Promise<Set<string>|null>} 'YYYYMMDD' 集合；接口失败返回 null（调用方退化为仅星期判断）
 */
async function fetchTradingDays() {
  try {
    const data = await thsRequest('/api/a-share/calendar/trading-days');
    const days = new Set();
    for (const it of (data && data.item) || []) if (it && it.date) days.add(String(it.date));
    return days;
  } catch {
    return null;
  }
}

/**
 * 查询分红 / 公司行动记录
 * 股票：/api/a-share/corporate-actions/adjustment-factors
 * ETF：/api/fund/corporate-actions/dividends
 */
async function fetchCorporateActions(type, thsCode) {
  if (type === 'stock') {
    const data = await thsRequest('/api/a-share/corporate-actions/adjustment-factors', { thscode: thsCode });
    return (data && data.item) || [];
  }
  if (type === 'etf') {
    const data = await thsRequest('/api/fund/corporate-actions/dividends', {
      fund_type: 'etf',
      thscode: thsCode,
    });
    return (data && data.item) || [];
  }
  return [];
}

module.exports = {
  ThsApiError,
  thsRequest,
  toThsCode,
  fetchQuotes,
  searchTickerName,
  fetchTradingDays,
  fetchCorporateActions,
};
