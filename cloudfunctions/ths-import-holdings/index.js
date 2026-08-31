/**
 * ths-import-holdings —— 批量导入持仓
 *
 * 输入：{
 *   rows: [ { type, code, name, quantity, costPrice, buyDate?, accountName? } ],
 *   duplicateStrategy: 'skip' | 'update' | 'overwrite',
 *   accessCode?
 * }
 */
const cloud = require('@cloudbase/node-sdk');
const { toThsCode, searchTickerName } = require('./lib/ths-api');
const { assertAccess } = require('./lib/access-guard');

const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
const db = app.database();
const HOLDINGS_COLL = 'ths_holdings';
const WATCH_COLL = 'ths_watchlist';

const MAX_ROWS = 1000;
const ADD_CHUNK = 100;

function round(val, decimals = 2) {
  if (typeof val !== 'number' || !Number.isFinite(val)) return null;
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

async function ensureCollections() {
  try {
    await db.createCollection(HOLDINGS_COLL);
  } catch (_) {}
}

async function safeQuery(fn, fallback = { data: [] }) {
  try {
    return await fn();
  } catch (e) {
    if (e && (e.code === 'DATABASE_COLLECTION_NOT_EXIST' || /Db or Table not exist/i.test(e.message))) {
      await ensureCollections().catch(() => {});
      try {
        return await fn();
      } catch (_) {
        return fallback;
      }
    }
    throw e;
  }
}

exports.main = async (event = {}) => {
  const denied = assertAccess(event);
  if (denied) return denied;

  const rawRows = Array.isArray(event.rows) ? event.rows : [];
  if (!rawRows.length) return { ok: false, error: '导入数据为空' };
  if (rawRows.length > MAX_ROWS) return { ok: false, error: `单次最多导入 ${MAX_ROWS} 条记录` };

  const strategy = ['skip', 'update', 'overwrite'].includes(event.duplicateStrategy)
    ? event.duplicateStrategy
    : 'skip';

  try {
    await ensureCollections().catch(() => {});
    // 1. 读取已有持仓和监控映射
    const [existSnap, watchSnap] = await Promise.all([
      safeQuery(() => db.collection(HOLDINGS_COLL).limit(1000).get()),
      safeQuery(() => db.collection(WATCH_COLL).limit(1000).get()),
    ]);


    const existMap = new Map();
    for (const h of existSnap.data || []) {
      existMap.set(h.code, h);
    }

    const watchMap = new Map();
    for (const w of watchSnap.data || []) {
      watchMap.set(w.code, w);
    }

    const validated = [];
    const failed = [];

    for (let i = 0; i < rawRows.length; i++) {
      const r = rawRows[i] || {};
      const type = String(r.type || 'stock').trim();
      const code = String(r.code || '').trim();
      const name = String(r.name || '').trim();
      const qty = Number(r.quantity);
      const costP = Number(r.costPrice);

      if (!['stock', 'etf'].includes(type)) {
        failed.push({ code, reason: '类型必须为 stock 或 etf' });
        continue;
      }
      if (!/^\d{6}$/.test(code)) {
        failed.push({ code, reason: '代码必须为 6 位数字' });
        continue;
      }
      const thsCode = toThsCode(type, code);
      if (!thsCode) {
        failed.push({ code, reason: '代码号段无法识别' });
        continue;
      }
      if (!Number.isFinite(qty) || qty <= 0) {
        failed.push({ code, reason: '持仓数量必须为正整数' });
        continue;
      }
      if (!Number.isFinite(costP) || costP <= 0) {
        failed.push({ code, reason: '成本价必须大于 0' });
        continue;
      }

      const finalQty = Math.floor(qty);
      const finalCostP = round(costP, 4);
      const costAmount = round(finalQty * finalCostP, 2);

      validated.push({
        type,
        code,
        thsCode,
        name: name || code,
        quantity: finalQty,
        costPrice: finalCostP,
        costAmount,
        buyDate: r.buyDate ? String(r.buyDate).trim() : null,
        accountName: r.accountName ? String(r.accountName).trim() : '默认账户',
        targetQuantity: Number.isFinite(Number(r.targetQuantity)) ? Math.floor(Number(r.targetQuantity)) : null,
        plannedAmount: Number.isFinite(Number(r.plannedAmount)) ? round(Number(r.plannedAmount), 2) : null,
        note: r.note ? String(r.note).trim() : '',
        watchId: watchMap.has(code) ? watchMap.get(code)._id : null,
      });
    }

    if (strategy === 'overwrite') {
      const allExist = existSnap.data || [];
      for (const cur of allExist) {
        await db.collection(HOLDINGS_COLL).doc(cur._id).remove().catch(() => {});
      }
      existMap.clear();
    }

    const toAdd = [];
    const toUpdate = [];
    let skipped = 0;

    for (const v of validated) {
      const exist = existMap.get(v.code);
      if (!exist) {
        toAdd.push(v);
      } else if (strategy === 'skip') {
        skipped++;
      } else if (strategy === 'update') {
        toUpdate.push({ ...v, _id: exist._id });
      }
    }

    let added = 0;
    let updated = 0;
    const now = new Date();

    // 批量新增
    for (let i = 0; i < toAdd.length; i += ADD_CHUNK) {
      const chunk = toAdd.slice(i, i + ADD_CHUNK);
      const docs = chunk.map((v) => ({ ...v, createdAt: now, updatedAt: now }));
      try {
        await db.collection(HOLDINGS_COLL).add(docs);
        added += docs.length;
      } catch (e) {
        for (const doc of docs) {
          try {
            await db.collection(HOLDINGS_COLL).add(doc);
            added++;
          } catch (e2) {
            failed.push({ code: doc.code, reason: e2.message });
          }
        }
      }
    }

    // 逐条更新
    for (const u of toUpdate) {
      try {
        await db.collection(HOLDINGS_COLL).doc(u._id).update({
          name: u.name,
          quantity: u.quantity,
          costPrice: u.costPrice,
          costAmount: u.costAmount,
          buyDate: u.buyDate,
          accountName: u.accountName,
          targetQuantity: u.targetQuantity,
          plannedAmount: u.plannedAmount,
          note: u.note,
          watchId: u.watchId,
          updatedAt: now,
        });
        updated++;
      } catch (e) {
        failed.push({ code: u.code, reason: e.message });
      }
    }

    return {
      ok: true,
      added,
      updated,
      skipped,
      failed,
      totalProcessed: rawRows.length,
    };
  } catch (e) {
    return { ok: false, error: `批量导入持仓失败：${e.message}` };
  }
};
