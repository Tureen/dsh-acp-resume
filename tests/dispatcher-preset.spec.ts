/** D37: compare with the shipped D36 declaration and exercise rc.5 profile composition and preset revisions.
 * @module dsh-acp-resume/tests/dispatcher-preset
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader, { EntryTree, Group } from '@deepseek-ai/cordis-plugin-loader'
import Registry, { type PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { auditStartupEntries, mountRootInclude } from '@deepseek-ai/dsh-app-boot'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as Persona from '@deepseek-ai/dsh-persona'
import { SessionId } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import Subs from '@deepseek-ai/dsh-subagent'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import * as FsTools from '@deepseek-ai/dsh-tool-fs'
import * as FsSearch from '@deepseek-ai/dsh-tool-fs-search'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import { expect, it, onTestFinished, vi } from 'vitest'
import { parse } from 'yaml'
import * as dispatcher from '../src/dispatcher-preset.ts'
import * as acp from '../src/index.ts'

const golden = JSON.parse(readFileSync(new URL('./fixtures/dispatcher-preset-46978eb.json', import.meta.url), 'utf8'))
const bundle = parse(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'))
const declarationId = 'acp-dispatcher-settings'
const defaultTools = dispatcher.Config({}).dispatcherTools
type Tools = typeof defaultTools

function preset(changes: Partial<Tools>) {
  return dispatcher.buildDispatcherPreset(dispatcher.Config({ dispatcherTools: changes }).dispatcherTools)
}

function prefix(definition: PresetDefinition): string {
  return definition.plugins.find(row => row.id === 'persona')!.config.prefix
}

it('preserves the published persona, defaults, row order, parameters and isolation exactly', () => {
  expect(defaultTools).toEqual({ readOnlyFs: false, web: true, present: true, todo: true, askUser: true, skill: false, compaction: true })
  expect(preset({})).toEqual(golden)
  expect(dispatcher.buildDispatcherPreset()).toEqual(golden)
})

it.each([
  ['web', 'tool-web', '联网查询交给 Worker', 'For lightweight fact-checking'],
  ['present', 'present', '交付物在对话中说明', 'Report deliverables'],
  ['todo', 'tool-todo', '任务清单工具已关闭', 'Track outstanding tasks'],
  ['askUser', 'tool-ask-user', '直接在对话中提问', 'ask in the conversation'],
  ['compaction', 'compaction', '上下文压缩组已关闭', 'compaction group is disabled'],
] as const)('turns %s off and back on with matching rows and instructions', (flag, id, summary, instruction) => {
  const off = preset({ [flag]: false })
  expect(off.plugins.slice(1)).toEqual(golden.plugins.slice(1).filter((row: { id: string }) => row.id !== id))
  expect(off.description).toContain(summary)
  expect(prefix(off).includes(instruction)).toBe(flag !== 'web')
  expect(prefix(off)).not.toContain('When coordinating named roles')
  expect(preset({ [flag]: true })).toEqual(golden)
})

it('limits read-only file verification to the two allowlisted rows and keeps web independent', () => {
  const both = preset({ readOnlyFs: true, web: false })
  expect(both.plugins.filter(row => row.id?.startsWith('tool-fs'))).toEqual([
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', config: { read: true, readImage: false, write: false, edit: false, applyPatch: false } },
    { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
  ])
  expect(both.plugins.map(row => row.id)).toEqual([
    'persona', 'agent-instructions', 'time-context', 'tool-jobs', 'tool-todo', 'tool-ask-user', 'tool-fs', 'tool-fs-search', 'present', 'compaction',
  ])
  expect(both.description).toContain('read/grep/glob 核对结果，无 bash，不改文件')
  expect(both.description).toContain('联网查询交给 Worker')
  expect(prefix(both)).toContain('Use read, grep, and glob to verify worker results.')
  expect(prefix(both)).not.toMatch(/no file operations|use web tools directly/)
})

it('inserts only the skill provider and tool between present and compaction when enabled', () => {
  expect(preset({ skill: false })).toEqual(golden)
  const enabled = preset({ skill: true })
  const ids = golden.plugins.map((row: { id: string }) => row.id)
  ids.splice(ids.indexOf('present') + 1, 0, 'skill-filesystem', 'tool-skill')
  expect(enabled.plugins.map(row => row.id)).toEqual(ids)
  expect(enabled.description).toBe(golden.description + '可加载 skill。')
  expect(prefix(enabled)).toContain('When a task matches an available skill’s description, load that skill before acting.')
  expect(prefix(enabled)).not.toContain('dsh-doc')
})

async function host() {
  const dir = mkdtempSync(join(tmpdir(), 'acp-dispatcher-'))
  const ctx = new Context()
  const originalImport = EntryTree.prototype.import
  // The unrelated preset children need no CLI or account. Use real modules for the
  // declaration, persona, file and skill tools, ACP provider and Cordis Include/group.
  const passive = new Set(golden.plugins.flatMap((row: { group?: boolean; config?: { name: string }[]; name: string }) =>
    row.group ? row.config!.map(child => child.name) : [row.name]))
  const skillFilesystemApply = vi.fn(SkillFilesystem.apply)
  const modules = new Map<string, unknown>([
    ['dsh-acp-resume/dispatcher-preset', dispatcher], ['dsh-acp-resume', acp],
    ['@deepseek-ai/dsh-persona', Persona], ['@deepseek-ai/dsh-tool-fs', FsTools], ['@deepseek-ai/dsh-tool-fs-search', FsSearch],
    ['@deepseek-ai/dsh-skill-filesystem', { ...SkillFilesystem, apply: skillFilesystemApply }], ['@deepseek-ai/dsh-tool-skill', ToolSkill],
  ])
  const imports = vi.spyOn(EntryTree.prototype, 'import').mockImplementation(function (this: EntryTree, name, stack) {
    if (modules.has(name)) return modules.get(name)
    if (passive.has(name)) return { apply() {} }
    return originalImport.call(this, name, stack)
  })
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() } finally {
      imports.mockRestore()
      rmSync(dir, { recursive: true, force: true })
    }
  })
  ctx.baseUrl = pathToFileURL(dir + '/').href
  await ctx.plugin(Loader)
  ctx.loader.builtins.group = Group
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(Subs)
  await ctx.plugin(LocalSubprocess)
  await ctx.plugin(Registry, { default: 'acp-dispatcher' })
  const mainOverride = { id: 'subagent-acp-resume', config: { command: 'fixture-acp', discoverBackends: false, registryPath: join(dir, 'registry.json') } }
  return { ctx, dir, mainOverride, skillFilesystemApply }
}

it('resolves the installed preset skills from the Loader baseUrl and loads dsh-doc through the Agent skill tool', async () => {
  const { ctx, dir, skillFilesystemApply } = await host()
  // Give the temporary profile its own dependency resolution base and isolated skill homes.
  const presetDir = dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-agent-preset/package.json'))
  const packages = join(dir, 'node_modules', '@deepseek-ai')
  mkdirSync(packages, { recursive: true })
  symlinkSync(presetDir, join(packages, 'dsh-agent-preset'), 'junction')
  vi.stubEnv('DSH_HOME', join(dir, 'dsh'))
  vi.stubEnv('DSH_AGENTS_HOME', join(dir, 'agents'))
  vi.stubEnv('DSH_BUNDLED_SKILL_DIR', undefined)
  onTestFinished(() => { vi.unstubAllEnvs() })
  await ctx.plugin(SkillRegistry)
  await ctx.loader.root.update([{ id: declarationId, name: 'dsh-acp-resume/dispatcher-preset', config: { dispatcherTools: { skill: true } } }])
  await ctx.loader.await()
  const { agent } = await ctx.agents.create({ sessionId: SessionId('skills-enabled'), meta: { cwd: dir } })
  await ctx.agentPresets.select(agent, golden.id)
  expect(ctx.tools.schemas(agent).map(t => t.name)).toContain('skill')
  const root = join(presetDir, 'skills')
  expect(skillFilesystemApply).toHaveBeenCalledTimes(1)
  expect(skillFilesystemApply.mock.calls[0]![1]?.customSkillDirs).toEqual([root])
  expect(statSync(root).isDirectory()).toBe(true)
  expect(await ctx.skills.list({ cwd: dir, scope: agent })).toContainEqual(expect.objectContaining({
    name: 'dsh-doc', source: 'custom', path: join(root, 'dsh-doc', 'SKILL.md'),
  }))
  const { results } = await ctx.tools.execute({
    agent, signal: new AbortController().signal,
    calls: [{ type: 'tool-call', id: ToolCallId('load-doc'), name: 'skill', arguments: JSON.stringify({ name: 'dsh-doc' }) }],
  })
  expect(results[0]!.result.isError).toBeFalsy()
  expect(results[0]!.result.content).toContainEqual({ type: 'text', text: expect.stringContaining('# DeepSeek Harness documentation') })
})

it('logs an orphaned old override and still mounts the migrated profile with one selectable default declaration', async () => {
  const { ctx, dir, mainOverride } = await host()
  const configPath = join(dir, 'cordis.yml')
  writeFileSync(configPath, '[]\n')
  ctx.provide('profileContext', { name: 'migration', dir, home: dir, cwd: dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(dir, 'package.json'), startedBundles: [], overlays: [], telemetryDisabledEnv: undefined })
  const warnings: unknown[] = []
  ctx.logger.exporter({ export(message) { if (message.type === 'warn') warnings.push(...message.args) } })
  const orphan = { id: 'preset-acp-dispatcher', name: '@deepseek-ai/dsh-agent-preset',
    config: { ...golden, plugins: preset({ readOnlyFs: true }).plugins } }
  await mountRootInclude(ctx, configPath, [...bundle, mainOverride, orphan])
  await ctx.loader.await()
  await auditStartupEntries(ctx, 'dsh')
  expect(warnings).toContain('patch: entry "preset-acp-dispatcher" not found')
  expect(ctx.loader.resolve('include:' + declarationId).options.name).toBe('dsh-acp-resume/dispatcher-preset')
  expect(ctx.subagents.getProvider('acp-resume')).toBeDefined()
  expect(await ctx.agentPresets.list()).toEqual([{ id: golden.id, name: golden.name, order: 10, description: golden.description }])
  const { agent } = await ctx.agents.create({ sessionId: SessionId('migrated') })
  await ctx.agentPresets.select(agent, golden.id)
  expect(ctx.tools.get('acp_chat_start', agent)).toBeDefined()
  expect(ctx.tools.get('read', agent)).toBeUndefined()
})

it('reloads only the declaration; new Agents gain exactly glob/grep/read and an existing Agent keeps its tools', async () => {
  const { ctx, mainOverride } = await host()
  const rows = bundle.flatMap((patch: { insert: object[] }) => patch.insert)
  await ctx.loader.root.update(rows.map((row: { id: string }) => row.id === mainOverride.id ? { ...row, config: mainOverride.config } : row))
  expect(await ctx.agentPresets.list()).toEqual([{ id: golden.id, name: golden.name, description: golden.description, order: 10 }])
  const owner = ctx.loader.resolve(mainOverride.id).fiber
  const select = async (id: string) => {
    const { agent } = await ctx.agents.create({ sessionId: SessionId(id) })
    await ctx.agentPresets.select(agent, golden.id)
    return agent
  }
  const first = await select('before')
  const names = (agent: typeof first) => ctx.tools.schemas(agent).map(tool => tool.name).sort()
  const before = names(first)
  expect(before).toContain('acp_chat_start')
  expect(before).not.toContain('read')
  await ctx.loader.update(declarationId, { config: { dispatcherTools: { readOnlyFs: true } } })
  await ctx.loader.await()
  expect(await ctx.agentPresets.list()).toEqual([{ id: golden.id, name: golden.name, order: 10, description: preset({ readOnlyFs: true }).description }])
  expect(ctx.loader.resolve(mainOverride.id).fiber).toBe(owner)
  expect(names(first)).toEqual(before)
  expect(names(await select('after'))).toEqual([...before, 'glob', 'grep', 'read'].sort())
})
