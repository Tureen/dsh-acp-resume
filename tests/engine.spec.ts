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

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
import { buildChildArgs, stripVolatileFlags } from '../src/engine.ts'
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
    expect(buildChildArgs(['acp'], { engine: 'v3' })).toEqual(['acp', '--agent-engine', 'v3'])
    expect(buildChildArgs([], { engine: 'v2' })).toEqual(['--agent-engine', 'v2'])
    expect(buildChildArgs(['acp', '--agent-engine', 'v1'], { engine: 'v3' })).toEqual(['acp', '--agent-engine', 'v1'])
    expect(buildChildArgs(['acp', '--agent-engine=v2'], { engine: 'v3' })).toEqual(['acp', '--agent-engine=v2'])
  })

  it("appends no --agent-engine for engine 'none' (still honours model/effort and user args)", () => {
    expect(buildChildArgs(['acp'], { engine: 'none' })).toEqual(['acp'])
    expect(buildChildArgs([], { engine: 'none' })).toEqual([])
    expect(buildChildArgs(['acp', '--agent-engine=v2'], { engine: 'none' })).toEqual(['acp', '--agent-engine=v2'])
    expect(buildChildArgs(['acp'], { engine: 'none', model: 'glm-5', effort: 'high' }))
      .toEqual(['acp', '--model', 'glm-5', '--effort', 'high'])
  })

  it("modelSelect 'session' appends no --model / --effort; default 'flag' still does", () => {
    expect(buildChildArgs(['acp'], { engine: 'none', model: 'm', modelSelect: 'session' })).toEqual(['acp'])
    expect(buildChildArgs(['acp'], { engine: 'none', model: 'm', modelSelect: 'flag' })).toEqual(['acp', '--model', 'm'])
    expect(buildChildArgs(['acp'], { engine: 'v3', model: 'm', effort: 'xhigh', modelSelect: 'session' })).toEqual(['acp', '--agent-engine', 'v3'])
    expect(buildChildArgs(['acp'], { engine: 'v2', effort: 'xhigh', modelSelect: 'flag' })).toEqual(['acp', '--agent-engine', 'v2', '--effort', 'xhigh'])
    expect(buildChildArgs(['acp'], { engine: 'none', model: 'm' })).toEqual(['acp', '--model', 'm'])
  })

  it('strips --agent-engine and its value, leaving every other arg in order', () => {
    expect(stripVolatileFlags(['a', '--agent-engine', 'v3', 'b'])).toEqual(['a', 'b'])
    expect(stripVolatileFlags(['a', '--agent-engine=v2', 'b'])).toEqual(['a', 'b'])
    expect(stripVolatileFlags(['a', '--agent-engine'])).toEqual(['a'])
    expect(stripVolatileFlags(['a', '--agent-engine-other', 'b'])).toEqual(['a', '--agent-engine-other', 'b'])
    expect(stripVolatileFlags(['a', 7, null])).toEqual(['a', 7, null])
  })

  it('appends --model / --effort only when configured and not already set (D19 2026-11-05)', () => {
    expect(buildChildArgs(['acp'], { engine: 'v3' })).toEqual(['acp', '--agent-engine', 'v3'])
    expect(buildChildArgs(['acp'], { engine: 'v3', model: 'glm-5' })).toEqual(['acp', '--agent-engine', 'v3', '--model', 'glm-5'])
    expect(buildChildArgs(['acp'], { engine: 'v3', model: 'glm-5', effort: 'high' }))
      .toEqual(['acp', '--agent-engine', 'v3', '--model', 'glm-5', '--effort', 'high'])
    // Empty strings are treated as unset.
    expect(buildChildArgs(['acp'], { engine: 'v2', model: '', effort: '' })).toEqual(['acp', '--agent-engine', 'v2'])
    // A user-supplied flag (either form) is never duplicated.
    expect(buildChildArgs(['acp', '--model', 'mine'], { engine: 'v3', model: 'glm-5' }))
      .toEqual(['acp', '--model', 'mine', '--agent-engine', 'v3'])
    expect(buildChildArgs(['acp', '--effort=low'], { engine: 'v3', effort: 'max' }))
      .toEqual(['acp', '--effort=low', '--agent-engine', 'v3'])
  })

  it('strips --model and --effort too (fingerprint ignores volatile flags)', () => {
    expect(stripVolatileFlags(['acp', '--model', 'glm-5', '--effort', 'high'])).toEqual(['acp'])
    expect(stripVolatileFlags(['acp', '--model=glm-5', '--effort=high', '--other'])).toEqual(['acp', '--other'])
    expect(stripVolatileFlags(['acp', '--agent-engine', 'v3', '--model', 'glm-5'])).toEqual(['acp'])
    expect(stripVolatileFlags(['acp', 7, null])).toEqual(['acp', 7, null])
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

  it("chat pool: agentEngine 'none' spawns without the flag", async () => {
    expect(await chatArgv({ args: [mockServer], agentEngine: 'none' })).toEqual([])
  })

  it("one-shot provider: agentEngine 'none' spawns without the flag", async () => {
    expect(await oneShotArgv({ args: [mockServer], agentEngine: 'none' })).toEqual([])
  })

  it('one-shot provider: appends --agent-engine v3 by default', async () => {
    expect(await oneShotArgv({ args: [mockServer] })).toEqual(['--agent-engine', 'v3'])
  })

  it('one-shot provider: does not duplicate a user-supplied flag', async () => {
    expect(await oneShotArgv({ args: [mockServer, '--agent-engine=v2'] })).toEqual(['--agent-engine=v2'])
  })

  it('chat pool: leaves model/effort off by default (server auto-routes)', async () => {
    expect(await chatArgv({ args: [mockServer] })).toEqual(['--agent-engine', 'v3'])
  })

  it('chat pool: appends --model / --effort when configured', async () => {
    expect(await chatArgv({ args: [mockServer], model: 'glm-5', effort: 'high' }))
      .toEqual(['--agent-engine', 'v3', '--model', 'glm-5', '--effort', 'high'])
  })

  it('chat pool: does not duplicate a user-supplied --model', async () => {
    expect(await chatArgv({ args: [mockServer, '--model', 'mine'], model: 'glm-5' }))
      .toEqual(['--model', 'mine', '--agent-engine', 'v3'])
  })

  it('one-shot provider: appends --model / --effort when configured', async () => {
    expect(await oneShotArgv({ args: [mockServer], model: 'claude-opus-5.5', effort: 'max' }))
      .toEqual(['--agent-engine', 'v3', '--model', 'claude-opus-5.5', '--effort', 'max'])
  })
})

describe('session effort on ACP backends (kiro v3 effortLevel)', () => {
  /** Chat argv plus the `set_config_option` lines the mock recorded for that chat's process. */
  async function chatWithConfigLog(config: Record<string, unknown>): Promise<{ argv: string[]; configLines: string[] }> {
    const dir = mkdtempSync(join(tmpdir(), 'acp-resume-effort-'))
    dirs.push(dir)
    const log = join(dir, 'set-config.log')
    const argv = await chatArgv({ ...config, env: { MOCK_ECHO_ARGV: '1', MOCK_SET_CONFIG_FILE: log } })
    return { argv, configLines: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [] }
  }

  it("modelSelect 'session' + effort: no --effort flag, one set_config_option(effortLevel) after open", async () => {
    const { argv, configLines } = await chatWithConfigLog({ args: [mockServer], modelSelect: 'session', effort: 'xhigh' })
    expect(argv).toEqual(['--agent-engine', 'v3'])
    expect(configLines).toHaveLength(1)
    expect(configLines[0]).toMatch(/^set_config_option \S+ effortLevel xhigh$/)
  })

  it("modelSelect 'flag' keeps --effort as a flag and sends no effortLevel; no effort sends nothing", async () => {
    const flag = await chatWithConfigLog({ args: [mockServer], effort: 'high' })
    expect(flag.argv).toEqual(['--agent-engine', 'v3', '--effort', 'high'])
    expect(flag.configLines).toEqual([])
    const unset = await chatWithConfigLog({ args: [mockServer], modelSelect: 'session' })
    expect(unset.argv).toEqual(['--agent-engine', 'v3'])
    expect(unset.configLines).toEqual([])
  })

  it('rejects a session-mode effort outside low|medium|high|xhigh|max at load; flag mode and Codex keep their own values', async () => {
    const base = { command: process.execPath, args: [mockServer], registryPath: join(mkdtempSync(join(tmpdir(), 'acp-resume-effort-')), 'registry.json'), discoverBackends: false }
    await expect(Promise.resolve((await host()).plugin(acp, { ...base, modelSelect: 'session', effort: 'ultra' })))
      .rejects.toThrow('acp-resume: effort "ultra" is not a session effort level; with modelSelect: session it must be one of low, medium, high, xhigh, max')
    await expect(Promise.resolve((await host()).plugin(acp, { ...base, backends: { kiro: { command: 'kiro-cli', args: ['acp'], modelSelect: 'session', effort: 'High' } } })))
      .rejects.toThrow('acp-resume: backends.kiro.effort "High" is not a session effort level')
    const accepted = await (await host()).plugin(acp, { ...base, effort: 'ultra', backends: { codex: { command: 'codex', protocol: 'codex', model: 'gpt-x', modelSelect: 'session', effort: 'ultra' } } })
    cleanups.push(() => accepted.dispose())
  })
})
