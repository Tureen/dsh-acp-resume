/**
 * Pure unit tests for `src/team-view.ts` (D47 Step 5): five-state
 * classification and urgency ordering, owner isolation (D20), empty-role
 * behavior, `latestTurn` first-non-empty-line preview and 320-char truncation,
 * and mutual exclusion partitioning between team and standalone chats.
 * @module dsh-acp-resume/tests/team-view.spec
 */

import { describe, expect, it } from 'vitest'
import {
  LATEST_TURN_PREVIEW_CHARS,
  buildTeamSectionView,
  compareTeamChats,
  definedRoleNames,
  firstNonEmptyLinePreview,
  latestTurnOf,
  partitionOwnerChats,
  projectChatTeamView,
  teamCardState,
  type TeamChatLike,
} from '../src/team-view.ts'

const NOW = 1_800_000_000_000
const OWNER_A = 'session-owner-a'
const OWNER_B = 'session-owner-b'

function chat(overrides: Partial<TeamChatLike> = {}): TeamChatLike {
  return {
    chatId: 'chat-default',
    active: true,
    lastActive: NOW - 60_000,
    ownerSessionId: OWNER_A,
    ...overrides,
  }
}

describe('team-view (D47)', () => {
  it('classifies the five team states (running > error > cancelled > completed > idle) and sorts by urgency', () => {
    const runningOlder = chat({
      chatId: 'chat-run-old',
      role: 'coder-old',
      inFlight: { chatId: 'chat-run-old', message: 'working old', startedAt: NOW - 20_000 },
      attention: 'error',
    })
    const runningNewer = chat({
      chatId: 'chat-run-new',
      role: 'coder-new',
      inFlight: { chatId: 'chat-run-new', message: 'working new', startedAt: NOW - 5_000 },
    })
    const errored = chat({
      chatId: 'chat-err',
      role: 'debugger',
      active: false,
      attention: 'error',
      latestTurn: { seq: 2, startedAt: NOW - 50_000, at: NOW - 40_000, message: 'run test', output: '', stopReason: 'error', freshSession: false },
    })
    const aborted = chat({
      chatId: 'chat-abort',
      role: 'auditor',
      latestTurn: { seq: 1, startedAt: NOW - 60_000, at: NOW - 30_000, message: 'audit', output: 'partial', stopReason: 'aborted', freshSession: false },
    })
    const maxTokens = chat({
      chatId: 'chat-max',
      role: 'writer',
      latestTurn: { seq: 1, startedAt: NOW - 70_000, at: NOW - 25_000, message: 'draft', output: 'cut', stopReason: 'max-tokens', freshSession: false },
    })
    const completed = chat({
      chatId: 'chat-done',
      role: 'reviewer',
      latestTurn: { seq: 3, startedAt: NOW - 90_000, at: NOW - 10_000, message: 'review', output: 'LGTM', stopReason: 'completed', freshSession: false },
    })
    const idleFirst = chat({ chatId: 'chat-idle-1', role: 'planner', lastActive: NOW - 200_000 })
    const idleSecond = chat({ chatId: 'chat-idle-2', role: 'tester', lastActive: NOW - 100_000 })

    expect(teamCardState(runningOlder)).toBe('running')
    expect(teamCardState(errored)).toBe('error')
    expect(teamCardState(aborted)).toBe('cancelled')
    expect(teamCardState(maxTokens)).toBe('cancelled')
    expect(teamCardState(completed)).toBe('completed')
    expect(teamCardState(idleFirst)).toBe('idle')

    const sorted = [idleFirst, completed, aborted, errored, runningOlder, idleSecond, maxTokens, runningNewer].sort(compareTeamChats)
    expect(sorted.map(c => c.chatId)).toEqual([
      'chat-run-new',
      'chat-run-old',
      'chat-err',
      'chat-max',
      'chat-abort',
      'chat-done',
      'chat-idle-1',
      'chat-idle-2',
    ])
  })

  it('extracts the first non-empty line and truncates by Unicode code points at 320 characters', () => {
    expect(firstNonEmptyLinePreview('\n   \n  第一行内容  \n第二行内容')).toBe('第一行内容')
    expect(firstNonEmptyLinePreview('   \n\t\n  ')).toBe('')

    const exact = 'a'.repeat(LATEST_TURN_PREVIEW_CHARS)
    expect(firstNonEmptyLinePreview(exact)).toBe(exact)

    const longEmoji = '🚀'.repeat(LATEST_TURN_PREVIEW_CHARS + 10)
    const cut = firstNonEmptyLinePreview(`\n  ${longEmoji}\nignored`)
    expect(Array.from(cut)).toHaveLength(LATEST_TURN_PREVIEW_CHARS + 1)
    expect(cut.endsWith('…')).toBe(true)

    // Ignores trailing reconnect events and returns the newest settled turn.
    const latest = latestTurnOf([
      { kind: 'turn', seq: 1, startedAt: 10, at: 20, message: 'first', output: 'out1', stopReason: 'completed', freshSession: false },
      { kind: 'turn', seq: 2, startedAt: 30, at: 40, message: '\n  second line1\nsecond line2', output: '\n\n  reply1\nreply2', stopReason: 'completed', freshSession: true },
      { kind: 'event', seq: 3, at: 50 },
    ])
    expect(latest).toEqual({
      seq: 2,
      startedAt: 30,
      at: 40,
      message: 'second line1',
      output: 'reply1',
      stopReason: 'completed',
      freshSession: true,
    })
    expect(latestTurnOf([{ kind: 'event', seq: 1, at: 10 }])).toBeUndefined()
  })

  it('scopes role projection strictly to ownerSessionId and omits undefined fields', () => {
    const lookedUp: [string, string][] = []
    const roleOf = (chatId: string, owner: string): string | undefined => {
      lookedUp.push([chatId, owner])
      return owner === OWNER_A && chatId === 'chat-1' ? 'reviewer' : undefined
    }
    expect(projectChatTeamView('chat-1', OWNER_A, roleOf, [])).toEqual({ role: 'reviewer' })
    expect(projectChatTeamView('chat-1', OWNER_B, roleOf, [])).toEqual({})
    expect(projectChatTeamView('chat-1', undefined, roleOf, [])).toEqual({})
    expect(lookedUp).toEqual([['chat-1', OWNER_A], ['chat-1', OWNER_B]])
  })

  it('filters out other owners and keeps team empty when no chats have a role', () => {
    const foreignRole = chat({ chatId: 'chat-foreign', ownerSessionId: OWNER_B, role: 'coder' })
    const unownedRole = chat({ chatId: 'chat-unowned', ownerSessionId: undefined, role: 'coder' })
    const standalone = chat({ chatId: 'chat-free', ownerSessionId: OWNER_A, active: true })

    const res = partitionOwnerChats([foreignRole, unownedRole, standalone], OWNER_A)
    expect(res.team).toEqual([])
    expect(res.activeStandalone.map(c => c.chatId)).toEqual(['chat-free'])
    expect(res.releasedStandalone).toEqual([])
    expect(res.visible.map(c => c.chatId)).toEqual(['chat-free'])

    const none = partitionOwnerChats([foreignRole, standalone], undefined)
    expect(none).toEqual({ visible: [], team: [], activeStandalone: [], releasedStandalone: [] })
  })

  it('mutually partitions role-bound and standalone chats so no chatId appears twice', () => {
    const teamActive = chat({ chatId: 'chat-role-live', role: 'coder', active: true })
    const teamReleased = chat({ chatId: 'chat-role-rel', role: 'reviewer', active: false })
    const freeActive = chat({ chatId: 'chat-free-live', active: true })
    const freeReleased = chat({ chatId: 'chat-free-rel', active: false })
    const otherOwner = chat({ chatId: 'chat-other', ownerSessionId: OWNER_B, role: 'coder' })

    const parts = partitionOwnerChats([teamActive, teamReleased, freeActive, freeReleased, otherOwner], OWNER_A)
    expect(parts.team.map(c => c.chatId)).toEqual(['chat-role-live', 'chat-role-rel'])
    expect(parts.activeStandalone.map(c => c.chatId)).toEqual(['chat-free-live'])
    expect(parts.releasedStandalone.map(c => c.chatId)).toEqual(['chat-free-rel'])

    // Disjointness check: every visible chatId appears in exactly one bucket.
    const allBucketIds = [
      ...parts.team.map(c => c.chatId),
      ...parts.activeStandalone.map(c => c.chatId),
      ...parts.releasedStandalone.map(c => c.chatId),
    ]
    expect(new Set(allBucketIds).size).toBe(allBucketIds.length)
    expect(allBucketIds.sort()).toEqual(parts.visible.map(c => c.chatId).sort())
  })

  it('builds the three-state TeamSection view: defined+dispatched, defined+unprovisioned, unconfigured, and roles disabled (D47 2026-11-27)', () => {
    expect(definedRoleNames([{ name: ' coder ' }, { name: '' }, { name: 'reviewer' }, { name: 'coder' }])).toEqual(['coder', 'reviewer'])
    expect(definedRoleNames(undefined)).toEqual([])

    const runningCoder = chat({
      chatId: 'chat-coder',
      role: 'coder',
      inFlight: { chatId: 'chat-coder', message: 'fix bug', startedAt: NOW - 5_000 },
    })

    // 1. Defined roles + partially dispatched: dispatched chat first, unprovisioned defined roles appended as idle (no duplicates).
    const mixed = buildTeamSectionView([runningCoder], ['coder', 'reviewer', 'tester'], true)
    expect(mixed.mode).toBe('roles')
    expect(mixed.entries).toEqual([
      { kind: 'chat', role: 'coder', state: 'running', chat: runningCoder },
      { kind: 'unprovisioned', role: 'reviewer', state: 'idle' },
      { kind: 'unprovisioned', role: 'tester', state: 'idle' },
    ])

    // 2. Defined roles + zero dispatched: all render as unprovisioned idle entries in config order.
    const unprovisionedOnly = buildTeamSectionView([], ['reviewer', 'coder'], true)
    expect(unprovisionedOnly).toEqual({
      mode: 'roles',
      entries: [
        { kind: 'unprovisioned', role: 'reviewer', state: 'idle' },
        { kind: 'unprovisioned', role: 'coder', state: 'idle' },
      ],
    })

    // 3. No defined roles and no roster chats: unconfigured (empty entries + mode marker).
    expect(buildTeamSectionView([], [], true)).toEqual({ mode: 'unconfigured', entries: [] })
    expect(buildTeamSectionView([], undefined, true)).toEqual({ mode: 'unconfigured', entries: [] })

    // 4. Connection-level roles switch off (D33): hidden regardless of defined roles or chats.
    expect(buildTeamSectionView([runningCoder], ['coder', 'reviewer'], false)).toEqual({ mode: 'hidden', entries: [] })
    expect(buildTeamSectionView([], [], false)).toEqual({ mode: 'hidden', entries: [] })
  })
})
