/**
 * ths-create-watch —— 新增监控标的
 * 输入：{ type, code, name, buyPrice?, sellPrice?, enabled?,
 *         targetPrice?, buyDiscount?, sellDiscount?, accessCode? }
 * 校验：类型合法、代码 6 位且市场可识别、名称非空、价格有效数字、至少一条价格线、代码查重。
 * 目标价/折扣仅为记录（编辑回填用），价格线由前端按 目标价 × 折扣 换算后提交。
 */
const cloud = require('@cloudbase/node-sdk');
const { toThsCode, fetchQuotes } = require('./lib/ths-api');
const { assertAccess } = require('./lib/access-guard');

const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
const db = app.database();
const WATCH_COLL = 'ths_watchlist';

/** 价格解析：空值 → null（表示不监控该侧）；非法 → undefined（校验失败） */
function parsePrice(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n >= 1000000) return undefined;
  return Math.round(n * 10000) / 10000;
}

/** 折扣解析：0.9 / 1.05 等「倍率」或 90 / 105 等「百分比」都接受，统一存小数倍率（倍率上限 5，即 500%） */
function parseDiscount(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const d = n > 2 ? n / 100 : n;
  if (d > 5) return undefined;
  return Math.round(d * 10000) / 10000;
}

exports.main = async (event = {}) => {
  const denied = assertAccess(event);
  if (denied) return denied;

  try {
    const type = String(event.type || '');
    if (!['stock', 'etf'].includes(type)) {
      return { ok: false, error: '类型必须为 stock（股票）或 etf（ETF）' };
    }

    const code = String(event.code || '').trim();
    if (!/^\d{6}$/.test(code)) return { ok: false, error: '代码必须为 6 位数字' };
    const thsCode = toThsCode(type, code);
    if (!thsCode) return { ok: false, error: '无法识别该代码所属市场，请检查代码是否正确' };

    const name = String(event.name || '').trim().slice(0, 30);
    if (!name) return { ok: false, error: '请填写标的名称' };

    const buyPrice = parsePrice(event.buyPrice);
    const sellPrice = parsePrice(event.sellPrice);
    if (buyPrice === undefined) return { ok: false, error: '买入价格必须是大于 0 的数字或留空' };
    if (sellPrice === undefined) return { ok: false, error: '卖出价格必须是大于 0 的数字或留空' };
    if (buyPrice === null && sellPrice === null) {
      return { ok: false, error: '请至少填写买入价格或卖出价格之一' };
    }

    const targetPrice = parsePrice(event.targetPrice);
    const buyDiscount = parseDiscount(event.buyDiscount);
    const sellDiscount = parseDiscount(event.sellDiscount);
    if (targetPrice === undefined) return { ok: false, error: '目标价必须是大于 0 的数字或留空' };
    if (buyDiscount === undefined) return { ok: false, error: '买入折扣必须在 0.01（1%）到 5（500%）之间' };
    if (sellDiscount === undefined) return { ok: false, error: '卖出折扣必须在 0.01（1%）到 5（500%）之间' };

    // 防止重复添加相同代码（数据库唯一索引兜底）
    const dup = await db.collection(WATCH_COLL).where({ code }).count();
    if (dup.total > 0) return { ok: false, error: `代码 ${code} 已在监控列表中` };

    const now = new Date();
    let currentPrice = null;
    let changePercent = null;
    let quoteError = null;
    let lastFetchTime = null;

    try {
      const { quotes, failures } = await fetchQuotes(type, [thsCode]);
      if (quotes && quotes[thsCode]) {
        currentPrice = quotes[thsCode].price;
        changePercent = quotes[thsCode].changePercent;
        lastFetchTime = now;
      } else if (failures && failures[thsCode]) {
        quoteError = failures[thsCode];
      }
    } catch (qe) {
      quoteError = qe.message;
    }

    const doc = {
      type,
      code,
      thsCode,
      name,
      buyPrice,
      sellPrice,
      targetPrice,
      buyDiscount,
      sellDiscount,
      enabled: event.enabled !== false,
      currentPrice,
      previousPrice: null,
      changePercent,
      buyTriggered: buyPrice != null && currentPrice != null && currentPrice <= buyPrice,
      sellTriggered: sellPrice != null && currentPrice != null && currentPrice >= sellPrice,
      buyAchievedAt: buyPrice != null && currentPrice != null && currentPrice <= buyPrice ? now : null,
      sellAchievedAt: sellPrice != null && currentPrice != null && currentPrice >= sellPrice ? now : null,
      lastBuyAlertTime: null,
      lastSellAlertTime: null,
      quoteError,
      lastFetchTime,
      createdAt: now,
      updatedAt: now,
    };
    const res = await db.collection(WATCH_COLL).add(doc);
    return { ok: true, id: res.id || (res.data && res.data.id) || null };
  } catch (e) {
    const msg = /duplicate|E11000/i.test(String(e.message))
      ? '该代码已在监控列表中'
      : `创建失败：${e.message}`;
    return { ok: false, error: msg };
  }
};
