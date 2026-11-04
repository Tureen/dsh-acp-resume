/**
 * Agent-engine flag (D19): the pure argv helpers, plus the plugin wiring on
 * both spawn paths. The wiring cases mount the plugin under cordis and have
 * the mock agent echo the args it was actually spawned with: the chat pool
 * path (via the registered tools) and the one-shot provider path. Default is
 * `--agent-engine v3`; an explicit flag in the user's args is never duplicated.
 * Keyless; no model.
 *
 * @module dsh-acp-resume/tests/engine.spec
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import * as acp from '../src/index.ts'
import { hasAgentEngineFlag, stripAgentEngine, withAgentEngine } from '../src/engine.ts'
import type { ToolsRegistryFace } from '../src/tools.ts'
import { mountWorkingDirectoryFixture } from './helpers/working-directory-fixture.ts'

const mockServer = fileURLToPath(new URL('./mock-acp-server.ts', import.meta.url))

const dirs: string[] = []
const cleanups: (() => unknown)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

type Definition = Parameters<ToolsRegistryFace['register']>[0]

class StubTools extends Service {
  readonly registered = new Map<string, Definition>()
  constructor(ctx: Context) { super(ctx, 'tools') }
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

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 10))
  }
}

const exec = (): ToolRunContext => ({ signal: new AbortController().signal }) as unknown as ToolRunContext

/** Mount the plugin against the argv-echoing mock and return the args its chat process was spawned with. */
async function chatArgv(config: Record<string, unknown>): Promise<string[]> {
  const ctx = await host()
  const dir = mkdtempSync(join(tmpdir(), 'acp-resume-engine-'))
  dirs.push(dir)
  const fiber = await ctx.plugin(acp, {
    command: process.execPath,
    registryPath: join(dir, 'registry.json'),
    env: { MOCK_ECHO_ARGV: '1' },
    ...config,
  })
  cleanups.push(() => fiber.dispose())
  const tools = (ctx.get('tools') as unknown as StubTools).registered
  await until(() => tools.has('acp_chat_send'), 'tool registration')
  const { chatId } = await tools.get('acp_chat_start')!.execute({ cwd: process.cwd() }, exec()) as { chatId: string }
  const { text } = await tools.get('acp_chat_send')!.execute({ chatId, message: 'argv?' }, exec()) as { text: string }
  return JSON.parse(text) as string[]
}

/** The args the one-shot provider's child was spawned with. */
async function oneShotArgv(config: Record<string, unknown>): Promise<string[]> {
  const ctx = await host()
  const fiber = await ctx.plugin(acp, {
    providerName: 'acp',
    command: process.execPath,
    env: { MOCK_ECHO_ARGV: '1' },
    enableChatTools: false,
    ...config,
  })
  cleanups.push(() => fiber.dispose())
  const provider = ctx.subagents.getProvider('acp')!
  const parent = { id: 'parent', session: { header: {} } } as never
  const run = await provider.start!({
    prompt: [{ type: 'text' as const, text: 'argv?' }],
    parent,
    cwd: process.cwd(),
    signal: new AbortController().signal,
  })
  const result = await run.result
  await run.dispose()
  return JSON.parse(result.output.map(b => (b as { text?: string }).text ?? '').join('')) as string[]
}

describe('engine flag helpers', () => {
  it('appends --agent-engine unless the user already set it (either form)', () => {
    expect(withAgentEngine(['acp'], 'v3')).toEqual(['acp', '--agent-engine', 'v3'])
    expect(withAgentEngine([], 'v2')).toEqual(['--agent-engine', 'v2'])
    expect(withAgentEngine(['acp', '--agent-engine', 'v1'], 'v3')).toEqual(['acp', '--agent-engine', 'v1'])
    expect(withAgentEngine(['acp', '--agent-engine=v2'], 'v3')).toEqual(['acp', '--agent-engine=v2'])
    expect(hasAgentEngineFlag(['acp'])).toBe(false)
  })

  it('strips the flag and its value, leaving every other arg in order', () => {
    expect(stripAgentEngine(['a', '--agent-engine', 'v3', 'b'])).toEqual(['a', 'b'])
    expect(stripAgentEngine(['a', '--agent-engine=v2', 'b'])).toEqual(['a', 'b'])
    expect(stripAgentEngine(['a', '--agent-engine'])).toEqual(['a'])
    expect(stripAgentEngine(['a', '--agent-engine-other', 'b'])).toEqual(['a', '--agent-engine-other', 'b'])
    expect(stripAgentEngine(['a', 7, null])).toEqual(['a', 7, null])
  })
})

describe('engine flag on the spawn paths', () => {
  it('chat pool: appends --agent-engine v3 by default', async () => {
    expect(await chatArgv({ args: [mockServer] })).toEqual(['--agent-engine', 'v3'])
  })

  it('chat pool: honours a configured engine', async () => {
    expect(await chatArgv({ args: [mockServer], agentEngine: 'v2' })).toEqual(['--agent-engine', 'v2'])
  })

  it('chat pool: leaves the args alone when the user already passed the flag', async () => {
    expect(await chatArgv({ args: [mockServer, '--agent-engine', 'v1'] })).toEqual(['--agent-engine', 'v1'])
  })

  it('one-shot provider: appends --agent-engine v3 by default', async () => {
    expect(await oneShotArgv({ args: [mockServer] })).toEqual(['--agent-engine', 'v3'])
  })

  it('one-shot provider: does not duplicate a user-supplied flag', async () => {
    expect(await oneShotArgv({ args: [mockServer, '--agent-engine=v2'] })).toEqual(['--agent-engine=v2'])
  })
})
