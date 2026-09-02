/**
 * ths-get-portfolio —— 资产管理、投资组合分析与 V4 新手友好辅助
 *
 * 聚合能力：
 * 1. 持仓汇总（ths_holdings）：实时行情、当前市值、浮动盈亏、浮盈率、今日盈亏
 * 2. 资金账户（ths_accounts）：账户现金、总投入、总资产、仓位配置（股票/ETF/现金）、计划投入 vs 未规划资金
 * 3. 集中度与风险体检：单项资产集中度占比（>30% 标记）、现金安全垫比例
 * 4. 情景盈亏测算（-30% ~ +30% 九档数学测算）
 * 5. 理论回本价格（结合佣金与印花税等交易税费）
 * 6. 监控与分红联动：买入卖出目标、预计现金分红、股息率
 */
const cloud = require('@cloudbase/node-sdk');
const { fetchQuotes, toThsCode, fetchTradingDays } = require('./lib/ths-api');
const { fetchUsQuotes } = require('./lib/yahoo-api');
const { beijingParts } = require('./lib/trading-time');
const { getDividendData } = require('./lib/dividend-service');
const { assertAccess } = require('./lib/access-guard');

const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
const db = app.database();

const HOLDINGS_COLL = 'ths_holdings';
const ACCOUNTS_COLL = 'ths_accounts';
const WATCH_COLL = 'ths_watchlist';
const CONFIG_COLL = 'ths_config';
const PLANS_COLL = 'ths_plans';
const SETTINGS_COLL = 'ths_settings';

function round(val, decimals = 2) {
  if (typeof val !== 'number' || !Number.isFinite(val)) return null;
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

async function loadTradingDays(nowMs) {
  const today = beijingParts(nowMs).compactDate;
  const coll = db.collection(CONFIG_COLL);
  const snap = await coll.where({ key: 'trading_days' }).limit(1).get();
  const cache = (snap.data && snap.data[0]) || null;
  if (cache && cache.date === today && Array.isArray(cache.days)) return new Set(cache.days);
  const days = await fetchTradingDays();
  if (!days) return null;
  const arr = [...days];
  if (cache) await coll.doc(cache._id).update({ date: today, days: arr }).catch(() => {});
  else await coll.add({ key: 'trading_days', date: today, days: arr }).catch(() => {});
  return new Set(arr);
}

async function ensureCollections() {
  const colls = [HOLDINGS_COLL, ACCOUNTS_COLL, 'ths_transactions', PLANS_COLL, SETTINGS_COLL];
  for (const c of colls) {
    try {
      await db.createCollection(c);
    } catch (_) {}
  }
}

async function safeQuery(fn, fallback = { data: [] }) {
  try {
    return await fn();
  } catch (e) {
    if (e && (e.code === 'DATABASE_COLLECTION_NOT_EXIST' || /Db or Table not exist/i.test(e.message))) {
      await ensureCollections().catch(() => {});
      try {
        return await fn();
      } catch (_) {
        return fallback;
      }
    }
    throw e;
  }
}

/** 计算考虑交易费用的理论回本价（盈亏平衡价格） */
function calcBreakevenPrice(type, quantity, costPrice, feeSettings = {}, isUs = false) {
  if (!quantity || !costPrice) return null;
  if (isUs) {
    // 美股大多数券商免佣，印花税/过户费极低
    return round(costPrice, 2);
  }
  const commissionRate = feeSettings.commissionRate != null ? Number(feeSettings.commissionRate) : 0.00025; // 默认万2.5
  const minCommission = feeSettings.minCommission != null ? Number(feeSettings.minCommission) : 5.0;       // 默认5元
  const stampDutyRate = type === 'stock' ? (feeSettings.stampDutyRate != null ? Number(feeSettings.stampDutyRate) : 0.0005) : 0; // 股票卖出印花税万5，ETF免
  const transferFeeRate = feeSettings.transferFeeRate != null ? Number(feeSettings.transferFeeRate) : 0.00001; // 过户费

  const buyAmount = quantity * costPrice;
  const buyCommission = Math.max(minCommission, buyAmount * commissionRate);
  const buyTransfer = buyAmount * transferFeeRate;
  const totalActualCost = buyAmount + buyCommission + buyTransfer;

  const effectiveSellRate = 1 - commissionRate - stampDutyRate - transferFeeRate;
  if (effectiveSellRate <= 0) return costPrice;
  const theoreticalSellAmount = (totalActualCost + minCommission) / effectiveSellRate;
  const breakevenPrice = theoreticalSellAmount / quantity;
  return round(breakevenPrice, type === 'etf' ? 3 : 2);
}

exports.main = async (event = {}) => {
  const denied = assertAccess(event);
  if (denied) return denied;

  const nowMs = Date.now();

  try {
    const [holdingsSnap, accountsSnap, watchSnap, settingsSnap, plansSnap, userSettingsSnap] = await Promise.all([
      safeQuery(() => db.collection(HOLDINGS_COLL).orderBy('createdAt', 'desc').get()),
      safeQuery(() => db.collection(ACCOUNTS_COLL).limit(10).get()),
      safeQuery(() => db.collection(WATCH_COLL).get()),
      safeQuery(() => db.collection(CONFIG_COLL).where({ key: 'settings' }).limit(1).get()),
      safeQuery(() => db.collection(PLANS_COLL).get()),
      safeQuery(() => db.collection(SETTINGS_COLL).limit(1).get()),
    ]);

    const holdingsRaw = holdingsSnap.data || [];
    const accounts = accountsSnap.data || [];
    const watches = watchSnap.data || [];
    const plans = plansSnap.data || [];
    const userSettingsDoc = (userSettingsSnap.data && userSettingsSnap.data[0]) || {};
    const settingsDoc = (settingsSnap.data && settingsSnap.data[0]) || {};
    const holidays = Array.isArray(settingsDoc.holidays) ? settingsDoc.holidays : [];
    const tradingDays = await loadTradingDays(nowMs).catch(() => null);

    const watchMap = new Map();
    for (const w of watches) {
      if (w.code) watchMap.set(`${w.market || 'CN'}_${w.code}`, w);
      if (w.code) watchMap.set(w.code, w);
      if (w.thsCode) watchMap.set(w.thsCode, w);
    }

    const planMap = new Map();
    for (const p of plans) {
      if (p.code) planMap.set(p.code, p);
    }

    // 1. 批量拉取持仓标的最新行情（中国标的 + 美股标的）
    const cnStockCodes = [];
    const cnEtfCodes = [];
    const usSymbols = [];

    for (const h of holdingsRaw) {
      const isUs = (h.market === 'US') || (!h.market && !/^\d{6}$/.test(h.code));
      if (isUs) {
        usSymbols.push(h.code);
      } else {
        const tc = h.thsCode || toThsCode(h.type, h.code);
        if (tc) {
          if (h.type === 'stock') cnStockCodes.push(tc);
          else if (h.type === 'etf') cnEtfCodes.push(tc);
        }
      }
    }

    const [stockQuotesRes, etfQuotesRes, usQuotesRes] = await Promise.all([
      cnStockCodes.length ? fetchQuotes('stock', [...new Set(cnStockCodes)]).catch(() => ({ quotes: {} })) : { quotes: {} },
      cnEtfCodes.length ? fetchQuotes('etf', [...new Set(cnEtfCodes)]).catch(() => ({ quotes: {} })) : { quotes: {} },
      usSymbols.length ? fetchUsQuotes([...new Set(usSymbols)]).catch(() => ({ quotes: {} })) : { quotes: {} },
    ]);
    const quotes = {
      ...stockQuotesRes.quotes,
      ...etfQuotesRes.quotes,
      ...usQuotesRes.quotes,
    };

    // 2. 现金账户汇总
    let cashBalanceCn = 0;
    let totalInvestedCn = 0;
    let cashBalanceUs = 0;
    let totalInvestedUs = 0;

    for (const acc of accounts) {
      const accCurrency = acc.currency || (acc.market === 'US' ? 'USD' : 'CNY');
      const c = typeof acc.cashBalance === 'number' ? acc.cashBalance : 0;
      const inv = typeof acc.totalInvested === 'number' ? acc.totalInvested : 0;
      if (accCurrency === 'USD') {
        cashBalanceUs += c;
        totalInvestedUs += inv;
      } else {
        cashBalanceCn += c;
        totalInvestedCn += inv;
      }
    }

    // 3. 分币种资产统计累加器
    const cnStat = { stockMv: 0, etfMv: 0, cost: 0, floatPnL: 0, todayPnL: 0, dividend: 0, planned: 0, count: 0 };
    const usStat = { stockMv: 0, etfMv: 0, cost: 0, floatPnL: 0, todayPnL: 0, dividend: 0, planned: 0, count: 0 };

    const reachSellHoldings = [];
    const reachBuyHoldings = [];
    const upcomingDividendHoldings = [];
    const nearBuyHoldings = [];
    const nearSellHoldings = [];

    const holdings = [];

    for (const h of holdingsRaw) {
      const isUs = (h.market === 'US') || (!h.market && !/^\d{6}$/.test(h.code));
      const market = isUs ? 'US' : 'CN';
      const currency = isUs ? 'USD' : 'CNY';
      const timezone = isUs ? 'America/New_York' : 'Asia/Shanghai';
      const stat = isUs ? usStat : cnStat;
      stat.count++;

      const tc = isUs ? h.code : (h.thsCode || toThsCode(h.type, h.code));
      const q = (tc && quotes[tc]) || (quotes[h.code]) || null;
      const w = watchMap.get(`${market}_${h.code}`) || watchMap.get(h.code) || null;
      const p = planMap.get(h.code) || null;

      const quantity = Number(h.quantity) || 0;
      const costPrice = Number(h.costPrice) || 0;
      const costAmount = round(quantity * costPrice, 2);

      let currentPrice = q && typeof q.price === 'number' ? q.price : null;
      let prevPrice = q && typeof q.prevPrice === 'number' ? q.prevPrice : null;
      let changePercent = q && typeof q.changePercent === 'number' ? q.changePercent : null;

      if (currentPrice === null && w && typeof w.currentPrice === 'number') {
        currentPrice = w.currentPrice;
        prevPrice = w.previousPrice;
        changePercent = w.changePercent;
      }

      let marketValue = null;
      let floatingPnL = null;
      let floatingPnLPct = null;
      let todayPnL = null;

      if (currentPrice !== null && quantity > 0) {
        marketValue = round(currentPrice * quantity, 2);
        floatingPnL = round(marketValue - costAmount, 2);
        floatingPnLPct = costAmount > 0 ? round((floatingPnL / costAmount) * 100, 2) : 0;

        if (prevPrice !== null && prevPrice > 0) {
          todayPnL = round((currentPrice - prevPrice) * quantity, 2);
          stat.todayPnL += todayPnL;
        }

        if (h.type === 'stock') stat.stockMv += marketValue;
        else if (h.type === 'etf') stat.etfMv += marketValue;

        stat.cost += costAmount;
        stat.floatPnL += floatingPnL;
      } else {
        stat.cost += costAmount;
      }

      // 分红数据（仅中国 A 股有完整同花顺分红日历，美股若无接口则安全跳过）
      let dividendData = null;
      if (!isUs) {
        try {
          dividendData = await getDividendData(db, h.type, h.code, {
            currentPrice,
            buyPrice: w ? w.buyPrice : costPrice,
            tradingDays,
            holidays,
          });
        } catch (_) {}
      }

      let expectedDividend = null;
      let costDividendYield = null;
      let currentDividendYield = null;
      let latestDividend = dividendData && dividendData.latest ? dividendData.latest : null;
      let tradingDaysLeft = dividendData ? dividendData.tradingDaysLeft : null;

      if (latestDividend && latestDividend.dividendPerShare > 0) {
        expectedDividend = round(quantity * latestDividend.dividendPerShare, 2);
        stat.dividend += expectedDividend;
        if (costPrice > 0) {
          costDividendYield = round((latestDividend.dividendPerShare / costPrice) * 100, 2);
        }
        if (currentPrice !== null && currentPrice > 0) {
          currentDividendYield = round((latestDividend.dividendPerShare / currentPrice) * 100, 2);
        }
      }

      // 关联监控的目标与理论收益
      const buyPrice = w && w.buyPrice != null ? w.buyPrice : null;
      const sellPrice = w && w.sellPrice != null ? w.sellPrice : null;

      let expectedProfitAtSell = null;
      let expectedReturnAtSell = null;
      if (sellPrice !== null && quantity > 0 && costAmount > 0) {
        const theoreticalSellAmount = round(quantity * sellPrice, 2);
        expectedProfitAtSell = round(theoreticalSellAmount - costAmount, 2);
        expectedReturnAtSell = round((expectedProfitAtSell / costAmount) * 100, 2);
      }

      // 距离买入/卖出目标
      let distBuyPct = null;
      let distSellPct = null;
      let reachBuy = false;
      let reachSell = false;

      if (currentPrice !== null) {
        if (buyPrice !== null) {
          if (currentPrice <= buyPrice) {
            reachBuy = true;
          } else {
            distBuyPct = round(((currentPrice - buyPrice) / currentPrice) * 100, 1);
          }
        }
        if (sellPrice !== null) {
          if (currentPrice >= sellPrice) {
            reachSell = true;
          } else {
            distSellPct = round(((sellPrice - currentPrice) / currentPrice) * 100, 1);
          }
        }
      }

      // 计划投入汇总
      const plannedAmt = p && p.plannedAmount != null ? Number(p.plannedAmount) : (h.plannedAmount != null ? Number(h.plannedAmount) : 0);
      stat.planned += plannedAmt;

      // 9档情景盈亏数学测算 (-30% ~ +30%)
      const scenarioPcts = [-30, -20, -10, -5, 0, 5, 10, 20, 30];
      const basePrice = currentPrice !== null ? currentPrice : costPrice;
      const scenarios = scenarioPcts.map((pct) => {
        const sPrice = basePrice !== null ? round(basePrice * (1 + pct / 100), h.type === 'etf' ? 3 : 2) : null;
        const sMarketValue = sPrice !== null && quantity > 0 ? round(sPrice * quantity, 2) : null;
        const sPnL = sMarketValue !== null && costAmount > 0 ? round(sMarketValue - costAmount, 2) : null;
        const sPnLPct = costAmount > 0 && sPnL !== null ? round((sPnL / costAmount) * 100, 2) : null;
        return {
          percent: pct,
          price: sPrice,
          marketValue: sMarketValue,
          floatingPnL: sPnL,
          floatingPnLPct: sPnLPct,
        };
      });

      // 理论盈亏平衡价格（回本价）
      const breakevenPrice = calcBreakevenPrice(h.type, quantity, costPrice, userSettingsDoc);

      const item = {
        _id: h._id,
        type: h.type,
        code: h.code,
        thsCode: tc,
        name: h.name,
        quantity,
        costPrice,
        costAmount,
        buyDate: h.buyDate || null,
        accountName: h.accountName || '默认账户',
        targetQuantity: p && p.targetQuantity != null ? p.targetQuantity : (h.targetQuantity != null ? h.targetQuantity : null),
        plannedAmount: plannedAmt || null,
        reasons: p && p.reasons ? p.reasons : [],
        customReason: p ? p.customReason : '',
        note: h.note || (p ? p.note : ''),
        watchId: w ? w._id : (h.watchId || null),
        hasWatch: !!w,
        hasPlan: !!p,
        // 行情与资产计算
        currentPrice,
        prevPrice,
        changePercent,
        marketValue,
        floatingPnL,
        floatingPnLPct,
        todayPnL,
        breakevenPrice,
        // 目标与理论测算
        buyPrice,
        sellPrice,
        expectedProfitAtSell,
        expectedReturnAtSell,
        reachBuy,
        reachSell,
        distBuyPct,
        distSellPct,
        // 情景盈亏
        scenarios,
        // 分红联动
        hasDividend: !!(dividendData && dividendData.hasDividend),
        latestDividend,
        expectedDividend,
        costDividendYield,
        currentDividendYield,
        tradingDaysLeft,
        isDividendToday: dividendData ? !!dividendData.isToday : false,
        isDividendPassed: dividendData ? !!dividendData.isPassed : false,
        createdAt: h.createdAt || null,
        updatedAt: h.updatedAt || null,
      };

      holdings.push(item);

      // 汇总提醒与机会
      if (reachSell) reachSellHoldings.push(item);
      if (reachBuy) reachBuyHoldings.push(item);
      if (tradingDaysLeft !== null && tradingDaysLeft >= 0 && tradingDaysLeft <= 20) {
        upcomingDividendHoldings.push(item);
      }
      if (!reachBuy && distBuyPct !== null && distBuyPct <= 5.0) nearBuyHoldings.push(item);
      if (!reachSell && distSellPct !== null && distSellPct <= 5.0) nearSellHoldings.push(item);
    }

    const cnTotalMv = round(cnStat.stockMv + cnStat.etfMv, 2);
    const cnTotalAsset = round(cnTotalMv + cashBalanceCn, 2);
    const cnFloatingPnLPct = cnStat.cost > 0 ? round((cnStat.floatPnL / cnStat.cost) * 100, 2) : 0;

    const usTotalMv = round(usStat.stockMv + usStat.etfMv, 2);
    const usTotalAsset = round(usTotalMv + cashBalanceUs, 2);
    const usFloatingPnLPct = usStat.cost > 0 ? round((usStat.floatPnL / usStat.cost) * 100, 2) : 0;

    const cnStockWeight = cnTotalAsset > 0 ? round((cnStat.stockMv / cnTotalAsset) * 100, 1) : 0;
    const cnEtfWeight = cnTotalAsset > 0 ? round((cnStat.etfMv / cnTotalAsset) * 100, 1) : 0;
    const cnCashWeight = cnTotalAsset > 0 ? round((cashBalanceCn / cnTotalAsset) * 100, 1) : 0;
    const cnUnplannedCash = Math.max(0, round(cashBalanceCn - cnStat.planned, 2));
    const cnPlannedRatio = cashBalanceCn > 0 ? round((cnStat.planned / cashBalanceCn) * 100, 1) : 0;

    const usStockWeight = usTotalAsset > 0 ? round((usStat.stockMv / usTotalAsset) * 100, 1) : 0;
    const usEtfWeight = usTotalAsset > 0 ? round((usStat.etfMv / usTotalAsset) * 100, 1) : 0;
    const usCashWeight = usTotalAsset > 0 ? round((cashBalanceUs / usTotalAsset) * 100, 1) : 0;
    const usUnplannedCash = Math.max(0, round(cashBalanceUs - usStat.planned, 2));
    const usPlannedRatio = cashBalanceUs > 0 ? round((usStat.planned / cashBalanceUs) * 100, 1) : 0;

    const cnSummary = {
      currency: 'CNY',
      totalAsset: cnTotalAsset,
      stockMarketValue: round(cnStat.stockMv, 2),
      etfMarketValue: round(cnStat.etfMv, 2),
      totalMarketValue: cnTotalMv,
      cashBalance: round(cashBalanceCn, 2),
      totalInvested: round(totalInvestedCn, 2),
      totalCost: round(cnStat.cost, 2),
      totalFloatingPnL: round(cnStat.floatPnL, 2),
      totalFloatingPnLPct: cnFloatingPnLPct,
      todayTotalPnL: round(cnStat.todayPnL, 2),
      totalExpectedDividend: round(cnStat.dividend, 2),
      totalPlannedAmount: round(cnStat.planned, 2),
      unplannedCash: cnUnplannedCash,
      plannedRatio: cnPlannedRatio,
      weights: { stock: cnStockWeight, etf: cnEtfWeight, cash: cnCashWeight },
      count: cnStat.count,
    };

    const usSummary = {
      currency: 'USD',
      totalAsset: usTotalAsset,
      stockMarketValue: round(usStat.stockMv, 2),
      etfMarketValue: round(usStat.etfMv, 2),
      totalMarketValue: usTotalMv,
      cashBalance: round(cashBalanceUs, 2),
      totalInvested: round(totalInvestedUs, 2),
      totalCost: round(usStat.cost, 2),
      totalFloatingPnL: round(usStat.floatPnL, 2),
      totalFloatingPnLPct: usFloatingPnLPct,
      todayTotalPnL: round(usStat.todayPnL, 2),
      totalExpectedDividend: round(usStat.dividend, 2),
      totalPlannedAmount: round(usStat.planned, 2),
      unplannedCash: usUnplannedCash,
      plannedRatio: usPlannedRatio,
      weights: { stock: usStockWeight, etf: usEtfWeight, cash: usCashWeight },
      count: usStat.count,
    };

    // 仓位配置占比与单项集中度二次补齐（按同币种自身总资产计算占比）
    for (const h of holdings) {
      const curTotalAsset = h.market === 'US' ? usTotalAsset : cnTotalAsset;
      const curTotalMv = h.market === 'US' ? usTotalMv : cnTotalMv;
      h.weightInTotalAsset = curTotalAsset > 0 && h.marketValue != null ? round((h.marketValue / curTotalAsset) * 100, 1) : 0;
      h.weightInTotalMarket = curTotalMv > 0 && h.marketValue != null ? round((h.marketValue / curTotalMv) * 100, 1) : 0;
      h.isConcentrated = h.weightInTotalAsset >= 30.0;
    }

    const defaultSummary = usStat.count > 0 && cnStat.count === 0 ? usSummary : cnSummary;

    return {
      ok: true,
      summary: {
        ...defaultSummary,
        cn: cnSummary,
        us: usSummary,
        hasCn: cnStat.count > 0 || cashBalanceCn > 0,
        hasUs: usStat.count > 0 || cashBalanceUs > 0,
      },
      holdings,
      accounts,
      plans,
      opportunities: {
        reachSell: reachSellHoldings,
        reachBuy: reachBuyHoldings,
        upcomingDividends: upcomingDividendHoldings,
        nearBuy: nearBuyHoldings,
        nearSell: nearSellHoldings,
      },
      settings: {
        holidays,
        tradingDays: tradingDays ? [...tradingDays] : null,
      },
      serverTime: nowMs,
    };
  } catch (e) {
    return { ok: false, error: `获取资产组合失败：${e.message}` };
  }
};
