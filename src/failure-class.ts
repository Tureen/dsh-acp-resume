/**
 * Host-side failure classification (D50): inspects structured backend error
 * objects (`codexErrorInfo`, `message`, `data`, `details`) and maps only
 * high-confidence quota exhaustion signals to a fixed label (`'quota'`).
 * Raw backend text is never surfaced to the panel or model tools (D31); this
 * module is pure and node-free so its types can also be imported by client code.
 *
 * Recognition table:
 * - Codex (verified against real app-server): `codexErrorInfo === 'usageLimitExceeded'`.
 * - Generic JSON-RPC / HTTP (inferred regex — 待真实样本校准, no agy / kiro
 *   quota-exhausted samples yet): `message` / `data` / `details` string values
 *   matching {@link QUOTA_MESSAGE_PATTERN}. Prefer missing unknown wordings over
 *   misclassifying ordinary errors.
 * - Anything outside this table returns `undefined` (plain `error`).
 *
 * @module dsh-acp-resume/failure-class
 */

/** Recognized non-generic failure class carried in turn logs and panel DTOs. */
export type FailureKind = 'quota'

/** Codex app-server `codexErrorInfo` variant verified on real quota exhaustion. */
export const CODEX_QUOTA_ERROR_INFO = 'usageLimitExceeded'

/**
 * Inferred quota message pattern for generic JSON-RPC / HTTP backends.
 * 待真实样本校准: no real agy / kiro quota-exhausted error samples yet; prefer
 * false negatives over false positives.
 */
export const QUOTA_MESSAGE_PATTERN = /usage limit|rate limit exceeded|quota exceeded|insufficient_quota|overage.*limit|exceeded your usage/i

/** Fixed model-facing guidance prepended to tool errors when quota is exhausted (never echoes raw text). */
export const QUOTA_TOOL_GUIDANCE = 'backend quota exhausted; wait for the reset or switch backend'

/** Structural error-like input inspected by {@link classifyFailure}. */
export interface FailureErrorLike {
  readonly message?: unknown
  readonly data?: unknown
  readonly details?: unknown
  readonly codexErrorInfo?: unknown
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function codexErrorTag(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  const record = asRecord(value)
  if (record === undefined) return undefined
  const keys = Object.keys(record)
  return keys.length === 1 ? keys[0] : undefined
}

/** Collect string values from a detail field (`data` / `details`) without matching object keys. */
function collectStrings(value: unknown, out: string[], seen: Set<object>, depth: number): void {
  if (typeof value === 'string') {
    if (value !== '') out.push(value)
    return
  }
  if (depth <= 0 || typeof value !== 'object' || value === null) return
  if (seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, seen, depth - 1)
    return
  }
  for (const field of Object.values(value)) {
    collectStrings(field, out, seen, depth - 1)
  }
}

/**
 * Classify a backend error into a fixed {@link FailureKind}, or `undefined`
 * when it does not match a high-confidence rule. Pure; never throws.
 * @param error - error instance or structured object carrying `message` / `data` / `details` / `codexErrorInfo`.
 */
export function classifyFailure(error: unknown): FailureKind | undefined {
  if (typeof error !== 'object' || error === null || Array.isArray(error)) return undefined
  if (codexErrorTag(Reflect.get(error, 'codexErrorInfo')) === CODEX_QUOTA_ERROR_INFO) {
    return 'quota'
  }
  const texts: string[] = []
  const message: unknown = Reflect.get(error, 'message')
  if (typeof message === 'string' && message !== '') texts.push(message)
  const seen = new Set<object>([error])
  for (const key of ['data', 'details'] as const) {
    const value: unknown = Reflect.get(error, key)
    if (value !== undefined) collectStrings(value, texts, seen, 4)
  }
  return texts.some(text => QUOTA_MESSAGE_PATTERN.test(text)) ? 'quota' : undefined
}
