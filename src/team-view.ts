/**
 * Pure team dispatch projection and view helpers (D47): derives memory-only
 * `role` and `latestTurn` fields from existing roster and cached turn-log data
 * (zero new storage, zero extra disk reads, zero new Remote methods), classifies
 * team cards into five urgency states, sorts them, and mutually partitions
 * owner-scoped chats between the team view and standalone chat lists so a
 * `chatId` never appears twice.
 * @module dsh-acp-resume/team-view
 */

import type { FailureKind } from './failure-class.js'

/** Maximum characters (code points) kept in a `latestTurn` line preview. */
export const LATEST_TURN_PREVIEW_CHARS = 320

/** Latest settled turn summary projected in memory from the cached turn log (D47). */
export interface LatestTurnSummary {
  readonly seq: number
  readonly startedAt: number
  readonly at: number
  /** First non-empty line of the turn prompt, capped at {@link LATEST_TURN_PREVIEW_CHARS}. */
  readonly message: string
  /** First non-empty line of the turn answer, capped at {@link LATEST_TURN_PREVIEW_CHARS}. */
  readonly output: string
  readonly stopReason: string
  readonly freshSession: boolean
  /** Host-classified failure reason for an `error` turn (D50); absent otherwise. */
  readonly failureKind?: FailureKind
}

/** Structural slice of a turn-log entry needed for pure projection (keeps this module node-free). */
export interface TurnLogEntryLike {
  readonly kind: string
  readonly seq: number
  readonly startedAt?: number
  readonly at: number
  readonly message?: string
  readonly output?: string
  readonly stopReason?: string
  readonly freshSession?: boolean
  readonly failureKind?: FailureKind
}

/** Five display states of a team role card, ordered by urgency (D47). */
export type TeamCardState = 'running' | 'error' | 'cancelled' | 'completed' | 'idle'

/** Priority rank of each team card state (lower appears first). */
export const TEAM_STATE_PRIORITY: Readonly<Record<TeamCardState, number>> = {
  running: 0,
  error: 1,
  cancelled: 2,
  completed: 3,
  idle: 4,
}

/** Structural chat slice accepted by pure team-view helpers (works for host and browser DTOs). */
export interface TeamChatLike {
  readonly chatId: string
  readonly active: boolean
  readonly lastActive: number
  readonly ownerSessionId?: string
  readonly role?: string
  readonly attention?: 'error' | 'warning'
  readonly inFlight?: { readonly chatId: string; readonly message: string; readonly startedAt: number }
  readonly latestTurn?: LatestTurnSummary
}

/**
 * First non-empty trimmed line of `text`, truncated at `maxChars` Unicode code
 * points with a trailing ellipsis when clipped.
 * @param text - raw turn message or answer.
 * @param maxChars - code point cap (defaults to {@link LATEST_TURN_PREVIEW_CHARS}).
 */
export function firstNonEmptyLinePreview(text: string, maxChars = LATEST_TURN_PREVIEW_CHARS): string {
  const line = text.split('\n').map(part => part.trim()).find(part => part !== '') ?? ''
  if (line === '') return ''
  const chars = Array.from(line)
  if (maxChars > 0 && chars.length > maxChars) {
    return `${chars.slice(0, maxChars).join('').trimEnd()}…`
  }
  return line
}

/**
 * Extract the newest settled `kind === 'turn'` entry from a chat's cached turn
 * log entries. Returns `undefined` when no turn has settled yet.
 * @param entries - retained turn-log entries, oldest first.
 * @param maxChars - preview code-point limit.
 */
export function latestTurnOf(entries: readonly TurnLogEntryLike[], maxChars = LATEST_TURN_PREVIEW_CHARS): LatestTurnSummary | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]
    if (entry?.kind !== 'turn') continue
    return {
      seq: entry.seq,
      startedAt: entry.startedAt ?? entry.at,
      at: entry.at,
      message: firstNonEmptyLinePreview(entry.message ?? '', maxChars),
      output: firstNonEmptyLinePreview(entry.output ?? '', maxChars),
      stopReason: entry.stopReason ?? 'completed',
      freshSession: entry.freshSession === true,
      ...(entry.failureKind === undefined ? {} : { failureKind: entry.failureKind }),
    }
  }
  return undefined
}

/**
 * Derive the optional memory-only `role` and `latestTurn` projection for one
 * pooled chat. Role lookup is strictly scoped to `ownerSessionId` (D20) and
 * skipped when the chat has no owner.
 * @param chatId - chat identifier.
 * @param ownerSessionId - owning DSH session id, if attributed.
 * @param roleOf - owner-scoped roster lookup.
 * @param entries - cached turn-log entries already read for this chat.
 */
export function projectChatTeamView(
  chatId: string,
  ownerSessionId: string | undefined,
  roleOf: (chatId: string, ownerSessionId: string) => string | undefined,
  entries: readonly TurnLogEntryLike[],
): { readonly role?: string; readonly latestTurn?: LatestTurnSummary } {
  const role = ownerSessionId !== undefined && ownerSessionId !== '' ? roleOf(chatId, ownerSessionId) : undefined
  const latestTurn = latestTurnOf(entries)
  return {
    ...(role === undefined || role === '' ? {} : { role }),
    ...(latestTurn === undefined ? {} : { latestTurn }),
  }
}

/**
 * Classify a role-bound chat into one of five team-card states (D47):
 * `running` > `error` > `cancelled` > `completed` > `idle`.
 * @param chat - role chat row.
 */
export function teamCardState(chat: Pick<TeamChatLike, 'inFlight' | 'attention' | 'latestTurn'>): TeamCardState {
  if (chat.inFlight !== undefined) return 'running'
  if (chat.attention === 'error' || chat.latestTurn?.stopReason === 'error') return 'error'
  if (chat.latestTurn !== undefined) {
    return chat.latestTurn.stopReason === 'completed' ? 'completed' : 'cancelled'
  }
  return 'idle'
}

/** Sort comparator for team role cards: urgency rank, then newest activity (idle keeps registration order). */
export function compareTeamChats(a: TeamChatLike, b: TeamChatLike): number {
  const stateA = teamCardState(a)
  const stateB = teamCardState(b)
  const rankDiff = TEAM_STATE_PRIORITY[stateA] - TEAM_STATE_PRIORITY[stateB]
  if (rankDiff !== 0) return rankDiff
  if (stateA === 'running') {
    return (b.inFlight?.startedAt ?? 0) - (a.inFlight?.startedAt ?? 0)
  }
  if (stateA === 'idle') return 0
  const timeA = a.latestTurn?.at ?? a.lastActive
  const timeB = b.latestTurn?.at ?? b.lastActive
  return timeB - timeA
}

function compareStandaloneActive(a: TeamChatLike, b: TeamChatLike): number {
  if (a.inFlight !== undefined && b.inFlight !== undefined) return b.inFlight.startedAt - a.inFlight.startedAt
  if (a.inFlight !== undefined) return -1
  if (b.inFlight !== undefined) return 1
  return b.lastActive - a.lastActive
}

function compareByLastActive(a: TeamChatLike, b: TeamChatLike): number {
  return b.lastActive - a.lastActive
}

/**
 * Filter chats strictly to `currentSessionId` (D20) and mutually partition them:
 * chats with a non-empty `role` go ONLY into `team` (even when idle-released),
 * while standalone chats without a `role` split into `activeStandalone` and
 * `releasedStandalone`. No `chatId` appears in more than one bucket.
 * @param chats - profile-global chat list.
 * @param currentSessionId - viewing DSH session id; `undefined` yields all empty buckets.
 */
export function partitionOwnerChats<T extends TeamChatLike>(
  chats: readonly T[],
  currentSessionId: string | undefined,
): {
  readonly visible: readonly T[]
  readonly team: readonly T[]
  readonly activeStandalone: readonly T[]
  readonly releasedStandalone: readonly T[]
} {
  if (currentSessionId === undefined || currentSessionId === '') {
    return { visible: [], team: [], activeStandalone: [], releasedStandalone: [] }
  }
  const visible = chats.filter(chat => chat.ownerSessionId === currentSessionId)
  const team: T[] = []
  const activeStandalone: T[] = []
  const releasedStandalone: T[] = []
  for (const chat of visible) {
    if (chat.role !== undefined && chat.role !== '') {
      team.push(chat)
    } else if (chat.active) {
      activeStandalone.push(chat)
    } else {
      releasedStandalone.push(chat)
    }
  }
  team.sort(compareTeamChats)
  activeStandalone.sort(compareStandaloneActive)
  releasedStandalone.sort(compareByLastActive)
  return { visible, team, activeStandalone, releasedStandalone }
}
