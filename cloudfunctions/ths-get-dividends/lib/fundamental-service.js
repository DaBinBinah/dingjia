/**
 * 基本面指标服务（PE、PB、ROE）
 */
const { thsRequest } = require('./ths-api');

const CACHE_COLL = 'ths_history_cache';

/** 获取股票估值快照（PE_TTM、PB_MRQ 等），失败自动重试一次 */
async function fetchValuations(thsCodes) {
  const map = {};
  if (!Array.isArray(thsCodes) || !thsCodes.length) return map;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const data = await thsRequest('/api/a-share/valuations/snapshot', { thscodes: thsCodes.join(',') });
      for (const item of (data && data.item) || []) {
        if (item && item.thscode) {
          map[item.thscode] = {
            peTtm: typeof item.pe_ttm === 'number' ? item.pe_ttm : null,
            peMrq: typeof item.pe_mrq === 'number' ? item.pe_mrq : null,
            pbMrq: typeof item.pb_mrq === 'number' ? item.pb_mrq : null,
            psTtm: typeof item.ps_ttm === 'number' ? item.ps_ttm : null,
            pcfTtm: typeof item.pcf_ttm === 'number' ? item.pcf_ttm : null,
          };
        }
      }
      if (Object.keys(map).length > 0) break;
    } catch (e) {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 400));
      }
    }
  }
  return map;
}

/** 获取股票 ROE（优先最快命中最成熟的财报期，遇到限流平滑避让） */
async function fetchRoe(thsCode) {
  const priorityReports = ['2024-4', '2024-3', '2024-2', '2023-4'];

  for (const report of priorityReports) {
    try {
      const data = await thsRequest('/api/a-share/financials/indicators', { thscode: thsCode, report });
      if (data && data.abilities) {
        const prof = data.abilities.find((a) => a.ability === 'profitability');
        if (prof && prof.indicators) {
          const weightedRoe = prof.indicators.find((i) => i.index_id === 'index_weighted_avg_roe');
          const deductRoe = prof.indicators.find((i) => i.index_id === 'index_deduct_weighted_avg_roe');
          const target = weightedRoe || deductRoe;
          if (target && target.value != null && !isNaN(parseFloat(target.value))) {
            return {
              roe: parseFloat(target.value),
              report,
              isDeduct: !weightedRoe && !!deductRoe,
            };
          }
        }
      }
    } catch (e) {
      if (e.message && e.message.includes('limit')) {
        await new Promise((r) => setTimeout(r, 350));
      }
    }
  }
  return null;
}

async function getFundamentals(db, thsCode, code) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const cacheKey = `fund:${thsCode}:${todayStr}`;

  // 1. 尝试读缓存（严格校验非空）
  try {
    const snap = await db.collection(CACHE_COLL).where({ key: cacheKey }).limit(1).get();
    if (snap.data && snap.data.length && snap.data[0].data) {
      const cachedFund = snap.data[0].data;
      const hasValidData =
        (cachedFund.pe && cachedFund.pe.value != null) ||
        (cachedFund.pb && cachedFund.pb.value != null) ||
        (cachedFund.roe && cachedFund.roe.value != null);

      if (hasValidData) {
        return cachedFund;
      }
    }
  } catch (_) {}

  // 2. 实时拉取
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

  // 3. 写入缓存（仅在存在有效非空指标时才写缓存）
  const hasValidData =
    (pe && pe.value != null) ||
    (pb && pb.value != null) ||
    (roe && roe.value != null);

  if (hasValidData) {
    try {
      await db.collection(CACHE_COLL).where({ key: cacheKey }).remove().catch(() => {});
      await db.collection(CACHE_COLL).add({
        key: cacheKey,
        data: fundamentals,
        createdAt: new Date(),
      });
    } catch (_) {}
  }

  return fundamentals;
}

module.exports = {
  fetchValuations,
  fetchRoe,
  getFundamentals,
};
