/**
 * Model-tool and plugin-wiring tests. The tool cases drive the five chat
 * tools' `execute` bodies over a REAL pool and mock-server subprocesses
 * (error mapping, fresh-session note, unknown-chat wording, concurrency
 * flags). The `apply` cases mount the plugin under cordis with a stub
 * `tools` service and assert registration, prefixing, opt-out, provider
 * default name, and teardown (tools revoked, chat processes released).
 * Keyless; no model.
 *
 * @module dsh-acp-resume/tests/tools.spec
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import * as acp from '../src/index.ts'
import { AcpSessionPool } from '../src/pool.ts'
import { chatStaticTools, registerChatTools, type ToolsRegistryFace } from '../src/tools.ts'
import { COMMAND_NOT_FOUND_GUIDANCE } from '../src/command-not-found.ts'
import { startExternalActivation } from './helpers/external-activation-helpers.ts'
import { nodeSpawn } from './helpers/node-spawn.ts'
import { mountWorkingDirectoryFixture } from './helpers/working-directory-fixture.ts'

const mockServer = fileURLToPath(new URL('./mock-acp-server.ts', import.meta.url))
const codexMock = fileURLToPath(new URL('./mock-codex-server.ts', import.meta.url))

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

/** Collecting tools registry: `register` returns an unregister function. */
function collectingRegistry(): ToolsRegistryFace & { readonly tools: Map<string, Definition> } {
  const tools = new Map<string, Definition>()
  return {
    tools,
    register(definition) {
      tools.set(definition.name, definition)
      return () => { tools.delete(definition.name) }
    },
  }
}

function exec(signal: AbortSignal = new AbortController().signal): ToolRunContext {
  return { signal } as unknown as ToolRunContext
}

/** Register the five tools over a real pool with a fake host context. */
function mountTools(env: Record<string, string>, toolPrefix = 'acp_chat_') {
  const registry = collectingRegistry()
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
    registryPath: join(tempDir('acp-resume-tools-'), 'registry.json'),
    idleTimeoutMs: 600_000,
  })
  pools.push(pool)
  const disposers: (() => void)[] = []
  const fakeCtx = { effect: (fn: () => () => void) => { disposers.push(fn()) } }
  registerChatTools(fakeCtx as unknown as Context, registry, pool, toolPrefix)
  const call = async (name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> => {
    const definition = registry.tools.get(`${toolPrefix}${name}`)
    if (definition === undefined) throw new Error(`tool ${toolPrefix}${name} not registered`)
    return await definition.execute(args, exec(signal)) as Record<string, unknown>
  }
  return { registry, pool, call, disposers }
}

describe('chat tools', () => {
  it('registers the five tools under the prefix with the documented concurrency flags', () => {
    const { registry, disposers } = mountTools({}, 'kc_')
    expect([...registry.tools.keys()].sort()).toEqual(['kc_close', 'kc_list', 'kc_send', 'kc_start', 'kc_steer'])
    expect(registry.tools.get('kc_send')?.isConcurrencySafe?.({ chatId: 'c', message: 'm' })).toBe(true)
    expect(registry.tools.get('kc_close')?.isConcurrencySafe?.({ chatId: 'c' })).toBe(false)
    expect(registry.tools.get('kc_steer')?.isConcurrencySafe?.({ chatId: 'c', message: 'm' })).toBe(true)
    expect(registry.tools.get('kc_start')?.description).not.toMatch(/always/i)
    for (const dispose of disposers) dispose()
    expect(registry.tools.size).toBe(0)
  })

  it('runs start → send → list → close end to end', async () => {
    const { call, pool } = mountTools({ MOCK_TEXT: 'tool answer' })
    const started = await call('start', { cwd: process.cwd() })
    const chatId = started.chatId as string
    expect(chatId).toMatch(/^chat-/)
    expect(await call('send', { chatId, message: 'hi' })).toEqual({ text: 'tool answer' })
    const listed = (await call('list', {})).text as string
    expect(listed).toContain(chatId)
    expect(listed).toMatch(new RegExp(`^${chatId} \\| backend default \\| idle \\(\\d+s\\) \\| remote `))
    expect((await call('close', { chatId })).text).toContain('record is kept')
    expect((await call('list', {})).text).toMatch(/\| backend default \| released \(last active \d+s ago; reconnects on next send\) \|/)
    expect((await call('close', { chatId, purge: true })).text).toContain('record deleted')
    expect(pool.knows(chatId)).toBe(false)
    expect((await call('list', {})).text).toBe('no persistent chats')
  })

  it('names the list tool when a chat is unknown (send and close)', async () => {
    const { call } = mountTools({}, 'kc_')
    await expect(call('send', { chatId: 'chat-nope', message: 'x' })).rejects.toThrow('unknown chat chat-nope; call kc_list to see known chats')
    await expect(call('close', { chatId: 'chat-nope' })).rejects.toThrow('unknown chat chat-nope; call kc_list to see known chats')
  })

  it('throws on a non-completed turn and carries the partial output', async () => {
    const { call } = mountTools({ MOCK_STOP: 'max_tokens', MOCK_TEXT: 'half an answer' })
    const { chatId } = await call('start', { cwd: process.cwd() })
    const error = await call('send', { chatId, message: 'x' }).then(() => undefined, (e: unknown) => e as Error)
    expect(error?.message).toContain('ran out of room')
    expect(error?.message).toContain('partial output received:\nhalf an answer')
  })

  it('throws with a diagnostic excerpt when the child crashes mid-turn', async () => {
    const { call } = mountTools({ MOCK_CRASH_ON_PROMPT: '1' })
    const { chatId } = await call('start', { cwd: process.cwd() })
    await expect(call('send', { chatId, message: 'x' })).rejects.toThrow(/the agent failed before it finished: Subagent failure \(provider: ACP; .*process-exit/)
  })

  it('prefixes a degraded answer with the fresh-session note', async () => {
    const dir = tempDir('acp-resume-tools-store-')
    const store = join(dir, 's.json')
    const { call, pool } = mountTools({ MOCK_REMEMBER: '1', MOCK_SESSION_STORE: store })
    const { chatId } = await call('start', { cwd: process.cwd() })
    await pool.close(chatId as string)
    rmSync(store)
    const answer = (await call('send', { chatId, message: 'x' })).text as string
    const [first, ...rest] = answer.split('\n')
    expect(first).toMatch(/^\[remote session lost, started fresh — /)
    expect(rest.join('\n')).toBe('remember:none')
  })

  it('accepts an optional label on start and shows it in list', async () => {
    const { call, pool } = mountTools({})
    const { chatId } = await call('start', { cwd: process.cwd(), label: '方案评审' })
    const { chatId: plainId } = await call('start', { cwd: process.cwd() })
    const lines = ((await call('list', {})).text as string).split('\n')
    expect(lines.find(l => l.startsWith(chatId as string))).toContain('| label "方案评审" |')
    expect(lines.find(l => l.startsWith(plainId as string))).not.toContain('label')
    expect(pool.listChats().find(c => c.chatId === chatId)?.label).toBe('方案评审')
    await expect(call('start', { cwd: process.cwd(), label: 'x'.repeat(81) })).rejects.toThrow(/at most 80/)
  })

  it('records the owning agent session on start (D20)', async () => {
    const { registry, pool, disposers } = mountTools({})
    try {
      const start = registry.tools.get('acp_chat_start') as Definition
      const ownerExec = { signal: new AbortController().signal, agent: { id: 'sess-owner-42' } } as unknown as ToolRunContext
      const { chatId } = await start.execute({ cwd: process.cwd() }, ownerExec) as { chatId: string }
      expect(pool.listChats().find(c => c.chatId === chatId)?.ownerSessionId).toBe('sess-owner-42')
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('lists only chats from the calling session by default', async () => {
    const { registry, pool } = mountTools({})
    const mine = await pool.start(process.cwd(), undefined, { ownerSessionId: 'session-mine-1234' })
    const other = await pool.start(process.cwd(), undefined, { ownerSessionId: 'session-other-5678' })
    const legacy = await pool.start(process.cwd())
    const list = registry.tools.get('acp_chat_list') as Definition
    const output = await list.execute({}, { signal: new AbortController().signal, agent: { id: 'session-mine-1234' } } as unknown as ToolRunContext) as { text: string }
    expect(output.text).toContain(mine.chatId)
    expect(output.text).not.toContain(other.chatId)
    expect(output.text).not.toContain(legacy.chatId)
    expect(output.text).not.toContain('owner')
  })

  it('has no scope parameter and describes current-session discovery', () => {
    const { registry } = mountTools({})
    const list = registry.tools.get('acp_chat_list') as Definition
    expect(list.parameters).not.toHaveProperty('scope')
    expect(list.description).toContain('created by the current DSH session')
  })

  it('allows another session to send to a known chat id', async () => {
    const { registry, pool } = mountTools({ MOCK_TEXT: 'cross-session answer' })
    const chat = await pool.start(process.cwd(), undefined, { ownerSessionId: 'session-owner-1234' })
    const send = registry.tools.get('acp_chat_send') as Definition
    await expect(send.execute({ chatId: chat.chatId, message: 'continue' }, { signal: new AbortController().signal, agent: { id: 'session-other-5678' } } as unknown as ToolRunContext))
      .resolves.toEqual({ text: 'cross-session answer' })
  })

  it('falls back to every chat when list has no calling session', async () => {
    const { call, pool } = mountTools({})
    const owned = await pool.start(process.cwd(), undefined, { ownerSessionId: 'session-other-5678' })
    const legacy = await pool.start(process.cwd())
    const output = (await call('list', {})).text as string
    expect(output).toContain(owned.chatId)
    expect(output).toContain(legacy.chatId)
  })

  it('shows a running chat as running with its elapsed time, and drops the owner column', async () => {
    const dir = tempDir('acp-resume-list-running-')
    const hold = join(dir, 'hold')
    writeFileSync(hold, 'held')
    const { registry, pool, call } = mountTools({ MOCK_TEXT: 'later', MOCK_PROMPT_HOLD: hold })
    const chat = await pool.start(process.cwd(), undefined, { ownerSessionId: 'owner-123456789' })
    const sending = call('send', { chatId: chat.chatId, message: 'long' })
    const deadline = Date.now() + 5000
    while (pool.chatInfo(chat.chatId)?.inFlight === undefined && Date.now() < deadline) await new Promise(r => setTimeout(r, 10))
    const list = registry.tools.get('acp_chat_list') as Definition
    const output = await list.execute({}, exec()) as { text: string }
    expect(output.text).toMatch(new RegExp(`^${chat.chatId} \\| backend default \\| running \\(\\d+s\\) \\| remote `))
    expect(output.text).not.toContain('owner')
    rmSync(hold)
    await sending
  })

  it('list shows the start-passable backend name and steer copy names no protocol method or engine', async () => {
    const { registry, pool } = mountTools({})
    await pool.start(process.cwd())
    const list = registry.tools.get('acp_chat_list') as Definition
    const output = await list.execute({}, exec()) as { text: string }
    expect(output.text).toContain('| backend default |')
    expect(output.text).not.toContain(`backend ${pool.listChats()[0]?.backendDisplay as string} |`)
    const steer = registry.tools.get('acp_chat_steer') as Definition
    expect(steer.description).toContain('Requires a backend that supports mid-turn steering')
    expect(steer.description).not.toMatch(/_session\/steer|kiro|engine/)
  })

  it('rejects an already-aborted call before touching the pool', async () => {
    const { call } = mountTools({})
    await expect(call('start', { cwd: process.cwd() }, AbortSignal.abort())).rejects.toThrow()
  })

  it('single-backend start tool matches the 0.1.20 fixture byte for byte', () => {
    const start = chatStaticTools({} as AcpSessionPool, 'acp_chat_').find(tool => tool.name === 'acp_chat_start') as Definition
    const actual = JSON.stringify({ name: start.name, description: start.description, parameters: start.parameters }, null, 2)
    const fixture = readFileSync(new URL('./fixtures/acp-chat-start-single-backend.json', import.meta.url), 'utf8').trim()
    expect(actual).toBe(fixture)
  })

  it('single-backend start tool has no backend parameter', () => {
    const start = chatStaticTools({} as AcpSessionPool, 'acp_chat_').find(tool => tool.name === 'acp_chat_start') as Definition
    expect(start.parameters).not.toHaveProperty('backend')
  })

  it('multi-backend descriptions are neutral and user override wins', () => {
    const start = chatStaticTools({} as AcpSessionPool, 'acp_chat_', [
      { name: 'default', description: 'default (agent)' },
      { name: 'review', description: '用户指定的评审后端' },
    ]).find(tool => tool.name === 'acp_chat_start') as Definition
    expect(start.description).toContain('review: 用户指定的评审后端')
    expect(start.description).toContain('configured external ACP agent')
    expect(start.description).not.toContain('kiro-cli')
  })

  it('invalid backend name errors with available names', async () => {
    const starts: unknown[] = []
    const start = chatStaticTools({ start: async (...args: unknown[]) => { starts.push(args); return { chatId: 'x', remoteSessionId: 'y' } } } as unknown as AcpSessionPool, 'acp_chat_', [
      { name: 'default', description: 'default' }, { name: 'review', description: 'review' },
    ]).find(tool => tool.name === 'acp_chat_start') as Definition
    await expect(start.execute({ cwd: process.cwd(), backend: 'missing' }, exec())).rejects.toThrow('unknown backend missing; available backends: default, review')
    expect(starts).toEqual([])
  })
})

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

async function host(withTools = true): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  if (withTools) await ctx.plugin(StubTools)
  return ctx
}

function stubTools(ctx: Context): StubTools {
  return ctx.get('tools') as unknown as StubTools
}

async function until(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 10))
  }
}

describe('apply (plugin wiring)', () => {
  it('registers the provider under the default name, the five prefixed tools, and acp_workflow with workflow: true', async () => {
    const ctx = await host()
    const registryPath = join(tempDir('acp-resume-apply-'), 'registry.json')
    const fiber = await ctx.plugin(acp, { command: process.execPath, args: [mockServer], registryPath, toolPrefix: 'kc_', workflow: true })
    cleanups.push(() => fiber.dispose())
    await until(() => stubTools(ctx).registered.size === 8, 'tool registration')
    expect([...stubTools(ctx).registered.keys()].sort()).toEqual(['acp_backend_usage', 'acp_workflow', 'kc_backend_status', 'kc_close', 'kc_list', 'kc_send', 'kc_start', 'kc_steer'])
  })

  it('registers the five chat tools and backend status, without workflow by default', async () => {
    for (const extra of [{}, { workflow: false }]) {
      const ctx = await host()
      const registryPath = join(tempDir('acp-resume-apply-'), 'registry.json')
      const fiber = await ctx.plugin(acp, { command: process.execPath, args: [mockServer], registryPath, toolPrefix: 'kc_', ...extra })
      cleanups.push(() => fiber.dispose())
      await until(() => stubTools(ctx).registered.size === 7, 'tool registration')
      expect([...stubTools(ctx).registered.keys()].sort()).toEqual(['acp_backend_usage', 'kc_backend_status', 'kc_close', 'kc_list', 'kc_send', 'kc_start', 'kc_steer'])
      expect(JSON.stringify(stubTools(ctx).registered.get('kc_send')?.parameters)).not.toContain('role')
    }
  })

  it('forwards ask through the registered persistent-chat tool', async () => {
    const ctx = await host()
    await ctx.plugin(UserQuestionService)
    ctx.on('user-questions/request', request => ({
      answers: request.questions.map(question => ({ id: question.id, selected: ['Allow (allow_once, option 1)'] })),
    }))
    const fiber = await ctx.plugin(acp, {
      command: process.execPath,
      args: [mockServer],
      permission: 'ask',
      env: { MOCK_PERMISSION: '1', MOCK_TEXT: 'approved in persistent chat' },
      registryPath: join(tempDir('acp-resume-ask-tool-'), 'registry.json'),
    })
    cleanups.push(() => fiber.dispose())
    await until(() => stubTools(ctx).registered.has('acp_chat_start'), 'tool registration')
    const start = stubTools(ctx).registered.get('acp_chat_start') as Definition
    const send = stubTools(ctx).registered.get('acp_chat_send') as Definition
    const { chatId } = await start.execute({ cwd: process.cwd() }, exec()) as { chatId: string }
    await expect(send.execute({ chatId, message: 'p' }, exec())).resolves.toEqual({ text: 'approved in persistent chat' })
  })

  it('preserves actionable one-shot ENOENT and keeps tools available when the CLI is missing', async () => {
    const ctx = await host()
    const dir = tempDir('acp-resume-missing-command-')
    const command = join(dir, 'missing-acp-agent')
    const registryPath = join(dir, 'registry.json')
    const fiber = await ctx.plugin(acp, { command, args: [], registryPath })
    cleanups.push(() => fiber.dispose())
    const request = {
      label: 'missing command',
      prompt: [{ type: 'text' as const, text: 'p' }],
      parent: { id: 'parent', session: { header: { cwd: process.cwd() } } } as never,
      signal: new AbortController().signal,
    }
    const oneShot = await startExternalActivation(ctx, 'acp-resume', request).then(() => undefined, (error: unknown) => error as Error)
    expect(oneShot?.message).toContain(COMMAND_NOT_FOUND_GUIDANCE)
    expect(oneShot?.message).not.toContain(command)
    const status = await ctx.get('acpResume')!.checkBackends()
    expect(status.backends).toContainEqual(expect.objectContaining({ id: 'default', compatibility: 'not-found', reason: 'missing-executable' }))
    expect(JSON.stringify(status)).not.toContain(command)
    expect(stubTools(ctx).registered.has('acp_chat_start')).toBe(true)
    expect(existsSync(registryPath)).toBe(false)
  })

  it('registers no tools when enableChatTools is false', async () => {
    const ctx = await host()
    const registryPath = join(tempDir('acp-resume-apply-'), 'registry.json')
    const fiber = await ctx.plugin(acp, { command: process.execPath, args: [mockServer], registryPath, enableChatTools: false })
    cleanups.push(() => fiber.dispose())
    await new Promise(r => setTimeout(r, 50))
    expect(stubTools(ctx).registered.size).toBe(0)
    expect(existsSync(registryPath)).toBe(false)
  })

  it('rejects a relative registryPath at load', async () => {
    const ctx = await host()
    const loading = ctx.plugin(acp, { command: process.execPath, args: [mockServer], registryPath: 'rel/registry.json' })
    await expect(Promise.resolve(loading)).rejects.toThrow(/registryPath must be an absolute path/)
  })

  it('revokes the tools and releases chat processes when the plugin fiber unloads', async () => {
    const ctx = await host()
    const dir = tempDir('acp-resume-apply-')
    const flushed = join(dir, 'flushed')
    const fiber = await ctx.plugin(acp, {
      command: process.execPath,
      args: [mockServer],
      registryPath: join(dir, 'registry.json'),
      env: { MOCK_FLUSH_ON_EOF: flushed },
    })
    await until(() => stubTools(ctx).registered.size === 7, 'tool registration')
    const start = stubTools(ctx).registered.get('acp_chat_start') as Definition
    const send = stubTools(ctx).registered.get('acp_chat_send') as Definition
    const { chatId } = await start.execute({ cwd: process.cwd() }, exec()) as { chatId: string }
    expect(await send.execute({ chatId, message: 'hi' }, exec())).toEqual({ text: 'mock child answer' })
    expect(existsSync(flushed)).toBe(false)

    await fiber.dispose()
    expect(stubTools(ctx).registered.size).toBe(0)
    // The chat's child got stdin EOF and exited on its own before teardown returned.
    expect(existsSync(flushed)).toBe(true)
    // The captured tool body now hits a disposed pool.
    await expect(send.execute({ chatId, message: 'again' }, exec())).rejects.toThrow(/disposed/)
    expect(existsSync(join(dir, 'registry.json'))).toBe(true)
  })
})

describe('Codex backend wiring (D25)', () => {
  const codexBackends = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    codex: { command: process.execPath, args: [codexMock], protocol: 'codex', model: 'mock-model', env: { MOCK_TEXT: 'codex via tool' }, ...extra },
  })

  async function mount(config: Record<string, unknown>): Promise<{ ctx: Context; registryPath: string }> {
    const ctx = await host()
    const registryPath = join(tempDir('acp-resume-codex-apply-'), 'registry.json')
    const fiber = await ctx.plugin(acp, { command: process.execPath, args: [mockServer], registryPath, ...config })
    cleanups.push(() => fiber.dispose())
    await until(() => stubTools(ctx).registered.has('acp_chat_start'), 'tool registration')
    return { ctx, registryPath }
  }

  it('registers acp_backend_usage when a Codex backend is configured, even with discovery disabled (D28)', async () => {
    const { ctx } = await mount({ backends: codexBackends(), discoverBackends: false })
    await until(() => stubTools(ctx).registered.has('acp_backend_usage'), 'usage tool registration')
    const usage = stubTools(ctx).registered.get('acp_backend_usage') as Definition
    expect(usage.isConcurrencySafe?.({})).toBe(true)
    expect(usage.description).toMatch(/read-only/)
  })

  it('omits usage if discovery is disabled and no Codex backend is configured', async () => {
    const { ctx } = await mount({ discoverBackends: false })
    expect(stubTools(ctx).registered.has('acp_backend_usage')).toBe(false)
    const start = stubTools(ctx).registered.get('acp_chat_start')!
    expect(JSON.stringify(start.parameters)).not.toContain('"backend"')
    const { chatId } = await start.execute({ cwd: process.cwd() }, exec()) as { chatId: string }
    expect(chatId).toMatch(/^chat-/)
  })

  it('lists both the default ACP backend and the Codex backend in acp_chat_start', async () => {
    const { ctx } = await mount({ backends: codexBackends({ description: 'Codex 评审' }) })
    const start = stubTools(ctx).registered.get('acp_chat_start') as Definition
    const serialized = JSON.stringify(start.parameters)
    expect(serialized).toContain('"backend"')
    expect(start.description).toContain('codex: Codex 评审')
  })

  it('keeps the backend parameter for a Codex-only named backend because the default ACP backend still counts', async () => {
    const { ctx } = await mount({ backends: codexBackends() })
    const start = stubTools(ctx).registered.get('acp_chat_start') as Definition
    expect(JSON.stringify(start.parameters)).toContain('"backend"')
    expect(start.description).toContain('codex:')
  })

  it('multi-backend start receipt names the backend and cwd; the single-backend receipt is unchanged', async () => {
    const { ctx } = await mount({ backends: codexBackends(), defaultBackend: 'default' })
    const start = stubTools(ctx).registered.get('acp_chat_start') as Definition
    for (const [args, backend] of [[{ cwd: process.cwd(), backend: 'codex' }, 'codex'], [{ cwd: process.cwd() }, 'default']] as const) {
      const value = await start.execute(args, exec()) as { chatId: string }
      expect(start.output.render(args, value)).toEqual([{ type: 'text', text: `chat started: ${value.chatId} (backend: ${backend}, cwd: ${process.cwd()}); send messages with acp_chat_send` }])
    }
    const single = chatStaticTools({} as AcpSessionPool, 'acp_chat_').find(tool => tool.name === 'acp_chat_start') as Definition
    expect(single.output.render({}, { chatId: 'chat-x', remoteSessionId: 'r' })).toEqual([{ type: 'text', text: 'chat started: chat-x; send messages with acp_chat_send' }])
  })

  it('runs a chat on the selected Codex backend through the registered tools', async () => {
    const { ctx } = await mount({ backends: codexBackends() })
    const start = stubTools(ctx).registered.get('acp_chat_start') as Definition
    const send = stubTools(ctx).registered.get('acp_chat_send') as Definition
    const { chatId } = await start.execute({ cwd: process.cwd(), backend: 'codex' }, exec()) as { chatId: string }
    await expect(send.execute({ chatId, message: 'p' }, exec())).resolves.toEqual({ text: 'codex via tool' })
  })

  it('does not repoint an existing chat to auto-discovered Codex when its configured backend is removed', async () => {
    const registryPath = join(tempDir('acp-resume-codex-gone-'), 'registry.json')
    const first = await host()
    const fiberA = await first.plugin(acp, { command: process.execPath, args: [mockServer], registryPath, backends: codexBackends() })
    cleanups.push(() => fiberA.dispose())
    await until(() => stubTools(first).registered.has('acp_chat_start'), 'tool registration')
    const { chatId } = await (stubTools(first).registered.get('acp_chat_start') as Definition).execute({ cwd: process.cwd(), backend: 'codex' }, exec()) as { chatId: string }
    await fiberA.dispose()
    const second = await host()
    const fiberB = await second.plugin(acp, { command: process.execPath, args: [mockServer], registryPath })
    cleanups.push(() => fiberB.dispose())
    await until(() => stubTools(second).registered.has('acp_chat_send'), 'tool registration')
    await expect((stubTools(second).registered.get('acp_chat_send') as Definition).execute({ chatId, message: 'p' }, exec())).rejects.toThrow(/unavailable backend codex|saved session belongs to another agent/)
  })

  it('reports a Codex backend without an explicit model without taking the plugin offline', async () => {
    const { ctx } = await mount({ backends: codexBackends({ model: undefined }) })
    const status = await ctx.get('acpResume')!.checkBackends()
    expect(status.backends).toContainEqual(expect.objectContaining({ id: 'codex', readiness: 'needs-configuration', reason: 'model-required' }))
    expect(stubTools(ctx).registered.has('acp_backend_usage')).toBe(true)
  })

  function autoFixture() {
    const dir = tempDir('acp-resume-known-cli-')
    const kiro = join(dir, 'kiro-cli')
    const codex = join(dir, 'codex')
    const touchedKiro = join(dir, 'kiro-was-started')
    const signedOut = join(dir, 'signed-out')
    const leakedEnv = join(dir, 'leaked-env')
    const requests = join(dir, 'requests')
    const store = join(dir, 'codex-store.json')
    const registryPath = join(dir, 'registry.json')
    const quote = (text: string): string => "'" + text.replaceAll("'", "'\"'\"'") + "'"
    const writeCodex = (version: string): void => writeFileSync(codex, `#!/bin/sh
if [ -n "\${OTHER_BACKEND_SECRET:-}" ]; then : > ${quote(leakedEnv)}; fi
if [ "$1" = --version ]; then printf 'codex-cli ${version}\\n'; exit 0; fi
if [ -f ${quote(signedOut)} ]; then export MOCK_CODEX_SIGNED_OUT=1; fi
export MOCK_REQUEST_FILE=${quote(requests)}
export MOCK_SESSION_STORE=${quote(store)}
exec ${quote(process.execPath)} ${quote(codexMock)}
`, { mode: 0o755 })
    const writeKiro = (version: string): void => writeFileSync(kiro, `#!/bin/sh
if [ "$1" = --version ]; then printf 'kiro-cli ${version}\\n'; exit 0; fi
: > ${quote(touchedKiro)}
exec ${quote(process.execPath)} ${quote(mockServer)}
`, { mode: 0o755 })
    writeKiro('2.21.1')
    writeCodex('0.155.1')
    return { writeKiro, writeCodex, touchedKiro, signedOut, leakedEnv, requests, registryPath,
      config: { command: 'kiro-cli', args: ['acp'], registryPath, workflow: true, env: { PATH: dir, OTHER_BACKEND_SECRET: 'test-only-sentinel' } },
    }
  }

  it.skipIf(process.platform === 'win32')('boots with old Kiro and a ready Codex without a named backend, model, or button click', async () => {
    const ctx = await host()
    const fixture = autoFixture()
    const fiber = await ctx.plugin(acp, fixture.config)
    cleanups.push(() => fiber.dispose())
    const tools = stubTools(ctx).registered
    const panel = ctx.get('acpResume')!
    const beforeCheck = new Map(tools)
    expect([...beforeCheck.keys()].sort()).toEqual([
      'acp_backend_status', 'acp_backend_usage', 'acp_chat_close', 'acp_chat_list',
      'acp_chat_send', 'acp_chat_start', 'acp_chat_steer', 'acp_workflow',
    ])
    await until(() => panel.backends().defaultBackend === 'codex' && !panel.backends().checking, 'automatic backend check')
    expect(panel.backends()).toMatchObject({ defaultBackend: 'codex', dispatchEnabled: true, checking: false })
    expect(panel.backends().backends).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'default', version: '2.21.1', compatibility: 'unverified-version', readiness: 'unverified' }),
      expect.objectContaining({ id: 'codex', version: '0.155.1', compatibility: 'supported', readiness: 'ready', automatic: true, configured: false }),
      expect.objectContaining({ id: 'agy', label: 'Antigravity CLI (agy)', compatibility: 'not-found', reason: 'missing-executable', range: '>=1.5.4 <1.6.0' }),
    ]))
    const status = await tools.get('acp_backend_status')!.execute({}, exec()) as { text: string }
    expect(status.text).toContain('agy — Antigravity CLI (agy): not-found, unavailable')
    expect(existsSync(fixture.touchedKiro)).toBe(false)
    expect(existsSync(fixture.leakedEnv)).toBe(false)
    expect(existsSync(fixture.registryPath)).toBe(false)
    expect(readFileSync(fixture.requests, 'utf8')).toMatch(/account\/read.*"refreshToken":false/)
    expect(readFileSync(fixture.requests, 'utf8')).not.toMatch(/thread\/start|turn\/start/)
    expect(tools.has('acp_workflow')).toBe(true)
    const start = tools.get('acp_chat_start')!
    expect(start).toBe(beforeCheck.get('acp_chat_start'))
    expect(start.description).toContain('kiro-cli')
    const chat = await start.execute({ cwd: process.cwd() }, exec()) as { backend: string; chatId: string }
    expect(chat).toMatchObject({ backend: 'codex', cwd: process.cwd() })
    expect(readFileSync(fixture.requests, 'utf8')).toMatch(/thread\/start.*"model":"mock-model"/)
    expect(readFileSync(fixture.requests, 'utf8')).toMatch(/thread\/start.*"sandbox":"read-only"/)
    await panel.close(chat.chatId)
    await tools.get('acp_chat_send')!.execute({ chatId: chat.chatId, message: 'resume' }, exec())
    const resumed = readFileSync(fixture.requests, 'utf8').split('\n').find(line => line.startsWith('thread/resume '))
    expect(resumed).toBeDefined()
    expect(resumed).not.toContain('"model"')

    fixture.writeCodex('0.153.0')
    expect((await panel.checkBackends()).defaultBackend).toBeUndefined()
    expect([...tools.keys()].sort()).toEqual([...beforeCheck.keys()].sort())
    for (const [name, definition] of beforeCheck) expect(tools.get(name)).toBe(definition)
    await expect(start.execute({ cwd: process.cwd() }, exec())).rejects.toThrow(/cannot dispatch/)
    await panel.close(chat.chatId)
    await expect(tools.get('acp_chat_send')!.execute({ chatId: chat.chatId, message: 'resume after upgrade' }, exec())).resolves.toMatchObject({ text: expect.any(String) })
    expect(panel.list()).toEqual([expect.objectContaining({ chatId: chat.chatId, backend: 'codex' })])
  }, 10_000)

  it.skipIf(process.platform === 'win32')('auto-discovers agy 1.5.14, reports auth failure on first start, and retries after sign-in', async () => {
    const ctx = await host()
    const fixture = autoFixture()
    const dir = fixture.config.env.PATH
    const command = join(dir, 'agy')
    const decision = join(dir, 'agy-permission')
    const writeAgy = (version: string, signedOut = false): void => writeFileSync(command, `#!/bin/sh
if [ "$1" = --version ]; then printf '%s\\n' '${version}'; exit 0; fi
[ "$#" = 1 ] && [ "$1" = acp ] && [ -z "\${OTHER_BACKEND_SECRET:-}" ] || exit 1
export MOCK_AUTH_REQUIRED=${signedOut ? 1 : 0} MOCK_PERMISSION=1 MOCK_PERMISSION_IGNORE_DECISION=1 MOCK_PERMISSION_DECISION_FILE="${decision}"
exec "${process.execPath}" "${mockServer}"
`, { mode: 0o755 })
    fixture.writeCodex('0.153.0')
    writeAgy('1.5.14', true)
    const fiber = await ctx.plugin(acp, { ...fixture.config, permission: 'allow' })
    cleanups.push(() => fiber.dispose())
    const panel = ctx.get('acpResume')!
    const tools = stubTools(ctx).registered
    await until(() => panel.backends().defaultBackend === 'agy' && !panel.backends().checking, 'automatic agy check')
    expect(panel.backends()).toMatchObject({ defaultBackend: 'agy', dispatchEnabled: true })
    expect(panel.backends().backends).toContainEqual(expect.objectContaining({ id: 'agy', version: '1.5.14', readiness: 'ready', automatic: true, configured: false }))
    expect(existsSync(fixture.registryPath)).toBe(false)
    await expect(tools.get('acp_chat_start')!.execute({ cwd: process.cwd() }, exec())).rejects.toThrow('Sign in using the backend CLI')
    expect(panel.backends().backends).toContainEqual(expect.objectContaining({ id: 'agy', readiness: 'needs-login', reason: 'login-required' }))
    expect(tools.has('acp_chat_start')).toBe(true)
    writeAgy('1.5.14')
    expect(await panel.checkBackends()).toMatchObject({ defaultBackend: 'agy', dispatchEnabled: true })
    const chat = await tools.get('acp_chat_start')!.execute({ cwd: process.cwd() }, exec()) as { backend: string; chatId: string }
    expect(chat.backend).toBe('agy')
    await tools.get('acp_chat_send')!.execute({ chatId: chat.chatId, message: 'hello' }, exec())
    expect(readFileSync(decision, 'utf8')).toBe('cancelled\n')
    fixture.writeCodex('0.171.1')
    const mixed = await panel.checkBackends()
    expect(mixed.backends.filter(row => row.readiness === 'ready').map(row => row.id).sort()).toEqual(['agy', 'codex'])
    expect(mixed.defaultBackend).toBe('codex')
    expect(await tools.get('acp_chat_start')!.execute({ cwd: process.cwd() }, exec())).toMatchObject({ backend: 'codex', cwd: process.cwd() })
    fixture.writeKiro('3.5.1')
    expect(await panel.checkBackends()).toMatchObject({ defaultBackend: 'default' })
    const start = tools.get('acp_chat_start')!
    const args = { cwd: process.cwd() }
    const kiro = await start.execute(args, exec()) as { chatId: string; backend: string; cwd: string }
    expect(kiro).toMatchObject({ backend: 'default', cwd: process.cwd() })
    expect(start.output.render(args, kiro)).toEqual([{ type: 'text', text: `chat started: ${kiro.chatId} (backend: default, cwd: ${process.cwd()}); send messages with acp_chat_send` }])
    expect(await start.execute({ ...args, backend: 'agy' }, exec())).toMatchObject({ backend: 'agy' })
    fixture.writeKiro('2.21.1')
    fixture.writeCodex('0.153.0')
    writeAgy('1.6.0')
    expect((await panel.checkBackends()).defaultBackend).toBeUndefined()
    expect(panel.backends().backends).toContainEqual(expect.objectContaining({ id: 'agy', version: '1.6.0', compatibility: 'unverified-version', readiness: 'unverified', reason: 'unsupported-version' }))
    expect(panel.list()).toContainEqual(expect.objectContaining({ chatId: chat.chatId, backend: 'agy' }))
  }, 10_000)

  it.skipIf(process.platform === 'win32')('keeps a configured out-of-range default pinned and only warns about its version', async () => {
    const ctx = await host()
    const fixture = autoFixture()
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    const fiber = await ctx.plugin(acp, { ...fixture.config, defaultBackend: 'default' })
    cleanups.push(() => fiber.dispose())
    const panel = ctx.get('acpResume')!
    const status = await panel.checkBackends()
    expect(status.defaultBackend).toBe('default')
    expect(status.backends).toContainEqual(expect.objectContaining({ id: 'default', version: '2.21.1', compatibility: 'unverified-version', readiness: 'unverified' }))
    expect(status.backends).toContainEqual(expect.objectContaining({ id: 'codex', readiness: 'ready' }))
    expect(warnings.some(warning => warning.includes('configured backend default version 2.21.1') && warning.includes('outside verified range'))).toBe(true)
    expect(existsSync(fixture.touchedKiro)).toBe(false)
    const start = stubTools(ctx).registered.get('acp_chat_start')!
    expect(await start.execute({ cwd: process.cwd() }, exec())).toMatchObject({ backend: 'default', cwd: process.cwd() })
    expect(existsSync(fixture.touchedKiro)).toBe(true)
    expect(readFileSync(fixture.requests, 'utf8')).not.toContain('thread/start')
  }, 10_000)

  it.skipIf(process.platform === 'win32')('keeps a preferred auto backend pinned when unverified, without falling back to Kiro', async () => {
    const ctx = await host()
    const fixture = autoFixture()
    fixture.writeKiro('3.5.1')
    fixture.writeCodex('0.172.0')
    const fiber = await ctx.plugin(acp, { ...fixture.config, defaultBackend: 'codex' })
    cleanups.push(() => fiber.dispose())
    const panel = ctx.get('acpResume')!
    const status = await panel.checkBackends()
    expect(status.defaultBackend).toBe('codex')
    expect(status.backends).toContainEqual(expect.objectContaining({ id: 'default', readiness: 'ready' }))
    expect(status.backends).toContainEqual(expect.objectContaining({ id: 'codex', compatibility: 'unverified-version', readiness: 'unverified' }))
    const start = stubTools(ctx).registered.get('acp_chat_start')!
    await expect(start.execute({ cwd: process.cwd() }, exec())).rejects.toThrow(/outside the verified range/)
    expect(existsSync(fixture.registryPath)).toBe(false)
    expect(await start.execute({ cwd: process.cwd(), backend: 'default' }, exec())).toMatchObject({ backend: 'default' })
  }, 10_000)

  it.skipIf(process.platform === 'win32')('allows an explicit unverified auto backend only with opt-in, not as a startup fallback', async () => {
    const ctx = await host()
    const fixture = autoFixture()
    fixture.writeCodex('0.172.0')
    const fiber = await ctx.plugin(acp, { ...fixture.config, allowUnverifiedBackends: true })
    cleanups.push(() => fiber.dispose())
    const status = await ctx.get('acpResume')!.checkBackends()
    expect(status.defaultBackend).toBeUndefined()
    expect(status.backends).toContainEqual(expect.objectContaining({ id: 'codex', compatibility: 'unverified-version', readiness: 'ready' }))
    const start = stubTools(ctx).registered.get('acp_chat_start')!
    await expect(start.execute({ cwd: process.cwd() }, exec())).rejects.toThrow(/cannot dispatch/)
    expect(await start.execute({ cwd: process.cwd(), backend: 'codex' }, exec())).toMatchObject({ backend: 'codex' })
  }, 10_000)

  it.skipIf(process.platform === 'win32')('reports Codex signed out automatically and rechecks after the user signs in', async () => {
    const ctx = await host()
    const fixture = autoFixture()
    writeFileSync(fixture.signedOut, '')
    const fiber = await ctx.plugin(acp, fixture.config)
    cleanups.push(() => fiber.dispose())
    const panel = ctx.get('acpResume')!
    await until(() => panel.backends().backends.some(row => row.reason === 'login-required'), 'automatic login check')
    const tools = stubTools(ctx).registered
    const start = tools.get('acp_chat_start')!
    expect(start).toBeDefined()
    await expect(start.execute({ cwd: process.cwd(), backend: 'codex' }, exec())).rejects.toThrow(/sign in to the CLI/)
    expect(readFileSync(fixture.requests, 'utf8')).not.toMatch(/account\/login|thread\/start|turn\/start/)
    rmSync(fixture.signedOut)
    expect(await panel.checkBackends()).toMatchObject({ defaultBackend: 'codex', dispatchEnabled: true })
    expect(tools.get('acp_chat_start')).toBe(start)
    expect(existsSync(fixture.registryPath)).toBe(false)
  })

  it('rejects an unknown protocol, sandbox or approvalPolicy value at config validation', () => {
    const base = { command: 'codex', model: 'm' }
    expect(() => acp.Config({ command: 'x', backends: { codex: { ...base, protocol: 'codx' } } })).toThrow()
    expect(() => acp.Config({ command: 'x', backends: { codex: { ...base, protocol: 'codex', sandbox: 'wide-open' } } })).toThrow()
    expect(() => acp.Config({ command: 'x', backends: { codex: { ...base, protocol: 'codex', approvalPolicy: 'sometimes' } } })).toThrow()
    const ok = acp.Config({ command: 'x', backends: { codex: { ...base, protocol: 'codex', sandbox: 'workspace-write', approvalPolicy: 'on-request' } } }) as { backends: Record<string, { protocol: string; args: string[] }> }
    expect(ok.backends['codex']).toMatchObject({ protocol: 'codex', sandbox: 'workspace-write', approvalPolicy: 'on-request' })
  })

  it('defaults a named backend to the acp protocol', () => {
    const cfg = acp.Config({ command: 'x', backends: { review: { command: 'agent' } } }) as { backends: Record<string, { protocol: string }> }
    expect(cfg.backends['review']?.protocol).toBe('acp')
  })
})
