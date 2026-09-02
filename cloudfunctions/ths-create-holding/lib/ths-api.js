/**
 * 同花顺金融数据服务 REST 客户端
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

async function searchTickerName(q) {
  try {
    const data = await thsRequest('/api/meta/tickers/search', { q, limit: 1 });
    const item = (data && data.item && data.item[0]) || null;
    return item ? item.name : null;
  } catch {
    return null;
  }
}

module.exports = {
  ThsApiError,
  thsRequest,
  toThsCode,
  searchTickerName,
};
