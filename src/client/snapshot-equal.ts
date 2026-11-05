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

import type { ChatsSnapshot, DetailSnapshot, EventItem, PanelChat, TurnItem } from './face.ts'

/** Two chat rows carry the same facts (the fields the panel renders). */
export function chatEqual(a: PanelChat, b: PanelChat): boolean {
  return a.chatId === b.chatId
    && a.remoteSessionId === b.remoteSessionId
    && a.cwd === b.cwd
    && a.label === b.label
    && a.title === b.title
    && a.turnCount === b.turnCount
    && a.active === b.active
    && a.lastActive === b.lastActive
    && a.ownerSessionId === b.ownerSessionId
}

/** Two chat lists hold the same rows in the same order. */
export function chatsEqual(a: readonly PanelChat[], b: readonly PanelChat[]): boolean {
  return a.length === b.length && a.every((row, i) => chatEqual(row, b[i] as PanelChat))
}

/** Two history entries carry the same facts. Previews are strings, so `===` suffices. */
function entryEqual(a: TurnItem | EventItem, b: TurnItem | EventItem): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'turn' && b.kind === 'turn') {
    return a.seq === b.seq && a.startedAt === b.startedAt && a.at === b.at
      && a.message === b.message && a.output === b.output
      && a.messageMore === b.messageMore && a.outputMore === b.outputMore
      && a.stopReason === b.stopReason && a.freshSession === b.freshSession && a.diagnostic === b.diagnostic
  }
  if (a.kind === 'event' && b.kind === 'event') {
    return a.seq === b.seq && a.event === b.event && a.at === b.at && a.message === b.message && a.error === b.error
  }
  return false
}

function entriesEqual(a: readonly (TurnItem | EventItem)[], b: readonly (TurnItem | EventItem)[]): boolean {
  return a.length === b.length && a.every((entry, i) => entryEqual(entry, b[i] as TurnItem | EventItem))
}

/**
 * Whether two list snapshots are content-equal (ignoring `fetchedAt`, which is
 * only the relative-time reference and must not, on its own, force a re-render).
 */
export function listSnapshotEqual(a: ChatsSnapshot, b: ChatsSnapshot): boolean {
  return a.status === b.status && a.error === b.error && chatsEqual(a.chats, b.chats)
}

/** Whether two detail snapshots are content-equal (ignoring `fetchedAt`). */
export function detailSnapshotEqual(a: DetailSnapshot, b: DetailSnapshot): boolean {
  if (a.status !== b.status || a.error !== b.error || a.total !== b.total) return false
  if ((a.chat === undefined) !== (b.chat === undefined)) return false
  if (a.chat !== undefined && b.chat !== undefined && !chatEqual(a.chat, b.chat)) return false
  return entriesEqual(a.entries, b.entries)
}
