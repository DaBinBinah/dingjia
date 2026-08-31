/**
 * ths-get-ai-summary —— 预留 GLM AI 投资信息整理与自然语言查询接口
 *
 * 核心原则：
 * 1. 告诉用户【发生了什么】、【涉及什么】、【可能为什么发生】
 * 2. 严禁输出任何买入、卖出、操作等投资建议
 * 3. 如尚未配置 GLM API Key，返回结构化数据规则摘要作为优雅降级
 */
const cloud = require('@cloudbase/node-sdk');
const { assertAccess } = require('./lib/access-guard');

const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
const db = app.database();

exports.main = async (event = {}) => {
  const denied = assertAccess(event);
  if (denied) return denied;

  const mode = event.mode || 'daily_summary'; // daily_summary | query | explain_event
  const query = event.query ? String(event.query).trim() : '';

  try {
    // 聚合当前持仓、监控与提醒数据
    const [watchSnap, holdSnap, alertSnap] = await Promise.all([
      db.collection('ths_watchlist').where({ enabled: true }).get().catch(() => ({ data: [] })),
      db.collection('ths_holdings').get().catch(() => ({ data: [] })),
      db.collection('ths_alerts').orderBy('createdAt', 'desc').limit(20).get().catch(() => ({ data: [] })),
    ]);

    const watches = watchSnap.data || [];
    const holdings = holdSnap.data || [];
    const alerts = alertSnap.data || [];

    // 客观统计今日数据变化
    const buyTriggers = alerts.filter((a) => a.alertType === 'buy');
    const sellTriggers = alerts.filter((a) => a.alertType === 'sell');
    const divTriggers = alerts.filter((a) => String(a.alertType).startsWith('DIVIDEND'));

    const summaryText = [
      `【今日数据速览】`,
      `• 当前有效监控标的 ${watches.length} 只，持仓标的 ${holdings.length} 只；`,
      `• 今日触发买入价格线 ${buyTriggers.length} 次，达到卖出价格线 ${sellTriggers.length} 次；`,
      `• 近期分红相关事件提醒 ${divTriggers.length} 次；`,
      `💡 提示：本摘要由数据引擎客观统计整理，不构成任何投资建议，请理性坚持个人投资纪律。`
    ].join('\n');

    return {
      ok: true,
      mode,
      summary: summaryText,
      stats: {
        totalWatches: watches.length,
        totalHoldings: holdings.length,
        buyTriggers: buyTriggers.length,
        sellTriggers: sellTriggers.length,
        divTriggers: divTriggers.length,
      },
      answer: query ? `关于「${query}」的查询：系统已记录您的查询意图，当前可通过监控与资产页面查看实时对应数据。` : null,
      serverTime: Date.now(),
    };
  } catch (e) {
    return { ok: false, error: `生成智能摘要失败: ${e.message}` };
  }
};
