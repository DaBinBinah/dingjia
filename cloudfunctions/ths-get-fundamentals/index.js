/**
 * ths-get-fundamentals —— 获取股票基本面指标（PE、PB、ROE）
 *
 * 输入：{ type: 'stock' | 'etf', code: string, thsCode?: string, accessCode? }
 * 输出：{ ok: true, type: 'stock' | 'etf', fundamentals: { pe, pb, roe } | null }
 *
 * 规则：
 * 1. ETF 详情页严禁展示股票公司基本面，直接返回 fundamentals: null；
 * 2. 股票返回三个指标：PE (TTM)、PB (MRQ)、ROE (加权平均/最新报告期)；
 * 3. 亏损公司（PE <= 0）：显示「不适用」，说明「公司当前盈利为负，PE不适用」；
 * 4. 异常或缺失字段返回「—」，绝不显示 NaN/undefined/Infinity/错误 0。
 */
const cloud = require('@cloudbase/node-sdk');
const { toThsCode, fetchValuations, fetchRoe } = require('./lib/ths-api');
const { assertAccess } = require('./lib/access-guard');

const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
const db = app.database();

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

    // 并行获取估值快照与 ROE 财务指标
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

    return {
      ok: true,
      type: 'stock',
      code,
      thsCode,
      fundamentals: {
        pe,
        pb,
        roe,
      },
    };
  } catch (e) {
    return { ok: false, error: `获取基本面失败：${e.message}` };
  }
};
