/**
 * 通知服务 —— 渠道注册表模式
 * 调用链：PriceMonitor(ths-check-market) → AlertService → NotificationService
 *
 * 新增通知渠道（Telegram / 微信 / 邮件 / 企业微信 / Push / Webhook）时，只需实现
 * { name, async send(alert, watch) } 并调用 register()，价格监控与提醒逻辑不需要改动。
 */
const https = require('https');
const http = require('http');

const channels = [];

function register(channel) {
  if (channel && channel.name && typeof channel.send === 'function') {
    channels.push(channel);
  }
}

// 内置渠道 1：日志（云函数日志中可追溯每一次提醒）
register({
  name: 'console',
  async send(alert) {
    const label = alert.alertType === 'buy' ? '买入提醒' : '卖出提醒';
    console.log(
      `[通知:console] ${label} | ${alert.name}(${alert.code}) 现价=${alert.currentPrice} 阈值=${alert.triggerPrice}`
    );
  },
});

/** 通用 HTTP POST（返回 Promise，网络异常在 send 内捕获，绝不影响提醒主流程） */
function postJson(url, payload, headers = {}, timeoutMs = 6000) {
  const lib = url.startsWith('https:') ? https : http;
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (_) {
      return reject(new Error('WEBHOOK_URL 不是合法 URL'));
    }
    const body = JSON.stringify(payload);
    const req = lib.request(
      u,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': 'ths-check-market/1.0',
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve(data);
          else reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// 内置渠道 2：Webhook（环境变量 THS_WEBHOOK_URL，可选 THS_WEBHOOK_TOKEN 放 X-Token 头）
// 可接 Server酱 / PushPlus / Bark / Telegram Bot API 等任意可收 POST 的服务。
register({
  name: 'webhook',
  async send(alert) {
    const url = (process.env.THS_WEBHOOK_URL || '').trim();
    if (!url) return;
    const payload = {
      event: 'price_alert',
      alertType: alert.alertType,
      name: alert.name,
      code: alert.code,
      currentPrice: alert.currentPrice,
      triggerPrice: alert.triggerPrice,
      time: alert.createdAt ? new Date(alert.createdAt).toISOString() : null,
    };
    const token = (process.env.THS_WEBHOOK_TOKEN || '').trim();
    await postJson(url, payload, token ? { 'X-Token': token } : {});
    console.log(`[通知:webhook] ${alert.alertType} | ${alert.name}(${alert.code}) 推送成功`);
  },
});

module.exports = { register, channels };
