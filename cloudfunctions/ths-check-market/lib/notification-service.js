/**
 * 通知服务 —— 渠道注册表模式
 * 调用链：PriceMonitor(ths-check-market) → AlertService → NotificationService
 *
 * 新增通知渠道（Telegram / 微信 / 邮件 / 企业微信 / Push / Webhook）时，只需实现
 * { name, async send(alert, watch) } 并调用 register()，价格监控与分红提醒逻辑不需要改动。
 */
const https = require('https');
const http = require('http');

const channels = [];

function register(channel) {
  if (channel && channel.name && typeof channel.send === 'function') {
    channels.push(channel);
  }
}

function formatAlertLabel(alertType) {
  if (alertType === 'buy') return '买入提醒';
  if (alertType === 'sell') return '卖出提醒';
  if (alertType === 'DIVIDEND_10D') return '分红提醒（距股权登记日10个交易日）';
  if (alertType === 'DIVIDEND_5D') return '分红提醒（距股权登记日5个交易日）';
  if (alertType === 'DIVIDEND_3D') return '分红临近（距股权登记日3个交易日）';
  if (alertType === 'DIVIDEND_1D') return '分红重要提醒（明天为股权登记日）';
  if (alertType === 'DIVIDEND_TODAY') return '分红提醒（今日为股权登记日）';
  return alertType;
}

// 内置渠道 1：日志
register({
  name: 'console',
  async send(alert) {
    const label = formatAlertLabel(alert.alertType);
    if (alert.alertType.startsWith('DIVIDEND_')) {
      console.log(
        `[通知:console] 💰 ${label} | ${alert.name}(${alert.code}) 每股分红 ¥${alert.dividendPerShare} 登记日=${alert.recordDate} 剩余=${alert.tradingDaysLeft}交易日`
      );
    } else {
      console.log(
        `[通知:console] 🔔 ${label} | ${alert.name}(${alert.code}) 现价=${alert.currentPrice} 阈值=${alert.triggerPrice}`
      );
    }
  },
});

/** 通用 HTTP POST */
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
          'User-Agent': 'ths-check-market/2.0',
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
register({
  name: 'webhook',
  async send(alert) {
    const url = (process.env.THS_WEBHOOK_URL || '').trim();
    if (!url) return;
    const isDividend = typeof alert.alertType === 'string' && alert.alertType.startsWith('DIVIDEND_');
    const payload = {
      event: isDividend ? 'dividend_alert' : 'price_alert',
      alertType: alert.alertType,
      alertLabel: formatAlertLabel(alert.alertType),
      name: alert.name,
      code: alert.code,
      type: alert.type,
      currentPrice: alert.currentPrice,
      triggerPrice: alert.triggerPrice,
      dividendPerShare: alert.dividendPerShare,
      recordDate: alert.recordDate,
      exDividendDate: alert.exDividendDate,
      paymentDate: alert.paymentDate,
      tradingDaysLeft: alert.tradingDaysLeft,
      time: alert.createdAt ? new Date(alert.createdAt).toISOString() : null,
      disclaimer: '分红信息仅供参考，除权除息后股价会相应调整，获得分红不代表无风险收益。',
    };
    const token = (process.env.THS_WEBHOOK_TOKEN || '').trim();
    await postJson(url, payload, token ? { 'X-Token': token } : {});
    console.log(`[通知:webhook] ${alert.alertType} | ${alert.name}(${alert.code}) 推送成功`);
  },
});

module.exports = { register, channels, formatAlertLabel };
