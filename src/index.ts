/**
 * dsh-relay-watchdog — DSH 中转站/模型 API 连接看门狗（TypeScript 源，供 checkout 重编译）。
 * 运行时入口等价实现见 lib/index.js（本机无 checkout/tsc 时直接热载 lib）。
 */
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'

export const name = 'dsh-relay-watchdog'
export const inject = ['agents']

const API_PREFIX = '/dsh-relay-watchdog'
const NS = settingsNamespace('relay-watchdog')

const DEFAULT_INSTRUCTION = [
  '【系统提示】刚刚一次模型请求因与中转站/模型服务连接中断而失败',
  '（provider={provider}，code={code}，status={status}）。',
  '这通常是瞬时网络抖动。请不要宣布任务失败，也不要空转或假装在运行。',
  '请先根据上文梳理已经完成的进度，然后从上次中断的位置继续执行，',
  '避免重复已完成的工作；若不确定某一步是否完成，请先用工具核实后再继续。',
].join('\n')

const DEFAULT_RESTART_INSTRUCTION = [
  '【系统提示】上一次模型请求因中转站/模型服务连接中断而提前结束，现在自动重新唤醒你继续。',
  '请先根据上下文确认进度，然后从中断处继续完成任务；',
  '不要重复已完成的工作，也不要假装还在运行。',
].join('\n')

const DEFAULT_CUTOFF_INSTRUCTION = [
  '【系统提示】上一次模型请求的输出因达到 token 上限被截断，任务尚未完成。',
  '请先根据上文梳理已经完成的进度，然后从截断处继续完成剩余工作；',
  '不要重复已完成的部分，也不要把未完成的任务当作已经完成。',
].join('\n')

const DEFAULTS = {
  enabled: true,
  manualOverride: false,
  collectAllErrors: true,
  watchAll: true,
  sessionIdPattern: '',
  retryableCodes: ['TRANSPORT', 'SERVER', 'TIMEOUT', 'RATE_LIMIT', 'HTTP_502', 'HTTP_503', 'HTTP_504', 'UNKNOWN'],
  retryableStatuses: [500, 502, 503, 504],
  retryableMessagePatterns: ['upstream', 'temporarily unavailable', 'rate limit exceeded'],
  maxRetries: 8,
  stopAfterExhaustion: true,
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
  reviveOnMaxTokens: true,
  restartInstruction: DEFAULT_RESTART_INSTRUCTION,
  cutoffInstruction: DEFAULT_CUTOFF_INSTRUCTION,
  restartCooldownMs: 15000,
  maxAutoRestartsPerSession: 5,
  resetBudgetOnSuccess: true,
  enableApi: true,
  maxIncidents: 200,
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  manualOverride: z.boolean().default(false),
  collectAllErrors: z.boolean().default(true),
  watchAll: z.boolean().default(true),
  sessionIdPattern: z.string().default(''),
  retryableCodes: z.array(z.string()).default(['TRANSPORT', 'SERVER', 'TIMEOUT', 'RATE_LIMIT', 'HTTP_502', 'HTTP_503', 'HTTP_504', 'UNKNOWN']),
  retryableStatuses: z.array(z.number()).default([500, 502, 503, 504]),
  retryableMessagePatterns: z.array(z.string()).default(['upstream', 'temporarily unavailable', 'rate limit exceeded']),
  maxRetries: z.number().step(1).min(0).default(8),
  stopAfterExhaustion: z.boolean().default(true),
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
  reviveOnMaxTokens: z.boolean().default(true),
  restartInstruction: z.string().default(DEFAULT_RESTART_INSTRUCTION),
  cutoffInstruction: z.string().default(DEFAULT_CUTOFF_INSTRUCTION),
  restartCooldownMs: z.number().min(0).default(15000),
  maxAutoRestartsPerSession: z.number().step(1).min(0).default(5),
  resetBudgetOnSuccess: z.boolean().default(true),
  enableApi: z.boolean().default(true),
  maxIncidents: z.number().step(1).min(1).default(200),
})

export function apply(ctx: any, config: any): void {
  const entry = { ...DEFAULTS, ...(config || {}) }
  let currentConfig: () => any = () => entry
  const cfg = () => currentConfig()

  const log = typeof ctx.logger === 'function' ? ctx.logger('dsh-relay-watchdog') : console

  const lifetime = new AbortController()
  const attempts = new Map<string, number>()
  const restarts = new Map<string, { count: number; lastAt: number }>()
  const lastInstructionAt = new Map<string, number>()
  const timers = new Set<any>()
  const routeDisposers: Array<() => void> = []
  const incidents: any[] = []
  const startedAt = Date.now()

  const wanted = (agent: any) => {
    const c = cfg()
    if (!c.enabled || !agent) return false
    const sid = String(agent.id ?? agent.session?.id ?? '')
    if (c.sessionIdPattern) return sid.includes(c.sessionIdPattern)
    return !!c.watchAll
  }

  const isConnectionFailure = (failure: any) => {
    if (!failure) return false
    const c = cfg()
    const code = String(failure.code ?? '').toUpperCase()
    const codes = new Set((c.retryableCodes || []).map((s: any) => String(s).toUpperCase()))
    if (code && codes.has(code)) return true
    if (Number.isInteger(failure.status) && new Set(c.retryableStatuses || []).has(failure.status)) return true
    const message = String(failure.message ?? '').toLowerCase()
    return (c.retryableMessagePatterns || []).some((p: any) => p && message.includes(String(p).toLowerCase()))
  }

  const canInjectInstruction = (sid: any) => {
    const c = cfg()
    if (!c.instructionCooldownMs) return true
    const last = lastInstructionAt.get(sid) ?? 0
    return Date.now() - last >= c.instructionCooldownMs
  }

  const render = (text: any, vars: Record<string, any>) => String(text ?? '').replace(
    /\{(\w+)\}/g,
    (_: any, k: string) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : `{${k}}`),
  )

  const pushIncident = (rec: any) => {
    incidents.push(rec)
    const max = Number(cfg().maxIncidents) || 200
    while (incidents.length > max) incidents.shift()
    return rec
  }

  // attempts 只增不减时的双保险：按插入序淘汰最旧条目，防长期会话内存无限增长
  const MAX_ATTEMPTS = 1000
  const pruneAttempts = () => {
    while (attempts.size > MAX_ATTEMPTS) {
      const oldest = attempts.keys().next().value
      if (oldest === undefined) break
      attempts.delete(oldest)
    }
  }

  // 清理某个会话的所有 (session,turn,step) 计数；回合结束即为该步的终点
  const clearAttemptsFor = (sessionId: string) => {
    const prefix = `${sessionId}\u0000`
    for (const key of attempts.keys()) {
      if (key.startsWith(prefix)) attempts.delete(key)
    }
  }

  const makeMessage = (text: string, summary: string) => createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: name, form: 'notice', summary },
  })

  const delayFor = (priorFailures: number, failure: any) => {
    const c = cfg()
    const ratio = Math.min(1, Math.max(0, Number(c.jitterRatio) || 0))
    const jitter = 1 - ratio + 2 * ratio * Math.random()

    // provider 明确返回 Retry-After 时优先尊重，封顶 maxDelayMs
    const cap = Math.max(0, Number(c.maxDelayMs) || 0)
    const retryAfter = failure && Number.isFinite(failure.providerRetryAfterMs) && failure.providerRetryAfterMs > 0
      ? failure.providerRetryAfterMs
      : undefined
    if (retryAfter !== undefined) return cap > 0 ? Math.min(retryAfter, cap) : retryAfter

    const code = String(failure?.code ?? '').toUpperCase()

    // 429 限流：不做快速连试，直接按保守固定间隔排队，避免越打越限
    if (code === 'RATE_LIMIT') {
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

  const cancellableDelay = (ms: number, signal: AbortSignal | undefined) => {
    const fused = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
    if (fused.aborted) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      let timer: any
      const onAbort = () => { clearTimeout(timer); resolve(false) }
      timer = setTimeout(() => {
        fused.removeEventListener('abort', onAbort)
        resolve(true)
      }, ms)
      fused.addEventListener('abort', onAbort, { once: true })
    })
  }

  ctx.on('agent/request-error', async (payload: any, next: any) => {
    if (lifetime.signal.aborted) return next()
    const { agent, turn, step, provider, failure, signal } = payload
    if (signal && signal.aborted) return next()
    try {
      const c = cfg()
      const conn = isConnectionFailure(failure)
      const watch = wanted(agent)
      const willAct = c.enabled && watch && conn

      if (c.collectAllErrors && !willAct) {
        pushIncident({
          id: randomUUID(), time: Date.now(), kind: 'error',
          sessionId: String(agent.id), turn, step, provider: provider ?? '',
          code: failure.code ?? '', status: failure.status ?? '', message: failure.message ?? '',
          attempt: null, note: 'unhandled: collectAllErrors 已收集',
        })
        log.info?.(`[${agent.id}] ${provider} step ${turn}/${step} API 调用错误已收集 (${failure.code ?? 'UNKNOWN'}${conn ? '' : '，非连接类'})`)
      }

      if (!willAct) return next()

      if (c.manualOverride) {
        pushIncident({
          id: randomUUID(), time: Date.now(), kind: 'detected',
          sessionId: String(agent.id), turn, step, provider: provider ?? '',
          code: failure.code ?? '', status: failure.status ?? '', message: failure.message ?? '',
          attempt: 0, note: 'manualOverride: 已记录但不自动处理',
        })
        log.info?.(`[${agent.id}] ${provider} step ${turn}/${step} 连接失败 (${failure.code ?? 'UNKNOWN'})；人工接管模式，不自动处理`)
        return next()
      }

      const stepKey = `${agent.id}\u0000${turn}\u0000${step}`
      const prior = attempts.get(stepKey) ?? 0
      if (prior >= c.maxRetries) {
        attempts.delete(stepKey)
        pushIncident({
          id: randomUUID(), time: Date.now(), kind: 'giveup',
          sessionId: String(agent.id), turn, step, provider: provider ?? '',
          code: failure.code ?? '', status: failure.status ?? '', message: failure.message ?? '',
          attempt: prior + 1,
          note: c.stopAfterExhaustion
            ? '单步重试耗尽：终止本回合，交由回合级复活接管'
            : '单步重试耗尽：已放行给下游重试处理器',
        })
        log.warn?.(`[${agent.id}] ${provider} step ${turn}/${step} 重试耗尽（${prior + 1} 次），` +
          (c.stopAfterExhaustion ? '终止本回合（阻断下游重试），等待回合级复活' : '放行给下游重试处理器'))
        // stopAfterExhaustion=true（默认）：不调用 next()，waterfall 语义下直接以返回值截断整条链，
        // 下游 dsh-llm-retry 不会再接管同一失败 → 回合以 error 终态结束 → 由第二层（turn/end）冷却后复活。
        if (c.stopAfterExhaustion) return undefined
        return next()
      }

      const attemptNo = prior + 1
      const delay = delayFor(prior, failure)
      log.info?.(`[${agent.id}] ${provider} step ${turn}/${step} 连接失败 (${failure.code ?? 'UNKNOWN'})，${delay}ms 后自动重试 ${attemptNo}/${c.maxRetries}`)

      const ok = await cancellableDelay(delay, signal)
      if (!ok || lifetime.signal.aborted) return next()

      if (prior === 0 && c.appendInstruction && canInjectInstruction(agent.id)) {
        try {
          const msg = makeMessage(
            render(c.instruction, {
              provider: provider ?? '', model: agent.options?.model ?? '',
              code: failure.code ?? '', status: failure.status ?? '', message: failure.message ?? '',
              turn, step, attempt: attemptNo, sessionId: String(agent.id),
            }),
            `relay-watchdog: API 连接失败，自动重试 ${attemptNo}/${c.maxRetries}`,
          )
          agent.session.append('user/message', msg, { surfaceOp: 'append' })
          lastInstructionAt.set(String(agent.id), Date.now())
        } catch (err) {
          log.warn?.('注入续跑指令失败（不影响重试）:', err && ((err as any).stack || String(err)))
        }
      }

      attempts.set(stepKey, attemptNo)
      pruneAttempts()
      pushIncident({
        id: randomUUID(), time: Date.now(), kind: 'retry',
        sessionId: String(agent.id), turn, step, provider: provider ?? '',
        code: failure.code ?? '', status: failure.status ?? '', message: failure.message ?? '',
        attempt: attemptNo,
      })
      return { kind: 'retry' }
    } catch (err) {
      log.warn?.('request-error 恢复流程异常，交由默认流程处理:', err && ((err as any).stack || String(err)))
      return next()
    }
  }, { prepend: true })

  function scheduleRestart(agent: any, failure: any, count: number, instructionOverride?: string, isCutoff?: boolean) {
    const delay = Math.max(0, Number(cfg().restartCooldownMs) || 0)
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (lifetime.signal.aborted) return
      try {
        const c = cfg()
        const current = ctx.agents && typeof ctx.agents.get === 'function' ? ctx.agents.get(agent.id) : undefined
        if (!current) return
        const note = makeMessage(
          render(instructionOverride ?? c.restartInstruction, {
            provider: current.options?.provider ?? '', model: current.options?.model ?? '',
            code: failure.code ?? '', status: failure.status ?? '', message: failure.message ?? '',
            count, sessionId: String(agent.id),
          }),
          isCutoff
            ? `relay-watchdog: 输出截断后自动续跑（第 ${count}/${c.maxAutoRestartsPerSession} 次）`
            : `relay-watchdog: 连接恢复后自动重新唤醒（第 ${count}/${c.maxAutoRestartsPerSession} 次）`,
        )
        current.followup(note)
        pushIncident({
          id: randomUUID(), time: Date.now(), kind: 'restart',
          sessionId: String(agent.id), turn: null, step: null,
          provider: current.options?.provider ?? '', code: failure.code ?? '',
          status: failure.status ?? '', message: failure.message ?? '', attempt: count,
        })
        log.info?.(`[${agent.id}] 自动${isCutoff ? '续跑' : '重新唤醒'}对话（第 ${count}/${c.maxAutoRestartsPerSession} 次，${failure.code ?? 'UNKNOWN'}）`)
      } catch (err) {
        log.warn?.('自动续跑 followup 失败:', err && ((err as any).stack || String(err)))
      }
    }, delay)
    timers.add(timer)
  }

  ctx.on('session/event', (session: any, event: any) => {
    if (lifetime.signal.aborted) return
    try {
      const c = cfg()
      if (event.type !== 'turn/end') return
      const reason = event.data && event.data.reason
      if (!reason) return

      // 任何回合结束时清理该会话的 attempts，避免 (session,turn,step) 计数无限累积
      clearAttemptsFor(String(session.id))

      const isError = reason.kind === 'error'
      const isCutoff = reason.kind === 'max-tokens'
      const isCompleted = reason.kind === 'completed'

      // 成功回合 = 中转站已恢复的信号：清零该会话的复活预算，之后可再次获得完整预算
      if (isCompleted && c.resetBudgetOnSuccess) {
        const st = restarts.get(String(session.id))
        if (st && st.count > 0) {
          restarts.set(String(session.id), { count: 0, lastAt: st.lastAt })
          log.info?.(`[${session.id}] 回合成功完成，自动唤醒预算已重置`)
        }
      }

      if (!isError && !isCutoff) return

      // 截断（max-tokens）不是 request-error，拿不到 failure：为两种场景统一构造失败事实
      const failure: any = isError
        ? (reason.error ?? { message: 'unknown turn error', code: 'UNKNOWN' })
        : { message: '输出达到 token 上限，回合被截断', code: 'MAX_TOKENS', status: undefined }

      const conn = isError ? isConnectionFailure(reason.error) : false
      const cutoffRevive = isCutoff && c.reviveOnMaxTokens
      const agent = ctx.agents && typeof ctx.agents.get === 'function' ? ctx.agents.get(session.id) : undefined
      const willAct = c.enabled && !c.manualOverride && c.restartOnTurnError && (conn || cutoffRevive) && agent && wanted(agent)

      // 日常收集：回合级错误/截断也入账（与步内收集互补），避免漏判
      if (c.collectAllErrors && !willAct) {
        pushIncident({
          id: randomUUID(), time: Date.now(), kind: isCutoff ? 'cutoff' : 'error',
          sessionId: String(session.id), turn: null, step: null,
          provider: agent?.options?.provider ?? '',
          code: failure.code ?? '', status: failure.status ?? '', message: failure.message ?? '',
          attempt: null, note: isCutoff ? 'max-tokens: collectAllErrors 已收集' : 'turn-error: collectAllErrors 已收集',
        })
        log.info?.(`[${session.id}] 回合${isCutoff ? '截断' : '错误'}已收集 (${failure.code ?? 'UNKNOWN'})`)
      }

      if (!willAct) return

      const now = Date.now()
      const state = restarts.get(String(session.id)) || { count: 0, lastAt: 0 }
      if (now - state.lastAt < c.restartCooldownMs) return
      if (state.count >= c.maxAutoRestartsPerSession) return
      const nextState = { count: state.count + 1, lastAt: now }
      restarts.set(String(session.id), nextState)
      scheduleRestart(agent, failure, nextState.count, isCutoff ? c.cutoffInstruction : undefined, isCutoff)
    } catch (err) {
      log.warn?.('turn-error 自动续跑处理异常:', err && ((err as any).stack || String(err)))
    }
  })

  const status = () => {
    const c = cfg()
    return {
      name, ok: true, startedAt, uptimeMs: Date.now() - startedAt,
      enabled: !!c.enabled, manualOverride: !!c.manualOverride, collectAllErrors: !!c.collectAllErrors,
      watchAll: !!c.watchAll, sessionIdPattern: c.sessionIdPattern,
      retryableCodes: [...(c.retryableCodes || [])],
      retryableStatuses: [...(c.retryableStatuses || [])],
      retryableMessagePatterns: [...(c.retryableMessagePatterns || [])],
      maxRetries: c.maxRetries, stopAfterExhaustion: !!c.stopAfterExhaustion, fastRetryCount: c.fastRetryCount, fastRetryDelayMs: c.fastRetryDelayMs, steadyRetryDelayMs: c.steadyRetryDelayMs, rateLimitBaseDelayMs: c.rateLimitBaseDelayMs, maxDelayMs: c.maxDelayMs,
      appendInstruction: !!c.appendInstruction, instructionCooldownMs: c.instructionCooldownMs,
      restartOnTurnError: !!c.restartOnTurnError, reviveOnMaxTokens: !!c.reviveOnMaxTokens, restartCooldownMs: c.restartCooldownMs, maxAutoRestartsPerSession: c.maxAutoRestartsPerSession, resetBudgetOnSuccess: !!c.resetBudgetOnSuccess,
      activeRestarts: Object.fromEntries([...restarts.entries()]),
      incidents: incidents.slice(-30).reverse(),
    }
  }

  if (cfg().enableApi) {
    const webServer = ctx.get('webServer')
    if (webServer && typeof webServer.register === 'function') {
      const json = (res: any, code: number, obj: any) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        // 本地诊断接口不放行任意跨域源（避免任意网页经 CORS 读本机会话信息），并禁止缓存
        res.setHeader('Cache-Control', 'no-store')
        res.statusCode = code
        res.end(JSON.stringify(obj))
      }
      const route = {
        kind: 'exact',
        path: API_PREFIX + '/status',
        handler: (req: any, res: any) => {
          if (req.method && req.method !== 'GET') return json(res, 405, { error: 'GET only' })
          try { json(res, 200, status()) } catch (err) { json(res, 500, { error: String((err && (err as any).stack) || err) }) }
        },
      }
      try {
        const dispose = webServer.register(route)
        routeDisposers.push(dispose)
      } catch (err) {
        log.warn?.('注册状态路由失败（可能已存在）:', API_PREFIX + '/status', String(err))
      }
    } else {
      log.warn?.('webServer 不可用，状态路由未启用')
    }
  }

  ctx.provide('relayWatchdog', {
    status,
    reset() { attempts.clear(); restarts.clear(); lastInstructionAt.clear(); incidents.length = 0 },
    incidents: () => incidents.slice().reverse(),
    forceRestart(sessionId: any) {
      const c = cfg()
      const agent = ctx.agents && typeof ctx.agents.get === 'function' ? ctx.agents.get(sessionId) : undefined
      if (!agent) throw new Error(`relay-watchdog: no live agent for session ${sessionId}`)
      agent.followup(makeMessage(
        render(c.restartInstruction, { sessionId: String(agent.id), code: 'MANUAL', status: '', message: 'manual', count: 0 }),
        'relay-watchdog: 手动唤醒',
      ))
      return { ok: true }
    },
  })

  installSettingsSection(ctx, NS, Config, entry, {
    setSource: (source) => { currentConfig = source },
    onChange: () => {},
  })

  ctx.effect(() => () => {
    lifetime.abort(new Error('dsh-relay-watchdog disposed'))
    for (const t of timers) clearTimeout(t)
    timers.clear()
    for (const d of routeDisposers) { try { d() } catch {} }
    routeDisposers.length = 0
  }, 'dsh-relay-watchdog: teardown')

  log.info?.('dsh-relay-watchdog 已启动', {
    enabled: cfg().enabled, manualOverride: cfg().manualOverride, collectAllErrors: cfg().collectAllErrors,
    watchAll: cfg().watchAll, sessionIdPattern: cfg().sessionIdPattern,
    maxRetries: cfg().maxRetries, stopAfterExhaustion: cfg().stopAfterExhaustion,
    restartOnTurnError: cfg().restartOnTurnError, reviveOnMaxTokens: cfg().reviveOnMaxTokens, resetBudgetOnSuccess: cfg().resetBudgetOnSuccess,
    retryableMessagePatterns: cfg().retryableMessagePatterns,
  })
}