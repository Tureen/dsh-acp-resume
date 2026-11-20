/**
 * The persistent-chat panel body (PANEL-DESIGN §2.2/§2.3): header with
 * refresh, empty state, one card per chat, release without confirmation
 * while idle (behind one while a turn is in flight, since releasing cancels
 * it), delete behind a confirmation dialog. A card's summary line shows the
 * in-flight message's first line (`当前:…`) while a turn runs, else the
 * first-turn title. A card opens the chat's detail tab
 * (D18) on a click anywhere on it; its release/delete buttons stop the click.
 * A header line counts the session's chats by state (running · idle ·
 * released). Each row is one line (dot, name, backend badge, running time);
 * the current message, turn count and last activity sit in its hover text.
 * The dot is the official StateDot over the panel states ({@link chatDotState}).
 * Active chats come first; past six, the first five show and the rest sit
 * behind a "show the other N" toggle whose state survives a remount; released ones
 * sit under a "Released (N)" group header, collapsed by default, with the
 * open state kept in component state only. Both groups keep the snapshot's
 * newest-first order. The panel is strictly scoped to chats opened by the visible DSH session (D20),
 * so rows show no owner. This is discovery only:
 * knowing a chat id still permits operations from any session. The host list
 * remains profile-global; this component only filters its local view. Pure props: data arrives
 * through the bound `useChats` hook, the current session id and commands
 * through props, copy through `t`.
 * @module dsh-acp-resume/client/ChatsPanel
 */

import { useEffect, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { Button, Modal, StateDot, Tag, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import { chatAddress } from './chat-address.ts'
import type { ChatsPanelInjected, ChatsSnapshot, PanelChat, PanelUsage, SelectorHook, TabInfoHook } from './face.ts'
import type { PanelTranslate } from './locales.ts'

/** The panel's props: the injected face with `hooks.chats` bound to `useChats`, plus the locale seat. */
export type ChatsPanelProps = Omit<ChatsPanelInjected, 'hooks'> & {
  readonly useChats: SelectorHook<ChatsSnapshot>
  /** The framework's tab-info hook: its `tab.actions.openResource` opens a detail tab. */
  readonly useTabInfo: TabInfoHook
  /** The DSH session viewing the panel; without one no owned chats are discoverable. */
  readonly currentSessionId: string | undefined
  readonly t: PanelTranslate
}

/** Newest `lastActive` first. */
function byLastActive(a: PanelChat, b: PanelChat): number {
  return b.lastActive - a.lastActive
}

/** Chats with a turn in flight first (newest prompt first), then the rest by newest `lastActive`. */
function activeOrder(a: PanelChat, b: PanelChat): number {
  if (a.inFlight !== undefined && b.inFlight !== undefined) return b.inFlight.startedAt - a.inFlight.startedAt
  if (a.inFlight !== undefined) return -1
  if (b.inFlight !== undefined) return 1
  return byLastActive(a, b)
}

/** Active chats fold only past this many: the toggle takes a row itself, so hiding a single chat saves nothing. */
const ACTIVE_FOLD_ABOVE = 6
/** Active chats left visible while folded. */
const ACTIVE_FOLD_SHOWN = 5

/**
 * Whether the active group is unfolded. Module scope on purpose: the panel
 * remounts when hidden and shown again, and the choice should survive that
 * (but not a reload).
 */
let activeExpanded = false

/** Reset module-scoped view state (tests only). */
export function resetChatsPanelViewState(): void {
  activeExpanded = false
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
  dot: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 14, flex: 'none' },
  list: { display: 'flex', flexDirection: 'column', gap: 8, margin: 0, padding: 0, listStyle: 'none' },
  groupToggle: { alignSelf: 'flex-start' },
  controls: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  countNote: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
  usage: { display: 'flex', flexDirection: 'column', gap: 2 },
  usageError: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' },
  elapsed: { flex: 'none', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', fontVariantNumeric: 'tabular-nums' },
} satisfies Record<string, CSSProperties>

/**
 * A chat's panel state, most urgent first: a turn in flight (`ongoing`), the
 * newest log entry's attention (`error` / `warning`), then for a live process
 * `done` when its newest turn completed or `idle` otherwise; a released process
 * is `released`.
 */
export type ChatDotState = 'ongoing' | 'error' | 'warning' | 'done' | 'idle' | 'released'

/**
 * The official StateDot state per panel state, following the DSH colour rule
 * (green means finished, grey means tracked but not working). `released`
 * draws the grey `idle` dot hollow (the `step` appearance) so it reads weaker
 * than a live idle chat.
 */
const STATE_DOT: Readonly<Record<ChatDotState, StateDotState>> = {
  ongoing: 'ongoing', error: 'error', warning: 'warning', done: 'done', idle: 'idle', released: 'idle',
}

/**
 * Classify a chat for its state dot. Attention outranks liveness on purpose: an
 * `error` turn releases its process, so a released chat is exactly where a
 * failure must still show.
 * @param chat - the row, or the detail page's chat plus whether a running entry is shown.
 * @param running - a turn is known to be in flight even if `chat.inFlight` lags.
 */
export function chatDotState(chat: Pick<PanelChat, 'inFlight' | 'attention' | 'active' | 'lastCompleted'>, running = false): ChatDotState {
  if (running || chat.inFlight !== undefined) return 'ongoing'
  if (chat.attention !== undefined) return chat.attention
  if (!chat.active) return 'released'
  return chat.lastCompleted === true ? 'done' : 'idle'
}

/**
 * Render a chat's state dot (the official StateDot), tagged `data-dot` with the panel state.
 * @param props.state - the panel state from {@link chatDotState}.
 */
export function ChatStateDot({ state }: { readonly state: ChatDotState }): ReactNode {
  return (
    <span data-dot={state} style={styles.dot}>
      <StateDot state={STATE_DOT[state]} {...(state === 'released' ? { appearance: 'step' as const } : {})} />
    </span>
  )
}

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

/**
 * A duration in at most two adjacent units: `12秒`, `3分12秒`, `1时5分`, `2天3时`
 * (`12s`, `3m 12s`, `1h 5m`, `2d 3h` in English).
 * @param t - panel copy.
 * @param ms - duration in milliseconds; negative reads as zero.
 */
export function formatDuration(t: PanelTranslate, ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return t('durationSeconds', { s: seconds })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t('durationMinutes', { m: minutes, s: seconds % 60 })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('durationHours', { h: hours, m: minutes % 60 })
  return t('durationDays', { d: Math.floor(hours / 24), h: hours % 24 })
}

/** `已运行 3分12秒`: how long a turn has been running at `now`. */
export function elapsedTime(t: PanelTranslate, startedAt: number, now: number): string {
  return t('runningFor', { duration: formatDuration(t, now - startedAt) })
}

/**
 * A running turn's elapsed time, ticking once a second while mounted. It is
 * mounted only for a chat with a turn in flight, so no clock runs when nothing
 * is running, and only this span re-renders on each tick. The base is the
 * snapshot's `fetchedAt` (host time) plus local time passed since mount.
 */
function LiveElapsed({ startedAt, now, t }: { readonly startedAt: number; readonly now: number; readonly t: PanelTranslate }): ReactNode {
  const [drift, setDrift] = useState(0)
  useEffect(() => {
    const base = Date.now()
    setDrift(0)
    const timer = setInterval(() => { setDrift(Date.now() - base) }, 1000)
    return () => { clearInterval(timer) }
  }, [now, startedAt])
  return <span style={styles.elapsed} data-elapsed>{elapsedTime(t, startedAt, now + drift)}</span>
}

function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Longest in-flight message excerpt on a card, in characters (code points). */
const CURRENT_MESSAGE_MAX = 60

/** First non-empty line of a message, cut to {@link CURRENT_MESSAGE_MAX} characters with an ellipsis. */
function messageExcerpt(message: string): string {
  const line = message.split('\n').map(part => part.trim()).find(part => part !== '') ?? ''
  const chars = Array.from(line)
  return chars.length > CURRENT_MESSAGE_MAX ? `${chars.slice(0, CURRENT_MESSAGE_MAX).join('')}…` : line
}

interface ChatCardProps {
  readonly chat: PanelChat
  readonly now: number
  readonly pending: boolean
  readonly onRelease: (chat: PanelChat) => void
  readonly onDelete: (chat: PanelChat) => void
  readonly onOpen: (chat: PanelChat) => void
  readonly t: PanelTranslate
}

/** A usage window's length in words: `周` for 7 days, else hours or minutes. */
function windowLabel(t: PanelTranslate, mins: number): string {
  if (mins === 10_080) return t('usageWeek')
  return mins % 60 === 0 ? t('usageHours', { hours: mins / 60 }) : t('usageMinutes', { minutes: mins })
}

/**
 * The header's backend usage lines (D28): `codex · prolite · 83%` per backend
 * read `ok`, `codex · 额度读取失败` per `error`; `unsupported` backends are not
 * shown. The hover text names the window and its reset time, or the failure.
 */
function UsageLines({ usage, t }: { readonly usage: readonly PanelUsage[] | undefined; readonly t: PanelTranslate }): ReactNode {
  const shown = (usage ?? []).filter(u => u.status !== 'unsupported')
  if (shown.length === 0) return null
  return (
    <div style={styles.usage} data-usage>
      {shown.map((u) => {
        const text = u.status === 'error'
          ? [u.backend, t('usageFailed')].join(' · ')
          : [u.backend, ...(u.plan === undefined ? [] : [u.plan]), ...(u.usedPercent === undefined ? [] : [`${Math.round(u.usedPercent)}%`])].join(' · ')
        const hint = u.status === 'error'
          ? u.error ?? ''
          : [
              ...(u.usedPercent === undefined || u.windowMins === undefined ? [] : [t('usageWindow', { window: windowLabel(t, u.windowMins), percent: Math.round(u.usedPercent) })]),
              ...(u.resetsAt === undefined ? [] : [t('usageResets', { time: new Date(u.resetsAt * 1000).toLocaleString() })]),
            ].join(' · ')
        return <p key={u.backend} style={u.status === 'error' ? styles.usageError : styles.countNote} data-usage-backend={u.backend} title={hint}>{text}</p>
      })}
    </div>
  )
}

/**
 * The row's hover text (native `title`): the in-flight message's first line
 * (`当前:…`) or the first-turn title, then state, turn count, and last activity.
 * Recomputed on refresh only; it does not tick.
 */
function rowHint(t: PanelTranslate, chat: PanelChat, now: number): string {
  const turns = chat.turnCount === undefined ? t('noValue') : String(chat.turnCount)
  const summary = chat.inFlight !== undefined
    ? t('currentMessage', { message: messageExcerpt(chat.inFlight.message) })
    : chat.title === undefined ? undefined : t('chatTitle', { title: chat.title })
  const status = [chat.active ? t('active') : t('released'), t('turns', { count: turns }), relativeTime(t, chat.lastActive, now)].join(' · ')
  return summary === undefined ? status : `${summary}\n${status}`
}

/**
 * One chat row: state dot, name (label, else first-turn title, else short id;
 * one line with an ellipsis), backend badge, and the running time while a turn
 * is in flight. Everything else sits in the hover text and the detail tab.
 */
function ChatCard({ chat, now, pending, onRelease, onDelete, onOpen, t }: ChatCardProps): ReactNode {
  const short = shortChatId(chat.chatId)
  const name = chat.label ?? chat.title ?? short
  return (
    <li style={styles.card} data-chat-id={chat.chatId} title={rowHint(t, chat, now)} onClick={() => { onOpen(chat) }}>
      <div style={styles.cardHead}>
        <ChatStateDot state={chatDotState(chat)} />
        {/* The click is handled by the card; this button is the keyboard and screen-reader way in. */}
        <button type="button" style={styles.nameButton} aria-label={t('viewDetail', { chatId: short })}>
          <span style={styles.name} data-name>
            {name}
            {name === short ? null : <span style={styles.id}> {short}</span>}
          </span>
        </button>
        {(chat.backendCount ?? 1) > 1 && chat.backend !== undefined ? <Tag tone="neutral">{t('backendBadge', { name: chat.backendDisplay ?? chat.backend })}</Tag> : null}
        {chat.inFlight === undefined ? null : <LiveElapsed startedAt={chat.inFlight.startedAt} now={now} t={t} />}
        <Button size="sm" variant="ghost" disabled={pending || !chat.active} aria-label={t('releaseLabel', { chatId: short })}
          onClick={(event: MouseEvent) => { event.stopPropagation(); onRelease(chat) }}>{t('release')}</Button>
        <Button size="sm" variant="ghost" disabled={pending} aria-label={t('deleteLabel', { chatId: short })}
          onClick={(event: MouseEvent) => { event.stopPropagation(); onDelete(chat) }}>{t('delete')}</Button>
      </div>
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
  const [confirming, setConfirming] = useState<{ readonly chat: PanelChat; readonly kind: 'delete' | 'release' } | undefined>(undefined)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  const [releasedOpen, setReleasedOpen] = useState(false)
  const [activeOpen, setActiveOpenState] = useState(activeExpanded)
  const setActiveOpen = (open: boolean): void => {
    activeExpanded = open
    setActiveOpenState(open)
  }

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
  // The session-scoped seat gives the viewer identity. A missing identity has
  // no discoverable owner set, so it deliberately shows no profile-global rows.
  const visible = currentSessionId === undefined
    ? []
    : snapshot.chats.filter(chat => chat.ownerSessionId === currentSessionId)
  const activeChats = visible.filter(c => c.active).sort(activeOrder)
  const releasedChats = visible.filter(c => !c.active).sort(byLastActive)
  const cards = (chats: readonly PanelChat[]): ReactNode => (
    <ul style={styles.list}>
      {chats.map(chat => (
        <ChatCard key={chat.chatId} chat={chat} now={now} pending={pending.has(chat.chatId)} t={t}
          onOpen={(target) => { tab.actions.openResource(chatAddress(target.chatId)) }}
          onRelease={(target) => {
            // Releasing cancels an in-flight turn: ask first. An idle chat releases at once.
            if (target.inFlight === undefined) run(target.chatId, close)
            else setConfirming({ chat: target, kind: 'release' })
          }}
          onDelete={(target) => { setConfirming({ chat: target, kind: 'delete' }) }} />
      ))}
    </ul>
  )
  const runningCount = visible.filter(c => c.inFlight !== undefined).length
  const foldable = activeChats.length > ACTIVE_FOLD_ABOVE
  const shownActive = activeOpen || !foldable ? activeChats : activeChats.slice(0, ACTIVE_FOLD_SHOWN)
  const confirmingShort = confirming === undefined ? '' : shortChatId(confirming.chat.chatId)
  const releasing = confirming?.kind === 'release'
  return (
    <section style={styles.root} aria-label={t('title')}>
      <div style={styles.header}>
        <h2 style={styles.heading}>{t('title')}</h2>
        <div style={styles.controls}>
          <Button size="sm" variant="ghost" onClick={() => { refresh() }}>{t('refresh')}</Button>
        </div>
      </div>
      <UsageLines usage={snapshot.usage} t={t} />
      {snapshot.status === 'error' && snapshot.error !== undefined
        ? <p role="alert" style={styles.error}>{t('loadFailed', { message: snapshot.error })}</p>
        : null}
      {actionError === undefined ? null : <p role="alert" style={styles.error}>{actionError}</p>}
      {snapshot.status === 'loading'
        ? <p style={styles.notice}>{t('loading')}</p>
        : visible.length === 0
          ? (
            <div style={styles.empty} data-empty="session">
              <p style={styles.heading}>{snapshot.chats.length === 0 ? t('emptyTitle') : t('countMine', { count: 0, total: snapshot.chats.length })}</p>
              <p style={styles.notice}>{snapshot.chats.length === 0 ? t('emptyHint', { tool: START_TOOL }) : t('emptySessionHint')}</p>
            </div>
          )
          : (
            <>
              <p style={styles.countNote} data-count="mine">{t('countMine', { count: visible.length, total: snapshot.chats.length })}</p>
              <p style={styles.countNote} data-count="states">
                {t('statsLine', { running: runningCount, idle: activeChats.length - runningCount, released: releasedChats.length })}
              </p>
              {activeChats.length === 0 ? null : cards(shownActive)}
              {!foldable ? null : (
                <Button size="sm" variant="ghost" style={styles.groupToggle} aria-expanded={activeOpen}
                  onClick={() => { setActiveOpen(!activeOpen) }}>
                  {activeOpen ? t('collapseActive') : t('showRest', { count: activeChats.length - ACTIVE_FOLD_SHOWN })}
                </Button>
              )}
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
        title={t(releasing ? 'releaseConfirmTitle' : 'confirmTitle', { chatId: confirmingShort })} description={t(releasing ? 'releaseConfirmBody' : 'confirmBody')}
        footer={(
          <>
            <Button variant="outline" data-modal-autofocus onClick={() => { setConfirming(undefined) }}>{t('cancel')}</Button>
            <Button variant="primary" onClick={() => {
              if (confirming !== undefined) run(confirming.chat.chatId, confirming.kind === 'release' ? close : purge)
              setConfirming(undefined)
            }}>{t(releasing ? 'release' : 'delete')}</Button>
          </>
        )} />
    </section>
  )
}
