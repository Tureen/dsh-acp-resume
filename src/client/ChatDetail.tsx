/**
 * The chat detail tab body (D18, PANEL-DESIGN §2.6; D30 density pass). One
 * header line: the state dot, the chat's name (label, else first-turn title,
 * else short id — as in the list), and a "⋯" menu with "release process" and
 * "delete record…" (release asks first while a turn is in flight; delete
 * always asks and closes the tab). One quiet meta line under it:
 * `backend · N turns · last active` (the backend only with several
 * backends), replaced while a turn runs by `backend · running 1m20s`, ticking
 * each second. The full chatId, cwd, remote session id, and state sit in the
 * name's hover text; the meta line ends with the cwd's last segment. The
 * history is a borderless list, newest first, rows split by a divider: a
 * running entry on top (spinner, the sent message's first two lines,
 * expandable), then turns as a question preview (primary colour, up to two
 * lines, relative time at the end, a stop-reason tag when not completed, a
 * fresh-session tag) and an answer preview (secondary colour, up to three
 * lines, "full text · N lines" when cut). A turn that ended in error carries a
 * red left rail; one that stopped short or was answered by a fresh session an
 * orange one. Reconnect events are one line on a warning rail. A click on a turn
 * toggles it, and only one turn is open at a time; an open turn shows the full
 * message and answer in scrollable regions, the diagnostic behind its own
 * toggle, and a collapse button. The full text is fetched on demand when a
 * preview is cut; expansion and fetched text live in component state only.
 * Pure props: data arrives through a per-chat {@link DetailSource}, commands
 * through injected callbacks, copy through `t`. Styling uses only
 * `--dsw-alias-*` variables and ui-primitives components.
 * @module dsh-acp-resume/client/ChatDetail
 */

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { Button, Menu, Modal, Tag, type MenuEntry, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import { detailPreview, DetailMarkdown } from './detail-markdown.tsx'
import { DisclosureRow, PanelCard, MarkdownCompactStyle, cleanPreview, useClipboardCopy } from './panel-chrome.tsx'
import { formatTurnTime, formatTurnTimeTitle } from './panel-time.ts'
import type { FollowTurn, LiveView } from './live-source.ts'
import { panelActionError } from './chats-source.ts'
import { PanelFeatureGate } from './PanelFeatureGate.tsx'
import { parseChatAddress } from './chat-address.ts'
import { ChatStateDot, chatDotState, LiveElapsed, shortChatId } from './ChatsPanel.tsx'
import type { ChatDetailInjected, DetailSource, EventItem, FullEntry, PanelChat, RunningItem, TabInfoHook, TurnItem } from './face.ts'
import type { PanelCopyKey, PanelTranslate } from './locales.ts'

/** The detail body's props: the injected face plus the framework's tab-info hook and the locale seat. */
export type ChatDetailProps = ChatDetailInjected & {
  readonly useTabInfo: TabInfoHook
  readonly t: PanelTranslate
}

const ROW_DIVIDER = '1px solid var(--dsw-alias-border-l3)'

const styles = {
  root: { display: 'flex', flexDirection: 'column', gap: 12, padding: 16, height: '100%', overflowY: 'auto', boxSizing: 'border-box', background: 'var(--dsw-alias-bg-layer-1)' },

  // Header: the identity line, with the actions menu at its end.
  header: { display: 'flex', alignItems: 'center', gap: 8 },
  identity: { flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 },
  heading: { minWidth: 0, margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  meta: { display: 'flex', alignItems: 'center', gap: 6, margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },

  error: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' },
  notice: { margin: 0, fontSize: 13, color: 'var(--dsw-alias-label-secondary)' },
  empty: { margin: 0, fontSize: 13, color: 'var(--dsw-alias-label-tertiary)' },
  subheading: { margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
  sectionCount: { fontSize: 12, fontWeight: 400, color: 'var(--dsw-alias-label-tertiary)' },

  sticky: { position: 'sticky', top: 0, zIndex: 1, background: 'var(--dsw-alias-bg-layer-1)', paddingBlock: 6 },
  list: { display: 'flex', flexDirection: 'column', gap: 10, margin: 0, padding: 0, listStyle: 'none' },
  row: { display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px' },
  bubble: { background: 'var(--dsw-specific-bubble)', padding: 8, borderRadius: 8, minWidth: 0 },
  rowHead: { display: 'flex', flexDirection: 'column', gap: 2, cursor: 'pointer', borderRadius: 6, padding: '2px 4px', margin: '-2px -4px' },
  // Previews keep their line breaks and clamp to 2 (question) / 3 (answer) lines.
  question: { flex: 1, minWidth: 0, margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)', whiteSpace: 'pre-line', overflowWrap: 'anywhere', overflow: 'hidden', display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2 },
  answer: { flex: 1, minWidth: 0, margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'pre-line', overflowWrap: 'anywhere', overflow: 'hidden', display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 3 },
  line: { display: 'flex', alignItems: 'flex-start', gap: 6, minWidth: 0 },
  aside: { flex: 'none', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },

  full: { margin: 0, maxHeight: 320, overflow: 'auto', padding: 10, borderRadius: 8, fontSize: 12, lineHeight: 1.6, fontFamily: 'var(--dsw-font-family-mono, ui-monospace, monospace)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l4)' },
  linkButton: { alignSelf: 'flex-start', padding: 0, border: 0, background: 'transparent', color: 'var(--dsw-alias-label-tertiary)', cursor: 'pointer', fontSize: 11 },
  diag: { margin: 0, padding: 8, borderRadius: 6, fontSize: 11, lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent)', color: 'var(--dsw-alias-state-error-primary)' },

  // Reconnect event: one line on a warning rail.
  event: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderLeft: '3px solid var(--dsw-alias-state-warn-primary)', borderBottom: ROW_DIVIDER },
  eventText: { flex: 1, minWidth: 0, margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' },

  loadMoreWrap: { display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' },
  centered: { display: 'flex', flexDirection: 'column', gap: 8, padding: '32px 8px', textAlign: 'center', alignItems: 'center' },
} satisfies Record<string, CSSProperties>

function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Non-empty line count of a body (0 when blank). */
function countLines(text: string): number {
  return text.split('\n').filter(line => line.trim() !== '').length
}

/** Lines shown in a collapsed preview. */
const QUESTION_LINES = 2
const ANSWER_LINES = 3

/** The rail of a turn: red for an error, orange for a stop short of completion or a fresh-session answer, none otherwise. */
function turnRail(item: TurnItem): 'error' | 'warn' | undefined {
  if (item.stopReason === 'error') return 'error'
  if (item.stopReason !== 'completed' || item.freshSession) return 'warn'
  return undefined
}

/** Last path segment of a cwd (`/a/b/repo` → `repo`); the root stays `/`. */
export function cwdName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(part => part !== '')
  return parts.at(-1) ?? cwd
}

/** The stop reason's localized label and tag tone, for a turn that did not end `completed`. */
function stopTag(stopReason: string): { key: PanelCopyKey; tone: TagTone } | undefined {
  switch (stopReason) {
    case 'aborted': return { key: 'stopAborted', tone: 'neutral' }
    case 'error': return { key: 'stopError', tone: 'danger' }
    case 'max-tokens': return { key: 'stopMaxTokens', tone: 'warning' }
    case 'refusal': return { key: 'stopRefusal', tone: 'warning' }
    default: return undefined
  }
}

/** The chat's display name: label, else first-turn title, else short id (as the list row). */
function chatName(chat: PanelChat | undefined, chatId: string): string {
  return chat?.label ?? chat?.title ?? shortChatId(chatId)
}

/** The name's hover text: full chat id, cwd, full remote session id, and state. */
function identityHint(t: PanelTranslate, chat: PanelChat | undefined, chatId: string): string {
  if (chat === undefined) return chatId
  return [chatId, t('cwd', { cwd: chat.cwd }), t('remote', { id: chat.remoteSessionId }), chat.active ? t('active') : t('released')].join('\n')
}

/** Toggle on click, Enter, or Space: the row-as-button contract. */
function pressable(onPress: () => void) {
  return {
    role: 'button',
    tabIndex: 0,
    onClick: onPress,
    onKeyDown: (event: { key: string; preventDefault(): void }) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onPress() }
    },
  } as const
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
  const [diagOpen, setDiagOpen] = useState(false)
  const fullEntry = full?.status === 'ready' && full.entry.kind === 'turn' ? full.entry : undefined
  const message = fullEntry?.message ?? item.message
  const output = fullEntry?.output ?? item.output
  const tag = item.stopReason === 'completed' ? undefined : stopTag(item.stopReason)
  const question = detailPreview(item.message, QUESTION_LINES)
  const answer = item.output === '' ? { text: t('noAnswer'), clipped: false } : detailPreview(item.output, ANSWER_LINES)
  const rail = turnRail(item)
  const promptCopy = useClipboardCopy(message)
  const replyCopy = useClipboardCopy(output)
  // "Full text · N lines" only when the two lines do not already show everything.
  const truncated = question.clipped || answer.clipped || item.messageMore || item.outputMore
  const lines = (item as TurnItem & { outputLines?: number }).outputLines ?? (fullEntry || (!item.outputMore && !item.messageMore) ? countLines(output) : undefined)
  const toggle = (): void => { onToggle(item) }
  return (
    <li data-seq={item.seq} data-open={open ? '' : undefined} data-rail={rail}>
      <PanelCard rail={rail} style={styles.row}>
        <div style={styles.rowHead} {...pressable(toggle)} aria-expanded={open} aria-label={t('turnToggle', { seq: item.seq })} data-turn-head="">
          <div style={{ ...styles.line, alignItems: 'center' }}>
            <strong>#{item.seq}</strong>
            {tag ? <Tag tone={tag.tone}>{t(tag.key)}</Tag> : item.stopReason !== 'completed' && <Tag tone="neutral">{item.stopReason}</Tag>}
            {item.freshSession && <Tag tone="info">{t('freshBadge')}</Tag>}
            <span style={{ ...styles.aside, marginLeft: 'auto' }} title={formatTurnTimeTitle(t, item, now)}>{formatTurnTime(t, item, now)}</span>
            <span aria-hidden="true">{open ? '⌃' : '⌄'}</span>
          </div>
          {!open && <>
            <div style={styles.bubble}><p style={styles.question} data-question>{question.text}</p></div>
            <p style={styles.answer} data-answer>{answer.text}</p>
            {truncated && <span style={styles.aside} data-full-hint>{lines ? t('fullLines', { lines }) : t('detailExpandFull')}</span>}
          </>}
        </div>
        {open && <>
          <div style={styles.bubble}>
            <div style={styles.line}>{t('detailPrompt')} <Button variant="ghost" size="sm" disabled={item.messageMore && !fullEntry} onClick={promptCopy.onCopy}>{t(promptCopy.copied ? 'copiedText' : 'copyText')}</Button></div>
            <div style={{ maxHeight: 160, overflowY: 'auto' }} data-full="message"><DetailMarkdown text={message} t={t} /></div>
          </div>
          <div style={styles.line}>{t('detailReply')} <Button variant="ghost" size="sm" disabled={item.outputMore && !fullEntry} onClick={replyCopy.onCopy}>{t(replyCopy.copied ? 'copiedText' : 'copyText')}</Button></div>
          <div data-full="output"><DetailMarkdown text={output || t('noAnswer')} t={t} /></div>
          {full?.status === 'loading' && <p style={styles.notice}>{t('loadingFull')}</p>}
          {full?.status === 'error' && <p role="alert" style={styles.error}>{t('fullFailed', { message: full.message })}</p>}
          {item.diagnostic !== undefined && <DisclosureRow icon={null} expandable open={diagOpen}
            title={t(diagOpen ? 'hideDiagnostic' : 'showDiagnostic')} onToggle={() => setDiagOpen(v => !v)}>
            <p style={styles.diag} data-diagnostic>{item.diagnostic}</p>
          </DisclosureRow>}
          <Button variant="ghost" size="sm" aria-label={t('turnCollapse', { seq: item.seq })} onClick={toggle}>{t('collapseFull')}</Button>
        </>}
      </PanelCard>
    </li>
  )
}

function LiveOutput({ chatId, startedAt, follow, signal, t }: { signal?: AbortSignal; chatId: string; startedAt: number; follow: FollowTurn; t: PanelTranslate }) {
  const [frame, setFrame] = useState<LiveView>()
  const box = useRef<HTMLPreElement>(null)
  const following = useRef(true)
  useEffect(() => {
    if (signal?.aborted) return
    const stop = follow(chatId, startedAt, setFrame)
    signal?.addEventListener('abort', stop, { once: true })
    return () => { signal?.removeEventListener('abort', stop); stop() }
  }, [follow, chatId, startedAt, signal])
  useLayoutEffect(() => {
    if (box.current && following.current) box.current.scrollTop = box.current.scrollHeight
  }, [frame])
  if (frame?.kind === 'settled') return null
  if (frame?.kind === 'error') return <p role="status">{t('liveError')}</p>
  if (!frame?.text) return <p>{t('liveWaiting')}</p>
  return <div>
    <p>{t('liveOutput')}{frame.truncated ? ' · ' + t('liveTail') : ''}</p>
    <pre ref={box} style={{ ...styles.full, maxHeight: 240, overflowY: 'auto' }} data-live-output
      onScroll={event => {
        const el = event.currentTarget
        following.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 2
      }}>{frame.text}</pre>
  </div>
}

function RunningRow({ item, now, t, chatId, follow, signal }: { signal?: AbortSignal; item: RunningItem; now: number; t: PanelTranslate; chatId: string; follow?: FollowTurn }): ReactNode {
  const [open, setOpen] = useState(false)
  const sent = detailPreview(item.message, QUESTION_LINES)
  const toggle = (): void => setOpen(value => !value)
  return (
    <li style={styles.row} data-running>
      <div style={styles.rowHead} {...pressable(toggle)} aria-expanded={open} aria-label={t(open ? 'runningCollapse' : 'runningExpand')}>
        <div style={styles.line}>
          <ChatStateDot state="ongoing" />
          <p style={styles.question} data-running-preview>{sent.text}</p>
          <span title={formatTurnTimeTitle(t, item, now)}><LiveElapsed startedAt={item.startedAt} now={now} t={t} /></span>
          {follow ? <span style={styles.aside} aria-hidden="true">{t('liveOutput')} {open ? '▴' : '▾'}</span> : null}
        </div>
      </div>
      {open && sent.clipped ? <div data-running-full><DetailMarkdown text={item.message} t={t} /></div> : null}
      {open && follow ? <LiveOutput signal={signal} chatId={chatId} startedAt={item.startedAt} follow={follow} t={t} /> : null}
    </li>
  )
}

function EventRow({ item, now, t }: { readonly item: EventItem; readonly now: number; readonly t: PanelTranslate }): ReactNode {
  const text = item.event === 'session-lost'
    ? t('eventSessionLost')
    : item.event === 'session-reset-after-errors'
      ? t('eventSessionResetAfterErrors')
      : `${t('eventReconnectFailed', { error: item.error ?? '' })}${item.message === undefined ? '' : ` · ${t('failedMessage', { message: cleanPreview(item.message, { maxLines: 2 }) })}`}`
  return (
    <li data-seq={item.seq} data-event={item.event}><PanelCard rail={item.event === 'reconnect-failed' ? 'error' : 'warn'} style={styles.line}>
      <p style={styles.eventText}>{text}</p>
      <span style={styles.aside} title={formatTurnTimeTitle(t, item, now)}>{formatTurnTime(t, item, now)}</span>
    </PanelCard></li>
  )
}

/** The header's "⋯" menu: release the process, then (after a separator) delete the record. */
function ActionsMenu({ canRelease, disabled, onRelease, onDelete, t }: {
  readonly canRelease: boolean
  readonly disabled: boolean
  readonly onRelease: () => void
  readonly onDelete: () => void
  readonly t: PanelTranslate
}): ReactNode {
  const [open, setOpen] = useState(false)
  const items: MenuEntry[] = [
    { id: 'release', label: t('releaseProcess'), disabled: !canRelease },
    { type: 'separator', id: 'sep' },
    { id: 'delete', label: t('deleteRecord'), danger: true },
  ]
  return (
    <Menu open={open} onClose={() => { setOpen(false) }} align="end" items={items}
      onSelect={(id) => {
        setOpen(false)
        if (id === 'release') onRelease()
        else if (id === 'delete') onDelete()
      }}
      anchor={(
        <Button size="sm" variant="ghost" disabled={disabled} aria-label={t('moreActions')} aria-haspopup="menu" aria-expanded={open}
          onClick={() => { setOpen(value => !value) }}>⋯</Button>
      )} />
  )
}

interface ViewProps {
  readonly tabSignal?: AbortSignal
  readonly follow?: FollowTurn
  readonly chatId: string
  readonly source: DetailSource
  readonly close: (chatId: string) => Promise<void>
  readonly purge: (chatId: string) => Promise<void>
  readonly closeTab: () => void
  readonly t: PanelTranslate
}

function ChatDetailView({ chatId, source, close, purge, closeTab, follow, tabSignal, t }: ViewProps): ReactNode {
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot)
  // One open turn at a time.
  const [openSeq, setOpenSeq] = useState<number | undefined>(undefined)
  const [fulls, setFulls] = useState<Readonly<Record<number, FullState>>>({})
  const [pending, setPending] = useState(false)
  const [confirming, setConfirming] = useState<'delete' | 'release' | undefined>(undefined)
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
    const opening = openSeq !== item.seq
    setOpenSeq(opening ? item.seq : undefined)
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
      (error: unknown) => { setActionError(panelActionError(error, t)) },
    ).finally(() => { setPending(false) })
  }

  const chat = snapshot.chat
  const now = snapshot.fetchedAt ?? 0
  const running = snapshot.entries.find((item): item is RunningItem => item.kind === 'running')
  const newestFirst = snapshot.entries.filter((item): item is TurnItem | EventItem => item.kind !== 'running').reverse()
  const inFlightSince = running?.startedAt ?? chat?.inFlight?.startedAt
  const backend = chat !== undefined && (chat.backendCount ?? 1) > 1 && chat.backend !== undefined ? (chat.backendDisplay ?? chat.backend) : undefined
  const turns = chat?.turnCount === undefined ? t('noValue') : String(chat.turnCount)
  return (
    <section style={styles.root} aria-label={t('viewDetail', { chatId: short })} data-chat-id={chatId}>
      <MarkdownCompactStyle />
      <header style={styles.sticky}>
        <div style={styles.header}>
          <div style={styles.identity}>
            {chat === undefined ? null : <ChatStateDot state={chatDotState(chat, running !== undefined)} />}
            <h2 style={styles.heading} title={identityHint(t, chat, chatId)}>{chatName(chat, chatId)}</h2>
          </div>
          <ActionsMenu t={t} disabled={pending || chat === undefined} canRelease={chat?.active === true}
            onRelease={() => {
              // Releasing cancels an in-flight turn: ask first. An idle chat releases at once.
              if (inFlightSince === undefined) run(close)
              else setConfirming('release')
            }}
            onDelete={() => { setConfirming('delete') }} />
        </div>
        {chat === undefined
          ? (snapshot.status === 'loading' ? <p style={styles.notice}>{t('loading')}</p> : null)
          : (
            <p style={styles.meta} title={formatTurnTimeTitle(t, inFlightSince === undefined ? { at: chat.lastActive } : { startedAt: inFlightSince }, now)} data-meta>
              {inFlightSince === undefined
                ? [...(backend === undefined ? [] : [backend]), t('turns', { count: turns }), formatTurnTime(t, { at: chat.lastActive }, now), cwdName(chat.cwd)].join(' · ')
                : <>{backend === undefined ? null : `${backend} · `}<LiveElapsed startedAt={inFlightSince} now={now} t={t} label="inFlightFor" />{` · ${cwdName(chat.cwd)}`}</>}
            </p>
          )}
      </header>
      {snapshot.status === 'error' && snapshot.error !== undefined
        ? <p role="alert" style={styles.error}>{t('loadFailed', { message: snapshot.error })}</p>
        : null}
      {actionError === undefined ? null : <p role="alert" style={styles.error}>{actionError}</p>}
      <h3 style={styles.subheading}>{t('turnsHeading')}</h3>
      {snapshot.status !== 'loading' && running === undefined && newestFirst.length === 0 ? <p style={styles.empty}>{t('noTurns')}</p> : null}
      {running === undefined && newestFirst.length === 0 ? null : (
        <ul style={styles.list}>
          {running === undefined ? null : <RunningRow key={running.startedAt} chatId={chatId} signal={tabSignal} follow={follow} item={running} now={now} t={t} />}
          {newestFirst.map(item => item.kind === 'event'
            ? <EventRow key={item.seq} item={item} now={now} t={t} />
            : <TurnRow key={item.seq} item={item} now={now} open={openSeq === item.seq} full={fulls[item.seq]} onToggle={toggle} t={t} />)}
        </ul>
      )}
      {snapshot.total > newestFirst.length ? (
        <div style={styles.loadMoreWrap}>
          <span style={styles.sectionCount}>{t('shownOf', { shown: newestFirst.length, total: snapshot.total })}</span>
          <Button size="sm" variant="ghost" onClick={() => { void source.loadMore() }}>{t('loadMore')}</Button>
        </div>
      ) : null}
      <Modal open={confirming !== undefined} onClose={() => { setConfirming(undefined) }} closeLabel={t('dismiss')}
        title={t(confirming === 'release' ? 'releaseConfirmTitle' : 'confirmTitle', { chatId: short })}
        description={t(confirming === 'release' ? 'releaseConfirmBody' : 'confirmBody')}
        footer={(
          <>
            <Button variant="outline" data-modal-autofocus onClick={() => { setConfirming(undefined) }}>{t('cancel')}</Button>
            <Button variant="primary" onClick={() => {
              const kind = confirming
              setConfirming(undefined)
              if (kind === 'release') run(close)
              else run(purge, closeTab)
            }}>{t(confirming === 'release' ? 'release' : 'delete')}</Button>
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
export function ChatDetail({ useTabInfo, features, sourceFor, close, purge, followTurn, t }: ChatDetailProps): ReactNode {
  const { tab } = useTabInfo()
  const chatId = parseChatAddress(tab.contentId)
  if (chatId === undefined) {
    return <section style={styles.root}><p role="alert" style={styles.error}>{t('goneTitle')}</p></section>
  }
  return <PanelFeatureGate source={features} t={t}>{() =>
    <ChatDetailView key={chatId} chatId={chatId} source={sourceFor(chatId)} tabSignal={tab.signal} follow={tab.visible === false ? undefined : followTurn} close={close} purge={purge}
      closeTab={() => { tab.actions.close() }} t={t} />
  }</PanelFeatureGate>
}

/**
 * Chip title of a detail tab: the chat's label, else its short id.
 * @param props - the data-source factory and the tab-info hook.
 * @returns the title text.
 */
export function ChatDetailTitle({ useTabInfo, sourceFor, features }: Pick<ChatDetailProps, 'useTabInfo' | 'sourceFor' | 'features'>): ReactNode {
  const { tab } = useTabInfo()
  const chatId = parseChatAddress(tab.contentId)
  if (chatId === undefined) return tab.contentId
  return <PanelFeatureGate source={features} fallback={shortChatId(chatId)}>{() =>
    <ChatDetailTitleText chatId={chatId} source={sourceFor(chatId)} />
  }</PanelFeatureGate>
}

function ChatDetailTitleText({ chatId, source }: { readonly chatId: string; readonly source: DetailSource }): ReactNode {
  const label = useSyncExternalStore(source.subscribe, () => source.getSnapshot().chat?.label)
  return label ?? shortChatId(chatId)
}
