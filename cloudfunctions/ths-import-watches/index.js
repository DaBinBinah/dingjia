/**
 * ths-import-watches —— 批量导入监控标的
 *
 * 与 ths-create-watch 写入同一个集合（ths_watchlist），只是批量录入通道，不引入新表。
 * 服务端对每一行重新做完整校验（不信任客户端预览结果），校验规则与单个添加完全一致。
 *
 * 重复数据处理策略 duplicateStrategy：
 *   skip      跳过重复（默认，不动数据库已有记录）
 *   update    更新已有记录的名称/价格线/启用状态（价格线变化时重置评估状态，与单个编辑一致）
 *   overwrite 全部覆盖：在 update 基础上再重置提醒状态（下次扫描按首次观测规则重新评估）
 *
 * 输入：{ rows: [{type, code, name, buyPrice, sellPrice, enabled}], duplicateStrategy?, accessCode? }
 * 输出：{ ok, added, updated, skipped, failed: [{code, reason}] }
 *
 * 说明：只保存监控配置，不在这里调用行情 API；行情与提醒仍由 ths-check-market 统一处理。
 */
const cloud = require('@cloudbase/node-sdk');
const { toThsCode } = require('./lib/ths-api');
const { normalizeUsSymbol } = require('./lib/yahoo-api');
const { assertAccess } = require('./lib/access-guard');

const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
const db = app.database();
const _ = db.command;

const WATCH_COLL = 'ths_watchlist';
const MAX_ROWS = 1000; // 单次请求上限（前端会按 200 条一批分多次调用）
const ADD_CHUNK = 100; // 批量写入分批大小
const IN_CHUNK = 100; // 已存在代码的分批查询大小

function parsePrice(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n >= 10000000) return undefined;
  return Math.round(n * 10000) / 10000;
}

function normType(t) {
  const s = String(t || '').trim().toLowerCase();
  if (!s) return ''; // 空：无法校验，直接报错（导入模板要求填写类型）
  if (s === '股票' || s === 'stock') return 'stock';
  if (s === 'etf') return 'etf';
  return null; // 非法值
}

function countUpdated(res) {
  // node-sdk 各版本返回结构不同：{updated: N} 或 {stats: {updated: N}}
  if (!res) return 0;
  if (res.updated != null) return Number(res.updated);
  if (res.stats && res.stats.updated != null) return Number(res.stats.updated);
  return 0;
}

exports.main = async (event = {}) => {
  const denied = assertAccess(event);
  if (denied) return denied;

  try {
    const rows = Array.isArray(event.rows) ? event.rows : [];
    if (!rows.length) return { ok: false, error: '没有可导入的数据' };
    if (rows.length > MAX_ROWS) return { ok: false, error: `单次最多导入 ${MAX_ROWS} 条` };

    const strategy = ['skip', 'update', 'overwrite'].includes(event.duplicateStrategy)
      ? event.duplicateStrategy
      : 'skip';

    // 1) 服务端完整校验（与 ths-create-watch 一致的规则）
    const valid = [];
    const failed = [];
    const seenKeys = new Set();
    let skippedInRequest = 0; // 同一请求内的重复代码：只保留第一条，其余按跳过计
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || {};
      const type = normType(r.type);
      if (type === null) {
        failed.push({ code: r.code, reason: '类型必须为 股票 或 ETF' });
        continue;
      }

      let market = String(r.market || '').trim().toUpperCase();
      let rawCode = String(r.code || '').trim();
      if (!market) {
        market = /^\d{6}$/.test(rawCode) ? 'CN' : 'US';
      }

      let code = rawCode;
      let thsCode = '';
      const currency = market === 'US' ? 'USD' : 'CNY';
      const timezone = market === 'US' ? 'America/New_York' : 'Asia/Shanghai';
      const dataSource = market === 'US' ? 'YAHOO' : 'THS';

      if (market === 'US') {
        code = normalizeUsSymbol(code);
        if (!/^[A-Z0-9.\-]{1,10}$/.test(code)) {
          failed.push({ code, reason: '美股代码格式不正确（如 AAPL、NVDA、QQQ、SPY）' });
          continue;
        }
        thsCode = code;
      } else {
        if (!/^\d{6}$/.test(code)) {
          failed.push({ code, reason: '中国市场代码必须为 6 位数字' });
          continue;
        }
        thsCode = toThsCode(type, code);
        if (!thsCode) {
          failed.push({ code, reason: '无法识别该代码所属市场，请检查类型与代码是否匹配' });
          continue;
        }
      }

      const dupKey = `${market}_${code}`;
      if (seenKeys.has(dupKey)) {
        skippedInRequest++;
        continue;
      }
      seenKeys.add(dupKey);

      const name = String(r.name || '').trim().slice(0, 40) || code; // 名称缺省时用代码
      const buyPrice = parsePrice(r.buyPrice);
      const sellPrice = parsePrice(r.sellPrice);
      if (buyPrice === undefined) {
        failed.push({ code: r.code, reason: '买入价格必须是大于 0 的数字' });
        continue;
      }
      if (sellPrice === undefined) {
        failed.push({ code: r.code, reason: '卖出价格必须是大于 0 的数字' });
        continue;
      }
      if (buyPrice === null && sellPrice === null) {
        failed.push({ code: r.code, reason: '买入价格和卖出价格不能同时为空' });
        continue;
      }
      valid.push({
        market,
        securityType: type === 'etf' ? 'ETF' : 'STOCK',
        currency,
        timezone,
        dataSource,
        type,
        code,
        thsCode,
        name,
        buyPrice,
        sellPrice,
        enabled: r.enabled !== false,
      });
    }

    let skipped = skippedInRequest;

    // 2) 查询数据库中已存在的代码（分批 IN 查询）
    const existMap = new Map();
    for (let i = 0; i < valid.length; i += IN_CHUNK) {
      const chunk = valid.slice(i, i + IN_CHUNK).map((v) => v.code);
      const snap = await db.collection(WATCH_COLL).where({ code: _.in(chunk) }).get();
      for (const doc of snap.data || []) existMap.set(doc.code, doc);
    }

    // 3) 按策略分流
    const toAdd = [];
    const toUpdate = [];
    for (const v of valid) {
      const exist = existMap.get(v.code);
      if (!exist) {
        toAdd.push(v);
      } else if (strategy === 'skip') {
        skipped++;
      } else {
        toUpdate.push({ ...v, _id: exist._id, old: exist });
      }
    }

    // 4) 批量新增（每批 100 条一次写入；批量失败时降级逐条，隔离唯一索引冲突）
    let added = 0;
    const now = new Date();
    for (let i = 0; i < toAdd.length; i += ADD_CHUNK) {
      const chunk = toAdd.slice(i, i + ADD_CHUNK);
      const docs = chunk.map((v) => ({
        type: v.type,
        code: v.code,
        thsCode: v.thsCode,
        name: v.name,
        buyPrice: v.buyPrice,
        sellPrice: v.sellPrice,
        targetPrice: null,
        buyDiscount: null,
        sellDiscount: null,
        enabled: v.enabled,
        // 行情与触发状态由 ths-check-market 扫描时填充
        currentPrice: null,
        previousPrice: null,
        changePercent: null,
        buyTriggered: false,
        sellTriggered: false,
        buyAchievedAt: null,
        sellAchievedAt: null,
        lastBuyAlertTime: null,
        lastSellAlertTime: null,
        lastDividendAlertType: null,
        lastDividendAlertTime: null,
        quoteError: null,
        lastFetchTime: null,
        note: '',
        noteUpdatedAt: null,
        createdAt: now,
        updatedAt: now,
      }));
      try {
        await db.collection(WATCH_COLL).add(docs);
        added += docs.length;
      } catch (e) {
        // 批量失败（如并发导致唯一索引冲突）：降级逐条，隔离问题行
        for (let j = 0; j < chunk.length; j++) {
          try {
            await db.collection(WATCH_COLL).add(docs[j]);
            added++;
          } catch (e2) {
            if (/duplicate|E11000/i.test(String(e2.message))) skipped++;
            else failed.push({ code: chunk[j].code, reason: `写入失败：${e2.message}` });
          }
        }
      }
    }

    // 5) 更新已有记录（逐条；价格线或代码变化时重置 previousPrice，与单个编辑 ths-update-watch 一致）
    let updated = 0;
    for (const v of toUpdate) {
      try {
        const patch = {
          name: v.name,
          buyPrice: v.buyPrice,
          sellPrice: v.sellPrice,
          enabled: v.enabled,
          updatedAt: now,
        };
        const priceChanged = v.old.buyPrice !== v.buyPrice || v.old.sellPrice !== v.sellPrice;
        const codeChanged = v.old.thsCode !== v.thsCode;
        if (priceChanged || codeChanged) {
          // 目标变化：重置评估基线并撤销「已完成」标记（与 ths-update-watch 一致）
          patch.previousPrice = null;
          patch.buyAchievedAt = null;
          patch.sellAchievedAt = null;
        }
        if (strategy === 'overwrite') {
          // 全部覆盖：像重新添加一样重置行情与提醒状态
          patch.currentPrice = null;
          patch.previousPrice = null;
          patch.buyTriggered = false;
          patch.sellTriggered = false;
          patch.buyAchievedAt = null;
          patch.sellAchievedAt = null;
          patch.lastBuyAlertTime = null;
          patch.lastSellAlertTime = null;
        }
        const res = await db.collection(WATCH_COLL).doc(v._id).update(patch);
        if (countUpdated(res) === 0) failed.push({ code: v.code, reason: '更新未生效，请重试' });
        else updated++;
      } catch (e) {
        failed.push({ code: v.code, reason: `更新失败：${e.message}` });
      }
    }

    return { ok: true, added, updated, skipped, failed };
  } catch (e) {
    return { ok: false, error: `导入失败：${e.message}` };
  }
};
