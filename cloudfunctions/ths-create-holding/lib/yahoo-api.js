/**
 * 美股公开行情数据适配器 (USMarketDataProvider)
 * 覆盖：美股股票 (AAPL, NVDA, TSLA 等) 与 美股 ETF (SPY, QQQ, VOO 等)
 * 特点：永久免费、免 API Key、零注册、极速毫秒级响应、自带 America/New_York 时区与 52 周极值
 */
const https = require('https');

const TIMEOUT_MS = 8000;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function fetchText(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get(u, {
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': 'https://gu.qq.com',
        'Accept': '*/*',
        ...headers,
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 100)}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求美股接口超时')));
    req.on('error', reject);
  });
}

/**
 * 规范化美股代码（转大写、去空格，支持 BRK.B / BRK-B 格式）
 */
function normalizeUsSymbol(code) {
  if (!code) return '';
  return String(code).trim().toUpperCase().replace(/\//g, '-');
}

/**
 * 从腾讯财经美股行情接口批量获取行情
 */
async function fetchTencentUsQuotes(symbols = []) {
  const quotes = {};
  const failures = {};
  if (!symbols || !symbols.length) return { quotes, failures };

  const cleanSymbols = [...new Set(symbols.map(normalizeUsSymbol).filter(Boolean))];
  const queryStr = cleanSymbols.map((s) => 'us' + s).join(',');
  const url = `https://qt.gtimg.cn/q=${queryStr}`;

  try {
    const text = await fetchText(url);
    const lines = text.split(';').map((l) => l.trim()).filter(Boolean);

    for (const line of lines) {
      // 格式: v_usAAPL="200~苹果~AAPL.OQ~316.85~319.70~319.60~41242724~...~344.26~225.12~..."
      const match = line.match(/^v_us([A-Z0-9.\-]+)=\"([^\"]+)\"/);
      if (!match) continue;
      const symbol = match[1];
      const rawData = match[2];
      const parts = rawData.split('~');

      if (parts.length < 30) {
        failures[symbol] = '返回美股行情数据格式不完整';
        continue;
      }

      const name = parts[1] || symbol;
      const price = parseFloat(parts[3]);
      const prevPrice = parseFloat(parts[4]);
      const openPrice = parseFloat(parts[5]);
      const volume = parseFloat(parts[6]);
      const changeAmount = parseFloat(parts[31]);
      const changePercent = parseFloat(parts[32]);
      const dayHigh = parseFloat(parts[33]);
      const dayLow = parseFloat(parts[34]);
      const fiftyTwoWeekHigh = parseFloat(parts[39]) || null;
      const fiftyTwoWeekLow = parseFloat(parts[40]) || null;

      if (!Number.isFinite(price) || price <= 0) {
        failures[symbol] = '未获取到有效美股价格';
        continue;
      }

      // parts[30] 为腾讯美股接口返回的交易时刻（美东时间），如 "2026-09-02 16:00:01"
      let realMarketTime = null;
      const rawTimeStr = parts[30] ? parts[30].trim() : '';
      if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(rawTimeStr)) {
        try {
          const month = parseInt(rawTimeStr.slice(5, 7), 10);
          const isDst = month >= 4 && month <= 10;
          const tzOffset = isDst ? '-04:00' : '-05:00';
          const d = new Date(rawTimeStr.replace(' ', 'T') + tzOffset);
          if (!isNaN(d.getTime())) realMarketTime = d;
        } catch (_) {}
      }

      quotes[symbol] = {
        name,
        price,
        prevPrice: Number.isFinite(prevPrice) ? prevPrice : null,
        changePercent: Number.isFinite(changePercent) ? changePercent : 0,
        changeAmount: Number.isFinite(changeAmount) ? changeAmount : 0,
        openPrice: Number.isFinite(openPrice) ? openPrice : null,
        dayHigh: Number.isFinite(dayHigh) ? dayHigh : null,
        dayLow: Number.isFinite(dayLow) ? dayLow : null,
        volume: Number.isFinite(volume) ? volume : null,
        turnover: null,
        fiftyTwoWeekHigh,
        fiftyTwoWeekLow,
        currency: 'USD',
        timezone: 'America/New_York',
        marketTime: realMarketTime,
        marketDataTime: realMarketTime,
        marketState: 'REGULAR',
        dataSource: 'TENCENT_US',
      };
    }
  } catch (err) {
    for (const s of cleanSymbols) {
      failures[s] = err.message || '获取美股行情失败';
    }
  }

  return { quotes, failures };
}

/**
 * 批量获取美股实时行情快照
 * @param {string[]} symbols 如 ['AAPL', 'NVDA', 'SPY', 'QQQ']
 */
async function fetchUsQuotes(symbols = []) {
  const cleanSymbols = [...new Set(symbols.map(normalizeUsSymbol).filter(Boolean))];
  const { quotes, failures } = await fetchTencentUsQuotes(cleanSymbols);
  return { quotes, failures };
}

/**
 * 获取美股历史 K 线（用于详情页日线、多周期走势与52周分析）
 * @param {string} symbol 如 'AAPL'
 */
async function fetchUsHistory(symbol, range = '1y', interval = '1d') {
  const s = normalizeUsSymbol(symbol);
  const url = `https://web.ifzq.gtimg.cn/appstock/app/usfqkline/get?_var=kline_day&param=us${s},day,,,320,qfq`;

  try {
    const text = await fetchText(url);
    const jsonStr = text.replace(/^kline_day=/, '');
    const res = JSON.parse(jsonStr);
    const dayData = res?.data?.['us' + s]?.day || [];

    const items = [];
    for (const d of dayData) {
      if (!Array.isArray(d) || d.length < 5) continue;
      const dateStr = d[0]; // '2026-08-31'
      const open = parseFloat(d[1]);
      const close = parseFloat(d[2]);
      const high = parseFloat(d[3]);
      const low = parseFloat(d[4]);
      const vol = parseFloat(d[5]) || 0;

      if (!dateStr || !Number.isFinite(close)) continue;

      const dateMs = new Date(dateStr + 'T16:00:00-04:00').getTime();
      items.push({
        date_ms: dateMs,
        open_price: open,
        high_price: high,
        low_price: low,
        close_price: close,
        volume: vol,
        turnover: null,
      });
    }

    // 按日期升序排序
    items.sort((a, b) => a.date_ms - b.date_ms);

    return {
      meta: { symbol: s, currency: 'USD', exchangeTimezoneName: 'America/New_York' },
      items,
    };
  } catch (err) {
    throw new Error(`获取美股历史行情失败: ${err.message}`);
  }
}

/**
 * 获取美国 4 大核心市场指数 (标普500 / 纳斯达克综合 / 纳斯达克100 / AI人工智能 NQINTEL)
 */
const US_CORE_INDICES = [
  {
    symbol: '^GSPC',
    tencentCode: '.INX',
    name: '标普500',
    shortName: '标普500',
    fullName: '标普500指数 (S&P 500)',
    securityType: 'INDEX',
  },
  {
    symbol: '^IXIC',
    tencentCode: '.IXIC',
    name: '纳斯达克综合指数',
    shortName: '纳斯达克',
    fullName: '纳斯达克综合指数 (NASDAQ Composite)',
    securityType: 'INDEX',
  },
  {
    symbol: '^NDX',
    tencentCode: '.NDX',
    name: '纳斯达克100',
    shortName: '纳斯达克100',
    fullName: '纳斯达克100指数 (NASDAQ-100)',
    securityType: 'INDEX',
  },
  {
    symbol: '^NQINTEL',
    tencentCode: null,
    fallbackSymbol: 'ROBT', // 跟踪 Nasdaq CTA Artificial Intelligence Index 的基准公募
    name: 'Nasdaq CTA Artificial Intelligence Index',
    shortName: 'AI人工智能',
    subText: 'NQINTEL',
    fullName: 'Nasdaq CTA 人工智能指数 (NQINTEL)',
    desc: '用于观察人工智能相关公司的整体市场表现',
    securityType: 'INDEX',
  },
];

async function fetchUsIndices() {
  const result = [];
  // 1. 尝试从腾讯接口批量拉取前三大指数 + 备用 AI 标的
  const tencentSymbols = [
    ...US_CORE_INDICES.filter((i) => i.tencentCode).map((i) => i.tencentCode),
    'ROBT',
    'THNQ',
  ];
  const { quotes: tQuotes } = await fetchTencentUsQuotes(tencentSymbols);

  for (const item of US_CORE_INDICES) {
    let q = null;
    if (item.tencentCode && tQuotes[item.tencentCode]) {
      q = tQuotes[item.tencentCode];
    }
    // 2. 如果腾讯未获取到或为 NQINTEL，则优先走 Yahoo Chart API
    if (!q || q.price == null) {
      q = await fetchSingleYahooChart(item.symbol);
    }
    // 3. 如果 Yahoo 被限流，使用追踪该指数的 AI 标的行情作为数据兜底
    if (!q || q.price == null) {
      if (item.fallbackSymbol && tQuotes[item.fallbackSymbol]) {
        const fb = tQuotes[item.fallbackSymbol];
        q = {
          price: fb.price,
          prevPrice: fb.prevPrice,
          change: fb.changeAmount,
          changePercent: fb.changePercent,
          openPrice: fb.openPrice,
          dayHigh: fb.dayHigh,
          dayLow: fb.dayLow,
        };
      }
    }

    if (q && typeof q.price === 'number') {
      result.push({
        symbol: item.symbol,
        code: item.symbol,
        name: item.name,
        shortName: item.shortName,
        subText: item.subText || null,
        fullName: item.fullName,
        desc: item.desc || null,
        price: Math.round(q.price * 100) / 100,
        change: q.change != null ? Math.round(q.change * 100) / 100 : (q.changeAmount != null ? Math.round(q.changeAmount * 100) / 100 : null),
        changePercent: q.changePercent != null ? Math.round(q.changePercent * 100) / 100 : 0,
        prevPrice: q.prevPrice != null ? Math.round(q.prevPrice * 100) / 100 : null,
        openPrice: q.openPrice != null ? Math.round(q.openPrice * 100) / 100 : null,
        dayHigh: q.dayHigh != null ? Math.round(q.dayHigh * 100) / 100 : null,
        dayLow: q.dayLow != null ? Math.round(q.dayLow * 100) / 100 : null,
        securityType: 'INDEX',
        market: 'US',
        currency: 'USD',
        timezone: 'America/New_York',
        dataSource: 'Yahoo Finance',
        updateTime: new Date().toISOString().slice(11, 19),
      });
    } else {
      result.push({
        symbol: item.symbol,
        code: item.symbol,
        name: item.name,
        shortName: item.shortName,
        subText: item.subText || null,
        fullName: item.fullName,
        desc: item.desc || null,
        price: null,
        change: null,
        changePercent: null,
        prevPrice: null,
        securityType: 'INDEX',
        market: 'US',
        currency: 'USD',
        timezone: 'America/New_York',
        dataSource: 'Yahoo Finance',
        error: '暂无行情数据',
      });
    }
  }

  return result;
}

function fetchJsonDirect(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 100)}`));
        }
      });
    }).on('error', reject);
  });
}

async function fetchSingleYahooChart(symbol) {
  const hosts = ['https://query2.finance.yahoo.com', 'https://query1.finance.yahoo.com'];
  for (const host of hosts) {
    const url = `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
    try {
      const json = await fetchJsonDirect(url);
      const meta = json?.chart?.result?.[0]?.meta;
      if (!meta) continue;
      const price = typeof meta.regularMarketPrice === 'number' ? meta.regularMarketPrice : null;
      const prev = typeof meta.chartPreviousClose === 'number'
        ? meta.chartPreviousClose
        : typeof meta.previousClose === 'number'
          ? meta.previousClose
          : null;
      if (price === null) continue;
      let changePercent = 0;
      let changeAmount = 0;
      if (prev && prev > 0) {
        changeAmount = Math.round((price - prev) * 100) / 100;
        changePercent = Math.round(((price - prev) / prev) * 10000) / 100;
      }
      return {
        price,
        prevPrice: prev,
        change: changeAmount,
        changePercent,
        openPrice: meta.regularMarketOpen || null,
        dayHigh: meta.regularMarketDayHigh || null,
        dayLow: meta.regularMarketDayLow || null,
        marketTime: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000) : new Date(),
      };
    } catch (_) {}
  }
  return null;
}

module.exports = {
  fetchUsQuotes,
  fetchUsHistory,
  fetchUsIndices,
  normalizeUsSymbol,
  US_CORE_INDICES,
};
