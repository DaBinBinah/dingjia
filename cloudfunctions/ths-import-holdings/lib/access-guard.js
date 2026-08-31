/**
 * 可选访问口令保护
 */
function isTimerEvent(event = {}) {
  return event.Type === 'Timer' || event.TriggerType === 'Timer';
}

function assertAccess(event = {}) {
  const expected = process.env.THS_ACCESS_CODE;
  if (!expected) return null;
  if (isTimerEvent(event)) return null;
  if (String(event.accessCode || '') === expected) return null;
  return { ok: false, error: '需要访问口令', needAccessCode: true };
}

module.exports = { assertAccess, isTimerEvent };
