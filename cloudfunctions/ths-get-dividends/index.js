/**
 * ths-get-dividends —— 分红雷达与分红日历服务
 *
 * 模式：
 * 1. mode=detail: { type, code, currentPrice?, buyPrice? }
 *    → 返回单个标的的完整分红历史、最新分红、股息率、倒计时与统计评级
 * 2. mode=batch: { list: [{ type, code, currentPrice?, buyPrice? }] }
 *    → 批量返回各标的分红摘要（供首页卡片与分红雷达批量渲染）
 * 3. mode=calendar: 自动汇聚所有监控标的的未来与历史分红日历序列
 */
const cloud = require('@cloudbase/node-sdk');
const { fetchTradingDays, toThsCode } = require('./lib/ths-api');
const { beijingParts, getTradingPhase } = require('./lib/trading-time');
const { getDividendData } = require('./lib/dividend-service');
const { getFundamentals } = require('./lib/fundamental-service');
const { assertAccess } = require('./lib/access-guard');

const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
const db = app.database();

const WATCH_COLL = 'ths_watchlist';
const CONFIG_COLL = 'ths_config';

async function loadTradingDays(nowMs) {
  const today = beijingParts(nowMs).compactDate;
  const coll = db.collection(CONFIG_COLL);
  const snap = await coll.where({ key: 'trading_days' }).limit(1).get();
  const cache = (snap.data && snap.data[0]) || null;
  if (cache && cache.date === today && Array.isArray(cache.days)) return new Set(cache.days);
  const days = await fetchTradingDays();
  if (!days) return null;
  const arr = [...days];
  if (cache) await coll.doc(cache._id).update({ date: today, days: arr }).catch(() => {});
  else await coll.add({ key: 'trading_days', date: today, days: arr }).catch(() => {});
  return new Set(arr);
}

exports.main = async (event = {}) => {
  const denied = assertAccess(event);
  if (denied) return denied;

  const nowMs = Date.now();
  const settingsSnap = await db.collection(CONFIG_COLL).where({ key: 'settings' }).limit(1).get();
  const settingsDoc = (settingsSnap.data && settingsSnap.data[0]) || {};
  const holidays = Array.isArray(settingsDoc.holidays) ? settingsDoc.holidays : [];
  const tradingDays = await loadTradingDays(nowMs).catch(() => null);

  const mode = event.mode || 'detail';

  try {
    if (mode === 'fundamentals') {
      const type = String(event.type || '').trim().toLowerCase();
      const code = String(event.code || '').trim();
      if (type === 'etf') return { ok: true, type: 'etf', fundamentals: null };
      if (type !== 'stock') return { ok: false, error: '只支持股票基本面查询' };
      const thsCode = event.thsCode || toThsCode('stock', code);
      if (!thsCode) return { ok: false, error: '无法识别股票代码' };
      const fundamentals = await getFundamentals(db, thsCode, code);
      return { ok: true, type: 'stock', code, thsCode, fundamentals };
    }

    if (mode === 'detail') {
      const type = String(event.type || '');
      const code = String(event.code || '').trim();
      if (!['stock', 'etf'].includes(type)) return { ok: false, error: '类型必须为 stock 或 etf' };
      const currentPrice = typeof event.currentPrice === 'number' ? event.currentPrice : null;
      const buyPrice = typeof event.buyPrice === 'number' ? event.buyPrice : null;

      const thsCode = toThsCode(type, code);
      const [data, fundamentals] = await Promise.all([
        getDividendData(db, type, code, {
          currentPrice,
          buyPrice,
          tradingDays,
          holidays,
        }),
        type === 'stock' && thsCode ? getFundamentals(db, thsCode, code).catch(() => null) : null,
      ]);

      if (data && fundamentals) {
        data.fundamentals = fundamentals;
      }

      return { ok: true, data, fundamentals };
    }

    if (mode === 'batch') {
      const list = Array.isArray(event.list) ? event.list.slice(0, 300) : [];
      const dividends = {};
      const CONCURRENCY = 5;

      for (let i = 0; i < list.length; i += CONCURRENCY) {
        await Promise.all(
          list.slice(i, i + CONCURRENCY).map(async (item) => {
            const type = String(item.type || '');
            const code = String(item.code || '').trim();
            const thsCode = toThsCode(type, code);
            if (!thsCode) return;
            try {
              const d = await getDividendData(db, type, code, {
                currentPrice: typeof item.currentPrice === 'number' ? item.currentPrice : null,
                buyPrice: typeof item.buyPrice === 'number' ? item.buyPrice : null,
                tradingDays,
                holidays,
              });
              dividends[thsCode] = d;
            } catch (e) {
              dividends[thsCode] = { hasDividend: false, error: e.message };
            }
          })
        );
      }

      return { ok: true, dividends };
    }

    if (mode === 'calendar') {
      // 汇聚所有开启监控标的的分红
      const snap = await db.collection(WATCH_COLL).where({ enabled: true }).get();
      const watches = snap.data || [];
      const events = [];

      for (const w of watches) {
        try {
          const d = await getDividendData(db, w.type, w.code, {
            currentPrice: typeof w.currentPrice === 'number' ? w.currentPrice : null,
            buyPrice: typeof w.buyPrice === 'number' ? w.buyPrice : null,
            tradingDays,
            holidays,
          });
          if (d && Array.isArray(d.items)) {
            for (const it of d.items) {
              events.push({
                watchId: w._id,
                code: w.code,
                thsCode: w.thsCode,
                name: w.name,
                type: w.type,
                currentPrice: w.currentPrice,
                buyPrice: w.buyPrice,
                dividendPerShare: it.dividendPerShare,
                recordDate: it.recordDate,
                recordDateMs: it.recordDateMs,
                exDividendDate: it.exDividendDate,
                exDateMs: it.exDateMs,
                paymentDate: it.paymentDate,
                paymentDateMs: it.paymentDateMs,
                fiscalYear: it.fiscalYear,
                tradingDaysLeft: d.tradingDaysLeft,
                dividendYield: d.dividendYield,
                buyDividendYield: d.buyDividendYield,
                isToday: d.isToday,
                isPassed: d.isPassed,
              });
            }
          }
        } catch (_) {}
      }

      // 按登记日/除息日倒序
      events.sort((a, b) => (b.recordDateMs || b.exDateMs || 0) - (a.recordDateMs || a.exDateMs || 0));
      return { ok: true, events, serverTime: nowMs };
    }

    return { ok: false, error: `不支持的模式：${mode}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
};
