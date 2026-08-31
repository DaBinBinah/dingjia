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
function calcBreakevenPrice(type, quantity, costPrice, feeSettings = {}) {
  if (!quantity || !costPrice) return null;
  const commissionRate = feeSettings.commissionRate != null ? Number(feeSettings.commissionRate) : 0.00025; // 默认万2.5
  const minCommission = feeSettings.minCommission != null ? Number(feeSettings.minCommission) : 5.0;       // 默认5元
  const stampDutyRate = type === 'stock' ? (feeSettings.stampDutyRate != null ? Number(feeSettings.stampDutyRate) : 0.0005) : 0; // 股票卖出印花税万5，ETF免
  const transferFeeRate = feeSettings.transferFeeRate != null ? Number(feeSettings.transferFeeRate) : 0.00001; // 过户费

  const buyAmount = quantity * costPrice;
  const buyCommission = Math.max(minCommission, buyAmount * commissionRate);
  const buyTransfer = buyAmount * transferFeeRate;
  const totalActualCost = buyAmount + buyCommission + buyTransfer;

  // 设卖出价格为 P，卖出净得 = quantity * P - max(minCommission, quantity * P * commissionRate) - quantity * P * stampDutyRate - quantity * P * transferFeeRate
  // 近似线性求解 P
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
      if (w.code) watchMap.set(w.code, w);
      if (w.thsCode) watchMap.set(w.thsCode, w);
    }

    const planMap = new Map();
    for (const p of plans) {
      if (p.code) planMap.set(p.code, p);
    }

    // 1. 批量拉取持仓标的最新行情
    const stockCodes = [];
    const etfCodes = [];
    for (const h of holdingsRaw) {
      const tc = h.thsCode || toThsCode(h.type, h.code);
      if (tc) {
        if (h.type === 'stock') stockCodes.push(tc);
        else if (h.type === 'etf') etfCodes.push(tc);
      }
    }

    const [stockQuotesRes, etfQuotesRes] = await Promise.all([
      stockCodes.length ? fetchQuotes('stock', [...new Set(stockCodes)]).catch(() => ({ quotes: {} })) : { quotes: {} },
      etfCodes.length ? fetchQuotes('etf', [...new Set(etfCodes)]).catch(() => ({ quotes: {} })) : { quotes: {} },
    ]);
    const quotes = { ...stockQuotesRes.quotes, ...etfQuotesRes.quotes };

    // 2. 现金账户汇总
    let cashBalance = 0;
    let totalInvested = 0;
    for (const acc of accounts) {
      if (typeof acc.cashBalance === 'number') cashBalance += acc.cashBalance;
      if (typeof acc.totalInvested === 'number') totalInvested += acc.totalInvested;
    }

    // 3. 逐个持仓计算
    let stockMarketValue = 0;
    let etfMarketValue = 0;
    let totalCost = 0;
    let totalFloatingPnL = 0;
    let todayTotalPnL = 0;
    let totalExpectedDividend = 0;
    let totalPlannedAmount = 0;

    const reachSellHoldings = [];
    const reachBuyHoldings = [];
    const upcomingDividendHoldings = [];
    const nearBuyHoldings = [];
    const nearSellHoldings = [];

    const holdings = [];

    for (const h of holdingsRaw) {
      const tc = h.thsCode || toThsCode(h.type, h.code);
      const q = (tc && quotes[tc]) || null;
      const w = watchMap.get(h.code) || (tc ? watchMap.get(tc) : null) || null;
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
          todayTotalPnL += todayPnL;
        }

        if (h.type === 'stock') stockMarketValue += marketValue;
        else if (h.type === 'etf') etfMarketValue += marketValue;

        totalCost += costAmount;
        totalFloatingPnL += floatingPnL;
      } else {
        totalCost += costAmount;
      }

      // 读取分红数据
      let dividendData = null;
      try {
        dividendData = await getDividendData(db, h.type, h.code, {
          currentPrice,
          buyPrice: w ? w.buyPrice : costPrice,
          tradingDays,
          holidays,
        });
      } catch (_) {}

      let expectedDividend = null;
      let costDividendYield = null;
      let currentDividendYield = null;
      let latestDividend = dividendData && dividendData.latest ? dividendData.latest : null;
      let tradingDaysLeft = dividendData ? dividendData.tradingDaysLeft : null;

      if (latestDividend && latestDividend.dividendPerShare > 0) {
        expectedDividend = round(quantity * latestDividend.dividendPerShare, 2);
        totalExpectedDividend += expectedDividend;
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
      totalPlannedAmount += plannedAmt;

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

    const totalMarketValue = round(stockMarketValue + etfMarketValue, 2);
    const totalAsset = round(totalMarketValue + cashBalance, 2);
    const totalFloatingPnLPct = totalCost > 0 ? round((totalFloatingPnL / totalCost) * 100, 2) : 0;

    // 仓位配置占比与单项集中度二次补齐
    for (const h of holdings) {
      h.weightInTotalAsset = totalAsset > 0 && h.marketValue != null ? round((h.marketValue / totalAsset) * 100, 1) : 0;
      h.weightInTotalMarket = totalMarketValue > 0 && h.marketValue != null ? round((h.marketValue / totalMarketValue) * 100, 1) : 0;
      h.isConcentrated = h.weightInTotalAsset >= 30.0; // 单项占总资产 30% 以上标记集中度高
    }

    const stockWeight = totalAsset > 0 ? round((stockMarketValue / totalAsset) * 100, 1) : 0;
    const etfWeight = totalAsset > 0 ? round((etfMarketValue / totalAsset) * 100, 1) : 0;
    const cashWeight = totalAsset > 0 ? round((cashBalance / totalAsset) * 100, 1) : 0;

    // 资金安全垫与未规划资金
    const unplannedCash = Math.max(0, round(cashBalance - totalPlannedAmount, 2));
    const plannedRatio = cashBalance > 0 ? round((totalPlannedAmount / cashBalance) * 100, 1) : 0;

    return {
      ok: true,
      summary: {
        totalAsset,
        stockMarketValue: round(stockMarketValue, 2),
        etfMarketValue: round(etfMarketValue, 2),
        totalMarketValue,
        cashBalance: round(cashBalance, 2),
        totalInvested: round(totalInvested, 2),
        totalCost: round(totalCost, 2),
        totalFloatingPnL: round(totalFloatingPnL, 2),
        totalFloatingPnLPct,
        todayTotalPnL: round(todayTotalPnL, 2),
        totalExpectedDividend: round(totalExpectedDividend, 2),
        totalPlannedAmount: round(totalPlannedAmount, 2),
        unplannedCash,
        plannedRatio,
        weights: {
          stock: stockWeight,
          etf: etfWeight,
          cash: cashWeight,
        },
      },
      holdings,
      accounts,
      opportunities: {
        reachSell: reachSellHoldings,
        reachBuy: reachBuyHoldings,
        upcomingDividends: upcomingDividendHoldings,
        nearBuy: nearBuyHoldings,
        nearSell: nearSellHoldings,
      },
      settings: userSettingsDoc,
      serverTime: nowMs,
    };
  } catch (e) {
    return { ok: false, error: `读取资产组合失败：${e.message}` };
  }
};
