/**
 * The persistent-chat panel body (PANEL-DESIGN §2.2/§2.3): header with
 * refresh, empty state, one card per chat, release without confirmation,
 * delete behind a confirmation dialog. Pure props: data arrives through the
 * bound `useChats` hook, commands through injected callbacks, copy through `t`.
 * @module dsh-acp-resume/client/ChatsPanel
 */

import { useState, type CSSProperties, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatsPanelInjected, ChatsSnapshot, PanelChat, SelectorHook } from './face.ts'
import type { PanelTranslate } from './locales.ts'

/** The panel's props: the injected face with `hooks.chats` bound to `useChats`, plus the locale seat. */
export type ChatsPanelProps = Omit<ChatsPanelInjected, 'hooks'> & {
  readonly useChats: SelectorHook<ChatsSnapshot>
  readonly t: PanelTranslate
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
  card: { display: 'flex', flexDirection: 'column', gap: 4, padding: 10, borderRadius: 12, border: '1px solid var(--dsw-alias-border-l3)', background: 'var(--dsw-alias-bg-layer-2)' },
  cardHead: { display: 'flex', alignItems: 'center', gap: 6 },
  name: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
  id: { fontSize: 12, fontWeight: 400, color: 'var(--dsw-alias-label-tertiary)' },
  line: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' },
  meta: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', overflowWrap: 'anywhere' },
  dotActive: { color: 'var(--dsw-alias-state-success-primary)' },
  dotReleased: { color: 'var(--dsw-alias-label-tertiary)' },
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
  readonly onRelease: (chat: PanelChat) => void
  readonly onDelete: (chat: PanelChat) => void
  readonly t: PanelTranslate
}

function ChatCard({ chat, now, pending, onRelease, onDelete, t }: ChatCardProps): ReactNode {
  const short = shortChatId(chat.chatId)
  const turns = chat.turnCount === undefined ? t('noValue') : String(chat.turnCount)
  const status = [
    chat.active ? t('active') : t('released'),
    t('turns', { count: turns }),
    relativeTime(t, chat.lastActive, now),
  ].join(' · ')
  return (
    <li style={styles.card} data-chat-id={chat.chatId}>
      <div style={styles.cardHead}>
        <span aria-hidden="true" style={chat.active ? styles.dotActive : styles.dotReleased}>{chat.active ? '●' : '○'}</span>
        <span style={styles.name} title={chat.chatId}>
          {chat.label ?? short}
          {chat.label === undefined ? null : <span style={styles.id}> {short}</span>}
        </span>
        <Button size="sm" variant="ghost" disabled={pending || !chat.active} aria-label={t('releaseLabel', { chatId: short })}
          onClick={() => { onRelease(chat) }}>{t('release')}</Button>
        <Button size="sm" variant="ghost" disabled={pending} aria-label={t('deleteLabel', { chatId: short })}
          onClick={() => { onDelete(chat) }}>{t('delete')}</Button>
      </div>
      <p style={styles.line}>{chat.title === undefined ? t('noValue') : chat.title}</p>
      <p style={styles.meta}>{status}</p>
      <p style={styles.meta}>{t('cwd', { cwd: chat.cwd })} · {t('remote', { id: chat.remoteSessionId.slice(0, 8) })}</p>
    </li>
  )
}

/**
 * Render the panel.
 * @param props - bound chats hook, commands, and copy.
 * @returns the panel body.
 */
export function ChatsPanel({ useChats, refresh, close, purge, t }: ChatsPanelProps): ReactNode {
  const snapshot = useChats(s => s)
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set())
  const [confirming, setConfirming] = useState<PanelChat | undefined>(undefined)
  const [actionError, setActionError] = useState<string | undefined>(undefined)

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
  const confirmingShort = confirming === undefined ? '' : shortChatId(confirming.chatId)
  return (
    <section style={styles.root} aria-label={t('title')}>
      <div style={styles.header}>
        <h2 style={styles.heading}>{t('title')}</h2>
        <Button size="sm" variant="ghost" onClick={() => { refresh() }}>{t('refresh')}</Button>
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
            <ul style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: 0, padding: 0, listStyle: 'none' }}>
              {snapshot.chats.map(chat => (
                <ChatCard key={chat.chatId} chat={chat} now={now} pending={pending.has(chat.chatId)} t={t}
                  onRelease={(target) => { run(target.chatId, close) }}
                  onDelete={(target) => { setConfirming(target) }} />
              ))}
            </ul>
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
