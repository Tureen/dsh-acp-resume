/**
 * Codex app-server connection tests (D25): open (new thread / resume), prompt
 * turns with streaming and the `final_answer` output, stop-reason mapping,
 * steer and cancel, the approval policy, and startup/exit failures, each
 * against a REAL mock-codex-server subprocess over real stdio. Keyless; no model.
 *
 * @module dsh-acp-resume/tests/connection-codex.spec
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { AcpConnectionError, AcpSteerUnsupportedError, type AcpConnection, type OpenAcpMode } from '../src/connection.ts'
import { openCodexConnection, type CodexSessionSpec } from '../src/connection-codex.ts'
import { COMMAND_NOT_FOUND_GUIDANCE } from '../src/command-not-found.ts'
import type { PermissionPolicy } from '../src/run.ts'
import { toCodexPermissionRequest } from '../src/codex-approval.ts'
import { userQuestionPermissionResolver, type PermissionRequestResolver } from '../src/permission-request.ts'
import { nodeSpawn } from './helpers/node-spawn.ts'

const mockServer = fileURLToPath(new URL('./mock-codex-server.ts', import.meta.url))

const dirs: string[] = []
const connections: AcpConnection[] = []
const children: SubprocessHandle[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'acp-resume-codex-'))
  dirs.push(dir)
  return dir
}

function makeSpec(env: Record<string, string> = {}, overrides: Partial<CodexSessionSpec> = {}): CodexSessionSpec {
  return {
    command: process.execPath,
    args: [mockServer],
    cwd: tempDir(),
    permission: 'reject',
    env,
    disposeEofGraceMs: 500,
    disposeGraceMs: 500,
    spawn: (spec: SubprocessSpawnSpec) => {
      const child = nodeSpawn(spec)
      children.push(child)
      return child
    },
    codexModel: 'mock-model',
    ...overrides,
  }
}

async function open(spec: CodexSessionSpec, mode: OpenAcpMode = { mode: 'new' }): Promise<AcpConnection> {
  const conn = await openCodexConnection(spec, mode)
  connections.push(conn)
  return conn
}

const ask = (message: string): [{ type: 'text'; text: string }] => [{ type: 'text', text: message }]
const live = (): AbortSignal => new AbortController().signal
const text = (blocks: readonly { type: string; text?: string }[]): string => blocks.map(b => b.text ?? '').join('')

function lines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(l => l !== '') : []
}

async function until(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 10))
  }
}

async function startupError(promise: Promise<unknown>): Promise<AcpConnectionError> {
  const error = await promise.then(() => undefined, (e: unknown) => e)
  expect(error).toBeInstanceOf(AcpConnectionError)
  return error as AcpConnectionError
}

afterEach(async () => {
  await Promise.allSettled(connections.splice(0).map(c => c.dispose()))
  children.length = 0
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('openCodexConnection', () => {
  it('opens a thread with ephemeral:false and the explicit model, sandbox and approval defaults', async () => {
    const requests = join(tempDir(), 'requests.log')
    const conn = await open(makeSpec({ MOCK_REQUEST_FILE: requests }))
    expect(conn.remoteSessionId).toMatch(/^thr-/)
    expect(conn.processSettled).toBe(false)
    const start = JSON.parse((lines(requests)[0] as string).replace('thread/start ', '')) as Record<string, unknown>
    expect(start).toMatchObject({ model: 'mock-model', approvalPolicy: 'never', sandbox: 'read-only', ephemeral: false })
  })

  it('passes explicit sandbox, approval policy and turn effort through', async () => {
    const requests = join(tempDir(), 'requests.log')
    const conn = await open(makeSpec({ MOCK_REQUEST_FILE: requests }, { sandbox: 'workspace-write', approvalPolicy: 'on-request', codexEffort: 'high' }))
    await conn.prompt(ask('p'), live())
    const [start, turn] = lines(requests).map(l => JSON.parse(l.slice(l.indexOf(' ') + 1)) as Record<string, unknown>)
    expect(start).toMatchObject({ sandbox: 'workspace-write', approvalPolicy: 'on-request' })
    expect(turn).toMatchObject({ effort: 'high', input: [{ type: 'text', text: 'p', text_elements: [] }] })
  })

  it('resumes a saved thread in a new process and finds the history', async () => {
    const store = join(tempDir(), 's.json')
    const env = { MOCK_REMEMBER: '1', MOCK_SESSION_STORE: store }
    const first = await open(makeSpec(env))
    await first.prompt(ask('暗号ZX'), live())
    const id = first.remoteSessionId
    children[0]?.terminate()
    await until(() => first.processSettled, 'first process exit')
    const second = await open(makeSpec(env), { mode: 'load', sessionId: id })
    expect(second.remoteSessionId).toBe(id)
    const turn = await second.prompt(ask('暗号是什么'), live())
    expect(text(turn.output)).toBe('remember:暗号ZX')
  })

  it('rejects resuming an unknown thread as a load-session protocol error', async () => {
    const error = await startupError(openCodexConnection(makeSpec({ MOCK_SESSION_STORE: join(tempDir(), 's.json') }), { mode: 'load', sessionId: 'thr-nope' }))
    expect(error).toMatchObject({ stage: 'load-session', category: 'protocol' })
    expect(error.jsonRpcCode).toBe(-32600)
  })

  it('classifies a missing command as process-start with the fixed guidance', async () => {
    // The seam reports a missing executable as an ENOENT-coded spawn failure.
    const spawn = (): never => { throw Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }) }
    const error = await startupError(openCodexConnection(makeSpec({}, { command: 'codex', args: ['app-server'], spawn }), { mode: 'new' }))
    expect(error).toMatchObject({ stage: 'initialize', category: 'process-start' })
    expect(error.message).toContain(COMMAND_NOT_FOUND_GUIDANCE)
    expect(error.message).not.toContain('spawn codex')
  })

  it('fails startup when the process dies during initialize and cleans up', async () => {
    const error = await startupError(openCodexConnection(makeSpec({ MOCK_CRASH_ON_INITIALIZE: '1' }), { mode: 'new' }))
    expect(error.stage).toBe('initialize')
    expect(['process-exit', 'transport']).toContain(error.category)
    await until(() => children.length === 1, 'spawn')
  })

  it('rejects an already-aborted startup without spawning', async () => {
    await expect(openCodexConnection(makeSpec(), { mode: 'new' }, AbortSignal.abort())).rejects.toThrow(/aborted/)
    expect(children).toHaveLength(0)
  })
})

describe('codex prompt turns', () => {
  it('returns the final_answer text and streams each delta in order', async () => {
    const conn = await open(makeSpec({ MOCK_TEXT: 'hello codex' }))
    const chunks: string[] = []
    const turn = await conn.prompt(ask('p'), live(), chunk => chunks.push(chunk))
    expect(turn).toMatchObject({ stopReason: 'completed', diagnostic: undefined })
    expect(text(turn.output)).toBe('hello codex')
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe('hello codex')
  })

  it('prefers the final_answer over commentary messages in the settled output', async () => {
    const conn = await open(makeSpec({ MOCK_TEXT: 'the answer', MOCK_CODEX_COMMENTARY: '1' }))
    const chunks: string[] = []
    const turn = await conn.prompt(ask('p'), live(), chunk => chunks.push(chunk))
    expect(text(turn.output)).toBe('the answer')
    expect(chunks.join('')).toBe('thinking about itthe answer')
  })

  it('keeps turns isolated: the second turn output does not include the first', async () => {
    const conn = await open(makeSpec({ MOCK_REMEMBER: '1' }))
    expect(text((await conn.prompt(ask('one'), live())).output)).toBe('remember:none')
    expect(text((await conn.prompt(ask('two'), live())).output)).toBe('remember:one')
  })

  it('removes its per-turn stdout close listener: twelve turns, no listener growth', async () => {
    const conn = await open(makeSpec())
    const stdout = children[0]?.stdout as unknown as NodeJS.EventEmitter
    const baseline = stdout.listenerCount('close')
    const warnings: Error[] = []
    const onWarning = (warning: Error): void => { warnings.push(warning) }
    process.on('warning', onWarning)
    try {
      for (let i = 0; i < 12; i++) expect((await conn.prompt(ask(`p${i}`), live())).stopReason).toBe('completed')
    } finally {
      process.off('warning', onWarning)
    }
    expect(stdout.listenerCount('close')).toBe(baseline)
    expect(warnings.filter(w => w.name === 'MaxListenersExceededWarning')).toEqual([])
  })

  it('contains a throwing text observer', async () => {
    const conn = await open(makeSpec({ MOCK_TEXT: 'ok' }))
    const turn = await conn.prompt(ask('p'), live(), () => { throw new Error('observer boom') })
    expect(turn.stopReason).toBe('completed')
    expect(text(turn.output)).toBe('ok')
  })

  it('maps a server-side interrupted turn to aborted', async () => {
    const conn = await open(makeSpec({ MOCK_CODEX_TURN_STATUS: 'interrupted' }))
    expect((await conn.prompt(ask('p'), live())).stopReason).toBe('aborted')
  })

  it('maps a failed turn to error with a fixed diagnostic', async () => {
    const reported: Error[] = []
    const conn = await open(makeSpec({ MOCK_CODEX_TURN_STATUS: 'failed' }, { onError: error => reported.push(error) }))
    const turn = await conn.prompt(ask('p'), live())
    expect(turn.stopReason).toBe('error')
    expect(turn.diagnostic).toContain('provider: Codex')
  })

  it('maps contextWindowExceeded to max-tokens', async () => {
    const conn = await open(makeSpec({ MOCK_CODEX_TURN_STATUS: 'contextWindowExceeded' }))
    expect((await conn.prompt(ask('p'), live())).stopReason).toBe('max-tokens')
  })
})

describe('codex steer and cancel', () => {
  it('steers the in-flight turn: same turn id, an extra user message, the turn keeps running', async () => {
    const dir = tempDir()
    const steerLog = join(dir, 'steer.log')
    const ready = join(dir, 'ready')
    const conn = await open(makeSpec({ MOCK_HANG: '1', MOCK_STEER_FILE: steerLog, MOCK_READY_FILE: ready, MOCK_CANCEL_FILE: join(dir, 'interrupt.log') }))
    const abort = new AbortController()
    const pending = conn.prompt(ask('p'), abort.signal)
    await until(() => existsSync(ready), 'turn in flight')
    const reply = await conn.steer('再加一条')
    expect(reply.queued).toBe(true)
    expect(reply.messageId).toMatch(/^turn-/)
    expect(lines(steerLog)).toEqual([`steer ${conn.remoteSessionId} 再加一条`])
    abort.abort()
    expect((await pending).stopReason).toBe('aborted')
  })

  it('maps -32601 from turn/steer to AcpSteerUnsupportedError', async () => {
    const ready = join(tempDir(), 'ready')
    const conn = await open(makeSpec({ MOCK_HANG: '1', MOCK_READY_FILE: ready, MOCK_CODEX_STEER_UNSUPPORTED: '1' }))
    const abort = new AbortController()
    const pending = conn.prompt(ask('p'), abort.signal)
    await until(() => existsSync(ready), 'turn in flight')
    await expect(conn.steer('x')).rejects.toBeInstanceOf(AcpSteerUnsupportedError)
    abort.abort()
    await pending
  })

  it('rejects steer when no turn is in flight', async () => {
    const conn = await open(makeSpec())
    await expect(conn.steer('x')).rejects.toThrow(/no Codex turn is in flight/)
  })

  it('cancel settles aborted locally and sends turn/interrupt with the turn id', async () => {
    const dir = tempDir()
    const interrupts = join(dir, 'interrupt.log')
    const ready = join(dir, 'ready')
    const conn = await open(makeSpec({ MOCK_HANG: '1', MOCK_READY_FILE: ready, MOCK_CANCEL_FILE: interrupts }))
    const abort = new AbortController()
    const pending = conn.prompt(ask('p'), abort.signal)
    await until(() => existsSync(ready), 'turn in flight')
    abort.abort()
    expect((await pending).stopReason).toBe('aborted')
    await until(() => lines(interrupts).length === 1, 'interrupt request')
    expect(lines(interrupts)[0]).toMatch(new RegExp(`^interrupt ${conn.remoteSessionId} turn-`))
  })

  it('does not start a turn when the signal is already aborted', async () => {
    const requests = join(tempDir(), 'requests.log')
    const conn = await open(makeSpec({ MOCK_REQUEST_FILE: requests }))
    expect((await conn.prompt(ask('p'), AbortSignal.abort())).stopReason).toBe('aborted')
    expect(lines(requests).filter(l => l.startsWith('turn/start'))).toEqual([])
  })
})

describe('codex approvals', () => {
  async function approvalRun(permission: PermissionPolicy): Promise<{ stopReason: string; decisions: string[]; output: string }> {
    const log = join(tempDir(), 'approval.log')
    const conn = await open(makeSpec({ MOCK_CODEX_APPROVAL: 'command', MOCK_CODEX_APPROVAL_FILE: log, MOCK_TEXT: 'ran' }, { permission }))
    const turn = await conn.prompt(ask('run it'), live())
    return { stopReason: turn.stopReason, decisions: lines(log), output: text(turn.output) }
  }

  it('allow answers accept and the turn completes', async () => {
    expect(await approvalRun('allow')).toEqual({ stopReason: 'completed', decisions: ['decision accept'], output: 'ran' })
  })

  it('reject answers decline and the turn continues', async () => {
    expect(await approvalRun('reject')).toEqual({ stopReason: 'completed', decisions: ['decision decline'], output: 'ran' })
  })

  it('ask without a bridge fails closed: cancel interrupts the whole turn', async () => {
    const result = await approvalRun('ask')
    expect(result.decisions).toEqual(['decision cancel'])
    expect(result.stopReason).toBe('aborted')
    expect(result.output).toBe('')
  })

  it('answers file-change approvals the same way', async () => {
    const log = join(tempDir(), 'approval.log')
    const conn = await open(makeSpec({ MOCK_CODEX_APPROVAL: 'file', MOCK_CODEX_APPROVAL_FILE: log }, { permission: 'allow' }))
    expect((await conn.prompt(ask('p'), live())).stopReason).toBe('completed')
    expect(lines(log)).toEqual(['decision accept'])
  })
})

describe('codex process failure', () => {
  it('settles error when the process exits mid-turn, then reports the connection as settled', async () => {
    const ready = join(tempDir(), 'ready')
    const conn = await open(makeSpec({ MOCK_HANG: '1', MOCK_READY_FILE: ready }))
    const pending = conn.prompt(ask('p'), live())
    await until(() => existsSync(ready), 'turn in flight')
    children[0]?.terminate()
    const turn = await pending
    expect(turn.stopReason).toBe('error')
    expect(turn.diagnostic).toContain('provider: Codex')
    await until(() => conn.processSettled, 'process settled')
    expect((await conn.observeOutcome())?.signal ?? (await conn.observeOutcome())?.exitCode).toBeDefined()
  })

  it('dispose is idempotent and ends the process', async () => {
    const conn = await open(makeSpec())
    await Promise.all([conn.dispose(), conn.dispose()])
    await until(() => conn.processSettled, 'process exit')
  })
})

describe('codex approvals under ask (host-user bridge)', () => {
  const select = (optionId: string): PermissionRequestResolver => async () => ({ outcome: { outcome: 'selected', optionId } })

  async function askRun(approval: string, resolver: PermissionRequestResolver | undefined): Promise<{ stopReason: string; decisions: string[]; output: string }> {
    const log = join(tempDir(), 'approval.log')
    const conn = await open(makeSpec({ MOCK_CODEX_APPROVAL: approval, MOCK_CODEX_APPROVAL_FILE: log, MOCK_TEXT: 'ran' }, { permission: 'ask' }))
    const turn = await conn.prompt(ask('run it'), live(), undefined, resolver)
    return { stopReason: turn.stopReason, decisions: lines(log), output: text(turn.output) }
  }

  it('user allows: accept, the command runs, the turn completes', async () => {
    expect(await askRun('command', select('accept'))).toEqual({ stopReason: 'completed', decisions: ['decision accept'], output: 'ran' })
  })

  it('user rejects: decline, only that step is refused and the turn continues', async () => {
    expect(await askRun('command', select('decline'))).toEqual({ stopReason: 'completed', decisions: ['decision decline'], output: 'ran' })
  })

  it('user cancels: cancel interrupts the whole turn', async () => {
    expect(await askRun('command', select('cancel'))).toEqual({ stopReason: 'aborted', decisions: ['decision cancel'], output: '' })
  })

  it('fails closed to cancel without a bridge', async () => {
    expect((await askRun('command', undefined)).decisions).toEqual(['decision cancel'])
  })

  it('fails closed to cancel when the bridge throws, answers cancelled, or selects an unoffered option', async () => {
    const throwing: PermissionRequestResolver = async () => { throw new Error('ui crashed') }
    const cancelled: PermissionRequestResolver = async () => ({ outcome: { outcome: 'cancelled' } })
    for (const resolver of [throwing, cancelled, select('accept-forever')]) {
      expect((await askRun('command', resolver)).decisions).toEqual(['decision cancel'])
    }
  })

  it('asks for file-change approvals', async () => {
    expect(await askRun('file', select('accept'))).toMatchObject({ stopReason: 'completed', decisions: ['decision accept'] })
    expect(await askRun('file', select('decline'))).toMatchObject({ stopReason: 'completed', decisions: ['decision decline'] })
  })

  it('asks for permissions approvals', async () => {
    expect(await askRun('permissions', select('accept'))).toMatchObject({ stopReason: 'completed', decisions: ['decision accept'] })
    expect(await askRun('permissions', select('cancel'))).toMatchObject({ stopReason: 'aborted', decisions: ['decision cancel'] })
  })

  it('shows the command and the three options to the resolver', async () => {
    const seen: RequestPermissionRequest[] = []
    await askRun('command', async (request): Promise<RequestPermissionResponse> => { seen.push(request); return { outcome: { outcome: 'selected', optionId: 'accept' } } })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.toolCall).toMatchObject({ title: 'Codex requests to run a command', kind: 'execute' })
    expect(JSON.stringify(seen[0]?.toolCall.content)).toContain('echo mock')
    expect(seen[0]?.options.map(option => option.optionId)).toEqual(['accept', 'decline', 'cancel'])
  })

  it('cancels at once when the turn is aborted while the question is pending', async () => {
    const dir = tempDir()
    const log = join(dir, 'approval.log')
    const conn = await open(makeSpec({ MOCK_CODEX_APPROVAL: 'command', MOCK_CODEX_APPROVAL_FILE: log }, { permission: 'ask' }))
    const abort = new AbortController()
    let asked = false
    const pending = conn.prompt(ask('p'), abort.signal, undefined, (_request, signal) => new Promise<RequestPermissionResponse>((resolve) => {
      asked = true
      signal.addEventListener('abort', () => { resolve({ outcome: { outcome: 'cancelled' } }) }, { once: true })
    }))
    await until(() => asked, 'approval question')
    abort.abort()
    expect((await pending).stopReason).toBe('aborted')
  })

  it('works through the real user-questions bridge', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const questions: string[] = []
    ctx.on('user-questions/request', (request) => {
      questions.push(JSON.stringify(request))
      return { answers: request.questions.map(question => ({ id: question.id, selected: ['Allow (allow_once, option 1)'] })) }
    })
    try {
      const resolver = userQuestionPermissionResolver(ctx.get('userQuestions') as never, undefined)
      expect(await askRun('command', resolver)).toMatchObject({ stopReason: 'completed', decisions: ['decision accept'] })
      expect(questions).toHaveLength(1)
      expect(questions[0]).toContain('Codex requests to run a command')
      expect(questions[0]).toContain('echo mock')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('toCodexPermissionRequest', () => {
  it('omits Allow when accept is not among the available decisions, always offering decline and cancel', () => {
    const request = toCodexPermissionRequest('item/commandExecution/requestApproval', { itemId: 'i1', availableDecisions: ['cancel'] })
    expect(request.options.map(option => option.optionId)).toEqual(['decline', 'cancel'])
  })

  it('caps long text and labels each kind', () => {
    const file = toCodexPermissionRequest('item/fileChange/requestApproval', { itemId: 'i2', grantRoot: '/work', reason: 'x'.repeat(5000) })
    expect(file.toolCall).toMatchObject({ kind: 'edit', title: 'Codex requests to change files' })
    expect(JSON.stringify(file.toolCall.content).length).toBeLessThan(2000)
    expect(toCodexPermissionRequest('item/permissions/requestApproval', {}).toolCall.kind).toBe('other')
  })
})
