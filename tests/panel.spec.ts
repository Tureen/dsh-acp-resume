/**
 * Side-panel Remote service tests (D15, PANEL-DESIGN §3.6.1). The service
 * class is instantiated directly under cordis and its methods are called the
 * way the Gateway's source mode would (no real Gateway): over a REAL pool and
 * mock-server subprocesses, as in pool.spec. Covers the method-to-pool
 * mapping (list state with title/turnCount, close keeps the record, purge
 * drops it), the detail reads `turns` and `turn` (D18: previews with
 * more-flags, the limit, full text, events, unknown chat/turn, bad arguments), unknown and malformed chatIds, the Remote markers the Gateway
 * discovers, and the `apply` wiring lifetime. Keyless; no model.
 *
 * @module dsh-acp-resume/tests/panel.spec
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as acp from '../src/index.ts'
import { AcpResumePanelService, PANEL_SERVICE_KEY } from '../src/panel.ts'
import { AcpSessionPool } from '../src/pool.ts'
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

function makePool(env: Record<string, string> = {}): { pool: AcpSessionPool; registryPath: string } {
  const registryPath = join(tempDir('acp-resume-panel-'), 'registry.json')
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
    registryPath,
    idleTimeoutMs: 600_000,
  })
  pools.push(pool)
  return { pool, registryPath }
}

/** Mount the service under a bare cordis root and return it as the Gateway would resolve it. */
async function mountPanel(pool: AcpSessionPool): Promise<{ ctx: Context; panel: AcpResumePanelService }> {
  const ctx = new Context()
  const fiber = await ctx.plugin({ name: 'panel-under-test', apply: (c: Context) => { new AcpResumePanelService(c, pool) } })
  cleanups.push(() => fiber.dispose())
  return { ctx, panel: ctx.get(PANEL_SERVICE_KEY) as unknown as AcpResumePanelService }
}

function registryChatIds(registryPath: string): string[] {
  const file = JSON.parse(readFileSync(registryPath, 'utf8')) as { sessions: { chatId: string }[] }
  return file.sessions.map(s => s.chatId)
}

/** The rejection's Remote code (Gateway discrimination is by `code`, never instanceof). */
async function rejectionCode(promise: Promise<unknown>): Promise<string | undefined> {
  const error = await promise.then(() => undefined, (e: unknown) => e)
  expect(error).toBeInstanceOf(Error)
  return (error as { code?: string }).code
}

describe('AcpResumePanelService', () => {
  it('registers under acpResume with the five Remote markers the Gateway discovers', async () => {
    const { pool } = makePool()
    const { panel } = await mountPanel(pool)
    expect(panel.typertRemote.namespace).toBe('acpResume')
    expect(remoteMethods(panel).map(m => m.exportName ?? m.method).sort()).toEqual(['close', 'list', 'purge', 'turn', 'turns'])
  })

  it('list reflects started chats, then title and turnCount after a completed turn', async () => {
    const { pool } = makePool({ MOCK_REMEMBER: '1' })
    const { panel } = await mountPanel(pool)
    expect(panel.list()).toEqual([])
    const chat = await pool.start(process.cwd(), undefined, { label: '审阅' })
    const [fresh] = panel.list()
    expect(fresh).toMatchObject({ chatId: chat.chatId, remoteSessionId: chat.remoteSessionId, label: '审阅', active: true })
    expect(fresh).not.toHaveProperty('title')
    expect(fresh).not.toHaveProperty('turnCount')
    await pool.send(chat.chatId, '记住暗号P')
    await pool.send(chat.chatId, '暗号是什么')
    expect(panel.list()).toEqual(pool.listChats())
    expect(panel.list()[0]).toMatchObject({ title: '记住暗号P', turnCount: 2, active: true })
  })

  it('close releases the process and keeps the record; the next send reconnects', async () => {
    const { pool, registryPath } = makePool()
    const { panel } = await mountPanel(pool)
    const chat = await pool.start(process.cwd())
    await expect(panel.close(chat.chatId)).resolves.toBeNull()
    expect(panel.list()).toHaveLength(1)
    expect(panel.list()[0]).toMatchObject({ chatId: chat.chatId, active: false })
    expect(registryChatIds(registryPath)).toEqual([chat.chatId])
    // Closing an already released chat is a no-op, not an error.
    await expect(panel.close(chat.chatId)).resolves.toBeNull()
    const again = await pool.send(chat.chatId, 'p')
    expect(again.stopReason).toBe('completed')
    expect(panel.list()[0]?.active).toBe(true)
  })

  it('purge releases the process and deletes the record; the chat is gone from list', async () => {
    const { pool, registryPath } = makePool()
    const { panel } = await mountPanel(pool)
    const kept = await pool.start(process.cwd())
    const dropped = await pool.start(process.cwd())
    await expect(panel.purge(dropped.chatId)).resolves.toBeNull()
    expect(panel.list().map(c => c.chatId)).toEqual([kept.chatId])
    expect(registryChatIds(registryPath)).toEqual([kept.chatId])
    expect(pool.knows(dropped.chatId)).toBe(false)
    await expect(pool.send(dropped.chatId, 'p')).rejects.toThrow(/unknown chat/)
  })

  it('rejects an unknown chatId with acp-resume/unknown-chat and leaves the pool untouched', async () => {
    const { pool, registryPath } = makePool()
    const { panel } = await mountPanel(pool)
    const chat = await pool.start(process.cwd())
    expect(await rejectionCode(panel.close('chat-nope'))).toBe('acp-resume/unknown-chat')
    expect(await rejectionCode(panel.purge('chat-nope'))).toBe('acp-resume/unknown-chat')
    // A purged chat is unknown from then on.
    await panel.purge(chat.chatId)
    expect(await rejectionCode(panel.purge(chat.chatId))).toBe('acp-resume/unknown-chat')
    expect(await rejectionCode(panel.close(chat.chatId))).toBe('acp-resume/unknown-chat')
    expect(registryChatIds(registryPath)).toEqual([])
  })

  it('rejects a missing or malformed chatId itself (source mode passes a missing field as undefined)', async () => {
    const { pool } = makePool()
    const { panel } = await mountPanel(pool)
    const chat = await pool.start(process.cwd())
    const invoke = panel as unknown as Record<'close' | 'purge', (chatId: unknown) => Promise<null>>
    for (const bad of [undefined, '', 3, null, { chatId: chat.chatId }]) {
      expect(await rejectionCode(invoke.close(bad))).toBe('gateway/bad-request')
      expect(await rejectionCode(invoke.purge(bad))).toBe('gateway/bad-request')
    }
    expect(panel.list()).toHaveLength(1)
    expect(panel.list()[0]?.active).toBe(true)
  })
})

/** Source-mode invocation of the detail reads with arbitrary (possibly malformed) arguments. */
type DetailInvoke = Record<'turns' | 'turn', (...args: unknown[]) => unknown>

describe('AcpResumePanelService detail reads (D18)', () => {
  it('turns returns the chat row, the entries oldest first as previews, and the retained total', async () => {
    const { pool } = makePool({ MOCK_REMEMBER: '1' })
    const { panel } = await mountPanel(pool)
    const chat = await pool.start(process.cwd(), undefined, { label: '审阅' })
    expect(panel.turns(chat.chatId, 50)).toEqual({ chat: pool.listChats()[0], entries: [], total: 0 })
    await pool.send(chat.chatId, '记住暗号M')
    await pool.send(chat.chatId, '暗号是什么')
    const answer = panel.turns(chat.chatId, 50)
    expect(answer.total).toBe(2)
    expect(answer.chat).toMatchObject({ chatId: chat.chatId, label: '审阅', turnCount: 2, title: '记住暗号M', active: true })
    expect(answer.entries).toMatchObject([
      { seq: 1, kind: 'turn', message: '记住暗号M', messageMore: false, outputMore: false, stopReason: 'completed', freshSession: false },
      { seq: 2, kind: 'turn', message: '暗号是什么', output: 'remember:记住暗号M' },
    ])
    expect(answer.entries[0]).not.toHaveProperty('diagnostic')
  })

  it('turns defaults to 50 entries and honors limit by returning the newest ones', async () => {
    const { pool } = makePool()
    const { panel } = await mountPanel(pool)
    const chat = await pool.start(process.cwd())
    for (let i = 1; i <= 3; i += 1) await pool.send(chat.chatId, `m${i}`)
    const invoke = panel as unknown as DetailInvoke
    expect((invoke.turns(chat.chatId, undefined) as { entries: unknown[] }).entries).toHaveLength(3)
    const newest = panel.turns(chat.chatId, 2)
    expect(newest.entries.map(e => e.seq)).toEqual([2, 3])
    expect(newest.total).toBe(3)
  })

  it('cuts previews to 120 characters and flags that the full text is longer; turn returns it whole', async () => {
    const long = '长'.repeat(300)
    const { pool } = makePool({ MOCK_TEXT: long })
    const { panel } = await mountPanel(pool)
    const chat = await pool.start(process.cwd())
    await pool.send(chat.chatId, `问${'题'.repeat(299)}`)
    const [entry] = panel.turns(chat.chatId, 50).entries
    expect(entry).toMatchObject({ messageMore: true, outputMore: true })
    expect(Array.from((entry as { message: string }).message)).toHaveLength(120)
    expect(Array.from((entry as { output: string }).output)).toHaveLength(120)
    expect(panel.turn(chat.chatId, 1)).toMatchObject({ seq: 1, kind: 'turn', message: `问${'题'.repeat(299)}`, output: long })
  })

  it('carries a failed turn with its diagnostic', async () => {
    const { pool } = makePool({ MOCK_CRASH_PROMPTS: '1' })
    const { panel } = await mountPanel(pool)
    const chat = await pool.start(process.cwd())
    await pool.send(chat.chatId, 'crash')
    const [failed] = panel.turns(chat.chatId, 50).entries
    expect(failed).toMatchObject({ kind: 'turn', stopReason: 'error' })
    expect((failed as { diagnostic?: string }).diagnostic).toMatch(/process-exit/)
  })

  it('shows a reconnect event as an event entry', async () => {
    const dir = tempDir('acp-resume-panel-event-')
    const registryPath = join(dir, 'registry.json')
    writeFileSync(registryPath, JSON.stringify({
      version: 1,
      sessions: [{ chatId: 'chat-other', remoteSessionId: 'remote-x', cwd: process.cwd(), command: '/opt/other-agent', args: ['acp'], lastActive: 1 }],
    }))
    const pool = new AcpSessionPool({
      specBase: { command: process.execPath, args: [mockServer], permission: 'reject', env: {}, disposeEofGraceMs: 500, disposeGraceMs: 500, spawn: nodeSpawn },
      registryPath, idleTimeoutMs: 600_000,
    })
    pools.push(pool)
    const { panel } = await mountPanel(pool)
    await pool.send('chat-other', 'hello').catch(() => undefined)
    const [event] = panel.turns('chat-other', 50).entries
    expect(event).toMatchObject({ seq: 1, kind: 'event', event: 'reconnect-failed', message: 'hello' })
    expect(panel.turn('chat-other', 1)).toMatchObject({ kind: 'event', event: 'reconnect-failed' })
  })

  it('rejects an unknown chat with acp-resume/unknown-chat, also after a purge removed the log', async () => {
    const { pool } = makePool()
    const { panel } = await mountPanel(pool)
    const invoke = panel as unknown as DetailInvoke
    expect(await rejectionCode(Promise.resolve().then(() => invoke.turns('chat-nope', 5)))).toBe('acp-resume/unknown-chat')
    expect(await rejectionCode(Promise.resolve().then(() => invoke.turn('chat-nope', 1)))).toBe('acp-resume/unknown-chat')
    const chat = await pool.start(process.cwd())
    await pool.send(chat.chatId, 'x')
    await panel.purge(chat.chatId)
    expect(await rejectionCode(Promise.resolve().then(() => invoke.turns(chat.chatId, 5)))).toBe('acp-resume/unknown-chat')
    expect(await rejectionCode(Promise.resolve().then(() => invoke.turn(chat.chatId, 1)))).toBe('acp-resume/unknown-chat')
  })

  it('rejects an entry the log does not hold with acp-resume/unknown-turn', async () => {
    const { pool } = makePool()
    const { panel } = await mountPanel(pool)
    const chat = await pool.start(process.cwd())
    await pool.send(chat.chatId, 'x')
    const invoke = panel as unknown as DetailInvoke
    for (const seq of [2, 0, -1, 999]) {
      expect(await rejectionCode(Promise.resolve().then(() => invoke.turn(chat.chatId, seq)))).toBe('acp-resume/unknown-turn')
    }
  })

  it('validates its own arguments (source mode passes missing fields as undefined)', async () => {
    const { pool } = makePool()
    const { panel } = await mountPanel(pool)
    const chat = await pool.start(process.cwd())
    const invoke = panel as unknown as DetailInvoke
    for (const bad of [undefined, '', 3, null, {}]) {
      expect(await rejectionCode(Promise.resolve().then(() => invoke.turns(bad, 5)))).toBe('gateway/bad-request')
      expect(await rejectionCode(Promise.resolve().then(() => invoke.turn(bad, 1)))).toBe('gateway/bad-request')
    }
    for (const limit of [0, -1, 1.5, '5', null, 201, Number.NaN, Infinity]) {
      expect(await rejectionCode(Promise.resolve().then(() => invoke.turns(chat.chatId, limit)))).toBe('gateway/bad-request')
    }
    for (const seq of [undefined, '1', null, 1.5, Number.NaN]) {
      expect(await rejectionCode(Promise.resolve().then(() => invoke.turn(chat.chatId, seq)))).toBe('gateway/bad-request')
    }
  })
})

/** Stub `tools` service: `register` returns an unregister function. */
class StubTools extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tools')
  }

  register(): () => void {
    return () => {}
  }
}

async function host(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  return ctx
}

async function until(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 10))
  }
}

describe('apply (panel wiring)', () => {
  it('registers the panel service with the tools and withdraws it with the tools service and the plugin', async () => {
    const ctx = await host()
    const registryPath = join(tempDir('acp-resume-panel-apply-'), 'registry.json')
    const fiber = await ctx.plugin(acp, { command: process.execPath, args: [mockServer], registryPath })
    cleanups.push(() => fiber.dispose())
    // No tools service yet: no pool, no panel.
    await new Promise(r => setTimeout(r, 50))
    expect(ctx.get(PANEL_SERVICE_KEY)).toBeUndefined()

    const tools = await ctx.plugin(StubTools)
    await until(() => ctx.get(PANEL_SERVICE_KEY) !== undefined, 'panel registration')
    const panel = ctx.get(PANEL_SERVICE_KEY) as unknown as AcpResumePanelService
    expect(panel.list()).toEqual([])

    await tools.dispose()
    await until(() => ctx.get(PANEL_SERVICE_KEY) === undefined, 'panel withdrawal with the tools service')
    // A returning tools service brings the panel back over the same pool.
    await ctx.plugin(StubTools)
    await until(() => ctx.get(PANEL_SERVICE_KEY) !== undefined, 'panel re-registration')

    await fiber.dispose()
    expect(ctx.get(PANEL_SERVICE_KEY)).toBeUndefined()
  })

  it('registers no panel service when enableChatTools is false', async () => {
    const ctx = await host()
    await ctx.plugin(StubTools)
    const registryPath = join(tempDir('acp-resume-panel-apply-'), 'registry.json')
    const fiber = await ctx.plugin(acp, { command: process.execPath, args: [mockServer], registryPath, enableChatTools: false })
    cleanups.push(() => fiber.dispose())
    await new Promise(r => setTimeout(r, 50))
    expect(ctx.get(PANEL_SERVICE_KEY)).toBeUndefined()
    expect(existsSync(registryPath)).toBe(false)
  })
})
