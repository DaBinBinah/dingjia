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

// ========================================================================
// 内置渠道 3：微信推送（Server酱 / PushPlus）
//
// 环境变量（云函数配置，只需配一个）：
//   THS_WECHAT_SENDKEY         — Server酱 SendKey（SCT/sctp 开头）
//   THS_WECHAT_PUSHPLUS_TOKEN  — PushPlus Token
//
// 优先级：Server酱 > PushPlus（避免重复推送）
// 都未配置时 send() 直接 return，不报错不阻塞。
// 分红提醒不推微信（仅价格触达推送）。
// ========================================================================

/** 构造微信消息正文（Markdown 格式） */
function buildWechatMessage(alert) {
  const time = alert.createdAt
    ? new Date(new Date(alert.createdAt).getTime() + 8 * 3600000)
        .toISOString().replace('T', ' ').slice(0, 19)
    : '未知';

  const isBuy = alert.alertType === 'buy';
  const emoji = isBuy ? '🟢' : '🔴';
  const action = isBuy ? '买入' : '卖出';
  const typeLabel = alert.type === 'etf' ? 'ETF' : '股票';

  return {
    title: `🔔 盯价提醒 | ${alert.name} 已达到${action}价格`,
    body: [
      `${emoji} 已达到${action}价格`,
      '',
      `${typeLabel}名称：${alert.name}`,
      `${typeLabel}代码：${alert.code}`,
      '',
      `当前价格：¥${alert.currentPrice}`,
      `我的${action}价：¥${alert.triggerPrice}`,
      '',
      `系统检测时间：${time}`,
      '',
      `⚠️ 这是价格触达提醒，不代表系统建议${action}。`,
    ].join('\n'),
  };
}

/** Server酱发送（兼容 SCT / sctp 两种 Key） */
async function sendViaServerChan(sendKey, title, body) {
  let url;
  if (sendKey.startsWith('sctp')) {
    // sctp 格式：sctp<数字>T<...> → https://<数字>.push.ft07.com/send/<key>.send
    const match = sendKey.match(/^sctp(\d+)T/);
    const num = match ? match[1] : '0';
    url = `https://${num}.push.ft07.com/send/${sendKey}.send`;
  } else {
    url = `https://sctapi.ftqq.com/${sendKey}.send`;
  }
  const payload = { title: title.slice(0, 32), desp: body };
  const resp = await postJson(url, payload, {}, 8000);
  try {
    const r = JSON.parse(resp);
    if (r.code !== 0) throw new Error(`Server酱返回错误: code=${r.code} ${r.message || ''}`);
  } catch (e) {
    if (e.message.startsWith('Server酱')) throw e;
    // JSON 解析失败但 HTTP 200，视为已发送
  }
}

/** PushPlus 发送 */
async function sendViaPushPlus(token, title, body) {
  const url = 'https://www.pushplus.plus/send';
  const payload = {
    token,
    title: title.slice(0, 100),
    content: body.replace(/\n/g, '<br>'),
    template: 'html',
    channel: 'wechat',
  };
  const resp = await postJson(url, payload, {}, 8000);
  try {
    const r = JSON.parse(resp);
    if (r.code !== 200) throw new Error(`PushPlus返回错误: code=${r.code} ${r.msg || ''}`);
  } catch (e) {
    if (e.message.startsWith('PushPlus')) throw e;
  }
}

register({
  name: 'wechat',
  async send(alert) {
    // 分红提醒不推微信
    if (typeof alert.alertType === 'string' && alert.alertType.startsWith('DIVIDEND_')) return;

    const sendKey = (process.env.THS_WECHAT_SENDKEY || '').trim();
    const pushPlusToken = (process.env.THS_WECHAT_PUSHPLUS_TOKEN || '').trim();
    if (!sendKey && !pushPlusToken) return; // 都未配置，静默跳过

    const { title, body } = buildWechatMessage(alert);

    if (sendKey) {
      await sendViaServerChan(sendKey, title, body);
      console.log(`[通知:wechat] Server酱 | ${alert.alertType} | ${alert.name}(${alert.code}) 推送成功`);
    } else {
      await sendViaPushPlus(pushPlusToken, title, body);
      console.log(`[通知:wechat] PushPlus | ${alert.alertType} | ${alert.name}(${alert.code}) 推送成功`);
    }
  },
});

module.exports = { register, channels, formatAlertLabel };
