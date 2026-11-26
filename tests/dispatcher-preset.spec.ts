/** D37: compare with the shipped D36 declaration and exercise rc.5 profile composition and preset revisions.
 * @module dsh-acp-resume/tests/dispatcher-preset
 */
import { statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { auditStartupEntries, loadOverlayPatches, mountRootInclude } from '@deepseek-ai/dsh-app-boot'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { expect, it } from 'vitest'
import * as dispatcher from '../src/dispatcher-preset.ts'
import { dispatcherHost as host, golden } from './helpers/dispatcher-host.ts'
import { fileURLToPath } from 'node:url'

const bundle = loadOverlayPatches('dsh', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))
const declarationId = 'acp-dispatcher-settings'
const defaultTools = dispatcher.Config({}).dispatcherTools
type Tools = typeof defaultTools

function preset(changes: Partial<Tools>, prompt?: Partial<ReturnType<typeof dispatcher.Config>['dispatcherPrompt']>) {
  const config = dispatcher.Config({ dispatcherTools: changes, dispatcherPrompt: prompt })
  return dispatcher.buildDispatcherPreset(config.dispatcherTools, config.dispatcherPrompt)
}

function prefix(definition: PresetDefinition): string {
  return definition.plugins.find(row => row.id === 'persona')!.config.prefix
}

it('matches the reference definition including the intentional target-directory revision', () => {
  expect(defaultTools).toEqual({ readOnlyFs: false, web: true, present: true, todo: true, askUser: true, compaction: true })
  expect(preset({})).toEqual(golden)
  expect(dispatcher.buildDispatcherPreset()).toEqual(golden)
})

it('keeps the corrected built-in prefix byte-for-byte for omitted, blank and non-overriding settings', () => {
  for (const prompt of [undefined, {}, { extraRules: '' }, { extraRules: ' \n\t ' }, { overrideRules: false }]) {
    expect(prefix(preset({}, prompt))).toBe(prefix(golden))
  }
})

const userRules = 'Assign one owner per deliverable.\nAsk for the evidence before closing the task.'

it('appends trimmed user rules once after synthesis and preserves the selected tool guidance', () => {
  const tools = { readOnlyFs: true }
  const original = preset(tools)
  const configured = preset(tools, { extraRules: `\n${userRules}\n` })
  expect(prefix(configured)).toBe(prefix(original) + '\n\n' + userRules)
  expect(configured.description).toBe(original.description)
})

it('replaces dispatch procedure, target selection, shared writes and synthesis, retaining identity and tool guidance', () => {
  const tools = { readOnlyFs: true, present: false, todo: false, askUser: false, compaction: false }
  const configured = preset(tools, { overrideRules: true, extraRules: userRules })
  expect(prefix(configured)).toBe([
    'You are a task dispatcher.',
    'When clarification is needed, ask in the conversation.',
    'For lightweight fact-checking use web tools directly; delegate full research tasks to workers.',
    'Use read, grep, and glob to verify worker results. Load a matching skill before acting on its instructions. Delegate shell commands, file changes, and code analysis to workers.',
    'Report deliverables and their locations in the conversation.',
    'Track outstanding tasks in the conversation.',
    'Keep worker summaries concise because the Dispatcher compaction group is disabled.',
    '', userRules,
  ].join('\n'))
  expect(configured.description).toBe(preset(tools).description)
  expect(configured.plugins.slice(1)).toEqual(preset(tools).plugins.slice(1))
})

it('rejects an override without rules at plugin activation, before registration', async () => {
  const { ctx } = await host()
  for (const extraRules of [undefined, '', ' \n\t ']) {
    const config = dispatcher.Config({ dispatcherPrompt: { overrideRules: true, extraRules } })
    await expect(Promise.resolve(ctx.plugin(dispatcher, config))).rejects.toThrow('dispatcherPrompt.overrideRules requires nonempty extraRules')
  }
  expect(await ctx.agentPresets.list()).toEqual([])
})

it('renders user rules exactly once alongside the built-in persona and host sections through the rc.5 Loader', async () => {
  const { ctx, dir } = await host()
  ctx.systemPrompt.section({ name: 'test:host', order: 1, text: 'Host section remains visible.' })
  await ctx.loader.root.update([{ id: declarationId, name: 'dsh-acp-resume/dispatcher-preset',
    config: { dispatcherPrompt: { extraRules: userRules } } }])
  await ctx.loader.await()
  const { agent } = await ctx.agents.create({ sessionId: SessionId('custom-prompt'), meta: { cwd: dir } })
  await ctx.agentPresets.select(agent, golden.id)
  const text = renderPrompt(await ctx.systemPrompt.assemble(assembleContextFor(agent)))
  expect(text.split(userRules)).toHaveLength(2)
  expect(text).toContain(prefix(golden) + '\n\n' + userRules)
  expect(text).toContain('Host section remains visible.')
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
    'persona', 'agent-instructions', 'time-context', 'tool-jobs', 'tool-todo', 'tool-ask-user', 'tool-fs', 'tool-fs-search', 'skill-filesystem', 'tool-skill', 'present', 'compaction',
  ])
  expect(both.description).toContain('read/grep/glob 核对结果并加载 skill，无 bash，不改文件')
  expect(both.description).toContain('联网查询交给 Worker')
  expect(prefix(both)).toContain('Use read, grep, and glob to verify worker results.')
  expect(prefix(both)).not.toMatch(/no file operations|use web tools directly/)
})

it('ignores the deprecated skill flag in both directions', () => {
  expect(preset({ skill: true })).toEqual(golden)
  expect(preset({ readOnlyFs: true, skill: false })).toEqual(preset({ readOnlyFs: true }))
})

it('resolves the installed preset skills from the Loader baseUrl and loads dsh-doc through the Agent skill tool', async () => {
  const { ctx, dir, skillFilesystemApply } = await host()
  const presetDir = dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-agent-preset/package.json'))
  await ctx.loader.root.update([{ id: declarationId, name: 'dsh-acp-resume/dispatcher-preset', config: { dispatcherTools: { readOnlyFs: true } } }])
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

it('reloads only the declaration; new Agents gain exactly glob/grep/read and skill and an existing Agent keeps its tools', async () => {
  const { ctx, mainOverride } = await host()
  const rows = bundle.flatMap(patch => patch.insert ?? [])
  await ctx.loader.root.update(rows.map(row => row.id === mainOverride.id ? { ...row, config: mainOverride.config } : row))
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
  expect(names(await select('after'))).toEqual([...before, 'glob', 'grep', 'read', 'skill'].sort())
})
