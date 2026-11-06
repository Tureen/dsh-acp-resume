/**
 * D22: the pre-execute gate that refuses a blocking `job_output` wait on a
 * running `acp-chat` job. Pure-function cases run `decideJobWait` over the
 * REAL process-local job registry (running / settled / other kind / unknown /
 * foreign-session jobs, malformed arguments). Plugin cases assert the
 * `allowChatJobWait` switch controls whether `apply` registers the
 * `tools/pre-execute` listener. The integration case dispatches a fake
 * `job_output` through the REAL `ToolRuntime`: the denied call returns an
 * error result and the tool body never runs. Keyless; no model.
 *
 * @module dsh-acp-resume/tests/job-wait-gate.spec
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as acp from '../src/index.ts'
import { decideJobWait, waitDeniedReason } from '../src/job-wait-gate.ts'
import { mountWorkingDirectoryFixture } from './helpers/working-directory-fixture.ts'

const mockServer = fileURLToPath(new URL('./mock-acp-server.ts', import.meta.url))

const dirs: string[] = []
const cleanups: (() => unknown)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
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

/** A registry host with a job controller and the agent registry (jobs need live owners). */
async function jobsHost(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin((await import('@deepseek-ai/dsh-agent')).default)
  await ctx.plugin(LocalJobRegistry)
  ctx.jobs.attachController('gate-spec')
  cleanups.push(() => ctx.fiber.dispose())
  return ctx
}

interface Settler {
  id: JobId
  settle(): void
}

/** Register a job of `kind` the test settles by hand. */
function startJob(ctx: Context, kind: 'acp-chat' | 'bash', owner: Agent | undefined, options: { deferCancel?: boolean } = {}): Settler {
  let settle!: () => void
  const done = new Promise<{ status: 'completed' }>((resolve) => { settle = () => { resolve({ status: 'completed' }) } })
  const id = ctx.jobs.start({
    kind,
    label: `${kind} test job`,
    ...(owner === undefined ? {} : { owner: owner.id }),
    run: () => ({ done, cancel() { if (options.deferCancel !== true) settle() } }),
  } as Parameters<typeof ctx.jobs.start>[0])
  return { id, settle }
}

const outputCall = (agent: Agent | undefined, args: unknown, name = 'job_output') => ({ name, arguments: args, agent })

describe('decideJobWait', () => {
  it('denies wait on a running acp-chat job, naming the job id', async () => {
    const ctx = await jobsHost()
    const agent = await liveAgent(ctx, 'session-a')
    const job = startJob(ctx, 'acp-chat', agent)
    const decision = decideJobWait(ctx.jobs, outputCall(agent, { job_id: job.id, wait: true, timeout_ms: 600000 }))
    expect(decision).toEqual({ kind: 'deny', reason: waitDeniedReason(job.id) })
    expect((decision as { reason: string }).reason).toContain(job.id)
    expect(job.id).toMatch(/^acp-chat-/)
    job.settle()
  })

  it('allows a read without wait, and wait:false', async () => {
    const ctx = await jobsHost()
    const agent = await liveAgent(ctx, 'session-a')
    const job = startJob(ctx, 'acp-chat', agent)
    expect(decideJobWait(ctx.jobs, outputCall(agent, { job_id: job.id }))).toBeUndefined()
    expect(decideJobWait(ctx.jobs, outputCall(agent, { job_id: job.id, wait: false }))).toBeUndefined()
    job.settle()
  })

  it('allows wait once the job has settled', async () => {
    const ctx = await jobsHost()
    const agent = await liveAgent(ctx, 'session-a')
    const job = startJob(ctx, 'acp-chat', agent)
    job.settle()
    await ctx.jobs.wait(job.id, 5000, agent.id)
    expect(ctx.jobs.get(job.id, agent.id).status).toBe('completed')
    expect(decideJobWait(ctx.jobs, outputCall(agent, { job_id: job.id, wait: true }))).toBeUndefined()
  })

  it('allows wait on a stopping job (killed by the model, no completion notice is coming)', async () => {
    const ctx = await jobsHost()
    const agent = await liveAgent(ctx, 'session-a')
    const job = startJob(ctx, 'acp-chat', agent, { deferCancel: true })
    ctx.jobs.kill(job.id, agent.id, 'test kill')
    expect(ctx.jobs.get(job.id, agent.id).status).toBe('stopping')
    expect(decideJobWait(ctx.jobs, outputCall(agent, { job_id: job.id, wait: true }))).toBeUndefined()
    job.settle()
  })

  it('leaves other job kinds alone', async () => {
    const ctx = await jobsHost()
    const agent = await liveAgent(ctx, 'session-a')
    const job = startJob(ctx, 'bash', agent)
    expect(decideJobWait(ctx.jobs, outputCall(agent, { job_id: job.id, wait: true }))).toBeUndefined()
    job.settle()
  })

  it('allows an unknown job id (job_output reports its own error)', async () => {
    const ctx = await jobsHost()
    const agent = await liveAgent(ctx, 'session-a')
    expect(decideJobWait(ctx.jobs, outputCall(agent, { job_id: 'acp-chat-0000000000000000', wait: true }))).toBeUndefined()
  })

  it('allows a job owned by another session', async () => {
    const ctx = await jobsHost()
    const owner = await liveAgent(ctx, 'session-owner')
    const stranger = await liveAgent(ctx, 'session-stranger')
    const job = startJob(ctx, 'acp-chat', owner)
    expect(decideJobWait(ctx.jobs, outputCall(stranger, { job_id: job.id, wait: true }))).toBeUndefined()
    expect(decideJobWait(ctx.jobs, outputCall(owner, { job_id: job.id, wait: true }))?.kind).toBe('deny')
    job.settle()
  })

  it('allows other tools, a missing agent, and malformed arguments', async () => {
    const ctx = await jobsHost()
    const agent = await liveAgent(ctx, 'session-a')
    const job = startJob(ctx, 'acp-chat', agent)
    const good = { job_id: job.id, wait: true }
    expect(decideJobWait(ctx.jobs, outputCall(agent, good, 'job_list'))).toBeUndefined()
    expect(decideJobWait(ctx.jobs, outputCall(undefined, good))).toBeUndefined()
    expect(decideJobWait(ctx.jobs, outputCall(agent, '{"job_id": broken'))).toBeUndefined()
    expect(decideJobWait(ctx.jobs, outputCall(agent, null))).toBeUndefined()
    expect(decideJobWait(ctx.jobs, outputCall(agent, { wait: true }))).toBeUndefined()
    expect(decideJobWait(ctx.jobs, outputCall(agent, { job_id: '', wait: true }))).toBeUndefined()
    expect(decideJobWait(ctx.jobs, outputCall(agent, { job_id: 7, wait: true }))).toBeUndefined()
    expect(decideJobWait(ctx.jobs, outputCall(agent, { job_id: job.id, wait: 'true' }))).toBeUndefined()
    job.settle()
  })

  it('guides the model: no polling, read after the notice without wait, no new send meanwhile', () => {
    const reason = waitDeniedReason('acp-chat-abc')
    expect(reason).toContain('acp-chat-abc')
    expect(reason).toMatch(/notification/)
    expect(reason).toMatch(/without wait/)
    expect(reason).toMatch(/Do not poll/)
    expect(reason).toMatch(/Ending your turn while this job runs is correct/)
    expect(reason).toMatch(/counts as collecting/)
    expect(reason).toMatch(/do not send another message/)
  })
})

/** Stub `tools` service so the plugin reaches its chat-tools scope. */
class StubTools extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tools')
  }

  register(): () => void {
    return () => {}
  }
}

async function pluginHost(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(StubTools)
  await ctx.plugin((await import('@deepseek-ai/dsh-agent')).default)
  await ctx.plugin(LocalJobRegistry)
  ctx.jobs.attachController('gate-spec')
  cleanups.push(() => ctx.fiber.dispose())
  return ctx
}

/** Run the waterfall as the tool runtime would; `kind` is what the chain resolved to. */
async function dispatch(ctx: Context, exec: unknown): Promise<{ kind: string; reason?: string }> {
  const gate = (ctx as unknown as { waterfall(name: string, ...args: unknown[]): Promise<{ kind: string; reason?: string }> })
  return await gate.waterfall('tools/pre-execute', exec, async () => ({ kind: 'allow' }))
}

describe('apply: allowChatJobWait switch', () => {
  async function mounted(config: Record<string, unknown>): Promise<{ ctx: Context; agent: Agent; job: Settler }> {
    const ctx = await pluginHost()
    const dir = mkdtempSync(join(tmpdir(), 'acp-resume-gate-'))
    dirs.push(dir)
    const fiber = await ctx.plugin(acp, { command: process.execPath, args: [mockServer], registryPath: join(dir, 'registry.json'), ...config })
    cleanups.push(() => fiber.dispose())
    const agent = await liveAgent(ctx, 'session-a')
    return { ctx, agent, job: startJob(ctx, 'acp-chat', agent) }
  }

  it('denies a wait on a running chat job by default', async () => {
    const { ctx, agent, job } = await mounted({})
    const decision = await dispatch(ctx, outputCall(agent, { job_id: job.id, wait: true }))
    expect(decision.kind).toBe('deny')
    expect(decision.reason).toContain(job.id)
    expect((await dispatch(ctx, outputCall(agent, { job_id: job.id }))).kind).toBe('allow')
    job.settle()
  })

  it('registers no listener when allowChatJobWait is true', async () => {
    const { ctx, agent, job } = await mounted({ allowChatJobWait: true })
    expect((await dispatch(ctx, outputCall(agent, { job_id: job.id, wait: true }))).kind).toBe('allow')
    job.settle()
  })

  it('drops the listener when the jobs service leaves', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(StubTools)
    await ctx.plugin((await import('@deepseek-ai/dsh-agent')).default)
    cleanups.push(() => ctx.fiber.dispose())
    const dir = mkdtempSync(join(tmpdir(), 'acp-resume-gate-'))
    dirs.push(dir)
    const fiber = await ctx.plugin(acp, { command: process.execPath, args: [mockServer], registryPath: join(dir, 'registry.json') })
    cleanups.push(() => fiber.dispose())
    const agent = await liveAgent(ctx, 'session-a')
    // Without jobs the listener is absent: the chain falls straight through.
    const probe = outputCall(agent, { job_id: 'acp-chat-0000000000000000', wait: true })
    expect((await dispatch(ctx, probe)).kind).toBe('allow')
    const jobsFiber = await ctx.plugin(LocalJobRegistry)
    ctx.jobs.attachController('gate-spec')
    const job = startJob(ctx, 'acp-chat', agent)
    expect((await dispatch(ctx, outputCall(agent, { job_id: job.id, wait: true }))).kind).toBe('deny')
    await jobsFiber.dispose()
    expect((await dispatch(ctx, outputCall(agent, { job_id: job.id, wait: true }))).kind).toBe('allow')
    // Remounting the registry brings the gate back (and exactly one listener).
    await ctx.plugin(LocalJobRegistry)
    ctx.jobs.attachController('gate-spec')
    const again = startJob(ctx, 'acp-chat', agent)
    expect((await dispatch(ctx, outputCall(agent, { job_id: again.id, wait: true }))).kind).toBe('deny')
    again.settle()
  })
})

describe('real ToolRuntime dispatch', () => {
  it('returns an error result for a denied wait and never runs the tool body; allows the read', async () => {
    const ctx = new Context()
    const calls: unknown[] = []
    class StubSystemPrompt extends Service {
      constructor(c: Context) { super(c, 'systemPrompt') }
      tools() { return () => {} }
      section() { return () => {} }
      getSectionOrder() { return 0 }
    }
    await ctx.plugin(StubSystemPrompt)
    await ctx.plugin((await import('@deepseek-ai/dsh-agent')).default)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalJobRegistry)
    ctx.jobs.attachController('gate-spec')
    cleanups.push(() => ctx.fiber.dispose())
    ctx.tools.register(defineTool({
      name: 'job_output',
      description: 'fake job_output',
      parameters: {
        job_id: { type: 'string', required: true },
        wait: { type: 'boolean' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        calls.push(args)
        return { text: 'body ran' }
      },
    }))
    const dir = mkdtempSync(join(tmpdir(), 'acp-resume-gate-'))
    dirs.push(dir)
    const fiber = await ctx.plugin(acp, { command: process.execPath, args: [mockServer], registryPath: join(dir, 'registry.json') })
    cleanups.push(() => fiber.dispose())
    const agent = await liveAgent(ctx, 'session-a')
    const job = startJob(ctx, 'acp-chat', agent)

    const denied = await ctx.tools.execute({
      callId: 'call-deny' as never,
      name: 'job_output',
      arguments: { job_id: job.id, wait: true },
      agent,
      signal: new AbortController().signal,
    })
    expect(denied.isError).toBe(true)
    const text = denied.content.map(block => ('text' in block ? block.text : '')).join('')
    expect(text.startsWith('Error: job acp-chat-')).toBe(true)
    expect(calls).toEqual([])

    const allowed = await ctx.tools.execute({
      callId: 'call-allow' as never,
      name: 'job_output',
      arguments: { job_id: job.id },
      agent,
      signal: new AbortController().signal,
    })
    expect(allowed.isError).toBeFalsy()
    expect(calls).toEqual([{ job_id: job.id }])
    job.settle()
  })
})
