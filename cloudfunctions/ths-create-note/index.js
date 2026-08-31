/**
 * ths-create-note —— 记录投资日记
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

  const code = event.code ? String(event.code).trim() : '';
  const name = String(event.name || '').trim();
  const content = String(event.content || '').trim();
  if (!content) {
    return { ok: false, error: '日记内容不能为空' };
  }

  const price = event.price != null ? Number(event.price) : null;
  const tags = Array.isArray(event.tags) ? event.tags.map((t) => String(t).trim()).filter(Boolean) : [];
  const dateStr = event.date || new Date().toISOString().slice(0, 10);
  const now = new Date();

  const doc = {
    code,
    name,
    date: dateStr,
    price,
    tags,
    content,
    createdAt: now,
    updatedAt: now,
  };

  try {
    let res;
    try {
      res = await db.collection(NOTES_COLL).add(doc);
    } catch (e) {
      if (e && (e.code === 'DATABASE_COLLECTION_NOT_EXIST' || /Db or Table not exist/i.test(e.message))) {
        await ensureCollections();
        res = await db.collection(NOTES_COLL).add(doc);
      } else {
        throw e;
      }
    }

    return { ok: true, id: res.id, doc: { _id: res.id, ...doc } };
  } catch (e) {
    return { ok: false, error: `保存日记失败: ${e.message}` };
  }
};
