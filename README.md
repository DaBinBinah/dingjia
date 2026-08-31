# 盯价（你定价格，我来盯。）

部署在腾讯云 CloudBase 上的**个人 A 股 / ETF 价格监控与资产管理工具**：自己录入股票 / ETF 和买入、卖出价格线，
系统定时拉取同花顺行情，价格**穿越**价格线时提醒一次（防重复），全部记录可查。

> 红线：本工具只做「获取行情 → 判断价格 → 发出提醒 → 网站展示」。
> **没有任何**自动买入、自动卖出、自动委托、自动撤单、券商接口等交易逻辑。

## 访问地址

**https://REDACTED_CLOUDBASE_ENV_ID-1420504604.tcloudbaseapp.com/ths/**

（手机浏览器打开体验最佳；页面数据每 30 秒自动刷新，也可点右上角 ↻ 立即刷新）

## 项目结构

```
同花顺/
├── cloudfunctions/                  # CloudBase 云函数（全部 ths- 前缀，与其他项目隔离）
│   ├── ths-check-market/            # 核心：定时扫描 + 穿越判断 + 提醒
│   │   ├── index.js
│   │   └── lib/
│   │       ├── ths-api.js           # 同花顺 REST 客户端（股票批量/ETF单个/搜索/交易日历）
│   │       ├── trading-time.js      # 东八区交易时段 + 交易日历缓存 + 节假日兜底
│   │       ├── alert-service.js     # 提醒落库 → 通知分发
│   │       ├── notification-service.js # 通知渠道注册表（内置 Webhook 渠道，预留 Telegram/微信/邮件/企微）
│   │       └── access-guard.js      # 可选访问口令校验
│   ├── ths-get-market-price/        # 单标的实时价+名称预览（添加表单用）
│   ├── ths-create-watch/            # 新增监控（校验+查重）
│   ├── ths-update-watch/            # 编辑/暂停/恢复
│   ├── ths-delete-watch/            # 删除（提醒记录保留）
│   ├── ths-get-watches/             # 列表+统计+行情状态
│   ├── ths-get-alerts/              # 提醒记录（筛选/分页）
│   └── ths-import-watches/          # 批量导入（服务端完整校验+批量写入+重复策略）
│   └── ths-get-history/             # 历史行情：首页批量 YTD（mode=perf）+ 详情页历史数据（mode=detail）
└── web/                             # 纯静态前端（无构建），部署于静态托管 /ths/ 目录
    ├── index.html
    ├── css/style.css
    ├── js/app.js
    └── vendor/cloudbase.js          # 自托管的 @cloudbase/js-sdk v3
```

## 数据库（CloudBase NoSQL，前端无直连权限，仅云函数可读写）

### ths_watchlist（监控标的）

| 字段 | 说明 |
| --- | --- |
| type | `stock` 股票 / `etf` ETF |
| code / thsCode | 6 位代码 / 自动推导的带后缀代码（如 `601137.SH`） |
| name | 名称（用户填写，可由 API 自动带出） |
| buyPrice / sellPrice | 买入线 / 卖出线（可任空，表示只监控一侧） |
| targetPrice | 目标价（可选）：与折扣配合自动换算价格线，保存后持久化并回填表单 |
| buyDiscount / sellDiscount | 买入折扣 / 卖出折扣（倍数：0.9 = 打九折 → 买入线 = 目标 × 0.9；1.05 = 涨 5% → 卖出线 = 目标 × 1.05） |
| buyAchievedAt / sellAchievedAt | 达成时间：价格首次满足买入线 / 卖出线条件时写入（用于「已达成」筛选与徽章） |
| enabled | 监控中 / 已暂停 |
| currentPrice / previousPrice / changePercent | 最新价 / 上一次价格 / 涨跌幅 |
| buyTriggered / sellTriggered | 触发标记（穿越判断的核心状态） |
| lastBuyAlertTime / lastSellAlertTime | 最近一次触发时间 |
| quoteError / lastFetchTime | 行情错误标记 / 最近取价时间 |
| createdAt / updatedAt | 创建 / 更新时间 |

索引：`code` 唯一（防止重复添加同一代码）。

### ths_alerts（提醒记录）

`watchId`、`type`、`code`、`name`、`alertType`(buy/sell)、`triggerPrice`、`currentPrice`、`createdAt`。
索引：`createdAt` 降序。

### ths_config（全局配置）

- `settings` 文档：`monitorIntervalSec`（扫描间隔秒，默认 30，最小 10）、`holidays`（额外节假日 `YYYY-MM-DD` 列表，交易日历接口失败时兜底）
- `scan_state` 文档：上次扫描时间与结果（节流 + 前端状态栏）
- `trading_days` 文档：当日交易日历缓存（每个北京日只调一次日历接口）

### ths_history_cache（历史行情缓存，ths-get-history 使用）

| 字段 | 说明 |
| --- | --- |
| thsCode | 缓存键，如 `510300.SH` |
| type | `stock` / `etf` |
| date | 缓存数据所属北京日期 `YYYYMMDD`（当日数据，跨日自动失效重取） |
| items | 日线数组 `[{d, c}]`（日期 / 收盘价，升序） |
| updatedAt | 更新时间 |

- 首页批量 YTD（`mode=perf`）与详情页历史表（`mode=detail`）共用该缓存；
  命中当日缓存直接返回，不重复请求行情 API；写缓存失败不阻塞主流程
- **绝不伪造数据**：接口失败时相应标的返回 `null` 并在前端优雅降级（YTD 行隐藏、表格显示错误提示），
  不会用旧数据冒充当日数据

## 云函数与定时任务

| 函数 | 触发方式 | 职责 |
| --- | --- | --- |
| ths-check-market | **定时触发器 `ths-check-market-timer`：每 10 秒**（7 段 cron `*/10 * * * * * *`）+ 前端手动 | 扫描开启的标的 → 批量取行情 → 穿越判断 → 生成提醒 → 更新状态 |
| ths-get-market-price | 前端调用 | 单标的实时价与名称预览 |
| ths-create-watch / ths-update-watch / ths-delete-watch | 前端调用 | 监标 CRUD |
| ths-get-watches / ths-get-alerts | 前端调用 | 列表与提醒记录查询 |
| ths-import-watches | 前端调用 | 批量导入：服务端逐行完整校验（与单个添加同规则）、批量写入（每批 100 条）、按策略处理重复 |

频率控制：定时器每 10 秒触发一次，函数内部按 `monitorIntervalSec`（默认 30 秒）节流；
**非交易时间（盘前/午休/收盘后/周末/节假日）定时路径直接跳过，不调用行情 API**。
手动点「刷新」会带 `force` 标记立即扫描一次（周末也能看到最近收盘价）。

## 同花顺 API 配置

- 服务：同花顺金融数据服务 https://fuyao.aicubes.cn （Key 管理页 /admin）
- **API Key 只存在云函数环境变量 `THS_API_KEY` 中**（已配置于 `ths-check-market` 与 `ths-get-market-price`），前端代码不含任何 Key
- 实际使用的接口（均已按官方文档逐字段核对并实测）：
  - 股票行情（批量）：`GET /api/a-share/prices/snapshot?thscodes=601137.SH,600519.SH`
  - ETF 行情（官方仅支持单个）：`GET /api/fund/market/snapshot?thscode=510300.SH`
  - 名称解析：`GET /api/meta/tickers/search?q=<代码>`
  - 交易日历：`GET /api/a-share/calendar/trading-days`
- 更换 Key：在 `/admin` 签发新 Key 后，更新上述两个函数的环境变量 `THS_API_KEY` 即可

## 价格穿越触发（防重复提醒）

- 买入：仅当价格从 `> 买入线` 穿越 `≤ 买入线` 时提醒一次；价格回升到线上方后自动「重新武装」，再次跌破才提醒下一次
- 卖出：仅当价格从 `< 卖出线` 穿越 `≥ 卖出线` 时提醒一次；对称回位
- 首次取到价格时只初始化；若已越过阈值且从未提醒过，补发一次（保证「添加即达标」有反馈）
- 修改代码或价格线后重置评估状态，已触发的标记不变，不会重复轰炸
- 触发更新采用条件更新（CAS）原子抢占，定时器与手动刷新并发也不会重复提醒

### 达成记录（buyAchievedAt / sellAchievedAt）

- 价格满足买入线 / 卖出线条件时，除提醒外还会写入对应 `AchievedAt` 时间戳（首次满足即记录，不随重新武装清除）
- 前端据此把标的归入「已达成 🏁」：`enabled && (buyAchievedAt || sellAchievedAt)`；「进行中」是它的互斥补集（未达成任何一条线），两者不重叠
- **修改代码或价格线时重置达成记录**（监控目标变化，重新评估；目标价×折扣自动换算出的价格变化同样触发重置，前端手动锁定且价格未变时保留原记录）；
  调价后如价格已满足新线会触发新提醒；暂停（enabled=false）的标的不参与扫描，恢复后继续按当前线评估

## 如何添加第一只股票 / ETF

1. 打开网站 → 点右下角 **＋ 添加监控**
2. 选择类型（股票 / ETF），输入 6 位代码（如股票 `601137`、ETF `510300`）
   - 输完代码会自动显示当前价格并带出名称（可修改）
3. 填写价格线（三选一即可）：
   - **直接填写**买入价格和/或卖出价格（**可以只填一个**，另一个留空）
   - 或填**目标价** + 买入折扣 / 卖出折扣（如目标 20、买入-10%、卖出+5%），价格线自动换算为 买入 18 / 卖出 21；
     手动直接改过某条价格行后，该条停止自动换算（本次编辑内不再重算）
4. 保持「开启监控」打开 → 保存
5. 卡片出现在列表中；价格跌破买入线或突破卖出线时，卡片高亮 + 🔔 徽章 + 提醒记录入库 + Webhook 推送（若已配置）

## 目标价与自动换算（添加 / 编辑表单）

- 表单支持「目标价 × 折扣」记账式录入：目标价与买入/卖出折扣一起保存，下次编辑自动回填
- 换算规则：买入线 = 目标价 × 买入折扣，卖出线 = 目标价 × 卖出折扣
  （折扣 0.9 = -10%，1.05 = +5%，支持 1%–500%）；
  改动目标或折扣时价格线自动重算并实时预览，保存时才落库
- 价格行被手动改过即停止联动（`formManBuy` / `formManSell` 标记，本次编辑内不再自动重算），避免覆盖手工输入；重新打开表单可恢复自动换算
- 只保存换算结果（buyPrice / sellPrice）与目标价/折扣的存档：监控逻辑仍按最终价格线判断，不依赖换算

## Webhook 通知（可选）

在云函数 `ths-check-market` 环境变量中配置（无需改代码）：

| 环境变量 | 说明 |
| --- | --- |
| `THS_WEBHOOK_URL` | 必填才启用：触发提醒时向该地址 POST JSON（可接 Server酱 / PushPlus / Bark / Telegram Bot 等任意 Webhook 服务） |
| `THS_WEBHOOK_TOKEN` | 可选：存在时以 `X-Token` 头附带（服务端自校验） |

推送体：

```json
{ "event": "price_alert", "alertType": "buy", "name": "博威合金", "code": "601137.SH",
  "currentPrice": 17.95, "triggerPrice": 18, "time": "2026-08-31T06:00:00.000Z" }
```

配置后 `ths-get-watches` 返回 `settings.notify = { configured: true, channel: 'webhook' }`，前端可据此展示通知状态；未配置时 `configured: false`，推送步骤静默跳过（不影响提醒落库与页面展示）。

## 列表筛选（全部 / 进行中 / 已达成）

- 列表顶部三个标签：**全部**（所有监控）/ **进行中**（未达成任何一条价格线）/ **已达成 🏁**（至少一条线已达成的开启标的）
- 达成卡片右上角显示 `🏁 已达成` 徽章；空列表时显示对应空态文案（如「还没有已达成标的」）
- 筛选规则与后端达成记录严格一致：`done = enabled && (buyAchievedAt || sellAchievedAt)`，`active` 为其补集；调价重置达成记录后标的自动回到「进行中」

代码市场后缀自动推导：股票 60/68→沪、00/30→深、43/83/87/92→北交所；ETF 5→沪、1→深。

## 批量导入

点右下角「批量导入」（或空状态页的「或批量导入」），三种方式任选：

1. **下载导入模板**：`investment_monitor_template.csv`（含示例行，示例不会被导入）
2. **选择 / 拖拽 CSV 文件**：支持 UTF-8 与 UTF-8 BOM，中文不乱码；Excel 请先「另存为 CSV UTF-8」（第一阶段支持 CSV，XLSX 预留扩展）
3. **复制粘贴导入**：直接把多行数据粘进文本框（自动兼容逗号 / Tab 分隔、全角逗号、带引号字段、带表头）

CSV 列：`类型,代码,名称,买入价格,卖出价格,开启监控`。说明：

- 类型可填 `股票`/`ETF`；留空时按代码号段自动识别，识别不了会在预览中标错
- 代码支持 `601137`、`"601137"`、`601137.SH`、`sh601137` 等写法，统一转为系统标准格式
- 名称可留空：预览时自动通过官方代码表补全（每次最多补 40 条，超出用代码代替并提示）
- 买入 / 卖出价格可任空（只监控一侧）；类型与代码不匹配、价格非数字等错误会逐行标明原因
- **解析后只出预览，绝不直接入库**；预览显示正确 / 重复 / 错误统计与逐行原因，确认后才写入
- 重复数据三种策略：跳过重复（默认）/ 更新已有记录 / 全部覆盖（重置提醒状态）
- 同一文件内部重复代码：默认「使用最后一条」，可切换「保留第一条」
- 有错误行时可下载 `investment_monitor_errors.csv`（含行号与错误原因），改好后再次导入
- 单次最多 1000 条，前端自动分批提交，服务端批量写入；导入只保存配置，不触发行情请求，
  由现有定时监控任务统一取价；是否触发提醒完全遵循现有「首次观测 / 价格穿越」规则

## 安全说明

- API Key 与 Webhook 凭据仅存于云函数环境变量（`THS_API_KEY` / `THS_WEBHOOK_URL` / `THS_WEBHOOK_TOKEN`），绝不进入前端代码或浏览器
- 数据库三个集合均为「仅管理员」权限，前端只能通过云函数读写
- 云函数调用权限为 `{"*": {"invoke": "auth != null"}}`：需登录态（匿名会话也算），完全未认证的请求被拒
- 如需进一步限制访问：给两个行情函数和所有 CRUD 函数配置环境变量 `THS_ACCESS_CODE`（任意口令），
  打开网站时会弹出「访问口令」输入框，输入正确后存入浏览器本地

## 扩展指南

- **新增通知渠道（Telegram / 微信 / 邮件 / 企业微信 / Push）**：
  在 `ths-check-market/lib/notification-service.js` 中实现 `{ name, async send(alert, watch) }` 并 `register()`，
  凭据放云函数环境变量，监控逻辑零改动
- **GLM 智能分析（第二阶段）**：在 `alert-service.dispatch()` 落库后追加异步分析调用即可；
  GLM 只在触发提醒时调用一次，绝不进入价格轮询路径
- **节假日**：默认按交易日历接口自动判断；如需兜底，往 `ths_config` 的 `settings.holidays` 追加 `YYYY-MM-DD`

## 本地开发

```bash
# ⚠️ 踩坑：tcb fn deploy 可能返回成功但函数未真正更新（"鬼成功"）
# 云函数更新请走 CloudBase 控制台 / MCP manageFunctions updateFunctionCode（functionRootPath=cloudfunctions/<函数名>），
# 更新后到控制台确认函数代码版本时间戳已变化
# 前端部署（静态托管 /ths/）：
tcb hosting deploy -e <envId> <本地 web 目录绝对路径> /ths
# 注意：tcb hosting deploy 不支持 --dir / --path 参数；命令后跟 目标绝对路径 + 云端路径

# 前端静态文件带版本号（web/index.html 里 css/js 的 ?v= 时间戳），
# 重新部署后浏览器强刷（或换新版本号）以绕过 CDN 缓存；云端函数改完同样要等权限/缓存收敛
```
