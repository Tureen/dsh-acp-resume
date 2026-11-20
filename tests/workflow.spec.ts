/**
 * D27 second round: the workflow engine (params, parallel steps with partial
 * failure, sequential injection, both merge modes, cancellation) against a
 * recording fake pool, plus the `acp_workflow` tool and `acp_chat_steer`'s
 * `role` over a real pool and mock-acp-server subprocesses. Keyless; no model.
 *
 * @module dsh-acp-resume/tests/workflow.spec
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { AcpSessionPool, type PoolSendResult, type RoleCallContext } from '../src/pool.ts'
import { parseTeamConfig, type Template } from '../src/team-config.ts'
import { chatWorkflowTool, registerChatTools, type ToolsRegistryFace } from '../src/tools.ts'
import { bindParams, fillPrompt, runWorkflow, type WorkflowPool } from '../src/workflow-engine.ts'
import { WorkflowRecorder } from '../src/workflow-record.ts'
import { nodeSpawn } from './helpers/node-spawn.ts'

const mockServer = fileURLToPath(new URL('./mock-acp-server.ts', import.meta.url))

const dirs: string[] = []
const pools: AcpSessionPool[] = []

afterEach(async () => {
  await Promise.allSettled(pools.splice(0).map(p => p.disposeAll()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

const TEAM = `
roles:
  - name: reviewerA
  - name: reviewerB
  - name: merger
templates:
  - name: dual_review
    description: two independent reviews, then a merge
    params: [target, dimensions]
    steps:
      - id: independent
        parallel: [reviewerA, { role: reviewerB, prompt: "B reviews {target}" }]
        prompt: "review {target} on {dimensions}"
      - id: merge
        merge: { mode: role, role: merger, prompt: "merge reviews of {target}" }
  - name: chain
    params: [target]
    steps:
      - id: first
        parallel: [reviewerA]
        prompt: "draft {target}"
      - id: second
        parallel: [reviewerB]
        prompt: "check this: {first}"
      - id: third
        parallel: [merger]
        prompt: "finalize"
      - id: done
        merge: { mode: return_to_model }
`

const templates = parseTeamConfig(TEAM, '/ws').templates
const template = (name: string): Template => templates.find(t => t.name === name) as Template
const CONTEXT: RoleCallContext = { ownerSessionId: 'session-a', workspaceDir: '/ws' }

/** A fake pool that records every prompt and answers `<role> saw: <prompt first line>`, or fails the roles in `failing`. */
function fakePool(failing: Record<string, 'throw' | 'error'> = {}): WorkflowPool & { readonly prompts: Map<string, string> } {
  const prompts = new Map<string, string>()
  return {
    prompts,
    async sendByRole(role, message) {
      prompts.set(role, message)
      if (failing[role] === 'throw') throw new Error(`${role} could not be provisioned`)
      const base: PoolSendResult = { chatId: `chat-${role}`, remoteSessionId: 'r', output: `${role} saw: ${message.split('\n')[0]}`, stopReason: 'completed', freshSession: false, freshSessionReason: undefined, diagnostic: undefined }
      return failing[role] === 'error' ? { ...base, output: '', stopReason: 'error', diagnostic: 'boom' } : base
    },
  }
}

describe('workflow engine (D27)', () => {
  it('runs a parallel step and a role merge, filling params, with the documented result shape', async () => {
    const pool = fakePool()
    const params = bindParams(template('dual_review'), { target: 'src/pool.ts', dimensions: 'safety' })
    const result = await runWorkflow(pool, template('dual_review'), params, CONTEXT, new AbortController().signal)
    expect(result).toEqual({
      template: 'dual_review',
      status: 'completed',
      steps: [
        { id: 'independent', results: { reviewerA: 'reviewerA saw: review src/pool.ts on safety', reviewerB: 'reviewerB saw: B reviews src/pool.ts' } },
        { id: 'merge', result: 'merger saw: merge reviews of src/pool.ts' },
      ],
    })
    // The merging role receives every earlier result.
    expect(pool.prompts.get('merger')).toContain('### Step independent\n#### reviewerA\nreviewerA saw: review src/pool.ts on safety')
    expect(pool.prompts.get('merger')).toContain('#### reviewerB\nreviewerB saw: B reviews src/pool.ts')
  })

  it('injects an earlier step through {stepId}, appends the previous step when none is named, and ends on return_to_model', async () => {
    const pool = fakePool()
    const result = await runWorkflow(pool, template('chain'), { target: 'X' }, CONTEXT, new AbortController().signal)
    expect(pool.prompts.get('reviewerB')).toBe('check this: ### Step first\n#### reviewerA\nreviewerA saw: draft X')
    expect(pool.prompts.get('merger')).toBe('finalize\n\nResults of the previous step:\n\n### Step second\n#### reviewerB\nreviewerB saw: check this: ### Step first')
    expect(result.status).toBe('completed')
    expect(result.steps.at(-1)).toEqual({ id: 'done', mode: 'return_to_model' })
    expect(result.steps.map(s => s.id)).toEqual(['first', 'second', 'third', 'done'])
  })

  it('records a failing role as { error } and lets the others carry on; a step where every role failed stops the run', async () => {
    const partial = await runWorkflow(fakePool({ reviewerB: 'error' }), template('dual_review'), { target: 't', dimensions: 'd' }, CONTEXT, new AbortController().signal)
    expect(partial.status).toBe('completed')
    expect(partial.steps[0]).toEqual({ id: 'independent', results: { reviewerA: 'reviewerA saw: review t on d', reviewerB: { error: 'turn ended error: boom' } } })
    const dead = await runWorkflow(fakePool({ reviewerA: 'throw', reviewerB: 'error' }), template('dual_review'), { target: 't', dimensions: 'd' }, CONTEXT, new AbortController().signal)
    expect(dead).toMatchObject({ status: 'failed', error: 'step independent: every role failed' })
    expect(dead.steps).toHaveLength(1)
    const mergeDown = await runWorkflow(fakePool({ merger: 'throw' }), template('dual_review'), { target: 't', dimensions: 'd' }, CONTEXT, new AbortController().signal)
    expect(mergeDown).toMatchObject({ status: 'failed', error: 'step merge: merge role merger: merger could not be provisioned' })
  })

  it('checks params: every declared one present, nothing undeclared, scalar values only', () => {
    expect(() => bindParams(template('dual_review'), { target: 'x' })).toThrow('template dual_review needs params: dimensions')
    expect(() => bindParams(template('dual_review'), { target: 'x', dimensions: 'y', extra: 1 })).toThrow('template dual_review has no param extra')
    expect(() => bindParams(template('dual_review'), { target: { a: 1 }, dimensions: 'y' })).toThrow('param target must be a string, number, or boolean')
    expect(bindParams(template('chain'), { target: 3 })).toEqual({ target: '3' })
    // Unknown placeholders stay literal (prompts may carry braces).
    expect(fillPrompt('keep {unknown} and {target}', { target: 'T' }, [])).toBe('keep {unknown} and T')
  })

  it('does not fill {constructor}, {toString} or {__proto__} from Object.prototype', () => {
    expect(fillPrompt('{constructor} {toString} {__proto__} {hasOwnProperty}', { target: 'T' }, [])).toBe('{constructor} {toString} {__proto__} {hasOwnProperty}')
    expect(fillPrompt('{constructor}', bindParams(template('chain'), { target: 'T' }), [])).toBe('{constructor}')
  })

  it('reports a declared __proto__ or constructor param as missing when not given, and binds it when given', () => {
    const [proto] = parseTeamConfig('roles:\n  - name: a\ntemplates:\n  - name: t\n    params: [__proto__, constructor]\n    steps:\n      - id: s\n        parallel: [a]\n', '/ws').templates as [Template]
    expect(() => bindParams(proto, {})).toThrow('template t needs params: __proto__, constructor')
    const bound = bindParams(proto, JSON.parse('{"__proto__": "P", "constructor": "C"}'))
    expect(fillPrompt('{__proto__}/{constructor}', bound, [])).toBe('P/C')
  })

  it('stops between steps once cancelled and reports aborted', async () => {
    const controller = new AbortController()
    const pool: WorkflowPool = {
      async sendByRole(role) {
        controller.abort()
        return { chatId: role, remoteSessionId: 'r', output: 'x', stopReason: 'completed', freshSession: false, freshSessionReason: undefined, diagnostic: undefined }
      },
    }
    const result = await runWorkflow(pool, template('chain'), { target: 'X' }, CONTEXT, controller.signal)
    expect(result).toMatchObject({ status: 'aborted' })
    expect(result.steps.map(s => s.id)).toEqual(['first'])
  })

  it('rejects templates that misuse return_to_model, repeat a role in one step, or reuse a param name as a step id', () => {
    const base = 'roles:\n  - name: a\n  - name: b\ntemplates:\n  - name: t\n    params: [p]\n    steps:\n'
    expect(() => parseTeamConfig(`${base}      - id: m\n        merge: { mode: return_to_model }\n      - id: s\n        parallel: [a]\n`, '/ws')).toThrow('a return_to_model merge must be the last step')
    expect(() => parseTeamConfig(`${base}      - id: s\n        parallel: [a, a]\n`, '/ws')).toThrow('duplicate role in')
    expect(() => parseTeamConfig(`${base}      - id: p\n        parallel: [a]\n`, '/ws')).toThrow('step id p collides with a param')
  })
})

describe('acp_workflow and steer by role (D27)', () => {
  type Definition = Parameters<ToolsRegistryFace['register']>[0]

  function mount(env: Record<string, string> = {}, withRoles = true) {
    const root = tempDir('acp-resume-wf-ws-')
    mkdirSync(join(root, '.agents'))
    writeFileSync(join(root, '.agents', 'acp-team.yml'), TEAM)
    const store = join(tempDir('acp-resume-wf-store-'), 's.json')
    const pool = new AcpSessionPool({
      specBase: { command: process.execPath, args: [mockServer], permission: 'reject', env: { MOCK_ECHO_PROMPT: '1', MOCK_SESSION_STORE: store, ...env }, disposeEofGraceMs: 500, disposeGraceMs: 500, spawn: nodeSpawn },
      registryPath: join(tempDir('acp-resume-wf-reg-'), 'registry.json'),
      idleTimeoutMs: 600_000,
    })
    pools.push(pool)
    const tools = new Map<string, Definition>()
    registerChatTools({ effect: (fn: () => () => void) => { fn() } } as unknown as Context, { register: (d) => { tools.set(d.name, d); return () => {} } }, pool, 'acp_chat_', undefined,
      withRoles ? { workspaceDirFor: () => root } : undefined)
    const call = async (name: string, args: Record<string, unknown>): Promise<{ text: string; queued?: boolean }> =>
      await (tools.get(name) as Definition).execute(args, { signal: new AbortController().signal, agent: { id: 'session-a' } } as unknown as ToolRunContext) as { text: string }
    return { tools, pool, call, root }
  }

  it('runs a template end to end over real role chats and returns the JSON result', async () => {
    const { call, pool } = mount()
    const { text } = await call('acp_workflow', { template: 'dual_review', params: { target: 'T', dimensions: 'D' } })
    const result = JSON.parse(text) as { status: string; steps: [{ results: Record<string, string> }, { result: string }] }
    expect(result.status).toBe('completed')
    expect(result.steps[0].results).toEqual({ reviewerA: 'echo:review T on D', reviewerB: 'echo:B reviews T' })
    expect(result.steps[1].result).toMatch(/^echo:merge reviews of T\n\n### Step independent\n#### reviewerA\necho:review T on D/)
    // The roles were provisioned into this session's roster.
    expect(pool.listRoster('session-a').map(e => e.role).sort()).toEqual(['merger', 'reviewerA', 'reviewerB'])
  })

  it('refuses an unknown template and missing params before running anything', async () => {
    const { call, pool } = mount()
    await expect(call('acp_workflow', { template: 'nope' })).rejects.toThrow(/unknown template nope; templates defined in .*: dual_review, chain/)
    await expect(call('acp_workflow', { template: 'dual_review', params: { target: 'T' } })).rejects.toThrow('template dual_review needs params: dimensions')
    expect(pool.listChats()).toEqual([])
  })

  it('tells the model in its description how partial failures, kept roles, and progress work', () => {
    const description = mount().tools.get('acp_workflow')?.description ?? ''
    expect(description).toContain('A role that failed shows as {error} inside its step; the run only fails when every role in a step failed.')
    expect(description).toContain('Roles keep their chats (and memory) after the run; follow up with acp_chat_send role=…, or acp_chat_close role=… to reset.')
    expect(description).toContain('Progress is shown to the user as a workflow card; the result comes with job_output.')
    expect(description).not.toMatch(/tool-workflow\/|session_event_/)
  })

  it('routes permission: ask requests of workflow roles (seeding included) to the caller\'s confirmation bridge', async () => {
    const root = tempDir('acp-resume-wf-ask-')
    mkdirSync(join(root, '.agents'))
    writeFileSync(join(root, '.agents', 'acp-team.yml'), 'roles:\n  - name: asker\n    seeding: hello\ntemplates:\n  - name: one\n    steps:\n      - id: s\n        parallel: [asker]\n        prompt: go\n')
    const pool = new AcpSessionPool({
      specBase: { command: process.execPath, args: [mockServer], permission: 'ask', env: { MOCK_PERMISSION: '1', MOCK_TEXT: 'approved answer' }, disposeEofGraceMs: 500, disposeGraceMs: 500, spawn: nodeSpawn },
      registryPath: join(root, 'registry.json'),
      idleTimeoutMs: 600_000,
    })
    pools.push(pool)
    const asked: string[] = []
    const allow = async (request: { toolCall: { title?: string | null } }) => {
      asked.push(request.toolCall.title ?? '')
      return { outcome: { outcome: 'selected' as const, optionId: 'yes' } }
    }
    const one = pool.templateFor('one', { ownerSessionId: 'session-a', workspaceDir: root })
    const result = await runWorkflow(pool, one, {}, { ownerSessionId: 'session-a', workspaceDir: root }, new AbortController().signal, {}, allow as never)
    expect(result).toMatchObject({ status: 'completed', steps: [{ id: 's', results: { asker: 'approved answer' } }] })
    // One question for the seeding turn, one for the step's turn.
    expect(asked).toEqual(['mock side effect', 'mock side effect'])
  })

  it('is not registered with the workflow feature off', () => {
    expect(mount({}, false).tools.has('acp_workflow')).toBe(false)
    expect(mount().tools.has('acp_workflow')).toBe(true)
  })

  it('steers a role\'s running turn through the roster, and refuses a role with no chat or no turn', async () => {
    const dir = tempDir('acp-resume-wf-steer-')
    const hold = join(dir, 'hold')
    const steers = join(dir, 'steers')
    const { call, pool } = mount({ MOCK_PROMPT_HOLD: hold, MOCK_STEER_FILE: steers })
    await call('acp_chat_send', { role: 'reviewerA', message: 'warm up' })
    await expect(call('acp_chat_steer', { role: 'reviewerA', message: 'x' })).rejects.toThrow(/no turn in flight/)
    await expect(call('acp_chat_steer', { role: 'merger', message: 'x' })).rejects.toThrow(/role merger has no chat in this session/)
    writeFileSync(hold, 'held')
    const chatId = pool.resolveRole('reviewerA', 'session-a') as string
    const sending = call('acp_chat_send', { role: 'reviewerA', message: 'long task' })
    const deadline = Date.now() + 5000
    while (pool.chatInfo(chatId)?.inFlight === undefined && Date.now() < deadline) await new Promise(r => setTimeout(r, 10))
    const steered = await call('acp_chat_steer', { role: 'reviewerA', message: 'also check tests' })
    expect(steered).toMatchObject({ queued: true })
    expect(steered.text).toContain(`chat ${chatId}`)
    rmSync(hold)
    await expect(sending).resolves.toEqual({ text: 'echo:long task' })
    expect(existsSync(steers)).toBe(true)
  })
})

describe('workflow progress records (D27, 2026-11-20)', () => {
  type Record_ = { type: string; data: Record<string, unknown> }
  const sink = (): { session: { append(type: string, data: unknown): void }; records: Record_[] } => {
    const records: Record_[] = []
    return { records, session: { append: (type, data) => { records.push({ type, data: data as Record<string, unknown> }) } } }
  }
  const observe = (recorder: WorkflowRecorder) => ({
    memberStart: (role: string, stepId: string) => recorder.memberStart(role, stepId),
    memberEnd: (seq: number, outcome: 'completed' | 'failed' | 'cancelled') => { recorder.memberEnd(seq, outcome) },
  })

  it('writes run-start, paired agent-start/agent-end per role with seq and phase, then run-end', async () => {
    const { session, records } = sink()
    const recorder = new WorkflowRecorder(session)
    const runId = recorder.start('dual_review')
    const result = await runWorkflow(fakePool({ reviewerB: 'error' }), template('dual_review'), { target: 't', dimensions: 'd' }, CONTEXT, new AbortController().signal, observe(recorder))
    recorder.finish('completed')
    expect(result.status).toBe('completed')
    expect(records.map(r => r.type)).toEqual([
      'tool-workflow/run-start', 'tool-workflow/agent-start', 'tool-workflow/agent-start',
      'tool-workflow/agent-end', 'tool-workflow/agent-end', 'tool-workflow/agent-start', 'tool-workflow/agent-end', 'tool-workflow/run-end',
    ])
    expect(records[0]?.data).toEqual({ runId, name: 'dual_review' })
    const starts = records.filter(r => r.type === 'tool-workflow/agent-start').map(r => r.data)
    expect(starts).toEqual([
      { runId, seq: 1, label: 'reviewerA', phase: 'independent', childId: 'acp-role:reviewerA' },
      { runId, seq: 2, label: 'reviewerB', phase: 'independent', childId: 'acp-role:reviewerB' },
      { runId, seq: 3, label: 'merger', phase: 'merge', childId: 'acp-role:merger' },
    ])
    const ends = Object.fromEntries(records.filter(r => r.type === 'tool-workflow/agent-end').map(r => [r.data['seq'], r.data['outcome']]))
    expect(ends).toEqual({ 1: 'completed', 2: 'failed', 3: 'completed' })
    expect(records.at(-1)?.data).toEqual({ runId, stopReason: 'completed' })
  })

  it('marks members and the run cancelled when the run is cancelled; return_to_model adds no member', async () => {
    const { session, records } = sink()
    const recorder = new WorkflowRecorder(session)
    recorder.start('chain')
    const controller = new AbortController()
    const pool: WorkflowPool = {
      async sendByRole(role) {
        controller.abort()
        return { chatId: role, remoteSessionId: 'r', output: '', stopReason: 'aborted', freshSession: false, freshSessionReason: undefined, diagnostic: undefined }
      },
    }
    const result = await runWorkflow(pool, template('chain'), { target: 'X' }, CONTEXT, controller.signal, observe(recorder))
    recorder.finish('cancelled')
    expect(result.status).toBe('aborted')
    expect(records.filter(r => r.type === 'tool-workflow/agent-end').map(r => r.data['outcome'])).toEqual(['cancelled'])
    expect(records.at(-1)?.data['stopReason']).toBe('cancelled')
    const full = sink()
    const second = new WorkflowRecorder(full.session)
    await runWorkflow(fakePool(), template('chain'), { target: 'X' }, CONTEXT, new AbortController().signal, observe(second))
    expect(full.records.filter(r => r.type === 'tool-workflow/agent-start').map(r => r.data['phase'])).toEqual(['first', 'second', 'third'])
  })

  it('warns once and stops recording after a failed append, leaving the workflow result untouched', async () => {
    const warnings: string[] = []
    let calls = 0
    const recorder = new WorkflowRecorder({ append: () => { calls += 1; if (calls === 2) throw new Error('disk full') } }, (m) => { warnings.push(m) })
    recorder.start('dual_review')
    const result = await runWorkflow(fakePool(), template('dual_review'), { target: 't', dimensions: 'd' }, CONTEXT, new AbortController().signal, observe(recorder))
    recorder.finish('completed')
    expect(result.status).toBe('completed')
    expect(result.steps).toHaveLength(2)
    expect(calls).toBe(2)
    expect(warnings).toEqual(['acp-resume: workflow progress record disabled after tool-workflow/agent-start append failed: disk full'])
  })

  it('records only for a model-direct call, and reports each step as the job progress line', async () => {
    const root = tempDir('acp-resume-wf-rec-')
    mkdirSync(join(root, '.agents'))
    writeFileSync(join(root, '.agents', 'acp-team.yml'), TEAM)
    const pool = new AcpSessionPool({
      specBase: { command: process.execPath, args: [mockServer], permission: 'reject', env: { MOCK_ECHO_PROMPT: '1', MOCK_SESSION_STORE: join(root, 's.json') }, disposeEofGraceMs: 500, disposeGraceMs: 500, spawn: nodeSpawn },
      registryPath: join(root, 'registry.json'),
      idleTimeoutMs: 600_000,
    })
    pools.push(pool)
    const progress: string[] = []
    let done: Promise<unknown> | undefined
    const jobs = {
      start(spec: { run: (job: unknown) => { done: Promise<unknown> } }) {
        done = spec.run({ append: () => {}, updateProgress: (line: string) => { progress.push(line) } }).done
        return 'job-1'
      },
    }
    const tool = chatWorkflowTool(pool, { workspaceDirFor: () => root }, jobs as never)
    const receipt = await tool.execute({ template: 'chain', params: { target: 'X' } }, { signal: new AbortController().signal, agent: { id: 'session-a', session: sink().session } } as unknown as ToolRunContext) as { text: string }
    await done
    expect(receipt.text).toBe('workflow chain started as background job job-1. You are woken in-session when it finishes. '
      + 'Do not call wait_agent or job_output with wait. Send any other independent tasks, then end your reply; the completion notification wakes you.')
    progress.length = 0
    const direct = sink()
    const nested = sink()
    const run = async (session: ReturnType<typeof sink>['session'], parent?: unknown): Promise<void> => {
      await tool.execute({ template: 'dual_review', params: { target: 'T', dimensions: 'D' } }, { signal: new AbortController().signal, agent: { id: 'session-a', session }, ...(parent === undefined ? {} : { parent }) } as unknown as ToolRunContext)
      await done
    }
    await run(direct.session)
    expect(direct.records.map(r => r.type).at(0)).toBe('tool-workflow/run-start')
    expect(direct.records.at(-1)).toMatchObject({ type: 'tool-workflow/run-end', data: { stopReason: 'completed' } })
    expect(direct.records.filter(r => r.type === 'tool-workflow/agent-start')).toHaveLength(3)
    expect(progress).toEqual(['independent', 'merge'])
    await run(nested.session, { token: 'ptc' })
    expect(nested.records).toEqual([])
  })
})
