/**
 * 盯价 —— 前端全量业务逻辑
 * Slogan: 你定价格，我来盯。
 * 包含：A股/ETF价格监控 + 分红雷达 + 资产管理 + 持仓盈亏 + 补仓/卖出模拟器 + 批量导入
 */
'use strict';

/* ---------------- 云环境配置 ---------------- */
const ENV_ID = 'REDACTED_CLOUDBASE_ENV_ID';
const REGION = 'ap-shanghai';
const ACCESS_KEY =
  'REDACTED_CLOUDBASE_ACCESS_KEY';

const PHASE_LABELS = {
  trading: '监控中',
  'lunch-break': '午间休市',
  'pre-open': '盘前',
  closed: '已收盘',
  weekend: '周末休市',
  holiday: '节假日休市',
};

/* ---------------- 新手术语通俗解释词典 (少术语、多举例、映射指南章节) ---------------- */
const EXPLAIN_DICT = {
  currentPrice: {
    title: '当前价格 (最新市价)',
    desc: '交易所当前最新撮合成交的单价。\n\n通俗理解：在交易时间内（09:30~11:30、13:00~15:00），买卖双方实时撮合，价格每时每刻在变动，这是完全正常的。',
    guideSec: 'secQuote',
  },
  changePercent: {
    title: '今日涨跌幅 (相比昨天)',
    desc: '今天最新价格相对于昨天收盘价的涨跌百分比。\n\n通俗理解：A股红色代表上涨（+），绿色代表下跌（-）。如果为 0.00% 表示与昨天收盘价持平。',
    guideSec: 'secQuote',
  },
  buyPrice: {
    title: '买入价格 (低吸关注线)',
    desc: '你自己设定的目标关注价格。\n\n通俗理解：当价格跌到或低于这个数字时，系统会自动提醒你。这绝非系统建议买入，而是你自己的计划价格。',
    guideSec: 'secTouch',
  },
  sellPrice: {
    title: '卖出价格 (止盈目标线)',
    desc: '你自己设定的目标止盈价格。\n\n通俗理解：当价格涨到或高于这个数字时，系统会自动提醒你，提醒后由你自己决定是否操作。',
    guideSec: 'secTouch',
  },
  targetTouch: {
    title: '目标价格触达 (秒级快照)',
    desc: '当市场行情第一次进入你设定的买入或卖出价格区域时，系统记录下该瞬间的精确秒级时间、行情快照与涨跌幅。\n\n通俗理解：即使后来价格回落，系统也完整记录它何时达标过。',
    guideSec: 'secTouch',
  },
  rearmTouch: {
    title: '重复重新触达 (离开后再次达标)',
    desc: '如果价格达标后又离开了目标区间（如从2.00涨到2.05），系统会自动解除锁定；当价格再次进入目标区时，会生成新的独立触达记录。',
    guideSec: 'secTouch',
  },
  holding: {
    title: '持仓股数 (你实际持有的份额)',
    desc: '你实际用资金买入并持有的股票或 ETF 数量。\n\n⚠️ 重点：监控 ≠ 持仓。监控只是你的观察清单，持仓才是你真金白银拥有的资产。',
    guideSec: 'secPortfolio',
  },
  costPrice: {
    title: '持仓成本价 (平均买入价)',
    desc: '你买入该股票时的平均成交单价。\n\n通俗理解：用来和你现在的股价对比，计算账面上是浮盈还是浮亏。',
    guideSec: 'secPortfolio',
  },
  marketValue: {
    title: '当前市值 (持仓总价值)',
    desc: '当前市值 = 当前股票单价 × 你持有的股数。\n\n通俗理解：如果现在把手里持有的股票全部按市价卖出，大约能换回多少现金。',
    guideSec: 'secPortfolio',
  },
  floatingPnL: {
    title: '浮动盈亏 (纸面盈亏)',
    desc: '浮动盈亏 = 当前市值 - 买入总成本。\n\n通俗理解：只要股票还没在券商卖出，它每天都会随股价波动，不等于真正落袋的利润。',
    guideSec: 'secPortfolio',
  },
  realizedProfit: {
    title: '已实现利润 (落袋收益)',
    desc: '只有真实在券商软件中卖出股票后，赚到的差价扣除税费后才属于真正落袋的已实现利润。',
    guideSec: 'secPortfolio',
  },
  dividend: {
    title: '上市公司分红 (现金红利)',
    desc: '上市公司将经营利润按持股比例以现金派发给股东。\n\n⚠️ 重点：分红后股价会进行除息扣减，获得分红不等于无风险额外收益。',
    guideSec: 'secDividend',
  },
  recordDate: {
    title: '股权登记日 (最关键分红日)',
    desc: '在股权登记日当天下午 15:00 收市时，只要你账户里持有该股票，就自动享有本次分红权益。在登记日之后卖出依然享有分红。',
    guideSec: 'secDividend',
  },
  exDate: {
    title: '除息日 (价格调整日)',
    desc: '进行除息价格调整的交易日。当天开盘基准价会按每股分红金额等额下调，属于正常的交易规则调整。',
    guideSec: 'secDividend',
  },
  dividendYield: {
    title: '股息率 (分红收益率)',
    desc: '股息率 = 每股现金分红 ÷ 股票价格。\n\n通俗理解：衡量分红回报率的指标，但上市公司未来分红可能变动，不等于固定利息保证。',
    guideSec: 'secDividend',
  },
  etf: {
    title: 'ETF (交易型一揽子基金)',
    desc: 'ETF 相当于一篮子股票打包在一起的基金份额（如沪深300、半导体等），买一份相当于分散买入一整篮子资产，避免单只个股暴雷。',
    guideSec: 'secConcept',
  },
  stock: {
    title: '股票 (上市公司股份)',
    desc: '代表持有单家上市公司的一小部分权益，收益与风险与该公司的经营发展紧密相连。',
    guideSec: 'secConcept',
  },
  yearHighLow: {
    title: '年内最高/最低价',
    desc: '记录今年以来该股票出现过的最高价与最低价，帮助你直观判断当前价格是在山顶还是谷底。',
    guideSec: 'secQuote',
  },
  pe: {
    title: 'PE (市盈率 / 估值)',
    desc: '市盈率 = 公司市值 ÷ 净利润。\n\n通俗理解：按当前价格买入大约需要多少年收回本金，数值越低通常估值相对越便宜。',
    guideSec: 'secQuote',
  },
  breakeven: {
    title: '理论回本价 (保本点)',
    desc: '理论回本价 = 覆盖买入与卖出的券商佣金、印花税及过户费后的价格。股价涨到此价位卖出才真正不亏钱。',
    guideSec: 'secPortfolio',
  },
  drawdown: {
    title: '年内回撤 (距高点下跌)',
    desc: '指股价从今年最高点跌到当前价格的幅度。衡量股票从高处跌下来多少。',
    guideSec: 'secQuote',
  },
  scenario: {
    title: '情景盈亏测算',
    desc: '基于纯数学模型，测算当股价上涨或下跌时你的市值与盈亏变化，帮助你提前做好心理准备与风险规划。',
    guideSec: 'secPortfolio',
  },
  cashSafe: {
    title: '现金安全垫',
    desc: '现金资产占总投资资产的比例。留有一定现金就像安全气囊，大跌时不慌，有机会时有子弹。',
    guideSec: 'secPortfolio',
  },
};

/* ---------------- 全局状态 ---------------- */
const state = {
  app: null,
  watches: [],
  alerts: [],
  alertFilter: 'all',
  alertOffset: 0,
  alertHasMore: false,
  stats: null,
  meta: null,
  view: 'watches', // 'watches' | 'portfolio' | 'dividends' | 'alerts' | 'detail' | 'holdingDetail'
  watchFilter: 'all',
  divFilter: 'all',
  holdingSort: 'pnlPct', // 'pnlPct' | 'pnlAmount' | 'marketValue' | 'newest'
  portfolio: {
    summary: null,
    holdings: [],
    accounts: [],
    opportunities: null,
  },
  editingId: null,
  editingHoldingId: null,
  detailId: null,
  detailHoldingId: null,
  formManBuy: false,
  formManSell: false,
  formBaseBuy: '',
  formBaseSell: '',
  confirmAction: null,
  refreshBusy: false,
  perf: {},
  dividends: {},
  dividendEvents: [],
  histPeriod: 'day',
  histRange: '1m',
  histCustom: { from: null, to: null },
  // V4 新增状态
  radar: { nearBuy: 0, nearSell: 0, divNear: 0, anomaly: 0, filter: null },
  marketOverview: null,
  plans: {},
  notes: {},
  settings: {
    displayMode: 'novice',
    commissionRate: 0.00025,
    minCommission: 5.0,
    stampDutyRate: 0.0005,
    transferFeeRate: 0.00001,
  },
};

const $ = (sel) => document.querySelector(sel);

/* ---------------- 工具函数 ---------------- */
function fmtPrice(v, type) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v.toFixed(type === 'etf' ? 3 : 2);
}

function fmtMoney(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '¥0.00';
  const s = Math.abs(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${v < 0 ? '-¥' : '¥'}${s}`;
}

function fmtSignedMoney(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '¥0.00';
  const s = Math.abs(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${v > 0 ? '+¥' : v < 0 ? '-¥' : '¥'}${s}`;
}

function parseDiscount(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = n > 2 ? n / 100 : n;
  if (d > 5) return null;
  return Math.round(d * 10000) / 10000;
}

function calcTargetPrices() {
  const t = parseFloat($('#fTarget').value);
  if (!Number.isFinite(t) || t <= 0) return null;
  const buyD = parseDiscount($('#fBuyD').value);
  const sellD = parseDiscount($('#fSellD').value);
  if (buyD === null || sellD === null) return null;
  return { buy: Math.round(t * buyD * 100) / 100, sell: Math.round(t * sellD * 100) / 100 };
}

function fmtPct(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const s = v > 0 ? '+' : '';
  return `${s}${v.toFixed(2)}%`;
}

function pctOffset(d) {
  if (typeof d !== 'number' || !Number.isFinite(d)) return null;
  return fmtPct((d - 1) * 100);
}

function toDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function fmtFullDateTime(v) {
  const d = toDate(v);
  if (!d) return '—';
  const beijing = new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 60000);
  return `${beijing.getFullYear()}-${pad(beijing.getMonth() + 1)}-${pad(beijing.getDate())} ${pad(beijing.getHours())}:${pad(beijing.getMinutes())}:${pad(beijing.getSeconds())}`;
}

function fmtDate(ms) {
  if (!ms) return '—';
  const d = new Date((ms || 0) + 8 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function isoWeekKey(ms) {
  const d = new Date(ms + 8 * 3600 * 1000);
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const thu = new Date(t);
  thu.setUTCDate(thu.getUTCDate() + 3 - ((thu.getUTCDay() + 6) % 7));
  const year = thu.getUTCFullYear();
  const first = new Date(Date.UTC(year, 0, 4));
  first.setUTCDate(first.getUTCDate() - ((first.getUTCDay() + 6) % 7));
  const week = Math.floor((thu.getTime() - first.getTime()) / (7 * 86400000)) + 1;
  return `${year}-W${pad(week)}`;
}

function fmtTime(v, withDate) {
  const d = toDate(v);
  if (!d) return '—';
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return withDate ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${t}` : t;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

let toastTimer = null;
function toast(msg, ms = 2200) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/* ---------------- 云端调用 ---------------- */
async function ensureLogin() {
  const auth = state.app.auth;
  try {
    const { data } = await auth.getSession();
    if (data && data.session) return;
  } catch (_) {}
  const { error } = await auth.signInAnonymously();
  if (error) throw new Error(`匿名登录失败：${error.message}`);
}

async function call(name, data = {}, { retried = false } = {}) {
  const accessCode = localStorage.getItem('ths_access_code') || '';
  let res;
  try {
    res = await state.app.callFunction({ name, data: { ...data, accessCode } });
  } catch (e) {
    throw new Error(`云函数 ${name} 调用失败：${e.message}`);
  }
  const result = res && res.result !== undefined ? res.result : res;
  if (result && result.needAccessCode && !retried) {
    const code = await promptAccessCode();
    if (code == null) throw new Error('需要访问口令');
    localStorage.setItem('ths_access_code', code);
    const retry = await call(name, data, { retried: true });
    if (retry && retry.needAccessCode) {
      localStorage.removeItem('ths_access_code');
      throw new Error('访问口令不正确');
    }
    return retry;
  }
  return result;
}

function promptAccessCode() {
  return new Promise((resolve) => {
    const modal = $('#codeModal');
    const input = $('#fAccessCode');
    const err = $('#codeError');
    err.hidden = true;
    input.value = '';
    modal.hidden = false;
    setTimeout(() => input.focus(), 60);
    const done = (val) => {
      modal.hidden = true;
      $('#codeOk').onclick = null;
      resolve(val);
    };
    $('#codeOk').onclick = () => {
      const v = input.value.trim();
      if (!v) { err.textContent = '请输入口令'; err.hidden = false; return; }
      done(v);
    };
  });
}

/* ---------------- 数据加载 ---------------- */
async function loadWatches({ silent = false } = {}) {
  try {
    const r = await call('ths-get-watches');
    if (!r || !r.ok) throw new Error((r && r.error) || '未知错误');
    state.watches = r.watches || [];
    state.stats = r.stats;
    state.meta = { phase: r.phase, serverTime: r.serverTime, settings: r.settings, scanState: r.scanState };
    renderStats();
    refreshPerf();
    refreshDividends();
    renderWatches();
    renderStatus();
    if (!silent && state.view === 'watches') $('#stats').hidden = false;
  } catch (e) {
    if (!silent) toast(`加载失败：${e.message}`);
    renderStatus({ error: e.message });
  }
}

async function loadPortfolio({ silent = false } = {}) {
  try {
    const r = await call('ths-get-portfolio');
    if (!r || !r.ok) throw new Error((r && r.error) || '未知错误');
    state.portfolio = {
      summary: r.summary || {},
      holdings: r.holdings || [],
      accounts: r.accounts || [],
      opportunities: r.opportunities || {},
    };
    renderPortfolio();
  } catch (e) {
    if (!silent) toast(`加载资产失败：${e.message}`);
  }
}

async function manualRefresh() {
  if (state.refreshBusy) return;
  state.refreshBusy = true;
  const btn = $('#refreshBtn');
  btn.classList.add('spinning');
  perfLoadedKey = null;
  divLoadedKey = null;
  try {
    const r = await call('ths-check-market', { force: true });
    if (r && r.ok) {
      const a = (r.alertsCreated || 0) + (r.dividendAlertsCreated || 0);
      toast(a > 0 ? `已刷新行情，新增 ${a} 条提醒` : '行情已同步最新收盘价', 1500);
    } else if (r && !r.ok) {
      toast(`刷新异常：${r.error || '未知错误'}`);
    }
  } catch (e) {
    toast(`刷新失败：${e.message}`);
  } finally {
    await Promise.all([loadWatches({ silent: true }), loadPortfolio({ silent: true })]);
    btn.classList.remove('spinning');
    state.refreshBusy = false;
  }
}

async function loadAlerts({ append = false } = {}) {
  try {
    const offset = append ? state.alertOffset : 0;
    const r = await call('ths-get-alerts', { filter: state.alertFilter, limit: 30, offset });
    if (!r || !r.ok) throw new Error((r && r.error) || '未知错误');
    state.alerts = append ? state.alerts.concat(r.items || []) : r.items || [];
    state.alertOffset = offset + (r.items || []).length;
    state.alertHasMore = !!r.hasMore;
    renderAlerts();
  } catch (e) {
    toast(`加载提醒记录失败：${e.message}`);
  }
}

/* ---------------- 批量预载历史行情与分红 ---------------- */
let perfLoadedKey = null;
async function refreshPerf() {
  const list = state.watches.map((w) => ({ type: w.type, code: w.code }));
  const key = list.map((x) => `${x.type}:${x.code}`).join(',');
  if (!list.length || key === perfLoadedKey) return;
  perfLoadedKey = key;
  try {
    const r = await call('ths-get-history', { mode: 'perf', list });
    if (r && r.ok && r.perf) {
      state.perf = r.perf;
      renderWatches();
    }
  } catch (_) {}
}

let divLoadedKey = null;
async function refreshDividends() {
  const list = state.watches.map((w) => ({
    type: w.type,
    code: w.code,
    currentPrice: w.currentPrice,
    buyPrice: w.buyPrice,
  }));
  const key = list.map((x) => `${x.type}:${x.code}:${x.currentPrice}`).join(',');
  if (!list.length || key === divLoadedKey) return;
  divLoadedKey = key;
  try {
    const r = await call('ths-get-dividends', { mode: 'batch', list });
    if (r && r.ok && r.dividends) {
      state.dividends = r.dividends;
      let upCount = 0;
      for (const d of Object.values(r.dividends)) {
        if (d && d.hasDividend && d.tradingDaysLeft != null && d.tradingDaysLeft >= 0 && d.tradingDaysLeft <= 20) {
          upCount++;
        }
      }
      if (state.stats) {
        state.stats.dividendUpcoming = upCount;
        renderStats();
      }
      renderWatches();
      if (state.view === 'dividends') renderDividendsView();
    }
  } catch (_) {}
}

/* ---------------- 渲染统计与状态栏 ---------------- */
function renderStats() {
  const s = state.stats;
  if (!s) return;
  $('#statMonitoring').textContent = s.monitoring;
  $('#statAlerts').textContent = s.alertsToday == null ? '—' : s.alertsToday;
  $('#statBuy').textContent = s.buyOpportunities;
  $('#statSell').textContent = s.sellOpportunities;
  $('#statDividend').textContent = s.dividendUpcoming != null ? s.dividendUpcoming : '—';
  if (state.view === 'watches') $('#stats').hidden = false;
}

function renderStatus(extra = {}) {
  const bar = $('#statusBar');
  const meta = state.meta || {};
  const phaseLabel = meta.phase ? PHASE_LABELS[meta.phase] || meta.phase : '—';
  const failedWatches = state.watches.filter((w) => w.enabled && w.quoteError).length;
  const scanState = meta.scanState;
  let market = '正常';
  if (extra.error) market = '获取失败';
  else if (scanState && scanState.lastScanAt && scanState.lastScanOk === false) market = '部分异常';
  else if (failedWatches > 0) market = `获取失败(${failedWatches})`;
  const updateTime = scanState && scanState.lastScanAt ? fmtTime(scanState.lastScanAt) : '—';
  bar.innerHTML = `<span>行情状态：${esc(market)} ｜ 更新 ${esc(updateTime)} ｜ ${esc(phaseLabel)}</span>`;
  $('#phaseLine').textContent = `当前：${phaseLabel}`;
}

/* ---------------- 价格距离状态与文案计算 ---------------- */
function updateRadarCard() {
  const ws = state.watches || [];
  let nearBuyCount = 0;
  let nearSellCount = 0;
  let divNearCount = 0;
  let anomalyCount = 0;

  for (const w of ws) {
    if (!w.enabled || typeof w.currentPrice !== 'number') continue;
    const price = w.currentPrice;
    if (w.buyPrice != null && price > w.buyPrice) {
      const distPct = ((price - w.buyPrice) / price) * 100;
      if (distPct <= 5.0) nearBuyCount++;
    }
    if (w.sellPrice != null && price < w.sellPrice) {
      const distPct = ((w.sellPrice - price) / price) * 100;
      if (distPct <= 5.0) nearSellCount++;
    }
    const d = state.dividends[w.thsCode || w.code];
    if (d && d.hasDividend && d.tradingDaysLeft != null && d.tradingDaysLeft >= 0 && d.tradingDaysLeft <= 10) {
      divNearCount++;
    }
    if (w.changePercent != null && Math.abs(w.changePercent) >= 5.0) {
      anomalyCount++;
    }
  }

  const totalEvents = nearBuyCount + nearSellCount + divNearCount + anomalyCount;
  $('#rgNearBuy').textContent = nearBuyCount;
  $('#rgNearSell').textContent = nearSellCount;
  $('#rgDivNear').textContent = divNearCount;
  $('#rgAnomaly').textContent = anomalyCount;
  $('#radarBadge').textContent = `${totalEvents} 个待关注事项`;

  const summaryEl = $('#dailySummaryText');
  const alertCount = state.stats ? state.stats.alertsToday || 0 : 0;
  summaryEl.textContent = `今天监控中 ${ws.length} 只标的，其中 ${nearBuyCount} 只接近买入线，${nearSellCount} 只接近卖出线，${divNearCount} 只临近分红，今日已生成 ${alertCount} 次关键提醒。`;
}

function lineState(w, side) {
  const line = side === 'buy' ? w.buyPrice : w.sellPrice;
  if (line == null) return null;
  if (typeof w.currentPrice !== 'number') return { cls: 'st-wait', text: '待行情', reached: false, side };
  const price = w.currentPrice;

  if (side === 'buy') {
    if (price <= line) {
      return { cls: 'st-ok-buy', text: '🎯 现价已达到买入目标价', reached: true, side: 'buy' };
    }
    const diff = price - line;
    const pct = (diff / price) * 100;
    return {
      cls: 'st-near-buy',
      text: `🟢 还需下跌 ¥${fmtPrice(diff, w.type)}（${pct.toFixed(1)}%） 到达买入价 ¥${fmtPrice(line, w.type)}`,
      reached: false,
      side: 'buy',
    };
  }

  if (price >= line) {
    return { cls: 'st-ok-sell', text: '🎯 现价已达到卖出目标价', reached: true, side: 'sell' };
  }
  const diff = line - price;
  const pct = (diff / price) * 100;
  return {
    cls: 'st-near-sell',
    text: `🟡 还需上涨 ¥${fmtPrice(diff, w.type)}（${pct.toFixed(1)}%） 到达卖出价 ¥${fmtPrice(line, w.type)}`,
    reached: false,
    side: 'sell',
  };
}

/* ---------------- 监控卡片渲染 ---------------- */
function renderWatches() {
  const list = $('#watchList');
  const empty = $('#emptyState');
  const all = state.watches;
  const watchFilter = state.watchFilter;
  let watches = all;
  if (watchFilter === 'done') watches = all.filter((w) => w.enabled && (w.buyAchievedAt || w.sellAchievedAt));
  else if (watchFilter === 'active') watches = all.filter((w) => !w.enabled || !(w.buyAchievedAt || w.sellAchievedAt));
  if (!watches.length) {
    list.innerHTML = '';
    empty.hidden = false;
    const et = $('#emptyTitle');
    const es = $('#emptySub');
    const btn = empty.querySelector('[data-open-add]');
    const alt = empty.querySelector('.empty-alt');
    if (watchFilter === 'done') {
      if (et) et.textContent = '暂无已达成标的';
      if (es) es.innerHTML = '当股票或 ETF 价格达到你设定的买入或卖出价时，<br>会在此归档展示';
      if (btn) btn.hidden = true;
      if (alt) alt.hidden = true;
    } else if (watchFilter === 'active') {
      if (et) et.textContent = '暂无进行中监控';
      if (es) es.innerHTML = '所有标的已达成或已暂停';
      if (btn) btn.hidden = false;
      if (alt) alt.hidden = false;
    } else {
      if (et) et.textContent = '还没有监控标的';
      if (es) es.innerHTML = '添加股票或 ETF，设置价格线，<br>跌破 / 突破时自动提醒你';
      if (btn) btn.hidden = false;
      if (alt) alt.hidden = false;
    }
    return;
  }
  empty.hidden = true;

  // 🎯 智能置顶排序：达标标的排在最前列，正常监控标的中次之，已暂停标的沉底
  watches.sort((a, b) => {
    const aInBuy = a.buyPrice != null && a.currentPrice != null && a.currentPrice <= a.buyPrice;
    const aInSell = a.sellPrice != null && a.currentPrice != null && a.currentPrice >= a.sellPrice;
    const aHit = a.enabled && (aInBuy || aInSell || a.buyAchievedAt || a.sellAchievedAt || a.buyTriggered || a.sellTriggered);

    const bInBuy = b.buyPrice != null && b.currentPrice != null && b.currentPrice <= b.buyPrice;
    const bInSell = b.sellPrice != null && b.currentPrice != null && b.currentPrice >= b.sellPrice;
    const bHit = b.enabled && (bInBuy || bInSell || b.buyAchievedAt || b.sellAchievedAt || b.buyTriggered || b.sellTriggered);

    const aScore = aHit ? 0 : a.enabled ? 1 : 2;
    const bScore = bHit ? 0 : b.enabled ? 1 : 2;

    if (aScore !== bScore) return aScore - bScore;
    return 0;
  });

  // 持仓快速映射
  const holdingMap = new Map();
  for (const h of state.portfolio.holdings || []) holdingMap.set(h.code, h);

  list.innerHTML = watches
    .map((w) => {
      const priceStr = fmtPrice(w.currentPrice, w.type);
      const pct = fmtPct(w.changePercent);
      const pctCls = w.changePercent == null ? 'flat' : w.changePercent > 0 ? 'up' : w.changePercent < 0 ? 'down' : 'flat';
      const inBuy = w.buyPrice != null && w.currentPrice != null && w.currentPrice <= w.buyPrice;
      const inSell = w.sellPrice != null && w.currentPrice != null && w.currentPrice >= w.sellPrice;
      const cardCls = ['card'];
      if (!w.enabled) cardCls.push('paused');
      else if (w.enabled && (inBuy || inSell)) {
        if (inBuy) cardCls.push('triggered-buy');
        else cardCls.push('triggered-sell');
      } else if (w.enabled && (w.buyAchievedAt || w.sellAchievedAt)) cardCls.push('done');

      let badge = '';
      let pinBadge = '';
      if (w.enabled && (inBuy || inSell)) {
        if (inBuy) {
          badge = '<span class="chip chip-buy-hit"><span class="pulse-dot buy"></span>🎯 已达到买入价格 · 置顶</span>';
          pinBadge = '<div class="card-pin-badge buy">📌 达标置顶</div>';
        } else {
          badge = '<span class="chip chip-sell-hit"><span class="pulse-dot sell"></span>🎯 已达到卖出价格 · 置顶</span>';
          pinBadge = '<div class="card-pin-badge sell">📌 达标置顶</div>';
        }
      } else if (w.enabled && (w.buyAchievedAt || w.sellAchievedAt)) {
        badge = '<span class="chip chip-done"><span class="pulse-dot purple"></span>🏁 目标已达成</span>';
        pinBadge = '<div class="card-pin-badge done">🏁 已达成</div>';
      } else if (!w.enabled) {
        badge = '<span class="chip chip-off">已暂停</span>';
      } else {
        badge = '<span class="chip chip-on">监控中</span>';
      }

      const h = holdingMap.get(w.code);
      let holdingTag = '';
      if (h) {
        const hpct = fmtPct(h.floatingPnLPct);
        holdingTag = `<span class="chip chip-holding">🟢 持有 ${h.quantity}股 (${hpct || '—'})</span>`;
      }

      const thsCode = w.thsCode || (w.type === 'etf' || w.type === 'stock' ? impToThsCode(w.type, w.code) : null);
      const p = thsCode ? state.perf[thsCode] : null;

      let ytdRow = '';
      if (p && (p.y2025 != null || p.y2026 != null)) {
        const y25 = p.y2025;
        const y26 = p.y2026;
        const c25 = y25 == null ? 'flat' : y25 >= 0 ? 'up' : 'down';
        const c26 = y26 == null ? 'flat' : y26 >= 0 ? 'up' : 'down';
        ytdRow = `<div class="ytd-row">
          <span class="ytd-item ${c25}">2025年至今 ${y25 == null ? '暂无数据' : fmtPct(y25)}</span>
          <span class="ytd-item ${c26}">2026年至今 ${y26 == null ? '暂无数据' : fmtPct(y26)}</span>
        </div>`;
      }

      let yearRangeRow = '';
      if (p && (p.yearHigh != null || p.yearLow != null) && typeof w.currentPrice === 'number') {
        const high = p.yearHigh;
        const low = p.yearLow;
        const distHigh = high ? ((w.currentPrice - high) / high) * 100 : null;
        const distLow = low ? ((w.currentPrice - low) / low) * 100 : null;
        yearRangeRow = `<div class="year-range-row">
          <span>年内高 <b>¥${high ? fmtPrice(high, w.type) : '—'}</b>${distHigh != null ? `（${fmtPct(distHigh)}）` : ''}</span>
          <span>年内低 <b>¥${low ? fmtPrice(low, w.type) : '—'}</b>${distLow != null ? `（${fmtPct(distLow)}）` : ''}</span>
        </div>`;
      }

      const buyLine = lineState(w, 'buy');
      const sellLine = lineState(w, 'sell');
      const lines = [];
      if (buyLine) {
        if (buyLine.reached) {
          lines.push(`<div class="line hit-highlight buy"><span>${esc(buyLine.text)}</span> <span>¥${fmtPrice(w.buyPrice, w.type)}</span></div>`);
        } else {
          lines.push(`<div class="line"><span class="st ${buyLine.cls}">${esc(buyLine.text)}</span></div>`);
        }
      }
      if (sellLine) {
        if (sellLine.reached) {
          lines.push(`<div class="line hit-highlight sell"><span>${esc(sellLine.text)}</span> <span>¥${fmtPrice(w.sellPrice, w.type)}</span></div>`);
        } else {
          lines.push(`<div class="line"><span class="st ${sellLine.cls}">${esc(sellLine.text)}</span></div>`);
        }
      }

      const div = thsCode ? state.dividends[thsCode] : null;
      let divRow = '';
      if (div && div.hasDividend && div.latest) {
        const latest = div.latest;
        const dps = latest.dividendPerShare;
        const days = div.tradingDaysLeft;
        let countdownText = '';
        let cdCls = 'cd-normal';
        if (div.isToday) {
          countdownText = '🔴 今日为股权登记日';
          cdCls = 'cd-today';
        } else if (div.isPassed) {
          countdownText = '⚪ 已除息';
          cdCls = 'cd-passed';
        } else if (days != null) {
          countdownText = `登记日还有 ${days} 个交易日`;
          if (days <= 3) cdCls = 'cd-urgent';
          else if (days <= 10) cdCls = 'cd-warn';
        }

        const inNearBuy = w.buyPrice != null && w.currentPrice != null && w.currentPrice > w.buyPrice && ((w.currentPrice - w.buyPrice) / w.currentPrice) < 0.05;
        let comboAlert = '';
        if (inNearBuy && days != null && days >= 0 && days <= 5) {
          comboAlert = '<span class="div-combo-tag">💰 分红临近 ⚠️ 价格接近买入线</span>';
        }

        divRow = `<div class="card-div-row">
          <span class="div-chip">💰 分红 每股 ¥${dps ? dps.toFixed(2) : '—'}</span>
          <span class="div-cd ${cdCls}">${countdownText}</span>
          ${comboAlert}
        </div>`;
      }

      let touchBanner = '';
      if (w.lastTouch && w.lastTouch.triggeredAt) {
        const t = w.lastTouch;
        const isBuy = t.alertType === 'buy';
        const postTxt = t.status === 'RETURNED' ? `触达后回落至 ¥${fmtPrice(w.currentPrice, w.type)}` : '当前仍处于目标区';
        touchBanner = `<div class="card-touch-banner ${isBuy ? 'buy' : 'sell'}">
          <span>${isBuy ? '🟢 买入价已触达' : '🔴 卖出价已触达'} ${fmtTime(t.triggeredAt)} · ¥${fmtPrice(t.triggerPrice, w.type)}</span>
          <span class="ctb-post">${postTxt}</span>
        </div>`;
      }

      return `
        <div class="${cardCls.join(' ')}" data-id="${esc(w._id)}" role="button" tabindex="0">
          <div class="card-top">
            <div style="min-width:0">
              <div class="card-name"><span class="nm">${esc(w.name)}</span>${badge}${holdingTag}</div>
              <div class="card-code">${esc(w.code)} · ${w.type === 'etf' ? 'ETF' : '股票'}</div>
            </div>
            ${pinBadge}
          </div>
          <div class="card-price-row">
            <span class="card-price ${priceStr == null ? 'na' : ''}">${priceStr == null ? '暂无行情' : `¥${priceStr}`}</span>
            <span class="card-change ${pctCls}">${pct == null ? '' : `${w.changePercent > 0 ? '↑' : w.changePercent < 0 ? '↓' : ''} ${pct}`}</span>
          </div>
          ${ytdRow}
          ${yearRangeRow}
          <div class="lines">${lines.join('')}</div>
          ${divRow}
          ${touchBanner}
          <div class="card-time">行情时间 ${esc(fmtTime(w.lastFetchTime, true))}${w.lastBuyAlertTime || w.lastSellAlertTime || w.lastDividendAlertTime ? ` ｜ 最近提醒 ${esc(fmtTime(w.lastBuyAlertTime || w.lastSellAlertTime || w.lastDividendAlertTime, true))}` : ''}</div>
        </div>`;
    })
    .join('');

  list.querySelectorAll('.card').forEach((el) => {
    el.addEventListener('click', () => {
      const w = state.watches.find((x) => x._id === el.dataset.id);
      if (w) openDetail(w);
    });
  });

  updateRadarCard();
}

/* ---------------- 资产视图渲染 ---------------- */
function renderPortfolio() {
  const sum = state.portfolio.summary || {};
  $('#heroTotalAsset').textContent = fmtMoney(sum.totalAsset || 0);
  $('#heroStockVal').textContent = fmtMoney(sum.stockMarketValue || 0);
  $('#heroEtfVal').textContent = fmtMoney(sum.etfMarketValue || 0);
  $('#heroCashVal').textContent = fmtMoney(sum.cashBalance || 0);
  $('#heroCostVal').textContent = fmtMoney(sum.totalCost || 0);

  const fp = sum.totalFloatingPnL || 0;
  const fpp = sum.totalFloatingPct != null ? sum.totalFloatingPct : sum.totalFloatingPnLPct || 0;
  const fpEl = $('#heroFloatingPnL');
  fpEl.textContent = fmtSignedMoney(fp);
  fpEl.className = `hp-val ${fp > 0 ? 'text-up' : fp < 0 ? 'text-down' : 'flat'}`;

  const fppEl = $('#heroFloatingPct');
  fppEl.textContent = fmtPct(fpp);
  fppEl.className = `hp-sub ${fpp > 0 ? 'text-up' : fpp < 0 ? 'text-down' : 'flat'}`;

  const tp = sum.todayTotalPnL || 0;
  const tpEl = $('#heroTodayPnL');
  tpEl.textContent = fmtSignedMoney(tp);
  tpEl.className = `hp-val ${tp > 0 ? 'text-up' : tp < 0 ? 'text-down' : 'flat'}`;

  $('#heroDividendVal').textContent = fmtMoney(sum.totalExpectedDividend || 0);

  // 资产配置条
  const w = sum.weights || { stock: 0, etf: 0, cash: 100 };
  $('#abStock').style.width = `${w.stock}%`;
  $('#abEtf').style.width = `${w.etf}%`;
  $('#abCash').style.width = `${w.cash}%`;
  $('#legStock').textContent = `${w.stock}%`;
  $('#legEtf').textContent = `${w.etf}%`;
  $('#legCash').textContent = `${w.cash}%`;

  // 资金安全垫与计划投入看板
  $('#fuCashRatio').textContent = `${w.cash}%`;
  $('#fuPlannedAmt').textContent = fmtMoney(sum.totalPlannedAmount || 0);
  $('#fuUnplannedCash').textContent = fmtMoney(sum.unplannedCash != null ? sum.unplannedCash : (sum.cashBalance || 0));

  // 单项集中度事实提示
  const concBanner = $('#concBanner');
  const concHolding = (state.portfolio.holdings || []).find((h) => h.isConcentrated);
  if (concHolding) {
    concBanner.hidden = false;
    $('#concText').textContent = `⚠️ 单项资产集中度较高：${concHolding.name} 占总资产 ${concHolding.weightInTotalAsset}%`;
  } else {
    concBanner.hidden = true;
  }

  renderOpportunities();
  renderHoldingsList();
}

function renderOpportunities() {
  const opp = state.portfolio.opportunities || {};
  const box = $('#oppSection');
  const list = $('#oppList');
  const items = [];

  for (const h of opp.reachSell || []) {
    items.push(`<div class="opp-item opp-reach-sell" data-code="${esc(h.code)}">
      <span class="opp-badge red">🔴 已达到卖出价</span>
      <div class="opp-txt"><b>${esc(h.name)}</b> 现价 ¥${fmtPrice(h.currentPrice, h.type)} ｜ 目标 ¥${fmtPrice(h.sellPrice, h.type)} ｜ 预计利润 <b class="text-up">+¥${h.expectedProfitAtSell}</b></div>
    </div>`);
  }

  for (const h of opp.reachBuy || []) {
    const buyShares = h.plannedAmount && h.buyPrice ? Math.floor(h.plannedAmount / h.buyPrice) : null;
    items.push(`<div class="opp-item opp-reach-buy" data-code="${esc(h.code)}">
      <span class="opp-badge green">🟢 已达到买入价</span>
      <div class="opp-txt"><b>${esc(h.name)}</b> 现价 ¥${fmtPrice(h.currentPrice, h.type)} ｜ 买入目标 ¥${fmtPrice(h.buyPrice, h.type)}${buyShares ? ` ｜ 计划投入可买约 <b>${buyShares}股</b>` : ''}</div>
    </div>`);
  }

  for (const h of opp.upcomingDividends || []) {
    items.push(`<div class="opp-item opp-div" data-code="${esc(h.code)}">
      <span class="opp-badge purple">💰 即将分红</span>
      <div class="opp-txt"><b>${esc(h.name)}</b> 持有 ${h.quantity}股 ｜ 预计现金分红 <b class="text-purple">¥${h.expectedDividend}</b> ｜ 还有 <b>${h.tradingDaysLeft}</b> 个交易日</div>
    </div>`);
  }

  for (const h of opp.nearBuy || []) {
    items.push(`<div class="opp-item opp-near-buy" data-code="${esc(h.code)}">
      <span class="opp-badge green-light">🟢 接近买入</span>
      <div class="opp-txt"><b>${esc(h.name)}</b> 现价 ¥${fmtPrice(h.currentPrice, h.type)} ｜ 距离买入目标仅 <b>${h.distBuyPct}%</b></div>
    </div>`);
  }

  for (const h of opp.nearSell || []) {
    items.push(`<div class="opp-item opp-near-sell" data-code="${esc(h.code)}">
      <span class="opp-badge yellow">🟡 接近卖出</span>
      <div class="opp-txt"><b>${esc(h.name)}</b> 现价 ¥${fmtPrice(h.currentPrice, h.type)} ｜ 距离卖出目标仅 <b>${h.distSellPct}%</b></div>
    </div>`);
  }

  if (!items.length) {
    box.hidden = true;
    list.innerHTML = '';
    return;
  }
  box.hidden = false;
  list.innerHTML = items.join('');
  list.querySelectorAll('.opp-item').forEach((el) => {
    el.addEventListener('click', () => {
      const h = state.portfolio.holdings.find((x) => x.code === el.dataset.code);
      if (h) openHoldingDetail(h);
    });
  });
}

function renderHoldingsList() {
  const container = $('#holdingsList');
  const empty = $('#holdingsEmpty');
  let holdings = state.portfolio.holdings || [];
  $('#holdingsCount').textContent = holdings.length;

  if (!holdings.length) {
    container.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  // 排序
  const sort = state.holdingSort;
  holdings = holdings.slice().sort((a, b) => {
    if (sort === 'pnlPct') return (b.floatingPnLPct || 0) - (a.floatingPnLPct || 0);
    if (sort === 'pnlAmount') return (b.floatingPnL || 0) - (a.floatingPnL || 0);
    if (sort === 'marketValue') return (b.marketValue || 0) - (a.marketValue || 0);
    return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
  });

  container.innerHTML = holdings
    .map((h) => {
      const pnl = h.floatingPnL || 0;
      const pnlPct = h.floatingPnLPct || 0;
      const pnlCls = pnl > 0 ? 'text-up' : pnl < 0 ? 'text-down' : 'flat';

      let badges = ['<span class="chip chip-holding">🟢 持有</span>'];
      if (h.hasWatch) badges.push('<span class="chip chip-on">已关联监控</span>');
      if (h.reachSell) badges.push('<span class="chip chip-sell">🏁 已达卖出价</span>');
      if (h.reachBuy) badges.push('<span class="chip chip-buy">🔔 已达买入价</span>');
      if (h.tradingDaysLeft != null && h.tradingDaysLeft >= 0 && h.tradingDaysLeft <= 20) {
        badges.push('<span class="chip chip-done">💰 即将分红</span>');
      }

      // 达到卖出价理论利润
      let sellProfitRow = '';
      if (h.sellPrice != null && h.expectedProfitAtSell != null) {
        sellProfitRow = `<div class="h-theory-row">
          <span>🎯 目标卖出 ¥${fmtPrice(h.sellPrice, h.type)} ｜ 预计理论利润 <b class="text-up">+¥${h.expectedProfitAtSell} (${fmtPct(h.expectedReturnAtSell)})</b></span>
        </div>`;
      }

      // 预计现金分红行
      let divRow = '';
      if (h.expectedDividend != null && h.expectedDividend > 0) {
        divRow = `<div class="h-div-row">
          <span>💰 预计现金分红 <b class="text-purple">¥${h.expectedDividend}</b> (成本股息率 ${h.costDividendYield || '—'}%)</span>
          ${h.tradingDaysLeft != null ? `<span class="div-cd">${h.isDividendToday ? '🔴 今日登记' : `还有 ${h.tradingDaysLeft} 交易日`}</span>` : ''}
        </div>`;
      }

      return `
        <div class="card holding-card" data-id="${esc(h._id)}">
          <div class="card-top">
            <div>
              <div class="card-name"><span class="nm">${esc(h.name)}</span>${badges.join('')}</div>
              <div class="card-code">${esc(h.code)} · ${h.type === 'etf' ? 'ETF' : '股票'} ｜ ${esc(h.accountName || '默认账户')}</div>
            </div>
            <div class="h-top-right">
              <span class="card-price">${h.currentPrice ? `¥${fmtPrice(h.currentPrice, h.type)}` : '暂无行情'}</span>
              <span class="card-change ${h.changePercent > 0 ? 'up' : h.changePercent < 0 ? 'down' : 'flat'}">${fmtPct(h.changePercent) || ''}</span>
            </div>
          </div>

          <div class="h-data-grid">
            <div class="hdg-item"><span>持仓数量</span><b>${h.quantity} 股</b></div>
            <div class="hdg-item"><span>持仓成本</span><b>¥${fmtPrice(h.costPrice, h.type)}</b></div>
            <div class="hdg-item"><span>持仓市值</span><b>${h.marketValue ? fmtMoney(h.marketValue) : '—'}</b></div>
            <div class="hdg-item"><span>浮动盈亏</span><b class="${pnlCls}">${fmtSignedMoney(pnl)} (${fmtPct(pnlPct)})</b></div>
          </div>

          ${sellProfitRow}
          ${divRow}
        </div>`;
    })
    .join('');

  container.querySelectorAll('.holding-card').forEach((el) => {
    el.addEventListener('click', () => {
      const h = state.portfolio.holdings.find((x) => x._id === el.dataset.id);
      if (h) openHoldingDetail(h);
    });
  });
}

/* ---------------- 持仓详情页（包含模拟器） ---------------- */
function findDetailHolding() {
  return state.portfolio.holdings.find((h) => h._id === state.detailHoldingId) || null;
}

function openHoldingDetail(holding) {
  state.detailHoldingId = holding._id;
  switchView('holdingDetail');
  renderHoldingDetail();
}

function renderHoldingDetail() {
  const h = findDetailHolding();
  if (!h) return;

  $('#hdName').textContent = h.name;
  $('#hdSub').textContent = `${h.code} · ${h.type === 'etf' ? 'ETF' : '股票'} ｜ ${h.accountName || '默认账户'}`;
  
  const chip = $('#hdChip');
  chip.textContent = '🟢 持仓中';
  chip.className = 'chip chip-holding';

  const priceStr = fmtPrice(h.currentPrice, h.type);
  $('#hdPrice').textContent = priceStr ? `¥${priceStr}` : '暂无行情';
  const pct = fmtPct(h.changePercent);
  $('#hdChange').textContent = pct ? `${h.changePercent > 0 ? '↑' : h.changePercent < 0 ? '↓' : ''} ${pct}` : '';
  $('#hdChange').className = h.changePercent == null ? 'flat' : h.changePercent > 0 ? 'up' : h.changePercent < 0 ? 'down' : 'flat';

  $('#hdQuantity').textContent = `${h.quantity} 股`;
  $('#hdCostPrice').textContent = `¥${fmtPrice(h.costPrice, h.type)}`;
  $('#hdCostAmount').textContent = fmtMoney(h.costAmount || 0);
  $('#hdMarketValue').textContent = h.marketValue ? fmtMoney(h.marketValue) : '—';
  
  const pnl = h.floatingPnL || 0;
  const pnlPct = h.floatingPnLPct || 0;
  $('#hdFloatingPnL').textContent = fmtSignedMoney(pnl);
  $('#hdFloatingPnL').className = pnl > 0 ? 'text-up' : pnl < 0 ? 'text-down' : 'flat';
  $('#hdFloatingPct').textContent = fmtPct(pnlPct);
  $('#hdFloatingPct').className = pnlPct > 0 ? 'text-up' : pnlPct < 0 ? 'text-down' : 'flat';

  // 理论回本价格 (盈亏平衡点)
  const bkPriceEl = $('#hdBreakevenPrice');
  if (h.breakevenPrice) {
    bkPriceEl.textContent = `¥${fmtPrice(h.breakevenPrice, h.type)}`;
  } else {
    bkPriceEl.textContent = `¥${fmtPrice(h.costPrice, h.type)} (未计费用)`;
  }

  // 9档情景盈亏测算表
  const sBody = $('#hdScenarioBody');
  if (Array.isArray(h.scenarios) && h.scenarios.length) {
    sBody.innerHTML = h.scenarios
      .map((sc) => {
        const isCurrent = sc.percent === 0;
        const pnlCls = sc.floatingPnL > 0 ? 'text-up' : sc.floatingPnL < 0 ? 'text-down' : 'flat';
        return `<tr class="${isCurrent ? 'current-row' : ''}">
          <td>${sc.percent > 0 ? '+' : ''}${sc.percent}%${isCurrent ? ' (当前)' : ''}</td>
          <td>¥${fmtPrice(sc.price, h.type)}</td>
          <td>${fmtMoney(sc.marketValue || 0)}</td>
          <td class="${pnlCls}">${fmtSignedMoney(sc.floatingPnL || 0)}</td>
          <td class="${pnlCls}">${fmtPct(sc.floatingPnLPct || 0)}</td>
        </tr>`;
      })
      .join('');
  }

  // 风险体检卡
  renderCheckupCard(h);

  // 市场大盘对比
  renderMarketCompare(h);

  // 投资计划 & 计划 vs 实际
  renderPlanAndPvs(h);

  // 投资日记
  loadAndRenderNotes(h.code);

  // 🎯 目标价格精确触达历史
  loadAndRenderTouches(h.code, 'hd');

  // 监控关联与理论收益
  const watchBadge = $('#hdWatchStatus');
  watchBadge.textContent = h.hasWatch ? '已关联监控' : '未开启监控';
  watchBadge.className = `sec-badge ${h.hasWatch ? 'green' : 'gray'}`;

  $('#hdDistRow').innerHTML = distCardHtml(h, 'buy') + distCardHtml(h, 'sell');

  // 理论卖出测算卡
  const theoryCard = $('#hdTheoryCard');
  if (h.sellPrice != null) {
    const totalSell = round(h.quantity * h.sellPrice, 2);
    $('#tpSellAmount').textContent = fmtMoney(totalSell);
    $('#tpProfitVal').textContent = fmtSignedMoney(h.expectedProfitAtSell || 0);
    $('#tpReturnPct').textContent = fmtPct(h.expectedReturnAtSell || 0);
    theoryCard.hidden = false;
  } else {
    theoryCard.hidden = true;
  }

  // 分红联动
  const divSec = $('#hdDividendSection');
  if (h.latestDividend && h.latestDividend.dividendPerShare > 0) {
    divSec.hidden = false;
    const isEtf = h.type === 'etf';
    const hdDivTitle = divSec.querySelector('h3');
    if (hdDivTitle) hdDivTitle.textContent = isEtf ? '💰 ETF 收益分配' : '💰 分红雷达';
    $('#hdExpDividend').textContent = h.expectedDividend ? fmtMoney(h.expectedDividend) : '—';
    $('#hdCostYield').textContent = h.costDividendYield ? `${h.costDividendYield}%` : '—';
    $('#hdCurYield').textContent = h.currentDividendYield ? `${h.currentDividendYield}%` : '—';
    const unit = isEtf ? '/份' : '/股';
    const dec = isEtf ? 3 : 2;
    $('#hdPerShare').textContent = `¥${h.latestDividend.dividendPerShare.toFixed(dec)}${unit}`;
    $('#hdRecordDate').textContent = h.latestDividend.recordDate || '—';
    $('#hdPayDate').textContent = h.latestDividend.paymentDate || '—';
    $('#hdDivCd').textContent = h.isDividendToday ? '🔴 今日登记' : h.tradingDaysLeft != null ? `还有 ${h.tradingDaysLeft} 交易日` : '';
  } else {
    divSec.hidden = true;
  }

  // 初始化模拟器默认值
  $('#simBuyPrice').value = h.buyPrice || (h.currentPrice ? (h.currentPrice * 0.9).toFixed(2) : '18.00');
  $('#simBuyAmount').value = h.plannedAmount || '10000';
  calcSimBuy();

  $('#simSellPrice').value = h.sellPrice || (h.currentPrice ? (h.currentPrice * 1.3).toFixed(2) : '28.00');
  $('#simSellShares').value = h.quantity.toString();
  calcSimSell();
}

/* ---------------- V4: 风险体检卡 ---------------- */
function renderCheckupCard(h) {
  const p = state.perf[h.thsCode || h.code] || {};
  const div = state.dividends[h.thsCode || h.code] || {};

  // 1. 波动程度（根据 20 日数据）
  const s20 = p.stats20d || {};
  const maxUp = Math.abs(s20.maxUp || 0);
  const maxDown = Math.abs(s20.maxDown || 0);
  const volScore = Math.max(maxUp, maxDown);
  const volEl = $('#ckVol');
  if (volScore > 6) {
    volEl.textContent = '较高 🔴';
    volEl.className = 'ck-val high';
  } else if (volScore > 3) {
    volEl.textContent = '中等 🟡';
    volEl.className = 'ck-val warn';
  } else {
    volEl.textContent = '较低 🟢';
    volEl.className = 'ck-val good';
  }

  // 2. 年内回撤
  const ddEl = $('#ckDd');
  if (p.yearHigh && h.currentPrice) {
    const dd = ((h.currentPrice - p.yearHigh) / p.yearHigh) * 100;
    if (dd < -20) {
      ddEl.textContent = `${dd.toFixed(1)}% 🔴`;
      ddEl.className = 'ck-val high';
    } else if (dd < -10) {
      ddEl.textContent = `${dd.toFixed(1)}% 🟡`;
      ddEl.className = 'ck-val warn';
    } else {
      ddEl.textContent = `${dd.toFixed(1)}% 🟢`;
      ddEl.className = 'ck-val good';
    }
  } else {
    ddEl.textContent = '—';
    ddEl.className = 'ck-val';
  }

  // 3. 持仓集中度
  const concEl = $('#ckConc');
  const wAsset = h.weightInTotalAsset || 0;
  if (wAsset >= 30) {
    concEl.textContent = `${wAsset}% ⚠️`;
    concEl.className = 'ck-val warn';
  } else if (wAsset >= 15) {
    concEl.textContent = `${wAsset}% 🟡`;
    concEl.className = 'ck-val warn';
  } else {
    concEl.textContent = `${wAsset}% 🟢`;
    concEl.className = 'ck-val good';
  }

  // 4. 分红稳定性
  const divEl = $('#ckDiv');
  const consec = div.stats ? div.stats.consecutiveYears || 0 : 0;
  if (consec >= 3) {
    divEl.textContent = `连续${consec}年 🟢`;
    divEl.className = 'ck-val good';
  } else if (div.hasDividend) {
    divEl.textContent = '近期分红 🟡';
    divEl.className = 'ck-val warn';
  } else {
    divEl.textContent = '暂无分红 ⚪';
    divEl.className = 'ck-val';
  }

  // 5. 大盘表现（相对沪深300）
  const mktEl = $('#ckMarket');
  const hs = state.marketOverview && state.marketOverview.hs300 ? state.marketOverview.hs300.changePercent : 0;
  const targetChg = h.changePercent || 0;
  if (targetChg - hs > 1.0) {
    mktEl.textContent = '跑赢大盘 🟢';
    mktEl.className = 'ck-val good';
  } else if (targetChg - hs < -1.0) {
    mktEl.textContent = '弱于大盘 🔴';
    mktEl.className = 'ck-val high';
  } else {
    mktEl.textContent = '与大盘持平 🟡';
    mktEl.className = 'ck-val warn';
  }

  // 6. 异常波动
  const anoEl = $('#ckAnomaly');
  if (Math.abs(targetChg) >= 5.0) {
    anoEl.textContent = '波动放大 ⚠️';
    anoEl.className = 'ck-val warn';
  } else {
    anoEl.textContent = '正常 🟢';
    anoEl.className = 'ck-val good';
  }
}

/* ---------------- V4: 市场大盘对比 ---------------- */
async function loadMarketOverview() {
  try {
    const res = await call('ths-get-market-overview');
    if (res && res.ok) {
      state.marketOverview = res;
    }
  } catch (_) {}
}

function renderMarketCompare(h) {
  const p = state.perf[h.thsCode || h.code] || {};
  const mo = state.marketOverview || {};
  const hs = mo.hs300 || {};
  const sh = mo.sh || {};

  $('#mcTargetName').textContent = h.name || h.code;
  $('#mcTargetToday').textContent = h.changePercent != null ? fmtPct(h.changePercent) : '—';
  $('#mcTargetR5d').textContent = p.r5d != null ? fmtPct(p.r5d) : '—';
  $('#mcTargetR20d').textContent = p.r20d != null ? fmtPct(p.r20d) : '—';
  $('#mcTargetYtd').textContent = p.y2026 != null ? fmtPct(p.y2026) : '—';

  $('#mcHs300Today').textContent = hs.changePercent != null ? fmtPct(hs.changePercent) : '—';
  $('#mcHs300R5d').textContent = '—';
  $('#mcHs300R20d').textContent = '—';
  $('#mcHs300Ytd').textContent = '—';

  $('#mcShToday').textContent = sh.changePercent != null ? fmtPct(sh.changePercent) : '—';
  $('#mcShR5d').textContent = '—';
  $('#mcShR20d').textContent = '—';
  $('#mcShYtd').textContent = '—';
}

/* ---------------- V4: 投资计划与复盘 ---------------- */
async function loadAndRenderPlan(code) {
  try {
    const res = await call('ths-get-plans', { code });
    if (res && res.ok && res.plan) {
      state.plans[code] = res.plan;
      const h = findDetailHolding();
      if (h && h.code === code) renderPlanAndPvs(h);
    }
  } catch (_) {}
}

function renderPlanAndPvs(h) {
  const plan = state.plans[h.code] || {};
  const targetQty = plan.targetQuantity || h.targetQuantity || (h.quantity * 2);
  const planProg = targetQty > 0 ? round((h.quantity / targetQty) * 100, 1) : 100;
  const plannedAmt = plan.plannedAmount || h.plannedAmount;

  const reasons = (plan.reasons && plan.reasons.length ? plan.reasons.join('、') : '') + (plan.customReason ? ` (${plan.customReason})` : '');
  $('#hdPlanReasons').textContent = reasons || '长期关注';
  $('#hdPlanTargetQty').textContent = `${targetQty} 股 (还差 ${Math.max(0, targetQty - h.quantity)} 股)`;
  $('#hdPlanProgress').textContent = `${planProg}%`;
  $('#hdPlanAmount').textContent = plannedAmt ? fmtMoney(plannedAmt) : '未设置';

  // 计划 vs 实际
  const planBuy = plan.planBuyPrice || h.buyPrice;
  $('#pvsPlanBuy').textContent = planBuy ? `¥${fmtPrice(planBuy, h.type)}` : '未设买入价';
  $('#pvsActualCost').textContent = `¥${fmtPrice(h.costPrice, h.type)}`;

  const pvsDevEl = $('#pvsDeviation');
  if (planBuy && h.costPrice) {
    const dev = ((h.costPrice - planBuy) / planBuy) * 100;
    pvsDevEl.textContent = `${dev > 0 ? '+' : ''}${dev.toFixed(2)}% (${dev > 0 ? '高于计划' : '低于计划'})`;
    pvsDevEl.className = dev > 0 ? 'text-sell' : 'text-buy';
  } else {
    pvsDevEl.textContent = '—';
    pvsDevEl.className = '';
  }

  // 多档买入与卖出
  const buyBox = $('#hdBuyLevelsBox');
  const buyList = $('#hdBuyLevelsList');
  if (Array.isArray(plan.buyLevels) && plan.buyLevels.length) {
    buyBox.hidden = false;
    buyList.innerHTML = plan.buyLevels.map((l, i) => `<div class="lv-row"><span>第 ${i + 1} 档：¥${l.price}</span><b>投入 ¥${l.amount}</b></div>`).join('');
  } else {
    buyBox.hidden = true;
  }

  const sellBox = $('#hdSellLevelsBox');
  const sellList = $('#hdSellLevelsList');
  if (Array.isArray(plan.sellLevels) && plan.sellLevels.length) {
    sellBox.hidden = false;
    sellList.innerHTML = plan.sellLevels.map((l, i) => `<div class="lv-row"><span>第 ${i + 1} 档：¥${l.price}</span><b>卖出 ${l.percent}%</b></div>`).join('');
  } else {
    sellBox.hidden = true;
  }
}

/* ---------------- V4: 投资日记 ---------------- */
async function loadAndRenderNotes(code) {
  const listEl = $('#hdNotesList');
  const emptyEl = $('#hdNotesEmpty');
  listEl.innerHTML = '<p class="notes-empty">加载日记中…</p>';
  try {
    const res = await call('ths-get-notes', { code });
    const notes = (res && res.ok && res.items) || [];
    state.notes[code] = notes;
    if (!notes.length) {
      listEl.innerHTML = '';
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;
    listEl.innerHTML = notes
      .map(
        (n) => `<div class="note-card">
        <div class="nc-head">
          <span class="nc-date">${esc(n.date || '')}</span>
          <span class="nc-price">${n.price ? `¥${n.price}` : ''}</span>
        </div>
        <div class="nc-content">${esc(n.content || '')}</div>
      </div>`
      )
      .join('');
  } catch (e) {
    listEl.innerHTML = '';
    emptyEl.hidden = false;
    emptyEl.textContent = `日记加载失败: ${e.message}`;
  }
}

/* ---------------- 🎯 目标价格精确触达历史与快照 ---------------- */
state.touchFilter = { alertType: 'all', timeRange: 'all' };
state.touches = {};

async function loadAndRenderTouches(code, prefix = 'hd') {
  const listEl = $(`#${prefix}TouchList`);
  const emptyEl = $(`#${prefix}TouchEmpty`);
  const statBadge = $(`#${prefix}TouchStatBadge`);
  const highlightCard = $(`#${prefix}TouchHighlight`);

  if (!listEl) return;
  listEl.innerHTML = '<p class="touch-empty">加载触达历史中…</p>';

  try {
    const filter = state.touchFilter;
    const res = await call('ths-get-price-touches', {
      code,
      alertType: filter.alertType,
      timeRange: filter.timeRange,
    });

    if (!res || !res.ok) throw new Error((res && res.error) || '加载失败');
    const items = res.items || [];
    const stats = res.stats || {};
    state.touches[code] = items;

    // 1. 统计看板
    if (statBadge) statBadge.textContent = `触达 ${stats.totalTouches || 0} 次`;
    const tsbTotal = $(`#${prefix === 'hd' ? 'hd' : 'dt'}TouchStatsBar #tsbTotal`) || $(`#${prefix}TsbTotal`);
    const tsbSell = $(`#${prefix === 'hd' ? 'hd' : 'dt'}TouchStatsBar #tsbSell`) || $(`#${prefix}TsbSell`);
    const tsbBuy = $(`#${prefix === 'hd' ? 'hd' : 'dt'}TouchStatsBar #tsbBuy`) || $(`#${prefix}TsbBuy`);
    const tsb30d = $(`#${prefix === 'hd' ? 'hd' : 'dt'}TouchStatsBar #tsb30d`) || $(`#${prefix}Tsb30d`);

    if (tsbTotal) tsbTotal.textContent = stats.totalTouches || 0;
    if (tsbSell) tsbSell.textContent = stats.sellTouches || 0;
    if (tsbBuy) tsbBuy.textContent = stats.buyTouches || 0;
    if (tsb30d) tsb30d.textContent = `${stats.last30dCount || 0} 次`;

    // 2. 最近一次触达高光卡片
    const latest = stats.latestTouch;
    if (latest && highlightCard) {
      highlightCard.hidden = false;
      const isBuy = latest.alertType === 'buy';
      const thBadge = $(`#${prefix === 'hd' ? 'thBadge' : 'dtThBadge'}`);
      const thStatus = $(`#${prefix === 'hd' ? 'thStatusChip' : 'dtThStatusChip'}`);
      const thTargetP = $(`#${prefix === 'hd' ? 'thTargetPrice' : 'dtThTargetPrice'}`);
      const thTriggerP = $(`#${prefix === 'hd' ? 'thTriggerPrice' : 'dtThTriggerPrice'}`);
      const thDetectedAt = $(`#${prefix === 'hd' ? 'thDetectedAt' : 'dtThDetectedAt'}`);
      const thMarketTime = $(`#${prefix === 'hd' ? 'thMarketTime' : 'dtThMarketTime'}`);
      const thCurPrice = $(`#${prefix === 'hd' ? 'thCurPrice' : 'dtThCurPrice'}`);
      const thPostReturn = $(`#${prefix === 'hd' ? 'thPostReturn' : 'dtThPostReturn'}`);
      const thProfitTxt = $(`#${prefix === 'hd' ? 'thProfitTxt' : 'dtThProfitTxt'}`);

      if (thBadge) {
        thBadge.textContent = isBuy ? '🟢 买入目标已触达' : '🔴 卖出目标已触达';
        thBadge.className = `th-badge ${isBuy ? 'text-buy' : 'text-sell'}`;
      }
      if (thStatus) {
        const isRet = latest.status === 'RETURNED';
        thStatus.textContent = isRet ? '已回落/回升' : '仍处于目标区';
        thStatus.className = `th-status-chip ${isRet ? 'returned' : 'active'}`;
      }
      if (thTargetP) thTargetP.textContent = `¥${fmtPrice(latest.targetPrice, latest.type)}`;
      if (thTriggerP) thTriggerP.textContent = `¥${fmtPrice(latest.triggerPrice, latest.type)}`;
      if (thDetectedAt) thDetectedAt.textContent = fmtFullDateTime(latest.detectedAt || latest.triggeredAt);
      if (thMarketTime) thMarketTime.textContent = fmtFullDateTime(latest.marketDataTime);
      if (thCurPrice) thCurPrice.textContent = latest.currentPriceNow ? `¥${fmtPrice(latest.currentPriceNow, latest.type)}` : '—';
      if (thPostReturn && latest.postTouchReturnPct != null) {
        const ret = latest.postTouchReturnPct;
        thPostReturn.textContent = `${ret > 0 ? '+' : ''}${ret.toFixed(2)}%`;
        thPostReturn.className = `th-post-ret ${ret > 0 ? 'text-up' : ret < 0 ? 'text-down' : 'flat'}`;
      }
      if (thProfitTxt) {
        if (latest.theoreticalProfit != null) {
          thProfitTxt.hidden = false;
          thProfitTxt.innerHTML = `持仓触达理论利润 <b class="${latest.theoreticalProfit > 0 ? 'text-up' : 'text-down'}">${fmtSignedMoney(latest.theoreticalProfit)}</b>`;
        } else {
          thProfitTxt.hidden = true;
        }
      }
    } else if (highlightCard) {
      highlightCard.hidden = true;
    }

    // 3. 历史记录列表
    if (!items.length) {
      listEl.innerHTML = '';
      if (emptyEl) emptyEl.hidden = false;
      return;
    }
    if (emptyEl) emptyEl.hidden = true;

    listEl.innerHTML = items
      .map((t) => {
        const isBuy = t.alertType === 'buy';
        const postPnl = t.postTouchReturnPct != null ? `${t.postTouchReturnPct > 0 ? '+' : ''}${t.postTouchReturnPct.toFixed(2)}%` : '—';
        const postCls = t.postTouchReturnPct > 0 ? 'text-up' : t.postTouchReturnPct < 0 ? 'text-down' : 'flat';
        return `<div class="touch-card">
          <div class="tc-head">
            <span class="tc-type ${isBuy ? 'buy' : 'sell'}">${isBuy ? '🟢 买入触达' : '🔴 卖出触达'}</span>
            <span class="tc-time">${fmtFullDateTime(t.triggeredAt)}</span>
          </div>
          <div class="tc-grid">
            <div><span>目标价</span> <b>¥${fmtPrice(t.targetPrice, t.type)}</b></div>
            <div><span>触达检测</span> <b>¥${fmtPrice(t.triggerPrice, t.type)}</b></div>
            <div><span>触达后变动</span> <b class="${postCls}">${postPnl}</b></div>
          </div>
          <div class="tc-foot">
            <span>行情时间 ${fmtTime(t.marketDataTime, false)} ｜ 状态 ${t.status === 'RETURNED' ? '已离开目标区' : '活跃'}</span>
            ${t.status !== 'CLOSED' ? `<button class="link-btn-sm" data-ack-touch="${esc(t._id)}">标记已看</button>` : '<span>已查看</span>'}
          </div>
        </div>`;
      })
      .join('');

    listEl.querySelectorAll('[data-ack-touch]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await call('ths-ack-price-touch', { id: btn.dataset.ackTouch });
        btn.parentElement.innerHTML = '<span>已查看</span>';
        toast('已标记为已查看 ✅');
      });
    });
  } catch (e) {
    listEl.innerHTML = '';
    if (emptyEl) {
      emptyEl.hidden = false;
      emptyEl.textContent = `触达历史加载失败: ${e.message}`;
    }
  }
}

function calcSimBuy() {
  const h = findDetailHolding();
  if (!h) return;
  const p = parseFloat($('#simBuyPrice').value);
  const a = parseFloat($('#simBuyAmount').value);
  if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(a) || a <= 0) return;

  const addShares = Math.floor(a / p);
  const totalShares = h.quantity + addShares;
  const addCost = round(addShares * p, 2);
  const totalCost = round(h.costAmount + addCost, 2);
  const newCostPrice = totalShares > 0 ? round(totalCost / totalShares, 2) : 0;

  $('#sbrAddShares').textContent = `${addShares} 股`;
  $('#sbrTotalShares').textContent = `${totalShares} 股`;
  $('#sbrTotalCost').textContent = fmtMoney(totalCost);
  $('#sbrNewCost').textContent = `¥${newCostPrice.toFixed(2)}/股 (降 ¥${(h.costPrice - newCostPrice).toFixed(2)})`;
}

function calcSimSell() {
  const h = findDetailHolding();
  if (!h) return;
  const p = parseFloat($('#simSellPrice').value);
  const qty = parseInt($('#simSellShares').value, 10);
  if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(qty) || qty <= 0) return;

  const totalAmount = round(qty * p, 2);
  const costAmount = round(qty * h.costPrice, 2);
  const profit = round(totalAmount - costAmount, 2);
  const returnPct = costAmount > 0 ? round((profit / costAmount) * 100, 2) : 0;

  $('#ssrTotalAmount').textContent = fmtMoney(totalAmount);
  $('#ssrCostAmount').textContent = fmtMoney(costAmount);
  $('#ssrProfitVal').textContent = fmtSignedMoney(profit);
  $('#ssrReturnPct').textContent = fmtPct(returnPct);
}

function bindHoldingDetailEvents() {
  $('#holdingDetailBack').addEventListener('click', () => switchView('portfolio'));
  $('#hdGoWatch').addEventListener('click', () => {
    const h = findDetailHolding();
    if (!h) return;
    const w = state.watches.find((x) => x.code === h.code);
    if (w) openDetail(w);
    else toast('未找到对应监控标的');
  });
  $('#hdEdit').addEventListener('click', () => {
    const h = findDetailHolding();
    if (h) openHoldingForm(h);
  });
  $('#hdDelete').addEventListener('click', () => {
    const h = findDetailHolding();
    if (h) askDeleteHolding(h);
  });

  $('#simBuyPrice').addEventListener('input', calcSimBuy);
  $('#simBuyAmount').addEventListener('input', calcSimBuy);
  $('#simSellPrice').addEventListener('input', calcSimSell);
  $('#simSellShares').addEventListener('input', calcSimSell);

  document.querySelectorAll('#simQuickPrices button').forEach((btn) => {
    btn.addEventListener('click', () => {
      $('#simSellPrice').value = btn.dataset.p;
      calcSimSell();
    });
  });
}

/* ---------------- 分红日历视图 ---------------- */
async function loadDividendsView() {
  renderDividendsView();
  try {
    const r = await call('ths-get-dividends', { mode: 'calendar' });
    if (r && r.ok && Array.isArray(r.events)) {
      state.dividendEvents = r.events;
      renderDividendsView();
    }
  } catch (e) {
    toast(`加载分红日历失败：${e.message}`);
  }
}

function renderDividendsView() {
  const container = $('#dividendList');
  const empty = $('#dividendEmpty');
  let events = state.dividendEvents || [];
  const filter = state.divFilter;

  if (filter === 'upcoming') {
    events = events.filter((e) => e.tradingDaysLeft != null && e.tradingDaysLeft >= 0);
  } else if (filter === 'thismonth') {
    const thisMonth = fmtDate(Date.now()).slice(0, 7);
    events = events.filter((e) => (e.recordDate && e.recordDate.startsWith(thisMonth)) || (e.exDividendDate && e.exDividendDate.startsWith(thisMonth)));
  } else if (filter === 'passed') {
    events = events.filter((e) => e.isPassed || (e.tradingDaysLeft != null && e.tradingDaysLeft < 0));
  } else if (filter === 'history') {
    events = events.filter((e) => e.fiscalYear && e.fiscalYear < 2026);
  }

  if (!events.length) {
    container.innerHTML = '';
    empty.hidden = false;
    const et = empty.querySelector('.empty-title');
    const es = empty.querySelector('.empty-sub');
    if (filter === 'upcoming') {
      if (et) et.textContent = '暂无即将登记的分红';
      if (es) es.textContent = '近期暂无已公布且在登记日前夕的股票或 ETF 分红方案';
    } else if (filter === 'thismonth') {
      if (et) et.textContent = '本月暂无分红事件';
      if (es) es.textContent = '本月没有安排股权登记或除权除息的标的';
    } else if (filter === 'passed') {
      if (et) et.textContent = '暂无已除息事件';
      if (es) es.textContent = '已完成除权除息的分红记录会归档在此';
    } else if (filter === 'history') {
      if (et) et.textContent = '暂无历史年度分红';
      if (es) es.textContent = '往年历史年度分红明细会在此展示';
    } else {
      if (et) et.textContent = '暂无分红事件';
      if (es) es.textContent = '已公布分红方案的股票 / ETF 会在此汇总';
    }
    return;
  }
  empty.hidden = true;

  container.innerHTML = events
    .map((e) => {
      const cd = e.isToday
        ? '<span class="tag-badge red">🔴 今日为股权登记日</span>'
        : e.isPassed
        ? '<span class="tag-badge gray">⚪ 已除息</span>'
        : e.tradingDaysLeft != null
        ? `<span class="tag-badge ${e.tradingDaysLeft <= 3 ? 'orange' : e.tradingDaysLeft <= 10 ? 'yellow' : 'blue'}">还有 ${e.tradingDaysLeft} 个交易日</span>`
        : '';

      const yieldInfo = e.dividendYield != null ? `当前股息率 <b>${e.dividendYield.toFixed(2)}%</b>` : '';
      const buyYieldInfo = e.buyDividendYield != null ? ` ｜ 按买入价 <b>${e.buyDividendYield.toFixed(2)}%</b>` : '';
      const isEtf = e.type === 'etf';
      const labelUnit = isEtf ? '每份分红' : '每股分红';
      const unitText = isEtf ? '/份' : '/股';

      return `
        <div class="card div-event-card" data-id="${esc(e.watchId)}">
          <div class="card-top">
            <div>
              <div class="card-name"><span class="nm">${esc(e.name)}</span><span class="card-code">${esc(e.code)} · ${isEtf ? 'ETF' : '股票'}</span></div>
            </div>
            ${cd}
          </div>
          <div class="div-event-body">
            <div class="div-ev-main">
              <span class="lab">${labelUnit}</span>
              <b class="val">¥${e.dividendPerShare != null ? e.dividendPerShare.toFixed(3) : '—'}${unitText}</b>
            </div>
            <div class="div-ev-yields">${yieldInfo}${buyYieldInfo}</div>
          </div>
          <div class="div-ev-dates">
            <div class="ed-item"><span>股权登记日</span><b>${esc(e.recordDate || '—')}</b></div>
            <div class="ed-item"><span>除息日</span><b>${esc(e.exDividendDate || '—')}</b></div>
            <div class="ed-item"><span>红利发放日</span><b>${esc(e.paymentDate || '—')}</b></div>
          </div>
        </div>`;
    })
    .join('');

  container.querySelectorAll('.div-event-card').forEach((el) => {
    el.addEventListener('click', () => {
      const w = state.watches.find((x) => x._id === el.dataset.id);
      if (w) openDetail(w);
    });
  });
}

/* ---------------- 标的详情页 ---------------- */
const detailCache = {};
const detailDivCache = {};

function findDetailWatch() {
  return state.watches.find((w) => w._id === state.detailId) || null;
}

function openDetail(watch) {
  state.detailId = watch._id;
  state.histRange = '1m';
  state.histPeriod = 'day';
  document.querySelectorAll('#histRange button').forEach((x) => x.classList.toggle('on', x.dataset.range === '1m'));
  document.querySelectorAll('#histPeriod button').forEach((x) => x.classList.toggle('on', x.dataset.period === 'day'));
  $('#histCustom').hidden = true;
  switchView('detail');
  renderDetail();
  renderHistContent();
  loadDetailDividendData();
}

function renderDetail() {
  const w = findDetailWatch();
  if (!w) return;
  $('#detailName').textContent = w.name;
  $('#detailSub').textContent = `${w.code} · ${w.type === 'etf' ? 'ETF' : '股票'}`;

  const live = typeof w.currentPrice === 'number';
  const inBuy = live && w.buyPrice != null && w.currentPrice <= w.buyPrice;
  const inSell = live && w.sellPrice != null && w.currentPrice >= w.sellPrice;

  const chip = $('#detailChip');
  if (w.enabled && inBuy) { chip.textContent = '🔔 已达到买入价'; chip.className = 'chip chip-buy'; }
  else if (w.enabled && inSell) { chip.textContent = '🔔 已达到卖出价'; chip.className = 'chip chip-sell'; }
  else if (!w.enabled) { chip.textContent = '已暂停'; chip.className = 'chip chip-off'; }
  else { chip.textContent = '监控中'; chip.className = 'chip chip-on'; }

  const priceStr = fmtPrice(w.currentPrice, w.type);
  const priceEl = $('#detailPrice');
  priceEl.textContent = priceStr == null ? '暂无行情' : `¥${priceStr}`;
  priceEl.classList.toggle('na', !live);

  const pct = fmtPct(w.changePercent);
  const chg = $('#detailChange');
  chg.textContent = pct ? `${w.changePercent > 0 ? '↑' : w.changePercent < 0 ? '↓' : ''} ${pct}` : '';
  chg.className = w.changePercent == null ? 'flat' : w.changePercent > 0 ? 'up' : w.changePercent < 0 ? 'down' : 'flat';

  const banner = $('#detailBanner');
  if (w.enabled && inBuy) {
    banner.textContent = `🔔 现价 ¥${fmtPrice(w.currentPrice, w.type)} 已达买入价 ¥${fmtPrice(w.buyPrice, w.type)}，留意买入机会`;
    banner.className = 'detail-banner buy';
    banner.hidden = false;
  } else if (w.enabled && inSell) {
    banner.textContent = `🔔 现价 ¥${fmtPrice(w.currentPrice, w.type)} 已达卖出价 ¥${fmtPrice(w.sellPrice, w.type)}，留意卖出机会`;
    banner.className = 'detail-banner sell';
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }

  $('#distRow').innerHTML = distCardHtml(w, 'buy') + distCardHtml(w, 'sell');
  $('#metricLast').textContent = priceStr == null ? '—' : `¥${priceStr}`;
  $('#detailToggle').textContent = w.enabled ? '⏸ 暂停监控' : '▶️ 恢复监控';
  renderDetailTarget(w);
  loadAndRenderTouches(w.code, 'dt');
}

function distCardHtml(w, side) {
  const line = side === 'buy' ? w.buyPrice : w.sellPrice;
  if (line == null) return '';
  const label = side === 'buy' ? '买入价' : '卖出价';
  if (typeof w.currentPrice !== 'number') {
    return `<div class="dist-card ${side}"><div class="dist-label">${label} <b>¥${fmtPrice(line, w.type)}</b></div><div class="dist-val st-wait">待行情</div></div>`;
  }
  const hit = side === 'buy' ? w.currentPrice <= line : w.currentPrice >= line;
  if (hit) {
    return `<div class="dist-card ${side}"><div class="dist-label">${label} <b>¥${fmtPrice(line, w.type)}</b></div><div class="dist-val ok-${side}">🟢 已达到${label}</div></div>`;
  }
  const diff = Math.abs(line - w.currentPrice);
  const pct = (diff / w.currentPrice) * 100;
  const actionText = side === 'buy' ? '还需下跌' : '还需上涨';
  return `<div class="dist-card ${side}"><div class="dist-label">${label} <b>¥${fmtPrice(line, w.type)}</b></div><div class="dist-val near-${side}">${side === 'buy' ? '🟢' : '🟡'} ${actionText} ¥${fmtPrice(diff, w.type)}（${pct.toFixed(1)}%）</div></div>`;
}

function renderDetailTarget(w) {
  const box = $('#detailTarget');
  if (w.targetPrice == null || !(w.buyPrice != null || w.sellPrice != null)) {
    box.hidden = true;
    return;
  }
  const t = w.targetPrice;
  const parts = [];
  if (w.buyDiscount != null) parts.push(`买入价 = 目标 × ${pctOffset(w.buyDiscount)} → ¥${fmtPrice(w.buyPrice, w.type)}`);
  if (w.sellDiscount != null) parts.push(`卖出价 = 目标 × ${pctOffset(w.sellDiscount)} → ¥${fmtPrice(w.sellPrice, w.type)}`);
  if (!parts.length) {
    box.hidden = true;
    return;
  }
  box.innerHTML = `<p class="target-title">🎯 目标价 <b>¥${fmtPrice(t, w.type)}</b></p>
    <p class="hint">${parts.join(' ｜ ')}</p>`;
  box.hidden = false;
}

/* ---------------- 详情页分红与历史行情 ---------------- */
async function loadDetailDividendData() {
  const w = findDetailWatch();
  if (!w) return;
  const ckey = `${w.type}:${w.code}`;
  if (detailDivCache[ckey]) {
    renderDetailDividend(detailDivCache[ckey]);
    return;
  }
  try {
    const r = await call('ths-get-dividends', {
      mode: 'detail',
      type: w.type,
      code: w.code,
      currentPrice: w.currentPrice,
      buyPrice: w.buyPrice,
    });
    if (r && r.ok && r.data) {
      detailDivCache[ckey] = r.data;
      renderDetailDividend(r.data);
    }
  } catch (e) {}
}

function renderDetailDividend(data) {
  const w = findDetailWatch();
  const divSec = $('#detailDividendSection');
  if (!w || !data || !data.hasDividend || !data.items || !data.items.length) {
    if (divSec) divSec.hidden = true;
    return;
  }
  if (divSec) divSec.hidden = false;

  const isEtf = w.type === 'etf';
  const secTitle = divSec.querySelector('h3');
  if (secTitle) secTitle.textContent = isEtf ? '💰 ETF 收益分配' : '💰 分红雷达';

  const stBadge = $('#divStabilityBadge');
  const stats = data.stats || {};
  stBadge.textContent = stats.stabilityLabel || '历史记录';
  stBadge.className = `sec-badge ${stats.stability === 'stable' ? 'green' : stats.stability === 'volatile' ? 'yellow' : 'gray'}`;

  const latest = data.latest;
  const unit = isEtf ? '/份' : '/股';
  const dec = isEtf ? 3 : 2;
  $('#divPerShare').textContent = latest && latest.dividendPerShare != null ? `¥${latest.dividendPerShare.toFixed(dec)}${unit}` : '—';
  $('#divCurrentYield').textContent = data.dividendYield != null ? `${data.dividendYield.toFixed(2)}%` : '—';
  $('#divBuyYield').textContent = data.buyDividendYield != null ? `${data.buyDividendYield.toFixed(2)}%` : (w.buyPrice == null ? '未设买入价' : '—');

  $('#divRecordDate').textContent = latest && latest.recordDate ? latest.recordDate : '暂无数据';
  $('#divExDate').textContent = latest && latest.exDividendDate ? latest.exDividendDate : '暂无数据';
  $('#divPayDate').textContent = latest && latest.paymentDate ? latest.paymentDate : '暂无数据';

  const cdEl = $('#divCountdown');
  if (data.isToday) {
    cdEl.textContent = '🔴 今日为股权登记日';
    cdEl.className = 'd-countdown cd-today';
  } else if (data.isPassed) {
    cdEl.textContent = '⚪ 已除息';
    cdEl.className = 'd-countdown cd-passed';
  } else if (data.tradingDaysLeft != null) {
    cdEl.textContent = `还有 ${data.tradingDaysLeft} 个交易日`;
    cdEl.className = `d-countdown ${data.tradingDaysLeft <= 3 ? 'cd-urgent' : data.tradingDaysLeft <= 10 ? 'cd-warn' : ''}`;
  } else {
    cdEl.textContent = '';
  }

  $('#dsConsecutive').textContent = stats.consecutiveYears != null ? `${stats.consecutiveYears}年` : '—';
  $('#dsSum3y').textContent = stats.sum3y != null ? `¥${stats.sum3y.toFixed(2)}` : '—';
  $('#dsSum5y').textContent = stats.sum5y != null ? `¥${stats.sum5y.toFixed(2)}` : '—';
  $('#dsYoy').textContent = stats.yoyChange != null ? fmtPct(stats.yoyChange) : '—';

  const tbody = $('#histDivBody');
  const empty = $('#histDivEmpty');
  const items = data.items || [];
  if (!items.length) {
    tbody.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  tbody.innerHTML = items
    .map(
      (it) => `<tr>
      <td>${it.fiscalYear || '—'}</td>
      <td>¥${it.dividendPerShare != null ? it.dividendPerShare.toFixed(2) : '—'}</td>
      <td>${esc(it.recordDate || '—')}</td>
      <td>${esc(it.exDividendDate || '—')}</td>
      <td>${esc(it.paymentDate || '—')}</td>
    </tr>`
    )
    .join('');
}

async function loadDetailData() {
  const w = findDetailWatch();
  if (!w) return null;
  const ckey = `${w.type}:${w.code}:${w.currentPrice || 0}`;
  if (detailCache[ckey]) {
    renderMetrics(detailCache[ckey]);
    return detailCache[ckey];
  }
  const r = await call('ths-get-history', {
    mode: 'detail',
    type: w.type,
    code: w.code,
    currentPrice: typeof w.currentPrice === 'number' ? w.currentPrice : null,
  });
  if (!r || !r.ok) throw new Error((r && r.error) || '加载历史失败');
  detailCache[ckey] = r;
  renderMetrics(r);
  return r;
}

function renderMetrics(data) {
  const w = findDetailWatch();
  const y25 = data ? data.y2025 : null;
  const y26 = data ? data.y2026 : null;
  const m25 = $('#metricY2025');
  m25.textContent = y25 == null ? '—' : fmtPct(y25);
  m25.className = y25 == null ? 'flat' : y25 >= 0 ? 'up' : 'down';
  const m26 = $('#metricY2026');
  m26.textContent = y26 == null ? '—' : fmtPct(y26);
  m26.className = y26 == null ? 'flat' : y26 >= 0 ? 'up' : 'down';

  const high = data ? data.yearHigh : null;
  const low = data ? data.yearLow : null;
  $('#metricYearHigh').textContent = high != null ? `¥${fmtPrice(high, w ? w.type : 'stock')}` : '—';
  $('#metricYearLow').textContent = low != null ? `¥${fmtPrice(low, w ? w.type : 'stock')}` : '—';

  if (w && typeof w.currentPrice === 'number' && high) {
    const distHigh = ((w.currentPrice - high) / high) * 100;
    $('#metricDistHigh').textContent = fmtPct(distHigh);
  } else {
    $('#metricDistHigh').textContent = '—';
  }

  const s20 = data ? data.stats20d : null;
  if (s20) {
    $('#hsUpDays').textContent = `${s20.upDays}天`;
    $('#hsDownDays').textContent = `${s20.downDays}天`;
    const flatEl = $('#hsFlatDays');
    if (flatEl) flatEl.textContent = `${s20.flatDays || 0}天`;
    $('#hsUpProb').textContent = s20.upProb != null ? `${s20.upProb}%` : '—';
    $('#hsMaxUp').textContent = s20.maxUp != null ? fmtPct(s20.maxUp) : '—';
    $('#hsMaxDown').textContent = s20.maxDown != null ? fmtPct(s20.maxDown) : '—';
  }
  $('#hsR5d').textContent = data && data.r5d != null ? fmtPct(data.r5d) : '—';
  $('#hsR10d').textContent = data && data.r10d != null ? fmtPct(data.r10d) : '—';
  $('#hsR20d').textContent = data && data.r20d != null ? fmtPct(data.r20d) : '—';
}

function periodKey(period, ms) {
  const d = new Date(ms + 8 * 3600 * 1000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  if (period === 'year') return `${y}`;
  if (period === 'quarter') return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
  if (period === 'month') return `${y}-${pad(m)}`;
  return isoWeekKey(ms);
}

function histFromTs() {
  const now = Date.now();
  switch (state.histRange) {
    case '1m': return now - 30 * 86400000;
    case '3m': return now - 90 * 86400000;
    case '6m': return now - 180 * 86400000;
    case '26ytd': return Date.UTC(2026, 0, 1);
    case '25ytd': return Date.UTC(2025, 0, 1);
    case 'custom':
      return state.histCustom && state.histCustom.from
        ? new Date(`${state.histCustom.from}T00:00:00Z`).getTime()
        : 0;
    default:
      return 0;
  }
}

function histToTs() {
  if (state.histRange === 'custom' && state.histCustom && state.histCustom.to) {
    return new Date(`${state.histCustom.to}T23:59:59Z`).getTime();
  }
  return Infinity;
}

function histRows(items) {
  const from = histFromTs();
  const to = histToTs();
  const period = state.histPeriod;
  const inRange = (items || []).filter((it) => it.d >= from && it.d <= to);
  if (!inRange.length) return [];
  if (period === 'day') return inRange;
  const groups = new Map();
  for (const it of inRange) {
    groups.set(periodKey(period, it.d), it);
  }
  return [...groups.values()];
}

function renderHistTable(rows) {
  const w = findDetailWatch();
  const body = $('#histBody');
  const empty = $('#histEmpty');
  if (!rows.length) {
    body.innerHTML = '';
    empty.textContent = '该区间暂无数据';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  const desc = rows.slice().reverse();
  body.innerHTML = desc
    .map((it, i) => {
      const prev = desc[i + 1];
      const diff = prev ? it.c - prev.c : null;
      const pct = prev && prev.c > 0 ? (diff / prev.c) * 100 : null;
      const cls = diff == null ? 'flat' : diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';
      const chgCell = diff == null
        ? '<td class="flat">—</td>'
        : `<td class="${cls}">${diff > 0 ? '+' : ''}${fmtPrice(diff, w ? w.type : 'stock')}</td>`;
      const pctCell = pct == null
        ? '<td class="flat">—</td>'
        : `<td class="${cls}">${pct > 0 ? '+' : ''}${pct.toFixed(2)}%</td>`;
      return `<tr><td class="d">${esc(fmtDate(it.d))}</td><td>${fmtPrice(it.c, w ? w.type : 'stock')}</td>${chgCell}${pctCell}</tr>`;
    })
    .join('');
}

async function renderHistContent() {
  const w = findDetailWatch();
  if (!w) return;
  $('#histBody').innerHTML = '<tr><td colspan="4"><span style="color:var(--text-3)">加载中…</span></td></tr>';
  try {
    const data = await loadDetailData();
    renderHistTable(histRows(data ? data.items : []));
  } catch (e) {
    $('#histBody').innerHTML = '';
    const empty = $('#histEmpty');
    empty.hidden = false;
    empty.textContent = `历史数据加载失败：${e.message}`;
  }
}

function bindDetailEvents() {
  $('#detailBack').addEventListener('click', () => switchView('watches'));
  $('#detailEdit').addEventListener('click', () => {
    const w = findDetailWatch();
    if (w) openForm(w);
  });
  $('#detailToggle').addEventListener('click', async () => {
    const w = findDetailWatch();
    if (!w) return;
    const btn = $('#detailToggle');
    btn.disabled = true;
    try {
      const r = await call('ths-update-watch', { _id: w._id, enabled: !w.enabled });
      if (!r || !r.ok) throw new Error((r && r.error) || '操作失败');
      await loadWatches({ silent: true });
      renderDetail();
      toast(w.enabled ? '已暂停监控' : '已恢复监控');
    } catch (e) {
      toast(`操作失败：${e.message}`);
    } finally {
      btn.disabled = false;
    }
  });
  $('#detailDelete').addEventListener('click', () => {
    const w = findDetailWatch();
    if (w) askDelete(w);
  });
  document.querySelectorAll('#histPeriod button').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('#histPeriod button').forEach((x) => x.classList.toggle('on', x === b));
      state.histPeriod = b.dataset.period;
      renderHistContent();
    })
  );
  document.querySelectorAll('#histRange button').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('#histRange button').forEach((x) => x.classList.toggle('on', x === b));
      state.histRange = b.dataset.range;
      const custom = b.dataset.range === 'custom';
      $('#histCustom').hidden = !custom;
      if (custom && !state.histCustom.from) {
        const py = (ms) => {
          const dd = new Date(ms + 8 * 3600 * 1000);
          return `${dd.getUTCFullYear()}-${pad(dd.getUTCMonth() + 1)}-${pad(dd.getUTCDate())}`;
        };
        $('#histFrom').value = py(Date.now() - 365 * 86400000);
        $('#histTo').value = py(Date.now());
        state.histCustom = { from: $('#histFrom').value, to: $('#histTo').value };
      }
      renderHistContent();
    })
  );
  $('#histApply').addEventListener('click', () => {
    const from = $('#histFrom').value;
    const to = $('#histTo').value;
    if (!from && !to) { toast('请选择至少一个日期'); return; }
    if (from && to && from > to) { toast('开始日期不能晚于结束日期'); return; }
    state.histCustom = { from: from || null, to: to || null };
    document.querySelectorAll('#histRange button').forEach((x) =>
      x.classList.toggle('on', x.dataset.range === 'custom')
    );
    state.histRange = 'custom';
    $('#histCustom').hidden = false;
    renderHistContent();
  });
}

/* ---------------- 监控表单 ---------------- */
let previewTimer = null;
function currentType() {
  return $('#typeSeg .on').dataset.type;
}

function setType(type) {
  document.querySelectorAll('#typeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.type === type));
  $('#codeLabel').textContent = type === 'etf' ? 'ETF代码' : '股票代码';
  $('#nameLabel').textContent = type === 'etf' ? 'ETF名称' : '股票名称';
  $('#fCode').placeholder = type === 'etf' ? '6 位数字，如 510300' : '6 位数字，如 601137';
  schedulePreview();
}

function schedulePreview() {
  clearTimeout(previewTimer);
  const code = $('#fCode').value.trim();
  const box = $('#pricePreview');
  box.textContent = '';
  box.className = 'hint';
  if (code.length !== 6) return;
  previewTimer = setTimeout(async () => {
    try {
      box.textContent = '查询行情中…';
      const r = await call('ths-get-market-price', { type: currentType(), code });
      if (!r.ok) {
        box.textContent = `未取到行情：${r.error || '暂无数据'}`;
        return;
      }
      const pct = fmtPct(r.changePercent);
      box.textContent = `当前价 ¥${fmtPrice(r.price, currentType())}${pct ? ` · ${pct}` : ''}`;
      box.className = 'hint ok';
      if (!$('#fName').value.trim() && r.name) $('#fName').value = r.name;
    } catch (_) {
      box.textContent = '';
    }
  }, 420);
}

function openForm(watch) {
  state.editingId = watch ? watch._id : null;
  $('#formTitle').textContent = watch ? '编辑监控' : '添加监控';
  $('#deleteBtn').hidden = !watch;
  $('#formError').hidden = true;
  $('#pricePreview').textContent = '';

  setType(watch ? watch.type : 'stock');
  $('#fCode').value = watch ? watch.code : '';
  $('#fName').value = watch ? watch.name : '';
  $('#fBuy').value = watch && watch.buyPrice != null ? watch.buyPrice : '';
  $('#fSell').value = watch && watch.sellPrice != null ? watch.sellPrice : '';
  $('#fEnabled').checked = watch ? !!watch.enabled : true;
  $('#fTarget').value = watch && watch.targetPrice != null ? watch.targetPrice : '';
  $('#fBuyD').value = watch && watch.buyDiscount != null ? Math.round(watch.buyDiscount * 100) : '';
  $('#fSellD').value = watch && watch.sellDiscount != null ? Math.round(watch.sellDiscount * 100) : '';
  state.formManBuy = false;
  state.formManSell = false;
  state.formBaseBuy = (watch && watch.buyPrice != null ? watch.buyPrice : '').toString();
  state.formBaseSell = (watch && watch.sellPrice != null ? watch.sellPrice : '').toString();

  $('#formModal').hidden = false;
  if (watch) schedulePreview();
}

function bindTargetPreview() {
  const recalc = () => {
    const r = calcTargetPrices();
    const hint = $('#targetHint');
    if (!r) { hint.textContent = ''; return; }
    hint.textContent = `→ 买入 ${fmtPrice(r.buy)} ｜ 卖出 ${fmtPrice(r.sell)}`;
    if (!state.formManBuy && $('#fBuy').value.trim() === state.formBaseBuy) $('#fBuy').value = fmtPrice(r.buy);
    if (!state.formManSell && $('#fSell').value.trim() === state.formBaseSell) $('#fSell').value = fmtPrice(r.sell);
  };
  ['fTarget', 'fBuyD', 'fSellD'].forEach((id) => $('#' + id).addEventListener('input', recalc));
  $('#fBuy').addEventListener('input', () => { state.formManBuy = true; $('#targetHint').textContent = ''; });
  $('#fSell').addEventListener('input', () => { state.formManSell = true; $('#targetHint').textContent = ''; });
}

async function saveForm() {
  const err = $('#formError');
  err.hidden = true;
  const payload = {
    type: currentType(),
    code: $('#fCode').value.trim(),
    name: $('#fName').value.trim(),
    buyPrice: $('#fBuy').value.trim(),
    sellPrice: $('#fSell').value.trim(),
    enabled: $('#fEnabled').checked,
    targetPrice: $('#fTarget').value.trim(),
    buyDiscount: $('#fBuyD').value.trim(),
    sellDiscount: $('#fSellD').value.trim(),
  };
  if (!/^\d{6}$/.test(payload.code)) {
    err.textContent = '代码必须为 6 位数字';
    err.hidden = false;
    return;
  }
  if (!payload.name) {
    err.textContent = '请填写名称';
    err.hidden = false;
    return;
  }
  const btn = $('#saveBtn');
  btn.disabled = true;
  try {
    let r;
    if (state.editingId) {
      r = await call('ths-update-watch', { _id: state.editingId, ...payload });
    } else {
      r = await call('ths-create-watch', payload);
    }
    if (!r || !r.ok) throw new Error((r && r.error) || '未知错误');
    closeModals();
    toast(state.editingId ? '已保存' : '已添加，正在获取行情…');
    await manualRefresh();
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

function askDelete(watch) {
  $('#confirmTitle').textContent = '确认删除监控';
  $('#confirmText').textContent = `确定删除「${watch.name}（${watch.code}）」的监控吗？历史持仓与提醒记录将保留。`;
  $('#confirmModal').hidden = false;
  state.confirmAction = async () => {
    try {
      const r = await call('ths-delete-watch', { _id: watch._id });
      if (!r || !r.ok) throw new Error((r && r.error) || '未知错误');
      closeModals();
      toast('已删除监控');
      if (state.view === 'detail') switchView('watches');
      else await loadWatches({ silent: true });
    } catch (e) {
      closeModals();
      toast(`删除失败：${e.message}`);
    }
  };
}

/* ---------------- 持仓表单 ---------------- */
let hPreviewTimer = null;
let hCurrentMode = 'qty'; // 'qty' | 'amount'

function currentHoldingType() {
  return $('#hTypeSeg .on').dataset.type;
}

function setHoldingType(type) {
  document.querySelectorAll('#hTypeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.type === type));
  $('#hCodeLabel').textContent = type === 'etf' ? 'ETF代码' : '股票代码';
  $('#hNameLabel').textContent = type === 'etf' ? 'ETF名称' : '股票名称';
  scheduleHoldingPreview();
}

function setHoldingMode(mode) {
  hCurrentMode = mode;
  document.querySelectorAll('#hModeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  $('#hModeQtyBox').hidden = mode !== 'qty';
  $('#hModeAmountBox').hidden = mode !== 'amount';
  recalcHoldingModeHint();
}

function recalcHoldingModeHint() {
  const hint = $('#hCalcHint');
  if (hCurrentMode === 'qty') {
    const q = parseFloat($('#hQuantity').value);
    const p = parseFloat($('#hCostPrice').value);
    if (Number.isFinite(q) && q > 0 && Number.isFinite(p) && p > 0) {
      hint.textContent = `持仓成本总额：¥${(q * p).toFixed(2)}`;
    } else {
      hint.textContent = '';
    }
  } else {
    const a = parseFloat($('#hInvestedAmount').value);
    const p = parseFloat($('#hAmountCostPrice').value);
    if (Number.isFinite(a) && a > 0 && Number.isFinite(p) && p > 0) {
      const q = Math.floor(a / p);
      hint.textContent = `理论换算持仓：约 ${q} 股（已投 ¥${a.toFixed(2)}）`;
    } else {
      hint.textContent = '';
    }
  }
}

function scheduleHoldingPreview() {
  clearTimeout(hPreviewTimer);
  const code = $('#hCode').value.trim();
  const box = $('#hPricePreview');
  box.textContent = '';
  if (code.length !== 6) return;
  hPreviewTimer = setTimeout(async () => {
    try {
      box.textContent = '查询行情中…';
      const r = await call('ths-get-market-price', { type: currentHoldingType(), code });
      if (!r.ok) {
        box.textContent = `未取到行情：${r.error || '暂无数据'}`;
        return;
      }
      const pct = fmtPct(r.changePercent);
      box.textContent = `当前价 ¥${fmtPrice(r.price, currentHoldingType())}${pct ? ` · ${pct}` : ''}`;
      box.className = 'hint ok';
      if (!$('#hName').value.trim() && r.name) $('#hName').value = r.name;
      if (r.price && !$('#hCostPrice').value) $('#hCostPrice').value = r.price.toFixed(2);
      if (r.price && !$('#hAmountCostPrice').value) $('#hAmountCostPrice').value = r.price.toFixed(2);
      recalcHoldingModeHint();
    } catch (_) {
      box.textContent = '';
    }
  }, 420);
}

function openHoldingForm(holding) {
  state.editingHoldingId = holding ? holding._id : null;
  $('#holdingFormTitle').textContent = holding ? '编辑持仓' : '添加持仓';
  $('#hDeleteBtn').hidden = !holding;
  $('#hFormError').hidden = true;
  $('#hPricePreview').textContent = '';

  setHoldingType(holding ? holding.type : 'stock');
  setHoldingMode('qty');

  $('#hCode').value = holding ? holding.code : '';
  $('#hName').value = holding ? holding.name : '';
  $('#hQuantity').value = holding ? holding.quantity : '';
  $('#hCostPrice').value = holding ? holding.costPrice : '';
  $('#hInvestedAmount').value = holding ? holding.costAmount : '';
  $('#hAmountCostPrice').value = holding ? holding.costPrice : '';
  $('#hBuyDate').value = holding && holding.buyDate ? holding.buyDate : '';
  $('#hAccount').value = holding && holding.accountName ? holding.accountName : '默认账户';
  $('#hTargetQty').value = holding && holding.targetQuantity ? holding.targetQuantity : '';
  $('#hPlanAmount').value = holding && holding.plannedAmount ? holding.plannedAmount : '';
  $('#hNote').value = holding && holding.note ? holding.note : '';

  recalcHoldingModeHint();
  $('#holdingModal').hidden = false;
  if (holding) scheduleHoldingPreview();
}

async function saveHoldingForm() {
  const err = $('#hFormError');
  err.hidden = true;

  const payload = {
    type: currentHoldingType(),
    code: $('#hCode').value.trim(),
    name: $('#hName').value.trim(),
    buyDate: $('#hBuyDate').value,
    accountName: $('#hAccount').value.trim() || '默认账户',
    targetQuantity: $('#hTargetQty').value.trim(),
    plannedAmount: $('#hPlanAmount').value.trim(),
    note: $('#hNote').value.trim(),
  };

  if (!/^\d{6}$/.test(payload.code)) {
    err.textContent = '代码必须为 6 位数字';
    err.hidden = false;
    return;
  }
  if (!payload.name) {
    err.textContent = '请填写名称';
    err.hidden = false;
    return;
  }

  if (hCurrentMode === 'qty') {
    payload.quantity = $('#hQuantity').value.trim();
    payload.costPrice = $('#hCostPrice').value.trim();
  } else {
    payload.investedAmount = $('#hInvestedAmount').value.trim();
    payload.costPrice = $('#hAmountCostPrice').value.trim();
  }

  const btn = $('#hSaveBtn');
  btn.disabled = true;
  try {
    let r;
    if (state.editingHoldingId) {
      r = await call('ths-update-holding', { _id: state.editingHoldingId, ...payload });
    } else {
      r = await call('ths-create-holding', payload);
    }
    if (!r || !r.ok) throw new Error((r && r.error) || '未知错误');
    closeModals();
    toast(state.editingHoldingId ? '持仓已保存' : '已添加持仓');
    await loadPortfolio({ silent: true });
    if (state.view === 'holdingDetail') {
      renderHoldingDetail();
    }
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

function askDeleteHolding(holding) {
  $('#confirmTitle').textContent = '确认删除持仓';
  $('#confirmText').textContent = `确定删除「${holding.name}（${holding.code}）」的 ${holding.quantity} 股持仓吗？对应监控和提醒不受影响。`;
  $('#confirmModal').hidden = false;
  state.confirmAction = async () => {
    try {
      const r = await call('ths-delete-holding', { _id: holding._id });
      if (!r || !r.ok) throw new Error((r && r.error) || '未知错误');
      closeModals();
      toast('已删除持仓');
      if (state.view === 'holdingDetail') switchView('portfolio');
      else await loadPortfolio({ silent: true });
    } catch (e) {
      closeModals();
      toast(`删除失败：${e.message}`);
    }
  };
}

/* ---------------- 现金管理 ---------------- */
function openCashModal() {
  const sum = state.portfolio.summary || {};
  $('#fCashBalance').value = sum.cashBalance != null ? sum.cashBalance : '0.00';
  $('#cashError').hidden = true;
  $('#cashModal').hidden = false;
}

async function saveCashBalance() {
  const v = parseFloat($('#fCashBalance').value);
  if (!Number.isFinite(v) || v < 0) {
    $('#cashError').textContent = '现金余额必须为大于等于 0 的数字';
    $('#cashError').hidden = false;
    return;
  }
  const btn = $('#saveCashBtn');
  btn.disabled = true;
  try {
    const r = await call('ths-update-account', { cashBalance: v });
    if (!r || !r.ok) throw new Error((r && r.error) || '更新现金失败');
    $('#cashModal').hidden = true;
    toast('现金余额已更新');
    await loadPortfolio({ silent: true });
  } catch (e) {
    $('#cashError').textContent = e.message;
    $('#cashError').hidden = false;
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- 提醒记录 ---------------- */
function renderAlerts() {
  const list = $('#alertList');
  const empty = $('#alertEmpty');
  const more = $('#loadMoreBtn');
  if (!state.alerts.length) {
    list.innerHTML = '';
    empty.hidden = false;
    more.hidden = true;
    const filter = state.alertFilter || 'all';
    const et = empty.querySelector('.empty-title');
    const es = empty.querySelector('.empty-sub');
    if (filter === 'dividend') {
      if (et) et.textContent = '暂无分红提醒记录';
      if (es) es.innerHTML = '当持仓或监控标的临近股权登记日时，<br>系统会自动发送提醒并记录在此';
    } else if (filter === 'buy') {
      if (et) et.textContent = '暂无买入提醒记录';
      if (es) es.innerHTML = '当标的价格跌至买入目标价时，<br>系统会自动发送提醒并记录在此';
    } else if (filter === 'sell') {
      if (et) et.textContent = '暂无卖出提醒记录';
      if (es) es.innerHTML = '当标的价格涨至卖出目标价时，<br>系统会自动发送提醒并记录在此';
    } else {
      if (et) et.textContent = '暂无提醒记录';
      if (es) es.innerHTML = '当价格穿越价格线或分红临近时，<br>提醒会出现在这里';
    }
    return;
  }
  empty.hidden = true;
  more.hidden = !state.alertHasMore;

  list.innerHTML = state.alerts
    .map((a) => {
      const isDiv = typeof a.alertType === 'string' && a.alertType.startsWith('DIVIDEND_');
      const isBuy = a.alertType === 'buy';
      const isSell = a.alertType === 'sell';

      let typeBadge = '';
      let detailsHtml = '';

      if (isDiv) {
        let divTitle = '💰 分红提醒';
        if (a.alertType === 'DIVIDEND_TODAY') divTitle = '🔴 今日股权登记';
        else if (a.alertType === 'DIVIDEND_1D') divTitle = '🟡 明日股权登记';
        else if (a.alertType === 'DIVIDEND_3D') divTitle = '💰 3日内股权登记';
        else if (a.alertType === 'DIVIDEND_5D') divTitle = '💰 5日内股权登记';
        else if (a.alertType === 'DIVIDEND_10D') divTitle = '💰 10日内分红';

        typeBadge = `<span class="alert-chip div">${divTitle}</span>`;
        const unit = a.type === 'etf' ? '/份' : '/股';
        detailsHtml = `
          <div class="alert-grid">
            <div class="ag-col"><span>每${a.type === 'etf' ? '份' : '股'}分红</span><b>¥${a.dividendPerShare != null ? a.dividendPerShare.toFixed(3) : '—'}${unit}</b></div>
            <div class="ag-col"><span>股权登记日</span><b>${esc(a.recordDate || '—')}</b></div>
            <div class="ag-col"><span>除息日</span><b>${esc(a.exDividendDate || '—')}</b></div>
          </div>`;
      } else {
        const chipCls = isBuy ? 'buy' : 'sell';
        const chipText = isBuy ? '🟢 买入机会已达' : '🔴 卖出机会已达';
        typeBadge = `<span class="alert-chip ${chipCls}">${chipText}</span>`;
        const actionText = isBuy ? '现价 ≤ 买入目标' : '现价 ≥ 卖出目标';
        const priceCls = isSell ? 'text-up' : isBuy ? 'text-down' : '';

        detailsHtml = `
          <div class="alert-grid">
            <div class="ag-col"><span>触发时现价</span><b class="${priceCls}">¥${fmtPrice(a.currentPrice, a.type) || '—'}</b></div>
            <div class="ag-col"><span>目标阈值</span><b>¥${fmtPrice(a.triggerPrice, a.type) || '—'}</b></div>
            <div class="ag-col"><span>达成条件</span><b class="cond">${actionText}</b></div>
          </div>`;
      }

      return `
        <div class="alert-card ${isDiv ? 'div' : isBuy ? 'buy' : 'sell'}">
          <div class="ac-head">
            <div class="ac-type">${typeBadge}</div>
            <div class="ac-time">${fmtFullDateTime(a.createdAt)}</div>
          </div>
          <div class="ac-body">
            <div class="ac-name-row">
              <span class="ac-name">${esc(a.name || a.code)}</span>
              <span class="ac-code">${esc(a.code)} · ${a.type === 'etf' ? 'ETF' : '股票'}</span>
            </div>
            ${detailsHtml}
          </div>
        </div>`;
    })
    .join('');
}

/* ---------------- 视图切换 ---------------- */
function switchView(view) {
  state.view = view;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.view === view));

  $('#viewWatches').hidden = view !== 'watches';
  $('#viewPortfolio').hidden = view !== 'portfolio';
  $('#viewDividends').hidden = view !== 'dividends';
  $('#viewAlerts').hidden = view !== 'alerts';
  $('#viewDetail').hidden = view !== 'detail';
  $('#viewHoldingDetail').hidden = view !== 'holdingDetail';
  $('#viewGuide').hidden = view !== 'guide';

  // 浮动按钮切换
  $('#fabAddWatch').hidden = view !== 'watches';
  $('#fabImportWatch').hidden = view !== 'watches';
  $('#fabAddHolding').hidden = view !== 'portfolio';
  $('#fabImportHolding').hidden = view !== 'portfolio';

  $('#stats').hidden = view !== 'watches';
  document.body.classList.toggle('detail-open', view === 'detail' || view === 'holdingDetail' || view === 'guide');

  if (view === 'watches') {
    $('#appTitle').textContent = '盯价';
    loadWatches({ silent: true });
  } else if (view === 'portfolio') {
    $('#appTitle').textContent = '我的资产';
    loadPortfolio({ silent: true });
  } else if (view === 'dividends') {
    $('#appTitle').textContent = '分红日历';
    loadDividendsView();
  } else if (view === 'alerts') {
    $('#appTitle').textContent = '提醒记录';
    loadAlerts();
  } else if (view === 'guide') {
    $('#appTitle').textContent = '新手指南';
  }
}

function closeModals() {
  $('#formModal').hidden = true;
  $('#holdingModal').hidden = true;
  $('#cashModal').hidden = true;
  $('#confirmModal').hidden = true;
}

/* ---------------- 批量导入持仓 ---------------- */
const impH = {
  step: 1,
  rows: [],
  importing: false,
};

function openImportHoldings() {
  impH.rows = [];
  impH.importing = false;
  $('#impHPaste').value = '';
  $('#impHHint').textContent = '';
  $('#impHFile').value = '';
  $('#impHConfirm').disabled = false;
  impHSwitchStep(1);
  $('#importHoldingsModal').hidden = false;
}

function impHSwitchStep(n) {
  impH.step = n;
  $('#impHStep1').hidden = n !== 1;
  $('#impHStep2').hidden = n !== 2;
  $('#impHStep3').hidden = n !== 3;
}

function parseImpHLines(text) {
  const lines = readImpLines(text);
  if (!lines.length) {
    $('#impHHint').textContent = '没有解析到有效内容';
    return;
  }
  const rows = [];
  const existCodes = new Set((state.portfolio.holdings || []).map((h) => h.code));

  for (let i = 0; i < lines.length; i++) {
    const cells = splitImpLine(lines[i]).map((c) => c.replace(/，/g, ',').trim());
    if (!cells.length || cells.every((c) => !c)) continue;
    const type = normImpType(cells[0]) || 'stock';
    const code = normImpCode(cells[1]);
    const name = String(cells[2] || '').trim();
    const qty = parseInt(cells[3], 10);
    const costP = parseFloat(cells[4]);
    const buyDate = cells[5] || null;
    const account = cells[6] || '默认账户';

    const errors = [];
    if (!code) errors.push('无效代码');
    if (!Number.isFinite(qty) || qty <= 0) errors.push('数量必须为正整数');
    if (!Number.isFinite(costP) || costP <= 0) errors.push('成本价必须大于0');

    const status = errors.length ? 'error' : existCodes.has(code) ? 'dup' : 'ok';
    rows.push({
      type,
      code,
      name: name || code,
      quantity: qty,
      costPrice: costP,
      costAmount: qty && costP ? (qty * costP).toFixed(2) : '—',
      buyDate,
      accountName: account,
      status,
      errors,
    });
  }

  impH.rows = rows;
  renderImpHPreview();
}

function renderImpHPreview() {
  const rows = impH.rows;
  const ok = rows.filter((r) => r.status === 'ok').length;
  const dup = rows.filter((r) => r.status === 'dup').length;
  const err = rows.filter((r) => r.status === 'error').length;

  $('#impHStats').innerHTML = `
    <span class="imp-chip">共 ${rows.length} 条</span>
    <span class="imp-chip ok">✅ 正确 ${ok}</span>
    <span class="imp-chip dup">⚠️ 重复 ${dup}</span>
    <span class="imp-chip err">❌ 错误 ${err}</span>`;

  $('#impHTbody').innerHTML = rows
    .map(
      (r) => `<tr class="${r.status === 'error' ? 'row-err' : ''}">
      <td>${r.status === 'ok' ? '✅' : r.status === 'dup' ? '⚠️' : '❌'}</td>
      <td>${r.type === 'etf' ? 'ETF' : '股票'}</td>
      <td>${esc(r.code || '')}</td>
      <td>${esc(r.name || '—')}</td>
      <td>${r.quantity || '—'}</td>
      <td>${r.costPrice || '—'}</td>
      <td>${r.costAmount}</td>
      <td>${esc(r.accountName)}</td>
      <td class="note">${esc(r.errors.join('；') || (r.status === 'dup' ? '已存在持仓' : '正常'))}</td>
    </tr>`
    )
    .join('');

  const willImport = rows.filter((r) => r.status !== 'error').length;
  $('#impHConfirm').textContent = `确认导入持仓（${willImport} 条）`;
  $('#impHConfirm').disabled = willImport === 0;

  impHSwitchStep(2);
}

async function confirmImportHoldings() {
  if (impH.importing) return;
  const payloadRows = impH.rows
    .filter((r) => r.status !== 'error')
    .map((r) => ({
      type: r.type,
      code: r.code,
      name: r.name,
      quantity: r.quantity,
      costPrice: r.costPrice,
      buyDate: r.buyDate,
      accountName: r.accountName,
    }));
  if (!payloadRows.length) return;

  const strategy = $('#impHDupStrategy .on').dataset.v;
  impH.importing = true;
  const btn = $('#impHConfirm');
  btn.disabled = true;
  btn.textContent = '正在导入…';

  try {
    const r = await call('ths-import-holdings', { rows: payloadRows, duplicateStrategy: strategy });
    if (!r || !r.ok) throw new Error((r && r.error) || '导入失败');
    $('#impHResult').innerHTML = `
      <p class="big">✅ 持仓导入完成</p>
      <p>成功新增：<span class="ok">${r.added || 0}</span> 条</p>
      <p>更新已有：<span class="ok">${r.updated || 0}</span> 条</p>
      <p>跳过重复：<span class="dup">${r.skipped || 0}</span> 条</p>`;
    impHSwitchStep(3);
  } catch (e) {
    toast(`导入失败：${e.message}`);
    btn.disabled = false;
    btn.textContent = '确认导入持仓';
  } finally {
    impH.importing = false;
  }
}

/* ---------------- V4 弹窗交互：日记、计划、名词解释、偏好设置 ---------------- */

// 1. 名词解释弹窗 (ⓘ)
let currentExplainSec = 'secQuick';
function openExplain(key) {
  const item = EXPLAIN_DICT[key];
  if (!item) return;
  currentExplainSec = item.guideSec || 'secQuick';
  $('#explainTitle').textContent = `💡 ${item.title}`;
  $('#explainBody').innerHTML = `<p>${esc(item.desc).replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>`;
  $('#explainModal').hidden = false;
}

/* ---------------- 📖 盯价 · 新手指南 控制器 ---------------- */
const guideState = {
  readSet: new Set(),
};

function initGuideProgress() {
  try {
    const saved = localStorage.getItem('dingjia_guide_read_v1');
    if (saved) {
      const arr = JSON.parse(saved);
      if (Array.isArray(arr)) guideState.readSet = new Set(arr);
    }
  } catch (e) {}
  updateGuideBadge();
}

function markGuideSecRead(secIndex) {
  if (secIndex == null) return;
  guideState.readSet.add(Number(secIndex));
  try {
    localStorage.setItem('dingjia_guide_read_v1', JSON.stringify([...guideState.readSet]));
  } catch (e) {}
  updateGuideBadge();
}

function updateGuideBadge() {
  const count = guideState.readSet.size;
  const badge = $('#guideProgressBadge');
  if (badge) badge.textContent = `已了解 ${count}/8 节`;
}

function openGuide(sectionId) {
  switchView('guide');
  initGuideProgress();
  const targetId = sectionId || 'secQuick';
  setTimeout(() => {
    const el = document.getElementById(targetId);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      const secIndex = el.dataset.guideSec;
      if (secIndex != null) markGuideSecRead(secIndex);
    }
    document.querySelectorAll('.guide-pill').forEach((btn) => {
      btn.classList.toggle('on', btn.dataset.sec === targetId);
    });
  }, 60);
}

function initGuideSearch() {
  const input = $('#guideSearchInput');
  if (!input) return;
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    const sections = document.querySelectorAll('.guide-section');
    sections.forEach((sec) => {
      if (!q) {
        sec.hidden = false;
        return;
      }
      const text = sec.textContent.toLowerCase();
      sec.hidden = !text.includes(q);
    });
  });
}

// 2. 投资日记弹窗
let noteTarget = { code: '', name: '', price: null };
function openNoteModal(code, name, price) {
  noteTarget = { code, name, price };
  $('#noteTargetName').textContent = `${name || code} (${code})`;
  $('#noteDate').value = new Date().toISOString().slice(0, 10);
  $('#notePrice').value = price != null ? price : '';
  $('#noteContent').value = '';
  $('#noteError').hidden = true;
  $('#noteModal').hidden = false;
}

async function saveNote() {
  const content = $('#noteContent').value.trim();
  const date = $('#noteDate').value;
  const price = parseFloat($('#notePrice').value) || null;
  const errEl = $('#noteError');
  if (!content) {
    errEl.textContent = '请输入日记内容';
    errEl.hidden = false;
    return;
  }
  errEl.hidden = true;
  const btn = $('#saveNoteBtn');
  btn.disabled = true;
  btn.textContent = '保存中…';
  try {
    const res = await call('ths-create-note', {
      code: noteTarget.code,
      name: noteTarget.name,
      date,
      price,
      content,
    });
    if (!res || !res.ok) throw new Error((res && res.error) || '保存失败');
    $('#noteModal').hidden = true;
    toast('日记已记录 ✅');
    loadAndRenderNotes(noteTarget.code);
  } catch (e) {
    errEl.textContent = e.message;
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = '保存日记';
  }
}

// 3. 投资计划弹窗
let planTarget = { code: '', name: '', type: 'stock' };
function openPlanModal(code, name, type) {
  planTarget = { code, name, type };
  $('#planTargetName').textContent = `${name || code} (${code})`;
  const exist = state.plans[code] || {};
  
  // 理由 tag
  const tags = new Set(exist.reasons || []);
  document.querySelectorAll('#planReasonTags .tag-btn').forEach((b) => {
    b.classList.toggle('on', tags.has(b.dataset.tag));
  });
  $('#planCustomReason').value = exist.customReason || '';
  $('#planFldTargetQty').value = exist.targetQuantity || '';
  $('#planFldPlannedAmt').value = exist.plannedAmount || '';

  // 档位初始化
  const buyEditor = $('#buyLevelsEditor');
  buyEditor.innerHTML = '';
  if (Array.isArray(exist.buyLevels) && exist.buyLevels.length) {
    exist.buyLevels.forEach((l) => addBuyLevelRow(l.price, l.amount));
  } else {
    addBuyLevelRow('', '');
  }

  const sellEditor = $('#sellLevelsEditor');
  sellEditor.innerHTML = '';
  if (Array.isArray(exist.sellLevels) && exist.sellLevels.length) {
    exist.sellLevels.forEach((l) => addSellLevelRow(l.price, l.percent));
  } else {
    addSellLevelRow('', '');
  }

  $('#planError').hidden = true;
  $('#planModal').hidden = false;
}

function addBuyLevelRow(price = '', amount = '') {
  const div = document.createElement('div');
  div.className = 'level-row';
  div.innerHTML = `<input type="number" step="0.01" placeholder="买入价(元)" value="${price}"><input type="number" placeholder="投入金额(元)" value="${amount}"><button type="button" class="level-del">✕</button>`;
  div.querySelector('.level-del').addEventListener('click', () => div.remove());
  $('#buyLevelsEditor').appendChild(div);
}

function addSellLevelRow(price = '', percent = '') {
  const div = document.createElement('div');
  div.className = 'level-row';
  div.innerHTML = `<input type="number" step="0.01" placeholder="卖出价(元)" value="${price}"><input type="number" placeholder="卖出比例%" value="${percent}"><button type="button" class="level-del">✕</button>`;
  div.querySelector('.level-del').addEventListener('click', () => div.remove());
  $('#sellLevelsEditor').appendChild(div);
}

async function savePlan() {
  const reasons = Array.from(document.querySelectorAll('#planReasonTags .tag-btn.on')).map((b) => b.dataset.tag);
  const customReason = $('#planCustomReason').value.trim();
  const targetQuantity = parseInt($('#planFldTargetQty').value, 10) || null;
  const plannedAmount = parseFloat($('#planFldPlannedAmt').value) || null;

  const buyLevels = [];
  document.querySelectorAll('#buyLevelsEditor .level-row').forEach((row) => {
    const inputs = row.querySelectorAll('input');
    const p = parseFloat(inputs[0].value);
    const a = parseFloat(inputs[1].value);
    if (Number.isFinite(p) && p > 0) buyLevels.push({ price: p, amount: a || 0 });
  });

  const sellLevels = [];
  document.querySelectorAll('#sellLevelsEditor .level-row').forEach((row) => {
    const inputs = row.querySelectorAll('input');
    const p = parseFloat(inputs[0].value);
    const pct = parseFloat(inputs[1].value);
    if (Number.isFinite(p) && p > 0) sellLevels.push({ price: p, percent: pct || 0 });
  });

  const btn = $('#savePlanBtn');
  const errEl = $('#planError');
  errEl.hidden = true;
  btn.disabled = true;
  btn.textContent = '保存中…';

  try {
    const res = await call('ths-update-plan', {
      code: planTarget.code,
      name: planTarget.name,
      type: planTarget.type,
      reasons,
      customReason,
      targetQuantity,
      plannedAmount,
      buyLevels,
      sellLevels,
    });
    if (!res || !res.ok) throw new Error((res && res.error) || '保存失败');
    $('#planModal').hidden = true;
    toast('投资计划已保存 ✅');
    await loadAndRenderPlan(planTarget.code);
    await loadPortfolio({ silent: true });
  } catch (e) {
    errEl.textContent = e.message;
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = '保存计划';
  }
}

// 4. 设置与偏好
function openSettingsModal() {
  const s = state.settings;
  $('#setCommissionRate').value = s.commissionRate || 0.00025;
  $('#setMinCommission').value = s.minCommission != null ? s.minCommission : 5.0;
  $('#setStampDutyRate').value = s.stampDutyRate != null ? s.stampDutyRate : 0.0005;
  $('#setTransferFeeRate').value = s.transferFeeRate != null ? s.transferFeeRate : 0.00001;
  document.querySelectorAll('#modeSeg button').forEach((b) => {
    b.classList.toggle('on', b.dataset.mode === s.displayMode);
  });
  $('#settingsModal').hidden = false;
}

function saveSettings() {
  state.settings.commissionRate = parseFloat($('#setCommissionRate').value) || 0.00025;
  state.settings.minCommission = parseFloat($('#setMinCommission').value) || 5.0;
  state.settings.stampDutyRate = parseFloat($('#setStampDutyRate').value) || 0.0005;
  state.settings.transferFeeRate = parseFloat($('#setTransferFeeRate').value) || 0.00001;
  state.settings.displayMode = $('#modeSeg .on').dataset.mode || 'novice';
  localStorage.setItem('ths_user_settings', JSON.stringify(state.settings));
  $('#settingsModal').hidden = true;
  toast('偏好设置已保存 ✅');
  loadPortfolio({ silent: true });
}

// 5. AI 今日数据速览
async function showAiSummary() {
  const summaryEl = $('#dailySummaryText');
  summaryEl.textContent = '正在整理今日投资数据…';
  try {
    const res = await call('ths-get-ai-summary', { mode: 'daily_summary' });
    if (res && res.ok && res.summary) {
      summaryEl.textContent = res.summary;
    }
  } catch (e) {
    summaryEl.textContent = `生成摘要失败: ${e.message}`;
  }
}

/* ---------------- 事件绑定 ---------------- */
function bindEvents() {
  document.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => switchView(t.dataset.view))
  );

  $('#refreshBtn').addEventListener('click', manualRefresh);
  $('#settingsBtn').addEventListener('click', openSettingsModal);
  $('#btnExplainToday').addEventListener('click', showAiSummary);

  // 📖 新手指南事件绑定
  const homeGb = $('#homeGuideBanner');
  if (homeGb) homeGb.addEventListener('click', () => openGuide('secQuick'));
  const settingGe = $('#settingGuideEntry');
  if (settingGe) {
    settingGe.addEventListener('click', () => {
      $('#settingsModal').hidden = true;
      openGuide('secQuick');
    });
  }
  const guideBack = $('#guideBackBtn');
  if (guideBack) guideBack.addEventListener('click', () => switchView('watches'));
  const guideHome = $('#btnGuideGoHome');
  if (guideHome) guideHome.addEventListener('click', () => switchView('watches'));
  const guideFinish = $('#btnGuideFinish');
  if (guideFinish) guideFinish.addEventListener('click', () => switchView('watches'));
  const guideJumpQuick = $('#btnGuideJumpQuick');
  if (guideJumpQuick) guideJumpQuick.addEventListener('click', () => openGuide('secQuick'));

  document.querySelectorAll('.guide-pill').forEach((btn) => {
    btn.addEventListener('click', () => openGuide(btn.dataset.sec));
  });

  const explainGoGuide = $('#btnExplainGoGuide');
  if (explainGoGuide) {
    explainGoGuide.addEventListener('click', () => {
      $('#explainModal').hidden = true;
      openGuide(currentExplainSec);
    });
  }
  initGuideSearch();

  // 名词解释点击
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-explain]');
    if (btn) openExplain(btn.dataset.explain);
  });
  $('[data-close-explain]').addEventListener('click', () => { $('#explainModal').hidden = true; });

  // 设置弹窗
  $('[data-close-settings]').addEventListener('click', () => { $('#settingsModal').hidden = true; });
  document.querySelectorAll('#modeSeg button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#modeSeg button').forEach((x) => x.classList.toggle('on', x === b));
    });
  });
  $('#saveSettingsBtn').addEventListener('click', saveSettings);

  // 日记弹窗
  $('#hdAddNoteBtn').addEventListener('click', () => {
    const h = findDetailHolding();
    if (h) openNoteModal(h.code, h.name, h.currentPrice);
  });
  $('[data-close-note]').addEventListener('click', () => { $('#noteModal').hidden = true; });
  $('#saveNoteBtn').addEventListener('click', saveNote);

  // 计划弹窗
  $('#hdEditPlanBtn').addEventListener('click', () => {
    const h = findDetailHolding();
    if (h) openPlanModal(h.code, h.name, h.type);
  });
  $('[data-close-plan]').addEventListener('click', () => { $('#planModal').hidden = true; });
  document.querySelectorAll('#planReasonTags .tag-btn').forEach((b) => {
    b.addEventListener('click', () => b.classList.toggle('on'));
  });
  $('#btnAddBuyLevel').addEventListener('click', () => addBuyLevelRow('', ''));
  $('#btnAddSellLevel').addEventListener('click', () => addSellLevelRow('', ''));
  $('#savePlanBtn').addEventListener('click', savePlan);

  // 触达筛选器
  document.querySelectorAll('#touchTypeFilter button').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('#touchTypeFilter button').forEach((x) => x.classList.toggle('on', x === b));
      state.touchFilter.alertType = b.dataset.type;
      const h = findDetailHolding();
      if (h) loadAndRenderTouches(h.code, 'hd');
      const w = findDetailWatch();
      if (w) loadAndRenderTouches(w.code, 'dt');
    })
  );
  document.querySelectorAll('#touchTimeFilter button').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('#touchTimeFilter button').forEach((x) => x.classList.toggle('on', x === b));
      state.touchFilter.timeRange = b.dataset.range;
      const h = findDetailHolding();
      if (h) loadAndRenderTouches(h.code, 'hd');
      const w = findDetailWatch();
      if (w) loadAndRenderTouches(w.code, 'dt');
    })
  );

  // 监控相关
  document.querySelectorAll('[data-open-add]').forEach((b) => b.addEventListener('click', () => openForm(null)));
  document.querySelectorAll('#watchFilter button').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('#watchFilter button').forEach((x) => x.classList.toggle('on', x === b));
      state.watchFilter = b.dataset.filter;
      renderWatches();
    })
  );

  // 资产与持仓相关
  document.querySelectorAll('[data-open-add-holding]').forEach((b) =>
    b.addEventListener('click', () => openHoldingForm(null))
  );
  document.querySelectorAll('[data-open-import-holding]').forEach((b) =>
    b.addEventListener('click', openImportHoldings)
  );
  $('#editCashBtn').addEventListener('click', openCashModal);
  $('#saveCashBtn').addEventListener('click', saveCashBalance);
  $('[data-close-cash]').addEventListener('click', () => { $('#cashModal').hidden = true; });

  document.querySelectorAll('#holdingSort button').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('#holdingSort button').forEach((x) => x.classList.toggle('on', x === b));
      state.holdingSort = b.dataset.sort;
      renderHoldingsList();
    })
  );

  // 持仓录入模式切换
  document.querySelectorAll('#hTypeSeg button').forEach((b) =>
    b.addEventListener('click', () => setHoldingType(b.dataset.type))
  );
  document.querySelectorAll('#hModeSeg button').forEach((b) =>
    b.addEventListener('click', () => setHoldingMode(b.dataset.mode))
  );
  $('#hCode').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
    scheduleHoldingPreview();
  });
  $('#hQuantity').addEventListener('input', recalcHoldingModeHint);
  $('#hCostPrice').addEventListener('input', recalcHoldingModeHint);
  $('#hInvestedAmount').addEventListener('input', recalcHoldingModeHint);
  $('#hAmountCostPrice').addEventListener('input', recalcHoldingModeHint);
  $('#hSaveBtn').addEventListener('click', saveHoldingForm);
  $('#hDeleteBtn').addEventListener('click', () => {
    const h = state.portfolio.holdings.find((x) => x._id === state.editingHoldingId);
    if (h) askDeleteHolding(h);
  });
  $('[data-close-holding]').addEventListener('click', () => { $('#holdingModal').hidden = true; });

  // 监控表单
  document.querySelectorAll('#typeSeg button').forEach((b) =>
    b.addEventListener('click', () => setType(b.dataset.type))
  );
  $('#fCode').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
    schedulePreview();
  });
  $('#saveBtn').addEventListener('click', saveForm);
  $('#deleteBtn').addEventListener('click', () => {
    const w = state.watches.find((x) => x._id === state.editingId);
    if (w) askDelete(w);
  });
  $('[data-close]').addEventListener('click', closeModals);
  $('[data-close-confirm]').addEventListener('click', () => { $('#confirmModal').hidden = true; });
  $('#confirmOk').addEventListener('click', () => {
    if (state.confirmAction) state.confirmAction();
    state.confirmAction = null;
  });

  // 分红日历与提醒
  document.querySelectorAll('#divFilter button').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('#divFilter button').forEach((x) => x.classList.toggle('on', x === b));
      state.divFilter = b.dataset.filter;
      renderDividendsView();
    })
  );
  document.querySelectorAll('#alertFilter button').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('#alertFilter button').forEach((x) => x.classList.toggle('on', x === b));
      state.alertFilter = b.dataset.filter;
      loadAlerts();
    })
  );
  $('#loadMoreBtn').addEventListener('click', () => loadAlerts({ append: true }));

  // 持仓批量导入
  $('[data-close-import-h]').addEventListener('click', () => { $('#importHoldingsModal').hidden = true; });
  $('#impHTemplate').addEventListener('click', () => {
    const content = [
      '类型,代码,名称,持仓数量,成本价,买入日期,账户',
      '股票,601137,博威合金,900,19.80,2026-08-01,A股账户',
      'ETF,510300,沪深300ETF,2000,3.80,2026-07-10,A股账户',
    ].join('\r\n');
    downloadTextFile('holdings_template.csv', '\uFEFF' + content);
  });
  $('#impHParse').addEventListener('click', () => {
    const text = $('#impHPaste').value;
    if (text.trim()) parseImpHLines(text);
  });
  $('#impHBack').addEventListener('click', () => impHSwitchStep(1));
  $('#impHConfirm').addEventListener('click', confirmImportHoldings);
  $('#impHDone').addEventListener('click', async () => {
    $('#importHoldingsModal').hidden = true;
    switchView('portfolio');
    await loadPortfolio({ silent: true });
  });

  bindTargetPreview();
  bindDetailEvents();
  bindHoldingDetailEvents();
  bindImportEvents();
}

/* ---------------- 监控批量导入支持 ---------------- */
function bindImportEvents() {
  document.querySelectorAll('[data-open-import]').forEach((b) =>
    b.addEventListener('click', async () => {
      openImport();
      await loadWatches({ silent: true });
    })
  );
  document.querySelectorAll('[data-close-import]').forEach((b) => b.addEventListener('click', closeImport));
  $('#impTemplate').addEventListener('click', downloadImpTemplate);
  $('#impParse').addEventListener('click', async () => {
    const text = $('#impPaste').value;
    if (text.trim()) await parseImportText(text);
  });
  $('#impBack').addEventListener('click', () => impSwitchStep(1));
  $('#impConfirm').addEventListener('click', confirmImport);
  $('#impDone').addEventListener('click', async () => {
    closeImport();
    switchView('watches');
    await manualRefresh();
  });
}

const imp = { step: 1, rows: [], importing: false };
function openImport() {
  imp.rows = [];
  imp.importing = false;
  $('#impPaste').value = '';
  $('#impHint').textContent = '';
  impSwitchStep(1);
  $('#importModal').hidden = false;
}
function closeImport() { $('#importModal').hidden = true; }
function impSwitchStep(n) {
  imp.step = n;
  $('#impStep1').hidden = n !== 1;
  $('#impStep2').hidden = n !== 2;
  $('#impStep3').hidden = n !== 3;
}
function downloadImpTemplate() {
  const content = ['类型,代码,名称,买入价格,卖出价格,开启监控', '股票,601137,博威合金,18,21,是'].join('\r\n');
  downloadTextFile('investment_monitor_template.csv', '\uFEFF' + content);
}
async function parseImportText(text) {
  const lines = readImpLines(text);
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const cells = splitImpLine(lines[i]);
    if (!cells.length || cells.every((c) => !c)) continue;
    rows.push({
      type: normImpType(cells[0]) || 'stock',
      code: normImpCode(cells[1]),
      name: cells[2] || cells[1],
      buy: parseFloat(cells[3]) || null,
      sell: parseFloat(cells[4]) || null,
      enabled: parseImpEnabled(cells[5]),
      status: 'ok',
    });
  }
  imp.rows = rows;
  $('#impStats').innerHTML = `<span class="imp-chip ok">共 ${rows.length} 条</span>`;
  $('#impTbody').innerHTML = rows.map((r) => `<tr><td>✅</td><td>${r.type}</td><td>${r.code}</td><td>${r.name}</td><td>${r.buy||'—'}</td><td>${r.sell||'—'}</td><td>${r.enabled?'是':'否'}</td><td class="note">—</td></tr>`).join('');
  impSwitchStep(2);
}
async function confirmImport() {
  const payloadRows = imp.rows.map((r) => ({ type: r.type, code: r.code, name: r.name, buyPrice: r.buy, sellPrice: r.sell, enabled: r.enabled }));
  try {
    await call('ths-import-watches', { rows: payloadRows, duplicateStrategy: 'skip' });
    $('#impResult').innerHTML = `<p class="big">✅ 导入完成</p><p>成功处理：${payloadRows.length} 条</p>`;
    impSwitchStep(3);
  } catch (e) {
    toast(`导入失败：${e.message}`);
  }
}

function normImpType(v) {
  const s = String(v || '').trim().toLowerCase();
  if (s === '股票' || s === 'stock') return 'stock';
  if (s === 'etf') return 'etf';
  return null;
}
function normImpCode(raw) {
  let s = String(raw == null ? '' : raw).replace(/["'\s]/g, '').toUpperCase();
  s = s.replace(/\.(SH|SZ|BJ)$/, '').replace(/^(SH|SZ|BJ)(?=\d{6}$)/, '');
  return /^\d{6}$/.test(s) ? s : null;
}
function parseImpEnabled(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s || ['是', 'y', 'yes', 'true', '1'].includes(s)) return true;
  return false;
}
function splitImpLine(line) {
  const delim = line.includes(',') ? ',' : '\t';
  return line.split(delim).map((s) => s.trim().replace(/^"|"$/g, ''));
}
function readImpLines(text) {
  const lines = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length && /类型|代码|名称/.test(lines[0])) lines.shift();
  return lines;
}
function impToThsCode(type, code) {
  if (type === 'stock') {
    if (/^(60|68)/.test(code)) return code + '.SH';
    if (/^(00|30)/.test(code)) return code + '.SZ';
    if (/^(43|83|87|92)/.test(code)) return code + '.BJ';
  }
  if (type === 'etf') {
    if (/^5/.test(code)) return code + '.SH';
    if (/^1/.test(code)) return code + '.SZ';
  }
  return null;
}
function downloadTextFile(filename, content) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 300);
}

/* ---------------- 启动 ---------------- */
async function boot() {
  try {
    const savedSettings = localStorage.getItem('ths_user_settings');
    if (savedSettings) {
      try { Object.assign(state.settings, JSON.parse(savedSettings)); } catch (_) {}
    }
    const sdk = window.cloudbase && (window.cloudbase.default || window.cloudbase);
    state.app = sdk.init({
      env: ENV_ID,
      region: REGION,
      accessKey: ACCESS_KEY,
      auth: { detectSessionInUrl: true },
    });
    await ensureLogin();
    bindEvents();
    $('#boot').hidden = true;
    $('#root').hidden = false;
    await Promise.all([loadWatches(), loadPortfolio(), loadMarketOverview()]);
    setInterval(() => {
      if (document.visibilityState === 'visible') {
        if (state.view === 'watches') loadWatches({ silent: true });
        if (state.view === 'portfolio') loadPortfolio({ silent: true });
      }
    }, 30000);
  } catch (e) {
    const bootEl = $('#boot');
    bootEl.innerHTML = `<div style="text-align:center;padding:0 30px">
      <p style="font-size:17px;font-weight:600;margin-bottom:8px">初始化失败</p>
      <p style="font-size:14px;color:#6e6e73;line-height:1.6">${esc(e.message)}</p>
    </div>`;
  }
}

boot();
