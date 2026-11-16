/**
 * Tool-call retry policy for DeepSeek Harness.
 *
 * DSH retries model requests (`@deepseek-ai/dsh-llm-retry` at
 * `agent/request-error`) and enforces per-tool deadlines
 * (`@deepseek-ai/dsh-tool-call-timeout-policy` at `tools/execute`), but no
 * installed row retries a *tool call* itself. This plugin adds that layer at the
 * `tools/execute` waterfall, whose mode is documented as "for timeout, retry, or
 * metrics".
 *
 * The waterfall's `next()` is single-use (the dispatcher throws
 * `next() called multiple times`), so a retry cannot re-enter the remaining
 * chain. It re-dispatches instead: `ctx.tools.execute()` with one call and no
 * `log`, which runs the whole invocation pipeline again — so timeout policy,
 * guards, approvals, and post-execute all apply to the new attempt — while
 * `BatchSettlement` appends no second `tool/call` / `tool/result` pair. The
 * retry is therefore transparent to the session log, which is why this plugin
 * keeps its own audit ledger (append-only JSONL that never throws, the same
 * discipline as Hermes cron's `usage_audit.jsonl`).
 *
 * Two source-studied rules shape the policy:
 *
 * - Classification before retry (NousResearch/hermes-agent
 *   `agent/error_classifier.py` + `agent/retry_utils.py:121 jittered_backoff`):
 *   only failures whose code or message says "transient" are retried, and the
 *   delay is `base * 2^(n-1)` capped, spread by uniform jitter so parallel
 *   callers de-correlate.
 * - Strict mode for everything not proven idempotent (openclaw
 *   `src/infra/retry-policy.ts:104-116` `strictShouldRetry`, whose comment turns
 *   the regex fallback off for non-idempotent sends to avoid duplicate
 *   delivery): a tool must be named in an allowlist or sit under an allowed
 *   prefix (`mcp__`), and an exact deny list plus a deny name pattern always
 *   win — MCP servers expose mutating tools whose names differ per server, so
 *   denying by shape beats enumerating every spelling.
 *
 * @module @caiyy0823/dsh-tool-retry
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-retry-policy'

/** The tool registry this plugin re-dispatches through. */
export const inject = ['tools']

/**
 * Failures that are never retried whatever the configuration says: a denial or
 * a cancellation is a decision, and re-running it would either re-ask the user
 * or repeat work the caller already stopped. Codes come from
 * `@deepseek-ai/dsh-tools` (`APPROVAL_*`, `TOOL_ABORTED*`) plus the
 * argument/tool-resolution failures that cannot change on a second attempt.
 */
export const NEVER_RETRY_CODES = Object.freeze([
  'APPROVAL_REJECTED',
  'APPROVAL_CANCELLED',
  'APPROVAL_UNAVAILABLE',
  'APPROVAL_ERROR',
  'TOOL_ABORTED',
  'TOOL_ABORTED_BEFORE_DISPATCH',
  'UNKNOWN_TOOL',
  'INVALID_ARGUMENTS',
  'TOOL_RESULT_CONTRACT',
])

/** Tools that mutate state or spend money, refused even if an allowlist names them. */
const DEFAULT_DENY_TOOLS = Object.freeze([
  'bash',
  'pwsh',
  'write',
  'edit',
  'send_message',
  'workflow',
  'schedule_create',
  'schedule_edit',
  'subagent',
  'subagent_fork',
  'subagent_claude_code',
  'subagent_codex',
])

/**
 * Name pattern for tools that must never be retried, whatever prefix covers
 * them. MCP is the reason this exists: a prefix allowlist sweeps in every tool a
 * server exposes, including the mutating ones, and their names differ per server
 * (`feedback_submit` exists on four different servers). Denying by shape covers
 * them all instead of enumerating each `mcp__<server>__<tool>` spelling.
 */
const DEFAULT_DENY_PATTERN =
  'feedback_submit|report_issue|deepin_shell|deepin_hermes_oneshot|deepin_cron_action|tavily_research|schedule_|send_message'

/**
 * Prefixes whose tools are retryable by default. `mcp__` is the DSH convention
 * for MCP-provided tools, so every read-only query tool a server exposes is
 * covered without listing dozens of names.
 */
const DEFAULT_RETRY_TOOL_PREFIXES = Object.freeze(['mcp__'])

/** Transient codes returned by network tools and by the timeout wrapper. */
const DEFAULT_RETRYABLE_CODES = Object.freeze([
  'TOOL_TIMEOUT',
  'ETIMEDOUT',
  'ECONNRESET',
  'EAI_AGAIN',
  'EPIPE',
  'HTTP_429',
  'HTTP_502',
  'HTTP_503',
  'HTTP_504',
  'RATE_LIMITED',
  'UPSTREAM_UNAVAILABLE',
])

/**
 * Message fallback for failures whose code is missing or unknown. Kept
 * deliberately narrow: a match here is the only path that retries a tool whose
 * error code this plugin does not know.
 */
const DEFAULT_RETRYABLE_PATTERN =
  '\\b(429|502|503|504)\\b|rate.?limit|too many requests|temporar(?:il)?y unavailable|timed out|timeout|socket hang up|econnreset|etimedout|eai_again|fetch failed|network error|connection reset'

/** Runtime schema for {@link Config}; also projected into Settings. */
export const Config = z.object({
  maxAttempts: z.natural().min(1).max(6).default(3)
    .description('Total dispatch attempts for one tool call, including the first. 1 disables retrying.'),
  initialDelayMs: z.natural().min(0).max(60_000).default(400)
    .description('Delay before the second attempt. Doubles per attempt, then stops at maxDelayMs.'),
  maxDelayMs: z.natural().min(0).max(120_000).default(20_000)
    .description('Upper bound for one backoff delay.'),
  jitterRatio: z.number().min(0).max(1).default(0.2)
    .description('Uniform jitter as a fraction of the delay; 0.2 spreads each delay by ±20%.'),
  retryTools: z.array(z.string()).default(['web_fetch', 'web_search'])
    .description('Exact tool names that may be retried. Empty disables exact-name retrying.'),
  retryToolPrefixes: z.array(z.string()).default([...DEFAULT_RETRY_TOOL_PREFIXES])
    .description('Name prefixes whose tools may be retried. Default "mcp__" covers MCP servers; denyTools and denyPattern still win.'),
  denyTools: z.array(z.string()).default([...DEFAULT_DENY_TOOLS])
    .description('Exact tool names never retried; wins over every allowlist.'),
  denyPattern: z.string().default(DEFAULT_DENY_PATTERN)
    .description('Case-insensitive regular expression matched against the tool name; a match is never retried. Empty disables the name deny list.'),
  retryableCodes: z.array(z.string()).default([...DEFAULT_RETRYABLE_CODES])
    .description('Error codes treated as transient.'),
  retryablePattern: z.string().default(DEFAULT_RETRYABLE_PATTERN)
    .description('Case-insensitive regular expression matched against the error message. Empty disables the message fallback.'),
  unknownCodeFallsBackToMessage: z.boolean().default(true)
    .description('When a failure carries an error code this policy does not list, let the message pattern decide. A code listed as non-retryable always wins.'),
  audit: z.boolean().default(true)
    .description('Append one JSON line per retry to the audit ledger.'),
  diagnostics: z.boolean().default(false)
    .description('Also record every covered dispatch, not just retries. Use to confirm the listener is wired.'),
  auditFile: z.string().default('')
    .description('Audit ledger path. Empty means <home>/.dsh/tool-retry-audit.jsonl.'),
})

/**
 * Marks the async chain of an attempt this plugin is already retrying, so the
 * re-dispatched call's own listener pass returns `next()` untouched instead of
 * multiplying attempts. Async-local rather than a shared set: concurrent tool
 * calls each carry their own store.
 */
const RETRYING = new AsyncLocalStorage()

/**
 * Normalize a row's config into the exact values the listener uses.
 * @param {Record<string, unknown> | undefined} config - row config from `cordis.patch.yml`.
 * @returns validated policy values.
 * @throws TypeError when a supplied value has the wrong shape; the row then
 * fails activation instead of silently retrying nothing.
 */
export function resolveConfig(config) {
  const raw = config ?? {}
  const number = (key, fallback) => {
    const value = raw[key]
    if (value === undefined) return fallback
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError(`tool-retry-policy: "${key}" must be a finite number`)
    }
    return value
  }
  const strings = (key, fallback) => {
    const value = raw[key]
    if (value === undefined) return [...fallback]
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new TypeError(`tool-retry-policy: "${key}" must be an array of strings`)
    }
    return [...value]
  }
  const maxAttempts = Math.trunc(number('maxAttempts', 3))
  if (maxAttempts < 1) throw new TypeError('tool-retry-policy: "maxAttempts" must be at least 1')
  const maxDelayMs = Math.max(0, number('maxDelayMs', 20_000))
  const jitterRatio = number('jitterRatio', 0.2)
  if (jitterRatio < 0 || jitterRatio > 1) throw new TypeError('tool-retry-policy: "jitterRatio" must be between 0 and 1')
  const auditFile = raw.auditFile === undefined ? '' : String(raw.auditFile)
  const denyPattern = raw.denyPattern === undefined ? DEFAULT_DENY_PATTERN : String(raw.denyPattern)
  return {
    maxAttempts,
    initialDelayMs: Math.max(0, number('initialDelayMs', 400)),
    maxDelayMs,
    jitterRatio,
    retryTools: strings('retryTools', ['web_fetch', 'web_search']),
    retryToolPrefixes: strings('retryToolPrefixes', DEFAULT_RETRY_TOOL_PREFIXES),
    denyTools: strings('denyTools', DEFAULT_DENY_TOOLS),
    denyPattern,
    denyNamePattern: denyPattern === '' ? undefined : new RegExp(denyPattern, 'i'),
    retryableCodes: strings('retryableCodes', DEFAULT_RETRYABLE_CODES),
    retryablePattern: raw.retryablePattern === undefined ? DEFAULT_RETRYABLE_PATTERN : String(raw.retryablePattern),
    unknownCodeFallsBackToMessage: raw.unknownCodeFallsBackToMessage === undefined
      ? true
      : raw.unknownCodeFallsBackToMessage !== false,
    audit: raw.audit === undefined ? true : raw.audit !== false,
    diagnostics: raw.diagnostics === true,
    auditFile,
  }
}

/**
 * Exponential backoff with uniform jitter, mirroring Hermes
 * `agent/retry_utils.py:121` (`base * 2^(n-1)`, capped) and the DSH
 * `@deepseek-ai/dsh-llm-retry` `localDelay` shape.
 * @param {ReturnType<typeof resolveConfig>} policy - resolved values.
 * @param {number} attempt - 1-based attempt that just failed.
 * @param {() => number} random - sample in [0, 1).
 * @returns delay in milliseconds.
 */
export function backoffDelay(policy, attempt, random) {
  const exponent = Math.min(Math.max(attempt - 1, 0), 30)
  const exponential = Math.min(policy.initialDelayMs * 2 ** exponent, policy.maxDelayMs)
  const jitter = 1 - policy.jitterRatio + 2 * policy.jitterRatio * random()
  return Math.min(Math.max(exponential * jitter, 0), policy.maxDelayMs)
}

/**
 * Whether this dispatch may be retried at all: an allowlisted name (exact, or
 * under an allowed prefix such as `mcp__`) that no deny rule rejects — openclaw's
 * strict mode, where unknown names never retry.
 * @param {{ name?: string }} exec - the execution under the waterfall.
 * @param {ReturnType<typeof resolveConfig>} policy - resolved values.
 * @returns whether the policy covers this tool.
 */
export function coversTool(exec, policy) {
  const toolName = typeof exec?.name === 'string' ? exec.name : ''
  if (toolName === '') return false
  if (policy.denyTools.includes(toolName)) return false
  if (policy.denyNamePattern !== undefined && policy.denyNamePattern.test(toolName)) return false
  if (policy.retryTools.includes(toolName)) return true
  return policy.retryToolPrefixes.some((prefix) => prefix !== '' && toolName.startsWith(prefix))
}

/**
 * Text a model would see for this result, used only for the message fallback.
 * @param {any} result - dispatch result from the terminal `next()`.
 * @returns concatenated text blocks.
 */
export function resultText(result) {
  const content = Array.isArray(result?.content) ? result.content : []
  const text = content
    .map((block) => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('\n')
  const message = typeof result?.error?.message === 'string' ? result.error.message : ''
  return message === '' ? text : `${message}\n${text}`
}

/**
 * Classify one failed dispatch.
 *
 * A code the policy knows decides alone: never-retry codes are final, listed
 * transient codes retry. A code it does *not* know — DSH tools invent their own,
 * such as `WEB_PROVIDER_ERROR` — defers to the message pattern by default,
 * because that is the only signal left; set `unknownCodeFallsBackToMessage`
 * false to make unknown codes final instead.
 *
 * @param {any} result - dispatch result from the terminal `next()`.
 * @param {ReturnType<typeof resolveConfig>} policy - resolved values.
 * @param {RegExp | undefined} pattern - compiled message fallback.
 * @returns `{ retry: boolean, code?: string }`; never throws.
 */
export function classifyFailure(result, policy, pattern) {
  if (result?.isError !== true) return { retry: false }
  const code = result?.error?.info?.code
  const matchesMessage = () => pattern !== undefined && pattern.test(resultText(result))
  if (typeof code === 'string' && code !== '') {
    if (NEVER_RETRY_CODES.includes(code)) return { retry: false, code }
    if (policy.retryableCodes.includes(code)) return { retry: true, code }
    if (!policy.unknownCodeFallsBackToMessage) return { retry: false, code }
    return { retry: matchesMessage(), code }
  }
  return { retry: matchesMessage() }
}

/**
 * Cancellable wait; resolves `false` when the caller aborted first.
 * @param {number} delayMs - backoff delay.
 * @param {AbortSignal | undefined} signal - the execution's signal.
 * @returns whether the full delay elapsed.
 */
export function cancellableDelay(delayMs, signal) {
  if (signal?.aborted) return Promise.resolve(false)
  if (delayMs <= 0) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort() {
      clearTimeout(timer)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Default ledger location: the profile home, next to DSH's own storages.
 * @returns absolute path.
 */
function defaultAuditFile() {
  return join(homedir(), '.dsh', 'tool-retry-audit.jsonl')
}

/**
 * Build the audit writer. Writes are serialized, best-effort, and never throw:
 * a logging defect must not break a tool call (Hermes `_write_usage_audit`
 * carries the same rule in its docstring).
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context for logging.
 * @param {ReturnType<typeof resolveConfig>} policy - resolved values.
 * @returns `(entry: object) => Promise<void>`.
 */
function createAudit(ctx, policy) {
  if (!policy.audit) return async () => {}
  const file = policy.auditFile === '' ? defaultAuditFile() : policy.auditFile
  let queue = Promise.resolve()
  return (entry) => {
    queue = queue.then(async () => {
      try {
        await mkdir(dirname(file), { recursive: true })
        await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8')
      } catch (error) {
        ctx.logger?.warn?.('tool-retry-policy: audit write failed: %o', error)
      }
    })
    return queue
  }
}

/**
 * Re-dispatch one call through the tool service.
 *
 * No `log` is passed, so the batch settlement appends no durable events: the
 * session keeps the single `tool/call` / `tool/result` pair written for the
 * original dispatch. The call keeps its `callId`, agent, and tool set, so
 * scoping, restrictions, and timeout policy resolve exactly as before.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context with `tools`.
 * @param {{ name: string, callId?: string, arguments?: unknown, agent?: unknown, toolSet?: unknown, signal?: AbortSignal }} exec
 *   the execution under the waterfall.
 * @returns the retried dispatch result, or `undefined` when the service returned none.
 */
export async function redispatch(ctx, exec) {
  const calls = [{
    type: 'tool-call',
    id: exec.callId,
    name: exec.name,
    arguments: JSON.stringify(exec.arguments ?? {}),
  }]
  const batch = await ctx.tools.execute({
    calls,
    signal: exec.signal,
    ...(exec.agent === undefined ? {} : { agent: exec.agent }),
    ...(exec.toolSet === undefined ? {} : { toolSet: exec.toolSet }),
  })
  return batch?.results?.[0]?.result
}

/**
 * Install the retry wrapper on `tools/execute`.
 *
 * `next()` runs the dispatching attempt once; each retry re-dispatches through
 * {@link redispatch} after a jittered backoff. The value returned to the caller
 * is always a real dispatch result — never a synthesized one — so an eventual
 * failure is exactly what the tool produced on its final attempt.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context owning the listener.
 * @param {Record<string, unknown>} [config] - row config.
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const policy = resolveConfig(config)
  const pattern = policy.retryablePattern === '' ? undefined : new RegExp(policy.retryablePattern, 'i')
  const audit = createAudit(ctx, policy)
  const random = Math.random

  ctx.on('tools/execute', async (exec, next) => {
    if (!coversTool(exec, policy)) return next()
    if (RETRYING.getStore() === true) return next()
    if (exec.signal?.aborted) return next()

    return RETRYING.run(true, async () => {
      let result = await next()
      if (policy.diagnostics) {
        const verdict = classifyFailure(result, policy, pattern)
        await audit({
          at: new Date().toISOString(),
          event: 'verdict',
          tool: exec.name,
          isError: result?.isError === true,
          code: result?.error?.info?.code ?? null,
          retryable: verdict.retry,
          sessionId: exec.agent?.id ?? null,
          callId: exec.callId ?? null,
        })
      }
      let attempt = 1
      while (attempt < policy.maxAttempts) {
        const verdict = classifyFailure(result, policy, pattern)
        if (!verdict.retry) break
        if (exec.signal?.aborted) break
        const delayMs = backoffDelay(policy, attempt, random)
        await audit({
          at: new Date().toISOString(),
          event: 'retry',
          tool: exec.name,
          attempt,
          of: policy.maxAttempts,
          delayMs,
          code: verdict.code ?? null,
          sessionId: exec.agent?.id ?? null,
          callId: exec.callId ?? null,
        })
        ctx.logger?.info?.(
          'tool-retry-policy: retrying %s after attempt %d/%d in %dms (%s)',
          exec.name,
          attempt,
          policy.maxAttempts,
          delayMs,
          verdict.code ?? 'message match',
        )
        if (!await cancellableDelay(delayMs, exec.signal)) break
        attempt += 1
        const retried = await redispatch(ctx, exec)
        // Nothing came back: keep the last real result rather than inventing one.
        if (retried === undefined) {
          attempt -= 1
          break
        }
        result = retried
      }
      if (attempt > 1) {
        await audit({
          at: new Date().toISOString(),
          event: result?.isError === true ? 'exhausted' : 'recovered',
          tool: exec.name,
          attempts: attempt,
          code: result?.error?.info?.code ?? null,
          sessionId: exec.agent?.id ?? null,
          callId: exec.callId ?? null,
        })
      }
      return result
    })
  })
}
