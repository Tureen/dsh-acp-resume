/**
 * Browser-half contracts of the persistent-chat panel (D15): the wire DTO the
 * host `acpResume/list` method returns, the snapshot the apply world publishes,
 * and the injected face the panel component receives. Types only; the plugin
 * depends on no official Client package types, so the framework seats it uses
 * are restated here structurally (PANEL-DESIGN §3.6.2).
 * @module dsh-acp-resume/client/face
 */

/**
 * One chat as `acpResume/list` returns it. Mirrors the host `PooledChatInfo`
 * (src/pool.ts); restated because the browser half must not reach the node half.
 */
export interface PanelChat {
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
}

/** Structural twin of the official `ObservableSnapshot`. */
export interface Observable<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** Structural twin of the official `SnapshotSelectorHook` the renderer binds from a `hooks` source. */
export type SelectorHook<T> = <S>(selector: (snapshot: T) => S, equal?: (a: S, b: S) => boolean) => S

/** What the slot registration injects (before the renderer binds `hooks`). */
export interface ChatsPanelInjected {
  readonly hooks: { readonly chats: Observable<ChatsSnapshot> }
  /** Fetch now; the result arrives through `chats`. */
  readonly refresh: () => void
  /** Release the chat's process (record kept); rejects with the failure text. */
  readonly close: (chatId: string) => Promise<void>
  /** Release and delete the record; rejects with the failure text. */
  readonly purge: (chatId: string) => Promise<void>
}
