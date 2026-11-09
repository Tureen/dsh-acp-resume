/**
 * Job-backed send (D17). The tool cases drive `acp_chat_send` over a REAL
 * pool, mock-server subprocesses, and the REAL process-local job registry
 * (`@deepseek-ai/dsh-jobs-local`): the call returns a job id before the turn
 * settles, the answer streams into the job's output, the outcome maps the
 * stop reason, `kill` reaches the turn as the pool's cancel semantics, the
 * job is owned by the calling agent's session, and single-flight still
 * rejects a second send as a tool error. The `apply` cases assert the send
 * variant follows `ctx.jobs` (inline without it, job-backed with it, inline
 * again when it leaves). Keyless; no model.
 *
 * @module dsh-acp-resume/tests/jobs.spec
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { JobId, JobRegistry } from '@deepseek-ai/dsh-jobs'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import * as acp from '../src/index.ts'
import { AcpSessionPool } from '../src/pool.ts'
import { registerChatTools, type ToolsRegistryFace } from '../src/tools.ts'
import { nodeSpawn } from './helpers/node-spawn.ts'
import { mountWorkingDirectoryFixture } from './helpers/working-directory-fixture.ts'

const mockServer = fileURLToPath(new URL('./mock-acp-server.ts', import.meta.url))

const dirs: string[] = []
const pools: AcpSessionPool[] = []
const cleanups: (() => unknown)[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await Promise.allSettled(pools.splice(0).map(p => p.disposeAll()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

type Definition = Parameters<ToolsRegistryFace['register']>[0]

async function until(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 10))
  }
}

let callSeq = 0
function exec(options: { signal?: AbortSignal; agent?: Agent } = {}): ToolRunContext {
  callSeq += 1
  const callId = `call-${callSeq}`
  return {
    signal: options.signal ?? new AbortController().signal,
    callId,
    rootCallId: callId,
    ...(options.agent === undefined ? {} : { agent: options.agent }),
  } as unknown as ToolRunContext
}

/** A host context with the real process-local registry; `controller: false` leaves no job controller attached. */
async function jobsHost(options: { controller?: boolean; agents?: boolean } = {}): Promise<Context> {
  const ctx = new Context()
  if (options.agents === true) {
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
  }
  await ctx.plugin(LocalJobRegistry)
  if (options.controller !== false) ctx.jobs.attachController('jobs-spec')
  cleanups.push(() => ctx.fiber.dispose())
  return ctx
}

/** Register the five tools over a real pool with the given job registry. */
function mountTools(env: Record<string, string>, jobs: JobRegistry | undefined) {
  const tools = new Map<string, Definition>()
  const registry: ToolsRegistryFace = {
    register(definition) {
      tools.set(definition.name, definition)
      return () => { tools.delete(definition.name) }
    },
  }
  const pool = new AcpSessionPool({
    specBase: {
      command: process.execPath,
      args: [mockServer],
      permission: 'reject',
      env,
      disposeEofGraceMs: 500,
      disposeGraceMs: 500,
      spawn: nodeSpawn,
    },
    registryPath: join(tempDir('acp-resume-jobs-'), 'registry.json'),
    idleTimeoutMs: 600_000,
  })
  pools.push(pool)
  const fakeCtx = { effect: (fn: () => () => void) => { fn() } }
  registerChatTools(fakeCtx as unknown as Context, registry, pool, 'acp_chat_', jobs)
  const call = async (name: string, args: Record<string, unknown>, run: ToolRunContext = exec()): Promise<Record<string, unknown>> => {
    const definition = tools.get(`acp_chat_${name}`)
    if (definition === undefined) throw new Error(`tool acp_chat_${name} not registered`)
    return await definition.execute(args, run) as Record<string, unknown>
  }
  return { tools, pool, call }
}

/** Everything the model's consuming reads would see, concatenated. */
function readAll(jobs: JobRegistry, id: JobId, caller?: SessionId): string {
  const read = jobs.read(id, caller)
  return read.chunks.map(chunk => chunk.text).join('') + (read.result ?? '')
}

describe('job-backed send', () => {
  it('returns the job id before the turn settles, then completes with the streamed answer', async () => {
    const ctx = await jobsHost()
    const dir = tempDir('acp-resume-jobs-hold-')
    const hold = join(dir, 'hold')
    writeFileSync(hold, 'held')
    const { call, tools } = mountTools({ MOCK_TEXT: 'job answer', MOCK_PROMPT_HOLD: hold }, ctx.jobs)
    const { chatId } = await call('start', { cwd: process.cwd() })

    const sent = await call('send', { chatId, message: 'hi' })
    const jobId = sent.jobId as JobId
    expect(jobId).toMatch(/^acp-chat-/)
    expect(sent.text).toContain(`background job ${jobId}`)
    expect(sent.text).toContain('job_output')
    // D22: no copy may push the model toward a blocked wait.
    expect(sent.text).not.toMatch(/wait for that job|wait: true/)
    const description = tools.get('acp_chat_send')!.description
    expect(description).not.toMatch(/wait for that job|wait: true/)
    expect(description).toContain('completion notice')
    for (const copy of [sent.text as string, description]) {
      expect(copy).toContain('woken')
      expect(copy).toContain('counts as collecting')
      expect(copy).toContain('without wait')
    }
    // The tool returned while the agent is still holding its answer.
    expect(ctx.jobs.get(jobId).status).toBe('running')
    expect(ctx.jobs.get(jobId).label).toBe(`${chatId as string}: hi`)

    rmSync(hold)
    const settled = await ctx.jobs.wait(jobId, 5000)
    expect(settled.status).toBe('completed')
    expect(readAll(ctx.jobs, jobId)).toBe('job answer')
  })

  it('does not block on a fast turn either: the call resolves while the job still runs', async () => {
    const ctx = await jobsHost()
    const { call } = mountTools({ MOCK_TEXT: 'quick' }, ctx.jobs)
    const { chatId } = await call('start', { cwd: process.cwd() })
    const { jobId } = await call('send', { chatId, message: 'hi' }) as { jobId: JobId }
    expect(ctx.jobs.get(jobId).status).toBe('running')
    expect((await ctx.jobs.wait(jobId, 5000)).status).toBe('completed')
    expect(readAll(ctx.jobs, jobId)).toBe('quick')
  })

  it('streams the answer into job output while the turn runs, and kill cancels the turn (session/cancel + released connection)', async () => {
    const ctx = await jobsHost()
    const dir = tempDir('acp-resume-jobs-kill-')
    const ready = join(dir, 'ready')
    const cancels = join(dir, 'cancels')
    const { call, pool } = mountTools({
      MOCK_TEXT: 'partial so far',
      MOCK_HANG_PROMPTS: '1',
      MOCK_READY_FILE: ready,
      MOCK_CANCEL_FILE: cancels,
    }, ctx.jobs)
    const { chatId } = await call('start', { cwd: process.cwd() })
    const { jobId } = await call('send', { chatId, message: 'long task' }) as { jobId: JobId }

    await until(() => existsSync(ready), 'the turn to stream its chunk')
    await until(() => ctx.jobs.readAt(jobId, 0).next > 0, 'the chunk to reach the job ring')
    // Incremental output is readable mid-turn.
    const mid = ctx.jobs.read(jobId)
    expect(mid.job.status).toBe('running')
    expect(mid.chunks.map(c => c.text).join('')).toBe('partial so far')

    expect(ctx.jobs.kill(jobId, undefined, 'no longer needed')).toBe('requested')
    const settled = await ctx.jobs.wait(jobId, 5000)
    expect(settled.status).toBe('killed')
    expect(settled.detail).toContain('the agent stopped before finishing')
    expect(settled.detail).toContain('no longer needed')
    await until(() => existsSync(cancels), 'session/cancel to reach the agent')
    expect(readFileSync(cancels, 'utf8')).toMatch(/^cancel /)
    // The cancelled turn's connection was released; the record stays for reconnect.
    await until(() => pool.listChats().find(c => c.chatId === chatId)?.active === false, 'the connection release')
    expect(pool.knows(chatId as string)).toBe(true)
    // The chat is free for the next send (reconnect after cancel: pool.spec).
    expect(() => { pool.assertSendable(chatId as string) }).not.toThrow()
  })

  it('steers the running job turn without touching job state, then the job still completes', async () => {
    const ctx = await jobsHost()
    const dir = tempDir('acp-resume-jobs-steer-')
    const hold = join(dir, 'hold')
    const steers = join(dir, 'steers')
    writeFileSync(hold, 'held')
    const { call } = mountTools({ MOCK_TEXT: 'steered answer', MOCK_PROMPT_HOLD: hold, MOCK_STEER_FILE: steers }, ctx.jobs)
    const { chatId } = await call('start', { cwd: process.cwd() })
    const { jobId } = await call('send', { chatId, message: 'long task' }) as { jobId: JobId }
    await until(() => ctx.jobs.get(jobId).status === 'running', 'the job to run')

    const steered = await call('steer', { chatId, message: 'also check the tests' })
    expect(steered).toMatchObject({ queued: true, messageId: 'steer-test' })
    expect(readFileSync(steers, 'utf8')).toContain('also check the tests')
    // Steering is not a turn: the job is still the same running job, no second one exists.
    expect(ctx.jobs.get(jobId).status).toBe('running')
    expect(ctx.jobs.list()).toHaveLength(1)

    rmSync(hold)
    expect((await ctx.jobs.wait(jobId, 5000)).status).toBe('completed')
    expect(readAll(ctx.jobs, jobId)).toBe('steered answer')
  })

  it('keeps single flight: a second send while the job runs is a tool error and registers no job', async () => {
    const ctx = await jobsHost()
    const dir = tempDir('acp-resume-jobs-single-')
    const hold = join(dir, 'hold')
    writeFileSync(hold, 'held')
    const { call } = mountTools({ MOCK_PROMPT_HOLD: hold }, ctx.jobs)
    const { chatId } = await call('start', { cwd: process.cwd() })
    const { chatId: otherId } = await call('start', { cwd: process.cwd() })

    // Parallel sends in one step: same chat → one rejected; another chat runs alongside.
    const [first, second, other] = await Promise.allSettled([
      call('send', { chatId, message: 'one' }),
      call('send', { chatId, message: 'two' }),
      call('send', { chatId: otherId, message: 'three' }),
    ])
    expect(first.status).toBe('fulfilled')
    expect(second.status).toBe('rejected')
    expect((second as PromiseRejectedResult).reason.message).toContain('already has a prompt in flight')
    expect(other.status).toBe('fulfilled')
    expect(ctx.jobs.list().map(j => j.status)).toEqual(['running', 'running'])

    rmSync(hold)
    const jobId = (first as PromiseFulfilledResult<Record<string, unknown>>).value.jobId as JobId
    expect((await ctx.jobs.wait(jobId, 5000)).status).toBe('completed')
    // Free again once the job settled.
    const { jobId: after } = await call('send', { chatId, message: 'four' }) as { jobId: JobId }
    expect((await ctx.jobs.wait(after, 5000)).status).toBe('completed')
  })

  it('ends a non-completed turn failed, with the headline as detail and the partial answer readable', async () => {
    const ctx = await jobsHost()
    const { call } = mountTools({ MOCK_STOP: 'max_tokens', MOCK_TEXT: 'half an answer' }, ctx.jobs)
    const { chatId } = await call('start', { cwd: process.cwd() })
    const { jobId } = await call('send', { chatId, message: 'x' }) as { jobId: JobId }
    const settled = await ctx.jobs.wait(jobId, 5000)
    expect(settled.status).toBe('failed')
    expect(settled.detail).toBe('the agent ran out of room before it finished its answer')
    expect(readAll(ctx.jobs, jobId)).toBe('half an answer')
  })

  it('ends a crashed turn failed with the diagnostic excerpt', async () => {
    const ctx = await jobsHost()
    const { call } = mountTools({ MOCK_CRASH_ON_PROMPT: '1' }, ctx.jobs)
    const { chatId } = await call('start', { cwd: process.cwd() })
    const { jobId } = await call('send', { chatId, message: 'x' }) as { jobId: JobId }
    const settled = await ctx.jobs.wait(jobId, 5000)
    expect(settled.status).toBe('failed')
    expect(settled.detail).toMatch(/^the agent failed before it finished: Subagent failure \(provider: ACP; .*process-exit/)
  })

  it('puts the fresh-session note first in the job output', async () => {
    const ctx = await jobsHost()
    const store = join(tempDir('acp-resume-jobs-store-'), 's.json')
    const { call, pool } = mountTools({ MOCK_REMEMBER: '1', MOCK_SESSION_STORE: store }, ctx.jobs)
    const { chatId } = await call('start', { cwd: process.cwd() })
    await pool.close(chatId as string)
    rmSync(store)
    const { jobId } = await call('send', { chatId, message: 'x' }) as { jobId: JobId }
    expect((await ctx.jobs.wait(jobId, 5000)).status).toBe('completed')
    const [first, ...rest] = readAll(ctx.jobs, jobId).split('\n')
    expect(first).toMatch(/^\[remote session lost, started fresh — /)
    expect(rest.join('\n')).toBe('remember:none')
  })

  it('throws preflight and registry refusals as tool errors without starting a turn', async () => {
    const ctx = await jobsHost({ controller: false })
    const { call, pool } = mountTools({}, ctx.jobs)
    await expect(call('send', { chatId: 'chat-nope', message: 'x' })).rejects.toThrow('unknown chat chat-nope; call acp_chat_list to see known chats')
    const { chatId } = await call('start', { cwd: process.cwd() })
    // No job controller serves the caller: the registry refuses before the starter runs.
    await expect(call('send', { chatId, message: 'x' })).rejects.toThrow()
    expect(ctx.jobs.list()).toEqual([])
    // The refused call left the chat free.
    expect(() => { pool.assertSendable(chatId as string) }).not.toThrow()
  })

  it('owns the job by the calling agent\'s session: another session cannot read or kill it', async () => {
    const ctx = await jobsHost({ agents: true })
    const owner = await liveAgent(ctx, 'session-owner')
    const stranger = await liveAgent(ctx, 'session-stranger')
    const { call } = mountTools({ MOCK_TEXT: 'mine' }, ctx.jobs)
    const { chatId } = await call('start', { cwd: process.cwd() })
    const run = exec({ agent: owner })
    const { jobId } = await call('send', { chatId, message: 'hi' }, run) as { jobId: JobId }
    expect(ctx.jobs.get(jobId, owner.id).owner).toBe(owner.id)
    expect(() => ctx.jobs.get(jobId, stranger.id)).toThrow()
    expect(() => ctx.jobs.kill(jobId, stranger.id)).toThrow()
    expect(ctx.jobs.list(stranger.id)).toEqual([])
    expect((await ctx.jobs.wait(jobId, 5000, owner.id)).status).toBe('completed')
    expect(readAll(ctx.jobs, jobId, owner.id)).toBe('mine')
  })
})

/** Minimal live agent the registry accepts as a job owner (shape of the official jobs-local spec stub). */
async function liveAgent(ctx: Context, rawId: string): Promise<Agent> {
  const id = SessionId(rawId)
  const scopeFiber = ctx.plugin(() => {})
  const agent = {
    id,
    options: {},
    session: Session.create(id),
    inbox: unsupportedInbox(),
    status: 'idle' as const,
    ctx: scopeFiber.ctx,
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: <T>(job: (signal: AbortSignal) => Promise<T>) => job(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  } satisfies Agent
  await ctx.agents.register(agent)
  return agent
}

/** Stub `tools` service: `register` returns an unregister function. */
class StubTools extends Service {
  readonly registered = new Map<string, Definition>()

  constructor(ctx: Context) {
    super(ctx, 'tools')
  }

  register(definition: Definition): () => void {
    this.registered.set(definition.name, definition)
    return () => { this.registered.delete(definition.name) }
  }
}

async function host(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(StubTools)
  return ctx
}

function sendDescription(ctx: Context): string | undefined {
  return (ctx.get('tools') as unknown as StubTools).registered.get('acp_chat_send')?.description
}

describe('apply: the send variant follows ctx.jobs', () => {
  it('registers the inline send without a registry, the job-backed one while it is present, and inline again when it leaves', async () => {
    const ctx = await host()
    const registryPath = join(tempDir('acp-resume-jobs-apply-'), 'registry.json')
    const fiber = await ctx.plugin(acp, { command: process.execPath, args: [mockServer], registryPath })
    cleanups.push(() => fiber.dispose())
    await until(() => sendDescription(ctx) !== undefined, 'tool registration')
    expect(sendDescription(ctx)).toMatch(/await its final answer/)

    const jobsFiber = await ctx.plugin(LocalJobRegistry)
    ctx.jobs.attachController('jobs-spec')
    await until(() => /background job id/.test(sendDescription(ctx) ?? ''), 'the job-backed send')
    const tools = (ctx.get('tools') as unknown as StubTools).registered
    expect([...tools.keys()].sort()).toEqual(['acp_chat_close', 'acp_chat_list', 'acp_chat_send', 'acp_chat_start', 'acp_chat_steer'])
    const { chatId } = await tools.get('acp_chat_start')!.execute({ cwd: process.cwd() }, exec()) as { chatId: string }
    const { jobId } = await tools.get('acp_chat_send')!.execute({ chatId, message: 'hi' }, exec()) as { jobId: JobId }
    expect((await ctx.jobs.wait(jobId, 5000)).status).toBe('completed')
    expect(readAll(ctx.jobs, jobId)).toBe('mock child answer')

    await jobsFiber.dispose()
    await until(() => /await its final answer/.test(sendDescription(ctx) ?? ''), 'the inline send to return')
    expect(await tools.get('acp_chat_send')!.execute({ chatId, message: 'inline' }, exec())).toEqual({ text: 'mock child answer' })
  })

  it('registers the job-backed send directly when the registry is already composed', async () => {
    const ctx = await host()
    await ctx.plugin(LocalJobRegistry)
    ctx.jobs.attachController('jobs-spec')
    const registryPath = join(tempDir('acp-resume-jobs-apply-'), 'registry.json')
    const fiber = await ctx.plugin(acp, { command: process.execPath, args: [mockServer], registryPath })
    cleanups.push(() => fiber.dispose())
    await until(() => sendDescription(ctx) !== undefined, 'tool registration')
    expect(sendDescription(ctx)).toMatch(/background job id/)
  })
})
