/**
 * 访问控制
 */
function assertAccess(event = {}) {
  const required = process.env.THS_ACCESS_CODE;
  if (!required || !required.trim()) return null;
  const provided = event.accessCode || (event.headers && event.headers['x-ths-access-code']);
  if (provided === required) return null;
  return { ok: false, error: '访问口令错误或已失效', code: 'ACCESS_DENIED' };
}

module.exports = { assertAccess };
