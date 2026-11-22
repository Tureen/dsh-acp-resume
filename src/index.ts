/**
 * Out-of-process ACP subagent backend. Each child has its own process, session, model, and
 * tools, so it shares no Cordis context and advertises no parent-enforced start capabilities;
 * the subagent service supplies the captured child working directory. This plugin uses
 * named exports only; a default would hide its
 * loader metadata (see `docs/postmortem/0001-acp-default-export-drops-inject.md`).
 * When `enableChatTools` is on, the persistent-chat tools register while a `tools`
 * service is present (revoked when it leaves); their session pool lives on the
 * plugin fiber and is drained on plugin teardown. The side-panel Remote service
 * (`acpResume/list|close|purge`, see `./panel.ts`) registers alongside the tools.
 * The send tool follows the job registry (D17): the job-backed variant is
 * registered while `ctx.jobs` is present, the inline variant otherwise (and
 * again when the registry leaves while the tools stay).
 * @module dsh-acp-resume
 */

import type { Context, FiberState } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserQuestionService } from '@deepseek-ai/dsh-user-questions'
import z from '@deepseek-ai/schemastery'
import type {
  ResolvedSubagentStartRequest,
  SubagentCapabilities,
  SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import { assertUsableCwd } from '@deepseek-ai/dsh-subagent'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { isAbsolute } from 'node:path'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { acpConfigurationFailure, type AcpRunSpec, DEFAULT_DISPOSE_EOF_GRACE_MS, DEFAULT_DISPOSE_GRACE_MS, type PermissionPolicy, startAcpRun } from './run.js'
import { AcpSessionPool, DEFAULT_BACKEND, type BackendSpec } from './pool.js'
import { chatSendTool, chatStaticTools, chatUsageTool, chatWorkflowTool, type ChatJobsFace, type RoleSupport } from './tools.js'
import { UsageService } from './usage.js'
import { AcpResumePanelService } from './panel.js'
import type { AcpSessionSpec } from './connection.js'
import { type AgentEngineSetting, buildChildArgs, type ModelSelect } from './engine.js'
import { decideJobWait } from './job-wait-gate.js'
import { userQuestionPermissionResolver, type PermissionRequestResolver } from './permission-request.js'
import { BackendReadinessService, backendPathEnv, type BackendCandidate } from './backend-readiness.js'
import { verifyBackend } from './backend-verification.js'
import { backendStatusTool } from './tools.js'

// cordis ships FiberState as an ambient const enum, which verbatimModuleSyntax
// cannot read at runtime; `satisfies` pins the literal to the declared member.
const FIBER_ACTIVE = 2 satisfies FiberState.ACTIVE

export const name = 'acp-resume'
export const inject = ['subagents', 'subprocess']

/** Per-chat ACP backend settings added by D24. */
export interface BackendConfig {
  command: string
  args: string[]
  agentEngine: AgentEngineSetting
  model?: string
  /** `'session'`: switch model via `session/set_model` (agy), falling back to `session/set_config_option` (kiro v3); no `--model` flag. Default `'flag'`. */
  modelSelect?: ModelSelect
  /** ACP: `--effort` flag. Codex: `effort` of every `turn/start`. */
  effort?: string
  permission: PermissionPolicy
  env: Record<string, string>
  /** Wire protocol of the child: `acp` (default) or Codex `app-server`. A known Codex CLI can use its own default model. */
  protocol?: 'acp' | 'codex'
  /** Codex only: `read-only` (default) | `workspace-write` | `danger-full-access`. */
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** Codex only: `never` (default) | `untrusted` | `on-request` | `on-failure`. */
  approvalPolicy?: 'never' | 'untrusted' | 'on-request' | 'on-failure'
  /** Neutral user-facing description; omitted falls back to name and command basename. */
  description?: string
}

/** Config: how to spawn and drive the child ACP agent process. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `acp-resume`). */
  providerName: string
  /** The executable to spawn for each run (the child ACP agent). */
  command: string
  /** Arguments passed to {@link command}. */
  args: string[]
  /**
   * Agent engine the child is started with: `--agent-engine <engine>` is
   * appended to {@link args} (default `v3`, kiro-cli's KAS engine, which also
   * supports mid-turn steering). If {@link args} already contains
   * `--agent-engine`, that explicit choice wins and nothing is appended.
   * Set `'none'` to never append the flag, for ACP agents that do not know it
   * (an agent that rejects unknown flags would otherwise fail to start).
   * Reconnecting a saved chat ignores the engine (sessions load across
   * engines); if the new engine cannot load it, the chat degrades to a fresh
   * session as usual (D19). Applies to both the one-shot provider and the chats.
   */
  agentEngine: AgentEngineSetting
  /**
   * Model id the child's sessions are pinned to, appended as `--model <id>`
   * (e.g. `claude-opus-5.5`, `glm-5`). Left unset by default so the server
   * keeps its `auto` routing (it picks a model per task, and `effort` is not
   * under our control). Set it to pin one model. If {@link args} already
   * contains `--model`, that explicit choice wins and nothing is appended.
   * Spawn-level: a chat already running keeps its model; a pinned model takes
   * effect on the NEXT reconnect (a new process), not on the live one.
   */
  model?: string
  /**
   * How {@link model} is applied. `'flag'` (default) appends `--model <id>`;
   * `'session'` appends nothing and calls `session/set_model` right after
   * `session/new` / `session/load` (for agents such as agy that reject
   * `--model`); on `-32601` or `-32603` it falls back to `session/set_config_option`
   * (kiro v3). A failure of both is logged and does not block the chat.
   */
  modelSelect?: ModelSelect
  /**
   * Reasoning effort the child's sessions are pinned to, appended as
   * `--effort <level>` (typically `low` / `medium` / `high` / `xhigh` /
   * `max`; the accepted set depends on the model). Left unset by default
   * (the model's own default under `auto`). If {@link args} already contains
   * `--effort`, that explicit choice wins. Spawn-level, like {@link model}:
   * applied on the next reconnect, not on a live process.
   */
  effort?: string
  /**
   * How to answer the child's `session/request_permission` prompts: `reject`
   * (default), `allow` (select the first allow-shaped option), or `ask`
   * (forward each request to the host user's confirmation UI). `ask` fails
   * closed when the host has no user-questions service or no answerer.
   */
  permission: PermissionPolicy
  /**
   * Extra environment variables for the child process — e.g. the child
   * harness's own `DEEPSEEK_API_KEY`. Forwarded on top of a credential-scrubbed
   * copy of the parent env, so an explicit key here reaches the child while
   * ambient secrets do not leak implicitly.
   */
  env: Record<string, string>
  /**
   * Grace period (ms) for the child's EOF-driven quiesce on dispose — its
   * window to flush persistence and tear down its own nested subprocesses
   * before the parent escalates to a signal. Must not exceed
   * `MAX_TIMER_DELAY_MS`.
   */
  disposeEofGraceMs?: number
  /** Failure-observation and termination-escalation grace (ms); must not exceed `MAX_TIMER_DELAY_MS`. */
  disposeGraceMs?: number
  /** Idle window (ms) after a settled chat turn before the chat's process is released. */
  idleTimeoutMs?: number
  /** Registry file for durable chats; defaults to $DSH_HOME/storages/acp-resume/registry.json. */
  registryPath?: string
  /** Optional named ACP backends; top-level settings remain the default backend. */
  backends?: Record<string, BackendConfig>
  /** Preferred backend for new persistent chats; does not change existing bindings or one-shot. */
  defaultBackend?: string
  /** Discover known CLI versions and supply a safe Codex backend when none is configured (default true). */
  discoverBackends?: boolean
  /** Opt in to configured custom wrappers without a known version contract (default false). */
  allowUnverifiedBackends?: boolean
  /** Name prefix for the five persistent-chat tools (default `acp_chat_`). */
  toolPrefix?: string
  /** Register the persistent-chat tools alongside the one-shot provider (default true). */
  enableChatTools?: boolean
  /**
   * Allow `job_output` with `wait: true` on a still-running `acp-chat` job
   * (default false, D22). By default such a call is refused with guidance:
   * a chat turn can run for minutes, and blocking on it stalls the model and
   * queues the user's messages, while the job's completion notice already
   * wakes the model. Settled jobs and other job kinds are never affected.
   */
  allowChatJobWait?: boolean
  /**
   * Workspace roles and workflows (D27). Off by default: set true to enable
   * them. When on, the chat tools accept a `role` from the workspace
   * `.agents/acp-team.yml` instead of a chatId, a role's chat is set up on
   * first reference, and `acp_workflow` is registered. Off keeps every tool
   * definition exactly as before D27 and reads no workspace team file.
   */
  workflow?: boolean
}

export const Config: z<Config> = z.object({
  providerName: z.string().default('acp-resume'),
  command: z.string().required(),
  args: z.array(z.string()).default([]),
  agentEngine: z.union(['v1', 'v2', 'v3', 'none'] as const).default('v3'),
  // Optional: no .required()/.default() ⇒ absent when unset (schemastery 3.18.5),
  // so the flag is only appended when the user pins a model/effort.
  model: z.string(),
  modelSelect: z.union(['flag', 'session'] as const).default('flag'),
  effort: z.string(),
  permission: z.union(['allow', 'reject', 'ask'] as const).default('reject'),
  env: z.dict(z.string()).default({}),
  disposeEofGraceMs: z.number().default(DEFAULT_DISPOSE_EOF_GRACE_MS),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
  idleTimeoutMs: z.number().default(600_000),
  registryPath: z.string().default(''),
  backends: z.dict(z.object({
    command: z.string().required(),
    args: z.array(z.string()).default([]),
    agentEngine: z.union(['v1', 'v2', 'v3', 'none'] as const).default('v3'),
    model: z.string(), effort: z.string(),
    modelSelect: z.union(['flag', 'session'] as const).default('flag'),
    permission: z.union(['allow', 'reject', 'ask'] as const).default('reject'),
    env: z.dict(z.string()).default({}),
    protocol: z.union(['acp', 'codex'] as const).default('acp'),
    sandbox: z.union(['read-only', 'workspace-write', 'danger-full-access'] as const),
    approvalPolicy: z.union(['never', 'untrusted', 'on-request', 'on-failure'] as const),
    description: z.string(),
  })),
  defaultBackend: z.string(),
  discoverBackends: z.boolean().default(true),
  allowUnverifiedBackends: z.boolean().default(false),
  toolPrefix: z.string().default('acp_chat_'),
  enableChatTools: z.boolean().default(true),
  allowChatJobWait: z.boolean().default(false),
  workflow: z.boolean().default(false),
})

/** A process grace must fit every Node timer that observes or terminates the child. */
function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`subagent-acp: ${name} must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

type ResolvedConfig = Required<Config>

/**
 * The ACP provider. Advertises NO start-time capabilities: an out-of-process
 * child cannot honor `agentOptions`/`agentPreset`/`outputSchema`/`maxDepth`.
 * The service rejects a request needing any before execution starts.
 */
class AcpProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = {
    agentOptions: false,
    agentPreset: false,
    outputSchema: false,
    depthLimit: false,
  }
  // Context contract: an out-of-process ACP child starts fresh — no parent conversation crosses the process boundary.
  readonly inheritsParentContext = false

  constructor(
    readonly name: string,
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
    private readonly permissionResolverFor: (agent: Agent | undefined) => PermissionRequestResolver | undefined,
  ) {}

  start(request: ResolvedSubagentStartRequest) {
    if (request.signal.aborted) {
      throw new Error('subagent request was aborted before the ACP child started')
    }
    let cwd: string
    try {
      cwd = assertUsableCwd('subagent-acp', 'child cwd', request.cwd)
    } catch (error: unknown) {
      const failure = acpConfigurationFailure(error)
      this.ctx.logger.warn(`subagent-acp "${this.name}": child start failed: %o`, error)
      throw failure
    }
    const permissionResolver = this.permissionResolverFor(request.parent)
    const spec: AcpRunSpec = {
      command: this.config.command,
      args: buildChildArgs(this.config.args, {
        engine: this.config.agentEngine,
        ...(this.config.model === undefined ? {} : { model: this.config.model }),
        ...(this.config.modelSelect === undefined ? {} : { modelSelect: this.config.modelSelect }),
        ...(this.config.effort === undefined ? {} : { effort: this.config.effort }),
      }),
      cwd,
      permission: this.config.permission,
      ...(permissionResolver === undefined ? {} : { permissionResolver }),
      env: this.config.env,
      disposeEofGraceMs: this.config.disposeEofGraceMs,
      disposeGraceMs: this.config.disposeGraceMs,
      spawn: spec => this.ctx.subprocess.spawn(spec),
      onError: (error, stopReason) => {
        // The seam forbids `result` rejecting, so a child-level failure is
        // flattened to a stop reason — preserve it here rather than losing it.
        this.ctx.logger.warn(`subagent-acp "${this.name}": child run failed (${stopReason}): ${error.message}`)
      },
    }
    return startAcpRun(request, spec)
  }
}

function backendSpecs(ctx: Context, config: ResolvedConfig): ReadonlyMap<string, BackendSpec> {
  const base = (backend: BackendConfig): Omit<AcpSessionSpec, 'cwd'> => ({
    command: backend.command,
    // Codex has no ACP engine/model/effort flags: its args are exactly the user's (default `app-server`).
    args: backend.protocol === 'codex' ? (backend.args.length === 0 ? ['app-server'] : backend.args) : buildChildArgs(backend.args, { engine: backend.agentEngine, ...(backend.model === undefined ? {} : { model: backend.model }), ...(backend.modelSelect === undefined ? {} : { modelSelect: backend.modelSelect }), ...(backend.effort === undefined ? {} : { effort: backend.effort }) }),
    ...(backend.modelSelect === 'session' && backend.model !== undefined && backend.model !== '' ? { sessionModel: backend.model } : {}),
    permission: backend.permission, env: { ...config.env, ...backend.env }, disposeEofGraceMs: config.disposeEofGraceMs, disposeGraceMs: config.disposeGraceMs,
    spawn: spec => ctx.subprocess.spawn(spec),
    onError: (error, stopReason) => { ctx.logger.warn(`acp-resume chat child failed (${stopReason}): ${error.message}`) },
  })
  const defaultBackend: BackendConfig = { command: config.command, args: config.args, agentEngine: config.agentEngine, permission: config.permission, env: {}, ...(config.model === undefined ? {} : { model: config.model }), ...(config.modelSelect === undefined ? {} : { modelSelect: config.modelSelect }), ...(config.effort === undefined ? {} : { effort: config.effort }) }
  const named = Object.entries(config.backends ?? {})
  if (named.some(([name]) => !/^[A-Za-z0-9_-]{1,32}$/.test(name) || name === DEFAULT_BACKEND)) throw new Error(`acp-resume: backend names must match [A-Za-z0-9_-]{1,32} and cannot be ${DEFAULT_BACKEND}`)
  const entries: [string, BackendSpec][] = named.map(([name, value]) => [
    name,
    {
      name, description: value.description ?? `${name} (${value.command.split('/').at(-1) ?? value.command})`, specBase: base(value),
      ...(value.protocol === 'codex' ? { protocol: 'codex' as const, codex: {
        ...(value.model?.trim() ? { model: value.model.trim() } : {}),
        ...(value.sandbox === undefined ? {} : { sandbox: value.sandbox }),
        ...(value.approvalPolicy === undefined ? {} : { approvalPolicy: value.approvalPolicy }),
        ...(value.effort === undefined ? {} : { effort: value.effort }),
      } } : {}),
    },
  ])
  entries.push([DEFAULT_BACKEND, { name: DEFAULT_BACKEND, description: defaultBackend.command.split('/').at(-1) ?? defaultBackend.command, specBase: base(defaultBackend) }])
  if (config.discoverBackends && !entries.some(([name, backend]) => name === 'codex' || backend.protocol === 'codex' || commandKind(backend.specBase.command) === 'codex')) {
    const auto: BackendConfig = {
      command: 'codex', args: ['app-server'], protocol: 'codex', agentEngine: 'none', permission: 'reject', env: {},
    }
    // Discovery is not consent to reuse another backend's credentials or elevate permissions.
    entries.push(['codex', { name: 'codex', description: 'Codex (auto-discovered, read-only)', automatic: true,
      specBase: { ...base(auto), env: backendPathEnv(config.env) }, protocol: 'codex',
      codex: { sandbox: 'read-only', approvalPolicy: 'never' },
    }])
  }
  return new Map(entries)
}

function commandKind(command: string): 'kiro-cli' | 'agy' | 'codex' | undefined {
  const base = command.split(/[\\/]/).at(-1)?.toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/, '')
  return base === 'kiro-cli' || base === 'agy' || base === 'codex' ? base : undefined
}

function readinessCandidates(backends: ReadonlyMap<string, BackendSpec>, config: ResolvedConfig): BackendCandidate[] {
  const candidates = [...backends.values()].map((backend): BackendCandidate => {
    const spec = backend.specBase
    const cli = commandKind(spec.command)
    const base = { id: backend.name, label: cli === 'codex' ? 'Codex' : cli === 'agy' ? 'Antigravity CLI (agy)' : cli ?? 'Custom ACP', command: spec.command,
      env: spec.env ?? {}, configured: backend.automatic !== true, ...(backend.automatic === true ? { automatic: true as const } : {}),
    }
    const args = spec.args
    const has = (flag: string): boolean => args.some(arg => arg === flag || arg.startsWith(`${flag}=`))
    if (cli === 'kiro-cli') {
      const index = args.findIndex(arg => arg === '--agent-engine' || arg.startsWith('--agent-engine='))
      const engine = index < 0 ? undefined : args[index]?.split('=')[1] ?? args[index + 1]
      const kind = engine === 'v2' ? 'kiro-v2' : engine === 'v3' ? 'kiro-v3' : null
      const invalid = backend.protocol === 'codex' || !args.includes('acp') || (engine === 'v3' && (has('--model') || has('--effort')))
      return { ...base, kind, ...(invalid ? { configurationIssue: 'unsupported-mode' as const } : {}) }
    }
    if (cli === 'agy') {
      const invalid = backend.protocol === 'codex' || !args.includes('acp') || has('--agent-engine') || has('--model') || has('--effort')
      return { ...base, kind: 'agy', ...(invalid ? { configurationIssue: 'unsupported-mode' as const } : {}) }
    }
    if (cli === 'codex') {
      const invalid = backend.protocol !== 'codex' || !args.includes('app-server')
      return { ...base, kind: 'codex', ...(invalid ? { configurationIssue: 'unsupported-mode' as const } : {}) }
    }
    return { ...base, label: backend.protocol === 'codex' ? 'Custom Codex' : base.label, kind: undefined,
      ...(backend.protocol === 'codex' && backend.codex?.model === undefined ? { configurationIssue: 'model-required' as const } : {}) }
  })
  if (!config.discoverBackends) return candidates
  const seen = new Set(candidates.map(candidate => commandKind(candidate.command)))
  const used = new Set(candidates.map(candidate => candidate.id))
  for (const [id, command, kind] of [['kiro', 'kiro-cli', 'kiro-v3'], ['agy', 'agy', 'agy']] as const) {
    if (seen.has(command)) continue
    let key: string = id
    while (used.has(key)) key = `detected-${key}`
    used.add(key)
    candidates.push({ id: key, label: command === 'agy' ? 'Antigravity CLI (agy)' : command, command, kind, configured: false, env: config.env })
  }
  return candidates
}

/** Minimal face of the host `workingDirectory` service (optional; not injected). */
interface WorkingDirectoryFace { get(session: Agent['session']): string }

/** The session's current working directory: the host service when composed, else the session header's cwd, else the host process cwd. */
function sessionWorkingDirectory(ctx: Context, agent: Agent): string {
  const service = ctx.get('workingDirectory') as WorkingDirectoryFace | undefined
  try {
    if (service !== undefined) return service.get(agent.session)
  } catch { /* fall back to the header */ }
  return agent.session?.header?.cwd ?? process.cwd()
}

export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  assertPositiveFinite('disposeEofGraceMs', resolved.disposeEofGraceMs)
  assertPositiveFinite('disposeGraceMs', resolved.disposeGraceMs)
  assertPositiveFinite('idleTimeoutMs', resolved.idleTimeoutMs)
  if (resolved.registryPath !== '' && !isAbsolute(resolved.registryPath)) {
    throw new Error(`acp-resume: registryPath must be an absolute path, got ${JSON.stringify(resolved.registryPath)}`)
  }
  // The connection applies each selected backend's policy. Always supplying the
  // bridge lets a named `permission: ask` backend ask while the default rejects.
  const permissionResolverFor = (agent: Agent | undefined): PermissionRequestResolver | undefined =>
    userQuestionPermissionResolver(ctx.get('userQuestions') as UserQuestionService | undefined, agent)
  const backends = backendSpecs(ctx, resolved)
  ctx.subagents.registerProvider(new AcpProvider(resolved.providerName, ctx, resolved, permissionResolverFor))
  if (!resolved.enableChatTools) return

  const registryPath = resolved.registryPath === ''
    ? dshHomePath('storages', 'acp-resume', 'registry.json')
    : resolved.registryPath
  // The pool lives on the plugin fiber, not the tools scope: a tools-service
  // reload re-registers the tools without killing chat processes. It is built
  // on the first tools arrival, so a host without a tools service touches no registry file.
  let pool: AcpSessionPool | undefined
  let usage: UsageService | undefined
  const readiness = new BackendReadinessService({
    candidates: readinessCandidates(backends, resolved), preferred: resolved.defaultBackend,
    allowUnverifiedBackends: resolved.allowUnverifiedBackends, host: ctx.subprocess,
    verify: (candidate, executable, signal) => {
      const spec = backends.get(candidate.id)!
      return verifyBackend({ ...spec, specBase: { ...spec.specBase, command: executable } }, signal)
    },
  })
  if (resolved.defaultBackend !== undefined && !backends.has(resolved.defaultBackend)) {
    throw new Error(`acp-resume: defaultBackend must name an available backend definition or default`)
  }
  let checkedAtStartup = false
  ctx.effect(() => () => readiness.dispose())
  // Plugin-fiber teardown awaits this promise: in-flight turns are cancelled
  // and every live chat process released; the registry file survives (D14).
  ctx.effect(() => () => pool?.disposeAll())
  ctx.inject(['tools'], (scope) => {
    pool ??= new AcpSessionPool({
      specBase: backends.get(DEFAULT_BACKEND)!.specBase,
      backends,
      registryPath,
      idleTimeoutMs: resolved.idleTimeoutMs,
      onWarn: message => { ctx.logger.warn(message) },
      dispatch: readiness,
    })
    // Registered in the tools scope: the tools are revoked when the service goes away.
    const chatPool = pool
    const roles: RoleSupport | undefined = resolved.workflow ? { workspaceDirFor: agent => sessionWorkingDirectory(ctx, agent), onWarn: (message) => { ctx.logger.warn(message) } } : undefined
    const backendChoices = [...backends.values()].map(backend => ({ name: backend.name, description: backend.description }))
    const [, list, close, steer] = chatStaticTools(chatPool, resolved.toolPrefix, backendChoices, roles)
    scope.effect(() => scope.tools.register(steer))
    scope.effect(() => scope.tools.register(list))
    scope.effect(() => scope.tools.register(close))
    scope.effect(() => scope.tools.register(backendStatusTool(readiness)))
    usage ??= new UsageService(chatPool, undefined, undefined, () => new Set(readiness.snapshot().backends.filter(row => row.readiness === 'ready').map(row => row.id)))
    // Register only dispatch tools for currently admitted backends. The pool also gates
    // captured tool bodies, and indirect role/workflow paths, before committing work.
    let unregister: (() => void) | undefined
    let jobs = scope.get('jobs') as ChatJobsFace | undefined
    let lastKey: string | undefined
    let lastJobs: ChatJobsFace | undefined
    const syncDispatch = (): void => {
      if (scope.fiber.state !== FIBER_ACTIVE) return
      const state = readiness.snapshot()
      const ready = new Set(state.backends.filter(row => row.readiness === 'ready').map(row => row.id))
      const choices = backendChoices.filter(backend => ready.has(backend.name))
      const key = JSON.stringify([choices.map(choice => choice.name), state.defaultBackend])
      if (key === lastKey && jobs === lastJobs) return
      lastKey = key
      lastJobs = jobs
      unregister?.()
      unregister = undefined
      if (!state.dispatchEnabled) return
      const [start] = chatStaticTools(chatPool, resolved.toolPrefix, choices, roles, state.defaultBackend === undefined || choices[0]?.name !== DEFAULT_BACKEND, state.defaultBackend)
      const definitions = [start, chatSendTool(chatPool, resolved.toolPrefix, jobs, permissionResolverFor, roles),
        ...(roles === undefined ? [] : [chatWorkflowTool(chatPool, roles, jobs, permissionResolverFor)])]
      if (chatPool.backendList().some(backend => backend.protocol === 'codex' && ready.has(backend.name))) definitions.push(chatUsageTool(usage as UsageService))
      const revokers = definitions.map(definition => scope.tools.register(definition))
      unregister = () => { for (const revoke of revokers) revoke() }
    }
    scope.effect(() => {
      const unsubscribe = readiness.subscribe(syncDispatch)
      syncDispatch()
      return () => { unsubscribe(); unregister?.(); unregister = undefined }
    })
    scope.inject(['jobs'], (jobsScope) => {
      jobs = jobsScope.jobs
      syncDispatch()
      if (!resolved.allowChatJobWait) {
        jobsScope.on('tools/pre-execute', async (exec, next) => decideJobWait(jobsScope.jobs, exec) ?? next())
      }
      jobsScope.effect(() => () => { jobs = undefined; syncDispatch() })
    })
    new AcpResumePanelService(scope, pool, usage, readiness)
    if (!checkedAtStartup) {
      checkedAtStartup = true
      void readiness.check().catch(() => { ctx.logger.warn('acp-resume: backend detection did not complete') })
    }
  })
}
