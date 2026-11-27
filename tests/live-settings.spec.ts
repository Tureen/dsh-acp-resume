/** Save one volatile field through rc.5 Settings and ConfigEditor while a real pool turn is held. */
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { initProfile, mountRootInclude, readProfilePatches } from '@deepseek-ai/dsh-app-boot'
import { SessionId } from '@deepseek-ai/dsh-session'
import { parse, stringify } from 'yaml'
import { expect, it, vi } from 'vitest'
import { dispatcherHost, golden } from './helpers/dispatcher-host.ts'
import { buildDispatcherPreset, Config, dispatcherValues } from '../src/dispatcher-preset.ts'

const main = 'subagent-acp-resume'
const declaration = 'acp-dispatcher-settings'
const req = createRequire(import.meta.url)
const settingsPath = createRequire(req.resolve('@deepseek-ai/dsh-agent-preset-registry')).resolve('@deepseek-ai/dsh-settings')
const editorPath = createRequire(settingsPath).resolve('@deepseek-ai/dsh-config-editor')
const mock = fileURLToPath(new URL('./mock-acp-server.ts', import.meta.url))
const changes = [
  ['defaultBackend', 'alternate'], ['roles', false], ['workflow', true], ['allowChatJobWait', true],
  ['allowUnverifiedBackends', true], ['idleTimeoutMs', 90_000], ['probeTimeoutMs', 9000],
  ['dispatcherTools.readOnlyFs', true], ['dispatcherTools.web', false], ['dispatcherTools.present', false],
  ['dispatcherTools.todo', false], ['dispatcherTools.askUser', false], ['dispatcherTools.compaction', false],
  ['dispatcherPrompt.extraRules', 'Share findings.'], ['dispatcherPrompt.overrideRules', true],
] as const

async function fixture(extraMain: Record<string, unknown> = {}) {
  const { ctx, dir } = await dispatcherHost()
  const home = join(dir, 'home'), profileDir = join(home, 'profiles', 'test'), patchPath = join(profileDir, 'cordis.patch.yml')
  const bundle = 'test-settings-bundle'
  initProfile(profileDir, [bundle])
  const pkg = join(profileDir, 'node_modules', bundle)
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(home, 'package.json'), '{"name":"temporary-installation"}')
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: bundle, version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  const hold = join(dir, 'hold')
  const extraEnv = (extraMain.env as Record<string, string> | undefined) ?? {}
  const { env: _ignoredEnv, ...restMain } = extraMain
  const rows = [
    { id: main, name: 'dsh-acp-resume', config: { command: process.execPath, args: [mock], agentEngine: 'none', discoverBackends: false,
      backends: { alternate: { command: process.execPath, args: [mock] } }, defaultBackend: 'default',
      probeTimeoutMs: 4000, registryPath: join(dir, 'registry.json'), ...restMain,
      env: { MOCK_PROMPT_HOLD: hold, MOCK_TEXT: 'saved', ...extraEnv } } },
    { id: declaration, name: 'dsh-acp-resume/dispatcher-preset', config: { dispatcherPrompt: { extraRules: 'Original rule.' } } },
  ]
  writeFileSync(join(pkg, 'cordis.patch.yml'), stringify([{ insert: rows.map(row => ({ id: row.id, name: row.name })) }]))
  writeFileSync(patchPath, '# Temporary profile\n' + stringify(rows))
  const configPath = join(profileDir, 'cordis.yml')
  writeFileSync(configPath, '[]\n')
  const profile = { name: 'test', dir: profileDir, patchPath, home, cwd: dir, installAnchor: join(home, 'package.json'), startedBundles: [bundle], overlays: [] }
  ctx.provide('profileContext', profile)
  ctx.provide('appReady', { onReady: f => { f(); return () => {} } })
  if (!ctx.get('jobs')) ctx.provide('jobs', {} as never)
  await ctx.plugin((await import(pathToFileURL(editorPath).href)).default)
  await ctx.plugin((await import(pathToFileURL(settingsPath).href)).default)
  await mountRootInclude(ctx, configPath, readProfilePatches('dsh', profile))
  await ctx.loader.await()
  return { ctx, dir, hold, patchPath }
}

it.each(changes)('saves %s without remounting the pool or interrupting the turn', async (field, value) => {
  const { ctx, dir, hold, patchPath } = await fixture()
  const dispatcher = field.includes('.'), ns = dispatcher ? declaration : main
  const path = field.split('.')
  const entry = () => ctx.loader.resolve('include:' + main)
  const fiber = entry().fiber
  const panel = ctx.get('acpResume')!
  const pool = panel['pool']
  const disposed = vi.spyOn(pool, 'disposeAll')
  const bind = async (name: string) => {
    const { agent } = await ctx.agents.create({ sessionId: SessionId(name), meta: { cwd: dir } })
    await ctx.agentPresets.select(agent, golden.id)
    return agent
  }
  const old = await bind('before')
  const oldTools = ctx.tools.schemas(old).map(tool => tool.name)
  const oldGeneration = ctx.agentPresets['generationFor'](old.ctx)
  const { chatId, remoteSessionId } = await pool.start(dir)
  writeFileSync(hold, '')
  const turn = pool.send(chatId, 'test')
  try {
    expect(panel.list()[0]?.inFlight?.chatId).toBe(chatId)
    const before = parse(readFileSync(patchPath, 'utf8'))
    const target = before.find(row => row.id === ns).config
    if (path.length === 1) target[field] = value
    else (target[path[0]] ??= {})[path[1]] = value
    const describe = () => ctx.settings.describe().find(row => row.ns === ns)!
    const revision = describe().revision
    await ctx.settings.mutate(ns, [{ op: 'set', path, value }], revision)
    expect(parse(readFileSync(patchPath, 'utf8'))).toEqual(before)
    expect(describe().revision).toBeGreaterThan(revision)
    expect(path.reduce((node, key) => node[key], describe().value)).toBe(value)
    expect(entry().fiber === fiber && ctx.get('acpResume')!['pool'] === pool).toBe(true)
    expect(disposed).not.toHaveBeenCalled()
    expect(panel.list()[0]?.inFlight?.chatId).toBe(chatId)
    if (dispatcher) {
      const { tools, prompt } = dispatcherValues(Config(target))
      const expected = buildDispatcherPreset(tools, prompt)
      await vi.waitFor(async () => {
        const doc = await ctx.agentPresets.readDocument(golden.id)
        expect(doc.description).toBe(expected.description)
        const children = parse(doc.content, { logLevel: 'silent' })
        expect(children.map(row => row.id)).toEqual(expected.plugins.map(row => row.id))
        expect(children[0].config.prefix).toBe(expected.plugins[0].config.prefix)
      })
      expect(ctx.agentPresets['generationFor'](old.ctx) === oldGeneration).toBe(true)
      expect(ctx.tools.schemas(old).map(tool => tool.name)).toEqual(oldTools)
      const next = await bind('after')
      expect(ctx.agentPresets['generationFor'](next.ctx) === oldGeneration).toBe(false)
    } else {
      const service = pool['opts'].dispatch
      if (field === 'defaultBackend') expect((await service.route()).backend).toBe('alternate')
      if (field === 'roles') await vi.waitFor(() => expect(ctx.tools.get('acp_team_list', old)).toBeUndefined())
      if (field === 'workflow') await vi.waitFor(() => expect(!!ctx.tools.get('acp_workflow', old)).toBe(true))
      if (field === 'allowChatJobWait') await vi.waitFor(() => {
        const tool = ctx.tools.get('acp_chat_send', old)
        expect(!!tool).toBe(true)
        expect(tool!.description).not.toContain('job_output with wait on a running turn is refused')
      })
      if (field === 'allowUnverifiedBackends') expect(service.admittedRow({ automatic: true, compatibility: 'unverified-version', readiness: 'ready' }).readiness).toBe('ready')
      if (field === 'probeTimeoutMs') expect(service.options.timeoutMs).toBe(value)
    }
  } finally { rmSync(hold, { force: true }); await turn }
  expect(await turn).toMatchObject({ remoteSessionId, output: 'saved', stopReason: 'completed' })
  expect(disposed).not.toHaveBeenCalled()
  if (field === 'idleTimeoutMs') expect(pool['live'].get(chatId)?.idleTimer?._idleTimeout).toBe(value)
}, 15_000)

it('preserves accepted settings on conflicts, forbidden paths and invalid combinations', async () => {
  const { ctx, patchPath } = await fixture()
  const revision = ctx.settings.describe().find(row => row.ns === main)!.revision
  await ctx.settings.mutate(main, [{ op: 'set', path: ['roles'], value: false }], revision)
  const before = readFileSync(patchPath, 'utf8')
  await expect(ctx.settings.mutate(main, [{ op: 'set', path: ['probeTimeoutMs'], value: 50 }], revision)).rejects.toThrow('changed since it was read')
  await expect(ctx.settings.mutate(main, [{ op: 'set', path: ['command'], value: 'another' }])).rejects.toThrow('is not volatile')
  await expect(ctx.settings.mutate(main, [{ op: 'set', path: ['workflow'], value: true }])).rejects.toThrow('workflow: true requires roles: true')
  await expect(ctx.settings.mutate(main, [{ op: 'set', path: ['backendDefaults', 'default', 'effort'], value: 'bogus' }])).rejects.toThrow('is not a valid effort level')
  expect(readFileSync(patchPath, 'utf8')).toBe(before)
})

it('updates backendDefaults live without remounting the pool, finishes in-flight turns, and applies to new and reconnected chats (D48)', async () => {
  const logName = 'd48-requests.log'
  const storeName = 'd48-sessions.json'
  const { ctx, dir, hold, patchPath } = await fixture({
    modelSelect: 'session',
    model: 'static-model',
    effort: 'low',
    backends: {
      alternate: { command: process.execPath, args: [mock], agentEngine: 'none', modelSelect: 'session' },
      agy: { command: 'agy', args: ['acp'], agentEngine: 'none', modelSelect: 'session' },
    },
  })
  const log = join(dir, logName)
  const store = join(dir, storeName)
  const entry = () => ctx.loader.resolve('include:' + main)
  const fiber = entry().fiber
  const panel = ctx.get('acpResume')!
  const pool = panel['pool']
  const disposed = vi.spyOn(pool, 'disposeAll')
  // Attach mock log/store env to the default backend spec so every spawned process records its startup RPCs.
  pool['backends'].get('default')!.specBase.env.MOCK_SET_MODEL_FILE = log
  pool['backends'].get('default')!.specBase.env.MOCK_SET_CONFIG_FILE = log
  pool['backends'].get('default')!.specBase.env.MOCK_SESSION_STORE = store

  const releasedChat = await pool.start(dir)
  await pool.close(releasedChat.chatId)
  const activeChat = await pool.start(dir)

  writeFileSync(hold, '')
  const inFlightTurn = pool.send(activeChat.chatId, 'in-flight-work')
  const describe = () => ctx.settings.describe().find(row => row.ns === main)!
  try {
    expect(panel.list().find(row => row.chatId === activeChat.chatId)?.inFlight?.chatId).toBe(activeChat.chatId)
    const rev = describe().revision
    await ctx.settings.mutate(main, [
      { op: 'set', path: ['backendDefaults', 'default', 'model'], value: 'live-model' },
      { op: 'set', path: ['backendDefaults', 'default', 'effort'], value: 'xhigh' },
    ], rev)
    expect(entry().fiber === fiber && ctx.get('acpResume')!['pool'] === pool).toBe(true)
    expect(disposed).not.toHaveBeenCalled()
    expect(panel.list().find(row => row.chatId === activeChat.chatId)?.inFlight?.chatId).toBe(activeChat.chatId)
    expect(describe().value.backendDefaults).toEqual({ default: { model: 'live-model', effort: 'xhigh' } })
    const beforeReject = readFileSync(patchPath, 'utf8')
    await expect(ctx.settings.mutate(main, [{ op: 'set', path: ['backendDefaults', 'agy', 'effort'], value: 'max' }], describe().revision))
      .rejects.toThrow('is not a valid effort level for agy')
    expect(readFileSync(patchPath, 'utf8')).toBe(beforeReject)
  } finally {
    rmSync(hold, { force: true })
  }
  expect(await inFlightTurn).toMatchObject({ remoteSessionId: activeChat.remoteSessionId, output: 'saved', stopReason: 'completed' })
  expect(disposed).not.toHaveBeenCalled()

  // New chat uses live backendDefaults instead of static model/effort.
  writeFileSync(log, '')
  const freshChat = await pool.start(dir)
  expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
    `set_model ${freshChat.remoteSessionId} live-model`,
    `set_config_option ${freshChat.remoteSessionId} effortLevel xhigh`,
  ])

  // Released chat reconnects with live backendDefaults.
  writeFileSync(log, '')
  const reconnected = await pool.send(releasedChat.chatId, 'after-update')
  expect(reconnected).toMatchObject({ remoteSessionId: releasedChat.remoteSessionId, freshSession: false, stopReason: 'completed' })
  expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
    `set_model ${releasedChat.remoteSessionId} live-model`,
    `set_config_option ${releasedChat.remoteSessionId} effortLevel xhigh`,
  ])

  // Clearing backendDefaults.default falls back to static model/effort.
  await ctx.settings.mutate(main, [{ op: 'unset', path: ['backendDefaults', 'default'] }], describe().revision)
  writeFileSync(log, '')
  const fallbackChat = await pool.start(dir)
  expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
    `set_model ${fallbackChat.remoteSessionId} static-model`,
    `set_config_option ${fallbackChat.remoteSessionId} effortLevel low`,
  ])
  expect(disposed).not.toHaveBeenCalled()
}, 15_000)
