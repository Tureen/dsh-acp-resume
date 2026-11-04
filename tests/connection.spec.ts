/**
 * Connection-primitive lifecycle tests: open (new / load reconnect, capability
 * gate), structured startup failures, prompt turns with the official settlement
 * semantics (stop reasons, permission policy, thoughts), cancellation and
 * per-turn state reset, and teardown — each against a REAL mock-server
 * subprocess over real ACP stdio. Keyless; no model.
 *
 * @module dsh-acp-resume/tests/connection.spec
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { AcpContentBlock } from '@agentclientprotocol/sdk'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { AcpConnectionError, openAcpConnection, type AcpConnection, type AcpRunSpec } from '../src/connection.ts'
import { DEFAULT_DISPOSE_EOF_GRACE_MS, DEFAULT_DISPOSE_GRACE_MS } from '../src/run.ts'
import { nodeSpawn } from './helpers/node-spawn.ts'

const mockServer = fileURLToPath(new URL('./mock-acp-server.ts', import.meta.url))

const dirs: string[] = []
const connections: AcpConnection[] = []

function tempDir(prefix = 'acp-resume-conn-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function makeSpec(env: Record<string, string> = {}, cwd?: string, overrides: Partial<AcpRunSpec> = {}): { spec: AcpRunSpec; dir: string } {
  const dir = cwd ?? tempDir()
  const spec: AcpRunSpec = {
    command: process.execPath,
    args: [mockServer],
    cwd: dir,
    permission: 'reject',
    env,
    disposeEofGraceMs: DEFAULT_DISPOSE_EOF_GRACE_MS,
    disposeGraceMs: DEFAULT_DISPOSE_GRACE_MS,
    spawn: nodeSpawn,
    ...overrides,
  }
  return { spec, dir }
}

async function open(spec: AcpRunSpec, mode: Parameters<typeof openAcpConnection>[1] = { mode: 'new' }): Promise<AcpConnection> {
  const conn = await openAcpConnection(spec, mode)
  connections.push(conn)
  return conn
}

function text(blocks: readonly { type: string; text?: string }[]): string {
  return blocks.filter(b => b.type === 'text').map(b => b.text).join('')
}

function ask(message: string): AcpContentBlock[] {
  return [{ type: 'text', text: message }]
}

function live(): AbortSignal {
  return new AbortController().signal
}

/** Poll until `predicate` holds; fail after `timeoutMs`. */
async function until(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 10))
  }
}

function lines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(l => l !== '') : []
}

/** Startup rejection captured for structured assertions. */
async function startupError(promise: Promise<unknown>): Promise<AcpConnectionError> {
  const error = await promise.then(() => undefined, (e: unknown) => e)
  expect(error).toBeInstanceOf(AcpConnectionError)
  return error as AcpConnectionError
}

afterEach(async () => {
  await Promise.allSettled(connections.splice(0).map(c => c.dispose()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('openAcpConnection / AcpConnection', () => {
  it('opens a fresh session, settles one prompt turn, and tears down', async () => {
    const { spec } = makeSpec({ MOCK_TEXT: 'hello from mock' })
    const conn = await open(spec)
    expect(typeof conn.remoteSessionId).toBe('string')
    expect(conn.processSettled).toBe(false)
    const turn = await conn.prompt(ask('p'), live())
    expect(turn.stopReason).toBe('completed')
    expect(text(turn.output)).toBe('hello from mock')
    expect(turn.diagnostic).toBeUndefined()
    await conn.dispose()
    await expect(conn.dispose()).resolves.toBeUndefined()
    expect(conn.processSettled).toBe(true)
  })

  it('maps a remote max_tokens terminal to the harness stop reason', async () => {
    const conn = await open(makeSpec({ MOCK_STOP: 'max_tokens' }).spec)
    const turn = await conn.prompt(ask('p'), live())
    expect(turn.stopReason).toBe('max-tokens')
  })

  it('remembers the previous prompt across turns in the same process (MOCK_REMEMBER)', async () => {
    const conn = await open(makeSpec({ MOCK_REMEMBER: '1' }).spec)
    await conn.prompt(ask('记住暗号X'), live())
    const turn = await conn.prompt(ask('暗号是什么'), live())
    expect(text(turn.output)).toBe('remember:记住暗号X')
  })

  it('reconnects a persisted session in a NEW process and the context survives (session/load)', async () => {
    const store = join(tempDir('acp-resume-store-'), 'sessions.json')
    const first = makeSpec({ MOCK_SESSION_ID: 'fixed-1', MOCK_REMEMBER: '1', MOCK_SESSION_STORE: store })
    const connA = await openAcpConnection(first.spec, { mode: 'new' })
    await connA.prompt(ask('记住暗号Y'), live())
    await connA.dispose()

    const second = makeSpec({ MOCK_SESSION_ID: 'fixed-1', MOCK_REMEMBER: '1', MOCK_SESSION_STORE: store }, first.dir)
    const connB = await open(second.spec, { mode: 'load', sessionId: 'fixed-1' })
    expect(connB.remoteSessionId).toBe('fixed-1')
    const turn = await connB.prompt(ask('暗号是什么'), live())
    expect(turn.stopReason).toBe('completed')
    expect(text(turn.output)).toBe('remember:记住暗号Y')
  })

  it('keeps history replayed during session/load out of the first turn output', async () => {
    const store = join(tempDir('acp-resume-store-'), 'sessions.json')
    const env = { MOCK_REMEMBER: '1', MOCK_SESSION_STORE: store, MOCK_LOAD_REPLAY: '1' }
    const first = makeSpec(env)
    const connA = await openAcpConnection(first.spec, { mode: 'new' })
    await connA.prompt(ask('记住暗号R'), live())
    await connA.dispose()

    const connB = await open(makeSpec(env, first.dir).spec, { mode: 'load', sessionId: connA.remoteSessionId })
    const turn = await connB.prompt(ask('暗号是什么'), live())
    expect(turn.stopReason).toBe('completed')
    expect(text(turn.output)).toBe('remember:记住暗号R')
    expect(text(turn.output)).not.toContain('replay:')
  })

  it('rejects a load of an unknown remote session as load-session/protocol', async () => {
    const error = await startupError(openAcpConnection(makeSpec({}).spec, { mode: 'load', sessionId: 'no-such-session' }))
    expect(error.stage).toBe('load-session')
    expect(error.category).toBe('protocol')
    expect(typeof error.jsonRpcCode).toBe('number')
    expect(error.message).toMatch(/stage: load-session; category: protocol/)
    // Safe facts only: the agent's own error text stays in `cause`.
    expect(error.message).not.toContain('no-such-session')
  })

  it('refuses session/load when the agent does not advertise loadSession', async () => {
    const store = join(tempDir('acp-resume-store-'), 'sessions.json')
    const first = makeSpec({ MOCK_SESSION_STORE: store })
    const connA = await openAcpConnection(first.spec, { mode: 'new' })
    await connA.dispose()
    const error = await startupError(openAcpConnection(
      makeSpec({ MOCK_SESSION_STORE: store, MOCK_NO_LOAD_CAPABILITY: '1' }, first.dir).spec,
      { mode: 'load', sessionId: connA.remoteSessionId },
    ))
    expect(error.stage).toBe('load-session')
    expect(error.category).toBe('protocol')
    expect(error.jsonRpcCode).toBeUndefined()
  })

  it('classifies a child that exits during initialize as initialize/process-exit', async () => {
    const errors: Error[] = []
    const { spec } = makeSpec({ MOCK_CRASH_ON_INITIALIZE: '1' }, undefined, { onError: (e) => { errors.push(e) } })
    const error = await startupError(openAcpConnection(spec, { mode: 'new' }))
    expect(error.stage).toBe('initialize')
    expect(error.category).toBe('process-exit')
    expect(error.message).toContain('exit code: 11')
    expect(errors.length).toBeGreaterThan(0)
  })

  it('classifies a session/new reply without a session id as new-session/protocol', async () => {
    const error = await startupError(openAcpConnection(makeSpec({ MOCK_MISSING_SESSION_ID: '1' }).spec, { mode: 'new' }))
    expect(error.stage).toBe('new-session')
    expect(error.category).toBe('protocol')
  })

  it('classifies a synchronous spawn failure as initialize/process-start', async () => {
    const errors: Error[] = []
    const { spec } = makeSpec({}, undefined, {
      spawn: () => { throw new Error('spawn boom') },
      onError: (e) => { errors.push(e) },
    })
    const error = await startupError(openAcpConnection(spec, { mode: 'new' }))
    expect(error.stage).toBe('initialize')
    expect(error.category).toBe('process-start')
    expect(error.message).not.toContain('spawn boom')
    expect(errors.map(e => e.message)).toContain('spawn boom')
  })

  it('reports a failed startup rollback through onError and keeps the startup classification', async () => {
    const errors: Error[] = []
    let real: SubprocessHandle | undefined
    const { spec } = makeSpec({ MOCK_MISSING_SESSION_ID: '1' }, undefined, {
      disposeEofGraceMs: 200,
      disposeGraceMs: 200,
      spawn: (s) => {
        const child = nodeSpawn(s)
        real = child
        return {
          get stdin() { return child.stdin },
          get stdout() { return child.stdout },
          get stderr() { return child.stderr },
          done: child.done,
          waitForExit: () => Promise.reject(new Error('rollback boom')),
          terminate: () => { child.terminate() },
        }
      },
      onError: (e) => { errors.push(e) },
    })
    const error = await startupError(openAcpConnection(spec, { mode: 'new' }))
    expect(error.stage).toBe('new-session')
    expect(error.category).toBe('protocol')
    // The raw teardown failure and its safe wrapper both reach the sink.
    const raw = errors.find((e): e is AggregateError => e instanceof AggregateError)
    expect(raw?.errors.map((x: Error) => x.message)).toEqual(['rollback boom', 'rollback boom'])
    expect(errors.map(e => e.message)).toContain('acp-resume: Subagent failure (provider: ACP; stage: teardown; category: unknown)')
    // terminate() still reached the real child.
    await expect(real?.done).resolves.toBeDefined()
  })

  it('rejects with a plain abort error when cancelled during session/new, and reaps the child', async () => {
    const dir = tempDir()
    const ready = join(dir, 'ready')
    const go = join(dir, 'go')
    let child: SubprocessHandle | undefined
    const { spec } = makeSpec({ MOCK_NEWSESSION_READY: ready, MOCK_NEWSESSION_GO: go }, dir, {
      disposeEofGraceMs: 500,
      spawn: (s) => (child = nodeSpawn(s)),
    })
    const controller = new AbortController()
    const opening = openAcpConnection(spec, { mode: 'new' }, controller.signal)
    await until(() => existsSync(ready), 'newSession reached')
    controller.abort()
    const error = await opening.then(() => undefined, (e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(AcpConnectionError)
    expect((error as Error).message).toMatch(/aborted/)
    await expect(child?.done).resolves.toBeDefined()
  })

  it('rejects before spawning when the startup signal is already aborted', async () => {
    let spawned = 0
    const { spec } = makeSpec({}, undefined, { spawn: (s) => { spawned += 1; return nodeSpawn(s) } })
    await expect(openAcpConnection(spec, { mode: 'new' }, AbortSignal.abort())).rejects.toThrow(/aborted/)
    expect(spawned).toBe(0)
  })

  it('auto-approves a permission prompt under the allow policy', async () => {
    const conn = await open(makeSpec({ MOCK_PERMISSION: '1', MOCK_TEXT: 'did it' }, undefined, { permission: 'allow' }).spec)
    const turn = await conn.prompt(ask('p'), live())
    expect(turn.stopReason).toBe('completed')
    expect(text(turn.output)).toBe('did it')
  })

  it('auto-rejects a permission prompt under the reject policy (child settles cancelled → aborted)', async () => {
    const conn = await open(makeSpec({ MOCK_PERMISSION: '1', MOCK_TOOL_KIND: 'edit' }).spec)
    const turn = await conn.prompt(ask('p'), live())
    expect(turn.stopReason).toBe('aborted')
    expect(turn.diagnostic).toBe('ACP unattended decision (policy: reject; request: edit; decision: denied)')
  })

  it('does not carry a permission decision into the next turn', async () => {
    const conn = await open(makeSpec({
      MOCK_PERMISSION_PROMPTS: '1',
      MOCK_PERMISSION_IGNORE_DECISION: '1',
      MOCK_STOP: 'max_tokens',
    }).spec)
    const first = await conn.prompt(ask('p1'), live())
    expect(first.stopReason).toBe('max-tokens')
    expect(first.diagnostic).toMatch(/decision: denied/)
    const second = await conn.prompt(ask('p2'), live())
    expect(second.stopReason).toBe('max-tokens')
    expect(second.diagnostic).toBeUndefined()
  })

  it('consumes a thought update without adding it to the output', async () => {
    const conn = await open(makeSpec({ MOCK_THOUGHT: '1', MOCK_TEXT: 'answer only' }).spec)
    const turn = await conn.prompt(ask('p'), live())
    expect(text(turn.output)).toBe('answer only')
  })

  it('settles error with process facts when the child exits mid-prompt, and reports through onError', async () => {
    const errors: Error[] = []
    const conn = await open(makeSpec({ MOCK_CRASH_ON_PROMPT: '1' }, undefined, { onError: (e) => { errors.push(e) } }).spec)
    const turn = await conn.prompt(ask('p'), live())
    expect(turn.stopReason).toBe('error')
    expect(turn.diagnostic).toMatch(/category: process-exit; exit code: 1/)
    expect(errors.length).toBe(1)
    expect(conn.processSettled).toBe(true)
  })

  it('settles an in-flight prompt as aborted on cancellation and still disposes', async () => {
    const conn = await open(makeSpec({ MOCK_HANG: '1' }).spec)
    const controller = new AbortController()
    const turnPromise = conn.prompt(ask('p'), controller.signal)
    controller.abort()
    const turn = await turnPromise
    expect(turn.stopReason).toBe('aborted')
    await conn.dispose()
  })

  it('settles an already-aborted turn immediately without sending the prompt', async () => {
    const conn = await open(makeSpec({ MOCK_REMEMBER: '1' }).spec)
    const turn = await conn.prompt(ask('never sent'), AbortSignal.abort())
    expect(turn.stopReason).toBe('aborted')
    expect(turn.output).toEqual([])
    // The agent never saw the aborted prompt: the next turn has no predecessor.
    const next = await conn.prompt(ask('first real'), live())
    expect(text(next.output)).toBe('remember:none')
  })

  it('runs a clean turn after a cancelled one and delivers a second cancel to the agent', async () => {
    const dir = tempDir()
    const ready = join(dir, 'ready')
    const cancels = join(dir, 'cancels')
    const conn = await open(makeSpec({ MOCK_HANG_PROMPTS: '1,3', MOCK_READY_FILE: ready, MOCK_CANCEL_FILE: cancels, MOCK_TEXT: 'ok' }, dir).spec)

    const c1 = new AbortController()
    const t1 = conn.prompt(ask('p1'), c1.signal)
    await until(() => existsSync(ready), 'turn 1 in flight')
    c1.abort()
    expect((await t1).stopReason).toBe('aborted')
    await until(() => lines(cancels).length === 1, 'first session/cancel at the agent')

    const t2 = await conn.prompt(ask('p2'), live())
    expect(t2.stopReason).toBe('completed')
    expect(text(t2.output)).toBe('ok')

    rmSync(ready)
    const c3 = new AbortController()
    const t3 = conn.prompt(ask('p3'), c3.signal)
    await until(() => existsSync(ready), 'turn 3 in flight')
    c3.abort()
    expect((await t3).stopReason).toBe('aborted')
    await until(() => lines(cancels).length === 2, 'second session/cancel at the agent')
    expect(lines(cancels)).toEqual([`cancel ${conn.remoteSessionId}`, `cancel ${conn.remoteSessionId}`])
  })

  it('settles error (not aborted) when the child crashes on the turn after a cancelled one', async () => {
    const dir = tempDir()
    const ready = join(dir, 'ready')
    const conn = await open(makeSpec({ MOCK_HANG_PROMPTS: '1', MOCK_CRASH_PROMPTS: '2', MOCK_READY_FILE: ready }, dir).spec)
    const c1 = new AbortController()
    const t1 = conn.prompt(ask('p1'), c1.signal)
    await until(() => existsSync(ready), 'turn 1 in flight')
    c1.abort()
    expect((await t1).stopReason).toBe('aborted')
    const t2 = await conn.prompt(ask('p2'), live())
    expect(t2.stopReason).toBe('error')
    expect(t2.diagnostic).toMatch(/process-exit/)
  })

  it('settles a turn after notifyCancel between turns as a normal turn', async () => {
    const conn = await open(makeSpec({ MOCK_TEXT: 'fine' }).spec)
    conn.notifyCancel()
    const turn = await conn.prompt(ask('p'), live())
    expect(turn.stopReason).toBe('completed')
    expect(text(turn.output)).toBe('fine')
  })
})
