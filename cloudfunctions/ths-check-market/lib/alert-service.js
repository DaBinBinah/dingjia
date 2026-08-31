/**
 * 提醒服务：PriceMonitor(ths-check-market) → AlertService → NotificationService
 * 只负责提醒的构造、落库与分发。全系统仅此链路产生提醒，绝不包含任何交易/委托/下单逻辑。
 */
const notificationService = require('./notification-service');

/** 构造提醒记录（alerts 集合文档） */
function buildAlert(watch, alertType, currentPrice, now) {
  return {
    watchId: watch._id,
    type: watch.type,
    code: watch.code,
    name: watch.name,
    alertType, // 'buy' | 'sell'
    triggerPrice: alertType === 'buy' ? watch.buyPrice : watch.sellPrice,
    currentPrice,
    createdAt: now,
  };
}

/** 落库 + 分发到全部已注册通知渠道。返回落库是否成功。 */
async function dispatch(db, alertsCollection, alert, watch) {
  try {
    await db.collection(alertsCollection).add(alert);
  } catch (e) {
    console.error('[alert-service] 提醒落库失败:', e.message);
    return false;
  }
  for (const channel of notificationService.channels) {
    try {
      await channel.send(alert, watch);
    } catch (e) {
      // 单渠道失败不影响其他渠道，更不影响监控主流程
      console.error(`[alert-service] 通知渠道 ${channel.name} 失败:`, e.message);
    }
  }
  return true;
}

module.exports = { buildAlert, dispatch };
