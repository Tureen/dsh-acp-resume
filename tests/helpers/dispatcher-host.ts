/** Real rc.5 Loader with isolated profile roots for Dispatcher integration tests. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader, { EntryTree, Group } from '@deepseek-ai/cordis-plugin-loader'
import Registry from '@deepseek-ai/dsh-agent-preset-registry'
import Preset from '@deepseek-ai/dsh-agent-preset'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as Persona from '@deepseek-ai/dsh-persona'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import Subs from '@deepseek-ai/dsh-subagent'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import * as FsTools from '@deepseek-ai/dsh-tool-fs'
import * as FsSearch from '@deepseek-ai/dsh-tool-fs-search'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import { onTestFinished, vi } from 'vitest'
import * as dispatcher from '../../src/dispatcher-preset.ts'
import * as acp from '../../src/index.ts'

export const golden = JSON.parse(readFileSync(new URL('../fixtures/dispatcher-preset-46978eb.json', import.meta.url), 'utf8'))

export async function dispatcherHost() {
  const dir = mkdtempSync(join(tmpdir(), 'acp-dispatcher-'))
  const ctx = new Context()
  const originalImport = EntryTree.prototype.import
  // The unrelated preset children need no CLI or account. Use real modules for the
  // declaration, persona, file and skill tools, ACP provider and Cordis Include/group.
  const passive = new Set(golden.plugins.flatMap((row: { group?: boolean; config?: { name: string }[]; name: string }) =>
    row.group ? row.config!.map(child => child.name) : [row.name]))
  const skillFilesystemApply = vi.fn(SkillFilesystem.apply)
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent-preset', Preset], ['dsh-acp-resume/dispatcher-preset', dispatcher], ['dsh-acp-resume', acp],
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
  const packages = join(dir, 'node_modules')
  mkdirSync(join(packages, '@deepseek-ai'), { recursive: true })
  symlinkSync(dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-agent-preset/package.json')), join(packages, '@deepseek-ai/dsh-agent-preset'), 'junction')
  symlinkSync(fileURLToPath(new URL('../../', import.meta.url)), join(packages, 'dsh-acp-resume'), 'junction')
  vi.stubEnv('DSH_HOME', join(dir, 'dsh'))
  vi.stubEnv('DSH_AGENTS_HOME', join(dir, 'agents'))
  vi.stubEnv('DSH_BUNDLED_SKILL_DIR', undefined)
  onTestFinished(() => { vi.unstubAllEnvs() })
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(Registry, { default: 'acp-dispatcher' })
  const mainOverride = { id: 'subagent-acp-resume', config: { command: 'fixture-acp', discoverBackends: false, registryPath: join(dir, 'registry.json') } }
  return { ctx, dir, mainOverride, skillFilesystemApply }
}
