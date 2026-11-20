/**
 * D29 workflow run log and pool tracking: append/read/trim/tolerance of
 * `workflows/<owner>.jsonl`, interrupted runs, the running set, orphan
 * cleanup on purge, the `acpResume/workflows` Remote method, and the run id
 * shared between the panel entry and the official progress records. Keyless; no model.
 *
 * @module dsh-acp-resume/tests/workflow-log.spec
 */

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { AcpResumePanelService } from '../src/panel.ts'
import { AcpSessionPool } from '../src/pool.ts'
import { chatWorkflowTool } from '../src/tools.ts'
import { RETAINED_RUNS, TRIM_ABOVE_RUNS, WorkflowLog } from '../src/workflow-log.ts'
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

const STEPS = [{ id: 'review', members: [{ role: 'a', chatId: 'chat-1', outcome: 'completed' as const }] }]

describe('WorkflowLog (D29)', () => {
  it('pairs start and end lines, newest first, at most five, and marks a start without an end interrupted unless it is running', () => {
    const dir = tempDir('acp-resume-wflog-')
    const log = new WorkflowLog(dir)
    for (let i = 1; i <= 6; i += 1) {
      log.appendRunStart('s1', `run-${i}`, 't', i, i === 1 ? 'job-1' : undefined)
      log.appendRunEnd('s1', `run-${i}`, i + 100, i % 2 === 0 ? 'completed' : 'failed', STEPS, i % 2 === 0 ? undefined : 'step review: every role failed')
    }
    log.appendRunStart('s1', 'run-7', 't', 7)
    log.appendRunStart('s1', 'run-8', 't', 8)
    const recent = log.readRecent('s1', new Set(['run-8']))
    expect(recent.map(r => [r.runId, r.status])).toEqual([['run-7', 'interrupted'], ['run-6', 'completed'], ['run-5', 'failed'], ['run-4', 'completed'], ['run-3', 'failed']])
    expect(recent[1]).toEqual({ runId: 'run-6', template: 't', startedAt: 6, endedAt: 106, status: 'completed', steps: STEPS })
    expect(recent[2]?.error).toBe('step review: every role failed')
    expect(log.readRecent('s1', new Set(), 10).at(-1)).toMatchObject({ runId: 'run-1', jobId: 'job-1' })
    // Answer text and params are never written.
    expect(readFileSync(join(dir, 's1.jsonl'), 'utf8')).not.toMatch(/output|params/)
  })

  it('skips bad lines, survives a cut-off last line, returns the same array for an unchanged file, and isolates sessions', () => {
    const dir = tempDir('acp-resume-wflog-')
    const log = new WorkflowLog(dir)
    log.appendRunStart('s1', 'run-1', 't', 1)
    appendFileSync(join(dir, 's1.jsonl'), 'not json\n{"v":1,"kind":"run-end"')
    log.appendRunEnd('s1', 'run-1', 2, 'completed', [])
    const first = log.readRecent('s1')
    expect(first.map(r => r.status)).toEqual(['completed'])
    expect(log.readRecent('s2')).toEqual([])
    const lines = (log as unknown as { read(o: string): unknown[] })
    expect(lines.read('s1')).toBe(lines.read('s1'))
  })

  it(`trims to the newest ${RETAINED_RUNS} runs once the file holds more than ${TRIM_ABOVE_RUNS}`, () => {
    const dir = tempDir('acp-resume-wflog-')
    const log = new WorkflowLog(dir)
    for (let i = 1; i <= TRIM_ABOVE_RUNS + 1; i += 1) {
      log.appendRunStart('s1', `run-${i}`, 't', i)
      log.appendRunEnd('s1', `run-${i}`, i, 'completed', [])
    }
    const starts = readFileSync(join(dir, 's1.jsonl'), 'utf8').split('\n').filter(l => l.includes('run-start'))
    // Trimmed at run 101's start; its end was appended after.
    expect(starts).toHaveLength(RETAINED_RUNS)
    expect(log.readRecent('s1', new Set(), 100).at(-1)?.runId).toBe(`run-${TRIM_ABOVE_RUNS + 2 - RETAINED_RUNS}`)
    expect(log.readRecent('s1')[0]).toMatchObject({ runId: `run-${TRIM_ABOVE_RUNS + 1}`, status: 'completed' })
  })

  it('warns instead of throwing on an unsafe session id or a write failure', () => {
    const warnings: string[] = []
    const dir = tempDir('acp-resume-wflog-')
    const blocked = join(dir, 'blocked')
    writeFileSync(blocked, 'a file where the directory should be')
    new WorkflowLog(dir, (m) => { warnings.push(m) }).appendRunStart('../escape', 'r', 't', 1)
    new WorkflowLog(blocked, (m) => { warnings.push(m) }).appendRunStart('s1', 'r', 't', 1)
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toMatch(/is not a safe file name/)
    expect(warnings[1]).toMatch(/workflow log for s1 could not be written/)
  })
})

describe('pool workflow tracking (D29)', () => {
  function makePool(registryDir = tempDir('acp-resume-wfpool-')) {
    const pool = new AcpSessionPool({
      specBase: { command: process.execPath, args: [mockServer], permission: 'reject', env: { MOCK_ECHO_PROMPT: '1', MOCK_SESSION_STORE: join(registryDir, 's.json') }, disposeEofGraceMs: 500, disposeGraceMs: 500, spawn: nodeSpawn },
      registryPath: join(registryDir, 'registry.json'),
      idleTimeoutMs: 600_000,
    })
    pools.push(pool)
    return { pool, registryDir }
  }

  it('shows a run as running with its current step and members, then as recent once finished; it never leaks to another session', () => {
    const { pool } = makePool()
    const tracker = pool.trackWorkflow('s1', 'dual_review', 'job-7')
    tracker.observer.stepStart?.('independent')
    const a = tracker.observer.memberStart?.('A', 'independent') as number
    tracker.observer.memberStart?.('B', 'independent')
    tracker.observer.memberEnd?.(a, 'completed', 'chat-a')
    const { running, recent } = pool.listWorkflows('s1')
    expect(recent).toEqual([])
    expect(running).toEqual([{
      runId: tracker.runId, template: 'dual_review', startedAt: expect.any(Number), jobId: 'job-7', currentStep: 'independent',
      steps: [{ id: 'independent', members: [{ role: 'A', chatId: 'chat-a', outcome: 'completed' }, { role: 'B' }] }],
    }])
    expect(pool.listWorkflows('s2')).toEqual({ running: [], recent: [] })
    tracker.finish({ template: 'dual_review', status: 'failed', error: 'step independent: every role failed', steps: [] })
    tracker.finish({ template: 'dual_review', status: 'completed', steps: [] })
    const after = pool.listWorkflows('s1')
    expect(after.running).toEqual([])
    expect(after.recent).toEqual([expect.objectContaining({ runId: tracker.runId, status: 'failed', error: 'step independent: every role failed', jobId: 'job-7' })])
  })

  it('reads an unfinished run as interrupted after a pool restart', () => {
    const { pool, registryDir } = makePool()
    const tracker = pool.trackWorkflow('s1', 't')
    const { pool: again } = makePool(registryDir)
    expect(again.listWorkflows('s1').recent).toEqual([expect.objectContaining({ runId: tracker.runId, status: 'interrupted' })])
  })

  it('deletes the session\'s workflow log once its last chat is purged', async () => {
    const { pool, registryDir } = makePool()
    const one = await pool.start(process.cwd(), undefined, { ownerSessionId: 's1' })
    const two = await pool.start(process.cwd(), undefined, { ownerSessionId: 's1' })
    pool.trackWorkflow('s1', 't').finish({ template: 't', status: 'completed', steps: [] })
    const file = join(registryDir, 'workflows', 's1.jsonl')
    expect(existsSync(file)).toBe(true)
    await pool.remove(one.chatId)
    expect(existsSync(file)).toBe(true)
    await pool.remove(two.chatId)
    expect(existsSync(file)).toBe(false)
  })

  it('serves acpResume/workflows and shares the run id with the official progress records', async () => {
    const { pool } = makePool()
    const root = tempDir('acp-resume-wf-ws-')
    mkdirSync(join(root, '.agents'))
    writeFileSync(join(root, '.agents', 'acp-team.yml'), 'roles:\n  - name: a\n  - name: b\ntemplates:\n  - name: pair\n    steps:\n      - id: both\n        parallel: [a, b]\n        prompt: go\n')
    const records: { type: string; data: Record<string, unknown> }[] = []
    const session = { append: (type: string, data: unknown) => { records.push({ type, data: data as Record<string, unknown> }) } }
    const tool = chatWorkflowTool(pool, { workspaceDirFor: () => root })
    await tool.execute({ template: 'pair' }, { signal: new AbortController().signal, agent: { id: 's1', session } } as unknown as ToolRunContext)
    const panel = new AcpResumePanelService(new Context(), pool)
    const { running, recent } = panel.workflows('s1')
    expect(running).toEqual([])
    expect(recent).toHaveLength(1)
    expect(recent[0]).toMatchObject({ template: 'pair', status: 'completed', steps: [{ id: 'both', members: [{ role: 'a', outcome: 'completed' }, { role: 'b', outcome: 'completed' }] }] })
    const chatIds = recent[0]?.steps[0]?.members.map(m => m.chatId)
    expect(chatIds?.every(id => typeof id === 'string' && pool.knows(id))).toBe(true)
    expect(records.every(r => r.data['runId'] === recent[0]?.runId)).toBe(true)
    expect(records.length).toBeGreaterThan(0)
    expect(() => panel.workflows('')).toThrow('ownerSessionId must be a non-empty string')
  })
})
