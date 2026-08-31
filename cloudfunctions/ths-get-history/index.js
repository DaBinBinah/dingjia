/**
 * ths-get-history —— 历史行情与年度涨跌（YTD）
 *
 * 双模式：
 *   mode=detail（默认为 perf，详情页传 detail）：{ type, code }
 *     → { ok, thsCode, items:[{d,c}...升序], y2025, y2026, base2025, base2026, last, lastDate }
 *   mode=perf（首页批量）：{ list: [{type, code}] }
 *     → { ok, perf: { [thsCode]: {y2025, y2026, base2025, base2026, last, lastDate} } }
 *
 * 数据来源：同花顺历史 K 线端点（股票 /api/a-share/prices/historical，前复权；
 * ETF /api/fund/market/historical），只取真实数据，绝不伪造。
 *
 * 缓存：ths_history_cache 集合按 thsCode 存「当日」序列（北京日）；同一天内重复读取
 * 不产生任何行情 API 请求，跨天自动重建。前复权基准可能因除权除息变化，故不跨天增量合并。
 */
const cloud = require('@cloudbase/node-sdk');
const { thsRequest, toThsCode } = require('./lib/ths-api');
const { assertAccess } = require('./lib/access-guard');

const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
const db = app.database();

const CACHE_COLL = 'ths_history_cache';
// 锚点略早于 2024-01-01：保证 2024 首条有前收（涨跌可算），并覆盖 2025/2026 年首个交易日
const START_MS = Date.UTC(2023, 11, 15);
const MAX_POINTS = 8000; // 安全上限（2023-12 至今约 650 个交易日）
const PERF_CONCURRENCY = 5; // perf 模式逐标的拉取的并发数
const YEARS = [2025, 2026];

function beijingYear(ms) {
  return new Date(ms + 8 * 3600 * 1000).getUTCFullYear();
}

/** 拉取历史日线原始数据（升序去重） */
async function fetchHistoryItems(type, thsCode, startMs, endMs) {
  if (type === 'etf') {
    // ETF 历史端点无 offset，窗口 ≤5 年（本函数起点在 5 年内）
    const data = await thsRequest('/api/fund/market/historical', {
      thscode: thsCode,
      interval: '1d',
      start: startMs,
      end: endMs,
    });
    return (data && data.item) || [];
  }
  // 股票历史端点支持 offset 分页：循环合并，按 date_ms 去重
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

/** 取序列：当日缓存命中直接返回，否则拉取并写缓存 */
async function getSeries(type, code) {
  const thsCode = toThsCode(type, code);
  if (!thsCode) throw new Error('代码无法识别');
  const today = beijingCompact();
  try {
    const snap = await db.collection(CACHE_COLL).doc(thsCode).get();
    const doc = Array.isArray(snap.data) ? snap.data[0] : snap.data;
    if (doc && doc.date === today && Array.isArray(doc.items) && doc.items.length) {
      return { thsCode, items: doc.items };
    }
  } catch (_) {
    // 缓存未命中属正常，继续拉取
  }
  const raw = await fetchHistoryItems(type, thsCode, START_MS, Date.now());
  const items = raw
    .filter((it) => typeof it.close_price === 'number')
    .map((it) => ({ d: it.date_ms, c: it.close_price }))
    .sort((a, b) => a.d - b.d);
  if (items.length) {
    // 写缓存失败不阻塞返回（下次再建）
    db.collection(CACHE_COLL)
      .doc(thsCode)
      .set({ type, thsCode, date: today, items, updatedAt: new Date() })
      .catch(() => {});
  }
  return { thsCode, items };
}

function beijingCompact() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

/** 年度至今涨跌：该年首个交易日收盘 → 最新收盘；该年无数据为 null */
function calcYtd(items) {
  const out = { y2025: null, y2026: null, base2025: null, base2026: null, last: null, lastDate: null };
  if (!items || !items.length) return out;
  const last = items[items.length - 1];
  out.last = last.c;
  out.lastDate = last.d;
  for (const year of YEARS) {
    const first = items.find((it) => beijingYear(it.d) === year);
    if (first && first.c > 0) {
      out['y' + year] = Math.round(((last.c - first.c) / first.c) * 10000) / 100;
      out['base' + year] = first.c;
    }
  }
  return out;
}

exports.main = async (event = {}) => {
  const denied = assertAccess(event);
  if (denied) return denied;

  try {
    if (event.mode === 'detail') {
      const type = String(event.type || '');
      const code = String(event.code || '').trim();
      if (!['stock', 'etf'].includes(type)) return { ok: false, error: '类型必须为 stock 或 etf' };
      const { thsCode, items } = await getSeries(type, code);
      if (!items.length) return { ok: true, thsCode, items: [], ...calcYtd(items), empty: true };
      return { ok: true, thsCode, items, ...calcYtd(items) };
    }

    // perf 批量模式：分批并发，单标的失败只影响自己
    const list = Array.isArray(event.list) ? event.list.slice(0, 300) : [];
    const perf = {};
    for (let i = 0; i < list.length; i += PERF_CONCURRENCY) {
      await Promise.all(
        list.slice(i, i + PERF_CONCURRENCY).map(async (item) => {
          try {
            const { thsCode, items } = await getSeries(String(item.type || ''), String(item.code || '').trim());
            perf[thsCode] = calcYtd(items);
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
