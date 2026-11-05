/**
 * The persistent-chat panel body (PANEL-DESIGN §2.2/§2.3): header with
 * refresh, empty state, one card per chat, release without confirmation,
 * delete behind a confirmation dialog. A card opens the chat's detail tab
 * (D18) on a click anywhere on it; its release/delete buttons stop the click.
 * Active chats come first; released ones
 * sit under a "Released (N)" group header, collapsed by default, with the
 * open state kept in component state only. Both groups keep the snapshot's
 * newest-first order. A header filter (D20) switches between all chats
 * (default) and the ones this DSH session opened; each card's origin — this
 * session, another session, or unknown (chats started before attribution) —
 * shows in its meta row. The filter is a pure view concern: the list stays
 * profile-global, nothing is hidden by access. Pure props: data arrives
 * through the bound `useChats` hook, the current session id and commands
 * through props, copy through `t`.
 * @module dsh-acp-resume/client/ChatsPanel
 */

import { useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { chatAddress } from './chat-address.ts'
import type { ChatsPanelInjected, ChatsSnapshot, PanelChat, SelectorHook, TabInfoHook } from './face.ts'
import type { PanelTranslate } from './locales.ts'

/** The panel's props: the injected face with `hooks.chats` bound to `useChats`, plus the locale seat. */
export type ChatsPanelProps = Omit<ChatsPanelInjected, 'hooks'> & {
  readonly useChats: SelectorHook<ChatsSnapshot>
  /** The framework's tab-info hook: its `tab.actions.openResource` opens a detail tab. */
  readonly useTabInfo: TabInfoHook
  /** The DSH session viewing the panel; `undefined` when none is on screen (the "this session" filter is then unavailable). */
  readonly currentSessionId: string | undefined
  readonly t: PanelTranslate
}

/** Which chats the panel shows: every chat in the profile registry, or only the ones this session opened. */
type ChatFilter = 'all' | 'mine'

/** How a chat relates to the viewing session. */
function originOf(chat: PanelChat, currentSessionId: string | undefined): 'mine' | 'other' | 'unknown' {
  if (chat.ownerSessionId === undefined) return 'unknown'
  return currentSessionId !== undefined && chat.ownerSessionId === currentSessionId ? 'mine' : 'other'
}

/** Tool the empty state points the user to. */
const START_TOOL = 'acp_chat_start'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const styles = {
  root: { display: 'flex', flexDirection: 'column', gap: 8, padding: 12, height: '100%', overflowY: 'auto', boxSizing: 'border-box' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  heading: { margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
  notice: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
  error: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' },
  empty: { display: 'flex', flexDirection: 'column', gap: 4, padding: '24px 4px', textAlign: 'center' },
  card: { cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 4, padding: 10, borderRadius: 12, border: '1px solid var(--dsw-alias-border-l3)', background: 'var(--dsw-alias-bg-layer-2)' },
  nameButton: { flex: 1, minWidth: 0, padding: 0, border: 0, background: 'transparent', textAlign: 'left', font: 'inherit', cursor: 'pointer' },
  cardHead: { display: 'flex', alignItems: 'center', gap: 6 },
  name: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
  id: { fontSize: 12, fontWeight: 400, color: 'var(--dsw-alias-label-tertiary)' },
  line: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' },
  meta: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', overflowWrap: 'anywhere' },
  dotActive: { color: 'var(--dsw-alias-state-success-primary)' },
  dotReleased: { color: 'var(--dsw-alias-label-tertiary)' },
  list: { display: 'flex', flexDirection: 'column', gap: 8, margin: 0, padding: 0, listStyle: 'none' },
  groupToggle: { alignSelf: 'flex-start' },
  controls: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  countNote: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
  origin: { fontWeight: 500, color: 'var(--dsw-alias-label-secondary)' },
} satisfies Record<string, CSSProperties>

/**
 * `chat-` plus the first 8 characters of the minted id (`chat-a1b2c3d4`).
 * @param chatId - pool chat id, normally `chat-<uuid>`.
 * @returns the short display form.
 */
export function shortChatId(chatId: string): string {
  return chatId.startsWith('chat-') ? `chat-${chatId.slice(5, 13)}` : chatId.slice(0, 8)
}

/**
 * Coarse relative time of `then` seen from `now`.
 * @param t - panel copy.
 * @param then - past epoch milliseconds.
 * @param now - reference epoch milliseconds.
 * @returns localized "n minutes ago" style text.
 */
export function relativeTime(t: PanelTranslate, then: number, now: number): string {
  const elapsed = Math.max(0, now - then)
  if (elapsed < MINUTE) return t('justNow')
  if (elapsed < HOUR) return t('minutesAgo', { count: Math.floor(elapsed / MINUTE) })
  if (elapsed < DAY) return t('hoursAgo', { count: Math.floor(elapsed / HOUR) })
  return t('daysAgo', { count: Math.floor(elapsed / DAY) })
}

function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface ChatCardProps {
  readonly chat: PanelChat
  readonly now: number
  readonly pending: boolean
  readonly origin: 'mine' | 'other' | 'unknown'
  readonly onRelease: (chat: PanelChat) => void
  readonly onDelete: (chat: PanelChat) => void
  readonly onOpen: (chat: PanelChat) => void
  readonly t: PanelTranslate
}

/** The origin label shown in a card's meta row; "this session" chats carry none (the common, unremarkable case). */
function originLabel(t: PanelTranslate, origin: 'mine' | 'other' | 'unknown'): string | undefined {
  if (origin === 'mine') return undefined
  return origin === 'other' ? t('originOther') : t('originUnknown')
}

function ChatCard({ chat, now, pending, origin, onRelease, onDelete, onOpen, t }: ChatCardProps): ReactNode {
  const short = shortChatId(chat.chatId)
  const turns = chat.turnCount === undefined ? t('noValue') : String(chat.turnCount)
  const status = [
    chat.active ? t('active') : t('released'),
    t('turns', { count: turns }),
    relativeTime(t, chat.lastActive, now),
  ].join(' · ')
  return (
    <li style={styles.card} data-chat-id={chat.chatId} onClick={() => { onOpen(chat) }}>
      <div style={styles.cardHead}>
        <span aria-hidden="true" style={chat.active ? styles.dotActive : styles.dotReleased}>{chat.active ? '●' : '○'}</span>
        {/* The click is handled by the card; this button is the keyboard and screen-reader way in. */}
        <button type="button" style={styles.nameButton} title={chat.chatId} aria-label={t('viewDetail', { chatId: short })}>
          <span style={styles.name}>
            {chat.label ?? short}
            {chat.label === undefined ? null : <span style={styles.id}> {short}</span>}
          </span>
        </button>
        <Button size="sm" variant="ghost" disabled={pending || !chat.active} aria-label={t('releaseLabel', { chatId: short })}
          onClick={(event: MouseEvent) => { event.stopPropagation(); onRelease(chat) }}>{t('release')}</Button>
        <Button size="sm" variant="ghost" disabled={pending} aria-label={t('deleteLabel', { chatId: short })}
          onClick={(event: MouseEvent) => { event.stopPropagation(); onDelete(chat) }}>{t('delete')}</Button>
      </div>
      <p style={styles.line}>{chat.title === undefined ? t('noValue') : chat.title}</p>
      <p style={styles.meta} data-origin={origin}>
        {status}
        {originLabel(t, origin) === undefined ? null : <> · <span style={styles.origin}>{originLabel(t, origin)}</span></>}
      </p>
      <p style={styles.meta}>{t('cwd', { cwd: chat.cwd })} · {t('remote', { id: chat.remoteSessionId.slice(0, 8) })}</p>
    </li>
  )
}

/**
 * Render the panel.
 * @param props - bound chats hook, commands, and copy.
 * @returns the panel body.
 */
export function ChatsPanel({ useChats, useTabInfo, currentSessionId, refresh, close, purge, t }: ChatsPanelProps): ReactNode {
  const snapshot = useChats(s => s)
  const { tab } = useTabInfo()
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set())
  const [confirming, setConfirming] = useState<PanelChat | undefined>(undefined)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  const [releasedOpen, setReleasedOpen] = useState(false)
  // Default to "all" so opening the panel in a fresh session never looks empty.
  const [filter, setFilter] = useState<ChatFilter>('all')

  const run = (chatId: string, action: (chatId: string) => Promise<void>): void => {
    setPending(current => new Set(current).add(chatId))
    setActionError(undefined)
    action(chatId).catch((error: unknown) => { setActionError(t('actionFailed', { message: failure(error) })) }).finally(() => {
      setPending((current) => {
        const next = new Set(current)
        next.delete(chatId)
        return next
      })
    })
  }

  const now = snapshot.fetchedAt ?? 0
  // "mine" needs a session on screen; without one the filter is not offered.
  const canFilterMine = currentSessionId !== undefined
  const effectiveFilter: ChatFilter = filter === 'mine' && canFilterMine ? 'mine' : 'all'
  const visible = effectiveFilter === 'mine'
    ? snapshot.chats.filter(c => originOf(c, currentSessionId) === 'mine')
    : snapshot.chats
  const activeChats = visible.filter(c => c.active)
  const releasedChats = visible.filter(c => !c.active)
  const cards = (chats: readonly PanelChat[]): ReactNode => (
    <ul style={styles.list}>
      {chats.map(chat => (
        <ChatCard key={chat.chatId} chat={chat} now={now} pending={pending.has(chat.chatId)} origin={originOf(chat, currentSessionId)} t={t}
          onOpen={(target) => { tab.actions.openResource(chatAddress(target.chatId)) }}
          onRelease={(target) => { run(target.chatId, close) }}
          onDelete={(target) => { setConfirming(target) }} />
      ))}
    </ul>
  )
  const confirmingShort = confirming === undefined ? '' : shortChatId(confirming.chatId)
  return (
    <section style={styles.root} aria-label={t('title')}>
      <div style={styles.header}>
        <h2 style={styles.heading}>{t('title')}</h2>
        <div style={styles.controls}>
          {canFilterMine ? (
            <Button size="sm" variant="ghost" aria-label={t('filterLabel')} aria-pressed={effectiveFilter === 'mine'}
              onClick={() => { setFilter(current => (current === 'mine' ? 'all' : 'mine')) }}>
              {effectiveFilter === 'mine' ? t('filterMine') : t('filterAll')}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => { refresh() }}>{t('refresh')}</Button>
        </div>
      </div>
      {snapshot.status === 'error' && snapshot.error !== undefined
        ? <p role="alert" style={styles.error}>{t('loadFailed', { message: snapshot.error })}</p>
        : null}
      {actionError === undefined ? null : <p role="alert" style={styles.error}>{actionError}</p>}
      {snapshot.status === 'loading'
        ? <p style={styles.notice}>{t('loading')}</p>
        : snapshot.chats.length === 0
          ? (
            <div style={styles.empty}>
              <p style={styles.heading}>{t('emptyTitle')}</p>
              <p style={styles.notice}>{t('emptyHint', { tool: START_TOOL })}</p>
            </div>
          )
          : (
            <>
              {effectiveFilter === 'mine'
                ? <p style={styles.countNote} data-count="mine">{t('countMine', { count: visible.length, total: snapshot.chats.length })}</p>
                : <p style={styles.countNote} data-count="all">{t('countAll', { count: snapshot.chats.length })}</p>}
              {effectiveFilter === 'mine' && visible.length === 0
                ? <p style={styles.notice} data-empty="mine">{t('countMine', { count: 0, total: snapshot.chats.length })}</p>
                : null}
              {activeChats.length === 0 ? null : cards(activeChats)}
              {releasedChats.length === 0 ? null : (
                <>
                  <Button size="sm" variant="ghost" style={styles.groupToggle} aria-expanded={releasedOpen}
                    onClick={() => { setReleasedOpen(open => !open) }}>
                    {t('releasedGroup', { count: releasedChats.length })} · {releasedOpen ? t('collapse') : t('expand')}
                  </Button>
                  {releasedOpen ? cards(releasedChats) : null}
                </>
              )}
            </>
          )}
      <Modal open={confirming !== undefined} onClose={() => { setConfirming(undefined) }} closeLabel={t('dismiss')}
        title={t('confirmTitle', { chatId: confirmingShort })} description={t('confirmBody')}
        footer={(
          <>
            <Button variant="outline" data-modal-autofocus onClick={() => { setConfirming(undefined) }}>{t('cancel')}</Button>
            <Button variant="primary" onClick={() => {
              if (confirming !== undefined) run(confirming.chatId, purge)
              setConfirming(undefined)
            }}>{t('delete')}</Button>
          </>
        )} />
    </section>
  )
}
