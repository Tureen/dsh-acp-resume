/**
 * Persistent ACP session pool: the asset behind the continuable chat tools.
 * Each pooled chat owns one remote agent session (spawned process kept alive
 * between turns), a durable registry entry (remote session id + cwd, so a
 * dead process reconnects through `session/load`), an idle timer that
 * releases the process while PRESERVING the registry, and single-flight
 * prompt semantics per chat. A `session/load` rejection that proves the saved
 * session missing (the error names it, or the agent lacks `loadSession`), or
 * three consecutive settled `error` turns in this pool instance, falls back
 * to a fresh remote session; any other reconnect failure fails the send and
 * leaves the saved remote session id untouched. The error count is volatile
 * pool state, never a registry field, and resets when the pool restarts.
 * A reconnect whose registry entry was recorded under a different
 * command/args fails without loading: the saved session belongs to another
 * agent. A turn that settles `aborted` or `error` releases its process.
 * Teardown (`close`, `disposeAll`) aborts open windows, each wait bounded by
 * one full dispose ladder (`disposeEofGraceMs + 2 × disposeGraceMs`), and
 * cancels in-flight turns (bounded by `disposeGraceMs`), so a hung
 * `session/load` cannot stall it and no process outlives the pool. A chat
 * stays live until its released process has exited: a send arriving while a
 * release is underway waits for it, so two processes never serve one chat.
 * Each `completed` turn bumps the entry's `turnCount` and, while the entry
 * has no title yet, records the turn's message (trimmed, first 40
 * characters) as its `title`; `aborted` and `error` turns record neither.
 * `steer` forwards a private `_session/steer` to the live connection while a
 * turn is in flight. The reconnect fingerprint ignores `--agent-engine` (D19).
 * `start` records the opening DSH session as `ownerSessionId` when given one
 * (D20): attribution metadata the panel filters on, never access control — the
 * registry stays profile-global and every method serves every chat.
 * Every settled turn and every reconnect event (`session-lost`,
 * `session-reset-after-errors`, `reconnect-failed`) is also appended to the chat's turn log (`turns/<chatId>.jsonl`
 * next to the registry, D18); the log is a mirror for the panel's detail page,
 * its write failures only warn, and `remove` deletes it with the record.
 * Optional send observers ({@link PoolSendHooks}) receive the turn's text
 * chunks as they stream and learn of a fresh-session fallback before the
 * prompt goes out.
 *
 * @module dsh-acp-resume/pool
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { BackendReport } from './backend-status.js'
import { LiveBuffer, type LiveSubscription } from './live-buffer.js'
import type { ChatOptions } from './chat-options.js'
import type { AcpConnection, AcpSessionSpec, AcpSteerResult, OpenAcpMode } from './connection.js'
import { AcpConnectionError, isLoadSessionMissing, openAcpConnection } from './connection.js'
import { openCodexConnection } from './connection-codex.js'
import { assertUsableCwd } from '@deepseek-ai/dsh-subagent'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { stripVolatileFlags } from './engine.js'
import { TurnLog, type LogEntry, type LogEntryInput } from './turn-log.js'
import type { PermissionRequestResolver } from './permission-request.js'
import type { DispatchRoute } from './backend-readiness.js'
import { Roster, toRosterTable, type RosterEntry, type RosterStore, type RosterTable } from './roster.js'
import { projectChatTeamView, type LatestTurnSummary } from './team-view.js'
import { readTeamConfig, seedingWithTeam, TEAM_CONFIG_FILE, type RoleBlueprint, type TeamConfig, type Template } from './team-config.js'
import { WorkflowLog, type WorkflowRunRecord, type WorkflowStepSummary } from './workflow-log.js'
import type { WorkflowObserver, WorkflowResult } from './workflow-engine.js'
import type { MemberOutcome } from './workflow-record.js'

/** A workflow running in this pool instance (D29), as the panel sees it; memory only. */
export interface RunningWorkflow {
  readonly runId: string
  readonly template: string
  readonly startedAt: number
  readonly jobId?: string
  /** The step whose sends are going out; absent before the first step starts. */
  readonly currentStep?: string
  readonly steps: readonly WorkflowStepSummary[]
}

/** One session's workflows for the panel: running (memory) and the newest finished ones (file). */
export interface SessionWorkflows {
  readonly running: readonly RunningWorkflow[]
  readonly recent: readonly WorkflowRunRecord[]
}

/** The pool's handle on one tracked run: its id, the observer to pass the engine, and how to close it. */
export interface WorkflowTracker {
  readonly runId: string
  readonly observer: WorkflowObserver
  /** Record the run's end (file) and drop it from the running set. Idempotent. */
  finish(result: WorkflowResult): void
}

interface TrackedRun {
  runId: string
  template: string
  startedAt: number
  jobId: string | undefined
  currentStep: string | undefined
  steps: { id: string; members: { role: string; chatId?: string; outcome?: MemberOutcome }[] }[]
}

function summarize(run: TrackedRun): WorkflowStepSummary[] {
  return run.steps.map(step => ({ id: step.id, members: step.members.map(m => ({ ...m })) }))
}

/** One pooled chat as reportable state (registry projection + liveness). */
export interface PooledChatInfo {
  readonly chatId: string
  readonly remoteSessionId: string
  readonly cwd: string
  /** Caller-chosen display label, when one was given at start. */
  readonly label?: string
  /** First completed turn's message, trimmed and cut to 40 characters; absent until one exists. */
  readonly title?: string
  /** Completed turns so far; absent until the first one (registries written before turn counting omit it). */
  readonly turnCount?: number
  /** A live process is attached (false once idle-released or after a restart). */
  readonly active: boolean
  readonly lastActive: number
  /** Session id of the DSH chat that opened this chat (D20); absent for chats started before attribution, or without a calling session. */
  readonly ownerSessionId?: string
  /** Backend that owns this chat, as a name `start` accepts back; old records read as `default`. */
  readonly backend: string
  /** Display name for UI: the default backend shows its command basename (e.g. `kiro-cli`), named backends their name. Never pass it back to `start`. */
  readonly backendDisplay: string
  /** Number of configured backends, for optional panel badges. */
  readonly backendCount: number
  /** Live backend-reported setting, omitted once the process is released. */
  readonly currentModel?: string
  readonly currentEffort?: string
  /** Lets the panel discard an open selector when the live connection changes. */
  readonly connectionId?: string
  /** Current prompt state, kept only in pool memory and omitted after settlement (D15). */
  readonly inFlight?: InFlightTurn
  /** What the newest turn-log entry asks the user to notice; absent when it settled normally or the log is empty. */
  readonly attention?: ChatAttention
  /** The newest turn-log entry is a turn that settled `completed` on its saved session; absent otherwise. */
  readonly lastCompleted?: true
  /** Bound role name in this chat's ownerSessionId roster (D27 / D47); memory-only projection, never written to the session row. */
  readonly role?: string
  /** Latest settled turn summary from the cached turn log (D47); memory-only projection, zero extra disk IO. */
  readonly latestTurn?: LatestTurnSummary
  /**
   * Set only on the result of the `start` that created the chat, when the
   * configured default's executable was not found and this chat was routed to
   * another backend (D31): the fixed notice to show. Never persisted.
   */
  readonly fallbackNotice?: string
}

/**
 * Panel attention derived from the chat's newest turn-log entry: `error` for a
 * turn that settled `error` or a send that failed to reconnect, `warning` for a
 * turn answered by a fresh session (or a fresh-session event awaiting its turn).
 */
export type ChatAttention = 'error' | 'warning'

/** Attention of the newest log entry, if any (see {@link ChatAttention}). */
export function attentionOf(entry: LogEntry | undefined): ChatAttention | undefined {
  if (entry === undefined) return undefined
  if (entry.kind === 'turn') return entry.stopReason === 'error' ? 'error' : entry.freshSession ? 'warning' : undefined
  return entry.event === 'reconnect-failed' ? 'error' : 'warning'
}

/** Reason the current send replaced its saved remote session. */
export type FreshSessionReason = 'load-rejected' | 'repeated-errors'

/** Number of consecutive settled `error` turns before the next send starts a fresh remote session (D6). */
export const CONSECUTIVE_ERROR_FRESH_SESSION_THRESHOLD = 3
/** Stable identity of the legacy top-level backend (D24). */
export const DEFAULT_BACKEND = 'default'

/** Return the model-facing notice for a fresh-session fallback. */
export function freshSessionNotice(reason: FreshSessionReason): string {
  return reason === 'load-rejected'
    ? '[remote session lost, started fresh — prior context is gone; restate what matters and re-ask]'
    : '[remote session failed repeatedly, started fresh — prior context is gone; restate what matters and re-ask]'
}

/** Terminal result of one pooled send. */
export interface PoolSendResult {
  readonly chatId: string
  readonly remoteSessionId: string
  /** The turn's assistant text. */
  readonly output: string
  readonly stopReason: string
  /** True when the saved remote session was replaced and a FRESH one answered instead. */
  readonly freshSession: boolean
  /** Why `freshSession` is true; absent when this turn stayed on its saved session. */
  readonly freshSessionReason: FreshSessionReason | undefined
  readonly diagnostic: string | undefined
}

/** Optional observers of one {@link AcpSessionPool.send}; a throwing observer is contained. */
export interface PoolSendHooks {
  /** Called once, before the message is sent, when a role was just provisioned on a fallback backend (D31); receives the fixed notice. */
  readonly onBackendFallback?: (notice: string) => void
  /** Called once, before the prompt is sent, when a FRESH remote session replaces the saved one. */
  readonly onFreshSession?: (reason: FreshSessionReason) => void
  /** Each assistant text chunk of this turn, in arrival order; their concatenation is `output`. */
  readonly onText?: (text: string) => void
  /** Resolves this turn's ACP permission request under `permission: ask`; absent fails closed. */
  readonly permissionResolver?: PermissionRequestResolver
}

/** Pool construction inputs: the spawn base plus durability knobs. */
export interface BackendSpec {
  readonly name: string
  readonly description: string
  readonly specBase: Omit<AcpSessionSpec, 'cwd'>
  /** Wire protocol of the child (D25). Absent means `acp`. */
  readonly protocol?: 'acp' | 'codex'
  /** Synthesized from installed CLI discovery, rather than authored by the user. */
  readonly automatic?: true
  /** Codex thread parameters; model may be resolved by the readiness probe. */
  readonly codex?: {
    readonly model?: string
    readonly sandbox?: string
    readonly approvalPolicy?: string
    readonly effort?: string
  }
}

export interface PoolOptions {
  /** Everything except `cwd` of the default backend's per-run spawn spec. */
  readonly specBase: Omit<AcpSessionSpec, 'cwd'>
  /** Named backends in addition to the default backend (D24). */
  readonly backends?: ReadonlyMap<string, BackendSpec>
  /** Registry file path; created (with parent dirs) on first change. */
  readonly registryPath: string
  /** Idle window (ms) after a settled turn before the process is released; positive, ≤ `MAX_TIMER_DELAY_MS`. */
  readonly idleTimeoutMs: number
  /** Non-fatal pool conditions (e.g. a corrupt registry file set aside). */
  readonly onWarn?: (message: string) => void
  /** Host admission for new chats, independent of existing chats' saved bindings. */
  readonly dispatch?: {
    select(backend?: string, signal?: AbortSignal): string | Promise<string>
    /** Like `select`, plus whether the configured default was replaced because its executable was not found. */
    route?(backend?: string, signal?: AbortSignal): DispatchRoute | Promise<DispatchRoute>
    executable?(backend: string): string | undefined
    model?(backend: string): string | undefined
    failure?(backend: string, reason: 'login-required'): void
  }
}

interface RegistryEntry {
  chatId: string
  remoteSessionId: string
  cwd: string
  /** Optional; registries written before labels existed omit it. */
  label?: string
  /** Optional; set once by the first completed turn with non-empty message text. */
  title?: string
  /** Optional; completed turns only. Older registries omit it and count from 0. */
  turnCount?: number
  /** Optional (D20); the DSH session that opened the chat. Older registries omit it. */
  ownerSessionId?: string
  /** Missing only in version-1 records, which route to the default backend. */
  backend?: string
  command: string
  args: readonly string[]
  lastActive: number
}

/** Optional inputs for {@link AcpSessionPool.start}. */
export interface PoolStartOptions {
  /** Display label persisted with the chat (trimmed; empty means none). */
  readonly label?: string
  /** The DSH session opening the chat, recorded for panel attribution (D20); empty/undefined means none. */
  readonly ownerSessionId?: string
  /** Backend selected at chat creation; omitted means the default backend. */
  readonly backend?: string
}

/** One prompt currently running on a pooled chat; a volatile panel projection, not a turn-log record. */
export interface InFlightTurn {
  readonly chatId: string
  readonly message: string
  readonly startedAt: number
}

/** An open window (`start` or reconnect) and the controller teardown aborts it with. */
interface OpenWindow {
  readonly promise: Promise<unknown>
  readonly controller: AbortController
}

interface RegistryFile {
  version: 1
  sessions: RegistryEntry[]
  /** D27 role rosters by owner session; absent in registries written before rosters. */
  rosters?: RosterTable
}

/** Who addresses a role and where its workspace team file is looked up from (D27). */
export interface RoleCallContext {
  /** The calling DSH session; rosters are per session. */
  readonly ownerSessionId: string
  /** The calling session's working directory: start of the `.agents/acp-team.yml` search. */
  readonly workspaceDir: string
}

/** A send addressed by role: the pool result plus the role and whether this call provisioned it. */
export type RoleSendResult = PoolSendResult & {
  readonly role: string
  readonly provisioned: boolean
  /** Set when this call provisioned the role on a fallback backend (D31): the fixed notice. */
  readonly fallbackNotice?: string
}

/** A pooled chat's live state (absent while released). */
interface LiveChat {
  buffer?: LiveBuffer
  jobText?: PoolSendHooks['onText']
  receiveText(text: string): void
  readonly chatId: string
  conn: AcpConnection
  idleTimer: NodeJS.Timeout | undefined
  busy: boolean
  changing?: boolean
  /** The in-flight turn's promise; a release cancels it and waits (bounded) for it to settle. */
  busyPromise: Promise<unknown> | undefined
  /** The in-flight prompt's volatile panel projection; removed when this turn settles. */
  inFlight: InFlightTurn | undefined
  /** Set once a release started; concurrent closes share it. */
  closing: Promise<void> | undefined
}

/** Shared function, no callback or buffer allocated on the per-chunk path without viewers. */
function receiveText(this: LiveChat, text: string): void {
  const buffer = this.buffer
  try { this.jobText?.(text) } catch { /* A failing job observer cannot starve the panel. */ }
  // A subscription opened by the job observer already seeded itself with this chunk.
  if (buffer && buffer === this.buffer) buffer.append(text)
}

/** Maximum `title` length, in characters (code points, so a surrogate pair is never split). */
const TITLE_MAX_CHARS = 40

/**
 * The registry entry after a settled turn. Only `completed` turns count and
 * may set the title. An entry written before these fields existed (no
 * `turnCount`, no `title`) is the established case of "no completed turn
 * recorded yet": its first completed turn counts as 1 and writes the title.
 * A non-numeric `turnCount` (hand-edited file) is treated the same way.
 */
function settledEntry(entry: RegistryEntry, stopReason: string, message: string, now: number): RegistryEntry {
  if (stopReason !== 'completed') return { ...entry, lastActive: now }
  const prior = typeof entry.turnCount === 'number' && Number.isFinite(entry.turnCount) ? entry.turnCount : 0
  const next: RegistryEntry = { ...entry, turnCount: prior + 1, lastActive: now }
  if (typeof entry.title !== 'string' || entry.title === '') {
    const title = Array.from(message.trim()).slice(0, TITLE_MAX_CHARS).join('')
    if (title !== '') next.title = title
  }
  return next
}

function emptyRegistry(): RegistryFile {
  return { version: 1, sessions: [] }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function blockText(blocks: readonly { type: string; text?: string }[]): string {
  return blocks.filter(b => b.type === 'text').map(b => b.text).join('')
}

function roleKey(role: string, ownerSessionId: string): string {
  return `${ownerSessionId}\u0000${role}`
}

const BUSY_TURN_GUIDANCE = 'Retry after the current turn finishes. For a background job, wait_agent can wait for the completion notice or user input if available.'

function roleInFlight(role: string): Error {
  return new Error(`acp-resume: role ${role} is still being set up or already has a prompt in flight. ${BUSY_TURN_GUIDANCE}`)
}

/** Resolve once `promise` settles or `ms` elapses, whichever comes first. Never rejects. */
async function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const elapsed = new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.ceil(ms)) })
  try {
    await Promise.race([promise.then(() => undefined, () => undefined), elapsed])
  } finally {
    clearTimeout(timer)
  }
}

/** The caller's signal joined with the pool-owned window controller. */
function windowSignal(controller: AbortController, signal: AbortSignal | undefined): AbortSignal {
  return signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function sameArgs(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function isRegistryFile(value: unknown): value is RegistryFile {
  return typeof value === 'object' && value !== null
    && Reflect.get(value, 'version') === 1
    && Array.isArray(Reflect.get(value, 'sessions'))
}

/**
 * Durable, atomically-written chat registry. Single-writer (this pool).
 * A missing file is an empty registry. An unreadable, unparsable, or
 * mis-shaped file is renamed to `<path>.corrupt-<timestamp>` and the pool
 * continues with an empty registry, reporting through `onWarn`.
 */
class ChatRegistry implements RosterStore {
  private file: RegistryFile

  constructor(private readonly path: string, onWarn: ((message: string) => void) | undefined) {
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch (error: unknown) {
      if (Reflect.get(toError(error), 'code') === 'ENOENT') {
        this.file = emptyRegistry()
        return
      }
      this.file = this.setAside(`unreadable (${toError(error).message})`, onWarn)
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error: unknown) {
      this.file = this.setAside(`not valid JSON (${toError(error).message})`, onWarn)
      return
    }
    this.file = isRegistryFile(parsed)
      ? parsed
      : this.setAside('not a version 1 registry with a sessions array', onWarn)
    const rosters = this.file.rosters
    if (rosters !== undefined && Object.keys(toRosterTable(rosters)).length !== Object.keys(rosters).length) {
      onWarn?.(`acp-resume: registry ${path} has a malformed rosters section; unreadable rosters are treated as empty`)
    }
  }

  readRosters(): unknown {
    return this.file.rosters
  }

  writeRosters(next: RosterTable): void {
    this.write({ ...this.file, rosters: next })
  }

  private setAside(reason: string, onWarn: ((message: string) => void) | undefined): RegistryFile {
    const target = `${this.path}.corrupt-${Date.now()}`
    try {
      renameSync(this.path, target)
      onWarn?.(`acp-resume: registry ${this.path} is ${reason}; moved to ${target}, starting with an empty registry`)
    } catch (error: unknown) {
      onWarn?.(`acp-resume: registry ${this.path} is ${reason} and could not be moved to ${target} (${toError(error).message}); starting with an empty registry, the next write replaces the file`)
    }
    return emptyRegistry()
  }

  all(): readonly RegistryEntry[] {
    return this.file.sessions
  }

  get(chatId: string): RegistryEntry | undefined {
    return this.file.sessions.find(s => s.chatId === chatId)
  }

  remove(chatId: string): void {
    this.write({ ...this.file, sessions: this.file.sessions.filter(s => s.chatId !== chatId) })
  }

  upsert(entry: RegistryEntry): void {
    const next = this.file.sessions.filter(s => s.chatId !== entry.chatId)
    next.push(entry)
    this.write({ ...this.file, sessions: next })
  }

  /** Disk first, then memory: a failed write throws and leaves both at the previous state. */
  private write(next: RegistryFile): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(next, undefined, 2))
    renameSync(tmp, this.path)
    this.file = next
  }
}

/**
 * The persistent ACP chat pool. One instance per plugin; chats are addressed
 * by their parent-minted chatId and survive process release, pool
 * reconstruction, and host restarts through the registry file.
 */
export class AcpSessionPool {
  private readonly live = new Map<string, LiveChat>()
  /** Consecutive settled `error` turns by chat; volatile D6 recovery state, never persisted. */
  private readonly consecutiveErrorTurns = new Map<string, number>()
  /**
   * Open windows in progress (`start` and reconnects), keyed by chatId. Each
   * promise settles only after its connection is tracked or disposed. Teardown
   * aborts the window's controller (the startup race then disposes the child)
   * and waits at most one dispose ladder (see {@link windowGraceMs}); a window
   * that settles later with a connection sees its aborted controller and
   * discards it.
   */
  private readonly starting = new Map<string, OpenWindow>()
  private readonly backends: ReadonlyMap<string, BackendSpec>
  private readonly registry: ChatRegistry
  private readonly roster: Roster
  /** Role provisioning in progress, keyed by owner and role: the D27 single-flight claim. */
  private readonly provisioning = new Map<string, Promise<PooledChatInfo>>()
  private readonly turnLog: TurnLog
  /** D29 run log, one file per owner session. */
  private readonly workflowLog: WorkflowLog
  /** D29 runs in progress by owner session; memory only. */
  private readonly runningWorkflows = new Map<string, Map<string, TrackedRun>>()
  private disposed = false

  constructor(private readonly opts: PoolOptions) {
    const idle = opts.idleTimeoutMs
    if (!Number.isFinite(idle) || idle <= 0 || idle > MAX_TIMER_DELAY_MS) {
      throw new Error(`acp-resume: idleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
    }
    this.backends = new Map([[DEFAULT_BACKEND, { name: DEFAULT_BACKEND, description: basename(opts.specBase.command), specBase: opts.specBase }], ...(opts.backends ?? new Map()).entries()])
    this.registry = new ChatRegistry(opts.registryPath, opts.onWarn)
    this.roster = new Roster(this.registry)
    this.turnLog = new TurnLog(join(dirname(opts.registryPath), 'turns'), opts.onWarn)
    this.workflowLog = new WorkflowLog(join(dirname(opts.registryPath), 'workflows'), opts.onWarn)
  }

  /** Registry rows (durable chats, live or released). */
  listChats(): readonly PooledChatInfo[] {
    return this.registry.all().map(e => this.withAttention(e.chatId, {
      chatId: e.chatId,
      remoteSessionId: e.remoteSessionId,
      cwd: e.cwd,
      ...(typeof e.label === 'string' && e.label !== '' ? { label: e.label } : {}),
      ...(typeof e.title === 'string' && e.title !== '' ? { title: e.title } : {}),
      ...(typeof e.turnCount === 'number' ? { turnCount: e.turnCount } : {}),
      ...(typeof e.ownerSessionId === 'string' && e.ownerSessionId !== '' ? { ownerSessionId: e.ownerSessionId } : {}),
      backend: this.backendName(e),
      backendDisplay: this.displayBackend(this.backendName(e)),
      backendCount: this.backends.size,
      ...(this.live.get(e.chatId)?.inFlight === undefined ? {} : { inFlight: this.live.get(e.chatId)?.inFlight }),
      ...this.rowSettings(e.chatId),
      active: this.live.has(e.chatId),
      lastActive: e.lastActive,
    }))
  }

  private rowSettings(chatId: string) {
    const chat = this.live.get(chatId)
    if (!chat || chat.closing || chat.conn.processSettled) return {}
    const report = chat.conn.settingsReport
    return { connectionId: chat.conn.id, ...(report?.model && { currentModel: report.model }),
      ...(report?.effort && { currentEffort: report.effort }) }
  }

  /** Add attention, completion, and memory-only team projections (`role` / `latestTurn`); reuses the single cached turn-log read. */
  private withAttention(chatId: string, info: PooledChatInfo): PooledChatInfo {
    const entries = this.turnLog.read(chatId)
    const newest = entries.at(-1)
    const attention = attentionOf(newest)
    const team = projectChatTeamView(chatId, info.ownerSessionId, (id, owner) => this.roster.roleOf(id, owner), entries)
    return {
      ...info,
      ...team,
      ...(attention !== undefined
        ? { attention }
        : newest?.kind === 'turn' && newest.stopReason === 'completed'
          ? { lastCompleted: true as const }
          : {}),
    }
  }

  /** One chat's registry projection, or undefined when the chatId is unknown. */
  chatInfo(chatId: string): PooledChatInfo | undefined {
    return this.listChats().find(chat => chat.chatId === chatId)
  }

  /** The chat's retained turn-log entries, oldest first (empty for an unknown chat or a chat with no log). */
  turnEntries(chatId: string): readonly LogEntry[] {
    return this.registry.get(chatId) === undefined ? [] : this.turnLog.read(chatId)
  }

  /** Does the chatId exist in the durable registry? */
  knows(chatId: string): boolean {
    return this.registry.get(chatId) !== undefined
  }

  /** Owner claimed by the creating DSH session, including for released chats. */
  chatOwner(chatId: string): string | undefined { return this.registry.get(chatId)?.ownerSessionId }

  /** Bind to this turn only. A viewer arriving late seeds its buffer from the existing connection accumulator. */
  subscribeLive(chatId: string): LiveSubscription {
    const chat = this.live.get(chatId)
    if (!chat?.inFlight) return { frames: (async function* () { yield { kind: 'settled' as const, seq: 0 } })(), close() {} }
    if (!chat.buffer) {
      const buffer: LiveBuffer = new LiveBuffer(chat.conn.currentTurnText, () => {
        if (chat.buffer === buffer) chat.buffer = undefined
      })
      chat.buffer = buffer
    }
    return chat.buffer.subscribe()
  }

  /** Snapshot of the connection report. Reading options never opens or wakes a chat. */
  chatOptions(chatId: string): ChatOptions {
    const entry = this.registry.get(chatId)
    if (!entry) throw new Error(`acp-resume: unknown chat ${chatId}`)
    const backend = this.backendName(entry)
    if (this.backends.get(backend)?.protocol === 'codex') {
      return { backend, supported: false, canChange: false, reason: 'codex session-level switch is not available yet' }
    }
    const chat = this.live.get(chatId)
    if (!chat || chat.closing || chat.conn.processSettled) return { backend, supported: true, canChange: false, reason: 'released' }
    const reason = (chat.busy || this.starting.has(chatId)) ? 'running' : chat.changing ? 'changing' : undefined
    return { ...chat.conn.sessionChoices, backend, supported: true, canChange: !reason, ...(reason && { reason }) }
  }

  setChatModel(chatId: string, value: string): Promise<void> { return this.changeSelection(chatId, 'model', value) }
  setChatEffort(chatId: string, value: string): Promise<void> { return this.changeSelection(chatId, 'effort', value) }

  private async changeSelection(chatId: string, field: 'model' | 'effort', value: string): Promise<void> {
    this.assertLive()
    const state = this.chatOptions(chatId)
    if (state.reason === 'released') throw new Error(`chat ${chatId} is released; send a message to reconnect first`)
    if (state.reason === 'running') throw new Error(`chat ${chatId} is running; wait for the turn to finish`)
    if (state.reason) throw new Error(state.reason === 'changing' ? 'a session setting change is in progress' : state.reason)
    const selection = state[field]
    if (!selection || selection === 'not-offered' || !selection.options.some(option => option.value === value)) {
      throw new Error(`backend does not offer ${field} "${value}" for this chat`)
    }
    const chat = this.live.get(chatId)!
    if (!chat.conn.setSelection) throw new Error('session-level settings are unavailable')
    chat.changing = true
    this.clearIdleTimer(chat)
    try {
      await chat.conn.setSelection(field, value)
      if (chat.closing || this.live.get(chatId) !== chat) throw new Error(`chat ${chatId} was released during the setting change`)
    } catch (error) {
      this.report(error)
      throw error
    } finally {
      chat.changing = false
      this.armIdle(chat)
    }
  }

  /** Start a fresh durable chat: new process, new remote session. */
  async start(cwd: string, signal?: AbortSignal, options: PoolStartOptions = {}): Promise<PooledChatInfo> {
    this.assertLive()
    // Fail loud at the earliest resolvable point, mirroring the official provider start.
    assertUsableCwd('acp-resume', 'chat cwd', cwd)
    const label = options.label?.trim() ?? ''
    const dispatch = this.opts.dispatch
    const routed: DispatchRoute | Promise<DispatchRoute> = dispatch === undefined
      ? { backend: options.backend ?? DEFAULT_BACKEND }
      : dispatch.route !== undefined
        ? dispatch.route(options.backend, signal)
        : (() => {
            const picked = dispatch.select(options.backend, signal)
            return typeof picked === 'string' ? { backend: picked } : picked.then(backend => ({ backend }))
          })()
    const route = routed instanceof Promise ? await routed : routed
    const backend = route.backend
    this.assertLive()
    const backendSpec = this.backends.get(backend)
    if (backendSpec === undefined) throw new Error(`acp-resume: unknown backend ${backend}`)
    const ownerSessionId = options.ownerSessionId?.trim() ?? ''
    const chatId = `chat-${randomUUID()}`
    const now = Date.now()
    const controller = new AbortController()
    const opening = (async (): Promise<AcpConnection> => {
      const startupSignal = windowSignal(controller, signal)
      let conn: AcpConnection
      try {
        conn = await this.connect(backendSpec, cwd, { mode: 'new' }, startupSignal, 'start')
      } catch (error: unknown) {
        if (!startupSignal.aborted && error instanceof AcpConnectionError && this.opts.dispatch !== undefined) {
          const needsLogin = backendSpec.protocol !== 'codex' && error.category === 'protocol' && error.jsonRpcCode === -32000 // ACP AuthRequired
          if (needsLogin || error.stage === 'initialize') {
            if (needsLogin) this.opts.dispatch.failure?.(backend, 'login-required')
            const action = needsLogin ? 'Sign in using the backend CLI, then open Right sidebar → ACP chats → Recheck backends next to Backend status (右侧栏 → ACP 会话 → 后端状态旁的「重新检测后端」).'
              : 'Retry this backend, or open Right sidebar → ACP chats → Recheck backends next to Backend status (右侧栏 → ACP 会话 → 后端状态旁的「重新检测后端」) for diagnostics.'
            throw new Error(`${error.message}\nBackend ${backend} did not open a session. ${action}`, { cause: error })
          }
        }
        throw error
      }
      if (this.disposed) await this.discard(conn, 'acp-resume: pool already disposed')
      if (controller.signal.aborted) await this.discard(conn, `acp-resume: chat ${chatId} was released before it started`)
      try {
        this.registry.upsert({
          chatId,
          remoteSessionId: conn.remoteSessionId,
          cwd,
          ...(label === '' ? {} : { label }),
          ...(ownerSessionId === '' ? {} : { ownerSessionId }),
          backend,
          command: backendSpec.specBase.command,
          args: backendSpec.specBase.args,
          lastActive: now,
        })
      } catch (error: unknown) {
        // Not tracked yet: without this dispose the child would be an orphan no close or teardown reaches.
        await this.disposeQuietly(conn)
        throw error
      }
      this.track(chatId, conn)
      return conn
    })()
    this.starting.set(chatId, { promise: opening, controller })
    let conn: AcpConnection
    try {
      conn = await opening
    } catch (error: unknown) {
      this.assertLive()
      throw error
    } finally {
      this.starting.delete(chatId)
    }
    this.assertLive()
    const fallbackNotice = route.fallbackFrom === undefined ? undefined : this.fallbackNotice(route.fallbackFrom, backend)
    return { chatId, remoteSessionId: conn.remoteSessionId, cwd, ...(label === '' ? {} : { label }), ...(ownerSessionId === '' ? {} : { ownerSessionId }), backend, backendDisplay: this.displayBackend(backend), backendCount: this.backends.size, active: true, lastActive: now, ...(fallbackNotice === undefined ? {} : { fallbackNotice }) }
  }

  /**
   * The fixed model- and user-facing sentence for a fallback (D31, 2026-11-25):
   * `kiro-cli was not found; this chat uses codex (read-only)`. `(read-only)`
   * appears for a Codex backend whose sandbox is read-only (the auto-discovered
   * one always is); the missing command is the replaced backend's basename.
   */
  private fallbackNotice(from: string, backend: string): string {
    const spec = this.backends.get(backend)
    const readOnly = spec?.protocol === 'codex' && (spec.codex?.sandbox ?? 'read-only') === 'read-only'
    return `${this.displayBackend(from)} was not found; this chat uses ${backend}${readOnly ? ' (read-only)' : ''}`
  }

  /**
   * Send one message to a durable chat, reconnecting through `session/load`
   * when no live process exists. A `session/load` rejection proving the saved session missing,
   * or a prior run of three settled `error` turns in this pool instance,
   * answers from a FRESH remote session (`freshSession: true`); any other
   * reconnect failure rejects and keeps the saved remote session id.
   * Rejects while another prompt on the same chat is in flight, and rejects
   * an already-aborted signal without touching the chat's connection. The
   * in-flight claim is taken synchronously within this call (before its first
   * await) unless a release of the chat is already underway.
   */
  async send(chatId: string, message: string, signal?: AbortSignal, hooks: PoolSendHooks = {}): Promise<PoolSendResult> {
    this.assertLive()
    if (isAborted(signal)) throw new Error('acp-resume: send aborted before it started')
    const entry = this.registry.get(chatId)
    if (entry === undefined) throw new Error(`acp-resume: unknown chat ${chatId}`)
    // Existing chats use their saved backend, not the admission policy for new chats.
    const existing = this.live.get(chatId)
    if (existing?.changing) throw new Error(`chat ${chatId} is changing session settings; try again when it finishes`)
    if (existing?.busy === true || this.starting.has(chatId)) {
      throw new Error(`acp-resume: chat ${chatId} already has a prompt in flight. ${BUSY_TURN_GUIDANCE}`)
    }
    if (existing?.closing !== undefined) {
      // A release is underway: let it finish, then take the released path.
      await existing.closing.catch(() => undefined)
      return this.send(chatId, message, signal, hooks)
    }
    if (existing?.conn.processSettled === true) {
      // The process already exited: release the dead connection and reconnect.
      await this.close(chatId).catch((error: unknown) => { this.report(error) })
      return this.send(chatId, message, signal, hooks)
    }

    let freshSession = false
    let freshSessionReason: FreshSessionReason | undefined
    if (existing === undefined) {
      try {
        this.assertSameAgent(entry)
      } catch (error: unknown) {
        this.logReconnectFailed(chatId, message, error)
        throw error
      }
      const released = `acp-resume: chat ${chatId} was released before the prompt started`
      // Claim the open window BEFORE awaiting: a concurrent send on this chat
      // must be rejected above, not leak a second connection.
      const controller = new AbortController()
      const reconnect = (async (): Promise<FreshSessionReason | undefined> => {
        const forceFresh = (this.consecutiveErrorTurns.get(chatId) ?? 0) >= CONSECUTIVE_ERROR_FRESH_SESSION_THRESHOLD
        const opened = await this.reopen(entry, windowSignal(controller, signal), forceFresh)
        if (this.disposed) await this.discard(opened.conn, 'acp-resume: pool already disposed')
        if (controller.signal.aborted) await this.discard(opened.conn, released)
        const current = this.registry.get(chatId)
        if (current === undefined) await this.discard(opened.conn, `acp-resume: chat ${chatId} was removed while reconnecting`)
        else if (opened.freshSessionReason !== undefined) {
          try {
            this.registry.upsert({ ...current, remoteSessionId: opened.conn.remoteSessionId, lastActive: Date.now() })
          } catch (error: unknown) {
            // Same orphan guard as start(); the registry keeps the old remote session id.
            await this.disposeQuietly(opened.conn)
            throw error
          }
          this.logEntry(chatId, {
            kind: 'event',
            event: opened.freshSessionReason === 'load-rejected' ? 'session-lost' : 'session-reset-after-errors',
            at: Date.now(),
            ...(opened.lost === undefined ? {} : { error: opened.lost.message }),
          })
        }
        this.track(chatId, opened.conn)
        return opened.freshSessionReason
      })()
      this.starting.set(chatId, { promise: reconnect, controller })
      try {
        freshSessionReason = await reconnect
        freshSession = freshSessionReason !== undefined
      } catch (error: unknown) {
        // A teardown-aborted window reports the teardown, not the startup race's abort text.
        this.assertLive()
        if (controller.signal.aborted && !isAborted(signal)) throw new Error(released, { cause: error })
        this.logReconnectFailed(chatId, message, error)
        throw error
      } finally {
        this.starting.delete(chatId)
      }
      this.assertLive()
      if (freshSessionReason !== undefined && hooks.onFreshSession !== undefined) {
        try { hooks.onFreshSession(freshSessionReason) } catch { /* an observer cannot break the send */ }
      }
    }

    const chat = this.live.get(chatId)
    if (chat === undefined || chat.closing !== undefined) {
      throw new Error(`acp-resume: chat ${chatId} was released before the prompt started`)
    }
    const conn = chat.conn
    chat.busy = true
    this.clearIdleTimer(chat)
    const startedAt = Date.now()
    const inFlight: InFlightTurn = { chatId, message, startedAt }
    chat.inFlight = inFlight
    chat.jobText = hooks.onText
    const turnPromise = conn.prompt(
      [{ type: 'text', text: message }],
      signal ?? new AbortController().signal,
      chat,
      hooks.permissionResolver,
    )
    chat.busyPromise = turnPromise
    try {
      const turn = await turnPromise
      // Re-read: a purge during the turn must not be resurrected by this update.
      const current = this.registry.get(chatId)
      const settledAt = Date.now()
      const output = blockText(turn.output)
      if (current !== undefined) {
        this.registry.upsert(settledEntry(current, turn.stopReason, message, settledAt))
        this.recordSettledTurn(chatId, turn.stopReason)
      } else {
        this.consecutiveErrorTurns.delete(chatId)
      }
      this.logEntry(chatId, {
        kind: 'turn', startedAt, at: settledAt, message, output, stopReason: turn.stopReason, freshSession,
        ...(turn.diagnostic === undefined ? {} : { diagnostic: turn.diagnostic }),
      })
      // A cancelled turn leaves the connection's stream state indeterminate: ACP
      // updates carry no turn identity, so a late chunk from the cancelled turn
      // would pollute the next turn on the SAME connection. A failed turn usually
      // means a dead or broken child. The official one-shot answers both with
      // process teardown; the pool does the same and lets the next send rebuild
      // context through session/load. The turn result outranks a teardown failure.
      if (turn.stopReason === 'aborted' || turn.stopReason === 'error') {
        await this.close(chatId).catch((error: unknown) => { this.report(error) })
      }
      return {
        chatId,
        remoteSessionId: conn.remoteSessionId,
        output,
        stopReason: turn.stopReason,
        freshSession,
        freshSessionReason,
        diagnostic: turn.diagnostic,
      }
    } finally {
      chat.busy = false
      chat.busyPromise = undefined
      chat.jobText = undefined
      if (chat.inFlight === inFlight) chat.inFlight = undefined
      chat.buffer?.settle()
      chat.buffer = undefined
      if (!this.disposed) this.armIdle(chat)
    }
  }

  /**
   * Synchronous preflight with the same verdicts {@link send} reaches before
   * it claims the chat: throws when the pool is disposed, the chat is unknown,
   * a prompt is already in flight on it, or (for a released chat) its record
   * belongs to another agent command. Lets a caller refuse a send before
   * committing to background work.
   */
  assertSendable(chatId: string): void {
    this.assertLive()
    const entry = this.registry.get(chatId)
    if (entry === undefined) throw new Error(`acp-resume: unknown chat ${chatId}`)
    const existing = this.live.get(chatId)
    if (existing?.busy === true || this.starting.has(chatId)) {
      throw new Error(`acp-resume: chat ${chatId} already has a prompt in flight. ${BUSY_TURN_GUIDANCE}`)
    }
    if (existing === undefined) this.assertSameAgent(entry)
  }

  /**
   * Queue a steering message into the chat's in-flight turn. Needs a live
   * connection with a turn in flight; it neither claims the chat nor touches
   * the turn, so several steers may be sent while a turn runs (the agent
   * queues them in order).
   * @throws when the pool is disposed, the chat is unknown, or no turn is in
   *   flight; {@link AcpSteerUnsupportedError} when the agent lacks `_session/steer`.
   */
  async steer(chatId: string, message: string): Promise<AcpSteerResult> {
    this.assertLive()
    if (this.registry.get(chatId) === undefined) throw new Error(`acp-resume: unknown chat ${chatId}`)
    const chat = this.live.get(chatId)
    if (chat === undefined || !chat.busy || chat.closing !== undefined) {
      throw new Error(`acp-resume: chat ${chatId} has no turn in flight, so there is nothing to steer; use send instead`)
    }
    return chat.conn.steer(message)
  }

  /**
   * Release the process AND delete the durable record (cannot reconnect
   * afterwards). If the release fails, the record is kept and the error says so.
   */
  async remove(chatId: string): Promise<void> {
    try {
      await this.close(chatId)
    } catch (error: unknown) {
      throw new Error(`acp-resume: releasing chat ${chatId} failed; its record is kept: ${toError(error).message}`, { cause: error })
    }
    const owner = this.registry.get(chatId)?.ownerSessionId
    this.registry.remove(chatId)
    this.roster.removeChat(chatId)
    this.consecutiveErrorTurns.delete(chatId)
    this.turnLog.remove(chatId)
    // D29: once a session has no chat left, its workflow log has nothing to point to.
    if (owner !== undefined && owner !== '' && !this.registry.all().some(e => e.ownerSessionId === owner)) this.workflowLog.remove(owner)
  }

  // ---- D29 workflows ----------------------------------------------------

  /**
   * Start tracking one workflow run for the session: writes its `run-start`
   * line, keeps it in the running set, and returns the observer that records
   * the current step and each member's role, chat, and outcome. The run id is
   * minted here so the official progress card can share it.
   */
  trackWorkflow(ownerSessionId: string, template: string, jobId?: string): WorkflowTracker {
    const run: TrackedRun = { runId: randomUUID(), template, startedAt: Date.now(), jobId, currentStep: undefined, steps: [] }
    let runs = this.runningWorkflows.get(ownerSessionId)
    if (runs === undefined) {
      runs = new Map()
      this.runningWorkflows.set(ownerSessionId, runs)
    }
    runs.set(run.runId, run)
    this.workflowLog.appendRunStart(ownerSessionId, run.runId, template, run.startedAt, jobId)
    const stepFor = (id: string): TrackedRun['steps'][number] => {
      let step = run.steps.find(s => s.id === id)
      if (step === undefined) {
        step = { id, members: [] }
        run.steps.push(step)
      }
      return step
    }
    const members = new Map<number, { role: string; chatId?: string; outcome?: MemberOutcome }>()
    let seq = 0
    let finished = false
    return {
      runId: run.runId,
      observer: {
        stepStart: (id) => {
          run.currentStep = id
          stepFor(id)
        },
        memberStart: (role, stepId) => {
          seq += 1
          const member: { role: string; chatId?: string; outcome?: MemberOutcome } = { role }
          stepFor(stepId).members.push(member)
          members.set(seq, member)
          return seq
        },
        memberEnd: (memberSeq, outcome, chatId) => {
          const member = members.get(memberSeq)
          if (member === undefined) return
          member.outcome = outcome
          if (chatId !== undefined) member.chatId = chatId
        },
      },
      finish: (result) => {
        if (finished) return
        finished = true
        runs.delete(run.runId)
        if (runs.size === 0) this.runningWorkflows.delete(ownerSessionId)
        this.workflowLog.appendRunEnd(ownerSessionId, run.runId, Date.now(), result.status, summarize(run), result.error)
      },
    }
  }

  /** The session's running workflows (this pool instance) and its newest finished ones (file). */
  listWorkflows(ownerSessionId: string): SessionWorkflows {
    const runs = [...(this.runningWorkflows.get(ownerSessionId)?.values() ?? [])]
    const running: RunningWorkflow[] = runs.map(run => ({
      runId: run.runId,
      template: run.template,
      startedAt: run.startedAt,
      ...(run.jobId === undefined ? {} : { jobId: run.jobId }),
      ...(run.currentStep === undefined ? {} : { currentStep: run.currentStep }),
      steps: summarize(run),
    }))
    return { running, recent: this.workflowLog.readRecent(ownerSessionId, new Set(runs.map(r => r.runId))) }
  }

  // ---- D27 roles --------------------------------------------------------

  /** The session's roster entries whose chat records still exist. */
  listRoster(ownerSessionId: string): readonly RosterEntry[] {
    return this.roster.list(ownerSessionId).filter(entry => this.registry.get(entry.chatId) !== undefined)
  }

  /** The role a chat plays in the session's roster (any roster when the owner is unknown). */
  roleOf(chatId: string, ownerSessionId?: string): string | undefined {
    return this.roster.roleOf(chatId, ownerSessionId)
  }

  /** The chat instantiating `role` for the session; a binding whose chat record is gone is dropped. */
  resolveRole(role: string, ownerSessionId: string): string | undefined {
    const entry = this.roster.resolve(role, ownerSessionId)
    if (entry === undefined) return undefined
    if (this.registry.get(entry.chatId) !== undefined) return entry.chatId
    this.roster.remove(role, ownerSessionId)
    return undefined
  }

  /**
   * Synchronous preflight for {@link sendByRole}, mirroring {@link assertSendable}:
   * an instantiated role checks its chat; an uninstantiated one checks that it is
   * not being provisioned and that the workspace defines it on a configured backend.
   */
  assertRoleSendable(role: string, context: RoleCallContext): void {
    this.assertLive()
    // Provisioning outranks the roster: the entry is written before the provisioning call's own send claims the chat.
    if (this.provisioning.has(roleKey(role, context.ownerSessionId))) throw roleInFlight(role)
    const chatId = this.resolveRole(role, context.ownerSessionId)
    if (chatId !== undefined) this.assertSendable(chatId)
    else this.blueprintFor(role, context)
  }

  /**
   * Send to a role (D27). An instantiated role routes to its chat (reconnecting
   * a released one through `session/load`); otherwise the role is provisioned
   * from the workspace blueprint first — start, seeding turn, roster entry —
   * then the message is sent. The instantiated path claims the chat before the
   * first await, as {@link send} does; provisioning is single-flight per session and role.
   */
  async sendByRole(role: string, message: string, context: RoleCallContext, signal?: AbortSignal, hooks: PoolSendHooks = {}): Promise<RoleSendResult> {
    this.assertLive()
    if (this.provisioning.has(roleKey(role, context.ownerSessionId))) throw roleInFlight(role)
    const existing = this.resolveRole(role, context.ownerSessionId)
    if (existing !== undefined) return { ...await this.send(existing, message, signal, hooks), role, provisioned: false }
    // The seeding turn gets the same confirmation bridge as the message: under `permission: ask` it may ask too.
    const chat = await this.provision(role, context, signal, hooks.permissionResolver)
    if (chat.fallbackNotice !== undefined && hooks.onBackendFallback !== undefined) {
      try { hooks.onBackendFallback(chat.fallbackNotice) } catch { /* an observer cannot break the send */ }
    }
    return { ...await this.send(chat.chatId, message, signal, hooks), role, provisioned: true, ...(chat.fallbackNotice === undefined ? {} : { fallbackNotice: chat.fallbackNotice }) }
  }

  /** The role's chat for this session, provisioning it from the blueprint when it has none. */
  async startForRole(role: string, context: RoleCallContext, signal?: AbortSignal, permissionResolver?: PermissionRequestResolver): Promise<PooledChatInfo> {
    this.assertLive()
    const existing = this.resolveRole(role, context.ownerSessionId)
    if (existing !== undefined) return this.chatInfo(existing) as PooledChatInfo
    return this.provision(role, context, signal, permissionResolver)
  }

  /**
   * Unbind the role in the session's roster, then release its chat, so the
   * next reference (even one arriving during the release) provisions it from
   * the current blueprint. `purge` also deletes the chat record. A failed
   * release leaves the role unbound and the chat record kept. Returns the released chatId.
   */
  async releaseRole(role: string, ownerSessionId: string, purge: boolean): Promise<string> {
    if (this.provisioning.has(roleKey(role, ownerSessionId))) throw roleInFlight(role)
    const chatId = this.resolveRole(role, ownerSessionId)
    if (chatId === undefined) throw new Error(`acp-resume: role ${role} has no chat in this session`)
    // Unbind first, synchronously: a send for the role arriving during the release
    // then provisions a new chat instead of reconnecting the one being released,
    // which would leave a live process that no roster entry points to.
    this.roster.remove(role, ownerSessionId)
    if (purge) await this.remove(chatId)
    else await this.close(chatId)
    return chatId
  }

  /** Single-flight provisioning: one start + seeding + roster entry per session and role at a time. */
  private async provision(role: string, context: RoleCallContext, signal: AbortSignal | undefined, permissionResolver: PermissionRequestResolver | undefined): Promise<PooledChatInfo> {
    const key = roleKey(role, context.ownerSessionId)
    if (this.provisioning.has(key)) throw roleInFlight(role)
    const { blueprint, roles } = this.roleAndTeam(role, context)
    const pending = this.provisionFromBlueprint(blueprint, roles, context.ownerSessionId, signal, permissionResolver)
    this.provisioning.set(key, pending)
    try {
      return await pending
    } finally {
      this.provisioning.delete(key)
    }
  }

  private async provisionFromBlueprint(blueprint: RoleBlueprint, roles: readonly RoleBlueprint[], ownerSessionId: string, signal: AbortSignal | undefined, permissionResolver: PermissionRequestResolver | undefined): Promise<PooledChatInfo> {
    const chat = await this.start(blueprint.cwd, signal, { label: blueprint.name, ownerSessionId, backend: blueprint.backend })
    const discard = async (reason: string, cause?: unknown): Promise<never> => {
      // A half-built role is not kept: the next reference provisions it again.
      await this.remove(chat.chatId).catch((error: unknown) => { this.report(error) })
      throw new Error(`acp-resume: role ${blueprint.name} could not be provisioned: ${reason}`, cause === undefined ? undefined : { cause })
    }
    if (blueprint.seeding !== undefined) {
      let seeded: PoolSendResult
      try {
        // D32: the team context goes in front of the user's seeding. A role without
        // seeding keeps D27's zero seeding turns: no turn is added just for the context.
        seeded = await this.send(chat.chatId, seedingWithTeam({ ...blueprint, seeding: blueprint.seeding }, roles), signal, permissionResolver === undefined ? {} : { permissionResolver })
      } catch (error: unknown) {
        return discard(`its seeding turn failed: ${toError(error).message}`, error)
      }
      if (seeded.stopReason !== 'completed') return discard(`its seeding turn ended ${seeded.stopReason}`)
    }
    try {
      this.roster.register(blueprint.name, chat.chatId, chat.backend, ownerSessionId)
    } catch (error: unknown) {
      return discard(`the roster could not be written: ${toError(error).message}`, error)
    }
    return chat
  }

  /**
   * The caller's workspace team config, or a model-facing error that says
   * whether the file is missing or what is wrong with it (the warning goes to `onWarn` too).
   */
  private teamConfig(what: string, context: RoleCallContext): TeamConfig {
    const read = readTeamConfig(context.workspaceDir)
    if (read.kind === 'ok') return read.config
    if (read.kind === 'none') {
      throw new Error(`acp-resume: unknown ${what}: no workspace team config (${TEAM_CONFIG_FILE}) found from ${context.workspaceDir}; pass chatId instead; roles need an ${TEAM_CONFIG_FILE} in the workspace`)
    }
    this.opts.onWarn?.(`acp-resume: workspace team config ${read.path} is not usable (${read.error})`)
    throw new Error(`acp-resume: cannot resolve ${what}: workspace team config ${read.path} is invalid: ${read.error}; fix the file, or pass chatId instead`)
  }

  /** The workspace template `name` seen from the caller's working directory; throws a model-facing reason when there is none. */
  templateFor(name: string, context: RoleCallContext): Template {
    const config = this.teamConfig(`template ${name}`, context)
    const template = config.templates.find(t => t.name === name)
    if (template === undefined) {
      const names = config.templates.map(t => t.name).join(', ')
      throw new Error(`acp-resume: unknown template ${name}; templates defined in ${config.root}/${TEAM_CONFIG_FILE}: ${names === '' ? '(none)' : names}`)
    }
    return template
  }

  /** The workspace blueprint of `role`, on a configured backend; throws a model-facing reason otherwise. */
  private blueprintFor(role: string, context: RoleCallContext): RoleBlueprint {
    return this.roleAndTeam(role, context).blueprint
  }

  /** The role's blueprint plus every role of its workspace (for the D32 team context), from one read of the team file. */
  private roleAndTeam(role: string, context: RoleCallContext): { blueprint: RoleBlueprint; roles: readonly RoleBlueprint[] } {
    const config = this.teamConfig(`role ${role}`, context)
    const blueprint = config.roles.find(r => r.name === role)
    if (blueprint === undefined) {
      const names = config.roles.map(r => r.name).join(', ')
      throw new Error(`acp-resume: unknown role ${role}; roles defined in ${config.root}/${TEAM_CONFIG_FILE}: ${names === '' ? '(none)' : names}`)
    }
    const backend = blueprint.backend ?? DEFAULT_BACKEND
    if (!this.backends.has(backend)) throw new Error(`acp-resume: role ${role} names unknown backend ${backend}`)
    return { blueprint, roles: config.roles }
  }

  /**
   * Release the chat's process; the registry entry survives for reconnect.
   * An open window in progress is aborted and awaited for up to one dispose
   * ladder, `disposeEofGraceMs + 2 × disposeGraceMs` (the aborted startup
   * disposes its own child). An in-flight turn is cancelled
   * (`session/cancel`) and given up to `disposeGraceMs` to settle before the
   * process is torn down. The chat leaves the live table only once its
   * process has exited; concurrent closes share one release.
   */
  async close(chatId: string): Promise<void> {
    const pending = this.starting.get(chatId)
    if (pending !== undefined) await this.abortWindow(pending)
    const chat = this.live.get(chatId)
    if (chat === undefined) return
    chat.closing ??= this.release(chatId, chat)
    return chat.closing
  }

  /**
   * Stop admission, abort open windows (each wait bounded by one dispose
   * ladder), cancel in-flight turns (each bounded by `disposeGraceMs`), then
   * release every live process. Registry survives.
   */
  async disposeAll(): Promise<void> {
    this.disposed = true
    await Promise.allSettled([...this.starting.values()].map(window => this.abortWindow(window)))
    await Promise.allSettled([...this.live.keys()].map(id => this.close(id)))
    this.consecutiveErrorTurns.clear()
  }

  /** Abort an open window and wait for it to settle, at most {@link windowGraceMs}. */
  private async abortWindow(window: OpenWindow): Promise<void> {
    window.controller.abort(new Error('acp-resume: open window aborted by pool teardown'))
    await settleWithin(window.promise, this.windowGraceMs())
  }

  /**
   * Upper bound for an aborted window to settle: the window disposes its child
   * through the full ladder (stdin-EOF grace, then SIGTERM and the grace
   * before SIGKILL) before it settles, plus one more grace for the exit proof.
   */
  private windowGraceMs(): number {
    const { disposeEofGraceMs, disposeGraceMs } = this.opts.specBase
    // Each grace fits a Node timer on its own; their sum may not.
    return Math.min(disposeEofGraceMs + 2 * disposeGraceMs, MAX_TIMER_DELAY_MS)
  }

  /** A saved session is only reloaded by the agent that created it. */
  /** Display name: the default backend shows its command basename (registry keeps 'default'). */
  private displayBackend(name: string): string {
    return name === DEFAULT_BACKEND ? basename(this.opts.specBase.command) : name
  }
  private backendName(entry: RegistryEntry): string { return entry.backend ?? DEFAULT_BACKEND }

  private backendFor(entry: RegistryEntry): BackendSpec {
    const backend = this.backends.get(this.backendName(entry))
    if (backend === undefined) throw new Error(`acp-resume: chat ${entry.chatId} uses unavailable backend ${this.backendName(entry)}`)
    return backend
  }

  private specFor(entry: RegistryEntry): Omit<AcpSessionSpec, 'cwd'> {
    return this.backendFor(entry).specBase
  }

  /** Latest report per backend from connections still alive; never retained in the registry. */
  liveBackendReports(): ReadonlyMap<string, Extract<BackendReport, { source: 'session' }>> {
    const reports = new Map<string, Extract<BackendReport, { source: 'session' }>>()
    for (const chat of this.live.values()) {
      const observed = chat.conn.settingsReport
      if (!observed || (!observed.model && !observed.effort) || chat.conn.processSettled || chat.closing) continue
      const entry = this.registry.get(chat.chatId)
      if (!entry) continue
      const backend = this.backendName(entry)
      const latest = reports.get(backend)
      if (!latest || observed.at >= latest.at) reports.set(backend, { ...observed, source: 'session', chatId: chat.chatId })
    }
    return reports
  }

  /** Every configured backend with its wire protocol (D28), default first. */
  backendList(): readonly { readonly name: string; readonly protocol: 'acp' | 'codex' }[] {
    return [...this.backends.values()]
      .map(b => ({ name: b.name, protocol: b.protocol === 'codex' ? 'codex' as const : 'acp' as const }))
      .sort((a, b) => (a.name === DEFAULT_BACKEND ? -1 : b.name === DEFAULT_BACKEND ? 1 : 0))
  }

  /**
   * Run `read` against a Codex connection of `backend` (D28): a live pooled
   * one when any chat of that backend has a live process (borrowed, not
   * claimed: the reads are read-only and may run beside a turn), else a
   * temporary `app-server` opened in usage mode (initialize only, no thread)
   * in the user's home directory and disposed afterwards. The temporary
   * process never joins the pool or the registry.
   * @throws when the backend is unknown or not a Codex backend, or the read fails.
   */
  async withCodexUsage<T>(backend: string, read: (conn: AcpConnection) => Promise<T>): Promise<T> {
    this.assertLive()
    const spec = this.backends.get(backend)
    if (spec === undefined) throw new Error(`acp-resume: unknown backend ${backend}`)
    if (spec.protocol !== 'codex' || spec.codex === undefined) throw new Error(`acp-resume: backend ${backend} is not a Codex backend`)
    for (const chat of this.live.values()) {
      const entry = this.registry.get(chat.chatId)
      if (entry === undefined || this.backendName(entry) !== backend) continue
      if (chat.closing !== undefined || chat.conn.processSettled || chat.conn.readRateLimits === undefined) continue
      return read(chat.conn)
    }
    const codex = spec.codex
    const conn = await openCodexConnection({
      ...spec.specBase,
      command: this.opts.dispatch?.executable?.(backend) ?? spec.specBase.command,
      cwd: homedir(),
      ...(codex.sandbox === undefined ? {} : { sandbox: codex.sandbox }),
      ...(codex.approvalPolicy === undefined ? {} : { approvalPolicy: codex.approvalPolicy }),
    }, { mode: 'usage' })
    try {
      return await read(conn)
    } finally {
      await this.disposeQuietly(conn)
    }
  }

  /** Open the bound backend's wire protocol (D25). Only a new chat uses discovery results. */
  private connect(backend: BackendSpec, cwd: string, open: OpenAcpMode, signal: AbortSignal | undefined, source: 'start' | 'continuation'): Promise<AcpConnection> {
    const checkedCommand = source === 'start' ? this.opts.dispatch?.executable?.(backend.name) : undefined
    const base = { ...backend.specBase, cwd, command: checkedCommand ?? backend.specBase.command }
    if (backend.protocol !== 'codex') return openAcpConnection(base, open, signal)
    const codex = backend.codex
    if (codex === undefined) throw new Error(`acp-resume: missing settings for Codex backend ${backend.name}`)
    // Resume preserves the thread model unless explicitly overridden. If D6 replaces
    // a lost thread without an override, app-server uses its own model settings.
    const model = codex.model ?? (source === 'start' ? this.opts.dispatch?.model?.(backend.name) : undefined)
    if (source === 'start' && backend.automatic && model === undefined) throw new Error(`acp-resume: no usable default model for Codex backend ${backend.name}`)
    return openCodexConnection({
      ...base,
      ...(model === undefined ? {} : { codexModel: model }),
      ...(codex.sandbox === undefined ? {} : { sandbox: codex.sandbox }),
      ...(codex.approvalPolicy === undefined ? {} : { approvalPolicy: codex.approvalPolicy }),
      ...(codex.effort === undefined ? {} : { codexEffort: codex.effort }),
    }, open, signal)
  }

  private assertSameAgent(entry: RegistryEntry): void {
    const { command, args } = this.specFor(entry)
    // Engine/model/effort are not part of the fingerprint (D19): saved sessions
    // load across engines, and `auto` already swaps models within a session.
    if (entry.command === command && Array.isArray(entry.args) && sameArgs(stripVolatileFlags(entry.args), stripVolatileFlags(args))) return
    throw new Error(
      `acp-resume: chat ${entry.chatId} was recorded for agent ${JSON.stringify([entry.command, ...(Array.isArray(entry.args) ? entry.args : [])])}, `
      + `but the plugin is now configured for ${JSON.stringify([command, ...args])}; the saved session belongs to another agent and was not loaded. `
      + 'Restore the old command/args to continue it, or start a new chat.',
    )
  }

  private async release(chatId: string, chat: LiveChat): Promise<void> {
    this.clearIdleTimer(chat)
    if (chat.busyPromise !== undefined) {
      chat.conn.notifyCancel()
      await settleWithin(chat.busyPromise, this.opts.specBase.disposeGraceMs)
    }
    try {
      await chat.conn.dispose()
    } finally {
      // Leave the live table only after the process is gone (or its teardown
      // failed): until then a send sees `closing` and waits instead of opening
      // a second process on the same remote session.
      if (this.live.get(chatId) === chat) this.live.delete(chatId)
    }
  }

  /** Reconnect a saved remote session, or skip load after repeated failed turns (D6). */
  private async reopen(entry: RegistryEntry, signal: AbortSignal | undefined, forceFresh: boolean): Promise<{ conn: AcpConnection; freshSessionReason: FreshSessionReason | undefined; lost?: Error }> {
    const backend = this.backendFor(entry)
    if (forceFresh) {
      const conn = await this.connect(backend, entry.cwd, { mode: 'new' }, signal, 'continuation')
      return { conn, freshSessionReason: 'repeated-errors' }
    }
    try {
      const conn = await this.connect(backend, entry.cwd, { mode: 'load', sessionId: entry.remoteSessionId }, signal, 'continuation')
      return { conn, freshSessionReason: undefined }
    } catch (error: unknown) {
      // Only a proven missing session is replaced; any other rejection keeps the binding (D6).
      if (!isLoadSessionMissing(error)) throw error
      this.assertLive()
      const conn = await this.connect(backend, entry.cwd, { mode: 'new' }, signal, 'continuation')
      return { conn, freshSessionReason: 'load-rejected', lost: error }
    }
  }

  /** Track a settled outcome for the volatile repeated-error fallback threshold (D6). */
  private recordSettledTurn(chatId: string, stopReason: string): void {
    if (stopReason === 'error') {
      this.consecutiveErrorTurns.set(chatId, (this.consecutiveErrorTurns.get(chatId) ?? 0) + 1)
    } else {
      this.consecutiveErrorTurns.delete(chatId)
    }
  }

  /** Dispose an untracked connection; a teardown failure is reported, never thrown. */
  private async disposeQuietly(conn: AcpConnection): Promise<void> {
    await conn.dispose().catch((error: unknown) => { this.report(error) })
  }

  /** Dispose a connection that must not join the pool, then reject with `reason`. */
  private async discard(conn: AcpConnection, reason: string): Promise<never> {
    await this.disposeQuietly(conn)
    throw new Error(reason)
  }

  /** Mirror an entry into the chat's turn log, unless the chat was purged meanwhile (no log may outlive its record). */
  private logEntry(chatId: string, input: LogEntryInput): void {
    if (this.registry.get(chatId) === undefined) return
    this.turnLog.append(chatId, input)
  }

  private logReconnectFailed(chatId: string, message: string, error: unknown): void {
    this.logEntry(chatId, { kind: 'event', event: 'reconnect-failed', at: Date.now(), message, error: toError(error).message })
  }

  private report(error: unknown): void {
    try { this.opts.specBase.onError?.(toError(error), 'error') } catch { /* sink cannot replace the failure */ }
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('acp-resume: pool already disposed')
  }

  private track(chatId: string, conn: AcpConnection): void {
    const chat: LiveChat = { chatId, conn, receiveText, idleTimer: undefined, busy: false, busyPromise: undefined, inFlight: undefined, closing: undefined }
    this.live.set(chatId, chat)
    this.armIdle(chat)
  }

  private armIdle(chat: LiveChat): void {
    // A released (or replaced) chat object must not re-arm a timer.
    if (chat.busy || chat.closing !== undefined || this.live.get(chat.chatId) !== chat) return
    this.clearIdleTimer(chat)
    chat.idleTimer = setTimeout(() => {
      this.close(chat.chatId).catch((error: unknown) => { this.report(error) })
    }, this.opts.idleTimeoutMs)
    chat.idleTimer.unref()
  }

  private clearIdleTimer(chat: LiveChat): void {
    if (chat.idleTimer !== undefined) {
      clearTimeout(chat.idleTimer)
      chat.idleTimer = undefined
    }
  }
}
