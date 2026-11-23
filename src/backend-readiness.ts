/** Host-owned CLI compatibility and readiness, shared by dispatch admission, panel and model. @module acp-resume/backend-readiness */
import { homedir } from 'node:os'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { backendCompatibility, backendSupportRange, parseBackendVersion, type KnownBackendKind } from './backend-compatibility.js'

import type { BackendStatus, BackendStatusReason, BackendStatusService, BackendStatusSnapshot } from './backend-status.js'

export type { BackendStatus, BackendStatusReason, BackendStatusService, BackendStatusSnapshot } from './backend-status.js'

export interface BackendCandidate {
  readonly id: string
  readonly label: string
  readonly command: string
  readonly env: Readonly<Record<string, string>>
  /** Undefined is a custom executable; null is a known CLI with an unsupported launch mode. */
  readonly kind: KnownBackendKind | null | undefined
  readonly configured: boolean
  readonly automatic?: true
  readonly configurationIssue?: 'model-required' | 'unsupported-mode'
}

export type Verification = { readonly status: 'ready'; readonly model?: string }
  | { readonly status: 'login-required' | 'handshake-failed' | 'model-required' | 'model-override-unavailable' }

interface ProbeHost {
  resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle
}

export interface BackendReadinessOptions {
  readonly candidates: readonly BackendCandidate[]
  /** Pinned default; never fall back if it fails. Otherwise use built-in priority. */
  readonly preferred?: string
  /** Permit explicit attempts on detected, out-of-range CLI versions, never automatic fallback. */
  readonly allowUnverifiedBackends?: boolean
  readonly onWarn?: (message: string) => void
  readonly host: ProbeHost
  readonly verify: (backend: BackendCandidate, executable: string, signal: AbortSignal) => Promise<Verification>
  readonly timeoutMs?: number
}

const reasons: Readonly<Record<BackendStatusReason, string>> = {
  'missing-executable': 'executable not found in the DSH runtime; install it or configure its absolute path',
  'version-unreadable': 'could not read the CLI version; check the executable and run backend detection again',
  'unsupported-version': 'CLI version is outside the verified range; configure it explicitly or allow unverified backends to opt in',
  'unsupported-mode': 'configured CLI launch mode or flags are not supported; check the backend configuration',
  'not-configured': 'CLI detected but not configured as a dispatch backend',
  'model-required': 'Codex did not advertise a usable default model; choose one in Codex or explicitly configure an available model',
  'model-override-unavailable': 'the explicitly configured Codex model is unavailable; update or remove the plugin model override and recheck',
  'custom-unverified': 'custom ACP executable has no published compatibility range; explicit configuration can still be used',
  'login-required': 'sign in to the CLI, then run backend detection again',
  'handshake-failed': 'the backend did not pass the connection check; check its configuration or CLI diagnostics and retry',
  'backend-unready': 'waiting for the automatic backend check',
}

export function describeBackendStatus(row: BackendStatus): string {
  const version = row.version === undefined ? '' : ` ${row.version}`
  const range = row.range === undefined ? '' : ` (supported range: ${row.range})`
  const action = row.reason === 'unsupported-version' && row.configured ? 'version is outside the verified range; the configured backend can still be tried'
    : row.reason === 'unsupported-version' && row.readiness === 'ready' ? 'available by explicit selection only, not by automatic priority'
      : row.reason === undefined ? undefined : reasons[row.reason]
  return `${row.id} — ${row.label}${version}: ${row.compatibility}, ${row.readiness}${range}`
    + (action === undefined ? '' : `; ${action}`)
}

export function describeBackendSnapshot(status: BackendStatusSnapshot): string {
  const header = status.checking ? 'Backend detection is running.' : status.dispatchEnabled
    ? (status.defaultBackend === undefined ? 'Select a ready backend explicitly.' : `Default for new chats: ${status.defaultBackend}.`)
    : 'No dispatch backend is ready. Install, upgrade, or configure a supported CLI, then check its connection.'
  return [header, ...status.backends.map(describeBackendStatus)].join('\n')
}

function initialRow(candidate: BackendCandidate): BackendStatus {
  return { id: candidate.id, label: candidate.label, configured: candidate.configured,
    ...(candidate.automatic === true ? { automatic: true } : {}),
    ...(candidate.kind == null ? {} : { range: backendSupportRange(candidate.kind) }), compatibility: 'unknown', readiness: 'unverified', reason: 'backend-unready' }
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
}

export function resultWithin<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort)).catch(() => {})
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

/** Only executable search paths may be inherited from plugin configuration by auto-discovery. */
export function backendPathEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([key]) => /^(?:path|pathext)$/i.test(key)))
}

/** Fixed argv, credential-scrubbed subprocess provider, no shell or raw output in diagnostics. */
async function versionFrom(host: ProbeHost, executable: string, candidate: BackendCandidate, signal: AbortSignal): Promise<string | undefined> {
  const child = host.spawn({
    argv: [executable, '--version'], cwd: homedir(), signal, graceMs: 250,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
    env: backendPathEnv(candidate.env),
  })
  try {
    const outcome = await resultWithin(child.done, signal)
    if (outcome.exitCode !== 0) return undefined
    const stdout = child.collected.stdout?.readFrom(0)
    const stderr = child.collected.stderr?.readFrom(0)
    return (stdout?.lossy === false ? parseBackendVersion(stdout.text) : undefined)
      ?? (stderr?.lossy === false ? parseBackendVersion(stderr.text) : undefined)
  } finally {
    child.terminate()
    await child.waitForExit(AbortSignal.timeout(750)).catch(() => {})
  }
}

/** In-memory state. Boot and manual refresh share one bounded, session-free check. */
export class BackendReadinessService implements BackendStatusService {
  private readonly life = new AbortController()
  private rows: readonly BackendStatus[]
  private executables: ReadonlyMap<string, string> = new Map()
  private models: ReadonlyMap<string, string> = new Map()
  private active: Promise<BackendStatusSnapshot> | undefined
  private checkedAt: number | undefined
  private readonly timeoutMs: number
  private readonly listeners = new Set<() => void>()

  constructor(private readonly options: BackendReadinessOptions) {
    this.rows = options.candidates.map(initialRow)
    this.timeoutMs = options.timeoutMs ?? 3_000
  }

  snapshot(): BackendStatusSnapshot {
    // Missing discovered CLIs still explain what is supported and how to prepare it.
    const backends = this.rows
    const defaultBackend = this.options.preferred ?? this.automaticDefault()
    const dispatchEnabled = backends.some(row => row.readiness === 'ready' || this.canStart(row))
    return { backends, ...(defaultBackend === undefined ? {} : { defaultBackend }), checking: this.active !== undefined, dispatchEnabled }
  }

  check(): Promise<BackendStatusSnapshot> {
    return this.active ??= this.run().finally(() => { this.active = undefined; this.checkedAt = Date.now(); this.changed() }).then(() => this.snapshot())
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  dispose(): void { this.life.abort(); this.listeners.clear() }

  private changed(): void {
    for (const listener of this.listeners) listener()
  }

  private automaticDefault(): string | undefined {
    for (const family of [['kiro-v2', 'kiro-v3'], ['codex'], ['agy']] as const) {
      const candidates = this.options.candidates.filter(candidate => family.some(kind => candidate.kind === kind))
      const isVerified = ({ id }: BackendCandidate): boolean => this.rows.some(row => row.id === id && row.readiness === 'ready' && row.compatibility === 'supported')
      const selected = candidates.find(candidate => candidate.id === 'default' && isVerified(candidate))
        ?? candidates.find(candidate => candidate.configured && isVerified(candidate)) ?? candidates.find(isVerified)
      if (selected !== undefined) return selected.id
    }
    return undefined
  }

  private canStart(row: BackendStatus): boolean {
    return row.configured && row.readiness !== 'ready' && row.compatibility !== 'not-found'
      && row.reason !== 'backend-unready' && row.reason !== 'model-required'
  }

  /** Select for a new chat only. Explicit configurations may try the real connection without waiting on diagnostics. */
  select(requested?: string, signal?: AbortSignal): string | Promise<string> {
    signal?.throwIfAborted()
    if (this.life.signal.aborted) throw new Error('acp-resume: backend detection is disposed')
    const explicit = requested ?? this.options.preferred
    const candidate = explicit === undefined ? undefined : this.options.candidates.find(row => row.id === explicit)
    if (explicit !== undefined && candidate === undefined) throw new Error(`acp-resume: selected backend is not available: ${explicit}`)
    if (candidate?.configured === true) return candidate.id
    const pick = (): string => {
      const id = explicit ?? this.automaticDefault()
      const row = this.rows.find(item => item.id === id)
      if (row?.readiness === 'ready') return row.id
      if (row !== undefined) throw new Error(`acp-resume: cannot dispatch: ${describeBackendStatus(row)}`)
      throw new Error(`acp-resume: cannot dispatch${explicit === undefined ? '' : ': selected backend is not available'}. ${describeBackendSnapshot(this.snapshot())}`)
    }
    const selected = explicit ?? this.automaticDefault()
    const ready = this.rows.some(row => row.id === selected && row.readiness === 'ready')
    // Retries are bounded and single-flight; the cached explicit choice is never silently replaced.
    if (!ready && (this.active !== undefined || this.checkedAt === undefined || Date.now() - this.checkedAt >= 1_000)) {
      const check = this.check()
      return (signal === undefined ? check : resultWithin(check, signal)).then(pick)
    }
    return pick()
  }

  /** Use a checked executable when available; a configured start may go through normal resolution. */
  executable(backend: string): string | undefined { return this.executables.get(backend) }

  /** Model selected by the Codex daemon, never exposed through the status DTO. */
  model(backend: string): string | undefined { return this.models.get(backend) }

  failure(backend: string, reason: 'login-required'): void {
    if (this.life.signal.aborted) return
    this.rows = this.rows.map(row => row.id === backend
      ? { ...row, readiness: 'needs-login', reason } : row)
    this.changed()
  }

  private async run(): Promise<void> {
    if (this.life.signal.aborted) return
    // Fixed-size batches avoid an unbounded process burst from named configuration.
    const rows: BackendStatus[] = []
    const executables = new Map<string, string>()
    const models = new Map<string, string>()
    for (let i = 0; i < this.options.candidates.length && !this.life.signal.aborted; i += 4) {
      rows.push(...await Promise.all(this.options.candidates.slice(i, i + 4).map(item => this.probe(item, executables, models))))
    }
    if (!this.life.signal.aborted) {
      this.rows = rows
      this.executables = executables
      this.models = models
    }
  }

  private async probe(candidate: BackendCandidate, executables: Map<string, string>, models: Map<string, string>): Promise<BackendStatus> {
    const row = initialRow(candidate)
    const signal = AbortSignal.any([this.life.signal, AbortSignal.timeout(this.timeoutMs)])
    let executable: string
    try {
      executable = await resultWithin(this.options.host.resolveExecutable(candidate.command, candidate.env, signal), signal)
    } catch (error) {
      const code = errorCode(error)
      const missing = code === 'ENOENT' || code === 'SUBPROCESS_EXECUTABLE_NOT_FOUND'
      return { ...row, compatibility: missing ? 'not-found' : 'unknown', readiness: 'unavailable', reason: missing ? 'missing-executable' : 'version-unreadable' }
    }
    if (candidate.kind === undefined) {
      if (candidate.configurationIssue === 'model-required') return { ...row, compatibility: 'custom', readiness: 'needs-configuration', reason: 'model-required' }
      return { ...row, compatibility: 'custom', readiness: 'unverified', reason: 'custom-unverified' }
    }
    if (candidate.kind === null) return { ...row, compatibility: 'unsupported', readiness: 'unavailable', reason: 'unsupported-mode' }
    let version: string | undefined
    try { version = await versionFrom(this.options.host, executable, candidate, signal) } catch { /* do not expose raw errors */ }
    if (version === undefined) return { ...row, readiness: 'unavailable', reason: 'version-unreadable' }
    const { supported, range } = backendCompatibility(candidate.kind, version)
    const { reason: _progress, ...identity } = row
    const compatibility = supported ? 'supported' : 'unverified-version'
    const known = { ...identity, version, range, compatibility } as const
    if (!supported) {
      if (candidate.configured) this.options.onWarn?.(`acp-resume: configured backend ${row.id} version ${version} is outside verified range ${range}; explicit dispatch remains enabled`)
      if (candidate.configured || candidate.automatic !== true || !this.options.allowUnverifiedBackends) {
        return { ...known, readiness: 'unverified', reason: 'unsupported-version' }
      }
    }
    if (candidate.configurationIssue === 'unsupported-mode') return { ...known, readiness: 'needs-configuration', reason: 'unsupported-mode' }
    if (candidate.configurationIssue === 'model-required') return { ...known, readiness: 'needs-configuration', reason: 'model-required' }
    if (!candidate.configured && candidate.automatic !== true) return { ...known, readiness: 'needs-configuration', reason: 'not-configured' }
    const verifySignal = AbortSignal.any([this.life.signal, AbortSignal.timeout(this.timeoutMs)])
    let result: Verification
    try { result = await this.options.verify(candidate, executable, verifySignal) } catch { result = { status: 'handshake-failed' } }
    if (result.status === 'ready') {
      executables.set(row.id, executable)
      if (result.model !== undefined) models.set(row.id, result.model)
      return { ...known, readiness: 'ready', ...(supported ? {} : { reason: 'unsupported-version' as const }) }
    }
    return { ...known, readiness: result.status === 'login-required' ? 'needs-login' : (result.status === 'model-required' || result.status === 'model-override-unavailable') ? 'needs-configuration' : 'unavailable', reason: result.status }
  }
}
