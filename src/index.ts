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
 * @module @deepseek-ai/dsh-subagent-acp
 */

import type { Context } from '@deepseek-ai/cordis'
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
import { AcpSessionPool } from './pool.js'
import { registerChatTools } from './tools.js'
import { AcpResumePanelService } from './panel.js'

export const name = 'acp-resume'
export const inject = ['subagents', 'subprocess']

/** Config: how to spawn and drive the child ACP agent process. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `acp-resume`). */
  providerName: string
  /** The executable to spawn for each run (the child ACP agent). */
  command: string
  /** Arguments passed to {@link command}. */
  args: string[]
  /**
   * How to auto-answer the child's `session/request_permission` prompts:
   * `reject` (default — decline every prompt) or `allow` (approve via the first
   * `allow_once` or `allow_always` option). No prompt is surfaced to a human.
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
  /** Name prefix for the four persistent-chat tools (default `acp_chat_`). */
  toolPrefix?: string
  /** Register the persistent-chat tools alongside the one-shot provider (default true). */
  enableChatTools?: boolean
}

export const Config: z<Config> = z.object({
  providerName: z.string().default('acp-resume'),
  command: z.string().required(),
  args: z.array(z.string()).default([]),
  permission: z.union(['allow', 'reject'] as const).default('reject'),
  env: z.dict(z.string()).default({}),
  disposeEofGraceMs: z.number().default(DEFAULT_DISPOSE_EOF_GRACE_MS),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
  idleTimeoutMs: z.number().default(600_000),
  registryPath: z.string().default(''),
  toolPrefix: z.string().default('acp_chat_'),
  enableChatTools: z.boolean().default(true),
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

  constructor(readonly name: string, private readonly ctx: Context, private readonly config: ResolvedConfig) {}

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
    const spec: AcpRunSpec = {
      command: this.config.command,
      args: this.config.args,
      cwd,
      permission: this.config.permission,
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

export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  assertPositiveFinite('disposeEofGraceMs', resolved.disposeEofGraceMs)
  assertPositiveFinite('disposeGraceMs', resolved.disposeGraceMs)
  assertPositiveFinite('idleTimeoutMs', resolved.idleTimeoutMs)
  if (resolved.registryPath !== '' && !isAbsolute(resolved.registryPath)) {
    throw new Error(`acp-resume: registryPath must be an absolute path, got ${JSON.stringify(resolved.registryPath)}`)
  }
  ctx.subagents.registerProvider(new AcpProvider(resolved.providerName, ctx, resolved))
  if (!resolved.enableChatTools) return

  const registryPath = resolved.registryPath === ''
    ? dshHomePath('storages', 'acp-resume', 'registry.json')
    : resolved.registryPath
  // The pool lives on the plugin fiber, not the tools scope: a tools-service
  // reload re-registers the tools without killing chat processes. It is built
  // on the first tools arrival, so a host without a tools service touches no registry file.
  let pool: AcpSessionPool | undefined
  // Plugin-fiber teardown awaits this promise: in-flight turns are cancelled
  // and every live chat process released; the registry file survives (D14).
  ctx.effect(() => () => pool?.disposeAll())
  ctx.inject(['tools'], (scope) => {
    pool ??= new AcpSessionPool({
      specBase: {
        command: resolved.command,
        args: resolved.args,
        permission: resolved.permission,
        env: resolved.env,
        disposeEofGraceMs: resolved.disposeEofGraceMs,
        disposeGraceMs: resolved.disposeGraceMs,
        spawn: spec => ctx.subprocess.spawn(spec),
        onError: (error, stopReason) => {
          ctx.logger.warn(`acp-resume "${resolved.providerName}": chat child failed (${stopReason}): ${error.message}`)
        },
      },
      registryPath,
      idleTimeoutMs: resolved.idleTimeoutMs,
      onWarn: message => { ctx.logger.warn(message) },
    })
    // Registered in the tools scope: the tools are revoked when the service goes away.
    registerChatTools(scope, scope.tools, pool, resolved.toolPrefix)
    // The panel Remote service (D15) shares the pool's arrival point and the
    // tools scope's lifetime: it is unregistered with that scope.
    new AcpResumePanelService(scope, pool)
  })
}
