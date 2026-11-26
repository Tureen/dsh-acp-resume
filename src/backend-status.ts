/** Transport-safe backend readiness DTOs shared by Host and Client. @module acp-resume/backend-status */
export type BackendCompatibility = 'supported' | 'unverified-version' | 'unsupported' | 'unknown' | 'not-found' | 'custom'
export type BackendReadiness = 'ready' | 'needs-configuration' | 'needs-login' | 'unverified' | 'unavailable'
export type BackendStatusReason = 'missing-executable' | 'version-unreadable' | 'unsupported-version' | 'unsupported-mode'
  | 'not-configured' | 'model-required' | 'model-override-unavailable' | 'custom-unverified' | 'login-required' | 'handshake-failed' | 'probe-timeout' | 'backend-unready'

/** Values actually returned by a backend. Missing fields stay unknown. */
export interface ReportedSettings {
  readonly model?: string
  readonly modelName?: string
  readonly effort?: string
}

export type BackendReport = ReportedSettings & (
  | { readonly source: 'probe' }
  | { readonly source: 'session'; readonly chatId: string; readonly at: number }
)

export interface BackendStatus {
  /** Panel-only comparison and provenance; the D31 model tool retains its text contract. */
  readonly configuredModel?: string
  readonly configuredEffort?: string
  readonly sessionReporting?: true
  readonly report?: BackendReport
  readonly id: string
  readonly label: string
  readonly version?: string
  readonly range?: string
  readonly compatibility: BackendCompatibility
  readonly readiness: BackendReadiness
  readonly reason?: BackendStatusReason
  readonly configured: boolean
  /** A built-in backend synthesized from discovery, without user-authored settings. */
  readonly automatic?: true
}

export interface BackendStatusSnapshot {
  readonly backends: readonly BackendStatus[]
  readonly defaultBackend?: string
  readonly checking: boolean
  readonly dispatchEnabled: boolean
}

export interface BackendStatusService {
  snapshot(): BackendStatusSnapshot
  check(): Promise<BackendStatusSnapshot>
}
