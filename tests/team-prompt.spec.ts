/** Render D36 against the published rc.5 Agent, registry, persona, tools and system prompt.
 * @module dsh-acp-resume/tests/team-prompt
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import PresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import * as Persona from '@deepseek-ai/dsh-persona'
import { SessionId } from '@deepseek-ai/dsh-session'
import Subs from '@deepseek-ai/dsh-subagent'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { parse } from 'yaml'
import { afterEach, expect, it } from 'vitest'
import * as acp from '../src/index.ts'
import { TEAM_INSTRUCTIONS } from '../src/team-prompt.ts'
import { mountWorkingDirectoryFixture } from './helpers/working-directory-fixture.ts'

const bundle = parse(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'))
const dispatcher = bundle.flatMap((patch: { insert: unknown[] }) => patch.insert)
  .find((row: { id: string }) => row.id === 'preset-acp-dispatcher').config
const persona = dispatcher.plugins.find((row: { name: string }) => row.name === '@deepseek-ai/dsh-persona')
let ctx: Context
let directory: string

async function setup(roles: boolean, workflow: boolean) {
  directory = mkdtempSync(join(tmpdir(), 'acp-team-prompt-'))
  ctx = new Context()
  ctx.baseUrl = pathToFileURL(directory + '/').href
  await ctx.plugin(Loader)
  ctx.loader.builtins.persona = Persona
  await mountAgentLoopTestDependencies(ctx)
  await mountAgentLoopTestHarness(ctx)
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(Subs)
  await ctx.plugin(LocalSubprocess)
  await ctx.plugin(PresetRegistry, { default: dispatcher.id })
  await ctx.plugin({ inject: ['agentPresets'], async *apply(scope: Context) {
    yield await scope.agentPresets.register({ id: dispatcher.id, plugins: [{ ...persona, name: 'cordis:persona' }] })
    yield await scope.agentPresets.register({ id: 'standard', plugins: [] })
  } })
  await ctx.plugin(acp, {
    providerName: 'acp-resume', command: 'fixture-acp', args: [], env: {}, agentEngine: 'none', permission: 'reject',
    roles, workflow, toolPrefix: workflow ? 'custom_chat_' : 'acp_chat_', discoverBackends: false, registryPath: join(directory, 'registry.json'),
  })
}

afterEach(async () => {
  await ctx.fiber.dispose()
  rmSync(directory, { recursive: true, force: true })
})

async function prompt(agent: Agent) {
  const signal = new AbortController().signal
  const toolSet = await ctx.tools.resolve({ agent, signal, modelSelection: { provider: 'fixture', model: 'fixture' } })
  try {
    return renderPrompt(await ctx.systemPrompt.assemble({ ...assembleContextFor(agent, signal), toolSet }))
  } finally { toolSet.dispose() }
}

it.each([[false, false], [true, false], [true, true]])('renders the role rule only for Dispatcher (roles=%s, workflow=%s)', async (roles, workflow) => {
  await setup(roles, workflow)
  const { agent } = await ctx.agents.create({ sessionId: SessionId('selection') })
  await ctx.agentPresets.select(agent, 'standard')
  expect(await prompt(agent)).not.toContain(TEAM_INSTRUCTIONS)
  await ctx.agentPresets.select(agent, dispatcher.id)
  const text = await prompt(agent)
  expect(text).toContain('Workers sharing the same cwd')
  expect(text).toContain('When synthesizing results')
  expect(text).not.toMatch(/When one worker's result changes|Relay self-contained summaries/)
  expect(text.split(TEAM_INSTRUCTIONS).length - 1).toBe(roles ? 1 : 0)
})

it('uses the actual default composition even when the session has no recorded selection', async () => {
  await setup(true, false)
  const { agent } = await ctx.agents.create({ sessionId: SessionId('default-mount'),
    setup: async scope => { await ctx.agentPresets.mount(scope) } })
  expect(ctx.agentPresets.presetForSession(agent.session)).toBeNull()
  expect(ctx.agentPresets.composedPreset(agent.ctx)).toBe('acp-dispatcher')
  expect(await prompt(agent)).toContain(TEAM_INSTRUCTIONS)
})

it('omits the rule when the visible custom team tool is not admitted for this step', async () => {
  await setup(true, true)
  const { agent } = await ctx.agents.create({ sessionId: SessionId('step-admission') })
  await ctx.agentPresets.select(agent, dispatcher.id)
  const team = ctx.tools.get('custom_team_list', agent)!
  agent.ctx.tools.register(team, { when: () => false })
  expect(ctx.tools.get('custom_team_list', agent)).toBeDefined()
  expect(await prompt(agent)).not.toContain(TEAM_INSTRUCTIONS)
})

it('rejects workflow without roles before registering the ACP provider', async () => {
  await expect(setup(false, true)).rejects.toThrow('workflow: true requires roles: true')
  expect(ctx.subagents.getProvider('acp-resume')).toBeUndefined()
})
