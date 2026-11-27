/**
 * Team dispatch overview section (D47, revised 2026-11-27 for discoverability):
 * renders three states instead of hiding on zero roster entries:
 * 1. Workspace defines roles (or the session already has roster-bound chats):
 *    shows urgency-ordered five-state cards (`running > error > cancelled >
 *    completed > idle`) plus non-clickable, menu-less "idle · awaiting task"
 *    cards for defined roles not yet dispatched (no chatId, never persisted).
 * 2. Workspace defines no roles (and `roles` is enabled): shows a one-line gray
 *    setup hint naming `.agents/acp-team.yml` in `<code>`.
 * 3. Connection-level `roles` switch is off (D33): returns `null`.
 * @module dsh-acp-resume/client/TeamSection
 */

import { useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import type { FailureKind } from '../failure-class.ts'
import { buildTeamSectionView, teamCardState, type TeamCardState } from '../team-view.ts'
import { ChatSettings } from './ChatSettings.tsx'
import type { ChatsPanelInjected, PanelChat } from './face.ts'
import type { PanelCopyKey, PanelTranslate } from './locales.ts'
import {
  Button,
  IconEllipsisOutlineRegular,
  LiveElapsed,
  Menu,
  PanelCard,
  SectionHeading,
  StateDot,
  Tag,
  cleanPreview,
  type MenuEntry,
  type RailState,
  type StateDotState,
  type TagTone,
} from './panel-chrome.tsx'
import { formatHybridTime, formatTurnTime, formatTurnTimeTitle } from './panel-time.ts'

/** Displayed path for the workspace team file inside the unconfigured hint. */
const TEAM_CONFIG_DISPLAY_PATH = '.agents/acp-team.yml'

export interface TeamSectionProps {
  /** Role-bound chats for the current owner session, already sorted by urgency. */
  readonly chats: readonly PanelChat[]
  /** Defined role names from the viewing session's workspace `.agents/acp-team.yml`. */
  readonly definedRoles?: readonly string[]
  /** Connection-level `roles` switch (D33); false hides the section. */
  readonly rolesEnabled?: boolean
  readonly settings?: ChatsPanelInjected['settings']
  readonly now: number
  readonly pending: ReadonlySet<string>
  readonly onOpen: (chat: PanelChat) => void
  readonly onRelease: (chat: PanelChat) => void
  readonly onDelete: (chat: PanelChat) => void
  readonly t: PanelTranslate
}

const styles = {
  section: { display: 'flex', flexDirection: 'column', gap: 8 },
  list: { display: 'flex', flexDirection: 'column', gap: 8, margin: 0, padding: 0, listStyle: 'none' },
  item: { listStyle: 'none' },
  card: { cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 10px' },
  unprovisionedCard: { cursor: 'default', display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 10px' },
  head: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
  dot: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 14, flex: 'none' },
  nameButton: { flex: 1, minWidth: 0, padding: 0, border: 0, background: 'transparent', textAlign: 'left', font: 'inherit', cursor: 'pointer' },
  name: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
  time: { flex: 'none', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', fontVariantNumeric: 'tabular-nums' },
  menuWrap: { flex: 'none', display: 'inline-flex', alignItems: 'center' },
  taskLine: {
    fontSize: 12, lineHeight: 1.4, color: 'var(--dsw-alias-label-primary)',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  replyLine: {
    fontSize: 12, lineHeight: 1.4, color: 'var(--dsw-alias-label-secondary)',
    overflow: 'hidden', display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2,
    overflowWrap: 'anywhere',
  },
  hintLine: { fontSize: 11, lineHeight: 1.4, color: 'var(--dsw-alias-label-tertiary)', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  unconfigured: { margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
  codePath: {
    fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
    fontSize: 11,
    padding: '1px 4px',
    borderRadius: 4,
    background: 'var(--dsw-alias-bg-subtle, rgba(127, 127, 127, 0.12))',
    color: 'var(--dsw-alias-label-secondary)',
  },
} satisfies Record<string, CSSProperties>

function shortId(chatId: string): string {
  return chatId.startsWith('chat-') ? `chat-${chatId.slice(5, 13)}` : chatId.slice(0, 8)
}

function teamDot(state: TeamCardState, active: boolean, failureKind?: FailureKind): { readonly key: string; readonly dot: StateDotState; readonly step?: true } {
  switch (state) {
    case 'running': return { key: 'ongoing', dot: 'ongoing' }
    case 'error': return failureKind === 'quota' ? { key: 'warning', dot: 'warning' } : { key: 'error', dot: 'error' }
    case 'cancelled': return { key: 'warning', dot: 'warning' }
    case 'completed': return { key: 'done', dot: 'done' }
    case 'idle': return active ? { key: 'idle', dot: 'idle' } : { key: 'released', dot: 'idle', step: true }
  }
}

function teamRail(state: TeamCardState, freshSession: boolean, failureKind?: FailureKind): RailState {
  switch (state) {
    case 'running': return 'running'
    case 'error': return failureKind === 'quota' ? 'warn' : 'error'
    case 'cancelled': return 'warn'
    case 'completed': return freshSession ? 'warn' : 'none'
    case 'idle': return 'none'
  }
}

function teamTag(state: TeamCardState, stopReason: string | undefined, freshSession: boolean, failureKind?: FailureKind): { readonly key: PanelCopyKey; readonly tone: TagTone } | undefined {
  if (state === 'error') {
    return failureKind === 'quota' ? { key: 'stopQuota', tone: 'warning' } : { key: 'stopError', tone: 'danger' }
  }
  if (state === 'cancelled') {
    if (stopReason === 'max-tokens') return { key: 'stopMaxTokens', tone: 'warning' }
    if (stopReason === 'refusal') return { key: 'stopRefusal', tone: 'warning' }
    return { key: 'stopAborted', tone: 'neutral' }
  }
  if (state === 'completed' && freshSession) return { key: 'freshBadge', tone: 'info' }
  return undefined
}

function TeamRoleCard({ chat, settings, now, pending, onOpen, onRelease, onDelete, t }: {
  readonly chat: PanelChat
  readonly settings?: ChatsPanelInjected['settings']
  readonly now: number
  readonly pending: boolean
  readonly onOpen: (chat: PanelChat) => void
  readonly onRelease: (chat: PanelChat) => void
  readonly onDelete: (chat: PanelChat) => void
  readonly t: PanelTranslate
}): ReactNode {
  const [menuOpen, setMenuOpen] = useState(false)
  const state = teamCardState(chat)
  const turn = chat.latestTurn
  const fresh = turn?.freshSession === true
  const dotInfo = teamDot(state, chat.active, turn?.failureKind)
  const rail = teamRail(state, fresh, turn?.failureKind)
  const tag = teamTag(state, turn?.stopReason, fresh, turn?.failureKind)
  const short = shortId(chat.chatId)
  const roleName = chat.role ?? chat.label ?? short
  const menuItems: MenuEntry[] = [
    { id: 'release', label: t('releaseProcess'), disabled: pending || !chat.active },
    { type: 'separator', id: 'sep' },
    { id: 'delete', label: t('deleteRecord'), disabled: pending, danger: true },
  ]
  const taskRaw = state === 'running' ? chat.inFlight?.message : turn?.message
  const taskText = taskRaw === undefined ? '' : cleanPreview(taskRaw, { maxLines: state === 'running' ? 2 : 1, maxChars: 160 })
  const replyRaw = state === 'running' || state === 'idle' ? undefined : turn?.output
  const replyClean = replyRaw === undefined ? '' : cleanPreview(replyRaw, { maxLines: state === 'completed' ? 2 : 1, maxChars: 160 })
  const replyText = state === 'error' && turn !== undefined
    ? (replyClean || t('noAnswer'))
    : replyClean
  const cardTitle = [
    roleName,
    chat.chatId,
    chat.cwd === '' ? undefined : t('cwd', { cwd: chat.cwd }),
    chat.active ? t('active') : t('released'),
  ].filter(Boolean).join('\n')

  return (
    <li style={styles.item} data-chat-id={chat.chatId} data-team-role={roleName} data-team-state={state} title={cardTitle} onClick={() => { onOpen(chat) }}>
      <PanelCard rail={rail} style={styles.card}>
        <div style={styles.head}>
          <span data-dot={dotInfo.key} style={styles.dot}>
            <StateDot state={dotInfo.dot} {...(dotInfo.step ? { appearance: 'step' as const } : {})} />
          </span>
          <button type="button" style={styles.nameButton} aria-label={t('viewDetail', { chatId: short })}>
            <span style={styles.name} data-name="">{roleName}</span>
          </button>
          {tag === undefined ? null : <Tag tone={tag.tone}>{t(tag.key)}</Tag>}
          {(chat.backendCount ?? 1) > 1 && chat.backend !== undefined ? <Tag tone="neutral">{t('backendBadge', { name: chat.backendDisplay ?? chat.backend })}</Tag> : null}
          {state === 'running' && chat.inFlight !== undefined ? (
            <LiveElapsed startedAt={chat.inFlight.startedAt} now={now} t={t} />
          ) : turn !== undefined ? (
            <span style={styles.time} data-time="" title={formatTurnTimeTitle(t, { startedAt: turn.startedAt, at: turn.at }, now)}>
              {formatTurnTime(t, { startedAt: turn.startedAt, at: turn.at }, now)}
            </span>
          ) : (
            <span style={styles.time} data-time="" title={formatTurnTimeTitle(t, { at: chat.lastActive }, now)}>
              {formatHybridTime(t, chat.lastActive, now)}
            </span>
          )}
          <div style={styles.menuWrap} onClick={(event: MouseEvent) => { event.stopPropagation() }}>
            <Menu
              open={menuOpen}
              align="end"
              onClose={() => { setMenuOpen(false) }}
              items={menuItems}
              onSelect={(id) => {
                setMenuOpen(false)
                if (id === 'release') onRelease(chat)
                else if (id === 'delete') onDelete(chat)
              }}
              anchor={(
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  icon={<IconEllipsisOutlineRegular size={14} />}
                  aria-label={t('moreActions')}
                  aria-expanded={menuOpen}
                  onClick={(event: MouseEvent) => { event.stopPropagation(); setMenuOpen(open => !open) }}
                />
              )}
            />
          </div>
        </div>
        {state === 'idle' ? (
          <div style={styles.hintLine} data-team-hint="">
            <span>{t('teamIdleHint')}</span>
            {!chat.active ? <span>· {t('teamRoleReleased')}</span> : null}
          </div>
        ) : (
          <>
            {taskText !== '' ? <div style={styles.taskLine} data-team-task="">↗ {taskText}</div> : null}
            {state === 'running' ? (
              <div style={styles.hintLine} data-team-hint="">{t('teamRunningHint')}</div>
            ) : (
              <>
                {replyText !== '' ? <div style={styles.replyLine} data-team-reply="">{replyText}</div> : null}
                {!chat.active ? <div style={styles.hintLine} data-team-released="">{t('teamRoleReleased')}</div> : null}
              </>
            )}
          </>
        )}
        {settings ? <ChatSettings key={chat.connectionId ?? 'released'} chat={chat} actions={settings} t={t} /> : null}
      </PanelCard>
    </li>
  )
}

/** Memory-only idle card for a defined workspace role that has not been dispatched yet (D47 2026-11-27). */
function UnprovisionedRoleCard({ role, t }: { readonly role: string; readonly t: PanelTranslate }): ReactNode {
  const hint = t('teamUnprovisionedHint')
  return (
    <li style={styles.item} data-team-role={role} data-team-state="idle" data-team-unprovisioned="" title={`${role}\n${hint}`}>
      <PanelCard rail="none" style={styles.unprovisionedCard}>
        <div style={styles.head}>
          <span data-dot="idle" style={styles.dot}>
            <StateDot state="idle" />
          </span>
          <span style={styles.name} data-name="">{role}</span>
        </div>
        <div style={styles.hintLine} data-team-hint="">{hint}</div>
      </PanelCard>
    </li>
  )
}

/**
 * Render the session's team dispatch section (D47, revised 2026-11-27):
 * hidden only when `roles` is disabled; shows defined roles (dispatched +
 * unprovisioned idle cards) or a one-line setup hint when no roles are defined.
 */
export function TeamSection({
  chats,
  definedRoles,
  rolesEnabled = true,
  settings,
  now,
  pending,
  onOpen,
  onRelease,
  onDelete,
  t,
}: TeamSectionProps): ReactNode {
  const view = buildTeamSectionView(chats, definedRoles, rolesEnabled)
  if (view.mode === 'hidden') return null
  if (view.mode === 'unconfigured') {
    const [before, after = ''] = t('teamUnconfiguredHint', { path: '\0' }).split('\0')
    return (
      <section style={styles.section} data-section="team" data-team="" data-team-mode="unconfigured">
        <SectionHeading title={t('teamHeading')} />
        <p style={styles.unconfigured} data-team-empty="">
          {before}<code style={styles.codePath}>{TEAM_CONFIG_DISPLAY_PATH}</code>{after}
        </p>
      </section>
    )
  }
  return (
    <section style={styles.section} data-section="team" data-team="" data-team-mode="roles">
      <SectionHeading title={t('teamHeading')} aside={t('teamRoleCount', { count: view.entries.length })} />
      <ul style={styles.list}>
        {view.entries.map(entry => (
          entry.kind === 'chat' ? (
            <TeamRoleCard
              key={entry.chat.chatId}
              chat={entry.chat}
              settings={settings}
              now={now}
              pending={pending.has(entry.chat.chatId)}
              onOpen={onOpen}
              onRelease={onRelease}
              onDelete={onDelete}
              t={t}
            />
          ) : (
            <UnprovisionedRoleCard key={`role:${entry.role}`} role={entry.role} t={t} />
          )
        ))}
      </ul>
    </section>
  )
}
