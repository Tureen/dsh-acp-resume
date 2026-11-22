/**
 * Backend usage (D28): one structure for every configured backend's quota.
 * Codex backends are read through two read-only `app-server` methods
 * (`account/read`, `account/rateLimits/read`) on a live pooled connection or
 * a temporary one (see `AcpSessionPool.withCodexUsage`); ACP backends report
 * `unsupported` and send nothing. Results are cached per backend: a cold
 * cache waits for the read, an expired entry is returned at once while one
 * background read refreshes it, `refresh: true` waits for a fresh read, and
 * concurrent reads of one backend share a single request. Reads never throw:
 * a failure is an `error` result.
 *
 * @module dsh-acp-resume/usage
 */

import type { AcpConnection } from './connection.js'

/** One backend's usage, as the tool, the Remote method, and the panel see it. */
export interface BackendUsage {
  /** Backend name `acp_chat_start` accepts (`default` for the default backend). */
  readonly backend: string
  readonly protocol: 'codex' | 'acp'
  readonly status: 'ok' | 'unsupported' | 'error'
  /** Plan, e.g. `prolite`; ChatGPT accounts report their plan type, others their account type. */
  readonly plan?: string
  /** Percent used of the most-used window; not capped (may exceed 100). */
  readonly usedPercent?: number
  /** What is left of that window: `100 - usedPercent`, rounded, never below 0. */
  readonly remainingPercent?: number
  /** That window's length in minutes (e.g. 10080 for a week). */
  readonly windowMins?: number
  /** When that window resets, unix seconds. */
  readonly resetsAt?: number
  /** Local epoch milliseconds the result was read. */
  readonly fetchedAt: number
  /** Why the read failed (`status: 'error'`). */
  readonly error?: string
}

/** Cache lifetime of a successful read. */
export const USAGE_TTL_MS = 5 * 60_000
/** Cache lifetime of a failed read: short, but enough not to respawn a broken backend on every poll. */
export const USAGE_ERROR_TTL_MS = 60_000
/** Upper bound of one read (both requests). */
export const USAGE_READ_TIMEOUT_MS = 15_000

/** What the usage service needs from the pool. */
export interface UsagePool {
  backendList(): readonly { readonly name: string; readonly protocol: 'acp' | 'codex' }[]
  withCodexUsage<T>(backend: string, read: (conn: AcpConnection) => Promise<T>): Promise<T>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Map the two raw replies onto {@link BackendUsage}. Of the `primary` and
 * `secondary` windows the one with the higher `usedPercent` is reported (the
 * longer one on a tie): the limit that binds first.
 */
export function toBackendUsage(backend: string, account: unknown, rateLimits: unknown, fetchedAt: number): BackendUsage {
  const snapshot = record(record(rateLimits)?.['rateLimits'])
  const acct = record(record(account)?.['account'])
  const type = typeof acct?.['type'] === 'string' ? acct['type'] : undefined
  const planType = typeof acct?.['planType'] === 'string' ? acct['planType'] : undefined
  const snapshotPlan = typeof snapshot?.['planType'] === 'string' ? snapshot['planType'] : undefined
  const plan = (type === 'chatgpt' ? planType : type) ?? snapshotPlan
  const windows = ['primary', 'secondary']
    .map(key => record(snapshot?.[key]))
    .flatMap((w) => {
      const usedPercent = finite(w?.['usedPercent'])
      return usedPercent === undefined ? [] : [{ usedPercent, windowMins: finite(w?.['windowDurationMins']), resetsAt: finite(w?.['resetsAt']) }]
    })
    .sort((a, b) => b.usedPercent - a.usedPercent || (b.windowMins ?? 0) - (a.windowMins ?? 0))
  const binding = windows[0]
  return {
    backend,
    protocol: 'codex',
    status: 'ok',
    ...(plan === undefined ? {} : { plan }),
    ...(binding === undefined ? {} : { usedPercent: binding.usedPercent, remainingPercent: remainingOf(binding.usedPercent) }),
    ...(binding?.windowMins === undefined ? {} : { windowMins: binding.windowMins }),
    ...(binding?.resetsAt === undefined ? {} : { resetsAt: binding.resetsAt }),
    fetchedAt,
  }
}

/** Percent left of a window: rounded, and 0 once usage passes 100. */
export function remainingOf(usedPercent: number): number {
  return Math.max(0, Math.round(100 - usedPercent))
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new Error(`usage read timed out after ${ms} ms`)) }, ms)
    timer.unref()
  })
  return Promise.race([work, timeout]).finally(() => { clearTimeout(timer) })
}

interface Entry {
  value: BackendUsage | undefined
  pending: Promise<BackendUsage> | undefined
}

/** Per-backend usage with the D28 cache. */
export class UsageService {
  private readonly entries = new Map<string, Entry>()

  /**
   * @param pool - backend list and Codex connection access.
   * @param now - clock (epoch ms).
   * @param timeoutMs - bound of one read.
   */
  constructor(
    private readonly pool: UsagePool,
    private readonly now: () => number = Date.now,
    private readonly timeoutMs: number = USAGE_READ_TIMEOUT_MS,
    private readonly readyBackends?: () => ReadonlySet<string>,
  ) {}

  /**
   * Usage of one backend, or of every configured backend in configuration order.
   * @throws only for an unknown backend name.
   */
  async read(options: { readonly backend?: string; readonly refresh?: boolean } = {}): Promise<readonly BackendUsage[]> {
    const backends = this.pool.backendList()
    const selected = options.backend === undefined ? backends : backends.filter(b => b.name === options.backend)
    if (options.backend !== undefined && selected.length === 0) throw new Error(`unknown backend ${options.backend}; configured backends: ${backends.map(b => b.name).join(', ')}`)
    const ready = this.readyBackends?.()
    const visible = ready === undefined ? selected : selected.filter(b => ready.has(b.name))
    if (options.backend !== undefined && visible.length === 0) throw new Error(`backend ${options.backend} is not ready; check backend status first`)
    return Promise.all(visible.map(b => b.protocol === 'codex'
      ? this.codex(b.name, options.refresh === true)
      : Promise.resolve<BackendUsage>({ backend: b.name, protocol: 'acp', status: 'unsupported', fetchedAt: this.now() })))
  }

  private codex(backend: string, refresh: boolean): Promise<BackendUsage> {
    let entry = this.entries.get(backend)
    if (entry === undefined) {
      entry = { value: undefined, pending: undefined }
      this.entries.set(backend, entry)
    }
    const value = entry.value
    if (!refresh && value !== undefined) {
      const ttl = value.status === 'error' ? USAGE_ERROR_TTL_MS : USAGE_TTL_MS
      // Expired: hand back the old result now and refresh behind it.
      if (this.now() - value.fetchedAt >= ttl) void this.load(backend, entry)
      return Promise.resolve(value)
    }
    return this.load(backend, entry)
  }

  /** One read per backend at a time; concurrent callers share it. */
  private load(backend: string, entry: Entry): Promise<BackendUsage> {
    if (entry.pending !== undefined) return entry.pending
    const pending = withTimeout(this.pool.withCodexUsage(backend, async (conn) => {
      if (conn.readAccount === undefined || conn.readRateLimits === undefined) throw new Error('connection cannot read usage')
      const [account, rateLimits] = await Promise.all([conn.readAccount(), conn.readRateLimits()])
      return { account, rateLimits }
    }), this.timeoutMs).then(
      ({ account, rateLimits }) => toBackendUsage(backend, account, rateLimits, this.now()),
      (error: unknown): BackendUsage => ({ backend, protocol: 'codex', status: 'error', fetchedAt: this.now(), error: error instanceof Error ? error.message : String(error) }),
    ).then((value) => {
      entry.value = value
      entry.pending = undefined
      return value
    })
    entry.pending = pending
    return pending
  }
}
