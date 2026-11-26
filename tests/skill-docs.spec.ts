/** D39: package discovery across Agent scopes and the integrity of the installed manual. */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import * as main from '../src/index.ts'
import * as dispatcher from '../src/dispatcher-preset.ts'
import { dispatcherHost, golden } from './helpers/dispatcher-host.ts'

const pkg = fileURLToPath(new URL('../', import.meta.url))
const manual = join(pkg, 'skills/acp-resume-docs')
const entry = readFileSync(join(manual, 'SKILL.md'), 'utf8')
const globalRow = loadOverlayPatches('dsh', join(pkg, 'cordis.patch.yml')).flatMap(p => p.insert ?? [])
  .find(row => row.id === 'acp-resume-skill-filesystem')!

async function readDocs(ctx: Awaited<ReturnType<typeof dispatcherHost>>['ctx'], dir: string, preset: string) {
  const { agent } = await ctx.agents.create({ sessionId: SessionId('docs-' + preset), meta: { cwd: dir } })
  await ctx.agentPresets.select(agent, preset)
  const catalog = await ctx.skills.list({ cwd: dir, scope: agent })
  expect(catalog).toContainEqual(expect.objectContaining({ name: 'acp-resume-docs', source: 'custom', provider: 'acp-resume-docs' }))
  const { results } = await ctx.tools.execute({
    agent, signal: new AbortController().signal,
    calls: [{ type: 'tool-call', id: ToolCallId('docs'), name: 'skill', arguments: JSON.stringify({ name: 'acp-resume-docs' }) }],
  })
  expect(results[0]!.result.isError).toBeFalsy()
  const body = results[0]!.result.content.map(block => block.type === 'text' ? block.text : '').join('\n')
  return { agent, catalog, body }
}

it('discovers and loads the global manual alongside official and user skills in standard mode', async () => {
  const { ctx, dir } = await dispatcherHost()
  const userDir = join(dir, 'agents/skills/local-note')
  mkdirSync(userDir, { recursive: true })
  writeFileSync(join(userDir, 'SKILL.md'), '---\nname: local-note\ndescription: Fixture for user skill discovery.\n---\n\n# Note\n')
  const official = dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-agent-preset/package.json'))
  await ctx.loader.root.update([globalRow, { id: 'preset-standard', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'standard', plugins: [
    { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem', config: { customSkillDirs: [join(official, 'skills')] } },
    { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
  ] } }])
  const { catalog, body } = await readDocs(ctx, dir, 'standard')
  expect(catalog.map(row => row.name).sort()).toEqual(['acp-resume-docs', 'dsh-doc', 'local-note'])
  for (const fact of ['cordis.patch.yml', '顶层', 'readOnlyFs: false', 'web: true', 'present: true', 'todo: true',
    'askUser: true', 'compaction: true', 'dispatcherPrompt', 'overrideRules', 'cannot dispatch']) expect(body).toContain(fact)
})

it('loads the same global manual from the read-only Dispatcher scope', async () => {
  const { ctx, dir } = await dispatcherHost()
  await ctx.loader.root.update([globalRow, { id: 'settings', name: 'dsh-acp-resume/dispatcher-preset', config: { dispatcherTools: { readOnlyFs: true } } }])
  const { agent, body } = await readDocs(ctx, dir, golden.id)
  expect(body).toContain('# ACP Resume 使用文档')
  const { results } = await ctx.tools.execute({
    agent, signal: new AbortController().signal,
    calls: [{ type: 'tool-call', id: ToolCallId('read-reference'), name: 'read',
      arguments: JSON.stringify({ file_path: join(manual, 'references/configuration.md') }) }],
  })
  expect(results[0]!.result.isError).toBeFalsy()
  expect(JSON.stringify(results[0]!.result.content)).toContain('disposeEofGraceMs')
})

it('opens the four read-only rows together and warns when only the deprecated switch was requested', async () => {
  const { ctx } = await dispatcherHost()
  const ids = golden.plugins.map((row: { id: string }) => row.id)
  ids.splice(ids.indexOf('present'), 0, 'tool-fs', 'tool-fs-search', 'skill-filesystem', 'tool-skill')
  const enabled = dispatcher.Config({ dispatcherTools: { readOnlyFs: true, skill: false } })
  expect(dispatcher.buildDispatcherPreset(enabled.dispatcherTools).plugins.map(row => row.id)).toEqual(ids)
  const warnings: string[] = []
  ctx.logger.exporter({ export(m) { if (m.type === 'warn') warnings.push(...m.args.map(String)) } })
  await ctx.loader.root.update([{ id: 'settings', name: 'dsh-acp-resume/dispatcher-preset', config: { dispatcherTools: { skill: true } } }])
  expect(warnings.join('\n')).toContain('dispatcherTools.skill is deprecated')
  expect((await ctx.agentPresets.readDocument(golden.id)).content).not.toContain('dsh-tool-skill')
})

it('routes every shipped reference and template from a valid entry and has no dangling local links', () => {
  const front = parse(/^---\n([\s\S]+?)\n---/u.exec(entry)![1]!)
  expect(front.name).toBe('acp-resume-docs')
  expect(front.description.trim().length).toBeGreaterThan(0)
  for (const [subdir, count] of [['references', 7], ['templates', 1]] as const) {
    const files = readdirSync(join(manual, subdir))
    expect(files).toHaveLength(count)
    for (const file of files) {
      const rel = subdir + '/' + file
      expect(entry).toContain('](' + rel + ')')
      const content = readFileSync(join(manual, rel), 'utf8')
      expect(content.trim()).not.toBe('')
      for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
        expect(readFileSync(join(manual, subdir, match[1]!), 'utf8').length).toBeGreaterThan(0)
      }
    }
  }
})

it('parses each copyable profile as top-level row overrides with complete schema-valid configs', () => {
  const recipes = readFileSync(join(manual, 'references/recipes.md'), 'utf8')
  const samples = [...recipes.matchAll(/^`{3}yaml\n([\s\S]*?)^`{3}$/gm)].map(match => match[1]!)
  expect(samples.length).toBeGreaterThanOrEqual(3)
  samples.push(readFileSync(join(manual, 'templates/profile-override.yml'), 'utf8'))
  for (const sample of samples) {
    const rows = parse(sample)
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      if (row.id === 'subagent-acp-resume') {
        expect(row.name).toBe('dsh-acp-resume')
        expect(row.config.command).toBeTruthy()
        expect(main.Config(row.config).command).toBe(row.config.command)
      } else {
        expect(row.id).toBe('acp-dispatcher-settings')
        expect(row.name).toBe('dsh-acp-resume/dispatcher-preset')
        const config = dispatcher.Config(row.config)
        expect(dispatcher.buildDispatcherPreset(config.dispatcherTools, config.dispatcherPrompt).id).toBe(golden.id)
      }
    }
  }
})
