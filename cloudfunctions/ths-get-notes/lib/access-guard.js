function assertAccess(event = {}) {
  const required = process.env.ACCESS_CODE;
  if (!required) return null;
  const isTimer = event.Type === 'Timer' || event.TriggerType === 'Timer';
  if (isTimer) return null;
  const provided = event.accessCode || (event.headers && event.headers['x-access-code']);
  if (provided !== required) {
    return { ok: false, error: '访问口令错误或未提供', code: 'UNAUTHORIZED' };
  }
  return null;
}
module.exports = { assertAccess };
