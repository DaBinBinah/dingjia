/**
 * ths-get-notes —— 读取投资日记列表
 */
const cloud = require('@cloudbase/node-sdk');
const { assertAccess } = require('./lib/access-guard');

const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
const db = app.database();

const NOTES_COLL = 'ths_notes';

async function ensureCollections() {
  try { await db.createCollection(NOTES_COLL); } catch (_) {}
}

exports.main = async (event = {}) => {
  const denied = assertAccess(event);
  if (denied) return denied;

  const code = event.code ? String(event.code).trim() : null;

  try {
    let snap;
    try {
      snap = code
        ? await db.collection(NOTES_COLL).where({ code }).orderBy('createdAt', 'desc').get()
        : await db.collection(NOTES_COLL).orderBy('createdAt', 'desc').limit(100).get();
    } catch (e) {
      if (e && (e.code === 'DATABASE_COLLECTION_NOT_EXIST' || /Db or Table not exist/i.test(e.message))) {
        await ensureCollections();
        snap = { data: [] };
      } else {
        throw e;
      }
    }

    return { ok: true, items: snap.data || [] };
  } catch (e) {
    return { ok: false, error: `读取投资日记失败: ${e.message}` };
  }
};
