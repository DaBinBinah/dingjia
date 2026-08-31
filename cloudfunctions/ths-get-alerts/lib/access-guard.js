/**
 * 可选访问口令：设置云函数环境变量 THS_ACCESS_CODE 后，
 * 所有前端调用必须携带相同 accessCode 参数；未设置该环境变量时完全放行（默认关闭）。
 * 定时触发事件（无前端参与）始终放行。
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
