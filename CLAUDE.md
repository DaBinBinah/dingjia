# CLAUDE.md — 项目开发指南（Coding Agent 协作入口）

> 给接手的 Coding Agent（Claude / GLM / DeepSeek / Kimi 等）的入口文档。
> 开发流程：**先读本文件 → 再读相关代码文件 → 再动手**。
> 内容以当前仓库代码为准（2026-08-31 核对），不确定处已标注「待确认」；不含任何密钥/口令/Token。
> 红线（用户要求，必须遵守）：
> - 监控标的 **601137 博威合金（买 18 / 卖 21）为用户手工添加，禁止删除、禁止修改价格线**。
> - 清理/修改测试数据时，只能按已知 `code` / `_id` 精确查询后删除；模糊匹配批量删除一律直接拒绝。

---

## 1. 项目介绍

「盯价」（Slogan：你定价格，我来盯。）——A 股股票 / ETF 的价格监控、资产管理与提醒工具（Web 应用）。

- **做什么**：用户维护一张监控清单（股票/ETF + 买入价格线 + 卖出价格线），系统在交易时段定时获取实时行情，当价格穿越价格线时记录提醒并（可选）推送 Webhook。
- **不做什么**：全代码库 **不存在任何交易/委托/下单逻辑**（代码注释与 README 均明确此红线；无交易按钮）。
- **站点**：CloudBase 静态托管 `/ths/` 前缀，地址 `https://REDACTED_CLOUDBASE_ENV_ID-1420504604.tcloudbaseapp.com/ths/`（另见 README）。
- **行情来源**：同花顺金融数据服务 REST API（见 §6.4），密钥仅存在于云函数环境变量，绝不下发前端。

## 2. 技术架构

```
浏览器（原生 HTML/CSS/JS，无框架，web/）
  │  CloudBase js-sdk（web/vendor/cloudbase.js 本地打包，匿名登录 + publishable key）
  ▼
CloudBase 云函数 ×9（Node.js + @cloudbase/node-sdk v3，每函数独立目录独立部署）
  │  THS_API_KEY 等环境变量（服务端）
  ▼
同花顺 REST API（https://fuyao.aicubes.cn，X-api-key 头，响应信封 {code:0, data}）
  ▲
  │  CloudBase NoSQL（ths_watchlist / ths_alerts / ths_config / ths_history_cache，仅管理员权限）
  ```

- 行情获取：**超时 8 秒**、股票批量、ETF 单只串行、单标的失败不阻塞整批（详见 §4.2）。
- 触发源：云函数 `ths-check-market` 定时触发器（约每 10 秒，云端配置，见 §6.2）+ 前端手动刷新（`force:true`）。

## 3. 项目目录

```
同花顺/
├── CLAUDE.md                  # 本文档
├── README.md                  # 用户向使用说明（含部署步骤、各功能说明）
├── jihua1.md                  # 历史实施计划文档（二期：价格距+历史行情）——已全部实现，仅历史留档，见 §9
├── web/                       # 前端静态站点（部署到静态托管 /ths/）
│   ├── index.html             # 单页应用（监控列表 / 详情页 / 提醒记录 / 批量导入弹窗）
│   ├── js/app.js              # 全部前端逻辑（无框架，~1516 行）
│   ├── css/style.css          # 样式（~568 行）
│   └── vendor/cloudbase.js    # @cloudbase/js-sdk（本地打包产物，勿手改）
└── cloudfunctions/            # 云函数（每个独立部署单元）
    ├── ths-check-market/      # ★ 价格监控核心（定时器 + 手动）
    │   └── lib/
    │       ├── access-guard.js    # 可选访问口令（THS_ACCESS_CODE）
    │       ├── ths-api.js         # 同花顺 REST 客户端（行情/日历/名称）
    │       ├── trading-time.js    # 交易时间 / 交易日判断
    │       ├── alert-service.js   # 提醒的构造 + 落库 + 分发
    │       └── notification-service.js  # 渠道注册表（console + webhook）
    ├── ths-create-watch/      # 添加监控（单个）
    ├── ths-update-watch/      # 编辑监控
    ├── ths-delete-watch/      # 删除监控
    ├── ths-get-watches/       # 监控列表 + 统计 + 行情状态元信息
    ├── ths-get-alerts/        # 提醒记录（分页）
    ├── ths-get-market-price/  # 单只实时行情（新增/编辑表单预览）
    ├── ths-get-history/       # 历史日线 + 年度涨跌（YTD）
    └── ths-import-watches/     # 批量导入（skip/update/overwrite 三策略）
```

> 注意：`lib/` 是**按函数目录各自复制**的（除 alert-service / notification-service 仅 check-market 特有外，其余函数内都有一份同源 copy）。修改公共逻辑（如 ths-api.js 契约、trading-time.js）时须逐个函数目录同步更新，否则部署后各函数行为不一致。

## 4. 核心功能

### 4.1 监控列表维护（ths-create-watch / ths-update-watch / ths-delete-watch）

- 输入校验：`type ∈ {stock, etf}`；`code` 必须 6 位数字且市场可识别（`thsCode` 自动加后缀：股票 60/68→SH、00/30→SZ、43/83/87/92→BJ；ETF 5→SH、1→SZ）；名称 ≤30 字；**至少填一条价格线**；代码查重（库唯一索引兜底）。
- 价格保存：`parsePrice` 四舍五入到 4 位小数；空值→null（表示该侧不监控）。
- 目标价/折扣字段（`targetPrice`、`buyDiscount`、`sellDiscount`）：**仅作记录**（供编辑回填），价格线由前端按「目标价 × 折扣」换算后提交；后端不透出换算。
  `parseDiscount`：接受 `0.9`（小数倍率）或 `90`（百分数，>2 自动 ÷100），最终限制 ≤5（500%）。
- 编辑时若**代码或任一价格线变化** → 重置 `previousPrice` + `buyAchievedAt` + `sellAchievedAt`（达成标记撤销，避免换价位后仍显示"已达成"）；**不重置** `buyTriggered/sellTriggered`（避免编辑后立刻重复轰炸提醒）。
- 删除：按 `_id` 删；提醒历史（`ths_alerts`）**保留**（code/name 冗余在提醒文档中）。

### 4.2 行情获取（ths-get-market-price / ths-check-market / ths-get-history）

- 实时快照（ths-get-market-price，单只，表单预览用）：`/api/a-share/prices/snapshot`（股票）或 `/api/fund/market/snapshot`（ETF），返回 `{price, changePercent, prevPrice, name?}`；`nameOnly` 参数走 `/api/meta/tickers/search` 只查名称。
- 批量快照（ths-check-market）：股票按批次 ≤100 只/批次调用快照端点；**ETF 端点仅接受单只**，逐只串行拉取（避免限流）。
- **关键行为——批量接口"全有或全无"**：股票批量任一只非法都会导致整批失败；代码里对多只批次失败自动降级为**并发 5 逐只重试**，只把真正非法的标的标失败，不影响同批其他标的。
- 历史（ths-get-history）：
  - `mode=detail`：单只日线序列（前复权）`items:[{d, c}]` + YTD 汇总 `{y2025, y2026, base2025, base2026, last, lastDate}`；
  - `mode=perf`：首页批量（`list` ≤300），并发 5 逐只，单只失败不阻塞；
  - 数据锚点 2024-01-01 前一个交易日起（`START_MS=2023-12-15`），覆盖 2025/2026 年初；
  - **缓存**：`ths_history_cache` 集合，按 `thsCode` 缓存「当日」序列（`date`=北京日），同日重复请求零 API 调用，跨天自动重建（前复权基准可能随除权变化，不做跨天合并）。
- 名称补全：快照不含名称，`searchTickerName` 查代码表；失败返回 null 不影响主流程。

### 4.3 价格监控与买卖触发（ths-check-market，全系统核心）

流程（index.js）：

1. 入口 `assertAccess` → 定时事件（`Type/TriggerType === 'Timer'`）永远放行；前端调用需口令（若配置了 `THS_ACCESS_CODE`）。
2. `resolveTradingDays`：每天北京日首次调用交易日历接口，结果缓存进 `ths_config.trading_days`（失败→null，退化到星期判断）。
3. **非交易时间且非 force → 直接 skip**（定时路径不产生任何行情 API 调用）；`force=true`（手动刷新）可在任何时间强制跑一次。
4. **节流**：定时路径按 `monitorIntervalSec`（默认 30s，范围 10–3600s）节流；`scan_state.lastScanAt` 距今 < 间隔-500ms 则跳过；手动 `force` 不节流。
5. 取全部 `enabled` 标的 → 按 type 分组批量取行情（失败只做错误标记 `quoteError` 并跳过，绝不中断这批监控）。
6. 逐只做**穿越判断**（`prev` = 上次 `currentPrice`，首观测 `prev === null`）：

```text
买入线（现价 ≤ buyPrice 提醒"可买"）：
  - 首次观测：若当前价 ≤ buyPrice 且从未触发过 → 触发（视为进入区间）
  - 后续：prev > buyPrice 且 price ≤ buyPrice  → 触发 buy
  - 反方向：buyTriggered === true 且 price > buyPrice → 重新武装（复位标志）
卖出线（现价 ≥ sellPrice 提醒"可卖"）：
  - 首次观测：若当前价 ≥ sellPrice 且从未触发过 → 触发
  - 后续：prev < sellPrice 且 price ≥ sellPrice → 触发
  - 反方向：sellTriggered === true 且 price < sellPrice → 重新武装
```

7. **防重复 + 原子抢占**：触发时更新 **不直接写**，而是 `where({_id, 'buyTriggered':false})` 条件更新（CAS），`updatedCount === 1` 才认为自己抢占成功 → 才写提醒。并发（定时器 vs 手动刷新）下只有一个能成功，避免重复提醒。
8. 达成标记：触发成功时若该侧 `{t}AchievedAt` 未填则**一次性写入并永久保留**（供前端"已达成"筛选）；只有在`ths-update-watch` 编辑价格线/代码时才重置。
9. 写 `scan_state.{lastScanAt,lastScanOk,lastAlerts}`（前端状态栏 + 节流共用）。

### 4.4 提醒机制（提醒服务）

- 触发抢占成功后 → `alertService.dispatch`：
  1. 向 `ths_alerts` 落库一条（`alertType: 'buy'|'sell'`, `triggerPrice`, `currentPrice`, 时间等）；
  2. 遍历 `notificationService.channels` 逐个 `send`，**单渠道失败不影响其他渠道、更不影响监控主流程**。
- 内置渠道（`notification-service.js`，渠道注册表模式，扩展只需 `register({name, send})`）：
  - `console`：云函数日志；
  - `webhook`（可选）：依赖环境变量 `THS_WEBHOOK_URL`；payload：
    ```json
    { "event": "price_alert", "alertType": "buy|sell", "name", "code",
      "currentPrice", "triggerPrice", "time": "ISO8601" }
    ```
    若配置 `THS_WEBHOOK_TOKEN` 则请求头带 `X-Token`。可接 Server酱 / PushPlus / Bark / Telegram Bot API 等任意可收 POST 的服务。
- `ths-get-watches` 返回 `settings.notify.configured`（布尔）：是否配置了 webhook。

### 4.5 前端（web/，原生无框架）

- 视图：监控列表（卡片） / 标的详情（无 K 线，历史表格） / 提醒记录（分页）+ 底部 tabbar。
- 列表筛选：**全部 / 进行中 / 已达成 🏁**。语义见 `renderWatches`：`done = enabled && (buyAchievedAt || sellAchievedAt)`；`active = 其余`（含已暂停与未达成）。卡片含价格线、距离、涨跌、目标价/折扣显示、状态徽章、YTD（mode=perf）。
- 详情：当前价 + 当日涨跌 + 2025/2026 至今 + 距离双卡（绿=买入侧 / 黄=卖出侧，达标变状态文字）+ 历史区间表格（日/周/月/季/年 × 近1月/3月/6月/26至今/25至今/全部/自定义）+ 编辑/暂停删除（删除有二次确认）。
- 表单：**目标价 × 折扣 自动换算价格行**（`calcTargetPrices`），用户手动改过价格行后停止自动换算（`formManBuy/formManSell` 标志）；代码输入后可实时预览价格与名称（调 `ths-get-market-price`）。
- 轮询：页面可见期间每 30s 静默刷新列表（cloud 定时器维护数据）；手动刷新按钮 → `ths-check-market {force:true}`。
- 访问口令：配置了 `THS_ACCESS_CODE` 时首次调用被拒会弹入口令框，存 `localStorage['ths_access_code']`。
- 批量导入（`ths-import-watches`）：CSV 拖拽/粘贴 → 本地解析与校验 → 预览（服务端会再校验一遍，规则同单条）→ 确认后分批提交。常量位于 `app.js` 的 `IMP_CONST`：单次上限 `MAX_ROWS=1000`、预览期自动补名称上限 `NAME_CAP=40`（超出后名称用代码代替）、确认提交分批 `SEND_CHUNK=200`；支持“文件内重复”策略（保留首条/末条，`impFileDup`）；表头格式 `类型,代码,名称,买入价格,卖出价格,开启监控`，行内容可含中文（股票/ETF）。

## 5. 数据库（CloudBase NoSQL，全部"仅管理员"权限，前端无直连）

| 集合 | 用途 | 关键字段 |
|---|---|---|
| `ths_watchlist` | 监控清单（code **唯一索引**） | 见下 |
| `ths_alerts` | 提醒流水（只增不删，供前端页面展示） | `watchId, type, code, name, alertType(buy/sell), triggerPrice, currentPrice, createdAt` |
| `ths_config` | 全局配置，`key` 标识文档 | `settings`（monitorIntervalSec 默认30、holidays[]）、`scan_state`、`trading_days`（date+days[] 每日缓存） |
| `ths_history_cache` | 历史序列缓存 | 主键取 `thsCode`，`{date:北京日, items:[{d,c}], updatedAt}` |

`ths_watchlist` 文档结构（与 create/import 初始化一致）：

```js
{
  _id, type: 'stock'|'etf',
  code: '601137', thsCode: '601137.SH',
  name: '博威合金',
  buyPrice: 18, sellPrice: 21,        // 价格线=null 表示该侧不监控
  targetPrice, buyDiscount, sellDiscount,  // 仅记录（目标价换算在前端）
  enabled: true,
  currentPrice, previousPrice, changePercent,  // 行情状态（扫描时填）
  buyTriggered, sellTriggered,                // 触发标志（穿越触发/复位）
  buyAchievedAt, sellAchievedAt,              // 达成时间（一次性，编辑价格线重置）
  lastBuyAlertTime, lastSellAlertTime,
  quoteError, lastFetchTime,
  createdAt, updatedAt
}
```

> ⚠️ 已知不一致：`ths-import-watches` 创建的文档**没有初始化** `targetPrice / buyDiscount / sellDiscount`（单条 create 初始化了这些字段）。前端读取按 `!= null` 处理所以可正常工作，但字段缺失状态与单条添加不一致。**待确认**：是否需要补缺省值。

## 6. CloudBase 基础设施与部署

### 6.1 环境与复用约定

- 环境：`REDACTED_CLOUDBASE_ENV_ID`（**ap-shanghai**），由**多个项目共享**。因此本项目所有资源（集合名、云函数前缀、静态托管路径、触发器名）统一使用 **`ths-` / `ths_` 前缀**，开发时严禁占用未带前缀的云函数/集合名。
- 静态站点：托管在静态托管 `/ths/` 前缀下（非根路径），访问地址见 §1。
- 集合权限：`ths_*` 全部为"仅管理员"（云函数可读写，前端只经云函数间接访问）。

### 6.2 云函数清单与调用关系

| 云函数 | 角色 | 来源（调用方） |
|---|---|---|
| `ths-check-market` | ★ 监控主循环 | 定时触发器（10s）+ 前端手动刷新 |
| `ths-get-watches` | 列表+统计+状态元信息 | 首页 load |
| `ths-get-alerts` | 提醒记录分页 | 提醒页 |
| `ths-get-market-price` | 单只实时价/名称 | 表单预览 |
| `ths-get-history` | 历史+YTD | 首页/详情 |
| `ths-create/update/delete-watch` | CRUD | 表单 |
| `ths-import-watches` | 批量导入 | 导入弹窗 |

输入输出全部 `{ ok:true|false, ... }`；错误统一 `{ ok:false, error: msg }`；所有函数开头调 `assertAccess(event)`（§6.4）。

### 6.3 定时任务

- `ths-check-market` 定时触发器：**约每 10 秒**（cron `*/10 * * * * * *`，7 段格式，配置在云平台控制台，不在仓库代码内——**待确认**：具体触发器配置项以控制台为准）。
- 函数内部按 `monitorIntervalSec` 二次节流（默认 30 秒），所以定时器 10 秒频率实际约 30 秒才跑一次扫描。

### 6.4 环境变量（云函数运行时配置，值为敏感信息，不在本项目记录）

| 变量 | 必填 | 说明 |
|---|---|---|
| `THS_API_KEY` | ✅ | 同花顺 REST 请求头 `X-api-key`（**服务端专用，绝不进前端**） |
| `THS_WEBHOOK_URL` | 选 | 提醒 webhook 推送地址；未设置则 webhook 渠道自动跳过 |
| `THS_WEBHOOK_TOKEN` | 选 | 附加在请求头 `X-Token`（下发方自校验） |
| `THS_ACCESS_CODE` | 选 | 站点访问口令；**未设置完全放行**（默认）；设置后非定时调用需传同值 |
| `THS_API_BASE_URL` | 选 | API 基址（默认 `https://fuyao.aicubes.cn`） |

前端 `web/js/app.js` 内置 `ACCESS_KEY` 为 CloudBase **publishable key**（匿名作用域的公开凭据，设计上可公开，非密钥；请勿误删）。手机端「访问口令」（accessCode）与这个 key 无关。

### 6.5 部署（重要——有坑）

**云函数**：⚠️ **不要使用 `tcb fn deploy`** —— 历史多次出现"幽灵成功"（CLI 报成功但线上函数未真正更新）。正确做法：

- 用 CloudBase MCP（`manageFunctions` → `updateFunctionCode`，传 `functionRootPath=cloudfunctions/<函数名>`）更新代码；
- 更新后到控制台确认函数代码版本时间戳已变化。
- 函数新增环境变量 → 控制台/编辑配置。

**前端（静态托管）**：

```bash
tcb hosting deploy -e REDACTED_CLOUDBASE_ENV_ID <web/ 的绝对路径> /ths
```

- 注意 `tcb hosting deploy` **不支持** `--dir / --path` 参数：位置路径 `本地绝对路径` + `/ths`（云端路径）；
- 前端资源引用带版本查询参数（如 `css/style.css?v=20260831f`），**每次改前端必须把三处（css/js/vendor 引用）的 `?v=` 统一改成新版本号**，否则 CDN 缓存会让线上仍然扩散旧资源；部署后浏览器强刷验证。

**数据库与权限调整**：CloudBase 控制台 / MCP（增集合、改权限、加唯一索引、手动查数据）。

## 7. 开发约定

1. **共享环境资源命名**：一律 `ths-` / `ths_` 前缀；新增资源 先查看避免与别的项目冲突。
2. **只能通过云函数改库**；新增集合记得设权限、必要时加索引（如 `ths_watchlist.code` 唯一索引）。
3. **公共库是复制、不是符号**（§3 目录说明）；改 `ths-api.js/trading-time.js/access-guard.js` 后逐个函数同步。
4. **node-sdk 版本适配**：`update().get()` 返回结构兼容 `{updated:N}` 或 `{stats:{updated:N}}`，业务代码里都做了兼容读取；新增类似代码照抄。
5. **失败隔离**：单只行情失败 → `quoteError` 记录继续；渠道分发失败 → console 记录；历史缓存写失败 → 下次重建。绝不让一个标的失败中断整批。
6. **交易时间以东八区**（`+8` 固定偏移、无夏令时）；前端时间显示同理。
7. **敏感信息**：禁止提交任何真实 `THS_API_KEY`、`THS_WEBHOOK_TOKEN`、`THS_ACCESS_CODE`、账号口令、Cookie 等到代码库 / README / CLAUDE.md。前端只允许 publishable key。
8. **测试数据清理**：只允许按已知 `code` / `_id` 精确删除；禁止模糊（正则/批量 like）删除。
9. **601137：「博威合金」（买入价 18 / 卖出价 21）为用户手工添加的长期保留项，禁止删除或修改其价格线**（本工程唯一的固定要素）——改动数据不是代码正常更新范围。

## 8. 当前状态（2026-08-31）

**已完成（线上可用）**：
- 监控 CRUD + 批量导入（支持 skip/update/overwrite 策略）
- 每 10 秒定时监控（内节流 30s）+ 手动强制刷新
- 价格穿越触发（买）：跌破 / 卖：涨破，防重复（CAS + rearm），首次观测特判
- 达成标记（achievedAt）与前端筛分「全部 / 进行中 / 已达成 🏁」
- 目标价 × 折扣自动换算（编辑表单实时预览），折扣换算进价格线
- 提醒记录（分页）+ Webhook 通知（可选）+ 通知渠道注册表模式
- 详情页：年度行情（2025/2026 YTD）、历史日线表格（周期×区间表格）、距离双卡、状态徽章、无交易按钮
- 行情错误单条隔离、交易日历缓存、节假日假日配置
- 前端指纹版本化（`?v=**`）部署 `?v=20260831f` 已在生产验证

**当前数据规模**：约 10 条监控标的（其中 601137 为手工添加，勿删）。

## 9. 已知问题 / 坑（接手游程注意事项）

| # | 问题 | 状态 |
|---|---|---|
| 1 | `tcb fn deploy` **"幽灵成功"**：报成功但线上函数未更新 → 一律改用 MCP `updateFunctionCode` 并确认时间戳 | 已知，已规避 |
| 2 | 同花顺批量行情"全有或全无"：混入无效代码 → 整批失败 → 已内置并发 5 降级逐码 | 已处理 |
| 3 | CDN 静态缓存：前端资源必须靠 `?v=` 版本号，改完必 +1 | 已处理 |
| 4 | `ths-import-watches` 创建的文档缺 `targetPrice/buyDiscount/sellDiscount` 缺省字段，与单条添加不一致 | **待确认** — 如需统一再补初始化 |
| 5 | 历史行情缓存未命中/写缓存失败静默（`catch`），会导致同一天内多次请求偶尔拉 API | 有意的降级 |
| 6 | 交易时间边界：分钟整数判断（570–690、780–900 区间端点为整分钟），9:30:30 之类的秒级边界视为交易 | 按设计（秒级误差可忽略） |
| 7 | 提醒：today 提醒数（`alertsToday`）按北京日 0 点统计，云函数时区与前端一致 | 正常 |

## 10. 后续计划 / 扩展点（非当前需求，标注为"建议"而非已承诺）

- 通知渠道扩展：NotificationService 已按 `register({name, send})` 设计，可添加 Telegram / 邮件 / 企业微信等（建议未来需求）
- 历史序列更长时间窗口（当前锚定 2023-12 起，`MAX_POINTS=8000` 已够年到近期）
- Webhook 重试/签名校验（当前一次尝试、无签名验签）
- 行情错误重试策略（目前失败只标记，下次扫描重试）
- `ths-config` 界面化修改（monitorIntervalSec、holidays 目前控制台/直接改 db）

> 该项目侧的已知需要沿用到新需求时优先参考 README「扩展指南」一节，README 长期领先部分以 CLAUDE.md 为准。

## 附：历史文档与现状对照

- `jihua1.md`：为二期「价格距离指标 + 历史行情详情」实施计划（重提交以退出计划模式时写入）；对照现网实现（详情页、YTD、历史表格、缓存），**计划中内容已全部实现**，该文件仅作留档不再作为待办。
- `README.md`：用户支持下使用说明（较长较详），涉及部署与踩坑描述与本文一致；遇到两者冲突时以其当时的实际代码行为/最新部署为准，并反馈同步。