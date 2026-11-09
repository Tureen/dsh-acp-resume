/**
 * The chat detail tab body (D18, PANEL-DESIGN §2.6). Three zones with their
 * own visual weight: a header (the chat's identity — a state dot and its label
 * or short id — as the one primary line, with the refresh/release/delete
 * controls), a quiet meta strip (state, turn count, cwd, remote id, first-turn
 * title) that recedes behind the header, and the turn history as one card per
 * entry, newest first, spaced apart. Each turn card shows the question and
 * answer as the subject (first non-empty line as a preview) with seq, stop
 * reason, and time demoted to a meta row. Expanding sits on the reading line:
 * the primary control is a full-width button at the card's tail ("expand full
 * text · N lines", becoming "collapse" once open), and the whole header row is
 * also clickable (a pointer cursor and a hover tint are its only cue — there is
 * no corner chevron). Expanding reveals the full message and answer in
 * scrollable regions that keep their line breaks, and the diagnostic sits
 * behind its own toggle. Reconnect events are set apart from turns by a
 * tinted left rail and a "connection" tag. The full text is fetched on demand
 * when a preview is cut; expansion and fetched text live in component state
 * only. Pure props: data arrives through a per-chat {@link DetailSource},
 * commands through injected callbacks, copy through `t`. Styling uses only
 * `--dsw-alias-*` variables and ui-primitives components.
 * @module dsh-acp-resume/client/ChatDetail
 */

import { useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { Button, Modal, StateDot, Tag, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import { parseChatAddress } from './chat-address.ts'
import { relativeTime, shortChatId } from './ChatsPanel.tsx'
import type { ChatDetailInjected, DetailSource, EventItem, FullEntry, TabInfoHook, TurnItem } from './face.ts'
import type { PanelCopyKey, PanelTranslate } from './locales.ts'

/** The detail body's props: the injected face plus the framework's tab-info hook and the locale seat. */
export type ChatDetailProps = ChatDetailInjected & {
  readonly useTabInfo: TabInfoHook
  readonly t: PanelTranslate
}

const styles = {
  root: { display: 'flex', flexDirection: 'column', gap: 16, padding: 16, height: '100%', overflowY: 'auto', boxSizing: 'border-box', background: 'var(--dsw-alias-bg-layer-1)' },

  // Zone 1: header. The identity line is the single primary element.
  header: { display: 'flex', alignItems: 'center', gap: 8 },
  identity: { flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 },
  heading: { minWidth: 0, margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  headingId: { flex: 'none', fontSize: 12, fontWeight: 400, color: 'var(--dsw-alias-label-tertiary)' },

  // Zone 2: meta strip. One or two quiet lines, clearly secondary.
  metaStrip: { display: 'flex', flexDirection: 'column', gap: 4 },
  metaRow: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
  metaSep: { color: 'var(--dsw-alias-border-l3)' },
  metaTitle: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },

  error: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' },
  notice: { margin: 0, fontSize: 13, color: 'var(--dsw-alias-label-secondary)' },

  // Zone 3: turn history.
  sectionHead: { display: 'flex', alignItems: 'baseline', gap: 8, margin: 0 },
  subheading: { margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
  sectionCount: { fontSize: 12, fontWeight: 400, color: 'var(--dsw-alias-label-tertiary)' },
  list: { display: 'flex', flexDirection: 'column', gap: 10, margin: 0, padding: 0, listStyle: 'none' },

  turn: { display: 'flex', flexDirection: 'column', gap: 8, padding: 12, borderRadius: 12, border: '1px solid var(--dsw-alias-border-l3)', background: 'var(--dsw-alias-bg-layer-2)' },
  // Clickable header row; its pointer cursor and hover tint are the only
  // clickability cue (no corner chevron — the bottom button is the primary one).
  turnTop: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', borderRadius: 6, padding: '2px 4px', margin: '-2px -4px', transition: 'background 100ms ease' },
  turnTopHover: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', borderRadius: 6, padding: '2px 4px', margin: '-2px -4px', transition: 'background 100ms ease', background: 'var(--dsw-alias-interactive-bg-hover)' },
  turnTags: { flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  turnSeq: { fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-label-tertiary)' },
  turnTime: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },

  qa: { display: 'flex', flexDirection: 'column', gap: 6 },
  qaBlock: { display: 'flex', flexDirection: 'column', gap: 2 },
  qaLabel: { fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-label-tertiary)', textTransform: 'uppercase', letterSpacing: '0.04em' },
  qaPreview: { margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  qaAnswerPreview: { margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  // The primary expand/collapse entry: a full-width button at the reading tail.
  expandButton: { alignSelf: 'stretch', marginTop: 2, padding: '6px 8px', border: '1px solid var(--dsw-alias-border-l4)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', fontSize: 12, fontWeight: 500, textAlign: 'center' },

  full: { margin: 0, maxHeight: 320, overflow: 'auto', padding: 10, borderRadius: 8, fontSize: 12, lineHeight: 1.6, fontFamily: 'var(--dsw-font-family-mono, ui-monospace, monospace)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l4)' },
  diagToggle: { alignSelf: 'flex-start', padding: 0, border: 0, background: 'transparent', color: 'var(--dsw-alias-label-tertiary)', cursor: 'pointer', fontSize: 11 },
  diag: { margin: 0, padding: 8, borderRadius: 6, fontSize: 11, lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent)', color: 'var(--dsw-alias-state-error-primary)' },

  // Reconnect event: set apart from turns by a tinted left rail.
  event: { display: 'flex', flexDirection: 'column', gap: 4, margin: 0, padding: '8px 10px', borderRadius: 8, borderLeft: '3px solid var(--dsw-alias-state-warn-primary)', background: 'var(--dsw-alias-bg-layer-2)' },
  eventTop: { display: 'flex', alignItems: 'center', gap: 6 },
  eventTime: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },
  eventText: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' },

  loadMoreWrap: { display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' },
  centered: { display: 'flex', flexDirection: 'column', gap: 8, padding: '32px 8px', textAlign: 'center', alignItems: 'center' },
} satisfies Record<string, CSSProperties>

function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Non-empty line count of a body, for the expand button's hint (0 when blank). */
function countLines(text: string): number {
  return text.split('\n').filter(line => line.trim() !== '').length
}

/** First non-empty line, trimmed and cut to `max` characters with an ellipsis. */
function firstLine(text: string, max = 100): { text: string; clipped: boolean } {
  const line = text.split('\n').map(l => l.trim()).find(l => l !== '') ?? ''
  const chars = Array.from(line)
  const multiline = text.split('\n').some(l => l.trim() !== '') && text.trim() !== line
  if (chars.length > max) return { text: `${chars.slice(0, max).join('')}…`, clipped: true }
  return { text: line, clipped: multiline }
}

/** The stop reason's localized label and the tag tone that carries its status meaning. */
function stopTag(stopReason: string): { key: PanelCopyKey; tone: TagTone } | undefined {
  switch (stopReason) {
    case 'completed': return { key: 'stopCompleted', tone: 'success' }
    case 'aborted': return { key: 'stopAborted', tone: 'neutral' }
    case 'error': return { key: 'stopError', tone: 'danger' }
    case 'max-tokens': return { key: 'stopMaxTokens', tone: 'warning' }
    case 'refusal': return { key: 'stopRefusal', tone: 'warning' }
    default: return undefined
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

function TurnCard({ item, now, open, full, onToggle, t }: TurnRowProps): ReactNode {
  const [diagOpen, setDiagOpen] = useState(false)
  const [headHover, setHeadHover] = useState(false)
  const fullEntry = full?.status === 'ready' && full.entry.kind === 'turn' ? full.entry : undefined
  const message = fullEntry?.message ?? item.message
  const output = fullEntry?.output ?? item.output
  const tag = stopTag(item.stopReason)
  const questionPreview = firstLine(item.message)
  const answerPreview = item.output === '' ? { text: t('noAnswer'), clipped: false } : firstLine(item.output)
  // A turn is expandable when the collapsed previews do not already show
  // everything: either line is clipped, the host flagged more, or there is no
  // answer text to preview. A fully-shown turn has nothing behind an expand.
  const expandable = questionPreview.clipped || answerPreview.clipped || item.messageMore || item.outputMore || item.output === ''
  // Line count of the longer body, for the bottom button's hint.
  const bodyLines = Math.max(countLines(message), countLines(output))
  const toggle = (): void => { onToggle(item) }
  return (
    <li style={styles.turn} data-seq={item.seq} data-open={open ? '' : undefined}>
      {/* The whole header row toggles the turn; the chevron is a visual cue only. */}
      <div
        style={headHover ? styles.turnTopHover : styles.turnTop}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={t('turnToggle', { seq: item.seq })}
        data-turn-head=""
        onClick={toggle}
        onMouseEnter={() => { setHeadHover(true) }}
        onMouseLeave={() => { setHeadHover(false) }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle() }
        }}
      >
        <div style={styles.turnTags}>
          <span style={styles.turnSeq}>#{item.seq}</span>
          {tag === undefined ? <Tag tone="neutral">{item.stopReason}</Tag> : <Tag tone={tag.tone}>{t(tag.key)}</Tag>}
          {item.freshSession ? <Tag tone="info">{t('freshBadge')}</Tag> : null}
          <span style={styles.turnTime}>{relativeTime(t, item.at, now)}</span>
        </div>
      </div>
      {open ? (
        <div style={styles.qa}>
          <div style={styles.qaBlock}>
            <span style={styles.qaLabel}>{t('question')}</span>
            <pre style={styles.full} data-full="message">{message}</pre>
          </div>
          <div style={styles.qaBlock}>
            <span style={styles.qaLabel}>{t('answer')}</span>
            <pre style={styles.full} data-full="output">{output === '' ? t('noAnswer') : output}</pre>
          </div>
          {full?.status === 'loading' ? <p style={styles.notice}>{t('loadingFull')}</p> : null}
          {full?.status === 'error' ? <p role="alert" style={styles.error}>{t('fullFailed', { message: full.message })}</p> : null}
          {item.diagnostic === undefined ? null : (
            <>
              <button type="button" style={styles.diagToggle} aria-expanded={diagOpen}
                onClick={() => { setDiagOpen(v => !v) }}>{t(diagOpen ? 'hideDiagnostic' : 'showDiagnostic')}</button>
              {diagOpen ? <p style={styles.diag} data-diagnostic>{item.diagnostic}</p> : null}
            </>
          )}
          {/* Collapse at the reading tail: the natural place after reading the full text. */}
          <button type="button" style={styles.expandButton} aria-expanded data-turn-foot=""
            aria-label={t('turnCollapse', { seq: item.seq })} onClick={toggle}>{t('collapseFull')}</button>
        </div>
      ) : (
        <div style={styles.qa}>
          <div style={styles.qaBlock}>
            <span style={styles.qaLabel}>{t('question')}</span>
            <p style={styles.qaPreview}>{questionPreview.text}</p>
          </div>
          <div style={styles.qaBlock}>
            <span style={styles.qaLabel}>{t('answer')}</span>
            <p style={styles.qaAnswerPreview}>{answerPreview.text}</p>
          </div>
          {/* The primary expand entry: a real button on the reading-line end. */}
          {expandable ? (
            <button type="button" style={styles.expandButton} aria-expanded={false} data-turn-foot=""
              aria-label={t('turnExpand', { seq: item.seq })} onClick={toggle}>
              {bodyLines > 1 ? t('expandFullLines', { lines: bodyLines }) : t('expandFull')}
            </button>
          ) : null}
        </div>
      )}
    </li>
  )
}

function EventCard({ item, now, t }: { readonly item: EventItem; readonly now: number; readonly t: PanelTranslate }): ReactNode {
  const text = item.event === 'session-lost'
    ? t('eventSessionLost')
    : item.event === 'session-reset-after-errors'
      ? t('eventSessionResetAfterErrors')
      : `${t('eventReconnectFailed', { error: item.error ?? '' })}${item.message === undefined ? '' : ` · ${t('failedMessage', { message: item.message })}`}`
  return (
    <li style={styles.event} data-seq={item.seq} data-event={item.event}>
      <div style={styles.eventTop}>
        <Tag tone="warning">{t('eventBadge')}</Tag>
        <span style={styles.eventTime}>{relativeTime(t, item.at, now)}</span>
      </div>
      <p style={styles.eventText}>{text}</p>
    </li>
  )
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
          <p style={styles.subheading}>{t('goneTitle')}</p>
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
  const sep = <span style={styles.metaSep} aria-hidden="true">·</span>
  return (
    <section style={styles.root} aria-label={t('viewDetail', { chatId: short })} data-chat-id={chatId}>
      <div style={styles.header}>
        <div style={styles.identity}>
          {chat === undefined ? null : <StateDot state={chat.active ? 'done' : 'idle'} />}
          <h2 style={styles.heading} title={chatId}>{chat?.label ?? short}</h2>
          {chat?.label === undefined ? null : <span style={styles.headingId}>{short}</span>}
        </div>
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
          <div style={styles.metaStrip}>
            <p style={styles.metaRow}>
              <span>{chat.active ? t('active') : t('released')}</span>{sep}
              <span>{t('turns', { count: turns })}</span>{sep}
              <span>{relativeTime(t, chat.lastActive, now)}</span>
            </p>
            <p style={styles.metaRow}>
              <span>{t('cwd', { cwd: chat.cwd })}</span>{sep}
              <span>{t('remote', { id: chat.remoteSessionId.slice(0, 8) })}</span>
            </p>
            {chat.title === undefined ? null : <p style={styles.metaTitle} title={chat.title}>{t('chatTitle', { title: chat.title })}</p>}
          </div>
        )}
      <div style={styles.sectionHead}>
        <h3 style={styles.subheading}>{t('turnsHeading')}</h3>
        {snapshot.entries.length === 0 ? null : <span style={styles.sectionCount}>{t('turns', { count: String(snapshot.total) })}</span>}
      </div>
      {snapshot.status !== 'loading' && newestFirst.length === 0 ? <p style={styles.notice}>{t('noTurns')}</p> : null}
      {newestFirst.length === 0 ? null : (
        <ul style={styles.list}>
          {newestFirst.map(item => item.kind === 'event'
            ? <EventCard key={item.seq} item={item} now={now} t={t} />
            : <TurnCard key={item.seq} item={item} now={now} open={expanded.has(item.seq)} full={fulls[item.seq]} onToggle={toggle} t={t} />)}
        </ul>
      )}
      {snapshot.total > snapshot.entries.length ? (
        <div style={styles.loadMoreWrap}>
          <span style={styles.sectionCount}>{t('shownOf', { shown: snapshot.entries.length, total: snapshot.total })}</span>
          <Button size="sm" variant="ghost" onClick={() => { void source.loadMore() }}>{t('loadMore')}</Button>
        </div>
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
