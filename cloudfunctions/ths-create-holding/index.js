/**
 * ths-create-holding —— 添加持仓记录
 *
 * 支持两种输入模式：
 * 1. 按持仓数量：{ type, code, name?, quantity, costPrice, buyDate?, accountName?, targetQuantity?, plannedAmount?, note? }
 * 2. 按投入金额：{ type, code, name?, investedAmount, costPrice, buyDate?, accountName?, targetQuantity?, plannedAmount?, note? }
 *
 * 自动与 ths_watchlist 关联（若存在相同 code 的监控标的则记录 watchId）。
 */
const cloud = require('@cloudbase/node-sdk');
const { toThsCode, searchTickerName } = require('./lib/ths-api');
const { assertAccess } = require('./lib/access-guard');

const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
const db = app.database();

const HOLDINGS_COLL = 'ths_holdings';
const WATCH_COLL = 'ths_watchlist';

function round(val, decimals = 2) {
  if (typeof val !== 'number' || !Number.isFinite(val)) return null;
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

async function ensureCollections() {
  const colls = [HOLDINGS_COLL, 'ths_accounts', 'ths_transactions'];
  for (const c of colls) {
    try {
      await db.createCollection(c);
    } catch (_) {}
  }
}

exports.main = async (event = {}) => {
  const denied = assertAccess(event);
  if (denied) return denied;

  try {
    await ensureCollections().catch(() => {});
    const type = String(event.type || 'stock').trim().toLowerCase();
    if (!['stock', 'etf'].includes(type)) return { ok: false, error: '类型必须为 stock 或 etf' };

    let rawCode = String(event.code || '').trim();
    let market = String(event.market || '').trim().toUpperCase();
    if (!market) {
      market = /^\d{6}$/.test(rawCode) ? 'CN' : 'US';
    }

    let code = rawCode;
    let thsCode = '';
    const currency = market === 'US' ? 'USD' : 'CNY';
    const timezone = market === 'US' ? 'America/New_York' : 'Asia/Shanghai';
    const dataSource = market === 'US' ? 'YAHOO' : 'THS';

    if (market === 'US') {
      code = code.toUpperCase().replace(/\//g, '-');
      if (!/^[A-Z0-9.\-]{1,10}$/.test(code)) {
        return { ok: false, error: '美股代码格式不正确（如 AAPL、NVDA、QQQ、SPY）' };
      }
      thsCode = code;
    } else {
      if (!/^\d{6}$/.test(code)) return { ok: false, error: '中国股票/ETF 代码必须为 6 位数字' };
      thsCode = toThsCode(type, code);
      if (!thsCode) return { ok: false, error: '无法识别代码对应的市场后缀' };
    }

    const costPrice = Number(event.costPrice);
    if (!Number.isFinite(costPrice) || costPrice <= 0) {
      return { ok: false, error: '持仓成本价必须为大于 0 的数字' };
    }

    let quantity = Number(event.quantity);
    let costAmount = 0;

    if (Number.isFinite(quantity) && quantity > 0) {
      // 模式 1：输入持仓数量
      quantity = Math.floor(quantity);
      costAmount = round(quantity * costPrice, 2);
    } else if (Number.isFinite(Number(event.investedAmount)) && Number(event.investedAmount) > 0) {
      // 模式 2：输入投入金额
      const invested = Number(event.investedAmount);
      quantity = Math.floor(invested / costPrice);
      costAmount = round(invested, 2);
    } else {
      return { ok: false, error: '请输入有效的持仓数量或投入金额' };
    }

    if (quantity <= 0) {
      return { ok: false, error: '换算得到的持仓数量必须大于 0' };
    }

    // 自动获取名称（若未传入）
    let name = String(event.name || '').trim();
    if (!name) {
      if (market === 'US') name = code;
      else name = (await searchTickerName(code).catch(() => null)) || code;
    }

    // 自动查找是否已有相同监控
    let watchId = null;
    try {
      const wSnap = await db.collection(WATCH_COLL).where({ code, market }).limit(1).get();
      if (wSnap.data && wSnap.data[0]) {
        watchId = wSnap.data[0]._id;
      }
    } catch (_) {}

    const now = new Date();
    const doc = {
      market,
      securityType: type === 'etf' ? 'ETF' : 'STOCK',
      currency,
      timezone,
      dataSource,
      type,
      code,
      thsCode,
      name,
      quantity,
      costPrice: round(costPrice, 4),
      costAmount,
      buyDate: event.buyDate ? String(event.buyDate).trim() : null,
      accountName: event.accountName ? String(event.accountName).trim() : '默认账户',
      targetQuantity: Number.isFinite(Number(event.targetQuantity)) ? Math.floor(Number(event.targetQuantity)) : null,
      plannedAmount: Number.isFinite(Number(event.plannedAmount)) ? round(Number(event.plannedAmount), 2) : null,
      note: event.note ? String(event.note).trim() : '',
      watchId,
      createdAt: now,
      updatedAt: now,
    };

    const res = await db.collection(HOLDINGS_COLL).add(doc);
    return { ok: true, _id: res.id, doc };
  } catch (e) {
    return { ok: false, error: `添加持仓失败：${e.message}` };
  }
};
