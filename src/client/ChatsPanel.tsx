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
 * through props, copy through `t`. The backend readiness block is profile-wide
 * and rendered independently of the chat list and its empty states.
 * @module dsh-acp-resume/client/ChatsPanel
 */

import { useCallback, useEffect, useId, useState, useSyncExternalStore, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import {
  Button,
  DisclosureRow,
  IconRefreshOutlineRegular,
  IconSettingsOutlineRegular,
  IconWarningOutlineRegular,
  Modal,
  PanelCard,
  StateDot,
  Tag,
  type RailState,
  type StateDotState,
  type TagTone,
} from './panel-chrome.tsx'
import { formatHybridTime, formatTurnTimeTitle } from './panel-time.ts'
import type { BackendStatus } from '../backend-status.ts'
import { ProfileSettings } from './ProfileSettings.tsx'
import { ChatSettings } from './ChatSettings.tsx'
import { panelActionError } from './chats-source.ts'
import { PanelFeatureGate } from './PanelFeatureGate.tsx'
import type { PanelFeatures } from '../panel-features.ts'
import { chatAddress } from './chat-address.ts'
import type { BackendStatusSourceFace, BackendStatusView, ChatsPanelInjected, ChatsSnapshot, Observable, PanelChat, PanelUsage, PanelWorkflowStep, SelectorHook, TabInfoHook, WorkflowsSnapshot } from './face.ts'
import type { PanelCopyKey, PanelTranslate } from './locales.ts'

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
  backendSection: { flexShrink: 0, overflow: 'hidden' },
  backendHeaderWrap: { padding: '4px 8px' },
  backendSummary: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 },
  visuallyHidden: { position: 'absolute', width: 1, height: 1, padding: 0, overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap' },
  backendContent: { display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 10px 10px', borderTop: '1px solid var(--dsw-alias-border-l2)' },
  backendCard: { display: 'flex', flexDirection: 'column', gap: 5, padding: '8px 10px', overflowWrap: 'anywhere' },
  backendCardHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, minWidth: 0 },
  backendCardIdentity: { display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0, flexWrap: 'wrap' },
  backendName: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
  backendMeta: { display: 'flex', flexWrap: 'wrap', gap: '2px 10px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
  backendDetail: { display: 'flex', flexWrap: 'wrap', gap: '2px 10px', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },
  backendUsageBar: { padding: '6px 10px', borderTop: '1px solid var(--dsw-alias-border-l2)' },
  backendAlertWarn: {
    display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '6px 10px', borderRadius: 8,
    border: '1px solid var(--dsw-alias-state-warn-primary)', borderLeft: '3px solid var(--dsw-alias-state-warn-primary)',
    background: 'var(--dsw-alias-card-fill)', color: 'var(--dsw-alias-label-primary)',
    textAlign: 'left', font: 'inherit', fontSize: 12, cursor: 'pointer', boxSizing: 'border-box',
  },
  backendAlertError: {
    display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '6px 10px', borderRadius: 8,
    border: '1px solid var(--dsw-alias-state-error-primary)', borderLeft: '3px solid var(--dsw-alias-state-error-primary)',
    background: 'var(--dsw-alias-card-fill)', color: 'var(--dsw-alias-state-error-primary)',
    textAlign: 'left', font: 'inherit', fontSize: 12, cursor: 'pointer', boxSizing: 'border-box',
  },
  backendAlertText: { flex: 1, minWidth: 0, overflowWrap: 'anywhere' },
  usage: { display: 'flex', flexDirection: 'column', gap: 2 },
  wfSection: { display: 'flex', flexDirection: 'column', gap: 6 },
  wfHeading: { margin: 0, fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' },
  wfRow: { display: 'flex', flexDirection: 'column', gap: 4, padding: 8, borderRadius: 10, border: '1px solid var(--dsw-alias-border-l3)', background: 'var(--dsw-alias-bg-layer-2)' },
  wfHead: { display: 'flex', alignItems: 'center', gap: 6, padding: 0, border: 0, background: 'transparent', textAlign: 'left', font: 'inherit', cursor: 'pointer', minWidth: 0 },
  wfSteps: { display: 'flex', flexDirection: 'column', gap: 4, margin: 0, paddingLeft: 20, listStyle: 'none' },
  wfStep: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
  wfStepId: { fontWeight: 600 },
  wfMeta: { color: 'var(--dsw-alias-label-tertiary)' },
  wfMember: { display: 'inline-flex', alignItems: 'center', gap: 4 },
  wfMemberButton: { display: 'inline-flex', alignItems: 'center', gap: 4, padding: 0, border: 0, background: 'transparent', font: 'inherit', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', textDecoration: 'underline' },
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
export function LiveElapsed({ startedAt, now, t, label = 'runningFor' }: {
  readonly startedAt: number
  readonly now: number
  readonly t: PanelTranslate
  /** Copy key taking `{duration}`; `runningFor` (`已运行 …`) by default. */
  readonly label?: 'runningFor' | 'inFlightFor'
}): ReactNode {
  const [drift, setDrift] = useState(0)
  useEffect(() => {
    const base = Date.now()
    setDrift(0)
    const timer = setInterval(() => { setDrift(Date.now() - base) }, 1000)
    return () => { clearInterval(timer) }
  }, [now, startedAt])
  return <span style={styles.elapsed} data-elapsed>{t(label, { duration: formatDuration(t, now + drift - startedAt) })}</span>
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
  readonly settings?: ChatsPanelInjected['settings']
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
 * Backend usage lines (D28 / D47): `codex · prolite · 剩 17%` per backend read
 * `ok`, `codex · 额度读取失败` per `error`; `unsupported` backends are hidden.
 * Hover text names the window and hybrid reset time, or the failure.
 */
function UsageLines({ usage, now, t }: { readonly usage: readonly PanelUsage[] | undefined; readonly now: number; readonly t: PanelTranslate }): ReactNode {
  const shown = (usage ?? []).filter(u => u.status !== 'unsupported')
  if (shown.length === 0) return null
  return (
    <div style={styles.usage} data-usage>
      {shown.map((u) => {
        const text = u.status === 'error'
          ? [u.backend, t('usageFailed')].join(' · ')
          : [u.backend, ...(u.plan === undefined ? [] : [u.plan]), ...(u.usedPercent === undefined ? [] : [t('usageRemaining', { percent: u.remainingPercent ?? Math.max(0, Math.round(100 - u.usedPercent)) })])].join(' · ')
        const hint = u.status === 'error'
          ? u.error ?? ''
          : [
              ...(u.usedPercent === undefined || u.windowMins === undefined ? [] : [t('usageWindow', { window: windowLabel(t, u.windowMins), percent: Math.round(u.usedPercent) })]),
              ...(u.resetsAt === undefined ? [] : [t('usageResets', { time: formatHybridTime(t, u.resetsAt * 1000, now) })]),
            ].join(' · ')
        return <p key={u.backend} style={u.status === 'error' ? styles.usageError : styles.countNote} data-usage-backend={u.backend} title={hint}>{text}</p>
      })}
    </div>
  )
}

const COMPATIBILITY_COPY = {
  supported: 'backendSupported', unsupported: 'backendUnsupported', unknown: 'backendUnknown',
  'not-found': 'backendNotFound', custom: 'backendCustom', 'unverified-version': 'backendUnverifiedVersion',
} satisfies Record<BackendStatus['compatibility'], PanelCopyKey>

const READINESS_COPY = {
  ready: 'backendReady', 'needs-configuration': 'backendNeedsConfiguration', 'needs-login': 'backendNeedsLogin',
  unverified: 'backendUnverified', unavailable: 'backendUnavailable',
} satisfies Record<BackendStatus['readiness'], PanelCopyKey>

const READINESS_TONE = {
  ready: 'success', 'needs-configuration': 'warning', 'needs-login': 'warning',
  unverified: 'neutral', unavailable: 'danger',
} satisfies Record<BackendStatus['readiness'], TagTone>

const READINESS_DOT = {
  ready: 'done', 'needs-configuration': 'warning', 'needs-login': 'warning',
  unverified: 'warning', unavailable: 'error',
} satisfies Record<BackendStatus['readiness'], StateDotState>

const READINESS_RAIL = {
  ready: 'none', 'needs-configuration': 'warn', 'needs-login': 'warn',
  unverified: 'warn', unavailable: 'error',
} satisfies Record<BackendStatus['readiness'], RailState>

const REMEDIATION_COPY = {
  'missing-executable': 'backendFixMissing', 'version-unreadable': 'backendFixVersionUnreadable',
  'unsupported-version': 'backendFixUnsupportedVersion', 'unsupported-mode': 'backendFixUnsupportedMode',
  'not-configured': 'backendFixNotConfigured', 'model-required': 'backendFixModel', 'model-override-unavailable': 'backendFixModelOverride', 'custom-unverified': 'backendFixCustom',
  'login-required': 'backendFixLogin', 'handshake-failed': 'backendFixHandshake', 'probe-timeout': 'backendFixTimeout', 'backend-unready': 'backendFixUnready',
} satisfies Record<NonNullable<BackendStatus['reason']>, PanelCopyKey>

const NO_BACKEND_STATUS: Observable<BackendStatusView | undefined> = { getSnapshot: () => undefined, subscribe: () => () => {} }

function copyFor<Key extends string>(map: Record<Key, PanelCopyKey>, key: Key): PanelCopyKey | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined
}

function backendName(t: PanelTranslate, backend: BackendStatus): string {
  return backend.configured && backend.id.toLowerCase() !== backend.label.toLowerCase()
    ? t('backendNameWithId', { name: backend.label, id: backend.id })
    : backend.label
}

/** Format a reported value; an override is shown only alongside conflicting backend evidence. */
function selectionValue(actual: string | undefined, configured: string | undefined, label: string | undefined, t: PanelTranslate): string {
  if (!actual) return t('backendNotReported')
  const value = label && label !== actual ? `${actual} (${label})` : actual
  return configured && configured !== actual ? t('backendSelectionMismatch', { configured, actual: value }) : value
}

function BackendStatusRow({ backend, visibleChats, now, t }: {
  readonly backend: BackendStatus
  readonly visibleChats: readonly PanelChat[]
  readonly now: number
  readonly t: PanelTranslate
}): ReactNode {
  const remediation = backend.reason === undefined ? undefined
    : backend.configured && backend.reason === 'probe-timeout' ? 'backendFixConfiguredTimeout' as const
    : backend.automatic && backend.id === 'agy' && backend.reason === 'login-required' ? 'backendFixAgyLogin' as const
      : backend.reason === 'unsupported-version' && backend.configured ? 'backendFixConfiguredVersion' as const
        : backend.reason === 'unsupported-version' && backend.readiness === 'ready' ? 'backendSelectUnverifiedVersion' as const
          : copyFor(REMEDIATION_COPY, backend.reason)
  const session = backend.report?.source === 'session' ? backend.report : undefined
  const readinessCopy = copyFor(READINESS_COPY, backend.readiness) ?? 'backendUnverified'
  const dot = READINESS_DOT[backend.readiness] ?? 'warning'
  const rail = READINESS_RAIL[backend.readiness] ?? 'warn'
  const tone = READINESS_TONE[backend.readiness] ?? 'neutral'
  return (
    <li>
      <PanelCard rail={rail} style={styles.backendCard} data-backend-id={backend.id}>
        <div style={styles.backendCardHead}>
          <div style={styles.backendCardIdentity}>
            <span data-dot={dot} style={styles.dot}><StateDot state={dot} /></span>
            <strong style={styles.backendName}>{backendName(t, backend)}</strong>
            {backend.configured ? null : <Tag tone="neutral">{t(backend.automatic ? 'backendAutomatic' : 'backendNotConfigured')}</Tag>}
          </div>
          <Tag tone={tone}>{t(readinessCopy)}</Tag>
        </div>
        <div style={styles.backendMeta}>
          <span>{backend.version === undefined ? t('backendVersionUnknown') : t('backendVersion', { version: backend.version })}</span>
          {backend.range === undefined ? null : <span>{t('backendRange', { range: backend.range })}</span>}
        </div>
        <div style={styles.backendMeta}>
          <span>{t('backendModel', { value: selectionValue(backend.report?.model, backend.configuredModel, backend.report?.modelName, t) })}</span>
          <span>{t('backendEffort', { value: selectionValue(backend.report?.effort, backend.configuredEffort, undefined, t) })}</span>
        </div>
        <div style={styles.backendDetail}>
          <span>{t('backendCompatibility', { status: t(copyFor(COMPATIBILITY_COPY, backend.compatibility) ?? 'backendUnknown') })}</span>
          <span>{t('backendReadiness', { status: t(readinessCopy) })}</span>
        </div>
        {session ? (
          <p style={styles.notice} title={formatTurnTimeTitle(t, { at: session.at }, now)}>
            {t(
              visibleChats.some(chat => chat.chatId === session.chatId) ? 'backendReportSession' : 'backendReportTime',
              { chat: session.chatId, time: formatHybridTime(t, session.at, now) },
            )}
          </p>
        ) : backend.report?.source === 'probe' ? <p style={styles.notice}>{t('backendReportProbe')}</p>
          : backend.sessionReporting ? <p style={styles.notice}>{t('backendAfterDispatch')}</p> : null}
        {backend.automatic && backend.readiness === 'ready' ? (
          <p style={styles.notice}>{t(backend.id === 'agy' ? 'backendAutomaticAgyReady' : 'backendAutomaticReady')}</p>
        ) : null}
        {remediation === undefined ? null : <p style={styles.notice}>{t(remediation)}</p>}
      </PanelCard>
    </li>
  )
}

/** Keep one status line visible via DisclosureRow; mount diagnostics only when expanded, with usage in the footer. */
function BackendStatusSection({ source, view, visibleChats, usage, now, expanded, onToggle, t }: {
  readonly visibleChats: readonly PanelChat[]
  readonly source: BackendStatusSourceFace
  readonly view: BackendStatusView
  readonly usage: readonly PanelUsage[] | undefined
  readonly now: number
  readonly expanded: boolean
  readonly onToggle: () => void
  readonly t: PanelTranslate
}): ReactNode {
  const { data, status } = view
  const helpId = useId()
  const checking = view.checking || data?.checking === true
  const startup = status === 'loading' || (checking && data !== undefined && data.backends.length > 0
    && data.backends.every(row => row.reason === 'backend-unready'))
  const selected = data?.backends.find(backend => backend.id === data.defaultBackend)
  const defaultName = selected === undefined ? data?.defaultBackend : backendName(t, selected)
  const readyBackends = data?.dispatchEnabled ? data.backends.filter(backend => backend.readiness === 'ready') : []
  const readyNames = readyBackends.map(backend => backendName(t, backend))
  const onlyAutomaticAgy = readyBackends.length === 1 && readyBackends[0]?.id === 'agy' && readyBackends[0].automatic === true
  const summary = startup || checking ? t('backendSummaryChecking')
    : status === 'unavailable' ? t('backendSummaryUnavailable')
      : view.checkFailed ? t('backendSummaryCheckFailed')
        : status === 'error' ? t('backendSummaryReadFailed')
          : selected !== undefined && selected.readiness !== 'ready' ? t(selected.reason === 'probe-timeout' ? 'backendSummaryTimeout' : 'backendSummaryPinnedUnready', { name: defaultName! })
            : onlyAutomaticAgy ? t('backendAgyHandshakeReady')
              : readyNames.length === 0 ? t('backendSummaryNone')
                : readyNames.length === 1 ? t('backendSummaryOne', { name: readyNames[0]! })
                  : defaultName !== undefined ? t('backendSummaryDefault', { name: defaultName })
                    : t('backendSummaryMany', { count: readyNames.length })
  const headerDot: StateDotState = startup || checking ? 'ongoing'
    : status === 'error' || view.checkFailed || (data !== undefined && !data.dispatchEnabled) ? 'error'
      : status === 'unavailable' ? 'idle'
        : (selected !== undefined && selected.readiness !== 'ready') || onlyAutomaticAgy ? 'warning'
          : readyNames.length > 0 ? 'done' : 'idle'
  const noneVerifiedAfterTimeout = readyNames.length === 0 && data?.backends.some(row => row.reason === 'probe-timeout')
  const checkResult = !view.checkCompleted ? null
    : noneVerifiedAfterTimeout ? t('backendCheckTimeout')
      : readyNames.length === 0 ? t('backendCheckNoneReady')
      : onlyAutomaticAgy ? t('backendAgyHandshakeReady')
        : readyNames.length === 1 ? t('backendCheckReady', { name: readyNames[0]! })
          : t('backendCheckMultipleReady', { names: readyNames.join(t('backendNameSeparator')) })
  const hasUsage = (usage ?? []).some(u => u.status !== 'unsupported')
  const recheckAccessory = status === 'unavailable' || startup ? undefined : (
    <Button
      size="sm"
      variant="outline"
      style={checking ? { opacity: 0.6 } : undefined}
      aria-describedby={expanded ? helpId : undefined}
      aria-disabled={checking}
      onClick={() => { if (!checking) void source.check() }}
    >
      {t(checking ? 'backendChecking' : 'backendCheck')}
    </Button>
  )
  return (
    <section aria-label={t('backendStatusHeading')} data-section="backend">
      <PanelCard style={styles.backendSection}>
        <div style={styles.backendHeaderWrap}>
          <DisclosureRow
            icon={<StateDot state={headerDot} />}
            title={t('backendStatusHeading')}
            open={expanded}
            expandable
            expandOnRowClick
            keepContentWhenOpen
            running={startup || checking}
            onToggle={onToggle}
            collapsedContent={<>{' '}<span style={{ ...styles.notice, ...styles.backendSummary }} title={summary}>{summary}</span></>}
            headerAccessory={recheckAccessory}
          >
            <div style={styles.backendContent}>
              {status === 'unavailable' || startup ? null : <p id={helpId} style={styles.notice}>{t('backendCheckHelp')}</p>}
              {startup ? <p style={styles.notice}>{t('backendLoading')}</p> : null}
              {status === 'unavailable' ? <p style={styles.notice}>{t('backendStatusUnavailable')}</p> : null}
              {status === 'error' || view.checkFailed ? <p style={styles.error}>{t(view.checkFailed ? 'backendCheckFailed' : data === undefined ? 'backendReadFailed' : 'backendReadFailedWithCache')}</p> : null}
              {status === 'ready' && !checking && !view.checkFailed && checkResult !== null ? <p style={styles.notice}>{checkResult}</p> : null}
              {data === undefined || startup ? null : (
                <>
                  <p style={styles.notice}>{defaultName === undefined ? t('backendNoDefault') : t('backendDefault', { name: defaultName })}</p>
                  {selected !== undefined && selected.readiness !== 'ready' && selected.reason !== 'probe-timeout' && !checking ? <p style={styles.notice}>{t('backendPinnedUnready')}</p> : null}
                  {data.dispatchEnabled
                    ? defaultName === undefined ? <p style={styles.notice}>{t('backendChooseReady')}</p> : null
                    : checking || noneVerifiedAfterTimeout ? null : <p style={styles.notice}>{t('backendNoDispatch')}</p>}
                  {data.backends.length === 0 ? <p style={styles.notice}>{t('backendNoEntries')}</p> : (
                    <ul style={styles.list}>
                      {data.backends.map(backend => <BackendStatusRow key={backend.id} backend={backend} visibleChats={visibleChats} now={now} t={t} />)}
                    </ul>
                  )}
                </>
              )}
            </div>
          </DisclosureRow>
        </div>
        <div role="status" style={styles.visuallyHidden}>{view.checkCompleted && !checking && !view.checkFailed && status === 'ready' ? checkResult : summary}</div>
        {hasUsage ? (
          <div style={styles.backendUsageBar}>
            <UsageLines usage={usage} now={now} t={t} />
          </div>
        ) : null}
      </PanelCard>
    </section>
  )
}

/** Dot of a finished run: green completed, red failed, orange cancelled or interrupted. */
const RUN_DOT: Readonly<Record<'completed' | 'failed' | 'aborted' | 'interrupted', ChatDotState>> = { completed: 'done', failed: 'error', aborted: 'warning', interrupted: 'warning' }
/** Dot of a member: by outcome; still running shows the spinner, never started (a finished run) grey. */
const MEMBER_DOT: Readonly<Record<'completed' | 'failed' | 'cancelled', ChatDotState>> = { completed: 'done', failed: 'error', cancelled: 'warning' }
const RUN_STATUS_COPY = { completed: 'workflowCompleted', failed: 'workflowFailed', aborted: 'workflowAborted', interrupted: 'workflowInterrupted' } as const

function emptyWorkflows(): Observable<WorkflowsSnapshot> {
  const snapshot: WorkflowsSnapshot = { status: 'ready', running: [], recent: [] }
  return { getSnapshot: () => snapshot, subscribe: () => () => {} }
}
const NO_WORKFLOWS = emptyWorkflows()

/** The expanded steps of one run: step id, then each member (role and short chat id) opening its chat. */
function WorkflowSteps({ steps, running, onOpenChat, t }: { readonly steps: readonly PanelWorkflowStep[]; readonly running: boolean; readonly onOpenChat: (chatId: string) => void; readonly t: PanelTranslate }): ReactNode {
  return (
    <ul style={styles.wfSteps} data-workflow-steps>
      {steps.map(step => (
        <li key={step.id} style={styles.wfStep}>
          <span style={styles.wfStepId}>{step.id}</span>
          {step.members.length === 0 ? <span style={styles.wfMeta}> · {t('workflowNoMembers')}</span> : null}
          {step.members.map((member, index) => {
            const dot: ChatDotState = member.outcome === undefined ? (running ? 'ongoing' : 'idle') : MEMBER_DOT[member.outcome]
            const label = member.chatId === undefined ? member.role : `${member.role} ${shortChatId(member.chatId)}`
            return member.chatId === undefined
              ? <span key={index} style={styles.wfMember} data-member={member.role}><ChatStateDot state={dot} />{label}</span>
              : (
                <button key={index} type="button" style={styles.wfMemberButton} data-member={member.role} aria-label={t('workflowOpenMember', { role: member.role })}
                  onClick={(event: MouseEvent) => { event.stopPropagation(); onOpenChat(member.chatId as string) }}>
                  <ChatStateDot state={dot} />{label}
                </button>
              )
          })}
        </li>
      ))}
    </ul>
  )
}

/**
 * The panel's workflow block (D29): heading with the running count, running
 * rows (spinner, `template · step`, live time), then up to five finished
 * rows (outcome dot, template, relative time). A click toggles a row's steps
 * and members; a member opens its chat's detail tab. Nothing renders when the
 * session has no workflow.
 */
function WorkflowsSection({ source, onOpenChat, t }: { readonly source: Observable<WorkflowsSnapshot>; readonly onOpenChat: (chatId: string) => void; readonly t: PanelTranslate }): ReactNode {
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot)
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  if (snapshot.running.length === 0 && snapshot.recent.length === 0) return null
  const now = snapshot.fetchedAt ?? 0
  const toggle = (runId: string): void => {
    setOpen((current) => {
      const next = new Set(current)
      if (next.has(runId)) next.delete(runId)
      else next.add(runId)
      return next
    })
  }
  const row = (runId: string, template: string, dot: ChatDotState, body: ReactNode, title: string | undefined, steps: readonly PanelWorkflowStep[], running: boolean): ReactNode => {
    const expanded = open.has(runId)
    return (
      <li key={runId} style={styles.wfRow} data-workflow={runId}>
        <button type="button" style={styles.wfHead} aria-expanded={expanded} title={title}
          aria-label={t(expanded ? 'workflowCollapse' : 'workflowExpand', { template })} onClick={() => { toggle(runId) }}>
          <ChatStateDot state={dot} />
          {body}
        </button>
        {expanded ? <WorkflowSteps steps={steps} running={running} onOpenChat={onOpenChat} t={t} /> : null}
      </li>
    )
  }
  return (
    <section style={styles.wfSection} data-workflows>
      <h3 style={styles.wfHeading}>{snapshot.running.length === 0 ? t('workflowsHeading') : t('workflowsRunning', { count: snapshot.running.length })}</h3>
      <ul style={styles.list}>
        {snapshot.running.map(run => row(run.runId, run.template, 'ongoing', (
          <>
            <span style={styles.name}>{run.currentStep === undefined ? run.template : `${run.template} · ${run.currentStep}`}</span>
            <LiveElapsed startedAt={run.startedAt} now={now} t={t} />
          </>
        ), undefined, run.steps, true))}
        {snapshot.recent.map(run => row(run.runId, run.template, RUN_DOT[run.status], (
          <>
            <span style={styles.name}>{run.template}</span>
            <span style={styles.elapsed}>{relativeTime(t, run.endedAt ?? run.startedAt, now)}</span>
          </>
        ), run.error === undefined ? t(RUN_STATUS_COPY[run.status]) : `${t(RUN_STATUS_COPY[run.status])}: ${run.error}`, run.steps, false))}
      </ul>
    </section>
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
function ChatCard({ chat, settings, now, pending, onRelease, onDelete, onOpen, t }: ChatCardProps): ReactNode {
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
      {chat.currentModel || chat.currentEffort ? <div>{[chat.currentModel, chat.currentEffort].filter(Boolean).join(' · ')}</div> : null}
      {settings && <ChatSettings key={chat.connectionId ?? 'released'} chat={chat} actions={settings} t={t} />}
    </li>
  )
}

/**
 * Render the panel.
 * @param props - bound chats hook, commands, and copy.
 * @returns the panel body.
 */
export function ChatsPanel(props: ChatsPanelProps): ReactNode {
  return <PanelFeatureGate source={props.features} t={props.t}>
    {config => <ChatsPanelView {...props} config={config} />}
  </PanelFeatureGate>
}

function ChatsPanelView({ useChats, useTabInfo, currentSessionId, settings, profileForms, features, backendStatus, workflowsFor, config, refresh, close, purge, t }:
  ChatsPanelProps & { config?: PanelFeatures }): ReactNode {
  const [showSettings, setShowSettings] = useState(false)
  const [backendExpanded, setBackendExpanded] = useState(false)
  const toggleBackend = useCallback(() => { setBackendExpanded(open => !open) }, [])
  const snapshot = useChats(s => s)
  const backendStore = backendStatus ?? NO_BACKEND_STATUS
  const backendView = useSyncExternalStore(backendStore.subscribe, backendStore.getSnapshot)
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
    action(chatId).catch((error: unknown) => { setActionError(panelActionError(error, t)) }).finally(() => {
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
        <ChatCard key={chat.chatId} settings={settings} chat={chat} now={now} pending={pending.has(chat.chatId)} t={t}
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
  const backendPending = backendView?.status === 'loading' || backendView?.checking || backendView?.data?.checking
  const backendAlert: 'check-failed' | 'no-dispatch' | undefined = backendView === undefined || backendPending
    ? undefined
    : (backendView.checkFailed === true || backendView.status === 'error')
      ? 'check-failed'
      : (backendView.status === 'ready' && backendView.data?.dispatchEnabled === false)
        ? 'no-dispatch'
        : undefined
  return (
    <section style={styles.root} aria-label={t('title')}>
      <div style={styles.header}>
        <h2 style={styles.heading}>{t('title')}</h2>
        <div style={styles.controls}>
          <Button size="sm" variant="ghost" icon={<IconRefreshOutlineRegular size={14} />}
            aria-label={t('refresh')} title={t('refresh')} onClick={() => { refresh() }} />
          {profileForms && (
            <Button size="sm" variant="ghost" icon={<IconSettingsOutlineRegular size={14} />}
              aria-label={t('profileSettings')} title={t('profileSettings')} aria-expanded={showSettings}
              onClick={() => { setShowSettings(open => !open) }} />
          )}
        </div>
      </div>
      {showSettings && <ProfileSettings key={currentSessionId} sessionId={currentSessionId} forms={profileForms?.()} backends={(backendView?.data?.backends ?? []).filter(b => b.configured || b.automatic).map(b => b.id)}
        t={t} onSaved={path => { if (path === 'workflow') void features.refresh() }} />}
      {backendAlert === undefined ? null : (
        <button
          type="button"
          data-backend-alert={backendAlert}
          style={backendAlert === 'check-failed' ? styles.backendAlertError : styles.backendAlertWarn}
          onClick={() => { setBackendExpanded(true) }}
        >
          <IconWarningOutlineRegular size={14} />
          <span style={styles.backendAlertText}>{t(backendAlert === 'check-failed' ? 'backendAlertCheckFailed' : 'backendAlertNoDispatch')}</span>
        </button>
      )}
      {backendStatus === undefined || backendView === undefined
        ? <UsageLines usage={snapshot.usage} now={now} t={t} />
        : <BackendStatusSection source={backendStatus} view={backendView} visibleChats={visible} usage={snapshot.usage} now={now} expanded={backendExpanded} onToggle={toggleBackend} t={t} />}
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
              {backendPending ? null : <p style={styles.notice}>{backendView?.data?.dispatchEnabled === false
                ? t('backendEmptyChatHint')
                : snapshot.chats.length > 0 ? t('emptySessionHint')
                  : config ? t('emptyHint', { tool: config.startToolName }) : t('emptyGenericHint')}</p>}
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
              <WorkflowsSection source={workflowsFor?.(config?.workflowEnabled ?? true) ?? NO_WORKFLOWS} onOpenChat={(chatId) => { tab.actions.openResource(chatAddress(chatId)) }} t={t} />
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
