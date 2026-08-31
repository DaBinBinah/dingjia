/**
 * 我的投资监控 —— 前端逻辑
 * 架构：浏览器 → CloudBase 云函数（匿名登录）→ 同花顺 API（Key 只在服务端）
 * 本文件不含任何第三方 API Key；publishable key 是 CloudBase 设计上可公开的匿名凭据。
 */
'use strict';

/* ---------------- 云环境配置 ---------------- */
const ENV_ID = 'REDACTED_CLOUDBASE_ENV_ID';
const REGION = 'ap-shanghai';
// publishable key（匿名作用域的公开凭据，非密钥）
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

/* ---------------- 全局状态 ---------------- */
const state = {
  app: null,
  watches: [],
  alerts: [],
  alertFilter: 'all',
  alertOffset: 0,
  alertHasMore: false,
  stats: null,
  meta: null, // phase / scanState / settings
  view: 'watches',
  watchFilter: 'all', // 列表筛选：all 全部 / active 进行中 / done 已达成
  editingId: null, // null=新增
  formManBuy: false, // 表单中买入价格行被手动改过（停止目标价自动换算）
  formManSell: false,
  confirmAction: null,
  refreshBusy: false,
  perf: {}, // thsCode -> {y2025,y2026,...} 首页批量 YTD（mode=perf）
  detailId: null, // 详情页当前标的 _id
  histPeriod: 'day',
  histRange: 'all',
  histCustom: { from: null, to: null }, // 自定义区间（YYYY-MM-DD）
};

const $ = (sel) => document.querySelector(sel);

/* ---------------- 工具函数 ---------------- */
function fmtPrice(v, type) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v.toFixed(type === 'etf' ? 3 : 2);
}
/** 折扣输入统一转小数倍率：0.9 / 90 都表示 0.90；非法返回 null（百分比 ≤ 500%） */
function parseDiscount(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = n > 2 ? n / 100 : n;
  if (d > 5) return null;
  return Math.round(d * 10000) / 10000;
}
/** 目标价 × 折扣 → 价格行（买入价 / 卖出价）；任一缺省或非法返回 null */
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
/** 折扣倍率 → 相对目标价涨跌幅文案（0.9 → "-10.00%"；1.1 → "+10.00%"） */
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
/** 北京时区 YYYY-MM-DD（date_ms 为 UTC 毫秒） */
function fmtDate(ms) {
  const d = new Date((ms || 0) + 8 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
/** 北京时区 ISO 周键（周跨年归属正确） */
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
  } catch (_) { /* 忽略，走匿名登录 */ }
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
    renderWatches();
    renderStatus();
    if (!silent) $('#stats').hidden = false;
  } catch (e) {
    if (!silent) toast(`加载失败：${e.message}`);
    renderStatus({ error: e.message });
  }
}

/** 手动刷新：强制扫描一次（含非交易时间），然后重拉列表 */
async function manualRefresh() {
  if (state.refreshBusy) return;
  state.refreshBusy = true;
  const btn = $('#refreshBtn');
  btn.classList.add('spinning');
  try {
    const r = await call('ths-check-market', { force: true });
    if (r && r.ok) {
      const n = r.scanned != null ? r.scanned : 0;
      const a = r.alertsCreated || 0;
      toast(a > 0 ? `已刷新，新增 ${a} 条提醒` : '已刷新', 1500);
    } else if (r && r.error) {
      toast(`刷新失败：${r.error}`);
    }
  } catch (e) {
    toast(`刷新失败：${e.message}`);
  } finally {
    await loadWatches({ silent: true });
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

/* ---------------- 渲染 ---------------- */
function renderStats() {
  const s = state.stats;
  if (!s) return;
  $('#statMonitoring').textContent = s.monitoring;
  $('#statAlerts').textContent = s.alertsToday == null ? '—' : s.alertsToday;
  $('#statBuy').textContent = s.buyOpportunities;
  $('#statSell').textContent = s.sellOpportunities;
  $('#stats').hidden = false;
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

function lineState(w, side) {
  // 返回某条价格线的展示状态 {cls, text}
  const line = side === 'buy' ? w.buyPrice : w.sellPrice;
  if (line == null) return null;
  if (typeof w.currentPrice !== 'number') return { cls: 'st-wait', text: '待行情' };
  const price = w.currentPrice;
  if (side === 'buy') {
    if (price <= line) return { cls: 'st-ok-buy', text: '已达到买入价格' };
    const diff = price - line;
    return { cls: 'st-near-buy', text: `距买入 ¥${fmtPrice(diff, w.type)}（${((diff / price) * 100).toFixed(1)}%）` };
  }
  if (price >= line) return { cls: 'st-ok-sell', text: '已达到卖出价格' };
  const diff = line - price;
  return { cls: 'st-near-sell', text: `距卖出 ¥${fmtPrice(diff, w.type)}（${((diff / price) * 100).toFixed(1)}%）` };
}

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
    if (watchFilter !== 'all') {
      $('#emptyTitle').textContent = watchFilter === 'done' ? '还没有已达成标的' : '没有进行中的监控';
      $('#emptySub').textContent = watchFilter === 'done' ? '价格线触发过的标的会出现在这里' : '「全部」标签页查看所有监控';
    } else {
      $('#emptyTitle').textContent = '还没有监控标的';
      $('#emptySub').innerHTML = '添加股票或 ETF，设置价格线，<br>跌破 / 突破时自动提醒你';
    }
    return;
  }
  empty.hidden = true;

  list.innerHTML = watches
    .map((w) => {
      const priceStr = fmtPrice(w.currentPrice, w.type);
      const pct = fmtPct(w.changePercent);
      const pctCls = w.changePercent == null ? 'flat' : w.changePercent > 0 ? 'up' : w.changePercent < 0 ? 'down' : 'flat';
      const inBuy = w.buyPrice != null && w.currentPrice != null && w.currentPrice <= w.buyPrice;
      const inSell = w.sellPrice != null && w.currentPrice != null && w.currentPrice >= w.sellPrice;
      const cardCls = ['card'];
      if (!w.enabled) cardCls.push('paused');
      else if (w.enabled && (w.buyAchievedAt || w.sellAchievedAt)) cardCls.push('done');
      else if (w.enabled && inBuy) cardCls.push('triggered-buy');
      else if (w.enabled && inSell) cardCls.push('triggered-sell');

      let badge = '';
      if (w.enabled && (w.buyAchievedAt || w.sellAchievedAt)) badge = '<span class="chip chip-done">🏁 已达成</span>';
      else if (w.enabled && inBuy) badge = '<span class="chip chip-buy">🔔 已达到买入价格</span>';
      else if (w.enabled && inSell) badge = '<span class="chip chip-sell">🔔 已达到卖出价格</span>';
      else if (!w.enabled) badge = '<span class="chip chip-off">已暂停</span>';
      else badge = '<span class="chip chip-on">监控中</span>';

      const ytdKey = w.type === 'etf' || w.type === 'stock' ? impToThsCode(w.type, w.code) : null;
      const ytd = ytdKey ? state.perf[ytdKey] : null;
      const ytdRow = ytd && (ytd.y2025 != null || ytd.y2026 != null)
        ? `<div class="ytd-row">${[2025, 2026].map((yy) => {
            const v = ytd['y' + yy];
            const cls = v == null ? 'flat' : v >= 0 ? 'up' : 'down';
            return `<span class="ytd-item ${cls}">${yy}年-至今 ${v == null ? '—' : fmtPct(v)}</span>`;
          }).join('')}</div>`
        : '';

      const buyLine = lineState(w, 'buy');
      const sellLine = lineState(w, 'sell');
      const lines = [];
      if (buyLine) {
        lines.push(
          `<div class="line"><span class="lab">买入 ≤ <b>¥${fmtPrice(w.buyPrice, w.type)}</b></span><span class="st ${buyLine.cls}">${buyLine.text}</span></div>`
        );
      }
      if (sellLine) {
        lines.push(
          `<div class="line"><span class="lab">卖出 ≥ <b>¥${fmtPrice(w.sellPrice, w.type)}</b></span><span class="st ${sellLine.cls}">${sellLine.text}</span></div>`
        );
      }
      const errRow = w.quoteError
        ? `<div class="card-err">⚠️ 行情获取失败：${esc(w.quoteError)}</div>`
        : '';

      return `
        <div class="${cardCls.join(' ')}" data-id="${esc(w._id)}" role="button" tabindex="0">
          <div class="card-top">
            <div style="min-width:0">
              <div class="card-name"><span class="nm">${esc(w.name)}</span>${badge}</div>
              <div class="card-code">${esc(w.code)} · ${w.type === 'etf' ? 'ETF' : '股票'}</div>
            </div>
          </div>
          <div class="card-price-row">
            <span class="card-price ${priceStr == null ? 'na' : ''}">${priceStr == null ? '暂无行情' : `¥${priceStr}`}</span>
            <span class="card-change ${pctCls}">${pct == null ? '' : `${w.changePercent > 0 ? '↑' : w.changePercent < 0 ? '↓' : ''} ${pct}`}</span>
          </div>
          ${ytdRow}
          <div class="lines">${lines.join('')}</div>
          ${errRow}
          <div class="card-time">行情时间 ${esc(fmtTime(w.lastFetchTime, true))}${w.lastBuyAlertTime || w.lastSellAlertTime ? ` ｜ 最近提醒 ${esc(fmtTime(w.lastBuyAlertTime || w.lastSellAlertTime, true))}` : ''}</div>
        </div>`;
    })
    .join('');

  list.querySelectorAll('.card').forEach((el) => {
    const open = () => {
      const w = state.watches.find((x) => x._id === el.dataset.id);
      if (w) openDetail(w);
    };
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  });
}

function renderAlerts() {
  const list = $('#alertList');
  const empty = $('#alertEmpty');
  const more = $('#loadMoreBtn');
  if (!state.alerts.length) {
    list.innerHTML = '';
    empty.hidden = false;
    more.hidden = true;
    return;
  }
  empty.hidden = true;
  more.hidden = !state.alertHasMore;
  list.innerHTML = state.alerts
    .map((a) => {
      const isBuy = a.alertType === 'buy';
      return `
        <div class="alert-item">
          <div class="alert-badge ${isBuy ? 'buy' : 'sell'}">${isBuy ? '🟢' : '🔴'}</div>
          <div class="alert-main">
            <div class="alert-title">${esc(a.name)}<span class="tag ${isBuy ? 'buy' : 'sell'}">${isBuy ? '买入' : '卖出'}提醒</span></div>
            <div class="alert-sub">${esc(a.code)} · 现价 ¥${fmtPrice(a.currentPrice, a.type) == null ? '—' : fmtPrice(a.currentPrice, a.type)} · 阈值 ¥${fmtPrice(a.triggerPrice, a.type) == null ? '—' : fmtPrice(a.triggerPrice, a.type)}</div>
          </div>
          <div class="alert-time">${esc(fmtTime(a.createdAt, true))}</div>
        </div>`;
    })
    .join('');
}

/* ---------------- 表单 ---------------- */
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
        box.className = 'hint';
        return;
      }
      const pct = fmtPct(r.changePercent);
      box.textContent = `当前价 ¥${fmtPrice(r.price, currentType())}${pct ? ` · ${pct}` : ''}`;
      box.className = 'hint ok';
      if (!$('#fName').value.trim() && r.name) $('#fName').value = r.name;
    } catch (e) {
      box.textContent = '';
    }
  }, 420);
}

/* ---------------- 年度表现（mode=perf 批量预载） ---------------- */
const detailCache = {}; // `${type}:${code}` -> ths-get-history detail 响应（会话级缓存）
let perfLoadedKey = null; // 已拉取过 perf 的标的指纹（当日有效，列表变化后自动重拉）

/** 首页批量 YTD：同一列表只拉一次，不随 30s 轮询重复；手动刷新前会重置指纹 */
async function refreshPerf() {
  const list = state.watches.map((w) => ({ type: w.type, code: w.code }));
  const key = list.map((x) => `${x.type}:${x.code}`).join(',');
  if (!list.length || key === perfLoadedKey) return;
  perfLoadedKey = key; // 先占位：无论成败，本轮列表不再重复请求
  try {
    const r = await call('ths-get-history', { mode: 'perf', list });
    if (!r || !r.ok) throw new Error((r && r.error) || '未知错误');
    const perf = {};
    for (const w of list) {
      const t = w.type === 'etf' || w.type === 'stock' ? impToThsCode(w.type, w.code) : null;
      if (t && r.perf && r.perf[t] && (r.perf[t].y2025 != null || r.perf[t].y2026 != null)) {
        perf[t] = r.perf[t];
      }
    }
    state.perf = perf;
    renderWatches();
  } catch (_) {
    // 静默失败：卡片 YTD 行保持隐藏，不影响主流程
  }
}

/* ---------------- 详情页（无 K 线） ---------------- */
function findDetailWatch() {
  return state.watches.find((w) => w._id === state.detailId) || null;
}

function openDetail(watch) {
  state.detailId = watch._id;
  switchView('detail');
  renderDetail();
  renderHistContent();
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
}

/** 详情页目标价 × 折扣块；未设置目标价则隐藏 */
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
    <p class="hint">${parts.join(' ｜ ')}</p>
    ${w.buyAchievedAt ? `<p class="hint">✅ 买入线已达（${fmtDate(w.buyAchievedAt)}）</p>` : ''}
    ${w.sellAchievedAt ? `<p class="hint">✅ 卖出线已达（${fmtDate(w.sellAchievedAt)}）</p>` : ''}`;
  box.hidden = false;
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
    return `<div class="dist-card ${side}"><div class="dist-label">${label} <b>¥${fmtPrice(line, w.type)}</b></div><div class="dist-val ok-${side}">✅ 已达到${label}</div></div>`;
  }
  const diff = Math.abs(line - w.currentPrice);
  const pct = (diff / w.currentPrice) * 100;
  return `<div class="dist-card ${side}"><div class="dist-label">${label} <b>¥${fmtPrice(line, w.type)}</b></div><div class="dist-val near-${side}">${side === 'buy' ? '🟢' : '🟠'} 距${label} ¥${fmtPrice(diff, w.type)}（${pct.toFixed(1)}%）</div></div>`;
}

async function loadDetailData() {
  const w = findDetailWatch();
  if (!w) return null;
  const ckey = `${w.type}:${w.code}`;
  if (detailCache[ckey]) {
    renderMetrics(detailCache[ckey]);
    return detailCache[ckey];
  }
  const r = await call('ths-get-history', { mode: 'detail', type: w.type, code: w.code });
  if (!r || !r.ok) throw new Error((r && r.error) || '加载历史失败');
  detailCache[ckey] = r;
  renderMetrics(r);
  return r;
}

function renderMetrics(data) {
  const y25 = data ? data.y2025 : null;
  const y26 = data ? data.y2026 : null;
  const m25 = $('#metricY2025');
  m25.textContent = y25 == null ? '—' : fmtPct(y25);
  m25.className = y25 == null ? 'flat' : y25 >= 0 ? 'up' : 'down';
  const m26 = $('#metricY2026');
  m26.textContent = y26 == null ? '—' : fmtPct(y26);
  m26.className = y26 == null ? 'flat' : y26 >= 0 ? 'up' : 'down';
}

/** 周期聚合键（北京时区）；day 不走此函数 */
function periodKey(period, ms) {
  const d = new Date(ms + 8 * 3600 * 1000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  if (period === 'year') return `${y}`;
  if (period === 'quarter') return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
  if (period === 'month') return `${y}-${pad(m)}`;
  return isoWeekKey(ms); // week
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
      return 0; // all
  }
}

function histToTs() {
  if (state.histRange === 'custom' && state.histCustom && state.histCustom.to) {
    return new Date(`${state.histCustom.to}T23:59:59Z`).getTime();
  }
  return Infinity;
}

/** 先按区间过滤，再去重聚合为周期行（升序返回） */
function histRows(items) {
  const from = histFromTs();
  const to = histToTs();
  const period = state.histPeriod;
  const inRange = (items || []).filter((it) => it.d >= from && it.d <= to);
  if (!inRange.length) return [];
  if (period === 'day') return inRange;
  const groups = new Map();
  for (const it of inRange) {
    groups.set(periodKey(period, it.d), it); // 升序遍历 → 每组末尾即周期收盘
  }
  return [...groups.values()];
}

function renderHistTable(rows) {
  const body = $('#histBody');
  const empty = $('#histEmpty');
  if (!rows.length) {
    body.innerHTML = '';
    empty.textContent = '该区间暂无数据';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  const desc = rows.slice().reverse(); // 表格按日期降序
  body.innerHTML = desc
    .map((it, i) => {
      const prev = desc[i + 1]; // 逆序中的下一位 = 更早一期
      const diff = prev ? it.c - prev.c : null;
      const pct = prev && prev.c > 0 ? (diff / prev.c) * 100 : null;
      const cls = diff == null ? 'flat' : diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';
      const chgCell = diff == null
        ? '<td class="flat">—</td>'
        : `<td class="${cls}">${diff > 0 ? '+' : ''}${diff.toFixed(2)}</td>`;
      const pctCell = pct == null
        ? '<td class="flat">—</td>'
        : `<td class="${cls}">${pct > 0 ? '+' : ''}${pct.toFixed(2)}%</td>`;
      return `<tr><td class="d">${esc(fmtDate(it.d))}</td><td>${it.c.toFixed(2)}</td>${chgCell}${pctCell}</tr>`;
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
        // 首次进入自定义：预填近一年
        const now = new Date(Date.now() + 8 * 3600 * 1000);
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
    // 同步高亮"自定义"段
    document.querySelectorAll('#histRange button').forEach((x) =>
      x.classList.toggle('on', x.dataset.range === 'custom')
    );
    state.histRange = 'custom';
    $('#histCustom').hidden = false;
    renderHistContent();
  });
}

function openForm(watch) {
  state.editingId = watch ? watch._id : null;
  $('#formTitle').textContent = watch ? '编辑监控' : '添加监控';
  $('#deleteBtn').hidden = !watch;
  $('#formError').hidden = true;
  $('#pricePreview').textContent = '';
  $('#pricePreview').className = 'hint';

  setType(watch ? watch.type : 'stock');
  $('#fCode').value = watch ? watch.code : '';
  $('#fName').value = watch ? watch.name : '';
  $('#fBuy').value = watch && watch.buyPrice != null ? watch.buyPrice : '';
  $('#fSell').value = watch && watch.sellPrice != null ? watch.sellPrice : '';
  $('#fEnabled').checked = watch ? !!watch.enabled : true;
  // 目标价 × 折扣回填（不存在或无效则留空）
  $('#fTarget').value = watch && watch.targetPrice != null ? watch.targetPrice : '';
  $('#fBuyD').value = watch && watch.buyDiscount != null ? Math.round(watch.buyDiscount * 100) : '';
  $('#fSellD').value = watch && watch.sellDiscount != null ? Math.round(watch.sellDiscount * 100) : '';
  // 每次打开重置「手动锁定」标记，避免上次编辑状态残留
  state.formManBuy = false;
  state.formManSell = false;
  // 记录回填时的价格行原值：只要用户没手动改过、且价格行仍等于原值，改目标/折扣就自动重算
  state.formBaseBuy = (watch && watch.buyPrice != null ? watch.buyPrice : '').toString();
  state.formBaseSell = (watch && watch.sellPrice != null ? watch.sellPrice : '').toString();

  $('#formModal').hidden = false;
  if (watch) schedulePreview();
}

/** 目标价 × 折扣自动换算：目标/折扣变化时重算价格行（手动改过价格行后停止联动） */
function bindTargetPreview() {
  const recalc = () => {
    const r = calcTargetPrices();
    const hint = $('#targetHint');
    if (!r) {
      hint.textContent = '';
      return;
    }
    hint.textContent = `→ 买入 ${fmtPrice(r.buy)} ｜ 卖出 ${fmtPrice(r.sell)}`;
    if (!state.formManBuy && $('#fBuy').value.trim() === state.formBaseBuy) $('#fBuy').value = fmtPrice(r.buy);
    if (!state.formManSell && $('#fSell').value.trim() === state.formBaseSell) $('#fSell').value = fmtPrice(r.sell);
  };
  ['fTarget', 'fBuyD', 'fSellD'].forEach((id) => $('#' + id).addEventListener('input', recalc));
  $('#fBuy').addEventListener('input', () => { state.formManBuy = true; $('#targetHint').textContent = ''; });
  $('#fSell').addEventListener('input', () => { state.formManSell = true; $('#targetHint').textContent = ''; });
}

function closeModals() {
  $('#formModal').hidden = true;
  $('#confirmModal').hidden = true;
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
    if (state.view === 'detail') {
      const w = findDetailWatch();
      if (w) {
        delete detailCache[`${w.type}:${w.code}`];
        renderDetail();
        renderHistContent();
      }
    }
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

function askDelete(watch) {
  $('#confirmText').textContent = `确定删除「${watch.name}（${watch.code}）」的监控吗？历史提醒记录将保留。`;
  $('#confirmModal').hidden = false;
  state.confirmAction = async () => {
    try {
      const r = await call('ths-delete-watch', { _id: watch._id });
      if (!r || !r.ok) throw new Error((r && r.error) || '未知错误');
      closeModals();
      toast('已删除');
      if (state.view === 'detail') switchView('watches');
      else await loadWatches({ silent: true });
    } catch (e) {
      closeModals();
      toast(`删除失败：${e.message}`);
    }
  };
}

/* ---------------- 视图切换与事件 ---------------- */
function switchView(view) {
  state.view = view;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.view === view));
  $('#viewWatches').hidden = view !== 'watches';
  $('#viewAlerts').hidden = view !== 'alerts';
  $('#viewDetail').hidden = view !== 'detail';
  document.body.classList.toggle('detail-open', view === 'detail');
  if (view === 'alerts') loadAlerts();
  if (view === 'watches') loadWatches({ silent: true });
}

function bindEvents() {
  document.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => switchView(t.dataset.view))
  );
  document.querySelectorAll('[data-open-add]').forEach((b) =>
    b.addEventListener('click', () => openForm(null))
  );
  $('#refreshBtn').addEventListener('click', manualRefresh);
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModals));
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
  $('#confirmOk').addEventListener('click', () => {
    if (state.confirmAction) state.confirmAction();
    state.confirmAction = null;
  });
  document.querySelectorAll('#alertFilter button').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('#alertFilter button').forEach((x) => x.classList.toggle('on', x === b));
      state.alertFilter = b.dataset.filter;
      loadAlerts();
    })
  );
  document.querySelectorAll('#watchFilter button').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('#watchFilter button').forEach((x) => x.classList.toggle('on', x === b));
      state.watchFilter = b.dataset.filter;
      renderWatches();
    })
  );
  bindTargetPreview();
  $('#loadMoreBtn').addEventListener('click', () => loadAlerts({ append: true }));
  document.querySelectorAll('.modal').forEach((m) =>
    m.addEventListener('click', (e) => {
      // 批量导入弹窗点遮罩不关闭，避免误触丢失已解析的数据
      if (e.target === m && m.id !== 'codeModal' && m.id !== 'importModal') closeModals();
    })
  );
  bindDetailEvents();
  bindImportEvents();
}

/* ---------------- 批量导入：事件绑定与入口 ---------------- */
function bindImportEvents() {
  document.querySelectorAll('[data-open-import]').forEach((b) =>
    b.addEventListener('click', async () => {
      openImport();
      // 打开时静默刷新一次列表，保证"数据库重复"预览标记基于最新数据
      await loadWatches({ silent: true });
    })
  );
  document.querySelectorAll('[data-close-import]').forEach((b) => b.addEventListener('click', closeImport));
  $('#impTemplate').addEventListener('click', downloadImpTemplate);

  const drop = $('#impDrop');
  const fileInput = $('#impFile');
  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('dragover');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) impHandleFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files[0]) impHandleFile(fileInput.files[0]);
  });

  $('#impParse').addEventListener('click', async () => {
    if (fileInput.files && fileInput.files[0]) {
      await impHandleFile(fileInput.files[0]);
    } else {
      const text = $('#impPaste').value;
      if (!text.trim()) {
        $('#impHint').textContent = '请先选择 CSV 文件，或把数据粘贴到文本框';
        return;
      }
      await parseImportText(text);
    }
  });

  $('#impBack').addEventListener('click', () => impSwitchStep(1));
  $('#impConfirm').addEventListener('click', confirmImport);
  $('#impErrors').addEventListener('click', downloadImpErrors);
  $('#impDone').addEventListener('click', async () => {
    closeImport();
    switchView('watches');
    await manualRefresh();
  });

  document.querySelectorAll('#impDupStrategy button').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('#impDupStrategy button').forEach((x) => x.classList.toggle('on', x === b));
    })
  );
  document.querySelectorAll('#impFileDup button').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('#impFileDup button').forEach((x) => x.classList.toggle('on', x === b));
      if (imp.lines.length) reclassifyImport(b.dataset.v);
    })
  );
}

/* ---------------- 启动 ---------------- */
async function boot() {
  try {
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
    await loadWatches();
    // 页面可见期间每 30 秒静默刷新列表（数据由云端定时器维护）
    setInterval(() => {
      if (document.visibilityState === 'visible' && state.view === 'watches') {
        loadWatches({ silent: true });
      }
    }, 30000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.view === 'watches') loadWatches({ silent: true });
    });
  } catch (e) {
    const bootEl = $('#boot');
    bootEl.innerHTML = `<div style="text-align:center;padding:0 30px">
      <p style="font-size:17px;font-weight:600;margin-bottom:8px">初始化失败</p>
      <p style="font-size:14px;color:#6e6e73;line-height:1.6">${esc(e.message)}</p>
      <p style="font-size:13px;color:#aeaeb2;margin-top:10px">请刷新重试；若持续失败请检查 CloudBase 匿名登录配置</p>
    </div>`;
  }
}

boot();

/* ================= 批量导入 ================= */
/* 流程：文件/粘贴 → 本地解析与校验 → 导入预览（绝不直接入库）→ 用户确认 → 分批调用
   ths-import-watches（服务端会再做一遍完整校验，与单个添加同规则、同数据集合）。 */
const imp = {
  step: 1,
  lines: [], // 原始解析行（切换文件内重复策略时重放分类）
  rows: [], // 分类后的每一行 {lineNo, type, code, name, buy, sell, enabled, status, dupKind, errors, notes}
  hasFileDup: false,
  importing: false,
  nameCache: {}, // code -> 已获取的名称（避免重复请求代码表）
  serverFailed: [], // 服务端阶段失败行（用于错误记录导出）
};

const IMP_CONST = {
  MAX_ROWS: 1000,
  NAME_CAP: 40, // 预览阶段自动补名称的最大条数，超出用代码代替
  SEND_CHUNK: 200, // 确认导入时每次请求的行数（控制调用负载）
};

function normImpType(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return '';
  if (s === '股票' || s === 'stock') return 'stock';
  if (s === 'etf') return 'etf';
  return null; // 非法
}

function normImpCode(raw) {
  let s = String(raw == null ? '' : raw);
  s = s.replace(/["'\s]/g, '');
  // 全角数字/点转半角
  s = s.replace(/[０-９．]/g, (c) => (c === '．' ? '.' : String.fromCharCode(c.charCodeAt(0) - 0xfee0)));
  s = s.toUpperCase();
  s = s.replace(/\.(SH|SZ|BJ)$/, '').replace(/^(SH|SZ|BJ)(?=\d{6}$)/, '');
  return /^\d{6}$/.test(s) ? s : null;
}

function parseImpPrice(raw) {
  const t = String(raw == null ? '' : raw).trim();
  if (!t) return { value: null };
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0 || n >= 1000000) return { value: undefined };
  return { value: Math.round(n * 10000) / 10000 };
}

function parseImpEnabled(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) return true; // 留空默认开启
  if (['是', 'y', 'yes', 'true', '1', '开'].includes(s)) return true;
  if (['否', 'n', 'no', 'false', '0', '关'].includes(s)) return false;
  return null; // 非法
}

/** 引号感知的行切分，分隔符按行自动识别：逗号 / 制表符（Excel 直接粘贴） */
function splitImpLine(line) {
  const delim = line.includes(',') ? ',' : line.includes('\t') ? '\t' : '\u0001';
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** 文本 → 行数组（去 BOM/空行/表头） */
function readImpLines(text) {
  const lines = String(text)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  // 表头识别：首行包含"类型/代码"等字段名时跳过
  if (lines.length && /类型|代码|名称|买入/.test(lines[0]) && !/^["']?\d{6}/.test(lines[0].replace(/^股票|ETF/i, ''))) {
    lines.shift();
  }
  return lines;
}

/** 单行 → 归一化数据或错误 */
function buildImpRow(lineNo, rawLine) {
  const cells = splitImpLine(rawLine).map((c) => c.replace(/，/g, ',').trim());
  if (!cells.length || cells.every((c) => !c)) return null;

  const row = { lineNo, type: '', code: '', name: '', buy: null, sell: null, enabled: true, status: 'ok', dupKind: null, errors: [], notes: [] };

  // 类型列可省略（首列直接是代码时自动识别）
  let rest = cells;
  const t = normImpType(cells[0]);
  if (t === null) {
    row.errors.push('类型必须为 股票 或 ETF');
    row.status = 'error';
    rest = cells.slice(1);
  } else if (t) {
    row.type = t;
    rest = cells.slice(1);
  }

  const codeRaw = rest[0];
  const code = normImpCode(codeRaw);
  if (!code) {
    row.errors.push(codeRaw ? '代码必须为有效的 6 位股票 / ETF 代码' : '缺少代码');
  } else {
    row.code = code;
    // 类型为空时按代码前缀自动识别（与系统现有市场规则一致）
    if (!row.type) {
      const probe = impDetectType(code);
      if (!probe) {
        row.errors.push('无法确定证券类型：代码不属于已支持的股票 / ETF 号段');
      } else {
        row.type = probe;
      }
    } else {
      // 校验类型与号段匹配（与单个添加同一规则）
      const ths = impToThsCode(row.type, code);
      if (!ths) row.errors.push('类型与代码不匹配（或市场号段无法识别）');
    }
  }

  const nameRaw = rest[1] != null ? rest[1] : '';
  row.name = String(nameRaw).replace(/^"|"$/g, '').trim().slice(0, 30);

  const buy = parseImpPrice(rest[2]);
  const sell = parseImpPrice(rest[3]);
  if (buy.value === undefined) row.errors.push('买入价格必须是数字且大于 0（如 20.00）');
  else row.buy = buy.value;
  if (sell.value === undefined) row.errors.push('卖出价格必须是数字且大于 0（如 28.00）');
  else row.sell = sell.value;

  const en = parseImpEnabled(rest[4]);
  if (en === null) row.errors.push('开启监控必须为 是 或 否');
  else row.enabled = en;

  if (row.buy != null && row.sell != null && row.buy >= row.sell) {
    row.notes.push('买入价格应低于卖出价格（已按你填写的数据保存）');
  }

  if (row.errors.length) row.status = 'error';
  return row;
}

// 与服务端 lib/ths-api.js 完全一致的市场号段规则
function impToThsCode(type, code) {
  if (type === 'stock') {
    if (/^(60|68)/.test(code)) return code + '.SH';
    if (/^(00|30)/.test(code)) return code + '.SZ';
    if (/^(43|83|87|92)/.test(code)) return code + '.BJ';
    return null;
  }
  if (type === 'etf') {
    if (/^5/.test(code)) return code + '.SH';
    if (/^1/.test(code)) return code + '.SZ';
    return null;
  }
  return null;
}
function impDetectType(code) {
  if (impToThsCode('stock', code)) return 'stock';
  if (impToThsCode('etf', code)) return 'etf';
  return null;
}

/** 解析入口：文本 → 保存原始行 → 分类 → 预览 */
async function parseImportText(text) {
  const lines = readImpLines(text);
  if (!lines.length) {
    $('#impHint').textContent = '没有解析到有效内容，请检查格式';
    return;
  }
  if (lines.length > IMP_CONST.MAX_ROWS) {
    $('#impHint').textContent = `一次最多 ${IMP_CONST.MAX_ROWS} 条，当前 ${lines.length} 条，请拆分后导入`;
    return;
  }
  $('#impHint').textContent = '正在解析与校验…';
  imp.lines = lines;
  await reclassifyImport('last');
}

/** 完整分类流程（切换文件内重复策略时重放）：build → 文件内去重 → DB 重复标记 → 名称补全 → 预览 */
async function reclassifyImport(fileDupMode) {
  const rows = [];
  imp.lines.forEach((line, i) => {
    const r = buildImpRow(i + 1, line);
    if (r) rows.push(r);
  });

  // 文件内部重复：按代码分组，默认使用最后一条
  applyFileDupStrategy(rows, fileDupMode);

  // 数据库重复标记（预览用；服务端确认时会再查一遍库）。文件内部重复行不再叠加数据库标记。
  const dbCodes = new Set(state.watches.map((w) => w.code));
  for (const r of rows) {
    if (r.status !== 'error' && r.dupKind !== 'file' && dbCodes.has(r.code)) {
      r.dupKind = 'db';
      r.status = 'dup';
      r.notes.push('数据库中已存在该监控');
    }
  }

  imp.rows = rows;
  imp.hasFileDup = (() => {
    const counts = {};
    for (const r of rows) if (r.status !== 'error') counts[r.code] = (counts[r.code] || 0) + 1;
    return Object.values(counts).some((n) => n > 1);
  })();

  // 已获取过的名称直接复用，避免重复请求
  for (const r of rows) {
    if (r.status !== 'error' && !r.name && imp.nameCache[r.code]) r.name = imp.nameCache[r.code];
  }

  if (rows.some((r) => r.status !== 'error' && !r.name)) {
    impHintProgress('正在自动获取缺失的名称…');
    await resolveImpNames(rows);
  }
  $('#impHint').textContent = '';
  renderImpPreview();
}

/** 文件内部重复策略：last=使用最后一条（默认） / first=保留第一条 */
function applyFileDupStrategy(rows, mode) {
  const groups = {};
  for (const r of rows) {
    if (r.status === 'error' || !r.code) continue;
    (groups[r.code] = groups[r.code] || []).push(r);
  }
  for (const code of Object.keys(groups)) {
    const g = groups[code];
    if (g.length < 2) continue;
    const keepIdx = mode === 'first' ? 0 : g.length - 1;
    g.forEach((r, idx) => {
      if (idx === keepIdx) {
        r.dupKind = null;
        if (r.status === 'dup' && r.dupSource === 'file') { r.status = 'ok'; r.notes = r.notes.filter((n) => !n.includes('文件内部重复')); }
      } else {
        r.dupSource = 'file';
        r.dupKind = 'file';
        r.status = 'dup';
        r.notes = r.notes.filter((n) => !n.includes('文件内部重复'));
        r.notes.push(`文件内部重复，本条未采用（${mode === 'first' ? '保留第一条' : '使用最后一条'}）`);
      }
    });
  }
}

/** 为空名称行自动补名称（走官方代码表搜索；并发 3，上限 40 条，超出用代码代替） */
async function resolveImpNames(rows) {
  const pending = rows.filter((r) => r.status !== 'error' && !r.name);
  const cap = Math.min(pending.length, IMP_CONST.NAME_CAP);
  let done = 0;
  const fetchOne = async (r) => {
    try {
      const res = await call('ths-get-market-price', { type: r.type, code: r.code, nameOnly: true });
      if (res && res.ok && res.name) {
        r.name = res.name;
        imp.nameCache[r.code] = res.name;
      } else {
        r.notes.push('名称自动获取失败，将使用代码作为名称');
      }
    } catch (_) {
      r.notes.push('名称自动获取失败，将使用代码作为名称');
    }
    if (!r.name) r.name = r.code;
    done++;
    impHintProgress(`正在自动获取缺失的名称… ${done}/${cap}`);
  };
  for (let i = 0; i < cap; i += 3) {
    await Promise.all(pending.slice(i, i + 3).map(fetchOne));
  }
  for (let i = cap; i < pending.length; i++) {
    pending[i].name = pending[i].code;
    pending[i].notes.push('名称获取超出单次上限，使用代码代替');
  }
}

function impHintProgress(text) {
  $('#impHint').textContent = text;
}

function renderImpPreview() {
  const rows = imp.rows;
  const ok = rows.filter((r) => r.status === 'ok').length;
  const dup = rows.filter((r) => r.status === 'dup').length;
  const err = rows.filter((r) => r.status === 'error').length;

  $('#impStats').innerHTML = `
    <span class="imp-chip">共 ${rows.length} 条</span>
    <span class="imp-chip ok">✅ 正确 ${ok}</span>
    <span class="imp-chip dup">⚠️ 重复 ${dup}</span>
    <span class="imp-chip err">❌ 错误 ${err}</span>`;

  $('#impFileDupField').hidden = !imp.hasFileDup;

  const typeLabel = (r) => (r.type === 'etf' ? 'ETF' : r.type === 'stock' ? '股票' : '—');
  const enabledLabel = (r) => (r.status === 'error' ? '—' : r.enabled ? '是' : '否');
  const stCell = (r) =>
    r.status === 'ok' ? '<span class="st-ok">✅</span>' : r.status === 'dup' ? '<span class="st-dup">⚠️</span>' : '<span class="st-err">❌</span>';
  const noteCell = (r) => {
    const parts = [];
    if (r.errors.length) parts.push(`<span style="color:var(--sell)">${esc(r.errors.join('；'))}</span>`);
    if (r.notes.length) parts.push(`<span class="warn-text">${esc(r.notes.join('；'))}</span>`);
    return parts.join(' ');
  };

  $('#impTbody').innerHTML = rows
    .map(
      (r) => `<tr class="${r.status === 'error' ? 'row-err' : ''}">
      <td>${stCell(r)}</td>
      <td>${typeLabel(r)}</td>
      <td>${esc(r.code || (r.lineNo ? `第${r.lineNo}行` : ''))}</td>
      <td>${esc(r.name || '—')}</td>
      <td>${r.buy != null ? r.buy : '—'}</td>
      <td>${r.sell != null ? r.sell : '—'}</td>
      <td>${enabledLabel(r)}</td>
      <td class="note">${noteCell(r) || (r.status === 'ok' ? '—' : '')}</td>
    </tr>`
    )
    .join('');

  const willImport = rows.filter((r) => r.status !== 'error' && r.dupKind !== 'file').length;
  $('#impConfirm').textContent = `确认导入（${willImport} 条）`;
  $('#impConfirm').disabled = willImport === 0;

  impSwitchStep(2);
}

/** 确认导入：分批发送到服务端（服务端会再次完整校验并按策略处理重复） */
async function confirmImport() {
  if (imp.importing) return;
  const payloadRows = imp.rows
    .filter((r) => r.status !== 'error' && r.dupKind !== 'file')
    .map((r) => ({ type: r.type, code: r.code, name: r.name, buyPrice: r.buy, sellPrice: r.sell, enabled: r.enabled }));
  if (!payloadRows.length) return;

  const strategy = $('#impDupStrategy .on').dataset.v;
  imp.importing = true;
  const btn = $('#impConfirm');
  btn.disabled = true;

  const totals = { added: 0, updated: 0, skipped: 0, failed: [] };
  try {
    for (let i = 0; i < payloadRows.length; i += IMP_CONST.SEND_CHUNK) {
      const chunk = payloadRows.slice(i, i + IMP_CONST.SEND_CHUNK);
      const part = Math.floor(i / IMP_CONST.SEND_CHUNK) + 1;
      const parts = Math.ceil(payloadRows.length / IMP_CONST.SEND_CHUNK);
      btn.textContent = parts > 1 ? `导入中 ${part}/${parts}…` : '导入中…';
      const r = await call('ths-import-watches', { rows: chunk, duplicateStrategy: strategy });
      if (!r || !r.ok) throw new Error((r && r.error) || '导入失败');
      totals.added += r.added || 0;
      totals.updated += r.updated || 0;
      totals.skipped += r.skipped || 0;
      if (Array.isArray(r.failed)) totals.failed.push(...r.failed);
    }
    imp.serverFailed = totals.failed;
    renderImpResult(totals);
  } catch (e) {
    toast(`导入失败：${e.message}`);
    btn.disabled = false;
    btn.textContent = '确认导入';
  } finally {
    imp.importing = false;
  }
}

function renderImpResult(totals) {
  const err = totals.failed.length;
  $('#impResult').innerHTML = `
    <p class="big">✅ 导入完成</p>
    <p>成功新增：<span class="ok">${totals.added}</span> 条</p>
    <p>更新已有：<span class="ok">${totals.updated}</span> 条</p>
    <p>跳过重复：<span class="dup">${totals.skipped}</span> 条</p>
    <p>失败：<span class="${err ? 'err' : ''}">${err}</span> 条</p>`;
  $('#impErrors').hidden = err === 0 && !imp.rows.some((r) => r.status === 'error');
  impSwitchStep(3);
}

/** 错误记录导出：预览错误行 + 服务端失败行 → investment_monitor_errors.csv */
function downloadImpErrors() {
  const lines = ['行号,类型,代码,名称,买入价格,卖出价格,错误原因'];
  const typeLabel = (t) => (t === 'etf' ? 'ETF' : t === 'stock' ? '股票' : '');
  for (const r of imp.rows) {
    if (r.status === 'error') {
      lines.push([r.lineNo, typeLabel(r.type), r.code, r.name, r.buy == null ? '' : r.buy, r.sell == null ? '' : r.sell, r.errors.join('；')].map(csvCell).join(','));
    }
  }
  for (const f of imp.serverFailed) {
    const r = imp.rows.find((x) => x.code === String(f.code) && x.status !== 'error');
    lines.push(
      [r ? r.lineNo : '', r ? typeLabel(r.type) : '', f.code, r ? r.name : '', r && r.buy != null ? r.buy : '', r && r.sell != null ? r.sell : '', f.reason]
        .map(csvCell)
        .join(',')
    );
  }
  downloadTextFile('investment_monitor_errors.csv', '\uFEFF' + lines.join('\r\n'));
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadTextFile(filename, content) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 300);
}

function downloadImpTemplate() {
  const content = [
    '类型,代码,名称,买入价格,卖出价格,开启监控',
    '股票,601137,博威合金,18,21,是',
    'ETF,510300,沪深300ETF,3.8,4.2,是',
  ].join('\r\n');
  downloadTextFile('investment_monitor_template.csv', '\uFEFF' + content);
  toast('模板已下载（示例数据仅供参考，不会被导入）');
}

function impSwitchStep(n) {
  imp.step = n;
  $('#impStep1').hidden = n !== 1;
  $('#impStep2').hidden = n !== 2;
  $('#impStep3').hidden = n !== 3;
  $('#impTitle').textContent = n === 2 ? '导入预览' : n === 3 ? '导入结果' : '批量导入';
}

function openImport() {
  imp.rows = [];
  imp.serverFailed = [];
  imp.hasFileDup = false;
  imp.importing = false;
  $('#impPaste').value = '';
  $('#impHint').textContent = '';
  $('#impFile').value = '';
  $('#impConfirm').disabled = false;
  $('#impConfirm').textContent = '确认导入';
  impSwitchStep(1);
  $('#importModal').hidden = false;
}

function closeImport() {
  if (imp.importing) { toast('正在导入，请稍候…'); return; }
  $('#importModal').hidden = true;
}

async function impHandleFile(file) {
  if (!file) return;
  if (!/\.csv$/i.test(file.name)) {
    $('#impHint').textContent = '第一阶段支持 CSV 文件；Excel 请先「另存为 CSV UTF-8」再导入';
    return;
  }
  const text = await file.text();
  await parseImportText(text);
}
