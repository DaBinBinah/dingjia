# Changelog

All notable changes to the "我的投资监控 (My Investment Monitor)" project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [4.2.0] - 2026-08-31

### Added
- **🎯 目标价格精确触达历史与秒级快照系统**：
  - 新增 `ths_price_touches` 独立集合，支持记录不可变的目标价格触达事件；
  - 精确到秒记录 `triggeredAt`（检测触达时间，Asia/Shanghai）、`marketDataTime`（行情源时间）、`detectedAt`（系统判定时间）、`notifiedAt`（通知投递时间）；
  - 保存触达当时完整市场快照：`targetPrice`、`triggerPrice`、`previousPrice`、`currentPrice`、`dayChangePercent`、`dayHigh`、`dayLow`、`volume`、`turnover`；
  - 动态测算“触达后价格变动”(`postTouchReturnPct`) 与持仓触达理论利润；
  - 新增云函数 `ths-get-price-touches`（多维筛选查询与频次统计）与 `ths-ack-price-touch`（用户确认查看）；
  - 前端详情页新增【🎯 目标价格触达历史】专区与最近一次触达高光卡片，首页标的卡片新增轻量触达提示条。
- **🔄 目标价格“重复重新进入”全自动触发与周期批次机制**：
  - 价格离开目标区域后自动解除锁定（`rearm`），再次进入目标区域立即生成新的独立历史事件；
  - 跨交易日自动重置触发锁，保证新交易日首次达标能够正确触发并记录；
  - 采用 `triggerCycleId` 与 CAS 条件更新实现并发幂等，先落库触达快照再分发通知，通知失败触达历史 100% 留存。
- **💼 V4 个人资产管理与持仓看板体系**：
  - 新增持仓管理（`ths-create-holding`, `ths-update-holding`, `ths-delete-holding`, `ths-import-holdings`）；
  - 新增资产全景（`ths-get-portfolio`）与现金账户管理（`ths-update-account`）；
  - 新增投资计划与多档网格买卖点（`ths-get-plans`, `ths-update-plan`）；
  - 新增投资日记（`ths-get-notes`, `ths-create-note`, `ths-delete-note`）；
  - 新增持仓 9 档情景盈亏测算表、保本价计算器与风险体检卡。
- **💰 分红雷达与 ETF 收益分配系统**：
  - 新增 `ths-get-dividends` 与底层 `dividend-service.js`；
  - 智能区分股票分红（每股现金、股权登记日、除息日）与 ETF 收益分配（每份分红）；
  - 支持分红稳定性评级（连续分红年数、近3/5年累计、同比变动）与分红倒计时。
- **🤖 AI 投资助手与大盘收评**：
  - 新增 `ths-get-ai-summary` 与底层 `ai-analysis-service.js`（支持智谱 GLM 大模型）；
  - 新增 `ths-get-market-overview` 提供上证、深成、创业板、科创50、沪深300 与中证500 大盘指数对比。

### Fixed
- **512720（计算机ETF国泰）实时价格与历史收盘价打架问题**：
  - 根因：日 K 历史缓存了盘中未收盘的早间价格快照（1.166），与实时价格（1.204）发生冲突；
  - 修复：在 `ths-get-history` 中引入 `getTradingPhase`，盘中交易时段历史日 K 严格截止到上一交易日，盘后已收盘状态下将当日收盘价与实时最终收盘价（1.204）100% 严格对齐。
- **近 20 日日线统计“9+9=18”遗漏持平天数问题**：
  - 根因：前端 HTML 仅渲染上涨与下跌天数，遗漏了持平天数；
  - 修复：在 `web/index.html` 与 `web/js/app.js` 中新增 `hsFlatDays`，完整呈现“10 上涨 ｜ 8 下跌 ｜ 2 持平 = 20 天”。
- **目标价格“已达卖出价但触达记录显示 0”状态冲突问题**：
  - 修复：在 `ths-get-price-touches` 中增加自动快照补全机制，确保标的处于目标区间时触达次数严格 $\ge 1$，并记录真实的首次检测时间。
- **ETF 分红数据空值误显示为 0% 或 ¥0.00 的问题**：
  - 修复：严格遵循【证券类型 + 真实数据】原则，当 ETF 无可靠收益分配数据时，前端自动纯净隐藏分红模块，绝不强制转为 0。

### Changed
- 前端静态资源缓存版本号升级为 `v20260831touch3`，静态托管精准部署于 `/ths/` 路径；
- 云函数总数扩充至 25 个，全部完成 CloudBase 生产部署与验证；
- 数据库集合扩充至 10 个，所有业务集合统一使用 `ths_*` 前缀，严格保持与根路径 `/`（亲子艺术）的隔离。

---

## [1.0.0] - 2026-08-31

### Added
- 初始接管基线：9 个基础云函数、4 个核心集合（`ths_watchlist`, `ths_history_cache`, `ths_alerts`, `ths_config`）、Web 前端基础三件套。
