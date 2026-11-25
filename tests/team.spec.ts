/**
 * D27 workspace teams: the `.agents/acp-team.yml` reader, per-session rosters,
 * role auto-provisioning through the pool (start, seeding turn, roster entry,
 * routing, release), and the chat tools' `role` parameter. Pool and tool
 * cases run real mock-acp-server subprocesses. Keyless; no model.
 *
 * @module dsh-acp-resume/tests/team.spec
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { AcpSessionPool, type RoleCallContext } from '../src/pool.ts'
import { Roster, type RosterTable } from '../src/roster.ts'
import { findTeamConfig, loadTeamConfig, parseTeamConfig } from '../src/team-config.ts'
import { registerChatTools, type ToolsRegistryFace } from '../src/tools.ts'
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

/** Write `.agents/acp-team.yml` under `root`. */
function writeTeam(root: string, text: string): void {
  mkdirSync(join(root, '.agents'), { recursive: true })
  writeFileSync(join(root, '.agents', 'acp-team.yml'), text)
}

const TEAM = `
roles:
  - name: reviewer
    seeding: 你是审阅者
  - name: scout
templates:
  - name: double-review
    description: two reviews, merged by the model
    params: [target]
    steps:
      - id: review
        parallel: [reviewer, { role: scout, prompt: "scan {target}" }]
        prompt: "review {target}"
      - id: merge
        merge: { mode: return_to_model }
`

function makePool(env: Record<string, string> = {}, registryPath?: string): { pool: AcpSessionPool; registryPath: string; warnings: string[] } {
  const path = registryPath ?? join(tempDir('acp-resume-team-reg-'), 'registry.json')
  const warnings: string[] = []
  const store = join(tempDir('acp-resume-team-store-'), 's.json')
  const pool = new AcpSessionPool({
    specBase: { command: process.execPath, args: [mockServer], permission: 'reject', env: { MOCK_REMEMBER: '1', MOCK_SESSION_STORE: store, ...env }, disposeEofGraceMs: 500, disposeGraceMs: 500, spawn: nodeSpawn },
    registryPath: path,
    idleTimeoutMs: 600_000,
    onWarn: (m) => { warnings.push(m) },
  })
  pools.push(pool)
  return { pool, registryPath: path, warnings }
}

function workspace(team = TEAM): string {
  const root = tempDir('acp-resume-team-ws-')
  writeTeam(root, team)
  return root
}

describe('team config (D27)', () => {
  it('parses roles and templates, resolving role cwd against the workspace root', () => {
    const config = parseTeamConfig(`${TEAM}\n`.replace('  - name: scout', '  - name: scout\n    cwd: sub\n    backend: review'), '/ws')
    expect(config.roles).toEqual([{ name: 'reviewer', cwd: '/ws', seeding: '你是审阅者' }, { name: 'scout', cwd: '/ws/sub', backend: 'review' }])
    expect(config.templates[0]).toMatchObject({
      name: 'double-review',
      params: ['target'],
      steps: [
        { id: 'review', parallel: [{ role: 'reviewer' }, { role: 'scout', prompt: 'scan {target}' }], prompt: 'review {target}' },
        { id: 'merge', merge: { mode: 'return_to_model' } },
      ],
    })
  })

  it('reads an optional one-line summary per role (D32): blank means unset, inner whitespace collapses', () => {
    const roles = parseTeamConfig('roles:\n  - name: a\n    summary: Reviews diffs for bugs.\n  - name: b\n    summary: "   "\n  - name: c\n  - name: d\n    summary: |\n      Two\n      lines\n', '/ws').roles
    expect(roles.map(r => r.summary)).toEqual(['Reviews diffs for bugs.', undefined, undefined, 'Two lines'])
    expect(roles[1]).not.toHaveProperty('summary')
    // The strict field check still holds next to the new field.
    expect(() => parseTeamConfig('roles:\n  - name: a\n    sumary: typo\n', '/ws')).toThrow('roles[0] has unknown field sumary; allowed: name, backend, cwd, summary, seeding')
    expect(() => parseTeamConfig('roles:\n  - name: a\n    summary: 3\n', '/ws')).toThrow('roles[0].summary must be a string')
  })

  it('accepts role names in any script, such as Chinese, and still rejects other characters', () => {
    const config = parseTeamConfig('roles:\n  - name: 调研员\n  - name: 审核员-2\ntemplates:\n  - name: t\n    steps:\n      - id: s\n        parallel: [调研员, 审核员-2]\n', '/ws')
    expect(config.roles.map(r => r.name)).toEqual(['调研员', '审核员-2'])
    expect(config.templates[0]?.steps[0]).toMatchObject({ parallel: [{ role: '调研员' }, { role: '审核员-2' }] })
    expect(() => parseTeamConfig('roles:\n  - name: 调研 员', '/ws')).toThrow('roles[0].name must be 1–32 letters, digits, _ or - (any script)')
    expect(() => parseTeamConfig(`roles:\n  - name: ${'调'.repeat(33)}`, '/ws')).toThrow('roles[0].name must be')
  })

  it('rejects unknown fields at every level, naming the field and the allowed ones', () => {
    expect(() => parseTeamConfig('roles:\n  - name: a\n    seed: hi\n', '/ws')).toThrow('roles[0] has unknown field seed; allowed: name, backend, cwd, summary, seeding')
    expect(() => parseTeamConfig('role:\n  - name: a\n', '/ws')).toThrow('file has unknown field role; allowed: version, roles, templates')
    expect(() => parseTeamConfig('roles:\n  - name: a\ntemplates:\n  - name: t\n    steps:\n      - id: s\n        parallel: [{ role: a, promt: x }]\n', '/ws')).toThrow('templates[0].steps[0].parallel[0] has unknown field promt')
    expect(() => parseTeamConfig('roles:\n  - name: a\ntemplates:\n  - name: t\n    steps:\n      - id: s\n        merge: { mode: role, role: a, extra: 1 }\n', '/ws')).toThrow('templates[0].steps[0].merge has unknown field extra')
    expect(() => parseTeamConfig('version: 2\n', '/ws')).toThrow('version must be 1 when given')
    expect(parseTeamConfig('version: 1\nroles:\n  - name: a\n', '/ws').roles).toHaveLength(1)
  })

  it('rejects a step that has both merge and parallel, or a step-level prompt on a merge', () => {
    const base = 'roles:\n  - name: a\ntemplates:\n  - name: t\n    steps:\n      - id: s\n'
    expect(() => parseTeamConfig(`${base}        parallel: [a]\n        merge: { mode: return_to_model }\n`, '/ws')).toThrow('templates[0].steps[0] has both merge and parallel; a step is one or the other')
    expect(() => parseTeamConfig(`${base}        prompt: x\n        merge: { mode: return_to_model }\n`, '/ws')).toThrow('templates[0].steps[0] is a merge step; put its instruction in merge.prompt')
  })

  it('finds the file at most three levels up and treats a missing one as no configuration, silently', () => {
    const root = workspace()
    mkdirSync(join(root, 'a', 'b', 'c'), { recursive: true })
    expect(findTeamConfig(join(root, 'a', 'b'))).toBe(join(root, '.agents', 'acp-team.yml'))
    expect(findTeamConfig(join(root, 'a', 'b', 'c'))).toBeUndefined()
    const warnings: string[] = []
    expect(loadTeamConfig(tempDir('acp-resume-team-none-'), (m) => { warnings.push(m) })).toBeUndefined()
    expect(warnings).toEqual([])
  })

  it('warns and degrades to no configuration on broken YAML or a bad reference', () => {
    for (const text of ['roles: [unclosed', 'roles:\n  - name: a\ntemplates:\n  - name: t\n    steps:\n      - id: s\n        parallel: [ghost]', 'roles:\n  - name: a\n  - name: a']) {
      const warnings: string[] = []
      expect(loadTeamConfig(workspace(text), (m) => { warnings.push(m) })).toBeUndefined()
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toMatch(/not usable/)
    }
    expect(() => parseTeamConfig('roles:\n  - name: a\ntemplates:\n  - name: t\n    steps:\n      - id: s\n        parallel: [ghost]', '/ws')).toThrow('names unknown role ghost')
  })
})

describe('Roster (D27)', () => {
  function memoryRoster(initial: unknown = undefined): { roster: Roster; table: () => RosterTable } {
    let stored: unknown = initial
    return { roster: new Roster({ readRosters: () => stored, writeRosters: (next) => { stored = next } }), table: () => stored as RosterTable }
  }

  it('registers, resolves, replaces, and removes per owner session, isolated between sessions', () => {
    const { roster, table } = memoryRoster()
    roster.register('reviewer', 'chat-1', 'default', 's1')
    roster.register('scout', 'chat-2', 'codex', 's1')
    roster.register('reviewer', 'chat-9', 'default', 's2')
    expect(roster.resolve('reviewer', 's1')?.chatId).toBe('chat-1')
    expect(roster.resolve('reviewer', 's2')?.chatId).toBe('chat-9')
    expect(roster.resolve('scout', 's2')).toBeUndefined()
    roster.register('reviewer', 'chat-3', 'default', 's1')
    expect(roster.list('s1').map(e => [e.role, e.chatId])).toEqual([['scout', 'chat-2'], ['reviewer', 'chat-3']])
    expect(roster.remove('scout', 's1')).toBe(true)
    expect(roster.remove('scout', 's1')).toBe(false)
    expect(roster.roleOf('chat-9')).toBe('reviewer')
    expect(roster.roleOf('chat-9', 's1')).toBeUndefined()
    roster.removeChat('chat-9')
    expect(table()).toEqual({ s1: { entries: [{ role: 'reviewer', chatId: 'chat-3', backend: 'default' }] } })
  })

  it('reads a malformed section as empty and drops malformed entries', () => {
    expect(memoryRoster('nope').roster.list('s1')).toEqual([])
    expect(memoryRoster({ s1: { entries: [{ role: 'r', chatId: 'c', backend: 'default' }, { role: 1 }] }, s2: 'x' }).roster.list('s1')).toEqual([{ role: 'r', chatId: 'c', backend: 'default' }])
  })
})

describe('AcpSessionPool roles (D27)', () => {
  const ctx = (workspaceDir: string, ownerSessionId = 'session-a'): RoleCallContext => ({ ownerSessionId, workspaceDir })

  it('provisions a role on first reference (start, seeding turn, roster entry), then routes later references to the same chat', async () => {
    const root = workspace()
    const { pool, registryPath } = makePool()
    const first = await pool.sendByRole('reviewer', '第一问', ctx(root))
    // MOCK_REMEMBER echoes the previous prompt: the seeding turn ran before the message.
    expect(first).toMatchObject({ role: 'reviewer', provisioned: true, stopReason: 'completed', output: 'remember:你是审阅者' })
    expect(pool.chatInfo(first.chatId)).toMatchObject({ label: 'reviewer', ownerSessionId: 'session-a', cwd: root, turnCount: 2 })
    const second = await pool.sendByRole('reviewer', '第二问', ctx(root))
    expect(second).toMatchObject({ chatId: first.chatId, provisioned: false, output: 'remember:第一问' })
    expect(pool.listChats()).toHaveLength(1)
    const file = JSON.parse(readFileSync(registryPath, 'utf8')) as { rosters: RosterTable }
    expect(file.rosters).toEqual({ 'session-a': { entries: [{ role: 'reviewer', chatId: first.chatId, backend: 'default' }] } })
  })

  it('keeps rosters per session and across a pool restart, reconnecting a released role through session/load', async () => {
    const root = workspace()
    const { pool, registryPath } = makePool()
    const a = await pool.sendByRole('scout', '记住暗号T', ctx(root, 'session-a'))
    const b = await pool.sendByRole('scout', 'hi', ctx(root, 'session-b'))
    expect(b.chatId).not.toBe(a.chatId)
    expect(pool.listRoster('session-a').map(e => e.chatId)).toEqual([a.chatId])
    await pool.disposeAll()
    const store = JSON.parse(readFileSync(registryPath, 'utf8')) as unknown
    expect(store).toHaveProperty('rosters')
    const env = pool as unknown as { opts: { specBase: { env: Record<string, string> } } }
    const { pool: again } = makePool(env.opts.specBase.env, registryPath)
    const back = await again.sendByRole('scout', '暗号是什么', ctx(root, 'session-a'))
    expect(back).toMatchObject({ chatId: a.chatId, provisioned: false, freshSession: false, output: 'remember:记住暗号T' })
  })

  it('does not rebuild a role when the blueprint changes; releasing the role makes the next reference use the new blueprint', async () => {
    const root = workspace()
    const { pool } = makePool()
    const first = await pool.sendByRole('reviewer', 'q1', ctx(root))
    writeTeam(root, TEAM.replace('你是审阅者', '你是新审阅者'))
    expect((await pool.sendByRole('reviewer', 'q2', ctx(root))).chatId).toBe(first.chatId)
    expect(await pool.releaseRole('reviewer', 'session-a', false)).toBe(first.chatId)
    // The released chat's record survives (purge false); only the binding is gone.
    expect(pool.knows(first.chatId)).toBe(true)
    const rebuilt = await pool.sendByRole('reviewer', 'q3', ctx(root))
    expect(rebuilt).toMatchObject({ provisioned: true, output: 'remember:你是新审阅者' })
    expect(rebuilt.chatId).not.toBe(first.chatId)
  })

  it('unbinds before releasing: a send for the role during the release gets a new chat, never the released one', async () => {
    const root = workspace()
    const { pool } = makePool()
    const first = await pool.sendByRole('scout', 'p1', ctx(root))
    const releasing = pool.releaseRole('scout', 'session-a', false)
    const during = pool.sendByRole('scout', 'p2', ctx(root))
    await releasing
    const second = await during
    expect(second).toMatchObject({ provisioned: true })
    expect(second.chatId).not.toBe(first.chatId)
    expect(pool.chatInfo(first.chatId)?.active).toBe(false)
    expect(pool.listRoster('session-a').map(e => e.chatId)).toEqual([second.chatId])
  })

  it('purging a role chat drops its roster entry', async () => {
    const root = workspace()
    const { pool } = makePool()
    const sent = await pool.sendByRole('scout', 'p', ctx(root))
    await pool.remove(sent.chatId)
    expect(pool.listRoster('session-a')).toEqual([])
    expect(pool.resolveRole('scout', 'session-a')).toBeUndefined()
  })

  it('discards a half-built role when its seeding turn fails, and refuses undefined roles and concurrent provisioning', async () => {
    const root = workspace()
    const crash = join(root, 'crash')
    const { pool } = makePool({ MOCK_CRASH_ON_PROMPT_FILE: crash })
    writeFileSync(crash, 'on')
    await expect(pool.sendByRole('reviewer', 'p', ctx(root))).rejects.toThrow(/role reviewer could not be provisioned: its seeding turn ended error/)
    expect(pool.listChats()).toEqual([])
    expect(pool.listRoster('session-a')).toEqual([])
    rmSync(crash)
    expect(() => { pool.assertRoleSendable('ghost', ctx(root)) }).toThrow(/unknown role ghost; roles defined in .*: reviewer, scout/)
    expect(() => { pool.assertRoleSendable('reviewer', ctx(tempDir('acp-resume-team-empty-'))) }).toThrow(/unknown role reviewer: no workspace team config \(\.agents\/acp-team\.yml\) found from /)
    const running = pool.sendByRole('reviewer', 'p', ctx(root))
    await expect(pool.sendByRole('reviewer', 'p2', ctx(root))).rejects.toThrow(/role reviewer is still being set up/)
    expect(() => { pool.assertRoleSendable('reviewer', ctx(root)) }).toThrow(/still being set up/)
    await expect(running).resolves.toMatchObject({ provisioned: true })
    expect(pool.listChats()).toHaveLength(1)
  })
})

describe('chat tools with roles (D27)', () => {
  type Definition = Parameters<ToolsRegistryFace['register']>[0]

  function mount(root: string, withRoles = true) {
    const tools = new Map<string, Definition>()
    const { pool } = makePool()
    const fakeCtx = { effect: (fn: () => () => void) => { fn() } }
    registerChatTools(fakeCtx as unknown as Context, { register: (d) => { tools.set(d.name, d); return () => {} } }, pool, 'acp_chat_', undefined,
      withRoles ? { workspaceDirFor: () => root } : undefined)
    /** `agentId: null` makes a headless call (no calling session). */
    const call = async (name: string, args: Record<string, unknown>, agentId: string | null = 'session-a'): Promise<{ text: string }> =>
      await (tools.get(`acp_chat_${name}`) as Definition).execute(args, { signal: new AbortController().signal, ...(agentId === null ? {} : { agent: { id: agentId } }) } as unknown as ToolRunContext) as { text: string }
    return { tools, pool, call }
  }

  it('sends by role, lists the role column, and closes by role', async () => {
    const root = workspace()
    const { pool, call } = mount(root)
    expect((await call('send', { role: 'reviewer', message: 'hi' })).text).toBe('remember:你是审阅者')
    const chatId = pool.resolveRole('reviewer', 'session-a') as string
    expect((await call('list', {})).text).toMatch(new RegExp(`^role reviewer \\| ${chatId} \\| label "reviewer" \\| backend default \\| `))
    expect((await call('close', { role: 'reviewer' })).text).toBe(`role reviewer released (chat ${chatId}) and unbound; its next reference sets up a new chat from the workspace blueprint`)
    expect((await call('list', {})).text).toMatch(new RegExp(`^${chatId} \\| `))
  })

  it('tells the model what is wrong with an invalid team file instead of implying there is none', async () => {
    const root = workspace('roles:\n  - name: reviewer\ntemplates:\n  - name: t\n    steps:\n      - id: s\n        parallel: [ghost]\n')
    const { call } = mount(root)
    await expect(call('send', { role: 'reviewer', message: 'm' })).rejects.toThrow(/cannot resolve role reviewer: workspace team config .*acp-team\.yml is invalid: templates\[0\]\.steps\[0\]\.parallel\[0\] names unknown role ghost/)
    expect((await call('list', {})).text).toMatch(/^no persistent chats\nworkspace config error: .*acp-team\.yml: templates\[0\]\.steps\[0\]\.parallel\[0\] names unknown role ghost$/)
  })

  it('ends the list with the workspace roles and templates, and adds nothing without a team file', async () => {
    const { call } = mount(workspace())
    expect((await call('list', {})).text).toBe('no persistent chats\nworkspace roles: reviewer, scout; templates: double-review(target)')
    const bare = mount(tempDir('acp-resume-team-bare-'))
    expect((await bare.call('list', {})).text).toBe('no persistent chats')
    expect((await mount(workspace(), false).call('list', {})).text).toBe('no persistent chats')
  })

  it('takes exactly one of chatId and role, and role only with a calling session', async () => {
    const { call } = mount(workspace())
    await expect(call('send', { chatId: 'chat-x', role: 'reviewer', message: 'm' })).rejects.toThrow('pass either chatId or role, not both')
    await expect(call('send', { message: 'm' })).rejects.toThrow('pass chatId or role')
    await expect(call('send', { role: 'reviewer', message: 'm' }, null)).rejects.toThrow(/role needs a calling DSH session/)
    await expect(call('close', { role: 'reviewer' })).rejects.toThrow(/role reviewer has no chat in this session/)
  })

  it('keeps the pre-D27 send and close schemas when the workflow feature is off', () => {
    const on = mount(workspace()).tools
    const off = mount(workspace(), false).tools
    type Schema = { properties: Record<string, unknown>; required: string[] }
    for (const name of ['acp_chat_send', 'acp_chat_close']) {
      const withRoles = on.get(name)?.parameters as Schema
      expect(withRoles.properties).toHaveProperty('role')
      expect(withRoles.required ?? []).not.toContain('chatId')
      const without = off.get(name)?.parameters as Schema
      expect(without.properties).not.toHaveProperty('role')
      expect(without.required).toContain('chatId')
      expect(off.get(name)?.description).not.toMatch(/\brole\b/)
    }
    expect(off.get('acp_chat_list')?.description).not.toMatch(/\brole\b/)
  })
})
