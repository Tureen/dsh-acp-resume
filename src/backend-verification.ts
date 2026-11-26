/** Session-free checks for built-in backends. @module acp-resume/backend-verification */
import { homedir } from 'node:os'
import { resultWithin, type Verification } from './backend-readiness.js'
import { AcpConnectionError, openAcpConnection } from './connection.js'
import { openCodexConnection } from './connection-codex.js'
import type { BackendSpec } from './pool.js'

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function modelId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
}

/** Read all pages before inferring a default; never select a model by catalog order. */
async function advertisedModel(
  list: (cursor?: string) => Promise<unknown>,
  requested: string | undefined,
  signal: AbortSignal,
): Promise<{ id: string; label?: string } | undefined> {
  const defaults = new Map<string, string | undefined>()
  const cursors = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < 10; page++) {
    signal.throwIfAborted()
    const response = record(await resultWithin(list(cursor), signal))
    const data = response?.['data']
    if (!Array.isArray(data)) throw new Error('Invalid Codex model list')
    for (const item of data) {
      const model = record(item)
      if (model === undefined) continue
      const label = modelId(model['displayName']) ? model['displayName'] : undefined
      if (requested !== undefined) {
        // Keep explicitly configured models working by either canonical slug or catalog id.
        if (model['model'] === requested || model['id'] === requested) return { id: requested, label }
        continue
      }
      const slug = model['model']
      const modalities = model['inputModalities']
      if (model['isDefault'] === true && model['hidden'] === false && modelId(slug)
        && (modalities === undefined || (Array.isArray(modalities) && modalities.includes('text')))) {
        // `model`, not the picker `id`, is the slug accepted by thread/start.
        defaults.set(slug, label)
      }
    }
    const next = response?.['nextCursor']
    if (next === undefined || next === null) {
      const id = defaults.size === 1 ? defaults.keys().next().value : undefined
      return id === undefined ? undefined : { id, label: defaults.get(id) }
    }
    if (typeof next !== 'string' || next.length === 0 || cursors.has(next)) break
    cursors.add(next)
    cursor = next
  }
  throw new Error('Codex model-list pagination did not finish')
}

/** Initialize only; never send a prompt, create a session, or request sign-in/refresh. */
export async function verifyBackend(spec: BackendSpec, signal: AbortSignal, onFailure?: (stage: string, category: string) => void): Promise<Verification> {
  const base = { ...spec.specBase, cwd: homedir(), onError: undefined, disposeGraceMs: 250, disposeEofGraceMs: 250 }
  try {
    if (spec.protocol !== 'codex') {
      const connection = await openAcpConnection(base, { mode: 'probe' }, signal)
      await connection.dispose()
      // Generic ACP initialize advertises methods, not current login status.
      return { status: 'ready' }
    }
    const connection = await openCodexConnection(base, { mode: 'probe' }, signal)
    try {
      signal.throwIfAborted()
      const report = record(await resultWithin(connection.readAccount(), signal))
      const requiresAuth = report?.['requiresOpenaiAuth']
      const account = report?.['account']
      if (typeof requiresAuth !== 'boolean' || (account != null && typeof record(account)?.['type'] !== 'string')) {
        return { status: 'handshake-failed' }
      }
      if (account == null) {
        if (requiresAuth) return { status: 'login-required' }
        // Custom providers can report neither an account nor an auth requirement.
        // A static catalog cannot establish their readiness for automatic dispatch.
        if (spec.automatic === true) return { status: 'handshake-failed' }
      }

      const explicit = spec.codex?.model
      const readDefaults = async () => record(record(await resultWithin(connection.readConfig(), signal))?.['config'])
      let config: Record<string, unknown> | undefined
      let requested = explicit
      if (explicit === undefined) {
        signal.throwIfAborted()
        config = await readDefaults()
        if (!config) return { status: 'handshake-failed' }
        const configured = config['model']
        if (configured != null) {
          if (typeof configured !== 'string') return { status: 'handshake-failed' }
          requested = configured
        }
      }
      const unavailable = explicit === undefined ? 'model-required' : 'model-override-unavailable'
      if (requested !== undefined && !modelId(requested)) return { status: unavailable }
      const selected = await advertisedModel(connection.listModels, requested, signal)
      if (explicit !== undefined) {
        // Admission already used the explicit selection. An optional display read cannot veto it.
        try { config = await readDefaults() } catch { /* leave backend defaults unreported */ }
      }
      const actual = explicit === undefined ? selected?.id : modelId(config?.model) ? config.model : undefined
      const effort = config?.model_reasoning_effort
      const reported = {
        ...(actual && { model: actual }),
        ...(actual && actual === selected?.id && selected.label && { modelName: selected.label }),
        ...(modelId(effort) && { effort }),
      }
      const observation = reported.model || reported.effort ? { reported } : {}
      return selected ? { status: 'ready', model: selected.id, ...observation } : { status: unavailable, ...observation }
    } finally {
      await connection.dispose()
    }
  } catch (error) {
    if (spec.protocol !== 'codex' && error instanceof AcpConnectionError && error.category === 'protocol' && error.jsonRpcCode === -32000) {
      return { status: 'login-required' }
    }
    // Only structured failure facts belong in the logger, not child output or RPC data.
    if (!signal.aborted || signal.reason?.name === 'TimeoutError') {
      if (error instanceof AcpConnectionError) onFailure?.(error.stage, error.category)
      else onFailure?.('verification', signal.aborted ? 'timeout' : 'unknown')
    }
    return { status: 'handshake-failed' }
  }
}
