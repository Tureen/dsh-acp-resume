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

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
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
import { registerChatTools, type ToolsRegistryFace } from '../src/tools.ts'
import { COMMAND_NOT_FOUND_GUIDANCE } from '../src/command-not-found.ts'
import { startExternalActivation } from './helpers/external-activation-helpers.ts'
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
    expect(listed).toContain('live process')
    expect((await call('close', { chatId })).text).toContain('record is kept')
    expect((await call('list', {})).text).toContain('released (reconnects on next send)')
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

  it('rejects an already-aborted call before touching the pool', async () => {
    const { call } = mountTools({})
    await expect(call('start', { cwd: process.cwd() }, AbortSignal.abort())).rejects.toThrow()
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
  it('registers the provider under the default name and the five prefixed tools', async () => {
    const ctx = await host()
    const registryPath = join(tempDir('acp-resume-apply-'), 'registry.json')
    const fiber = await ctx.plugin(acp, { command: process.execPath, args: [mockServer], registryPath, toolPrefix: 'kc_' })
    cleanups.push(() => fiber.dispose())
    expect(ctx.subagents.list()).toEqual(['acp-resume'])
    await until(() => stubTools(ctx).registered.size === 5, 'tool registration')
    expect([...stubTools(ctx).registered.keys()].sort()).toEqual(['kc_close', 'kc_list', 'kc_send', 'kc_start', 'kc_steer'])
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

  it('returns one safe actionable ENOENT message through the one-shot and chat-start entry points', async () => {
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
    await until(() => stubTools(ctx).registered.has('acp_chat_start'), 'tool registration')
    const start = stubTools(ctx).registered.get('acp_chat_start') as Definition
    const chatStart = await start.execute({ cwd: process.cwd() }, exec()).then(() => undefined, (error: unknown) => error as Error)
    expect(chatStart?.message).toContain(COMMAND_NOT_FOUND_GUIDANCE)
    expect(chatStart?.message).not.toContain(command)
    expect(existsSync(registryPath)).toBe(false)
  })

  it('registers no tools when enableChatTools is false', async () => {
    const ctx = await host()
    const registryPath = join(tempDir('acp-resume-apply-'), 'registry.json')
    const fiber = await ctx.plugin(acp, { command: process.execPath, args: [mockServer], registryPath, enableChatTools: false })
    cleanups.push(() => fiber.dispose())
    await new Promise(r => setTimeout(r, 50))
    expect(stubTools(ctx).registered.size).toBe(0)
    expect(ctx.subagents.list()).toEqual(['acp-resume'])
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
    await until(() => stubTools(ctx).registered.size === 5, 'tool registration')
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
