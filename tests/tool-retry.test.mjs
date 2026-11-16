/**
 * Deterministic unit tests for the tool-retry policy.
 *
 * The harness models the real dispatch contract: `next()` runs the dispatching
 * attempt and throws on a second call (DSH's dispatcher does exactly that), and
 * every retry goes through `ctx.tools.execute()`. No network, no long timers, no
 * DSH runtime.
 *
 * Run: node --test tests/tool-retry.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  apply,
  backoffDelay,
  classifyFailure,
  coversTool,
  resolveConfig,
} from '../index.js'

const success = (text = 'ok') => ({ isError: false, value: { text }, content: [{ type: 'text', text }] })
const failure = (code, message = 'boom') => ({
  isError: true,
  content: [{ type: 'text', text: `Error: ${message}` }],
  error: { message, ...(code === undefined ? {} : { info: { name: 'ToolError', code } }) },
})

/**
 * Build a context whose `tools.execute` serves scripted retry results.
 * `script[0]` is the result of the first attempt; `script[n]` of retry n. The
 * last entry repeats.
 */
function harness(script) {
  const listeners = []
  const logs = []
  const redispatches = []
  let produced = 0
  const take = () => script[Math.min(produced++, script.length - 1)]
  const ctx = {
    logger: {
      info: (...args) => logs.push(['info', args]),
      warn: (...args) => logs.push(['warn', args]),
    },
    on(event, listener) {
      listeners.push({ event, listener })
      return () => {}
    },
    tools: {
      async execute(input) {
        redispatches.push(input)
        const call = input.calls[0]
        return { results: [{ callId: call.id, result: take() }], additionalContexts: [], concluded: false }
      },
    },
  }
  /** Run the plugin once; `next` is single-use, like the real dispatcher. */
  const run = (exec) => {
    const entry = listeners.find((item) => item.event === 'tools/execute')
    assert.ok(entry, 'plugin registered a tools/execute listener')
    let used = false
    const next = async () => {
      if (used) throw new Error('next() called multiple times')
      used = true
      return take()
    }
    return entry.listener(exec, next)
  }
  return { ctx, run, logs, redispatches, attempts: () => produced }
}

const signal = () => new AbortController().signal
const exec = (name = 'web_fetch', extra = {}) => ({ name, callId: 'call-1', arguments: { url: 'x' }, signal: signal(), ...extra })

// Tests never touch the real ledger: every policy below disables auditing
// unless the case is about the ledger itself.
const fastPolicy = { initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0, audit: false }

test('a successful covered call runs once and re-dispatches nothing', async () => {
  const h = harness([success()])
  apply(h.ctx, fastPolicy)
  const result = await h.run(exec())
  assert.equal(result.isError, false)
  assert.equal(h.attempts(), 1)
  assert.equal(h.redispatches.length, 0)
})

test('an uncovered tool is never retried even when the failure looks transient', async () => {
  const h = harness([failure('ETIMEDOUT')])
  apply(h.ctx, fastPolicy)
  await h.run(exec('read'))
  assert.equal(h.attempts(), 1)
  assert.equal(h.redispatches.length, 0)
})

test('a covered tool with a non-transient code is not retried', async () => {
  const h = harness([failure('PERMISSION_DENIED')])
  apply(h.ctx, fastPolicy)
  await h.run(exec())
  assert.equal(h.attempts(), 1)
})

test('a transient failure is retried through the tool service and the recovery is returned', async () => {
  const h = harness([failure('ETIMEDOUT'), success('second')])
  apply(h.ctx, fastPolicy)
  const result = await h.run(exec())
  assert.equal(h.attempts(), 2)
  assert.equal(h.redispatches.length, 1)
  assert.equal(result.isError, false)
  assert.equal(result.value.text, 'second')
  assert.equal(h.logs.length, 1, 'one retry is logged')
})

test('the retry keeps the call identity and passes no log, so no durable events duplicate', async () => {
  const h = harness([failure('HTTP_503'), success()])
  apply(h.ctx, fastPolicy)
  await h.run(exec())
  const input = h.redispatches[0]
  assert.equal(input.calls[0].id, 'call-1')
  assert.equal(input.calls[0].name, 'web_fetch')
  assert.equal(JSON.parse(input.calls[0].arguments).url, 'x')
  assert.equal('log' in input, false)
})

test('attempts stop at maxAttempts and the last real failure is returned unchanged', async () => {
  const h = harness([failure('HTTP_503', 'service unavailable')])
  apply(h.ctx, { ...fastPolicy, maxAttempts: 3 })
  const result = await h.run(exec('web_search'))
  assert.equal(h.attempts(), 3)
  assert.equal(result.isError, true)
  assert.equal(result.error.info.code, 'HTTP_503')
})

test('maxAttempts 1 disables retrying entirely', async () => {
  const h = harness([failure('ETIMEDOUT')])
  apply(h.ctx, { ...fastPolicy, maxAttempts: 1 })
  await h.run(exec())
  assert.equal(h.attempts(), 1)
  assert.equal(h.redispatches.length, 0)
})

test('denyTools wins over retryTools', async () => {
  const h = harness([failure('ETIMEDOUT')])
  apply(h.ctx, { ...fastPolicy, retryTools: ['pwsh'], denyTools: ['pwsh'] })
  await h.run(exec('pwsh'))
  assert.equal(h.attempts(), 1)
})

test('a cancellation or denial code is never retried, even if configured as retryable', async () => {
  for (const code of ['APPROVAL_REJECTED', 'TOOL_ABORTED']) {
    const h = harness([failure(code)])
    apply(h.ctx, { ...fastPolicy, retryableCodes: ['APPROVAL_REJECTED', 'TOOL_ABORTED'] })
    await h.run(exec())
    assert.equal(h.attempts(), 1, `${code} must not be retried`)
  }
})

test('an already-aborted caller is dispatched once and not retried', async () => {
  const h = harness([failure('ETIMEDOUT')])
  apply(h.ctx, fastPolicy)
  const controller = new AbortController()
  controller.abort()
  await h.run(exec('web_fetch', { signal: controller.signal }))
  assert.equal(h.attempts(), 1)
})

test('abort during backoff cuts the wait and stops the retry loop', async () => {
  const h = harness([failure('ETIMEDOUT')])
  apply(h.ctx, { initialDelayMs: 50, maxDelayMs: 50, jitterRatio: 0, audit: false })
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 10)
  const started = Date.now()
  const result = await h.run(exec('web_fetch', { signal: controller.signal }))
  const elapsed = Date.now() - started
  assert.equal(result.isError, true)
  assert.equal(h.attempts(), 1, 'the aborted backoff never re-dispatched')
  assert.ok(elapsed < 45, `waited ${elapsed}ms instead of the full 50ms`)
})

test('the message fallback retries a codeless "fetch failed" failure', async () => {
  const h = harness([failure(undefined, 'web fetch failed: TypeError: fetch failed'), success()])
  apply(h.ctx, fastPolicy)
  const result = await h.run(exec())
  assert.equal(h.attempts(), 2)
  assert.equal(result.isError, false)
})

test('an unknown code with a matching message is retried end to end', async () => {
  const h = harness([failure('WEB_PROVIDER_ERROR', 'web fetch failed: TypeError: fetch failed'), success()])
  apply(h.ctx, fastPolicy)
  const result = await h.run(exec())
  assert.equal(h.attempts(), 2)
  assert.equal(result.isError, false)
})

test('an empty retryablePattern disables the message fallback', async () => {
  const h = harness([failure(undefined, 'fetch failed')])
  apply(h.ctx, { ...fastPolicy, retryablePattern: '' })
  await h.run(exec())
  assert.equal(h.attempts(), 1)
})

test('an empty retryTools allowlist makes the plugin inert', async () => {
  const h = harness([failure('ETIMEDOUT')])
  apply(h.ctx, { ...fastPolicy, retryTools: [] })
  await h.run(exec())
  assert.equal(h.attempts(), 1)
})

test('every retry and its final outcome land in the audit ledger', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tool-retry-'))
  try {
    const file = join(dir, 'audit.jsonl')
    const h = harness([failure('ETIMEDOUT')])
    apply(h.ctx, { ...fastPolicy, audit: true, auditFile: file, maxAttempts: 2 })
    await h.run(exec())
    const lines = (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(lines.length, 2)
    assert.deepEqual(lines.map((line) => line.event), ['retry', 'exhausted'])
    assert.equal(lines[0].tool, 'web_fetch')
    assert.equal(lines[0].callId, 'call-1')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an unwritable ledger path never throws into the tool call', async () => {
  const h = harness([failure('ETIMEDOUT'), success()])
  apply(h.ctx, { ...fastPolicy, audit: true, auditFile: 'Z:\\nope\\audit.jsonl' })
  const result = await h.run(exec())
  assert.equal(result.isError, false)
})

test('diagnostics records the verdict of a non-retryable failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tool-retry-'))
  try {
    const file = join(dir, 'audit.jsonl')
    const h = harness([failure('PERMISSION_DENIED')])
    apply(h.ctx, { ...fastPolicy, audit: true, auditFile: file, diagnostics: true })
    await h.run(exec())
    const lines = (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    assert.deepEqual(lines.map((line) => line.event), ['verdict'])
    assert.equal(lines[0].retryable, false)
    assert.equal(lines[0].code, 'PERMISSION_DENIED')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a re-dispatched attempt re-entering the listener does not multiply attempts', async () => {
  const h = harness([failure('ETIMEDOUT')])
  apply(h.ctx, { ...fastPolicy, maxAttempts: 3 })
  // Model the real re-entry: tools.execute runs the whole pipeline again, so the
  // listener sees a brand-new execution object.
  h.ctx.tools.execute = async (input) => {
    const call = input.calls[0]
    const nested = { name: call.name, callId: call.id, arguments: {}, signal: signal() }
    const result = await h.run(nested)
    return { results: [{ callId: call.id, result }], additionalContexts: [], concluded: false }
  }
  await h.run(exec())
  assert.equal(h.attempts(), 3, 'three dispatches, not nine')
})

test('backoffDelay doubles, caps, and stays inside the jitter band', () => {
  const policy = resolveConfig({ initialDelayMs: 400, maxDelayMs: 1_000, jitterRatio: 0.2 })
  assert.equal(backoffDelay(policy, 1, () => 0.5), 400)
  assert.equal(backoffDelay(policy, 2, () => 0.5), 800)
  assert.equal(backoffDelay(policy, 3, () => 0.5), 1_000, 'capped at maxDelayMs')
  assert.equal(backoffDelay(policy, 1, () => 0), 320, 'lower jitter band')
  assert.ok(Math.abs(backoffDelay(policy, 1, () => 0.999_999) - 480) < 1e-3, 'upper jitter band')
  assert.ok(backoffDelay(policy, 40, () => 0.5) <= 1_000)
})

test('coversTool: exact names, MCP prefix, and the deny rules that beat both', () => {
  const policy = resolveConfig({ retryTools: ['web_fetch'], denyTools: ['bash'] })
  assert.equal(coversTool({ name: 'web_fetch' }, policy), true)
  assert.equal(coversTool({ name: 'read' }, policy), false)
  assert.equal(coversTool({ name: '' }, policy), false)
  assert.equal(coversTool({}, policy), false)
  // MCP tools are covered by prefix, including unknown servers.
  assert.equal(coversTool({ name: 'mcp__qixin__enterprise_resolve' }, policy), true)
  assert.equal(coversTool({ name: 'mcp__some-new-server__anything' }, policy), true)
  // Denying beats the prefix: mutating MCP tools by shape, and exact names.
  assert.equal(coversTool({ name: 'mcp__qixin__feedback_submit' }, policy), false)
  assert.equal(coversTool({ name: 'mcp__yuandian-case__yuandian_report_issue' }, policy), false)
  assert.equal(coversTool({ name: 'mcp__deepin-hermes__deepin_shell' }, policy), false)
  assert.equal(coversTool({ name: 'mcp__tavily__tavily_research' }, policy), false)
  assert.equal(coversTool({ name: 'bash' }, policy), false)
  // An empty prefix never matches everything.
  const emptyPrefix = resolveConfig({ retryTools: [], retryToolPrefixes: [''] })
  assert.equal(coversTool({ name: 'web_fetch' }, emptyPrefix), false)
})

test('an MCP query tool is retried on a transient failure', async () => {
  const h = harness([failure('ETIMEDOUT'), success('rows')])
  apply(h.ctx, fastPolicy)
  const result = await h.run(exec('mcp__qixin__enterprise_resolve'))
  assert.equal(h.attempts(), 2)
  assert.equal(result.isError, false)
})

test('a mutating MCP tool is never retried, even on a transient failure', async () => {
  const h = harness([failure('ETIMEDOUT')])
  apply(h.ctx, fastPolicy)
  await h.run(exec('mcp__qixin__feedback_submit'))
  assert.equal(h.attempts(), 1)
  assert.equal(h.redispatches.length, 0)
})

test('classifyFailure: a listed code decides alone, an unknown code defers to the message', () => {
  const policy = resolveConfig({})
  const pattern = new RegExp(policy.retryablePattern, 'i')
  assert.equal(classifyFailure(success(), policy, pattern).retry, false)
  assert.equal(classifyFailure(failure('ETIMEDOUT', 'anything'), policy, pattern).retry, true)
  assert.equal(classifyFailure(failure('ETIMEDOUT', 'boom'), policy, pattern).retry, true, 'listed code needs no message match')
  assert.equal(classifyFailure(failure('PERMISSION_DENIED', 'boom'), policy, pattern).retry, false)
  assert.equal(classifyFailure(failure('PERMISSION_DENIED', 'timed out'), policy, pattern).retry, true)
  assert.equal(
    classifyFailure(failure('WEB_PROVIDER_ERROR', 'web fetch failed: TypeError: fetch failed'), policy, pattern).retry,
    true,
    'the live web-fetch code is unknown, so the message decides',
  )
  const strict = resolveConfig({ unknownCodeFallsBackToMessage: false })
  assert.equal(classifyFailure(failure('PERMISSION_DENIED', 'timed out'), strict, pattern).retry, false)
})

test('invalid configuration fails loudly instead of retrying nothing', () => {
  assert.throws(() => resolveConfig({ maxAttempts: 0 }), /maxAttempts/)
  assert.throws(() => resolveConfig({ jitterRatio: 2 }), /jitterRatio/)
  assert.throws(() => resolveConfig({ retryTools: 'web_fetch' }), /retryTools/)
  assert.throws(() => resolveConfig({ initialDelayMs: Number.NaN }), /initialDelayMs/)
})
