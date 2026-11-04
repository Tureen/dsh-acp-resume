/**
 * The chat detail tab body (D18, PANEL-DESIGN §2.6): one persistent chat's
 * facts (label, short ids, cwd, state, turn count, first-turn title) and its
 * turn history, newest first. Each turn shows a question/answer preview, its
 * stop reason, and a relative time; a click expands the full text, fetched on
 * demand when the preview is shorter than the text. Reconnect events sit in the
 * same list. Release and delete work from here too. Expansion and fetched text
 * live in component state only (they reset when the tab is hidden and shown
 * again). Pure props: data arrives through a per-chat {@link DetailSource},
 * commands through injected callbacks, copy through `t`.
 * @module dsh-acp-resume/client/ChatDetail
 */

import { useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { parseChatAddress } from './chat-address.ts'
import { relativeTime, shortChatId } from './ChatsPanel.tsx'
import type { ChatDetailInjected, DetailSource, EventItem, FullEntry, TabInfoHook, TurnItem } from './face.ts'
import type { PanelTranslate } from './locales.ts'

/** The detail body's props: the injected face plus the framework's tab-info hook and the locale seat. */
export type ChatDetailProps = ChatDetailInjected & {
  readonly useTabInfo: TabInfoHook
  readonly t: PanelTranslate
}

const styles = {
  root: { display: 'flex', flexDirection: 'column', gap: 8, padding: 12, height: '100%', overflowY: 'auto', boxSizing: 'border-box' },
  header: { display: 'flex', alignItems: 'center', gap: 6 },
  heading: { flex: 1, minWidth: 0, margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', overflowWrap: 'anywhere' },
  id: { fontSize: 12, fontWeight: 400, color: 'var(--dsw-alias-label-tertiary)' },
  notice: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
  error: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' },
  meta: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', overflowWrap: 'anywhere' },
  subheading: { margin: '8px 0 0', fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
  list: { display: 'flex', flexDirection: 'column', gap: 6, margin: 0, padding: 0, listStyle: 'none' },
  turn: { padding: 8, borderRadius: 10, border: '1px solid var(--dsw-alias-border-l3)', background: 'var(--dsw-alias-bg-layer-2)' },
  turnButton: { display: 'flex', flexDirection: 'column', gap: 2, width: '100%', padding: 0, border: 0, background: 'transparent', textAlign: 'left', font: 'inherit', cursor: 'pointer', color: 'inherit' },
  turnHead: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
  line: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' },
  full: { margin: '6px 0 0', padding: 8, borderRadius: 8, fontSize: 12, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)' },
  event: { margin: 0, padding: '4px 8px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' },
  centered: { display: 'flex', flexDirection: 'column', gap: 6, padding: '24px 4px', textAlign: 'center', alignItems: 'center' },
} satisfies Record<string, CSSProperties>

function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The localized stop reason; an unknown one is shown as the agent reported it. */
function stopLabel(t: PanelTranslate, stopReason: string): string {
  switch (stopReason) {
    case 'completed': return t('stopCompleted')
    case 'aborted': return t('stopAborted')
    case 'error': return t('stopError')
    case 'max-tokens': return t('stopMaxTokens')
    case 'refusal': return t('stopRefusal')
    default: return stopReason
  }
}

type FullState = { readonly status: 'loading' } | { readonly status: 'ready'; readonly entry: FullEntry } | { readonly status: 'error'; readonly message: string }

interface TurnRowProps {
  readonly item: TurnItem
  readonly now: number
  readonly open: boolean
  readonly full: FullState | undefined
  readonly onToggle: (item: TurnItem) => void
  readonly t: PanelTranslate
}

function TurnRow({ item, now, open, full, onToggle, t }: TurnRowProps): ReactNode {
  const fullEntry = full?.status === 'ready' && full.entry.kind === 'turn' ? full.entry : undefined
  const message = fullEntry?.message ?? item.message
  const output = fullEntry?.output ?? item.output
  return (
    <li style={styles.turn} data-seq={item.seq}>
      <button type="button" style={styles.turnButton} aria-expanded={open} aria-label={t('turnToggle', { seq: item.seq })}
        onClick={() => { onToggle(item) }}>
        <span style={styles.turnHead}>
          #{item.seq} · {stopLabel(t, item.stopReason)}{item.freshSession ? ` · ${t('freshBadge')}` : ''} · {relativeTime(t, item.at, now)}
        </span>
        <span style={styles.line}>{t('question')}: {open ? '' : item.message}</span>
        <span style={styles.line}>{t('answer')}: {open ? '' : (item.output === '' ? t('noAnswer') : item.output)}{open || !item.outputMore ? '' : '…'}</span>
      </button>
      {open ? (
        <>
          <pre style={styles.full} data-full="message">{message}</pre>
          <pre style={styles.full} data-full="output">{output === '' ? t('noAnswer') : output}</pre>
          {full?.status === 'loading' ? <p style={styles.notice}>{t('loadingFull')}</p> : null}
          {full?.status === 'error' ? <p role="alert" style={styles.error}>{t('fullFailed', { message: full.message })}</p> : null}
          {item.diagnostic === undefined ? null : <p style={styles.meta}>{t('diagnostic', { text: item.diagnostic })}</p>}
        </>
      ) : null}
    </li>
  )
}

function EventRow({ item, now, t }: { readonly item: EventItem; readonly now: number; readonly t: PanelTranslate }): ReactNode {
  const text = item.event === 'session-lost'
    ? t('eventSessionLost')
    : `${t('eventReconnectFailed', { error: item.error ?? '' })}${item.message === undefined ? '' : ` · ${t('failedMessage', { message: item.message })}`}`
  return <li style={styles.event} data-seq={item.seq} data-event={item.event}>{relativeTime(t, item.at, now)} · {text}</li>
}

interface ViewProps {
  readonly chatId: string
  readonly source: DetailSource
  readonly close: (chatId: string) => Promise<void>
  readonly purge: (chatId: string) => Promise<void>
  readonly closeTab: () => void
  readonly t: PanelTranslate
}

function ChatDetailView({ chatId, source, close, purge, closeTab, t }: ViewProps): ReactNode {
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot)
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set())
  const [fulls, setFulls] = useState<Readonly<Record<number, FullState>>>({})
  const [pending, setPending] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  const short = shortChatId(chatId)

  if (snapshot.status === 'gone') {
    return (
      <section style={styles.root} aria-label={short}>
        <div style={styles.centered}>
          <p style={styles.heading}>{t('goneTitle')}</p>
          <p style={styles.notice}>{t('goneBody')}</p>
          <Button size="sm" variant="outline" onClick={closeTab}>{t('closeTab')}</Button>
        </div>
      </section>
    )
  }

  const toggle = (item: TurnItem): void => {
    const opening = !expanded.has(item.seq)
    setExpanded((current) => {
      const next = new Set(current)
      if (opening) next.add(item.seq)
      else next.delete(item.seq)
      return next
    })
    if (!opening || fulls[item.seq] !== undefined || (!item.messageMore && !item.outputMore)) return
    setFulls(current => ({ ...current, [item.seq]: { status: 'loading' } }))
    source.loadEntry(item.seq).then(
      (entry) => { setFulls(current => ({ ...current, [item.seq]: { status: 'ready', entry } })) },
      (error: unknown) => { setFulls(current => ({ ...current, [item.seq]: { status: 'error', message: failure(error) } })) },
    )
  }

  const run = (action: (id: string) => Promise<void>, afterwards?: () => void): void => {
    setPending(true)
    setActionError(undefined)
    action(chatId).then(
      () => { void source.refresh(); afterwards?.() },
      (error: unknown) => { setActionError(t('actionFailed', { message: failure(error) })) },
    ).finally(() => { setPending(false) })
  }

  const chat = snapshot.chat
  const now = snapshot.fetchedAt ?? 0
  const newestFirst = [...snapshot.entries].reverse()
  const turns = chat?.turnCount === undefined ? t('noValue') : String(chat.turnCount)
  return (
    <section style={styles.root} aria-label={t('viewDetail', { chatId: short })} data-chat-id={chatId}>
      <div style={styles.header}>
        <h2 style={styles.heading} title={chatId}>
          {chat?.label ?? short}
          {chat?.label === undefined ? null : <span style={styles.id}> {short}</span>}
        </h2>
        <Button size="sm" variant="ghost" onClick={() => { void source.refresh() }}>{t('refreshDetail')}</Button>
        <Button size="sm" variant="ghost" disabled={pending || chat?.active !== true} aria-label={t('releaseLabel', { chatId: short })}
          onClick={() => { run(close) }}>{t('release')}</Button>
        <Button size="sm" variant="ghost" disabled={pending || chat === undefined} aria-label={t('deleteLabel', { chatId: short })}
          onClick={() => { setConfirming(true) }}>{t('delete')}</Button>
      </div>
      {snapshot.status === 'error' && snapshot.error !== undefined
        ? <p role="alert" style={styles.error}>{t('loadFailed', { message: snapshot.error })}</p>
        : null}
      {actionError === undefined ? null : <p role="alert" style={styles.error}>{actionError}</p>}
      {chat === undefined
        ? (snapshot.status === 'loading' ? <p style={styles.notice}>{t('loading')}</p> : null)
        : (
          <>
            <p style={styles.meta}>
              {[chat.active ? t('active') : t('released'), t('turns', { count: turns }), relativeTime(t, chat.lastActive, now)].join(' · ')}
            </p>
            {chat.title === undefined ? null : <p style={styles.line}>{t('chatTitle', { title: chat.title })}</p>}
            <p style={styles.meta}>{t('cwd', { cwd: chat.cwd })} · {t('remote', { id: chat.remoteSessionId.slice(0, 8) })}</p>
          </>
        )}
      <h3 style={styles.subheading}>{t('turnsHeading')}</h3>
      {snapshot.status !== 'loading' && newestFirst.length === 0 ? <p style={styles.notice}>{t('noTurns')}</p> : null}
      {newestFirst.length === 0 ? null : (
        <ul style={styles.list}>
          {newestFirst.map(item => item.kind === 'event'
            ? <EventRow key={item.seq} item={item} now={now} t={t} />
            : <TurnRow key={item.seq} item={item} now={now} open={expanded.has(item.seq)} full={fulls[item.seq]} onToggle={toggle} t={t} />)}
        </ul>
      )}
      {snapshot.total > snapshot.entries.length ? (
        <>
          <p style={styles.meta}>{t('shownOf', { shown: snapshot.entries.length, total: snapshot.total })}</p>
          <Button size="sm" variant="ghost" style={{ alignSelf: 'flex-start' }} onClick={() => { void source.loadMore() }}>{t('loadMore')}</Button>
        </>
      ) : null}
      <Modal open={confirming} onClose={() => { setConfirming(false) }} closeLabel={t('dismiss')}
        title={t('confirmTitle', { chatId: short })} description={t('confirmBody')}
        footer={(
          <>
            <Button variant="outline" data-modal-autofocus onClick={() => { setConfirming(false) }}>{t('cancel')}</Button>
            <Button variant="primary" onClick={() => {
              setConfirming(false)
              run(purge, closeTab)
            }}>{t('delete')}</Button>
          </>
        )} />
    </section>
  )
}

/**
 * Render the detail tab of the chat its address names.
 * @param props - the data-source factory, commands, the tab-info hook, and copy.
 * @returns the detail body.
 */
export function ChatDetail({ useTabInfo, sourceFor, close, purge, t }: ChatDetailProps): ReactNode {
  const { tab } = useTabInfo()
  const chatId = parseChatAddress(tab.contentId)
  if (chatId === undefined) {
    return <section style={styles.root}><p role="alert" style={styles.error}>{t('goneTitle')}</p></section>
  }
  return <ChatDetailView key={chatId} chatId={chatId} source={sourceFor(chatId)} close={close} purge={purge}
    closeTab={() => { tab.actions.close() }} t={t} />
}

/**
 * Chip title of a detail tab: the chat's label, else its short id.
 * @param props - the data-source factory and the tab-info hook.
 * @returns the title text.
 */
export function ChatDetailTitle({ useTabInfo, sourceFor }: Pick<ChatDetailProps, 'useTabInfo' | 'sourceFor'>): ReactNode {
  const { tab } = useTabInfo()
  const chatId = parseChatAddress(tab.contentId)
  if (chatId === undefined) return tab.contentId
  return <ChatDetailTitleText chatId={chatId} source={sourceFor(chatId)} />
}

function ChatDetailTitleText({ chatId, source }: { readonly chatId: string; readonly source: DetailSource }): ReactNode {
  const label = useSyncExternalStore(source.subscribe, () => source.getSnapshot().chat?.label)
  return label ?? shortChatId(chatId)
}
