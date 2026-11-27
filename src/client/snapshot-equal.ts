/**
 * Snapshot-stability helpers for the panel's data sources (performance, D21).
 * The official client reactivity rule requires an observable's `getSnapshot`
 * to return the SAME reference until the underlying fact moves; a source that
 * publishes a fresh object on every poll makes `useSyncExternalStore` see a
 * change each time and re-renders the whole panel on the poll interval. These
 * comparers let a source keep its previous snapshot reference when a poll's
 * payload is content-equal to what it already holds. Equality is intentionally
 * shallow-per-field over the small, flat DTOs the panel shows — not a general
 * deep-equal — so it stays cheap and obvious.
 * @module dsh-acp-resume/client/snapshot-equal
 */

import type { ChatsSnapshot, DetailSnapshot, EventItem, PanelChat, RunningItem, TurnItem } from './face.ts'

/** Two latest-turn summaries carry the same facts. */
function latestTurnEqual(a: PanelChat['latestTurn'], b: PanelChat['latestTurn']): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  return a.seq === b.seq
    && a.startedAt === b.startedAt
    && a.at === b.at
    && a.message === b.message
    && a.output === b.output
    && a.stopReason === b.stopReason
    && a.freshSession === b.freshSession
    && a.failureKind === b.failureKind
}

/** Two chat rows carry the same facts (the fields the panel renders). */
export function chatEqual(a: PanelChat, b: PanelChat): boolean {
  return a.chatId === b.chatId
    && a.remoteSessionId === b.remoteSessionId
    && a.cwd === b.cwd
    && a.label === b.label
    && a.title === b.title
    && a.turnCount === b.turnCount
    && a.currentModel === b.currentModel && a.currentEffort === b.currentEffort && a.connectionId === b.connectionId
    && a.active === b.active
    && a.lastActive === b.lastActive
    && a.ownerSessionId === b.ownerSessionId
    && a.inFlight?.chatId === b.inFlight?.chatId
    && a.inFlight?.message === b.inFlight?.message
    && a.inFlight?.startedAt === b.inFlight?.startedAt
    && a.backend === b.backend
    && a.backendDisplay === b.backendDisplay
    && a.attention === b.attention
    && a.lastCompleted === b.lastCompleted
    && a.backendCount === b.backendCount
    && a.role === b.role
    && latestTurnEqual(a.latestTurn, b.latestTurn)
}

/** Two chat lists hold the same rows in the same order. */
export function chatsEqual(a: readonly PanelChat[], b: readonly PanelChat[]): boolean {
  return a.length === b.length && a.every((row, i) => chatEqual(row, b[i] as PanelChat))
}

/** Two history entries carry the same facts. Previews are strings, so `===` suffices. */
function entryEqual(a: TurnItem | EventItem | RunningItem, b: TurnItem | EventItem | RunningItem): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'turn' && b.kind === 'turn') {
    return a.seq === b.seq && a.startedAt === b.startedAt && a.at === b.at
      && a.message === b.message && a.output === b.output
      && a.messageMore === b.messageMore && a.outputMore === b.outputMore && a.outputLines === b.outputLines
      && a.stopReason === b.stopReason && a.freshSession === b.freshSession && a.diagnostic === b.diagnostic && a.failureKind === b.failureKind
  }
  if (a.kind === 'event' && b.kind === 'event') {
    return a.seq === b.seq && a.event === b.event && a.at === b.at && a.message === b.message && a.error === b.error
  }
  if (a.kind === 'running' && b.kind === 'running') {
    return a.message === b.message && a.startedAt === b.startedAt
  }
  return false
}

function entriesEqual(a: readonly (TurnItem | EventItem | RunningItem)[], b: readonly (TurnItem | EventItem | RunningItem)[]): boolean {
  return a.length === b.length && a.every((entry, i) => entryEqual(entry, b[i] as TurnItem | EventItem | RunningItem))
}

/**
 * Whether two list snapshots are content-equal (ignoring `fetchedAt`, which is
 * only the relative-time reference and must not, on its own, force a re-render).
 */
export function listSnapshotEqual(a: ChatsSnapshot, b: ChatsSnapshot): boolean {
  return a.status === b.status && a.error === b.error && chatsEqual(a.chats, b.chats) && usageEqual(a.usage, b.usage)
}

/** Two usage lists carry the same facts; their entries are flat, so comparing the JSON suffices. */
function usageEqual(a: ChatsSnapshot['usage'], b: ChatsSnapshot['usage']): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}

/** Whether two detail snapshots are content-equal (ignoring `fetchedAt`). */
export function detailSnapshotEqual(a: DetailSnapshot, b: DetailSnapshot): boolean {
  if (a.status !== b.status || a.error !== b.error || a.total !== b.total) return false
  if ((a.chat === undefined) !== (b.chat === undefined)) return false
  if (a.chat !== undefined && b.chat !== undefined && !chatEqual(a.chat, b.chat)) return false
  return entriesEqual(a.entries, b.entries)
}
