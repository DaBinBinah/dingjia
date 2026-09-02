/**
 * ths-get-market-price —— 查询单个标的的最新价格与名称
 * 供前端「添加/编辑监控」表单实时预览使用；只读，不写数据库。
 * 输入：{ type: 'stock'|'etf', code: '601137', withName?: boolean }
 */
const cloud = require('@cloudbase/node-sdk');
const { ThsApiError, toThsCode, fetchQuotes, searchTickerName } = require('./lib/ths-api');
const { fetchUsQuotes, normalizeUsSymbol } = require('./lib/yahoo-api');
const { assertAccess } = require('./lib/access-guard');

cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });

exports.main = async (event = {}) => {
  const denied = assertAccess(event);
  if (denied) return denied;

  const market = String(event.market || 'CN').trim().toUpperCase() === 'US' ? 'US' : 'CN';
  const type = String(event.type || 'stock').toLowerCase();
  if (!['stock', 'etf'].includes(type)) {
    return { ok: false, error: '类型必须为 stock（股票）或 etf（ETF）' };
  }

  let code = String(event.code || '').trim();

  if (market === 'US') {
    code = normalizeUsSymbol(code);
    if (!/^[A-Z0-9.\-]{1,10}$/.test(code)) {
      return { ok: false, error: '美股代码格式不正确（如 AAPL、NVDA、QQQ、SPY）' };
    }

    try {
      const { quotes, failures } = await fetchUsQuotes([code]);
      const quote = quotes[code];
      if (!quote) {
        return { ok: false, error: failures[code] || '暂无美股行情数据', thsCode: code };
      }
      return {
        ok: true,
        market: 'US',
        currency: 'USD',
        timezone: 'America/New_York',
        dataSource: 'YAHOO',
        thsCode: code,
        price: quote.price,
        changePercent: quote.changePercent,
        prevPrice: quote.prevPrice,
        fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh,
        fiftyTwoWeekLow: quote.fiftyTwoWeekLow,
        name: event.name || code,
        serverTime: Date.now(),
      };
    } catch (e) {
      return { ok: false, thsCode: code, error: e.message };
    }
  }

  // 中国市场 (CN)
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
      market: 'CN',
      currency: 'CNY',
      timezone: 'Asia/Shanghai',
      dataSource: 'THS',
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
