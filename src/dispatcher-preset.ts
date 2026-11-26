/** Global Cordis declaration for the configurable ACP Dispatcher preset (D37/D38).
 * Its fiber owns the preset definition independently of the ACP provider and pool.
 * @module dsh-acp-resume/dispatcher-preset
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import z from '@deepseek-ai/schemastery'

/** Host service required by this declaration. */
export const inject = ['agentPresets']

const defaults = { readOnlyFs: false, web: true, present: true, todo: true, askUser: true, compaction: true }
type DispatcherTools = typeof defaults & {
  /** @deprecated Skill loading follows readOnlyFs. */
  skill?: boolean
}
const promptDefaults = { extraRules: '', overrideRules: false }
type DispatcherPrompt = typeof promptDefaults

/** Tool choices govern the menu description. Skill descriptions enter context only on opt-in.
 * Prompt customization affects only the persona prefix.
 */
export const Config = z.object({
  dispatcherTools: z.object({
    readOnlyFs: z.boolean().default(defaults.readOnlyFs).description('Read and search files, discover skills, and load their instructions.'),
    web: z.boolean().default(defaults.web).description('Use web tools for lightweight fact-checking.'),
    present: z.boolean().default(defaults.present).description('Present deliverables.'),
    todo: z.boolean().default(defaults.todo).description('Maintain a task list.'),
    askUser: z.boolean().default(defaults.askUser).description('Use a tool to ask the user for clarification.'),
    skill: z.boolean().description('Deprecated since 0.6.0: use readOnlyFs for file verification and skill loading.'),
    compaction: z.boolean().default(defaults.compaction).description('Enable the isolated context compaction group.'),
  }).default(defaults),
  dispatcherPrompt: z.object({
    extraRules: z.string().default('').description('User dispatch rules, appended after the built-in persona by default.'),
    overrideRules: z.boolean().default(false).description('Replace the built-in dispatch rules with nonempty extraRules. Keep the identity and tool guidance.'),
  }).default(promptDefaults),
})

const identity = 'You are a task dispatcher.'
const dispatchProcedure = `Check the registered ACP backend status tool (acp_backend_status with the default prefix) before reporting available workers or dispatching. This status tool never creates a session. Use the registered start and send tools, whose names may also have a custom prefix.
If detection is running, say so. After a CLI upgrade, sign-in, or default model change, users can choose Right sidebar → ACP chats → Recheck backends (右侧栏 → ACP 会话 → 后端状态旁的「重新检测后端」). This does not delete chats, log users out, or change settings. Do not create a test chat.
If the user names a backend and the start tool exposes a backend parameter, pass that backend's ID; never substitute another for an explicit choice. Otherwise use the configured default. A non-pinned Kiro default can fall back to ready Codex, then Antigravity, only if DSH cannot find the configured Kiro executable. Mention this fallback when it happens. Never treat an installed Kiro's version, handshake or sign-in issue as a reason to switch. Auto-discovered Codex is read-only: do not delegate tasks requiring writes to it. If new dispatch fails, explain the cause and available choices.
For an existing chat, send to its chatId without switching backends based on detection. Dispatch tasks with acp_chat_send (records jobId); wait for completion notifications; collect results with job_output.`

const synthesis = `When synthesizing results:
- Tasks with dependencies: wait for prerequisites before synthesizing
- Independent results: report partial findings as they arrive, noting what's still running
- Distinguish blocking results (needed for the answer) from informational results (nice to have)
- If the user's question is already answered by partial results, share them immediately`

function targetDirectoryRule(askUser: boolean): string {
  const choose = askUser ? 'ask the user to choose' : 'ask in the conversation which one to use'
  const clarify = askUser ? 'ask the user' : 'ask in the conversation'
  return `Before starting an ACP chat, identify the project, repository, or worktree the task targets. Pass its absolute path explicitly through the start tool's working-directory parameter. Use the dispatcher's own working directory only when the request or earlier conversation clearly identifies it as the target.
When the target is unambiguous, proceed without asking. If several directories are plausible, list them and ${choose}. If no target can be identified, ${clarify} which project or directory the task is for before starting the chat.`
}

function toolCopy(tools: DispatcherTools) {
  const description = ['纯派工模式:主 Agent 只做调度,ACP 会话做实际 Worker。']
  description.push(tools.readOnlyFs ? '可用 read/grep/glob 核对结果并加载 skill，无 bash，不改文件。' : '无 bash/fs,')
  description.push(tools.web ? '轻量联网查询保留。' : '联网查询交给 Worker。')
  const lines: string[] = []
  if (tools.web) lines.push('For lightweight fact-checking use web tools directly; delegate full research tasks to workers.')
  lines.push(tools.readOnlyFs
    ? 'Use read, grep, and glob to verify worker results. Load a matching skill before acting on its instructions. Delegate shell commands, file changes, and code analysis to workers.'
    : 'You do not execute tasks directly — no bash, no file operations, no code analysis.')
  if (!tools.present) {
    description.push('交付物在对话中说明。')
    lines.push('Report deliverables and their locations in the conversation.')
  }
  if (!tools.todo) {
    description.push('任务清单工具已关闭。')
    lines.push('Track outstanding tasks in the conversation.')
  }
  if (!tools.askUser) description.push('需要澄清时直接在对话中提问。')
  if (!tools.compaction) {
    description.push('上下文压缩组已关闭。')
    lines.push('Keep worker summaries concise because the Dispatcher compaction group is disabled.')
  }
  return { description: description.join(''), lines }
}

function personaPrefix(askUser: boolean, toolLines: string[], prompt: Partial<DispatcherPrompt>): string {
  const extra = prompt.extraRules?.trim() ?? ''
  if (prompt.overrideRules && !extra) {
    throw new Error('dispatcherPrompt.overrideRules requires nonempty extraRules to replace the built-in dispatch rules')
  }
  const lines = prompt.overrideRules ? [identity] : [
    `${identity} ${dispatchProcedure}`,
    targetDirectoryRule(askUser),
    'Workers sharing the same cwd must have non-overlapping file write boundaries.',
  ]
  // The default directory rule already explains how to ask when the tool is disabled.
  if (prompt.overrideRules && !askUser) lines.push('When clarification is needed, ask in the conversation.')
  lines.push(...toolLines)
  if (!prompt.overrideRules) lines.push('', synthesis)
  if (extra) lines.push('', extra)
  return lines.join('\n')
}

/** Build a detached preset. dispatcherPrompt changes the prefix; the description follows only the tools. */
export function buildDispatcherPreset(tools: DispatcherTools = defaults, prompt: Partial<DispatcherPrompt> = {}): PresetDefinition {
  const { description, lines } = toolCopy(tools)
  const prefix = personaPrefix(tools.askUser, lines, prompt)
  const plugins: PresetDefinition['plugins'][number][] = [
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix } },
    { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
    { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
    { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
  ]
  if (tools.todo) plugins.push({ id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } })
  if (tools.askUser) plugins.push({ id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' })
  if (tools.web) plugins.push({ id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true } })
  if (tools.readOnlyFs) plugins.push(
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', config: { read: true, readImage: false, write: false, edit: false, applyPatch: false } },
    { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
    { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem', config: {
      customSkillDirs: [{ __jsExpr: "process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:path').dirname(process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('@deepseek-ai/dsh-agent-preset/package.json')), 'skills')" }],
    } },
    { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
  )
  if (tools.present) plugins.push({ id: 'present', name: '@deepseek-ai/dsh-tool-present' })
  if (tools.compaction) plugins.push({
    id: 'compaction', name: 'cordis:group', group: true, isolate: { compaction: true, toolResultPruner: true },
    config: [
      { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
      { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
      { id: 'tool-result-pruner', name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
        config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 } },
    ],
  })
  return { id: 'acp-dispatcher', name: 'ACP Dispatcher', description, order: 10, plugins }
}

/** Register the definition and let Cordis retire it on update or unload. */
export async function* apply(ctx: Context, config: { dispatcherTools: DispatcherTools; dispatcherPrompt: DispatcherPrompt }) {
  if (config.dispatcherTools.skill && !config.dispatcherTools.readOnlyFs) {
    ctx.logger.warn('dispatcherTools.skill is deprecated and has no effect; set dispatcherTools.readOnlyFs: true to enable file reads and skill loading.')
  }
  yield await ctx.agentPresets.register(buildDispatcherPreset(config.dispatcherTools, config.dispatcherPrompt))
}
