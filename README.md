# dsh-relay-watchdog

DSH 插件：监测「模型 / 中转站 API」调用失败，自动重试并在重试前注入续跑指令；回合失败后自动重新唤醒对话，避免“以为在跑、其实已经停了”的假死局面。

- 纯逻辑插件，无网络遥测、无数据外发、不收集任何用户内容。
- 所有运行时记录只保存在插件进程内存里（`incidents`，条数可配），重启即清空。

## 功能

- **两层兜底**
  1. step 内自动重试：连接类失败出现时退避后原步重试，重试前把一条可配置的「从断点继续」指令注入会话。
  2. 回合级复活：重试耗尽、回合以 error 结束时，冷却后 `agent.followup()` 重新唤醒对话（次数可限）。
- **输出截断续跑**：回合因达到 token 上限（`max-tokens`）被截断时，也会冷却后自动重新唤醒并从截断处继续，避免“任务做到一半静默停住”。
- **快→稳退避**：断联类错误先快速连试几次，仍失败则转固定稳态间隔，兼顾“瞬时错误快恢复”和“持续故障不猛打”。
- **限流保守**：`RATE_LIMIT`(429) 不打快速连试，按固定间隔排队（带 ±10% 抖动），并优先尊重服务端 `Retry-After`。
- **耗尽即终态（防无限乒乓）**：`stopAfterExhaustion=true` 时，单步重试耗尽后终止本回合（不把失败放行给下游重试插件），由回合级复活接管——与随附的 `dsh-llm-retry` 并存时也不会互相接力导致同一 step 无限重试。
- **消息关键词兜底**：`retryableMessagePatterns` 默认包含 `upstream` / `524` / `temporarily unavailable` / `rate limit exceeded`，可匹配上游不带状态码的裸错误消息（例如 pi-ai 适配器把 502 文本归为 `PI_AI_ERROR`，或 Cloudflare 网关超时 `524 status code (no body)`）。
- **预算自适应**：`resetBudgetOnSuccess=true` 时，会话出现一次成功回合即清零自动唤醒次数，中转站恢复后预算重新计满。
- **人工接管开关**：`manualOverride=true` 时只检测/记录，不做任何自动动作，方便手动介入。
- **错误收集**：`collectAllErrors=true` 时，所有 API 模型调用错误（不论是否连接类）都记入 `incidents`，避免漏判。
- **独立设置页**：接入 DSH 设置面板，注册独立 `settings.section`，全部参数可视化调整、即时生效。
- **状态接口**：`GET /dsh-relay-watchdog/status` 返回配置摘要与最近事件记录（本机诊断接口，不放行跨域）。

## 默认行为逻辑

> 默认：`maxRetries=8, stopAfterExhaustion=true, fastRetryCount=3, fastRetryDelayMs=800, steadyRetryDelayMs=30000, rateLimitBaseDelayMs=15000, maxDelayMs=30000, jitterRatio=0.1, restartCooldownMs=15000, maxAutoRestartsPerSession=5, reviveOnMaxTokens=true, resetBudgetOnSuccess=true`

### 断联类错误（TRANSPORT / SERVER / TIMEOUT / HTTP_502/503/504 / UNKNOWN）

首次失败记为 `t0`：

| 第 N 次重试 | 距 t0 | 间隔 |
| --- | --- | --- |
| 1 | ~0.8s | 0.8s |
| 2 | ~1.6s | 0.8s |
| 3 | ~2.4s | 0.8s |
| 4 | ~32.4s | 30s |
| 5 | ~62.4s | 30s |
| 6 | ~92.4s | 30s |
| 7 | ~122.4s | 30s |
| 8 | ~152.4s | 30s |

- 单 step 内最多重试 8 次（含最初那次共 9 次模型调用），约 2.5 分钟后放弃本步。
- 所有延迟带 ±10% 抖动。

### 429 限流（RATE_LIMIT）

- 不打快速连试，每次按 `15s × (1 ± 10%)` 抖动排队：约 13.5s、27s、40.5s、54s、67.5s、81s、94.5s、108s。
- 约 2 分钟后放弃本步（`stopAfterExhaustion=true` 时以终态结束回合）；若服务端返回 `Retry-After`，则一次等待 = `min(Retry-After, 30s)`。

### 回合级复活

- step 重试耗尽（或回合以连接类 error 结束）后，等待 15s 再 `followup` 重新唤醒。
- 每会话最多自动复活 5 次；最坏全程约 16.5 分钟，之后停止自动动作（期间每个错误均已记录）。
- **输出截断（max-tokens）**：`reviveOnMaxTokens=true` 时，回合因达到 token 上限被截断也按同一冷却/预算规则自动续跑，注入独立的「截断续跑指令」。
- **预算自适应**：`resetBudgetOnSuccess=true` 时，会话出现一次成功回合即清零自动唤醒次数，避免中转站恢复后预算永久耗尽。
- **耗尽即终态**：`stopAfterExhaustion=true`（默认）时，单步重试耗尽不再把失败放行给下游重试插件（如随附的 `dsh-llm-retry`），避免同一 step 被两个重试层接力、回合永不结束；改为以 error 终态结束回合，由本层复活接管。若你希望保留下游重试接管，可将其设为 `false`。

## 安装

### 一键安装（推荐）

把本仓库地址直接交给 DSH 的 `plugin` 子命令，DSH 会自动下载、装配进你的 profile，无需手动改任何配置：

```bash
dsh plugin --profile web add github:Wokaor/dsh-relay-watchdog
```

- `--profile web` 是「网页版」的 profile，也可换成你自己的 profile 名（如 `tui`）。
- 也支持完整链接写法：

```bash
dsh plugin --profile web add https://github.com/Wokaor/dsh-relay-watchdog
```

- 本仓库已提交**预编译的 `lib/`**，安装过程不运行任何构建脚本，开箱即用。

**工作原理**：`dsh plugin <参数>` 会把 `add` 后面的参数原样转给 `pnpm` 在 profile 目录里执行；本包的 `package.json` 声明了 `dsh.bundle.patch`，所以 `pnpm` 装完后 DSH 会自动把它识别为一个 bundle 加入 profile 的装配列表，重启 DSH 即生效。

### 从源码构建（插件开发者）

直接把此网站链接发给dsh，自动化安装即可。

```bash
# 有 DSH 源码 checkout 时，用它的 tsc 从 src 编译到 lib；否则校验预编译的 lib/。
bash scripts/build.sh
```

### 手动挂载（参考）

如果不用 `dsh plugin`，也可把 `cordis.patch.yml` 里的条目合并进 profile 配置树：

```yaml
- insert:
    - id: dsh-relay-watchdog
      name: 'dsh-relay-watchdog'
```

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `manualOverride` | `false` | 人工接管：只检测/记录，不自动处理 |
| `collectAllErrors` | `true` | 收集所有 API 模型调用错误（防漏判） |
| `watchAll` | `true` | 监测所有对话 |
| `sessionIdPattern` | `""` | 只监测会话 id 包含该子串的对话（配合 `watchAll:false`） |
| `retryableCodes` | `TRANSPORT, SERVER, TIMEOUT, RATE_LIMIT, HTTP_502, HTTP_503, HTTP_504, UNKNOWN` | 连接类失败错误码 |
| `retryableStatuses` | `[500, 502, 503, 504, 524]` | 连接类失败 HTTP 状态码（含上游 500 gateway error、Cloudflare 524 网关超时） |
| `retryableMessagePatterns` | `upstream, 524, temporarily unavailable, rate limit exceeded` | 按错误消息关键词兜底匹配（`upstream` 覆盖各类上游错误文本、`524` 覆盖无响应体网关超时） |
| `maxRetries` | `8` | 单 step 内最大重试次数 |
| `stopAfterExhaustion` | `true` | 单步重试耗尽后终止本回合（不交给下游重试插件），由回合级复活接管 |
| `fastRetryCount` | `3` | 快速重试次数 |
| `fastRetryDelayMs` | `800` | 快速重试间隔（ms） |
| `steadyRetryDelayMs` | `30000` | 稳态重试间隔（ms） |
| `rateLimitBaseDelayMs` | `15000` | 429 固定排队间隔（ms） |
| `maxDelayMs` | `30000` | `Retry-After` 封顶（ms） |
| `jitterRatio` | `0.1` | 抖动比例 0~1 |
| `appendInstruction` | `true` | 重试前是否注入续跑指令 |
| `instruction` | 见源码 | 续跑指令模板（支持 `{provider}`/`{code}`/`{status}`/`{message}`/`{turn}`/`{step}`/`{attempt}`/`{sessionId}`/`{model}`） |
| `instructionCooldownMs` | `60000` | 同会话注入指令的最小间隔 |
| `restartOnTurnError` | `true` | 回合错误后是否自动重新唤醒 |
| `reviveOnMaxTokens` | `true` | 回合因 token 上限截断时是否自动续跑 |
| `restartInstruction` | 见源码 | 重新唤醒指令模板 |
| `cutoffInstruction` | 见源码 | 截断续跑指令模板（支持 `{provider}`/`{model}`/`{code}`/`{status}`/`{message}`/`{count}`/`{sessionId}`） |
| `restartCooldownMs` | `15000` | 复活冷却（ms） |
| `maxAutoRestartsPerSession` | `5` | 每会话最大自动复活次数 |
| `resetBudgetOnSuccess` | `true` | 成功回合后清零该会话复活预算，重新计满 |
| `enableApi` | `true` | 是否注册状态路由（启动时） |
| `maxIncidents` | `200` | 内存中保留的事件条数 |

## 状态接口

`GET /dsh-relay-watchdog/status`（需 `enableApi=true`，走 DSH `webServer`）返回配置摘要、活跃复活计数、最近事件记录（`incidents`）。

## 目录结构

```
├── lib/               # 预编译运行时代码（含浏览器设置卡片 client.js）
│   ├── index.js
│   └── client.js
├── src/               # TypeScript 源码
│   └── index.ts
├── scripts/build.sh   # 构建/校验脚本
├── cordis.patch.yml   # DSH bundle 挂载条目
├── tsconfig.json
├── package.json
└── README.md
```

## License

[MIT](./LICENSE)
