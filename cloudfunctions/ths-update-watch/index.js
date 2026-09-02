/**
 * ths-update-watch —— 编辑监控标的（名称 / 代码 / 价格线 / 目标价与折扣 / 暂停恢复）
 * 代码或任一价格线变更时重置 previousPrice 与「已达成」记录：下一次扫描按「首次观测」
 * 规则重新评估，已触发的标记保持不变，避免编辑后立刻重复轰炸提醒。
 * 输入：{ _id, name?, code?, buyPrice?, sellPrice?, enabled?,
 *         targetPrice?, buyDiscount?, sellDiscount?, accessCode? }
 */
const cloud = require('@cloudbase/node-sdk');
const { toThsCode } = require('./lib/ths-api');
const { assertAccess } = require('./lib/access-guard');

const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
const db = app.database();
const WATCH_COLL = 'ths_watchlist';

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

function pickDoc(snap) {
  if (!snap || !snap.data) return null;
  return Array.isArray(snap.data) ? snap.data[0] : snap.data;
}

exports.main = async (event = {}) => {
  const denied = assertAccess(event);
  if (denied) return denied;

  try {
    const id = String(event._id || '');
    if (!id) return { ok: false, error: '缺少 _id' };

    const snap = await db.collection(WATCH_COLL).doc(id).get();
    const doc = pickDoc(snap);
    if (!doc) return { ok: false, error: '监控标的不存在' };

    const patch = {};

    if (event.name !== undefined) {
      const name = String(event.name || '').trim().slice(0, 30);
      if (!name) return { ok: false, error: '名称不能为空' };
      if (name !== doc.name) patch.name = name;
    }

    const targetMarket = event.market !== undefined
      ? (String(event.market).trim().toUpperCase() === 'US' ? 'US' : 'CN')
      : (doc.market || 'CN');

    if (event.market !== undefined && targetMarket !== doc.market) {
      patch.market = targetMarket;
      patch.currency = targetMarket === 'US' ? 'USD' : 'CNY';
      patch.timezone = targetMarket === 'US' ? 'America/New_York' : 'Asia/Shanghai';
      patch.dataSource = targetMarket === 'US' ? 'YAHOO' : 'THS';
    }

    // 代码允许修改，类型保持不变
    let codeChanged = false;
    if (event.code !== undefined) {
      let code = String(event.code || '').trim();
      let thsCode = '';

      if (targetMarket === 'US') {
        code = code.toUpperCase().replace(/\//g, '-');
        if (!/^[A-Z0-9.\-]{1,10}$/.test(code)) {
          return { ok: false, error: '美股代码格式不正确（如 AAPL、NVDA、QQQ、SPY）' };
        }
        thsCode = code;
      } else {
        if (!/^\d{6}$/.test(code)) return { ok: false, error: '中国股票/ETF 代码必须为 6 位数字' };
        thsCode = toThsCode(doc.type, code);
        if (!thsCode) return { ok: false, error: '无法识别该代码所属市场' };
      }

      if (code !== doc.code || targetMarket !== doc.market) {
        const dup = await db.collection(WATCH_COLL).where({ code, market: targetMarket }).get();
        const otherDocs = (dup.data || []).filter((d) => String(d._id) !== id);
        if (otherDocs.length > 0) {
          return { ok: false, error: `代码 ${code}（${targetMarket === 'US' ? '美股' : '中国'}）已被其他监控使用` };
        }
        patch.code = code;
        patch.thsCode = thsCode;
        codeChanged = true;
      }
    }

    // 价格线：允许单独修改某一侧，或留空表示取消该侧监控
    let priceChanged = false;
    if (event.buyPrice !== undefined) {
      const v = parsePrice(event.buyPrice);
      if (v === undefined) return { ok: false, error: '买入价格必须是大于 0 的数字或留空' };
      if (v !== doc.buyPrice) {
        patch.buyPrice = v;
        priceChanged = true;
      }
    }
    if (event.sellPrice !== undefined) {
      const v = parsePrice(event.sellPrice);
      if (v === undefined) return { ok: false, error: '卖出价格必须是大于 0 的数字或留空' };
      if (v !== doc.sellPrice) {
        patch.sellPrice = v;
        priceChanged = true;
      }
    }
    const finalBuy = patch.buyPrice !== undefined ? patch.buyPrice : doc.buyPrice;
    const finalSell = patch.sellPrice !== undefined ? patch.sellPrice : doc.sellPrice;
    if (finalBuy === null && finalSell === null) {
      return { ok: false, error: '买入价格和卖出价格不能同时为空' };
    }

    // 目标价与折扣：仅记录，价格线由前端按 目标价 × 折扣 换算后提交
    if (event.targetPrice !== undefined) {
      const v = parsePrice(event.targetPrice);
      if (v === undefined) return { ok: false, error: '目标价必须是大于 0 的数字或留空' };
      if (v !== doc.targetPrice) patch.targetPrice = v;
    }
    if (event.buyDiscount !== undefined) {
      const v = parseDiscount(event.buyDiscount);
      if (v === undefined) return { ok: false, error: '买入折扣必须在 0.01（1%）到 5（500%）之间' };
      if (v !== doc.buyDiscount) patch.buyDiscount = v;
    }
    if (event.sellDiscount !== undefined) {
      const v = parseDiscount(event.sellDiscount);
      if (v === undefined) return { ok: false, error: '卖出折扣必须在 0.01（1%）到 5（500%）之间' };
      if (v !== doc.sellDiscount) patch.sellDiscount = v;
    }

    if (event.enabled !== undefined) {
      const enabled = Boolean(event.enabled);
      if (enabled !== doc.enabled) patch.enabled = enabled;
    }

    if (event.note !== undefined) {
      const note = String(event.note || '').trim().slice(0, 1000);
      if (note !== (doc.note || '')) {
        patch.note = note;
        patch.noteUpdatedAt = note ? new Date() : null;
      }
    }

    // 代码或价格线变化 = 监控目标变化：重置评估基线，并撤销此前达成的「已完成」标记与触发锁
    if (codeChanged || priceChanged) {
      patch.previousPrice = null;
      patch.buyAchievedAt = null;
      patch.sellAchievedAt = null;
      if (patch.buyPrice !== undefined) patch.buyTriggered = false;
      if (patch.sellPrice !== undefined) patch.sellTriggered = false;
    }

    if (!Object.keys(patch).length) return { ok: true, id, unchanged: true };

    patch.updatedAt = new Date();
    const res = await db.collection(WATCH_COLL).doc(id).update(patch);
    const updatedCount = Number(res && (res.updated != null ? res.updated : res.stats ? res.stats.updated : 0));
    if (updatedCount === 0) return { ok: false, error: '更新未生效，请重试' };
    // 异步触发一次即时价格巡检与通知判定
    app.callFunction({ name: 'ths-check-market', data: { force: true } }).catch(() => {});
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: `更新失败：${e.message}` };
  }
};
