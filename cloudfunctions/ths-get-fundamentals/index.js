/**
 * ths-get-fundamentals —— 获取股票基本面指标（PE、PB、ROE）
 *
 * 输入：{ type: 'stock' | 'etf', code: string, thsCode?: string, accessCode? }
 * 输出：{ ok: true, type: 'stock' | 'etf', fundamentals: { pe, pb, roe } | null }
 */
const cloud = require('@cloudbase/node-sdk');
const { toThsCode, fetchValuations, fetchRoe } = require('./lib/ths-api');
const { assertAccess } = require('./lib/access-guard');

const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
const db = app.database();
const CACHE_COLL = 'ths_history_cache';

exports.main = async (event = {}) => {
  const denied = assertAccess(event);
  if (denied) return denied;

  try {
    const type = String(event.type || '').trim().toLowerCase();
    const code = String(event.code || '').trim();

    // ETF 严格隐藏基本面
    if (type === 'etf') {
      return { ok: true, type: 'etf', fundamentals: null };
    }

    if (type !== 'stock') {
      return { ok: false, error: '只支持股票基本面查询' };
    }

    const thsCode = event.thsCode || toThsCode('stock', code);
    if (!thsCode) {
      return { ok: false, error: '无法识别股票代码' };
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    const cacheKey = `fund:${thsCode}:${todayStr}`;

    // 1. 尝试读缓存
    try {
      const snap = await db.collection(CACHE_COLL).where({ key: cacheKey }).limit(1).get();
      if (snap.data && snap.data.length && snap.data[0].data) {
        return {
          ok: true,
          type: 'stock',
          code,
          thsCode,
          cached: true,
          fundamentals: snap.data[0].data,
        };
      }
    } catch (_) {}

    // 2. 并行获取估值快照与 ROE 财务指标
    const [valMap, roeData] = await Promise.all([
      fetchValuations([thsCode]),
      fetchRoe(thsCode),
    ]);

    const val = valMap[thsCode] || null;

    // 1. PE (TTM)
    let pe = {
      value: null,
      text: '—',
      metric: 'PE (TTM)',
      isLoss: false,
      hint: '暂无估值数据',
    };
    if (val && typeof val.peTtm === 'number' && !isNaN(val.peTtm)) {
      if (val.peTtm <= 0) {
        pe = {
          value: val.peTtm,
          text: '不适用',
          metric: 'PE (TTM)',
          isLoss: true,
          hint: '公司当前盈利为负，PE不适用',
        };
      } else {
        pe = {
          value: val.peTtm,
          text: `${val.peTtm.toFixed(1)}倍`,
          metric: 'PE (TTM)',
          isLoss: false,
          hint: '基于过去12个月净利润估值',
        };
      }
    }

    // 2. PB (MRQ)
    let pb = {
      value: null,
      text: '—',
      metric: 'PB (MRQ)',
      hint: '暂无市净率数据',
    };
    if (val && typeof val.pbMrq === 'number' && !isNaN(val.pbMrq)) {
      pb = {
        value: val.pbMrq,
        text: `${val.pbMrq.toFixed(1)}倍`,
        metric: 'PB (MRQ)',
        hint: '基于最新每股净资产计算',
      };
    }

    // 3. ROE
    let roe = {
      value: null,
      text: '—',
      metric: 'ROE',
      report: null,
      hint: '暂无报告期数据',
    };
    if (roeData && typeof roeData.roe === 'number' && !isNaN(roeData.roe)) {
      const repText = roeData.report ? `${roeData.report.replace('-', 'Q')}` : '最新报告期';
      roe = {
        value: roeData.roe,
        text: `${roeData.roe.toFixed(1)}%`,
        metric: `ROE (${repText})`,
        report: roeData.report,
        hint: `公司用股东的钱赚钱的能力 (${repText})`,
      };
    }

    const fundamentals = { pe, pb, roe };

    // 3. 写入缓存（异步兜底，不阻塞主链路）
    try {
      await db.collection(CACHE_COLL).add({
        key: cacheKey,
        data: fundamentals,
        createdAt: new Date(),
      });
    } catch (_) {}

    return {
      ok: true,
      type: 'stock',
      code,
      thsCode,
      cached: false,
      fundamentals,
    };
  } catch (e) {
    return { ok: false, error: `获取基本面失败：${e.message}` };
  }
};
