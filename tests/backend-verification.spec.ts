/** D31 readiness checks against a credential-free mock app-server. @module */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { verifyBackend } from '../src/backend-verification.ts'
import { BackendReadinessService, describeBackendSnapshot, type BackendReadinessOptions } from '../src/backend-readiness.ts'
import { Config } from '../src/index.ts'
import { openCodexConnection } from '../src/connection-codex.ts'
import type { BackendSpec } from '../src/pool.ts'
import { nodeSpawn } from './helpers/node-spawn.ts'

const mock = fileURLToPath(new URL('./mock-codex-server.ts', import.meta.url))
const dirs: string[] = []
const children: SubprocessHandle[] = []
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (!await child.waitForExit(AbortSignal.timeout(50))) child.terminate()
    await child.done.catch(() => {})
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setup(env: Record<string, string> = {}, model?: string, automatic?: true) {
  const dir = mkdtempSync(join(tmpdir(), 'acp-resume-verification-'))
  dirs.push(dir)
  const trace = join(dir, 'protocol.jsonl')
  const store = join(dir, 'threads.json')
  const spawnSpecs: SubprocessSpawnSpec[] = []
  const spawned: SubprocessHandle[] = []
  const onError = vi.fn()
  const spec: BackendSpec = {
    name: 'codex', description: 'Codex', protocol: 'codex', automatic,
    ...(model === undefined ? {} : { codex: { model } }),
    specBase: {
      command: process.execPath, args: [mock], permission: 'reject',
      env: { MOCK_CODEX_PROTOCOL_FILE: trace, MOCK_SESSION_STORE: store, ...env },
      disposeEofGraceMs: 250, disposeGraceMs: 250, onError,
      spawn: (params) => {
        spawnSpecs.push(params)
        const child = nodeSpawn(params)
        children.push(child)
        spawned.push(child)
        return child
      },
    },
  }
  function requests(): Array<{ method?: string; params?: Record<string, unknown> }> {
    return existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
  }
  async function check(signal = AbortSignal.timeout(5_000)) {
    const result = await verifyBackend(spec, signal)
    expect(spawned).toHaveLength(1)
    expect(await spawned[0]?.waitForExit(AbortSignal.timeout(1_000))).toBe(true)
    expect(existsSync(store)).toBe(false)
    expect(onError).not.toHaveBeenCalled()
    return result
  }
  return { spec, check, requests, spawnSpecs, onError }
}

const advertised = (model: string, isDefault = false, fields: Record<string, unknown> = {}) => ({ id: model, model, isDefault, hidden: false, ...fields })
const pages = (value: Record<string, unknown>) => ({ MOCK_CODEX_MODEL_PAGES: JSON.stringify(value) })

const methodNames = (requests: Array<{ method?: string }>) => requests.map(request => request.method)
const accountOnly = ['initialize', 'initialized', 'account/read']

describe('Codex backend verification', () => {
  it('reads only account, effective config and advertised models for automatic dispatch, without opening a thread', async () => {
    const { check, requests, spawnSpecs } = setup({}, undefined, true)
    expect(await check()).toEqual({ status: 'ready', model: 'mock-model', reported: { model: 'mock-model' } })
    expect(methodNames(requests())).toEqual([...accountOnly, 'config/read', 'model/list'])
    expect(requests()[2]?.params).toEqual({ refreshToken: false })
    expect(requests()[3]?.params).toEqual({ includeLayers: false })
    expect(spawnSpecs[0]?.stdio?.stderr).toBe('pipe')
  })

  it('reports the backend default model and effort independently of the dispatch override', async () => {
    const { check, requests } = setup({ MOCK_CODEX_CONFIG_MODEL: 'backend-default', MOCK_CODEX_CONFIG_EFFORT: 'high',
      ...pages({ '': { data: [advertised('backend-default'), advertised('override')], nextCursor: null } }) }, 'override')
    expect(await check()).toEqual({ status: 'ready', model: 'override', reported: { model: 'backend-default', effort: 'high' } })
    expect(methodNames(requests())).toEqual([...accountOnly, 'model/list', 'config/read'])
  })

  it('uses the matched display name and never infers effective effort from catalog recommendations', async () => {
    const { check } = setup({ MOCK_CODEX_CONFIG_MODEL: 'chosen', ...pages({
      '': { data: [advertised('chosen', false, { displayName: 'Chosen', defaultReasoningEffort: 'low' })] },
    }) })
    expect(await check()).toEqual({ status: 'ready', model: 'chosen', reported: { model: 'chosen', modelName: 'Chosen' } })
  })

  it('stops before model checks when the CLI requires login', async () => {
    const { check, requests } = setup({ MOCK_CODEX_SIGNED_OUT: '1' })
    expect(await check()).toEqual({ status: 'login-required' })
    expect(methodNames(requests())).toEqual(accountOnly)
  })

  it('allows a named provider that does not require an OpenAI account', async () => {
    const { check } = setup({ MOCK_CODEX_ACCOUNT_REPLY: JSON.stringify({ requiresOpenaiAuth: false, account: null }) }, 'mock-model')
    expect(await check()).toEqual({ status: 'ready', model: 'mock-model' })
  })

  it('requires explicit setup for an automatic provider that reports no account evidence', async () => {
    const { check, requests } = setup({ MOCK_CODEX_ACCOUNT_REPLY: JSON.stringify({ requiresOpenaiAuth: false, account: null }) }, undefined, true)
    expect(await check()).toEqual({ status: 'handshake-failed' })
    expect(methodNames(requests())).toEqual(accountOnly)
  })

  it('fails closed on malformed account state', async () => {
    const { check, requests } = setup({ MOCK_CODEX_ACCOUNT_REPLY: JSON.stringify({ requiresOpenaiAuth: true, account: 'untrusted value' }) })
    expect(await check()).toEqual({ status: 'handshake-failed' })
    expect(methodNames(requests())).toEqual(accountOnly)
  })

  it('preserves the configured Codex model over the catalog default, even on a later page', async () => {
    const { check, requests } = setup({ MOCK_CODEX_CONFIG_MODEL: 'chosen-model', ...pages({
      '': { data: [advertised('catalog-default', true)], nextCursor: 'page:two' },
      'page:two': { data: [advertised('chosen-model')], nextCursor: null },
    }) })
    expect(await check()).toEqual({ status: 'ready', model: 'chosen-model', reported: { model: 'chosen-model' } })
    expect(requests().filter(request => request.method === 'model/list').map(request => request.params)).toEqual([
      { limit: 100 }, { limit: 100, cursor: 'page:two' },
    ])
  })

  it('does not replace an unavailable configured model with a catalog default', async () => {
    const { check } = setup({ MOCK_CODEX_CONFIG_MODEL: 'not-in-catalog' })
    expect(await check()).toEqual({ status: 'model-required' })
  })

  it('keeps a verified explicit model usable even if the backend defaults cannot be read', async () => {
    const { check, requests } = setup({ ...pages({
      '': { data: [advertised('catalog-default', true), advertised('named-model', false, { id: 'explicit-id' })] },
    }), MOCK_CODEX_CONFIG_ERROR: 'defaults unavailable' }, 'explicit-id')
    expect(await check()).toEqual({ status: 'ready', model: 'explicit-id' })
    expect(methodNames(requests())).toEqual([...accountOnly, 'model/list', 'config/read'])
  })

  it('distinguishes an unavailable explicit model override from a missing default', async () => {
    const { check } = setup({}, 'unavailable-override')
    expect(await check()).toEqual({ status: 'model-override-unavailable' })
  })

  it('selects a later-page default using the thread/start model slug, not a picker id', async () => {
    const { check } = setup(pages({
      '': { data: [advertised('not-a-default'), advertised('hidden', true, { hidden: true }), advertised('audio-only', true, { inputModalities: ['audio'] })], nextCursor: 'two' },
      two: { data: [advertised('real-default', true, { id: 'picker-id' })] },
    }))
    expect(await check()).toEqual({ status: 'ready', model: 'real-default', reported: { model: 'real-default' } })
  })

  it.each([
    { '': { data: [advertised('single-but-not-default')] } },
    { '': { data: [advertised('one', true)], nextCursor: 'two' }, two: { data: [advertised('two', true)] } },
    { '': { data: [advertised('', true)] } },
  ])('requires a usable, unambiguous advertised default (%#)', async (catalog) => {
    const { check } = setup(pages(catalog))
    expect(await check()).toEqual({ status: 'model-required' })
  })

  it('rejects a repeated pagination cursor instead of trusting incomplete results', async () => {
    const { check, requests } = setup(pages({
      '': { data: [advertised('maybe', true)], nextCursor: 'loop' },
      loop: { data: [], nextCursor: 'loop' },
    }))
    expect(await check()).toEqual({ status: 'handshake-failed' })
    expect(methodNames(requests())).toEqual([...accountOnly, 'config/read', 'model/list', 'model/list'])
  })

  it('returns only a fixed classification on an RPC error, with no raw logging', async () => {
    const { check, requests, spawnSpecs } = setup({ MOCK_CODEX_INITIALIZE_ERROR: 'private test fixture' })
    expect(await check()).toEqual({ status: 'handshake-failed' })
    expect(methodNames(requests())).toEqual(['initialize'])
    expect(spawnSpecs[0]?.stdio?.stderr).toBe('pipe')
  })

  it('disposes the child when an in-flight model read is aborted', async () => {
    const { check, requests } = setup({ MOCK_CODEX_MODEL_HANG: '1' })
    const controller = new AbortController()
    const pending = check(AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]))
    try {
      await vi.waitFor(() => expect(methodNames(requests())).toContain('model/list'), { timeout: 3_000 })
    } finally {
      controller.abort()
      expect(await pending).toEqual({ status: 'handshake-failed' })
    }
    expect(methodNames(requests())).toEqual([...accountOnly, 'config/read', 'model/list'])
  })

  it('omits a model override on resume when no explicit model was configured', async () => {
    const { spec, requests } = setup()
    const base = { ...spec.specBase, cwd: process.cwd() }
    const first = await openCodexConnection({ ...base, codexModel: 'original' }, { mode: 'new' })
    await first.dispose()
    const resumed = await openCodexConnection(base, { mode: 'load', sessionId: first.remoteSessionId })
    await resumed.dispose()
    expect(requests().find(request => request.method === 'thread/resume')?.params).not.toHaveProperty('model')
  })
})


const codexCandidate = { id: 'codex', command: 'codex', label: 'Codex', env: {}, kind: 'codex', configured: true } as const
function readiness(verify: BackendReadinessOptions['verify'], options: Partial<BackendReadinessOptions> = {}) {
  const version = {
    done: Promise.resolve({ exitCode: 0 }), terminate() {}, waitForExit: async () => true,
    collected: { stdout: { readFrom: () => ({ text: 'codex-cli 0.170.0', lossy: false }) } },
  }
  return new BackendReadinessService({ candidates: [codexCandidate], verify,
    host: { resolveExecutable: async command => command, spawn: () => version as unknown as SubprocessHandle }, ...options })
}

describe('D43 diagnostic budgets', () => {
  it('validates optional positive integer millisecond overrides before activation or a volatile update', () => {
    for (const value of [-1, 0, 1.5, NaN, Infinity, 2 ** 31]) {
      expect(() => Config({ command: 'test', probeTimeoutMs: value })).toThrow(/probeTimeoutMs/)
    }
    expect(Config({ command: 'test' }).probeTimeoutMs?.get()).toBeUndefined()
    expect(Config({ command: 'test', probeTimeoutMs: 1 }).probeTimeoutMs?.get()).toBe(1)
  })

  it('allows a slow mock Codex model list by default and reports a 3s override as unverified', async () => {
    const { spec, requests } = setup({ MOCK_CODEX_MODEL_DELAY_MS: '3200' })
    const verify: BackendReadinessOptions['verify'] = (_, __, signal) => verifyBackend(spec, signal)
    const short = readiness(verify, { timeoutMs: 3000 })
    const normal = readiness(verify)
    try {
      const timed = await short.check()
      expect(timed.backends[0]).toMatchObject({ version: '0.170.0', readiness: 'unverified', reason: 'probe-timeout' })
      expect(describeBackendSnapshot(timed)).toContain('backend detection timed out; use Recheck backends to retry; this configured backend can still be used for dispatch')
      expect(short.select('codex')).toBe('codex')
      expect((await normal.check()).backends[0]?.readiness).toBe('ready')
      expect(methodNames(requests()).filter(m => m === 'model/list')).toHaveLength(2)
    } finally { short.dispose(); normal.dispose() }
  }, 25_000)

  it('uses 15s for Codex by protocol or CLI and 5s for ACP, including executable discovery', async () => {
    const timer = vi.spyOn(AbortSignal, 'timeout')
    try {
      for (const [candidate, budget] of [
        [codexCandidate, 15_000], [{ ...codexCandidate, kind: undefined, protocol: 'codex' }, 15_000],
        [{ ...codexCandidate, kind: 'agy' }, 5_000], [{ ...codexCandidate, kind: undefined }, 5_000],
      ] as const) {
        timer.mockClear()
        const service = readiness(async () => ({ status: 'ready' }), { candidates: [candidate] })
        await service.check()
        service.dispose()
        expect(timer.mock.calls[0]).toEqual([budget])
      }
    } finally { timer.mockRestore() }
  })

  it('joins a recheck, cancels only the requesting waiter, and discards an aborted check on teardown', async () => {
    const entered = Promise.withResolvers<void>()
    const service = readiness(async (_, __, signal) => {
      entered.resolve()
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      return { status: 'handshake-failed' }
    }, { candidates: [{ ...codexCandidate, configured: false, automatic: true }] })
    try {
      const lookup = new AbortController()
      const pending = service.check()
      await entered.promise
      expect(service.check()).toBe(pending)
      const waiting = service.select('codex', lookup.signal)
      lookup.abort()
      await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
      expect(service.snapshot().checking).toBe(true)
      service.dispose()
      expect((await pending).backends[0]?.reason).toBe('backend-unready')
    } finally { service.dispose() }
  })

  it('keeps a verification rejection distinct from the owned deadline, even for an AbortError', async () => {
    const service = readiness(async () => { throw new DOMException('peer rejected', 'AbortError') })
    try {
      const failed = await service.check()
      expect(failed.backends[0]).toMatchObject({ readiness: 'unavailable', reason: 'handshake-failed' })
      expect(describeBackendSnapshot(failed)).toContain('the backend did not pass the connection check')
    } finally { service.dispose() }
  })
})
