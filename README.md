# dsh-relay-watchdog

DSH 插件：监测「模型 / 中转站 API」调用失败，自动重试并在重试前注入续跑指令；回合失败后自动重新唤醒对话，避免“以为在跑、其实已经停了”的假死局面。

- 纯逻辑插件，无网络遥测、无数据外发、不收集任何用户内容。
- 所有运行时记录只保存在插件进程内存里（`incidents`，条数可配），重启即清空。

## 功能

- **两层兜底**
  1. step 内自动重试：连接类失败出现时退避后原步重试，重试前把一条可配置的「从断点继续」指令注入会话。
  2. 回合级复活：重试耗尽、回合以 error 结束时，冷却后 `agent.followup()` 重新唤醒对话（次数可限）。
- **快→稳退避**：断联类错误先快速连试几次，仍失败则转固定稳态间隔，兼顾“瞬时错误快恢复”和“持续故障不猛打”。
- **限流保守**：`RATE_LIMIT`(429) 不打快速连试，按固定间隔排队，并优先尊重服务端 `Retry-After`。
- **人工接管开关**：`manualOverride=true` 时只检测/记录，不做任何自动动作，方便手动介入。
- **错误收集**：`collectAllErrors=true` 时，所有 API 模型调用错误（不论是否连接类）都记入 `incidents`，避免漏判。
- **独立设置页**：接入 DSH 设置面板，注册独立 `settings.section`，全部参数可视化调整、即时生效。
- **状态接口**：`GET /dsh-relay-watchdog/status` 返回配置摘要与最近事件记录。

## 默认行为逻辑

> 默认：`maxRetries=8, fastRetryCount=3, fastRetryDelayMs=800, steadyRetryDelayMs=30000, rateLimitBaseDelayMs=15000, maxDelayMs=30000, jitterRatio=0.1, restartCooldownMs=15000, maxAutoRestartsPerSession=5`

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

- 不打快速连试，每次固定 15s：15s、30s、45s、60s、75s、90s、105s、120s。
- 约 2 分钟后放弃本步；若服务端返回 `Retry-After`，则一次等待 = `min(Retry-After, 30s)`。

### 回合级复活

- step 重试耗尽、回合以 error 结束后，等待 15s 再 `followup` 重新唤醒。
- 每会话最多自动复活 5 次；最坏全程约 16.5 分钟，之后停止自动动作（期间每个错误均已记录）。

## 安装

本插件是 [DSH](https://github.com/deepseek-ai/DeepSeek-Harness) 的 Cordis bundle，运行期由 DSH 宿主提供依赖（`@deepseek-ai/*`、`schemastery` 等）。

直接把此网站链接发给dsh，自动化安装即可。

```bash
# 有 DSH 源码 checkout 时，用它的 tsc 从 src 编译到 lib；否则校验预编译的 lib/。
bash scripts/build.sh
```

挂载方式：把本包加入 DSH profile 的 bundle 列表（`cordis.patch.yml` 的 `insert` 已给出条目模板）：

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
| `retryableStatuses` | `[502, 503, 504]` | 连接类失败 HTTP 状态码 |
| `retryableMessagePatterns` | `[]` | 按错误消息关键词兜底匹配 |
| `maxRetries` | `8` | 单 step 内最大重试次数 |
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
| `restartInstruction` | 见源码 | 重新唤醒指令模板 |
| `restartCooldownMs` | `15000` | 复活冷却（ms） |
| `maxAutoRestartsPerSession` | `5` | 每会话最大自动复活次数 |
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
