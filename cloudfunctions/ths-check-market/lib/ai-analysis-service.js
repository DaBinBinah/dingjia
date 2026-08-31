/**
 * AI 分析服务（预留接口 —— 未来接入智谱 GLM）
 *
 * 架构原则：
 * 1. 结构化输入，输出信息总结与客观解读，绝不做自动买卖决策或套利建议。
 * 2. 价格和分红基础判断完全由本地程序完成，GLM 仅作为触发后的异步辅助分析。
 */

function buildAiPayload({
  code,
  name,
  type,
  currentPrice,
  buyPrice,
  sellPrice,
  changePercent,
  y2025,
  y2026,
  yearHigh,
  yearLow,
  dividendLatest,
  dividendYield,
  tradingDaysLeft,
  recentPerformance,
}) {
  return {
    code,
    name,
    type: type === 'etf' ? 'ETF' : 'A股股票',
    currentPrice,
    buyPrice,
    sellPrice,
    changePercent,
    yearPerformance: { y2025, y2026 },
    yearRange: { yearHigh, yearLow },
    dividend: dividendLatest
      ? {
          dividendPerShare: dividendLatest.dividendPerShare,
          recordDate: dividendLatest.recordDate,
          exDividendDate: dividendLatest.exDividendDate,
          paymentDate: dividendLatest.paymentDate,
          dividendYield,
          tradingDaysLeft,
        }
      : null,
    recentPerformance,
    timestamp: new Date().toISOString(),
  };
}

async function analyzeWithGlm(payload) {
  // 当前为预留桩函数，未来配置 GLM_API_KEY 后接入
  return {
    ready: false,
    message: 'GLM AI 辅助分析模块已就绪，当前待配置 API 密钥',
    payload,
  };
}

module.exports = {
  buildAiPayload,
  analyzeWithGlm,
};
