/**
 * ths-ack-price-touch —— 用户确认查看触达记录（只改变 readStatus，绝不修改成交状态）
 */
const cloud = require('@cloudbase/node-sdk');
const { assertAccess } = require('./lib/access-guard');

const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
const db = app.database();

const TOUCH_COLL = 'ths_price_touches';

exports.main = async (event = {}) => {
  const denied = assertAccess(event);
  if (denied) return denied;

  const id = event.id;
  const code = event.code;

  if (!id && !code) {
    return { ok: false, error: '缺少 id 或 code 参数' };
  }

  const now = new Date();
  try {
    if (id) {
      await db.collection(TOUCH_COLL).doc(id).update({
        readAt: now,
        status: 'CLOSED',
      });
    } else if (code) {
      await db.collection(TOUCH_COLL).where({ code, status: 'ACTIVE' }).update({
        readAt: now,
        status: 'CLOSED',
      });
    }
    return { ok: true, ackedAt: now };
  } catch (e) {
    return { ok: false, error: `确认查看失败: ${e.message}` };
  }
};
