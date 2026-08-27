/**
 * dsh-relay-watchdog — DSH 中转站/模型 API 连接看门狗
 *
 * 解决一类"假跑"问题：中转站 API 连接中途断开，模型请求悄悄失败，对话看起来
 * 还在跑、实际上已经停下来。本插件在两层上兜底：
 *
 *   1. 步内续跑（agent/request-error）：连接类失败出现时，等待退避时间后
 *      向会话注入一段可配置的「续跑指令」，然后返回 { kind: 'retry' } 让
 *      Agent Loop 原步重试。重试时模型会读到这段指令，从而从断点继续。
 *   2. 回合级复活（turn/end + error）：若重试耗尽或其它插件让该回合以 error
 *      结束，则冷却一段时间后用 agent.followup() 重新唤醒对话（次数可限定）。
 *
 * 配置通过 DSH 设置界面（settings namespace: relay-watchdog）实时调整。
 * manualOverride=true 时进入「人工接管」：只检测/记录，不做任何自动重试或复活。
 */
import { randomUUID } from "node:crypto"
import z from "@deepseek-ai/schemastery"
import { createUserMessage } from "@deepseek-ai/dsh-llm"
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings"

export const name = "dsh-relay-watchdog"
export const inject = ["agents"]

const API_PREFIX = "/dsh-relay-watchdog"
const NS = settingsNamespace("relay-watchdog")

const DEFAULT_INSTRUCTION = [
  "【系统提示】刚刚一次模型请求因与中转站/模型服务连接中断而失败",
  "（provider={provider}，code={code}，status={status}）。",
  "这通常是瞬时网络抖动。请不要宣布任务失败，也不要空转或假装在运行。",
  "请先根据上文梳理已经完成的进度，然后从上次中断的位置继续执行，",
  "避免重复已完成的工作；若不确定某一步是否完成，请先用工具核实后再继续。",
].join("\n")

const DEFAULT_RESTART_INSTRUCTION = [
  "【系统提示】上一次模型请求因中转站/模型服务连接中断而提前结束，现在自动重新唤醒你继续。",
  "请先根据上下文确认进度，然后从中断处继续完成任务；",
  "不要重复已完成的工作，也不要假装还在运行。",
].join("\n")

const DEFAULTS = {
  enabled: true,
  manualOverride: false,
  collectAllErrors: true,
  watchAll: true,
  sessionIdPattern: "",
  retryableCodes: [
    "TRANSPORT", "SERVER", "TIMEOUT", "RATE_LIMIT",
    "HTTP_502", "HTTP_503", "HTTP_504", "UNKNOWN",
  ],
  retryableStatuses: [502, 503, 504],
  retryableMessagePatterns: [],
  maxRetries: 8,
  fastRetryCount: 3,
  fastRetryDelayMs: 800,
  steadyRetryDelayMs: 30000,
  rateLimitBaseDelayMs: 15000,
  maxDelayMs: 30000,
  jitterRatio: 0.1,
  appendInstruction: true,
  instruction: DEFAULT_INSTRUCTION,
  instructionCooldownMs: 60000,
  restartOnTurnError: true,
  restartInstruction: DEFAULT_RESTART_INSTRUCTION,
  restartCooldownMs: 15000,
  maxAutoRestartsPerSession: 5,
  enableApi: true,
  maxIncidents: 200,
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  manualOverride: z.boolean().default(false),
  collectAllErrors: z.boolean().default(true),
  watchAll: z.boolean().default(true),
  sessionIdPattern: z.string().default(""),
  retryableCodes: z.array(z.string()).default([
    "TRANSPORT", "SERVER", "TIMEOUT", "RATE_LIMIT",
    "HTTP_502", "HTTP_503", "HTTP_504", "UNKNOWN",
  ]),
  retryableStatuses: z.array(z.number()).default([502, 503, 504]),
  retryableMessagePatterns: z.array(z.string()).default([]),
  maxRetries: z.number().step(1).min(0).default(8),
  fastRetryCount: z.number().step(1).min(0).max(30).default(3),
  fastRetryDelayMs: z.number().min(0).default(800),
  steadyRetryDelayMs: z.number().min(0).default(30000),
  rateLimitBaseDelayMs: z.number().min(0).default(15000),
  maxDelayMs: z.number().min(0).default(30000),
  jitterRatio: z.number().min(0).max(1).default(0.1),
  appendInstruction: z.boolean().default(true),
  instruction: z.string().default(DEFAULT_INSTRUCTION),
  instructionCooldownMs: z.number().min(0).default(60000),
  restartOnTurnError: z.boolean().default(true),
  restartInstruction: z.string().default(DEFAULT_RESTART_INSTRUCTION),
  restartCooldownMs: z.number().min(0).default(15000),
  maxAutoRestartsPerSession: z.number().step(1).min(0).default(5),
  enableApi: z.boolean().default(true),
  maxIncidents: z.number().step(1).min(1).default(200),
})

/**
 * @param {any} ctx
 * @param {any} config
 */
export function apply(ctx, config) {
  const entry = { ...DEFAULTS, ...(config || {}) }
  let currentConfig = () => entry
  const cfg = () => currentConfig()

  const log = typeof ctx.logger === "function" ? ctx.logger("dsh-relay-watchdog") : console

  const lifetime = new AbortController()
  const attempts = new Map() // stepKey -> attempt count
  const restarts = new Map() // session id -> { count, lastAt }
  const lastInstructionAt = new Map() // session id -> last injected instruction timestamp
  const timers = new Set()   // active restart timers
  const routeDisposers = []
  const incidents = []
  const startedAt = Date.now()

  const wanted = (agent) => {
    const c = cfg()
    if (!c.enabled || !agent) return false
    const sid = String(agent.id ?? agent.session?.id ?? "")
    if (c.sessionIdPattern) return sid.includes(c.sessionIdPattern)
    return !!c.watchAll
  }

  const isConnectionFailure = (failure) => {
    if (!failure) return false
    const c = cfg()
    const code = String(failure.code ?? "").toUpperCase()
    const codes = new Set((c.retryableCodes || []).map((s) => String(s).toUpperCase()))
    if (code && codes.has(code)) return true
    if (Number.isInteger(failure.status) && new Set(c.retryableStatuses || []).has(failure.status)) return true
    const message = String(failure.message ?? "").toLowerCase()
    return (c.retryableMessagePatterns || []).some((p) => p && message.includes(String(p).toLowerCase()))
  }

  const canInjectInstruction = (sid) => {
    const c = cfg()
    if (!c.instructionCooldownMs) return true
    const last = lastInstructionAt.get(sid) ?? 0
    return Date.now() - last >= c.instructionCooldownMs
  }

  const render = (text, vars) => String(text ?? "").replace(
    /\{(\w+)\}/g,
    (_, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : `{${k}}`),
  )

  const pushIncident = (rec) => {
    incidents.push(rec)
    const max = Number(cfg().maxIncidents) || 200
    while (incidents.length > max) incidents.shift()
    return rec
  }

  const makeMessage = (text, summary) => createUserMessage({
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: name, form: "notice", summary },
  })

  const delayFor = (priorFailures, failure) => {
    const c = cfg()
    const ratio = Math.min(1, Math.max(0, Number(c.jitterRatio) || 0))
    const jitter = 1 - ratio + 2 * ratio * Math.random()

    // provider 明确返回 Retry-After 时优先尊重，封顶 maxDelayMs
    const cap = Math.max(0, Number(c.maxDelayMs) || 0)
    const retryAfter = failure && Number.isFinite(failure.providerRetryAfterMs) && failure.providerRetryAfterMs > 0
      ? failure.providerRetryAfterMs
      : undefined
    if (retryAfter !== undefined) return cap > 0 ? Math.min(retryAfter, cap) : retryAfter

    const code = String(failure?.code ?? "").toUpperCase()

    // 429 限流：不做快速连试，直接按保守固定间隔排队，避免越打越限
    if (code === "RATE_LIMIT") {
      const base = Math.max(0, Number(c.rateLimitBaseDelayMs) || 0)
      return Math.max(0, base * jitter)
    }

    // 其它连接类错误（断联/网关/超时等）：先 fastRetryCount 次快速重试，再转稳态间隔
    const fastCount = Math.max(0, Number(c.fastRetryCount) || 0)
    const fastDelay = Math.max(0, Number(c.fastRetryDelayMs) || 0)
    const steady = Math.max(0, Number(c.steadyRetryDelayMs) || 0)
    const delay = priorFailures < fastCount ? fastDelay : steady
    return Math.max(0, delay * jitter)
  }

  const cancellableDelay = (ms, signal) => {
    const fused = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
    if (fused.aborted) return Promise.resolve(false)
    return new Promise((resolve) => {
      let timer
      const onAbort = () => { clearTimeout(timer); resolve(false) }
      timer = setTimeout(() => {
        fused.removeEventListener("abort", onAbort)
        resolve(true)
      }, ms)
      fused.addEventListener("abort", onAbort, { once: true })
    })
  }

  // ---------------- 第一层：步内续跑 ----------------
  ctx.on("agent/request-error", async (payload, next) => {
    if (lifetime.signal.aborted) return next()
    const { agent, turn, step, provider, failure, signal } = payload
    if (signal && signal.aborted) return next()
    try {
      const c = cfg()
      const conn = isConnectionFailure(failure)
      const watch = wanted(agent)
      const willAct = c.enabled && watch && conn

      // 日常收集（默认开）：所有 API 模型调用类错误都入账，避免以后漏判。
      // 不满足自动处理条件的（非连接类 / 关闭 / 不在监控范围）记成 unhandled，
      // 之后可从 /dsh-relay-watchdog/status 的 incidents 里回看并补进 retryable* 配置。
      if (c.collectAllErrors && !willAct) {
        pushIncident({
          id: randomUUID(), time: Date.now(), kind: "error",
          sessionId: String(agent.id), turn, step, provider: provider ?? "",
          code: failure.code ?? "", status: failure.status ?? "", message: failure.message ?? "",
          attempt: null, note: "unhandled: collectAllErrors 已收集",
        })
        log.info?.(`[${agent.id}] ${provider} step ${turn}/${step} API 调用错误已收集 (${failure.code ?? "UNKNOWN"}${conn ? "" : "，非连接类"})`)
      }

      if (!willAct) return next()

      if (c.manualOverride) {
        pushIncident({
          id: randomUUID(), time: Date.now(), kind: "detected",
          sessionId: String(agent.id), turn, step, provider: provider ?? "",
          code: failure.code ?? "", status: failure.status ?? "", message: failure.message ?? "",
          attempt: 0, note: "manualOverride: 已记录但不自动处理",
        })
        log.info?.(`[${agent.id}] ${provider} step ${turn}/${step} 连接失败 (${failure.code ?? "UNKNOWN"})；人工接管模式，不自动处理`)
        return next()
      }

      const stepKey = `${agent.id}\u0000${turn}\u0000${step}`
      const prior = attempts.get(stepKey) ?? 0
      // 重试耗尽就交给默认流程（回合以 error 结束），由第二层负责复活
      if (prior >= c.maxRetries) {
        attempts.delete(stepKey)
        return next()
      }

      const attemptNo = prior + 1
      const delay = delayFor(prior, failure)
      log.info?.(
        `[${agent.id}] ${provider} step ${turn}/${step} 连接失败 (${failure.code ?? "UNKNOWN"})，` +
        `${delay}ms 后自动重试 ${attemptNo}/${c.maxRetries}`,
      )

      const ok = await cancellableDelay(delay, signal)
      if (!ok || lifetime.signal.aborted) return next()

      // 只在本 step 的第一次失败后注入指令，并用全局冷却抑制持续断连期间的消息刷屏
      if (prior === 0 && c.appendInstruction && canInjectInstruction(agent.id)) {
        try {
          const msg = makeMessage(
            render(c.instruction, {
              provider: provider ?? "",
              model: agent.options?.model ?? "",
              code: failure.code ?? "",
              status: failure.status ?? "",
              message: failure.message ?? "",
              turn,
              step,
              attempt: attemptNo,
              sessionId: String(agent.id),
            }),
            `relay-watchdog: API 连接失败，自动重试 ${attemptNo}/${c.maxRetries}`,
          )
          agent.session.append("user/message", msg, { surfaceOp: "append" })
          lastInstructionAt.set(String(agent.id), Date.now())
        } catch (err) {
          log.warn?.("注入续跑指令失败（不影响重试）:", err && (err.stack || String(err)))
        }
      }

      attempts.set(stepKey, attemptNo)
      pushIncident({
        id: randomUUID(),
        time: Date.now(),
        kind: "retry",
        sessionId: String(agent.id),
        turn,
        step,
        provider: provider ?? "",
        code: failure.code ?? "",
        status: failure.status ?? "",
        message: failure.message ?? "",
        attempt: attemptNo,
      })
      return { kind: "retry" }
    } catch (err) {
      log.warn?.("request-error 恢复流程异常，交由默认流程处理:", err && (err.stack || String(err)))
      return next()
    }
  }, { prepend: true })

  // ---------------- 第二层：回合级复活 ----------------
  function scheduleRestart(agent, failure, count) {
    const delay = Math.max(0, Number(cfg().restartCooldownMs) || 0)
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (lifetime.signal.aborted) return
      try {
        const c = cfg()
        const current = ctx.agents && typeof ctx.agents.get === "function"
          ? ctx.agents.get(agent.id)
          : undefined
        if (!current) return

        const note = makeMessage(
          render(c.restartInstruction, {
            provider: current.options?.provider ?? "",
            model: current.options?.model ?? "",
            code: failure.code ?? "",
            status: failure.status ?? "",
            message: failure.message ?? "",
            count,
            sessionId: String(agent.id),
          }),
          `relay-watchdog: 连接恢复后自动重新唤醒（第 ${count} 次）`,
        )
        current.followup(note)
        pushIncident({
          id: randomUUID(),
          time: Date.now(),
          kind: "restart",
          sessionId: String(agent.id),
          turn: null,
          step: null,
          provider: current.options?.provider ?? "",
          code: failure.code ?? "",
          status: failure.status ?? "",
          message: failure.message ?? "",
          attempt: count,
        })
        log.info?.(`[${agent.id}] 自动重新唤醒对话（第 ${count}/${c.maxAutoRestartsPerSession} 次）`)
      } catch (err) {
        log.warn?.("自动续跑 followup 失败:", err && (err.stack || String(err)))
      }
    }, delay)
    timers.add(timer)
  }

  ctx.on("session/event", (session, event) => {
    if (lifetime.signal.aborted) return
    try {
      const c = cfg()
      if (event.type !== "turn/end") return
      const reason = event.data && event.data.reason
      if (!reason || reason.kind !== "error") return

      const conn = isConnectionFailure(reason.error)
      const agent = ctx.agents && typeof ctx.agents.get === "function"
        ? ctx.agents.get(session.id)
        : undefined
      const willAct = c.enabled && !c.manualOverride && c.restartOnTurnError && conn && agent && wanted(agent)

      // 日常收集：回合级错误也入账（与步内收集互补），避免漏判
      if (c.collectAllErrors && !willAct) {
        pushIncident({
          id: randomUUID(), time: Date.now(), kind: "error",
          sessionId: String(session.id), turn: null, step: null,
          provider: agent?.options?.provider ?? "",
          code: reason.error?.code ?? "", status: reason.error?.status ?? "", message: reason.error?.message ?? "",
          attempt: null, note: "turn-error: collectAllErrors 已收集",
        })
        log.info?.(`[${session.id}] 回合错误已收集 (${reason.error?.code ?? "UNKNOWN"})`)
      }

      if (!willAct) return

      const now = Date.now()
      const state = restarts.get(session.id) || { count: 0, lastAt: 0 }
      if (now - state.lastAt < c.restartCooldownMs) return
      if (state.count >= c.maxAutoRestartsPerSession) return
      const nextState = { count: state.count + 1, lastAt: now }
      restarts.set(session.id, nextState)
      scheduleRestart(agent, reason.error, nextState.count)
    } catch (err) {
      log.warn?.("turn-error 自动续跑处理异常:", err && (err.stack || String(err)))
    }
  })

  // ---------------- 状态/诊断出口 ----------------
  const status = () => {
    const c = cfg()
    return {
      name,
      ok: true,
      startedAt,
      uptimeMs: Date.now() - startedAt,
      enabled: !!c.enabled,
      manualOverride: !!c.manualOverride,
      collectAllErrors: !!c.collectAllErrors,
      watchAll: !!c.watchAll,
      sessionIdPattern: c.sessionIdPattern,
      retryableCodes: [...(c.retryableCodes || [])],
      retryableStatuses: [...(c.retryableStatuses || [])],
      retryableMessagePatterns: [...(c.retryableMessagePatterns || [])],
      maxRetries: c.maxRetries,
      fastRetryCount: c.fastRetryCount,
      fastRetryDelayMs: c.fastRetryDelayMs,
      steadyRetryDelayMs: c.steadyRetryDelayMs,
      rateLimitBaseDelayMs: c.rateLimitBaseDelayMs,
      maxDelayMs: c.maxDelayMs,
      appendInstruction: !!c.appendInstruction,
      instructionCooldownMs: c.instructionCooldownMs,
      restartOnTurnError: !!c.restartOnTurnError,
      restartCooldownMs: c.restartCooldownMs,
      maxAutoRestartsPerSession: c.maxAutoRestartsPerSession,
      activeRestarts: Object.fromEntries([...restarts.entries()]),
      incidents: incidents.slice(-30).reverse(),
    }
  }

  if (cfg().enableApi) {
    const webServer = ctx.get("webServer")
    if (webServer && typeof webServer.register === "function") {
      const json = (res, code, obj) => {
        res.setHeader("Content-Type", "application/json; charset=utf-8")
        res.setHeader("Access-Control-Allow-Origin", "*")
        res.statusCode = code
        res.end(JSON.stringify(obj))
      }
      const route = {
        kind: "exact",
        path: API_PREFIX + "/status",
        handler: (req, res) => {
          if (req.method && req.method !== "GET") return json(res, 405, { error: "GET only" })
          try {
            json(res, 200, status())
          } catch (err) {
            json(res, 500, { error: String((err && err.stack) || err) })
          }
        },
      }
      try {
        const dispose = webServer.register(route)
        routeDisposers.push(dispose)
      } catch (err) {
        log.warn?.("注册状态路由失败（可能已存在）:", API_PREFIX + "/status", String(err))
      }
    } else {
      log.warn?.("webServer 不可用，状态路由未启用")
    }
  }

  ctx.provide("relayWatchdog", {
    status,
    reset() {
      attempts.clear()
      restarts.clear()
      lastInstructionAt.clear()
      incidents.length = 0
    },
    incidents: () => incidents.slice().reverse(),
    forceRestart(sessionId) {
      const c = cfg()
      const agent = ctx.agents && typeof ctx.agents.get === "function"
        ? ctx.agents.get(sessionId)
        : undefined
      if (!agent) throw new Error(`relay-watchdog: no live agent for session ${sessionId}`)
      agent.followup(makeMessage(
        render(c.restartInstruction, { sessionId: String(agent.id), code: "MANUAL", status: "", message: "manual", count: 0 }),
        "relay-watchdog: 手动唤醒",
      ))
      return { ok: true }
    },
  })

  installSettingsSection(ctx, NS, Config, entry, {
    setSource: (source) => {
      currentConfig = source
    },
    onChange: () => {},
  })

  ctx.effect(() => () => {
    lifetime.abort(new Error("dsh-relay-watchdog disposed"))
    for (const t of timers) clearTimeout(t)
    timers.clear()
    for (const d of routeDisposers) {
      try { d() } catch { /* 路由可能已随 webServer 清理 */ }
    }
    routeDisposers.length = 0
  }, "dsh-relay-watchdog: teardown")

  log.info?.("dsh-relay-watchdog 已启动", {
    enabled: cfg().enabled,
    manualOverride: cfg().manualOverride,
    collectAllErrors: cfg().collectAllErrors,
    watchAll: cfg().watchAll,
    sessionIdPattern: cfg().sessionIdPattern,
    maxRetries: cfg().maxRetries,
    restartOnTurnError: cfg().restartOnTurnError,
  })
}