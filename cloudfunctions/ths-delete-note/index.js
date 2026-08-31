/**
 * ths-delete-note —— 删除投资日记
 */
const cloud = require('@cloudbase/node-sdk');
const { assertAccess } = require('./lib/access-guard');

const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
const db = app.database();

const NOTES_COLL = 'ths_notes';

exports.main = async (event = {}) => {
  const denied = assertAccess(event);
  if (denied) return denied;

  const id = event.id || event._id;
  if (!id) return { ok: false, error: '缺少日记 _id' };

  try {
    await db.collection(NOTES_COLL).doc(id).remove();
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: `删除失败: ${e.message}` };
  }
};
