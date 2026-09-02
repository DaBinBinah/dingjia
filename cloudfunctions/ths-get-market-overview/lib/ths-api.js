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
  const key = process.env.THS_API_KEY;
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

function normalizeQuote(raw, sourceTimestamp) {
  if (!raw || typeof raw.last_price !== 'number') return null;
  const price = raw.last_price;
  let changePercent = null;
  if (typeof raw.price_change_ratio_pct === 'number') {
    changePercent = raw.price_change_ratio_pct;
  } else if (typeof raw.prev_price === 'number' && raw.prev_price > 0) {
    changePercent = ((price - raw.prev_price) / raw.prev_price) * 100;
  }

  let change = null;
  if (typeof raw.price_change === 'number') {
    change = raw.price_change;
  } else if (typeof raw.prev_price === 'number') {
    change = price - raw.prev_price;
  }

  return {
    price,
    change,
    changePercent,
    prevPrice: typeof raw.prev_price === 'number' ? raw.prev_price : null,
    openPrice: typeof raw.open_price === 'number' ? raw.open_price : null,
    dayHigh: typeof raw.high_price === 'number' ? raw.high_price : null,
    dayLow: typeof raw.low_price === 'number' ? raw.low_price : null,
    volume: typeof raw.volume === 'number' ? raw.volume : null,
    turnover: typeof raw.turnover === 'number' ? raw.turnover : null,
    sourceTimestamp: sourceTimestamp || null,
  };
}

async function fetchQuotes(type, thsCodes) {
  const quotes = {};
  const failures = {};
  if (!Array.isArray(thsCodes) || !thsCodes.length) return { quotes, failures };

  for (let i = 0; i < thsCodes.length; i += STOCK_BATCH_SIZE) {
    const batch = thsCodes.slice(i, i + STOCK_BATCH_SIZE);
    try {
      const data = await thsRequest('/api/a-share/prices/snapshot', { thscodes: batch.join(',') });
      const srcTs = data && data.timestamp;
      for (const item of (data && data.item) || []) {
        const q = normalizeQuote(item, srcTs);
        if (q) quotes[item.thscode] = q;
      }
    } catch (e) {
      failures[batch[0]] = e.message;
    }
  }
  return { quotes, failures };
}

module.exports = {
  ThsApiError,
  thsRequest,
  toThsCode,
  fetchQuotes,
};
