/**
 * ths-update-account —— 更新现金账户与资金设置
 */
const cloud = require('@cloudbase/node-sdk');
const { assertAccess } = require('./lib/access-guard');

const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
const db = app.database();
const ACCOUNTS_COLL = 'ths_accounts';

function round(val, decimals = 2) {
  if (typeof val !== 'number' || !Number.isFinite(val)) return null;
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

async function ensureCollections() {
  try {
    await db.createCollection(ACCOUNTS_COLL);
  } catch (_) {}
}

exports.main = async (event = {}) => {
  const denied = assertAccess(event);
  if (denied) return denied;

  try {
    await ensureCollections().catch(() => {});
    const cash = Number(event.cashBalance);
    const hasCash = Number.isFinite(cash) && cash >= 0;
    const name = String(event.name || '默认账户').trim();

    let snap;
    try {
      snap = await db.collection(ACCOUNTS_COLL).limit(1).get();
    } catch (e) {
      snap = { data: [] };
    }

    const cur = (snap.data && snap.data[0]) || null;

    const now = new Date();
    if (cur) {
      const patch = { updatedAt: now };
      if (hasCash) patch.cashBalance = round(cash, 2);
      if (event.name !== undefined) patch.name = name;
      if (Number.isFinite(Number(event.totalInvested))) {
        patch.totalInvested = round(Number(event.totalInvested), 2);
      }
      await db.collection(ACCOUNTS_COLL).doc(cur._id).update(patch);
      return { ok: true, _id: cur._id, ...cur, ...patch };
    } else {
      const doc = {
        name,
        cashBalance: hasCash ? round(cash, 2) : 0,
        totalInvested: Number.isFinite(Number(event.totalInvested)) ? round(Number(event.totalInvested), 2) : null,
        createdAt: now,
        updatedAt: now,
      };
      const res = await db.collection(ACCOUNTS_COLL).add(doc);
      return { ok: true, _id: res.id, ...doc };
    }
  } catch (e) {
    return { ok: false, error: `更新账户失败：${e.message}` };
  }
};
