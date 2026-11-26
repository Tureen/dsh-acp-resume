/**
 * Browser-half contracts of the persistent-chat panel (D15): the wire DTO the
 * host `acpResume/list` method returns, the snapshot the apply world publishes,
 * and the injected face the panel component receives. Types only; the plugin
 * depends on no official Client package types, so the framework seats it uses
 * are restated here structurally (PANEL-DESIGN §3.6.2).
 * @module dsh-acp-resume/client/face
 */

import type { PanelFeatures } from '../panel-features.ts'
import type { BackendStatusSnapshot } from '../backend-status.ts'

/**
 * One chat as `acpResume/list` returns it. Mirrors the host `PooledChatInfo`
 * (src/pool.ts); restated because the browser half must not reach the node half.
 */
export interface PanelChat {
  readonly connectionId?: string
  readonly currentModel?: string
  readonly currentEffort?: string
  readonly chatId: string
  readonly remoteSessionId: string
  readonly cwd: string
  readonly label?: string
  /** First completed turn's message, at most 40 characters. */
  readonly title?: string
  /** Completed turns; absent in registries written before turn counting. */
  readonly turnCount?: number
  /** A live process is attached. */
  readonly active: boolean
  /** Epoch milliseconds of the last settled turn. */
  readonly lastActive: number
  /** The DSH session that opened this chat (D20); absent for chats started before attribution. */
  readonly ownerSessionId?: string
  /** The prompt currently running, supplied from pool memory only. */
  readonly inFlight?: { readonly chatId: string; readonly message: string; readonly startedAt: number }
  /** Chat backend identity (`default` or a configured name); absent with an older host. */
  readonly backend?: string
  /** What the newest log entry asks the user to notice (`error` / `warning`); absent when nothing does or with an older host. */
  readonly attention?: 'error' | 'warning'
  /** The newest log entry is a plainly completed turn; absent otherwise or with an older host. */
  readonly lastCompleted?: true
  /** Backend label for display (default backend shows its command basename); absent with an older host. */
  readonly backendDisplay?: string
  /** Configured backend count; controls whether a badge is useful. */
  readonly backendCount?: number
}

/** One backend's quota as the host reports it (D28; structural twin of the host `BackendUsage`). */
export interface PanelUsage {
  readonly backend: string
  readonly protocol: 'codex' | 'acp'
  readonly status: 'ok' | 'unsupported' | 'error'
  readonly plan?: string
  readonly usedPercent?: number
  readonly remainingPercent?: number
  readonly windowMins?: number
  readonly resetsAt?: number
  readonly fetchedAt: number
  readonly error?: string
}

/** The panel's published view of the pool. */
export interface ChatsSnapshot {
  /** `loading` until the first answer; `error` keeps the last good rows. */
  readonly status: 'loading' | 'ready' | 'error'
  /** Rows ordered by `lastActive`, newest first. */
  readonly chats: readonly PanelChat[]
  /** Failure text of the latest refresh when `status` is `error`. */
  readonly error?: string
  /** Epoch milliseconds the rows were fetched at: the reference for relative times. */
  readonly fetchedAt?: number
  /** Backend quotas (D28), fetched apart from the rows; absent until the first answer or with an older host. */
  readonly usage?: readonly PanelUsage[]
}

/** Structural twin of the official `ObservableSnapshot`. */
export interface Observable<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** Host capability read result. Only a missing endpoint selects the legacy protocol. */
export type FeatureView =
  | { readonly status: 'loading' | 'legacy' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly features: PanelFeatures }

/** Shared by every sidebar body and title in the connection scope. */
export interface FeatureStore extends Observable<FeatureView> {
  refresh(): Promise<void>
}

/** Structural twin of the official `SnapshotSelectorHook` the renderer binds from a `hooks` source. */
export type SelectorHook<T> = <S>(selector: (snapshot: T) => S, equal?: (a: S, b: S) => boolean) => S

/** Structural slice of the framework's `useTabInfo()` the panel bodies use (the official type is not imported; PANEL-DESIGN §3.6.2). */
export type TabInfoHook = () => {
  readonly tab: {
    /** The address the tab was opened at; for a detail tab, `dsh-resource://acp-resume-chat/<chatId>`. */
    readonly contentId: string
    readonly actions: {
      openResource(address: string): void
      close(): void
    }
  }
}

/** A turn as `acpResume/turns` previews it. Mirrors the host `TurnSummary` (src/panel.ts). */
export interface TurnItem {
  readonly seq: number
  readonly kind: 'turn'
  readonly startedAt: number
  readonly at: number
  readonly message: string
  readonly output: string
  readonly messageMore: boolean
  readonly outputMore: boolean
  readonly stopReason: string
  readonly freshSession: boolean
  readonly diagnostic?: string
}

/** A reconnect event. Mirrors the host `EventSummary`. */
export interface EventItem {
  readonly seq: number
  readonly kind: 'event'
  readonly event: 'session-lost' | 'session-reset-after-errors' | 'reconnect-failed'
  readonly at: number
  readonly message?: string
  readonly error?: string
}

export interface RunningItem {
  readonly kind: 'running'
  readonly message: string
  readonly startedAt: number
}

/** One turn-log entry in full, as `acpResume/turn` returns it (subset the page reads). */
export type FullEntry =
  | { readonly seq: number; readonly kind: 'turn'; readonly message: string; readonly output: string; readonly diagnostic?: string }
  | { readonly seq: number; readonly kind: 'event'; readonly message?: string; readonly error?: string }

/** The detail page's published view of one chat. */
export interface DetailSnapshot {
  /** `loading` until the first answer; `error` keeps the last good data; `gone` once the host reports the chat unknown. */
  readonly status: 'loading' | 'ready' | 'error' | 'gone'
  readonly chat?: PanelChat
  /** The newest retained entries, plus a running entry first when the host has one. */
  readonly entries: readonly (TurnItem | EventItem | RunningItem)[]
  /** Entries the host retains for this chat. */
  readonly total: number
  readonly error?: string
  readonly fetchedAt?: number
}

/** One chat's detail data source (apply world). */
export interface DetailSource extends Observable<DetailSnapshot> {
  refresh(): Promise<void>
  /** Show more history: raise the entry limit and refetch. */
  loadMore(): Promise<void>
  /** One entry in full; rejects with the failure text. */
  loadEntry(seq: number): Promise<FullEntry>
}

/** What the detail body's registration injects. */
export interface ChatDetailInjected {
  readonly features: FeatureStore
  /** The data source for a chat; one per chatId, shared by the body and the chip title. */
  readonly sourceFor: (chatId: string) => DetailSource
  readonly close: (chatId: string) => Promise<void>
  readonly purge: (chatId: string) => Promise<void>
}

/** What the slot registration injects (before the renderer binds `hooks`). */
/** One step of a workflow run (D29): its members, never their answers. */
export interface PanelWorkflowStep {
  readonly id: string
  readonly members: readonly { readonly role: string; readonly chatId?: string; readonly outcome?: 'completed' | 'failed' | 'cancelled' }[]
}

/** A workflow running in the host's pool instance. */
export interface PanelRunningWorkflow {
  readonly runId: string
  readonly template: string
  readonly startedAt: number
  readonly jobId?: string
  readonly currentStep?: string
  readonly steps: readonly PanelWorkflowStep[]
}

/** A finished (or interrupted) workflow run. */
export interface PanelWorkflowRun {
  readonly runId: string
  readonly template: string
  readonly startedAt: number
  readonly endedAt?: number
  readonly status: 'completed' | 'failed' | 'aborted' | 'interrupted'
  readonly error?: string
  readonly steps: readonly PanelWorkflowStep[]
}

/** One session's workflows as the panel shows them (D29). */
export interface WorkflowsSnapshot {
  readonly status: 'loading' | 'ready' | 'error'
  readonly running: readonly PanelRunningWorkflow[]
  /** Newest first, at most five. */
  readonly recent: readonly PanelWorkflowRun[]
  /** Epoch ms of the fetch: the reference for relative and running times. */
  readonly fetchedAt?: number
}

/** Client state around the Host readiness snapshot; failed requests keep the last good data. */
export interface BackendStatusView {
  readonly status: 'loading' | 'ready' | 'error' | 'unavailable'
  readonly data?: BackendStatusSnapshot
  /** An explicit check requested by this Client is still in flight. */
  readonly checking: boolean
  readonly checkFailed?: boolean
  readonly checkCompleted?: boolean
}

/** Profile-wide readiness source and its explicit refresh action. */
export interface BackendStatusSourceFace extends Observable<BackendStatusView> {
  check(): Promise<void>
}

/** What the sidebar slot injects before the renderer binds `hooks`. */
export interface ChatSettingsActions {
  read(chatId: string): Promise<import('../chat-options.ts').ChatOptions>
  change(chatId: string, field: 'model' | 'effort', value: string): Promise<void>
}

export interface ChatsPanelInjected {
  readonly profileForms?: () => import('./ProfileSettings.tsx').ProfileForms | undefined
  readonly settings?: ChatSettingsActions
  readonly features: FeatureStore
  readonly hooks: { readonly chats: Observable<ChatsSnapshot> }
  readonly backendStatus?: BackendStatusSourceFace
  /** The viewing session's workflow runs (D29); absent without a session on screen. */
  readonly workflowsFor?: (poll: boolean) => Observable<WorkflowsSnapshot>
  /** The DSH session viewing the panel (the seat's `inject` sessionId); `undefined` when none is on screen. */
  readonly currentSessionId: string | undefined
  /** Fetch now; the result arrives through `chats`. */
  readonly refresh: () => void
  /** Release the chat's process (record kept); rejects with the failure text. */
  readonly close: (chatId: string) => Promise<void>
  /** Release and delete the record; rejects with the failure text. */
  readonly purge: (chatId: string) => Promise<void>
}
