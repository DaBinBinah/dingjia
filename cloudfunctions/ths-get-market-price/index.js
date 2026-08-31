/**
 * ths-get-market-price —— 查询单个标的的最新价格与名称
 * 供前端「添加/编辑监控」表单实时预览使用；只读，不写数据库。
 * 输入：{ type: 'stock'|'etf', code: '601137', withName?: boolean }
 */
const cloud = require('@cloudbase/node-sdk');
const { ThsApiError, toThsCode, fetchQuotes, searchTickerName } = require('./lib/ths-api');
const { assertAccess } = require('./lib/access-guard');

cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });

exports.main = async (event = {}) => {
  const denied = assertAccess(event);
  if (denied) return denied;

  const type = String(event.type || '');
  const code = String(event.code || '').trim();
  if (!['stock', 'etf'].includes(type)) {
    return { ok: false, error: '类型必须为 stock（股票）或 etf（ETF）' };
  }
  const thsCode = toThsCode(type, code);
  if (!thsCode) {
    return { ok: false, error: '代码格式不正确：应为 6 位数字，且属于支持的市场' };
  }

  // 名称解析模式：只查代码表，不取行情（批量导入预览时批量补全名称用）
  if (event.nameOnly) {
    try {
      const name = await searchTickerName(code);
      return { ok: true, thsCode, name, nameResolved: !!name, serverTime: Date.now() };
    } catch (e) {
      return { ok: false, thsCode, error: e.message };
    }
  }

  try {
    const { quotes, failures } = await fetchQuotes(type, [thsCode]);
    const quote = quotes[thsCode];
    if (!quote) {
      return { ok: false, error: failures[thsCode] || '暂无行情数据', thsCode };
    }
    const withName = event.withName !== false;
    const name = withName ? await searchTickerName(code) : null;
    return {
      ok: true,
      thsCode,
      price: quote.price,
      changePercent: quote.changePercent,
      prevPrice: quote.prevPrice,
      name,
      serverTime: Date.now(),
    };
  } catch (e) {
    return {
      ok: false,
      thsCode,
      error: e.message,
      code: e instanceof ThsApiError ? e.code : 'UNKNOWN',
    };
  }
};
