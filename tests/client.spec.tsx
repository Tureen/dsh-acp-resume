// @vitest-environment jsdom
/**
 * Browser-half tests (PANEL-DESIGN §4, §2.6): the panel component fed realistic
 * props (empty state, cards with and without label/title/turnCount, release
 * without confirmation, delete behind a dialog naming the chat, cancel), the
 * data source over a mocked `connection.rpc` (call shape, fetch on open,
 * 5-second polling, refresh after commands, stale answers dropped), and the
 * `apply` wiring under cordis with stub services (tab type, guide entry, body
 * slot, no registration without `connection`, withdrawal). ui-primitives is a
 * shell-shared module, so it is replaced by plain stand-ins here.
 * @module dsh-acp-resume/tests/client.spec
 */

import { useSyncExternalStore, type ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configOptions, neon, sonnet, orchestrator } from './fixtures/session-options.ts'
import { readSessionChoices } from '../src/acp-reported-settings.ts'
import type { ChatOptions } from '../src/chat-options.ts'
import { callPanel, panelActionError } from '../src/client/chats-source.ts'
import type { BackendStatusSnapshot } from '../src/backend-status.ts'
import * as client from '../src/client/index.ts'
import type { LiveFrame } from '../src/live-buffer.ts'
import { LiveSource, type FollowTurn, type WatchRemote } from '../src/client/live-source.ts'
import { FeaturesSource } from '../src/client/features-source.ts'
import { BackendStatusSource } from '../src/client/backend-status-source.ts'
import { ChatsPanel, formatDuration, relativeTime, resetChatsPanelViewState, shortChatId, type ChatsPanelProps } from '../src/client/ChatsPanel.tsx'
import { formatHybridTime, formatTurnTime, formatTurnTimeTitle } from '../src/client/panel-time.ts'
import { ChatsSource, IDLE_POLL_INTERVAL_MS, POLL_INTERVAL_MS, QUIET_POLLS_BEFORE_BACKOFF, type PanelRpc, type PanelRpcResult } from '../src/client/chats-source.ts'
import { ChatDetail, ChatDetailTitle, cwdName, type ChatDetailProps } from '../src/client/ChatDetail.tsx'
import { CHAT_ADDRESS_PATTERN, chatAddress, parseChatAddress } from '../src/client/chat-address.ts'
import { ChatDetailSource, DETAIL_PAGE } from '../src/client/detail-source.ts'
import { WorkflowsSource } from '../src/client/workflows-source.ts'
import { chatEqual, chatsEqual, detailSnapshotEqual, listSnapshotEqual } from '../src/client/snapshot-equal.ts'
import type {
  BackendStatusView, ChatDetailInjected, ChatsPanelInjected, ChatsSnapshot, DetailSnapshot, DetailSource, EventItem, FullEntry, Observable,
  PanelChat, RunningItem, TabInfoHook, TurnItem, WorkflowsSnapshot,
} from '../src/client/face.ts'
import { en, zh, type PanelCopyKey, type PanelTranslate } from '../src/client/locales.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({  Button: ({ children, variant: _variant, size: _size, icon, ...rest }: Record<string, unknown> & { children?: ReactNode; icon?: ReactNode }) =>
    <button type="button" {...rest}>{icon}{children}</button>,
  Input: ({ icon: _icon, ...rest }: Record<string, unknown> & { icon?: ReactNode }) =>
    <span><input {...rest} /></span>,
  Switch: ({ checked, onChange, label, disabled, title }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean; title?: string }) =>
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} title={title} onClick={() => onChange(!checked)} />,
  IconArchiveOutlineRegular: () => <svg data-icon="archive" aria-hidden="true" />,
  IconChevronDownOutlineRegular: () => <svg data-icon="chevron-down" aria-hidden="true" />,
  IconChevronUpOutlineRegular: () => <svg data-icon="chevron-up" aria-hidden="true" />,
  IconEllipsisOutlineRegular: () => <svg data-icon="ellipsis" aria-hidden="true" />,
  IconRefreshOutlineRegular: () => <svg data-icon="refresh" aria-hidden="true" />,
  IconSettingsOutlineRegular: () => <svg data-icon="settings" aria-hidden="true" />,
  IconSlidersTwoOutlineRegular: () => <svg data-icon="sliders" aria-hidden="true" />,
  IconWarningOutlineRegular: () => <svg data-icon="warning" aria-hidden="true" />,
  DisclosureRow: ({ icon, title, open, expandable, onToggle, running, expandOnRowClick, keepContentWhenOpen, collapsedContent, headerAccessory, children }: {
    icon?: ReactNode; title: string; open: boolean; expandable: boolean; onToggle: () => void;
    running?: boolean; expandOnRowClick?: boolean; keepContentWhenOpen?: boolean;
    collapsedContent?: ReactNode; headerAccessory?: ReactNode; children?: ReactNode;
  }) => {
    const rowExpands = Boolean(expandable && expandOnRowClick)
    return (
      <div data-disclosure-root="" data-open={open || undefined}>
        <div data-disclosure-header="" data-has-accessory={headerAccessory ? '' : undefined}>
          <div
            data-disclosure-row=""
            data-expandable={rowExpands || undefined}
            role={rowExpands ? 'button' : undefined}
            tabIndex={rowExpands ? 0 : undefined}
            aria-expanded={rowExpands ? open : undefined}
            onClick={rowExpands ? onToggle : undefined}
            onKeyDown={rowExpands ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle() } } : undefined}
          >
            {expandable && !rowExpands ? (
              <button type="button" aria-label={title} aria-expanded={open} onClick={(e) => { e.stopPropagation(); onToggle() }}>
                {icon}
              </button>
            ) : (
              <span>{icon}</span>
            )}
            <span data-shimmer={running || undefined}>
              <span>{title}</span>
              {(keepContentWhenOpen || !open) && collapsedContent}
            </span>
          </div>
          {headerAccessory}
        </div>
        {open ? children : null}
      </div>
    )
  },
  MarkdownText: ({ text, omitHtml, streaming, variant }: { text: string; omitHtml: boolean; streaming: boolean; variant: string }) =>
    <div data-md={variant} data-omit-html={String(omitHtml)} data-streaming={String(streaming)}>{omitHtml ? text.replace(/<[^>]+>/g, '') : text}</div>,
  Pill: ({ onClick, children }: { onClick(): void; children: ReactNode }) => <button onClick={onClick}>{children}</button>,
  TextShimmer: ({ children, active }: { children: ReactNode; active?: boolean }) => <span data-shimmer={active || undefined}>{children}</span>,
  extractMarkdownPlainText: (text: string) => text
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1'),
  useClipboardCopy: () => ({ copied: false, onCopy: () => {} }),
  Modal: ({ open, title, description, footer, tone }: { open: boolean; title: string; description?: string; footer?: ReactNode; tone?: string }) =>
    open ? <div role="dialog" aria-label={title} data-tone={tone}><h3>{title}</h3><p>{description}</p>{footer}</div> : null,
  // Read-only badge and status dot: stand-ins that expose tone/state for assertions.
  Tag: ({ children, tone }: { children?: ReactNode; tone?: string }) => <span data-tag data-tone={tone}>{children}</span>,
  StateDot: ({ state }: { state: string }) => <span data-state-dot data-state={state} aria-hidden="true" />,
  // Menu stand-in: the anchor, then (while open) a menu of item buttons; a separator renders as <hr>.
  Menu: ({ open, anchor, items = [], onSelect }: { open: boolean; anchor: ReactNode; items?: readonly { id: string; type?: string; label?: ReactNode; disabled?: boolean; danger?: boolean }[]; onSelect?: (id: string) => void }) => (
    <>
      {anchor}
      {open ? (
        <div role="menu">
          {items.map(item => item.type === 'separator'
            ? <hr key={item.id} data-separator />
            : <button key={item.id} type="button" role="menuitem" disabled={item.disabled} data-danger={item.danger ? '' : undefined} onClick={() => { onSelect?.(item.id) }}>{item.label}</button>)}
        </div>
      ) : null}
    </>
  ),

}))

afterEach(() => {
  cleanup()
  resetChatsPanelViewState()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** The zh dictionary with `{name}` interpolation, as the locale seat renders it. */
const translator = (dict: Record<PanelCopyKey, string>): PanelTranslate => (key, params) =>
  dict[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? `{${name}}`))
const t = translator(zh)

const NOW = 1_800_000_000_000
const UUID_A = 'a1b2c3d4-0000-4000-8000-000000000001'
const UUID_B = 'e5f6a7b8-0000-4000-8000-000000000002'
const TEST_SESSION = 'test-session-0001'

function chat(overrides: Partial<PanelChat> = {}): PanelChat {
  return {
    chatId: `chat-${UUID_A}`,
    remoteSessionId: '4fb07582-1111-4111-8111-111111111111',
    cwd: '/tmp',
    active: true,
    lastActive: NOW - 3 * 60_000,
    ownerSessionId: TEST_SESSION,
    ...overrides,
  }
}

/** A plain stub for the renderer-bound selector hook. */
function staticHook(snapshot: ChatsSnapshot): ChatsPanelProps['useChats'] {
  return selector => selector(snapshot)
}

/** A tab-info stub whose tab sits at `contentId` and records opens and closes. */
function tabInfo(contentId = 'sidebar://acp-resume.chats'): { hook: TabInfoHook; openResource: ReturnType<typeof vi.fn>; closeTab: ReturnType<typeof vi.fn> } {
  const openResource = vi.fn()
  const closeTab = vi.fn()
  return { hook: () => ({ tab: { contentId, actions: { openResource, close: closeTab } } }), openResource, closeTab }
}

const defaultFeatureView = { status: 'ready', features: {
  chatToolsEnabled: true, workflowEnabled: true, startToolName: 'acp_chat_start',
} } as const
const defaultFeatureStore = {
  getSnapshot: () => defaultFeatureView, subscribe: () => () => {}, refresh: async () => {},
}

function props(snapshot: ChatsSnapshot, overrides: Partial<ChatsPanelProps> = {}): ChatsPanelProps {
  return {
    features: defaultFeatureStore,
    useChats: staticHook(snapshot),
    useTabInfo: tabInfo().hook,
    currentSessionId: TEST_SESSION,
    refresh: vi.fn(),
    close: vi.fn(async () => {}),
    purge: vi.fn(async () => {}),
    t,
    ...overrides,
  }
}

const ready = (chats: readonly PanelChat[]): ChatsSnapshot => ({ status: 'ready', chats, fetchedAt: NOW })

const backendFixture: BackendStatusSnapshot = {
  checking: false, dispatchEnabled: true, defaultBackend: 'codex',
  backends: [
    { id: 'codex', label: 'Codex', configured: true, version: '0.170.0', range: '>=0.100.0 <1', compatibility: 'supported', readiness: 'ready' },
    { id: 'kiro', label: 'Kiro', configured: true, version: '2.0.0', compatibility: 'unverified-version', readiness: 'unverified', reason: 'unsupported-version' },
    { id: 'agy', label: 'Antigravity', configured: false, compatibility: 'not-found', readiness: 'unavailable', reason: 'missing-executable' },
    { id: 'review', label: 'Review', configured: true, compatibility: 'custom', readiness: 'unverified', reason: 'custom-unverified' },
    { id: 'other', label: 'Other', configured: true, compatibility: 'unknown', readiness: 'needs-login', reason: 'login-required' },
  ],
}

describe('backend readiness', () => {
  it('shows CLI versions, compatibility, readiness, selected default and remediation above an empty chat list', () => {
    const backendStatus = {
      getSnapshot: () => view,
      subscribe: () => () => {},
      check: vi.fn(async () => {}),
    }
    const view = { status: 'ready', checking: false, data: backendFixture } as const
    render(<ChatsPanel {...props(ready([]), { currentSessionId: undefined, backendStatus, t: translator(en) })} />)
    const region = screen.getByRole('region', { name: 'Backend status' })
    const toggle = within(region).getByRole('button', { name: 'Backend status Codex ready' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(within(region).queryByRole('list')).toBeNull()
    const recheck = within(region).getByRole('button', { name: 'Recheck backends' })
    expect(toggle.contains(recheck)).toBe(false)
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const rows = within(region).getAllByRole('listitem')
    expect(region.compareDocumentPosition(screen.getByText('No ACP chats')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(region).getByText('Default for new chats: Codex')).toBeTruthy()
    expect(within(rows[0]!).getByText('CLI version: 0.170.0')).toBeTruthy()
    expect(within(rows[0]!).getByText('Supported range: >=0.100.0 <1')).toBeTruthy()
    expect(within(rows[0]!).getByText('Compatibility: Supported')).toBeTruthy()
    expect(within(rows[0]!).getByText('Readiness: Ready')).toBeTruthy()
    expect(within(rows[1]!).getByText('Compatibility: Unverified version')).toBeTruthy()
    expect(within(rows[1]!).getByText('This version is outside the verified range; you can still try the configured backend.')).toBeTruthy()
    expect(within(rows[2]!).getByText('Compatibility: CLI not found')).toBeTruthy()
    expect(within(rows[2]!).getByText('Not configured')).toBeTruthy()
    expect(within(rows[2]!).getByText('No CLI version detected')).toBeTruthy()
    expect(within(rows[3]!).getByText('Compatibility: Custom')).toBeTruthy()
    expect(within(rows[3]!).getByText('Readiness: Unverified')).toBeTruthy()
    expect(within(rows[4]!).getByText('Compatibility: Unknown')).toBeTruthy()
    expect(within(rows[4]!).getByText('Readiness: Needs sign-in')).toBeTruthy()
    expect(within(rows[4]!).getByText('Sign in through the CLI, then check again.')).toBeTruthy()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(within(region).queryByRole('list')).toBeNull()
    expect(within(region).getByRole('button', { name: 'Recheck backends' })).toBe(recheck)
    expect(backendStatus.check).not.toHaveBeenCalled()
  })

  it.each([['zh', zh], ['en', en]] as const)('renders reported values, mismatches and missing fields in %s', (language, dictionary) => {
    const chinese = language === 'zh'
    const row = { id: 'agy', label: 'Antigravity CLI (agy)', configured: true, compatibility: 'supported', readiness: 'ready' } as const
    const data: BackendStatusSnapshot = { checking: false, dispatchEnabled: true, backends: [
      { ...row, configuredModel: 'gemini-4-neon', configuredEffort: 'high',
        report: { source: 'session', chatId: 'chat-d41', at: 0, model: 'gemini-4-neon', modelName: 'Gemini 4 Neon', effort: 'high' } },
      { ...row, id: 'codex', label: 'Codex', configuredModel: 'requested', configuredEffort: 'high',
        report: { source: 'probe', model: 'backend-default', effort: 'low' } },
      { ...row, id: 'default', label: 'kiro-cli', sessionReporting: true, configuredModel: 'invisible', configuredEffort: 'invisible' },
    ] }
    const backendStatus = { subscribe: () => () => {}, getSnapshot: () => view, check: async () => {} }
    const view = { status: 'ready', checking: false, data } as const
    const tr = translator(dictionary)
    const expectedTime = formatHybridTime(tr, 0, NOW)
    const panelProps = props(ready([chat({ chatId: 'chat-d41' })]), { backendStatus, t: tr })
    const mounted = render(<ChatsPanel {...panelProps} />)
    const toggle = screen.getByRole('button', { expanded: false, name: chinese ? /^后端状态/ : /^Backend status/ })
    fireEvent.click(toggle)
    const region = screen.getByRole('region', { name: chinese ? '后端状态' : 'Backend status' })
    const rows = within(region).getAllByRole('listitem')
    expect(within(rows[0]!).getByText(chinese ? '模型：gemini-4-neon (Gemini 4 Neon)' : 'Model: gemini-4-neon (Gemini 4 Neon)')).toBeTruthy()
    expect(within(rows[0]!).getByText(chinese ? '思考强度：high' : 'Reasoning effort: high')).toBeTruthy()
    expect(within(rows[0]!).getByText(new RegExp(`chat-d41 · ${expectedTime}`))).toBeTruthy()
    expect(mounted.container.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/)
    expect(within(rows[1]!).getByText(chinese ? '模型：配置 requested，实际 backend-default' : 'Model: configured requested, actual backend-default')).toBeTruthy()
    expect(within(rows[1]!).getByText(chinese ? '思考强度：配置 high，实际 low' : 'Reasoning effort: configured high, actual low')).toBeTruthy()
    expect(within(rows[1]!).getByText(chinese ? '无会话检测：后端报告的默认值' : 'Session-free check: backend defaults')).toBeTruthy()
    expect(within(rows[2]!).getByText(chinese ? '模型：未报告' : 'Model: Not reported')).toBeTruthy()
    expect(within(rows[2]!).getByText(chinese ? '思考强度：未报告' : 'Reasoning effort: Not reported')).toBeTruthy()
    expect(within(rows[2]!).getByText(chinese ? '派工后可见会话报告' : 'Session reports are available after dispatch')).toBeTruthy()
    expect(screen.queryByText(/invisible/)).toBeNull()
    mounted.rerender(<ChatsPanel {...panelProps} currentSessionId="another-owner" />)
    expect(screen.queryByText(/chat-d41/)).toBeNull()
    expect(screen.getByText(chinese ? `最近活跃会话报告 · ${expectedTime}` : `Latest active session report · ${expectedTime}`)).toBeTruthy()
    expect(mounted.container.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/)
  })

  it.each([['zh', zh], ['en', en]] as const)('distinguishes timed out, auto-discovered and failed connections in %s', (locale, dictionary) => {
    const base = { label: 'CLI', configured: true, compatibility: 'supported' } as const
    const data: BackendStatusSnapshot = { checking: false, dispatchEnabled: true, defaultBackend: 'slow', backends: [
      { ...base, id: 'slow', readiness: 'unverified', reason: 'probe-timeout' },
      { ...base, id: 'auto', configured: false, automatic: true, readiness: 'unverified', reason: 'probe-timeout' },
      { ...base, id: 'failed', readiness: 'unavailable', reason: 'handshake-failed' },
    ] }
    const view = { status: 'ready', checking: false, checkCompleted: true, data } as const
    const source = { getSnapshot: () => view, subscribe: () => () => {}, check: vi.fn() }
    render(<ChatsPanel {...props(ready([]), { backendStatus: source, t: translator(dictionary) })} />)
    const chinese = locale === 'zh'
    fireEvent.click(screen.getByRole('button', { expanded: false, name: chinese ? /检测超时/ : /check timed out/ }))
    const rows = screen.getAllByRole('listitem')
    expect(within(rows[0]!).getByText(chinese ? '检测超时。可点「重新检测后端」重试；该后端仍可派工。'
      : 'Detection timed out. Select Recheck backends to try again. You can still dispatch to this backend.')).toBeTruthy()
    expect(within(rows[1]!).getByText(chinese ? '检测超时。可点「重新检测后端」重试。'
      : 'Detection timed out. Select Recheck backends to try again.')).toBeTruthy()
    expect(within(rows[2]!).getByText(chinese ? '连接失败。确认 CLI 及其启动模式是否正确，然后重新检查。'
      : 'Connection failed. Verify the CLI and its launch mode, then check again.')).toBeTruthy()
  })

  it('shows automatic startup without offering a setup click, then presents the discovered ready backend', () => {
    const pending = {
      data: { ...backendFixture, checking: true, dispatchEnabled: false, backends: [] },
      status: 'ready', checking: false,
    } as const
    const found = {
      ...backendFixture,
      backends: [{ ...backendFixture.backends[0]!, configured: false, automatic: true as const }],
    }
    const source = (view: BackendStatusView) => ({ getSnapshot: () => view, subscribe: () => () => {}, check: vi.fn(async () => {}) })
    const first = render(<ChatsPanel {...props(ready([]), { backendStatus: source(pending), t: translator(en) })} />)
    expect(screen.getByRole('button', { name: 'Backend status Checking…' }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: 'Recheck backends' })).toBeNull()
    expect(screen.queryByText(/acp_chat_start|Expand Backend status/)).toBeNull()
    first.rerender(<ChatsPanel {...props(ready([]), { backendStatus: source({ status: 'ready', checking: false, data: found }), t: translator(en) })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Backend status Codex ready' }))
    expect(screen.getByText('Auto-discovered')).toBeTruthy()
    expect(screen.getByText('Default for new chats: Codex')).toBeTruthy()
    expect(screen.getByText(/Uses your existing Codex account/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Recheck backends' })).toBeTruthy()
    const agy = { ...found.backends[0]!, id: 'agy', label: 'Antigravity CLI (agy)' }
    first.rerender(<ChatsPanel {...props(ready([]), { backendStatus: source({ status: 'ready', checking: false, data: { ...found, defaultBackend: 'agy', backends: [agy] } }), t: translator(en) })} />)
    expect(screen.getByRole('button', { name: 'Backend status agy handshake passed; sign-in not checked' })).toBeTruthy()
    expect(screen.getByText(/Uses agy model settings.*Sign-in checked when opening a chat/)).toBeTruthy()
    expect(screen.queryByText(/Uses your existing Codex account/)).toBeNull()
  })

  it('distinguishes named configurations for the same CLI and explains an unselected default', () => {
    const view = { status: 'ready', checking: false, data: {
      checking: false, dispatchEnabled: true,
      backends: [
        { id: 'default', label: 'Codex', configured: true, compatibility: 'supported', readiness: 'ready' },
        { id: 'review', label: 'Codex', configured: true, compatibility: 'supported', readiness: 'ready' },
      ],
    } } as const
    const backendStatus = { getSnapshot: () => view, subscribe: () => () => {}, check: async () => {} }
    render(<ChatsPanel {...props(ready([]), { backendStatus, t: translator(en) })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Backend status 2 backends ready' }))
    expect(screen.getByText('Codex (default)')).toBeTruthy()
    expect(screen.getByText('Codex (review)')).toBeTruthy()
    expect(screen.getByText('No default backend selected')).toBeTruthy()
    expect(screen.getByText('Choose a ready backend explicitly when dispatching.')).toBeTruthy()
  })

  it('checks only on its own button, keeps rows visible in flight, and announces the new state', async () => {
    let resolveCheck!: (r: PanelRpcResult) => void
    const call = vi.fn(async (_channel: string, endpoint: string): Promise<PanelRpcResult> => endpoint === 'acpResume/backends'
      ? { ok: true, value: backendFixture }
      : new Promise(resolve => { resolveCheck = resolve }))
    const backendStatus = new BackendStatusSource({ call })
    const refresh = vi.fn()
    render(<ChatsPanel {...props(ready([]), { backendStatus, refresh })} />)
    fireEvent.click(await screen.findByRole('button', { name: '后端状态 Codex 就绪' }))
    await screen.findByText('新会话默认后端：Codex')
    const check = screen.getByRole('button', { name: '重新检测后端' }) as HTMLButtonElement
    expect(check.disabled).toBe(false)
    expect(screen.getByText(/无需重启 DSH。不会删除会话、退出登录或修改配置/).id).toBe(check.getAttribute('aria-describedby'))
    fireEvent.click(screen.getByRole('button', { name: '刷新会话' }))
    expect(refresh).toHaveBeenCalledOnce()
    expect(call.mock.calls.map(([, endpoint]) => endpoint)).toEqual(['acpResume/backends'])
    fireEvent.click(check)
    expect(screen.getByRole('button', { name: '正在检测后端…' }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByText('新会话默认后端：Codex')).toBeTruthy()
    expect(call).toHaveBeenLastCalledWith('/api', 'acpResume/checkBackends', { args: {} })
    const { defaultBackend: _old, ...withoutDefault } = backendFixture
    const backends = withoutDefault.backends.map(backend => backend.id === 'codex'
      ? { ...backend, readiness: 'needs-login', reason: 'login-required' } : backend)
    await act(async () => { resolveCheck({ ok: true, value: { ...withoutDefault, backends, dispatchEnabled: false } }) })
    expect(screen.getByText('未选定默认后端')).toBeTruthy()
    expect(screen.getByText('没有可用的后端。仍可查看历史；要继续派工，请先准备好一个受支持的后端。')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('检测完成，暂无就绪的后端。')
    expect(screen.getByText('展开「后端状态」查看无法派工的原因。')).toBeTruthy()
    expect(screen.queryByText(/acp_chat_start/)).toBeNull()
  })

  it('names the ready backend when a recheck restores dispatch', async () => {
    const call: PanelRpc['call'] = async (_channel, endpoint) => endpoint === 'acpResume/backends'
      ? { ok: true, value: { checking: false, dispatchEnabled: false, backends: [] } }
      : { ok: true, value: backendFixture }
    render(<ChatsPanel {...props(ready([]), { backendStatus: new BackendStatusSource({ call }), t: translator(en) })} />)
    const collapsed = await screen.findByRole('button', { name: 'Backend status No backends ready' })
    const recheck = screen.getByRole('button', { name: 'Recheck backends' }) as HTMLButtonElement
    fireEvent.click(recheck)
    expect(collapsed.getAttribute('aria-expanded')).toBe('false')
    expect(recheck.getAttribute('aria-disabled')).toBe('true')
    expect(recheck.disabled).toBe(false)
    expect(screen.queryByText('No backend status yet. Check backends or review the plugin settings.')).toBeNull()
    const summary = await screen.findByRole('button', { name: 'Backend status Codex ready' })
    expect(summary.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByRole('status').textContent).toBe('Codex is ready for dispatch.')
  })

  it('announces a failed explicit check without exposing error text and leaves a retry available', async () => {
    const call: PanelRpc['call'] = async (_channel, endpoint) => endpoint === 'acpResume/backends'
      ? { ok: true, value: backendFixture }
      : { ok: false, error: { code: 'gateway/internal', message: 'private path or stderr' } }
    render(<ChatsPanel {...props(ready([]), { backendStatus: new BackendStatusSource({ call }), t: translator(en) })} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Backend status Codex ready' }))
    const button = screen.getByRole('button', { name: 'Recheck backends' }) as HTMLButtonElement
    fireEvent.click(button)
    expect(await screen.findByText('Backend check failed. Any results below are from the previous check.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Backend status Recheck failed' })).toBeTruthy()
    expect(screen.queryByText(/private path or stderr/)).toBeNull()
    expect(screen.getByText('Default for new chats: Codex')).toBeTruthy()
    expect(button.disabled).toBe(false)
  })

  it('keeps chat discovery useful when an older Host has no readiness Remote', async () => {
    const call: PanelRpc['call'] = async () => ({ ok: false, error: { code: 'gateway/invocation-unavailable', message: 'No such method' } })
    render(<ChatsPanel {...props(ready([]), { backendStatus: new BackendStatusSource({ call }), t: translator(en) })} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Backend status Status unavailable' }))
    expect(screen.getByText('This host does not provide backend status.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Recheck backends' })).toBeNull()
    expect(screen.getByText(/Ask the model to call acp_chat_start/)).toBeTruthy()
  })

  it('uses DisclosureRow, three-layer PanelCard rows with rails/tags, and nests usage in the backend card footer (D47 Step 3)', () => {
    const view = { status: 'ready', checking: false, data: backendFixture } as const
    const backendStatus = { getSnapshot: () => view, subscribe: () => () => {}, check: vi.fn(async () => {}) }
    const usage = [
      { backend: 'codex', protocol: 'codex' as const, status: 'ok' as const, plan: 'prolite', usedPercent: 17, windowMins: 10080, resetsAt: Math.floor((NOW + 3_600_000) / 1000), fetchedAt: NOW },
    ]
    render(<ChatsPanel {...props({ ...ready([]), usage }, { backendStatus })} />)
    const region = screen.getByRole('region', { name: zh.backendStatusHeading })
    expect(region.querySelector('[data-disclosure-row]')).toBeTruthy()
    // Usage stays visible inside the backend section card even while collapsed.
    expect(region.querySelector('[data-usage-backend="codex"]')?.textContent).toBe('codex · prolite · 剩 83%')
    expect(region.querySelector('[data-usage-backend="codex"]')?.getAttribute('title')).not.toMatch(/\d{4}-\d{2}-\d{2}T/)

    fireEvent.click(within(region).getByRole('button', { name: '后端状态 Codex 就绪' }))
    const cards = [...region.querySelectorAll('[data-backend-id]')] as HTMLElement[]
    expect(cards.map(c => [c.getAttribute('data-backend-id'), c.getAttribute('data-state')])).toEqual([
      ['codex', 'none'],
      ['kiro', 'warn'],
      ['agy', 'error'],
      ['review', 'warn'],
      ['other', 'warn'],
    ])
    expect(cards[0]?.querySelector('[data-state-dot]')?.getAttribute('data-state')).toBe('done')
    expect(within(cards[0]!).getByText(zh.backendReady).closest('[data-tag]')?.getAttribute('data-tone')).toBe('success')
    expect(cards[2]?.querySelector('[data-state-dot]')?.getAttribute('data-state')).toBe('error')
    expect(within(cards[2]!).getByText(zh.backendUnavailable).closest('[data-tag]')?.getAttribute('data-tone')).toBe('danger')
    expect(cards[4]?.querySelector('[data-state-dot]')?.getAttribute('data-state')).toBe('warning')
    expect(within(cards[4]!).getByText(zh.backendNeedsLogin).closest('[data-tag]')?.getAttribute('data-tone')).toBe('warning')
    expect(backendStatus.check).not.toHaveBeenCalled()
  })

  it('shows the conditional alert bar only when dispatchEnabled is false or check fails, and expands Backend status on click (D47 Step 3)', () => {
    const check = vi.fn(async () => {})
    const sourceOf = (view: BackendStatusView) => ({ getSnapshot: () => view, subscribe: () => () => {}, check })

    // Healthy: no alert bar.
    const healthy: BackendStatusView = { status: 'ready', checking: false, data: backendFixture }
    const view = render(<ChatsPanel {...props(ready([]), { backendStatus: sourceOf(healthy) })} />)
    expect(view.container.querySelector('[data-backend-alert]')).toBeNull()

    // Startup checking even with dispatchEnabled: false -> hidden.
    const loading: BackendStatusView = { status: 'ready', checking: false, data: { ...backendFixture, checking: true, dispatchEnabled: false } }
    view.rerender(<ChatsPanel {...props(ready([]), { backendStatus: sourceOf(loading) })} />)
    expect(view.container.querySelector('[data-backend-alert]')).toBeNull()

    // Unavailable legacy host -> hidden.
    view.rerender(<ChatsPanel {...props(ready([]), { backendStatus: sourceOf({ status: 'unavailable', checking: false }) })} />)
    expect(view.container.querySelector('[data-backend-alert]')).toBeNull()

    // Condition 1: dispatchEnabled === false -> shows no-dispatch alert and expands on click without triggering check.
    const noDispatch: BackendStatusView = { status: 'ready', checking: false, data: { ...backendFixture, dispatchEnabled: false } }
    view.rerender(<ChatsPanel {...props(ready([]), { backendStatus: sourceOf(noDispatch) })} />)
    const noDispatchAlert = view.container.querySelector('[data-backend-alert="no-dispatch"]') as HTMLElement
    expect(noDispatchAlert).toBeTruthy()
    expect(noDispatchAlert.textContent).toBe(zh.backendAlertNoDispatch)
    fireEvent.click(noDispatchAlert)
    const region = screen.getByRole('region', { name: zh.backendStatusHeading })
    expect(region.querySelector('[data-disclosure-row]')?.getAttribute('aria-expanded')).toBe('true')
    expect(check).not.toHaveBeenCalled()

    // Condition 2: checkFailed === true -> shows check-failed alert (zh and en).
    const failed: BackendStatusView = { status: 'ready', checking: false, checkFailed: true, data: backendFixture }
    view.rerender(<ChatsPanel {...props(ready([]), { backendStatus: sourceOf(failed) })} />)
    expect(view.container.querySelector('[data-backend-alert="check-failed"]')?.textContent).toBe(zh.backendAlertCheckFailed)
    view.rerender(<ChatsPanel {...props(ready([]), { backendStatus: sourceOf(failed), t: translator(en) })} />)
    expect(view.container.querySelector('[data-backend-alert="check-failed"]')?.textContent).toBe(en.backendAlertCheckFailed)
    view.rerender(<ChatsPanel {...props(ready([]), { backendStatus: sourceOf(noDispatch), t: translator(en) })} />)
    expect(view.container.querySelector('[data-backend-alert="no-dispatch"]')?.textContent).toBe(en.backendAlertNoDispatch)
    expect(check).not.toHaveBeenCalled()
  })
})

describe('BackendStatusSource', () => {
  it('polls only the snapshot while subscribed and preserves equal snapshot references', async () => {
    vi.useFakeTimers()
    let value = backendFixture
    const call = vi.fn(async () => ({ ok: true as const, value: structuredClone(value) }))
    const source = new BackendStatusSource({ call }, 1_000)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(call).not.toHaveBeenCalled()
    const listener = vi.fn()
    const stopFirst = source.subscribe(listener)
    const stopSecond = source.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(call).toHaveBeenCalledExactlyOnceWith('/api', 'acpResume/backends', { args: {} })
    const first = source.getSnapshot()
    expect(first).toMatchObject({ status: 'ready', data: value })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(source.getSnapshot()).toBe(first)
    expect(listener).toHaveBeenCalledTimes(1)
    value = { ...value, checking: true }
    stopSecond()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(source.getSnapshot().data?.checking).toBe(true)
    stopFirst()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(call.mock.calls).toHaveLength(3)
  })

  it('drops an older pending read after a check, collapses duplicate checks and ignores late answers on disposal', async () => {
    const pending: { endpoint: string; resolve: (result: PanelRpcResult) => void }[] = []
    const call: PanelRpc['call'] = (_channel, endpoint) => new Promise(resolve => { pending.push({ endpoint, resolve }) })
    const source = new BackendStatusSource({ call })
    source.subscribe(() => {})
    const check = source.check()
    await source.check()
    expect(pending.map(p => p.endpoint)).toEqual(['acpResume/backends', 'acpResume/checkBackends'])
    pending[1]?.resolve({ ok: true, value: backendFixture })
    await check
    pending[0]?.resolve({ ok: true, value: { ...backendFixture, dispatchEnabled: false } })
    await Promise.resolve()
    expect(source.getSnapshot().data).toBe(backendFixture)
    const finalCheck = source.check()
    const beforeDispose = source.getSnapshot()
    source.dispose()
    pending[2]?.resolve({ ok: true, value: { ...backendFixture, dispatchEnabled: false } })
    await finalCheck
    expect(source.getSnapshot()).toBe(beforeDispose)
  })
})

describe('ChatsPanel', () => {
  it('shows the empty state with the start tool named', () => {
    render(<ChatsPanel {...props(ready([]))} />)
    expect(screen.getByText('暂无 ACP 会话')).toBeTruthy()
    expect(screen.getByText('让模型调用 acp_chat_start 创建;之后的每一轮对话都在这里可见。')).toBeTruthy()
  })

  it('shows loading before the first answer and the failure text on error', () => {
    const { unmount } = render(<ChatsPanel {...props({ status: 'loading', chats: [] })} />)
    expect(screen.getByText('正在读取…')).toBeTruthy()
    unmount()
    render(<ChatsPanel {...props({ status: 'error', chats: [], error: 'gateway/internal: boom', fetchedAt: NOW })} />)
    expect(screen.getByRole('alert').textContent).toBe('读取失败:gateway/internal: boom')
  })

  it('renders one card per chat: full-width name (label, else title, else short id), clean preview, and release/delete inside the ⋯ menu', () => {
    const labelled = chat({ label: '审阅', title: '**记住暗号P**', turnCount: 12 })
    const titled = chat({ chatId: 'chat-titled', title: '首轮问题', lastActive: NOW - 4 * 60_000 })
    const legacy = chat({ chatId: `chat-${UUID_B}`, remoteSessionId: '9c0d1e2f-2222', cwd: '/work', active: false, lastActive: NOW - 2 * 3_600_000 })
    render(<ChatsPanel {...props(ready([labelled, titled, legacy]))} />)
    fireEvent.click(screen.getByRole('button', { name: '已释放 (1) · 展开' }))
    const cards = screen.getAllByRole('listitem') as HTMLElement[]
    expect(cards).toHaveLength(3)
    const name = (card: HTMLElement): string => (card.querySelector('[data-name]') as HTMLElement).textContent ?? ''

    expect(name(cards[0] as HTMLElement)).toBe('审阅')
    expect(cards[0]?.querySelector('[data-preview]')?.textContent).toBe('记住暗号P')
    expect((cards[0] as HTMLElement).getAttribute('title')).toBe('首轮:**记住暗号P**\n活跃 · 12 轮 · 3 分钟前')
    expect(name(cards[1] as HTMLElement)).toBe('首轮问题')
    expect(name(cards[2] as HTMLElement)).toBe('chat-e5f6a7b8')
    expect((cards[2] as HTMLElement).getAttribute('title')).toBe('已释放(下次发送自动重连) · — 轮 · 2 小时前')
    // cwd, remote id, and owner live on the detail tab, not on the row.
    for (const card of cards) {
      expect(card.textContent).not.toMatch(/cwd|远端|归属/)
      expect(card.querySelectorAll('p')).toHaveLength(0)
      expect(card.querySelector('[data-panel-card]')).toBeTruthy()
    }
    // A released chat has nothing to release in its ⋯ menu.
    fireEvent.click(within(cards[2] as HTMLElement).getByRole('button', { name: '更多操作' }))
    expect((within(cards[2] as HTMLElement).getByRole('menuitem', { name: '释放进程' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('maps panel states onto the official StateDot: ongoing > error > warning > done > idle > released', () => {
    const { container } = render(<ChatsPanel {...props(ready([
      chat({ chatId: 'chat-run', inFlight: { chatId: 'chat-run', message: 'm', startedAt: NOW - 5_000 }, attention: 'error' }),
      chat({ chatId: 'chat-done', active: true, lastCompleted: true }),
      chat({ chatId: 'chat-act', active: true }),
      // Completed but released: the process is gone, so it reads as released, not green.
      chat({ chatId: 'chat-rel-done', active: false, lastCompleted: true }),
      chat({ chatId: 'chat-warn', active: true, attention: 'warning' }),
      // An error turn releases its process; the failure must still show on the released chat.
      chat({ chatId: 'chat-err', active: false, attention: 'error' }),
      chat({ chatId: 'chat-rel', active: false }),
    ]))} />)
    fireEvent.click(screen.getByRole('button', { name: '已释放 (3) · 展开' }))
    const dot = (id: string): [string | null, string | null | undefined] => {
      const el = container.querySelector(`[data-chat-id="${id}"] [data-dot]`) as HTMLElement
      return [el.getAttribute('data-dot'), el.querySelector('[data-state-dot]')?.getAttribute('data-state')]
    }
    expect(dot('chat-run')).toEqual(['ongoing', 'ongoing'])
    expect(dot('chat-err')).toEqual(['error', 'error'])
    expect(dot('chat-warn')).toEqual(['warning', 'warning'])
    expect(dot('chat-done')).toEqual(['done', 'done'])
    expect(dot('chat-act')).toEqual(['idle', 'idle'])
    expect(dot('chat-rel')).toEqual(['released', 'idle'])
    expect(dot('chat-rel-done')).toEqual(['released', 'idle'])
  })

  it('orders active chats running first, then idle by newest lastActive', () => {
    const { container } = render(<ChatsPanel {...props(ready([
      chat({ chatId: 'chat-new', lastActive: NOW - 60_000 }),
      chat({ chatId: 'chat-old', lastActive: NOW - 60 * 60_000 }),
      chat({ chatId: 'chat-run', lastActive: NOW - 2 * 60 * 60_000, inFlight: { chatId: 'chat-run', message: 'm', startedAt: NOW - 5_000 } }),
    ]))} />)
    expect([...container.querySelectorAll('[data-chat-id]')].map(el => el.getAttribute('data-chat-id'))).toEqual(['chat-run', 'chat-new', 'chat-old'])
  })

  it('shows one header usage line per ok or failed backend, none for unsupported ones (D28)', () => {
    const usage = [
      { backend: 'default', protocol: 'acp' as const, status: 'unsupported' as const, fetchedAt: NOW },
      { backend: 'codex', protocol: 'codex' as const, status: 'ok' as const, plan: 'prolite', usedPercent: 83.4, windowMins: 10080, resetsAt: 1_800_600_000, fetchedAt: NOW },
      { backend: 'codex2', protocol: 'codex' as const, status: 'error' as const, error: 'usage read timed out after 15000 ms', fetchedAt: NOW },
    ]
    const { container, rerender } = render(<ChatsPanel {...props({ ...ready([chat()]), usage })} />)
    const lines = [...container.querySelectorAll('[data-usage-backend]')] as HTMLElement[]
    expect(lines.map(l => l.textContent)).toEqual(['codex · prolite · 剩 17%', 'codex2 · 额度读取失败'])
    expect(lines[0]?.getAttribute('title')).toMatch(/^周窗口已用 83% · .+ 重置$/)
    expect(lines[1]?.getAttribute('title')).toBe('usage read timed out after 15000 ms')
    rerender(<ChatsPanel {...props({ ...ready([chat()]), usage: [usage[0]!] })} />)
    expect(container.querySelector('[data-usage]')).toBeNull()
    rerender(<ChatsPanel {...props(ready([chat()]))} />)
    expect(container.querySelector('[data-usage]')).toBeNull()
  })

  it('merges backend usage into the snapshot without holding up the rows or counting as a poll (D28)', async () => {
    let answerUsage!: (value: PanelRpcResult) => void
    const rpc: PanelRpc = {
      call: async (_channel, endpoint) => endpoint === 'acpResume/usage'
        ? new Promise((resolve) => { answerUsage = resolve })
        : { ok: true, value: [chat()] },
    }
    const source = new ChatsSource(rpc, () => NOW)
    await source.refresh()
    expect(source.getSnapshot()).toEqual({ status: 'ready', chats: [chat()], fetchedAt: NOW })
    const usage = [{ backend: 'codex', protocol: 'codex', status: 'ok', usedPercent: 5, fetchedAt: NOW }]
    answerUsage({ ok: true, value: usage })
    await vi.waitFor(() => { expect(source.getSnapshot().usage).toEqual(usage) })
    // An older host without the method: the rows are unaffected.
    const old = new ChatsSource({ call: async (_c, endpoint) => endpoint === 'acpResume/usage' ? { ok: false, error: { code: 'gateway/not-found', message: 'no method' } } : { ok: true, value: [chat()] } }, () => NOW)
    await old.refresh()
    await new Promise(r => setTimeout(r, 0))
    expect(old.getSnapshot()).toEqual({ status: 'ready', chats: [chat()], fetchedAt: NOW })
  })

  describe('workflow block (D29)', () => {
    const staticWorkflows = (snapshot: WorkflowsSnapshot): Observable<WorkflowsSnapshot> => ({ getSnapshot: () => snapshot, subscribe: () => () => {} })
    const steps = [{ id: 'independent', members: [{ role: '审核员A', chatId: `chat-${UUID_A}`, outcome: 'completed' as const }, { role: '审核员B', chatId: `chat-${UUID_B}`, outcome: 'failed' as const }] }, { id: 'done', members: [] }]
    const snapshot: WorkflowsSnapshot = {
      status: 'ready',
      fetchedAt: NOW,
      running: [{ runId: 'run-live', template: 'dual_review', startedAt: NOW - 192_000, currentStep: 'independent', steps: [{ id: 'independent', members: [{ role: '审核员A' }] }] }],
      recent: [
        { runId: 'run-ok', template: 'chain', startedAt: NOW - 30 * 60_000, endedAt: NOW - 20 * 60_000, status: 'completed', steps },
        { runId: 'run-bad', template: 'chain', startedAt: NOW - 3 * 3_600_000, endedAt: NOW - 2 * 3_600_000, status: 'failed', error: 'step independent: every role failed', steps: [] },
        { runId: 'run-cut', template: 'chain', startedAt: NOW - 3 * 86_400_000, status: 'interrupted', steps: [] },
      ],
    }

    it('renders nothing for a session without workflows, and lists running then recent rows with the documented dots', () => {
      const { container, rerender } = render(<ChatsPanel {...props(ready([chat()]), { workflowsFor: () => staticWorkflows({ status: 'ready', running: [], recent: [] }) })} />)
      expect(container.querySelector('[data-workflows]')).toBeNull()
      rerender(<ChatsPanel {...props(ready([chat()]), { workflowsFor: () => staticWorkflows(snapshot) })} />)
      const section = container.querySelector('[data-workflows]') as HTMLElement
      expect(within(section).getByRole('heading', { level: 3 }).textContent).toBe('工作流 · 1 进行中')
      const rows = [...section.querySelectorAll('[data-workflow]')] as HTMLElement[]
      expect(rows.map(r => r.getAttribute('data-workflow'))).toEqual(['run-live', 'run-ok', 'run-bad', 'run-cut'])
      expect(rows.map(r => r.querySelector('[data-dot]')?.getAttribute('data-dot'))).toEqual(['ongoing', 'done', 'error', 'warning'])
      expect(rows.map(r => r.querySelector('[data-panel-card]')?.getAttribute('data-state'))).toEqual(['running', 'none', 'error', 'warn'])
      expect(rows.every(r => r.querySelector('[data-icon="chevron-down"]') !== null)).toBe(true)
      expect(rows[0]?.textContent).toBe('dual_review · independent已运行 3分12秒')
      expect(rows[1]?.textContent).toBe(`chain${formatTurnTime(t, { startedAt: NOW - 30 * 60_000, endedAt: NOW - 20 * 60_000 }, NOW)}`)
      expect(rows[1]?.textContent).toContain('10分0秒')
      expect((rows[2]?.querySelector('button') as HTMLElement).getAttribute('title')).toBe('失败: step independent: every role failed')
      // The block sits before the active chats (D47 authoritative order: ③ Workflows → ④a Active chats).
      const order = [...container.querySelectorAll('[data-chat-id], [data-workflows]')].map(el => el.hasAttribute('data-workflows') ? 'workflows' : 'chat')
      expect(order).toEqual(['workflows', 'chat'])
    })

    it('expands a row into steps and members, and a member opens its chat detail tab', () => {
      const info = tabInfo()
      const { container } = render(<ChatsPanel {...props(ready([chat()]), { workflowsFor: () => staticWorkflows(snapshot), useTabInfo: info.hook })} />)
      fireEvent.click(within(container.querySelector('[data-workflow="run-ok"]') as HTMLElement).getByRole('button', { name: '展开工作流 chain' }))
      const expanded = container.querySelector('[data-workflow="run-ok"] [data-workflow-steps]') as HTMLElement
      expect(expanded.textContent).toBe('independent审核员A chat-a1b2c3d4审核员B chat-e5f6a7b8done · 交回模型')
      expect([...expanded.querySelectorAll('[data-member] [data-dot]')].map(d => d.getAttribute('data-dot'))).toEqual(['done', 'error'])
      fireEvent.click(within(expanded).getByRole('button', { name: '打开 审核员B 的会话' }))
      expect(info.openResource).toHaveBeenCalledWith(chatAddress(`chat-${UUID_B}`))
      fireEvent.click(within(container.querySelector('[data-workflow="run-ok"]') as HTMLElement).getByRole('button', { name: '收起工作流 chain' }))
      expect(container.querySelector('[data-workflow="run-ok"] [data-workflow-steps]')).toBeNull()
    })
  })

  it('WorkflowsSource polls acpResume/workflows for its session only while subscribed, keeping the reference for unchanged content', async () => {
    vi.useFakeTimers()
    const calls: unknown[] = []
    let recent: unknown[] = []
    const rpc: PanelRpc = {
      call: async (_channel, endpoint, payload) => {
        calls.push([endpoint, payload])
        return { ok: true, value: { running: [], recent } }
      },
    }
    const source = new WorkflowsSource(rpc, 'session-x', true, () => NOW)
    const stop = source.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toEqual([['acpResume/workflows', { args: { ownerSessionId: 'session-x' } }]])
    const first = source.getSnapshot()
    expect(first).toEqual({ status: 'ready', running: [], recent: [], fetchedAt: NOW })
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(source.getSnapshot()).toBe(first)
    recent = [{ runId: 'r', template: 't', startedAt: 1, status: 'completed', steps: [] }]
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(source.getSnapshot()).not.toBe(first)
    stop()
    const count = calls.length
    await vi.advanceTimersByTimeAsync(3 * POLL_INTERVAL_MS)
    expect(calls).toHaveLength(count)
    source.dispose()
  })

  it('WorkflowsSource keeps the same snapshot reference across unchanged polls while a workflow is running (D49)', async () => {
    vi.useFakeTimers()
    let tick = NOW
    const running = [{ runId: 'run-1', template: 't', startedAt: NOW - 5_000, currentStep: 'plan', steps: [] }]
    const rpc: PanelRpc = { call: async () => ({ ok: true, value: { running, recent: [] } }) }
    const notified: number[] = []
    const source = new WorkflowsSource(rpc, 'session-x', true, () => tick)
    const stop = source.subscribe(() => { notified.push(1) })
    await vi.advanceTimersByTimeAsync(0)
    const first = source.getSnapshot()
    expect(notified).toHaveLength(1)
    tick += POLL_INTERVAL_MS
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(source.getSnapshot()).toBe(first)
    expect(notified).toHaveLength(1)
    stop()
    source.dispose()
  })

  it('refreshIfSubscribed reads history exactly once per manual refresh without starting a timer', async () => {
    vi.useFakeTimers()
    const call = vi.fn<PanelRpc['call']>(async () => ({ ok: true, value: { running: [], recent: [] } }))
    const source = new WorkflowsSource({ call }, TEST_SESSION, false)
    const stop = source.subscribe(() => {})
    expect(call).toHaveBeenCalledTimes(1)
    source.refreshIfSubscribed()
    expect(call).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(call).toHaveBeenCalledTimes(2)
    stop()
    source.refreshIfSubscribed()
    expect(call).toHaveBeenCalledTimes(2)
    source.dispose()
  })

  it('counts the session chats by state in the header line', () => {
    render(<ChatsPanel {...props(ready([
      chat({ chatId: 'chat-run', inFlight: { chatId: 'chat-run', message: 'm', startedAt: NOW - 5_000 } }),
      chat({ chatId: 'chat-act', active: true }),
      chat({ chatId: 'chat-act2', active: true }),
      chat({ chatId: 'chat-rel', active: false }),
      chat({ chatId: 'chat-foreign', ownerSessionId: 'someone-else' }),
    ]))} />)
    expect(screen.getByText('1 进行中 · 2 空闲 · 1 已释放')).toBeTruthy()
  })

  it('folds active chats only past six, showing five and "show the other N"; the released group is untouched', () => {
    const rows = Array.from({ length: 8 }, (_, i) => chat({ chatId: `chat-act${i}`, active: true }))
    const { container } = render(<ChatsPanel {...props(ready([...rows, chat({ chatId: 'chat-rel', active: false })]))} />)
    const shown = (): number => container.querySelectorAll('[data-chat-id^="chat-act"]').length
    expect(shown()).toBe(5)
    fireEvent.click(screen.getByRole('button', { name: '显示其余 3 个' }))
    expect(shown()).toBe(8)
    fireEvent.click(screen.getByRole('button', { name: '收起' }))
    expect(shown()).toBe(5)
    expect(screen.getByRole('button', { name: '已释放 (1) · 展开' })).toBeTruthy()
    cleanup()
    // Six fit without folding: a toggle would cost a row to hide one chat.
    const { container: six } = render(<ChatsPanel {...props(ready(rows.slice(0, 6)))} />)
    expect(six.querySelectorAll('[data-chat-id]').length).toBe(6)
    expect(screen.queryByRole('button', { name: /^显示其余/ })).toBeNull()
  })

  it('keeps the unfolded active group across a remount', () => {
    const rows = Array.from({ length: 7 }, (_, i) => chat({ chatId: `chat-act${i}`, active: true }))
    const { unmount } = render(<ChatsPanel {...props(ready(rows))} />)
    fireEvent.click(screen.getByRole('button', { name: '显示其余 2 个' }))
    unmount()
    const { container } = render(<ChatsPanel {...props(ready(rows))} />)
    expect(container.querySelectorAll('[data-chat-id]').length).toBe(7)
    expect(screen.getByRole('button', { name: '收起' })).toBeTruthy()
  })

  it('formats durations in at most two adjacent units', () => {
    const tEn = translator(en)
    expect([5_000, 192_000, 3_900_000, 2 * 86_400_000 + 3 * 3_600_000 + 59_000].map(ms => formatDuration(t, ms))).toEqual(['5秒', '3分12秒', '1时5分', '2天3时'])
    expect(formatDuration(tEn, 192_000)).toBe('3m 12s')
    expect(formatDuration(t, -1)).toBe('0秒')
  })

  it('ticks the running time once a second only while a turn is in flight', () => {
    vi.useFakeTimers({ now: NOW })
    const running = chat({ inFlight: { chatId: `chat-${UUID_A}`, message: 'm', startedAt: NOW - 5_000 } })
    const { container, rerender } = render(<ChatsPanel {...props(ready([running]))} />)
    const elapsed = (): string | null | undefined => container.querySelector('[data-elapsed]')?.textContent
    expect(elapsed()).toBe('已运行 5秒')
    act(() => { vi.advanceTimersByTime(3_000) })
    expect(elapsed()).toBe('已运行 8秒')
    expect(vi.getTimerCount()).toBe(1)
    rerender(<ChatsPanel {...props(ready([chat()]))} />)
    expect(elapsed()).toBeUndefined()
    // No turn in flight: no clock is left running.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('shows a backend badge only when more than one backend is configured', () => {
    const { rerender, container } = render(<ChatsPanel {...props(ready([chat({ backend: 'review', backendCount: 2 })]))} />)
    expect(within(container.querySelector('[data-chat-id]') as HTMLElement).getByText('后端 review')).toBeTruthy()
    rerender(<ChatsPanel {...props(ready([chat({ backend: 'review', backendCount: 1 })]))} />)
    expect(container.querySelector('[data-tag]')).toBeNull()
  })

  it('labels the backend badge with backendDisplay, falling back to backend for an older host', () => {
    const { rerender, container } = render(<ChatsPanel {...props(ready([chat({ backend: 'default', backendDisplay: 'kiro-cli', backendCount: 2 })]))} />)
    const row = (): HTMLElement => container.querySelector('[data-chat-id]') as HTMLElement
    expect(within(row()).getByText('后端 kiro-cli')).toBeTruthy()
    expect(within(row()).queryByText('后端 default')).toBeNull()
    rerender(<ChatsPanel {...props(ready([chat({ backend: 'review', backendCount: 2 })]))} />)
    expect(within(row()).getByText('后端 review')).toBeTruthy()
  })

  it('puts active chats first and released ones under a collapsed group, both newest first', () => {
    // Snapshot order is newest first across both kinds (ChatsSource sorts).
    const rows = [
      chat({ chatId: 'chat-r1', active: false, lastActive: NOW - 1_000 }),
      chat({ chatId: 'chat-a1', active: true, lastActive: NOW - 2_000 }),
      chat({ chatId: 'chat-r2', active: false, lastActive: NOW - 3_000 }),
      chat({ chatId: 'chat-a2', active: true, lastActive: NOW - 4_000 }),
      chat({ chatId: 'chat-r3', active: false, lastActive: NOW - 5_000 }),
    ]
    const { container } = render(<ChatsPanel {...props(ready(rows))} />)
    const ids = (): (string | null)[] => [...container.querySelectorAll('li')].map(li => li.getAttribute('data-chat-id'))
    expect(ids()).toEqual(['chat-a1', 'chat-a2'])
    const toggle = screen.getByRole('button', { name: '已释放 (3) · 展开' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(toggle)
    expect(toggle.textContent).toBe('已释放 (3) · 收起')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(ids()).toEqual(['chat-a1', 'chat-a2', 'chat-r1', 'chat-r2', 'chat-r3'])
    // The group header sits between the two lists.
    const lists = container.querySelectorAll('ul')
    expect(lists).toHaveLength(2)
    expect(lists[0]?.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(toggle.compareDocumentPosition(lists[1] as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    fireEvent.click(toggle)
    expect(toggle.textContent).toBe('已释放 (3) · 展开')
    expect(ids()).toEqual(['chat-a1', 'chat-a2'])
  })

  it('shows no group header when nothing is released', () => {
    render(<ChatsPanel {...props(ready([chat(), chat({ chatId: `chat-${UUID_B}` })]))} />)
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /^已释放/ })).toBeNull()
  })

  it('with every chat released shows the group header, not the empty state', () => {
    render(<ChatsPanel {...props(ready([chat({ active: false }), chat({ chatId: `chat-${UUID_B}`, active: false })]))} />)
    expect(screen.queryByText('暂无 ACP 会话')).toBeNull()
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '已释放 (2) · 展开' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })

  it('has the group copy in both locales', () => {
    for (const key of ['releasedGroup', 'expand', 'collapse'] as const) {
      expect(zh[key]).toBeTruthy()
      expect(en[key]).toBeTruthy()
    }
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    render(<ChatsPanel {...props(ready([chat({ active: false })]), { t: translator(en) })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Released (1) · Expand' }))
    expect(screen.getByRole('button', { name: 'Released (1) · Collapse' })).toBeTruthy()
  })

  const pickCardAction = (label: string): void => {
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: label }))
  }

  it('releases directly, without a confirmation dialog', async () => {
    const p = props(ready([chat()]))
    render(<ChatsPanel {...p} />)
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
    await act(async () => { fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: '释放进程' })) })
    expect(p.close).toHaveBeenCalledWith(`chat-${UUID_A}`)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('asks before releasing a chat with a turn in flight; cancel keeps it, confirm releases', async () => {
    const p = props(ready([chat({ inFlight: { chatId: `chat-${UUID_A}`, message: 'm', startedAt: NOW - 5_000 } })]))
    render(<ChatsPanel {...p} />)
    pickCardAction('释放进程')
    const dialog = screen.getByRole('dialog', { name: '释放 chat-a1b2c3d4?' })
    expect(within(dialog).getByText('将中止正在运行的本轮任务并释放进程(历史记录保留,后续仍可重连)。')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(p.close).not.toHaveBeenCalled()

    pickCardAction('释放进程')
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '释放' }))
    })
    expect(p.close).toHaveBeenCalledWith(`chat-${UUID_A}`)
    expect(p.purge).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('puts the in-flight message first line in the hover text while running, else the first-turn title', () => {
    const long = `${'长'.repeat(70)}\n第二行`
    const { container, rerender } = render(<ChatsPanel {...props(ready([chat({ title: '首轮标题', inFlight: { chatId: `chat-${UUID_A}`, message: `\n  ${long}`, startedAt: NOW - 5_000 } })]))} />)
    const hint = (): string => ((container.querySelector('[data-chat-id]') as HTMLElement).getAttribute('title') ?? '').split('\n')[0] ?? ''
    expect(hint()).toBe(`当前:${'长'.repeat(60)}…`)
    // The long text stays off the row itself.
    expect((container.querySelector('[data-chat-id]') as HTMLElement).textContent).not.toContain('当前:')
    rerender(<ChatsPanel {...props(ready([chat({ title: '首轮标题', inFlight: { chatId: `chat-${UUID_A}`, message: '短指令', startedAt: NOW - 5_000 } })]))} />)
    expect(hint()).toBe('当前:短指令')
    rerender(<ChatsPanel {...props(ready([chat({ title: '首轮标题' })]))} />)
    expect(hint()).toBe('首轮:首轮标题')
  })

  it('asks before deleting, naming the chat; cancel deletes nothing', async () => {
    const p = props(ready([chat()]))
    render(<ChatsPanel {...p} />)
    pickCardAction('删除记录…')
    const dialog = screen.getByRole('dialog', { name: '删除 chat-a1b2c3d4?' })
    expect(within(dialog).getByText('将释放进程并删除本地记录,之后无法重连该会话。')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(p.purge).not.toHaveBeenCalled()

    pickCardAction('删除记录…')
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除' }))
    })
    expect(p.purge).toHaveBeenCalledWith(`chat-${UUID_A}`)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows a failed command and calls refresh from the header button', async () => {
    const p = props(ready([chat()]), { close: vi.fn(async () => { throw new Error('acp-resume/unknown-chat: gone') }) })
    render(<ChatsPanel {...p} />)
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
    await act(async () => { fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: '释放进程' })) })
    expect(screen.getByRole('alert').textContent).toBe('操作失败:acp-resume/unknown-chat: gone')
    fireEvent.click(screen.getByRole('button', { name: '刷新会话' }))
    expect(p.refresh).toHaveBeenCalledTimes(1)
  })

  it('orders sections by attention (header → workflows → active-chats → backend → released-chats) and titles standalone chats "活跃会话" (D47 Step 4)', () => {
    const view = { status: 'ready', checking: false, data: backendFixture } as const
    const backendStatus = { getSnapshot: () => view, subscribe: () => () => {}, check: vi.fn(async () => {}) }
    const wfSnapshot: WorkflowsSnapshot = {
      status: 'ready',
      fetchedAt: NOW,
      running: [{ runId: 'r1', template: 'dual_review', startedAt: NOW - 10_000, currentStep: 'review', steps: [] }],
      recent: [],
    }
    const { container, rerender } = render(<ChatsPanel {...props(ready([
      chat({ chatId: 'chat-active', active: true, inFlight: { chatId: 'chat-active', message: '## Fix `bug` with **care**', startedAt: NOW - 5_000 } }),
      chat({ chatId: 'chat-rel', active: false, attention: 'error' }),
    ]), {
      backendStatus,
      workflowsFor: () => ({ getSnapshot: () => wfSnapshot, subscribe: () => () => {} }),
    })} />)
    const sectionOrder = [...container.querySelectorAll('[data-section]')].map(el => el.getAttribute('data-section'))
    expect(sectionOrder).toEqual(['header', 'team', 'workflows', 'active-chats', 'backend', 'released-chats'])
    // Without team roles, active section heading reads "活跃会话" (zh) / "Active chats" (en).
    const activeSection = container.querySelector('[data-section="active-chats"]') as HTMLElement
    expect(within(activeSection).getByRole('heading', { level: 3 }).textContent).toBe(zh.activeChatsHeading)
    // PanelCard left rail + cleaned Markdown preview on active chat card.
    const activeCard = container.querySelector('[data-chat-id="chat-active"] [data-panel-card]') as HTMLElement
    expect(activeCard.getAttribute('data-state')).toBe('running')
    expect(activeCard.querySelector('[data-preview]')?.textContent).toBe('Fix bug with care')

    rerender(<ChatsPanel {...props(ready([chat({ chatId: 'chat-active', active: true })]), { t: translator(en) })} />)
    expect(within(container.querySelector('[data-section="active-chats"]') as HTMLElement).getByRole('heading', { level: 3 }).textContent).toBe(en.activeChatsHeading)
  })
})

const MY_SESSION = 'session-mine-0001'
const OTHER_SESSION = 'session-other-0002'

describe('ChatsPanel attribution filter (D20)', () => {
  const rows = (): PanelChat[] => [
    chat({ chatId: 'chat-mine', ownerSessionId: MY_SESSION, lastActive: NOW - 1_000 }),
    chat({ chatId: 'chat-other', ownerSessionId: OTHER_SESSION, lastActive: NOW - 2_000 }),
    chat({ chatId: 'chat-legacy', ownerSessionId: undefined, lastActive: NOW - 3_000 }),
  ]
  const ids = (container: HTMLElement): (string | null)[] => [...container.querySelectorAll('li')].map(li => li.getAttribute('data-chat-id'))

  it('strictly shows only chats owned by the visible session', () => {
    const { container } = render(<ChatsPanel {...props(ready(rows()), { currentSessionId: MY_SESSION })} />)
    expect(ids(container)).toEqual(['chat-mine'])
    expect(container.querySelector('[data-chat-id="chat-other"]')).toBeNull()
    expect(container.querySelector('[data-chat-id="chat-legacy"]')).toBeNull()
  })

  it('has no all-chats scope toggle', () => {
    render(<ChatsPanel {...props(ready(rows()), { currentSessionId: MY_SESSION })} />)
    expect(screen.queryByRole('button', { name: '过滤范围' })).toBeNull()
    expect(screen.queryByText('全部')).toBeNull()
  })

  it('shows a session-empty notice when only foreign or legacy rows exist', () => {
    const { container } = render(<ChatsPanel {...props(ready(rows()), { currentSessionId: 'session-fresh-9999' })} />)
    expect(ids(container)).toEqual([])
    expect(container.querySelector('[data-empty="session"]')?.textContent).toContain('本会话 0 条 / 共 3 条')
    expect(container.querySelector('[data-empty="session"]')?.textContent).toContain('当前会话尚未创建 ACP 会话。')
  })

  it('shows no profile-global rows when the sidebar has no session identity', () => {
    const { container } = render(<ChatsPanel {...props(ready(rows()), { currentSessionId: undefined })} />)
    expect(ids(container)).toEqual([])
    expect(container.querySelector('[data-empty="session"]')).toBeTruthy()
  })

  it('has the session-scope copy in both locales and shows no owner on rows (every row is this session\'s)', () => {
    for (const key of ['countMine', 'emptySessionHint'] as const) {
      expect(zh[key]).toBeTruthy()
      expect(en[key]).toBeTruthy()
    }
    const { container } = render(<ChatsPanel {...props(ready(rows()), { currentSessionId: MY_SESSION, t: translator(en) })} />)
    expect((container.querySelector('[data-chat-id="chat-mine"]') as HTMLElement).textContent).not.toContain('Owner')
  })
})

describe('display helpers', () => {
  it('shortens chat ids and formats coarse relative times', () => {
    expect(shortChatId(`chat-${UUID_A}`)).toBe('chat-a1b2c3d4')
    expect(shortChatId('legacy-identifier')).toBe('legacy-i')
    expect(relativeTime(t, NOW - 10_000, NOW)).toBe('刚刚')
    expect(relativeTime(t, NOW - 59 * 60_000, NOW)).toBe('59 分钟前')
    expect(relativeTime(t, NOW - 5 * 3_600_000, NOW)).toBe('5 小时前')
    expect(relativeTime(t, NOW - 3 * 86_400_000, NOW)).toBe('3 天前')
    expect(relativeTime(t, NOW + 5000, NOW)).toBe('刚刚')
  })
})

/** Mock carrier: answers `acpResume/list` from `rows`, records every call. */
/** A fake carrier. Usage calls (D28) are kept apart in `usageCalls` so the list/command call log stays exact. */
function mockRpc(
  rows: () => unknown = () => [],
  usage: () => PanelRpcResult = () => ({ ok: true, value: [] }),
  teamRoles: () => readonly string[] = () => [],
): PanelRpc & { calls: [string, string, unknown][]; usageCalls: number } {
  const calls: [string, string, unknown][] = []
  const rpc = {
    calls,
    usageCalls: 0,
    call: vi.fn(async (channel: string, endpoint: string, payload: unknown): Promise<PanelRpcResult> => {
      if (endpoint === 'acpResumeInfo/features') return { ok: true, value: defaultFeatureView.features }
      if (endpoint === 'acpResume/usage') {
        rpc.usageCalls += 1
        return usage()
      }
      calls.push([channel, endpoint, payload])
      if (endpoint === 'acpResume/backends') return { ok: true, value: backendFixture }
      if (endpoint === 'acpResume/teamRoles') return { ok: true, value: teamRoles() }
      return endpoint === 'acpResume/list' ? { ok: true, value: rows() } : { ok: true, value: null }
    }),
  }
  return rpc
}

const listCalls = (rpc: { calls: [string, string, unknown][] }): number => rpc.calls.filter(c => c[1] === 'acpResume/list').length

describe('ChatsSource', () => {
  it('fetches on the first subscription, polls every 5 s while subscribed, and stops after the last leaves', async () => {
    vi.useFakeTimers()
    const rpc = mockRpc(() => [chat()])
    const source = new ChatsSource(rpc, () => NOW)
    expect(source.getSnapshot().status).toBe('loading')
    const stopA = source.subscribe(() => {})
    const stopB = source.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(rpc.calls).toEqual([['/api', 'acpResume/list', { args: {} }]])
    expect(source.getSnapshot()).toEqual({ status: 'ready', chats: [chat()], fetchedAt: NOW, usage: [] })
    const before = source.getSnapshot()
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(listCalls(rpc)).toBe(2)
    // Content unchanged → same snapshot reference (D21), so no re-render pulse.
    expect(source.getSnapshot()).toBe(before)
    stopA()
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(listCalls(rpc)).toBe(3)
    stopB()
    await vi.advanceTimersByTimeAsync(3 * POLL_INTERVAL_MS)
    expect(listCalls(rpc)).toBe(3)
  })

  it('keeps the same snapshot reference across unchanged polls and publishes a new one only on change (D21)', async () => {
    vi.useFakeTimers()
    let rows: PanelChat[] = [chat()]
    const rpc = mockRpc(() => rows)
    const notified: number[] = []
    const source = new ChatsSource(rpc, () => NOW)
    source.subscribe(() => { notified.push(1) })
    await vi.advanceTimersByTimeAsync(0)
    const first = source.getSnapshot()
    expect(notified).toHaveLength(1)
    // Two unchanged polls: no new reference, no listener call.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(source.getSnapshot()).toBe(first)
    expect(notified).toHaveLength(1)
    // A content change publishes a new reference and notifies once.
    rows = [chat({ turnCount: 7 })]
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(source.getSnapshot()).not.toBe(first)
    expect(source.getSnapshot().chats[0]?.turnCount).toBe(7)
    expect(notified).toHaveLength(2)
  })

  it('keeps the same snapshot reference across unchanged polls while a turn is in flight, without backing off (D49)', async () => {
    vi.useFakeTimers()
    let tick = NOW
    const inFlightRow = chat({ inFlight: { chatId: `chat-${UUID_A}`, message: 'm', startedAt: NOW - 5_000 } })
    const rpc = mockRpc(() => [inFlightRow])
    const notified: number[] = []
    const source = new ChatsSource(rpc, () => tick, POLL_INTERVAL_MS, IDLE_POLL_INTERVAL_MS)
    source.subscribe(() => { notified.push(1) })
    await vi.advanceTimersByTimeAsync(0)
    const first = source.getSnapshot()
    expect(notified).toHaveLength(1)
    // Past QUIET_POLLS_BEFORE_BACKOFF unchanged polls: same reference, no extra notify, still polling fast.
    for (let i = 0; i < QUIET_POLLS_BEFORE_BACKOFF + 2; i += 1) {
      tick += POLL_INTERVAL_MS
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    }
    expect(source.getSnapshot()).toBe(first)
    expect(notified).toHaveLength(1)
    expect(listCalls(rpc)).toBe(QUIET_POLLS_BEFORE_BACKOFF + 3)
  })

  it('backs off to the idle interval after a run of unchanged polls, and resets to fast on a change', async () => {
    vi.useFakeTimers()
    let rows: PanelChat[] = [chat()]
    const rpc = mockRpc(() => rows)
    const source = new ChatsSource(rpc, () => NOW, POLL_INTERVAL_MS, IDLE_POLL_INTERVAL_MS)
    source.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    // Fast polls until QUIET_POLLS_BEFORE_BACKOFF unchanged ones have passed.
    for (let i = 0; i < QUIET_POLLS_BEFORE_BACKOFF; i += 1) await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    const afterBackoff = listCalls(rpc)
    // Now on the idle cadence: a fast interval no longer triggers a fetch.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(listCalls(rpc)).toBe(afterBackoff)
    // The idle interval does.
    await vi.advanceTimersByTimeAsync(IDLE_POLL_INTERVAL_MS - POLL_INTERVAL_MS)
    expect(listCalls(rpc)).toBe(afterBackoff + 1)
    // A change resets to the fast cadence.
    rows = [chat({ turnCount: 9 })]
    await vi.advanceTimersByTimeAsync(IDLE_POLL_INTERVAL_MS)
    const afterChange = listCalls(rpc)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(listCalls(rpc)).toBe(afterChange + 1)
  })

  it('a command resets the poll cadence to fast', async () => {
    vi.useFakeTimers()
    const rpc = mockRpc(() => [chat()])
    const source = new ChatsSource(rpc, () => NOW, POLL_INTERVAL_MS, IDLE_POLL_INTERVAL_MS)
    source.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < QUIET_POLLS_BEFORE_BACKOFF; i += 1) await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    // Backed off: a fast tick does nothing on its own.
    const idle = listCalls(rpc)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(listCalls(rpc)).toBe(idle)
    // A command refreshes now and restores the fast cadence.
    await source.close('chat-x', TEST_SESSION)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(listCalls(rpc)).toBeGreaterThan(idle + 1)
  })

  it('sorts newest first, sends close/purge with the chatId, and refreshes after each command', async () => {
    const older = chat({ chatId: `chat-${UUID_B}`, lastActive: NOW - 9_000_000 })
    const rpc = mockRpc(() => [older, chat()])
    const source = new ChatsSource(rpc, () => NOW)
    await source.refresh()
    expect(source.getSnapshot().chats.map(c => c.chatId)).toEqual([`chat-${UUID_A}`, `chat-${UUID_B}`])
    await source.close(`chat-${UUID_A}`, TEST_SESSION)
    await source.purge(`chat-${UUID_B}`, TEST_SESSION)
    await vi.waitFor(() => { expect(listCalls(rpc)).toBe(3) })
    expect(rpc.calls.filter(c => c[1] !== 'acpResume/list')).toEqual([
      ['/api', 'acpResume/close', { args: { chatId: `chat-${UUID_A}`, sessionId: TEST_SESSION } }],
      ['/api', 'acpResume/purge', { args: { chatId: `chat-${UUID_B}`, sessionId: TEST_SESSION } }],
    ])
    expect(rpc.calls.map(c => c[1])).toEqual(['acpResume/list', 'acpResume/close', 'acpResume/list', 'acpResume/purge', 'acpResume/list'])
  })

  it('rejects a failed command with its code, still refreshes, and keeps rows when a refresh fails', async () => {
    let failList = false
    const rpc: PanelRpc = {
      call: vi.fn(async (_channel: string, endpoint: string): Promise<PanelRpcResult> => {
        if (endpoint === 'acpResume/usage') return { ok: true, value: [] }
        if (endpoint === 'acpResume/purge') return { ok: false, error: { code: 'acp-resume/unknown-chat', message: 'acp-resume: unknown chat x' } }
        if (failList) throw new Error('transport failure for /api/acpResume/list: HTTP 502')
        return { ok: true, value: [chat()] }
      }),
    }
    const source = new ChatsSource(rpc, () => NOW)
    await source.refresh()
    failList = true
    await expect(source.purge('x', TEST_SESSION)).rejects.toThrow('acp-resume/unknown-chat: acp-resume: unknown chat x')
    await vi.waitFor(() => { expect(source.getSnapshot().status).toBe('error') })
    expect(source.getSnapshot()).toEqual({
      status: 'error', chats: [chat()], fetchedAt: NOW, error: 'transport failure for /api/acpResume/list: HTTP 502', usage: [],
    })
  })

  it('drops an answer older than the latest refresh, and everything after dispose', async () => {
    const answers: ((value: PanelRpcResult) => void)[] = []
    // Usage (D28) answers at once; only list answers are held.
    const rpc: PanelRpc = { call: async (_channel, endpoint) => endpoint === 'acpResume/usage' ? { ok: true, value: [] } : new Promise((resolve) => { answers.push(resolve) }) }
    const source = new ChatsSource(rpc, () => NOW)
    const first = source.refresh()
    const second = source.refresh()
    answers[1]?.({ ok: true, value: [chat({ cwd: '/new' })] })
    answers[0]?.({ ok: true, value: [chat({ cwd: '/old' })] })
    await Promise.all([first, second])
    expect(source.getSnapshot().chats[0]?.cwd).toBe('/new')
    const third = source.refresh()
    source.dispose()
    answers[2]?.({ ok: true, value: [] })
    await third
    expect(source.getSnapshot().chats).toHaveLength(1)
  })
})

/** Stub services for `apply`, recording what registers. */
type RemoteStub = {
  readonly $mount: (contribution: unknown) => Promise<() => void | Promise<void>>
  readonly acpResume?: WatchRemote['acpResume']
}

/** Minimal `remote` for wiring tests: the plugin now injects it at the top level to mount the
 * stream descriptor. The real access guard is covered in tests/live-gateway-consumer.spec.ts. */
const REMOTE_STUB: RemoteStub = { $mount: async () => () => {} }

function provideRemote(ctx: Context, remote: RemoteStub = REMOTE_STUB): void {
  const mounted: RemoteStub = remote.acpResume === undefined ? remote : {
    ...remote,
    $mount: async (contribution) => {
      const unmount = await remote.$mount(contribution)
      const withdraw = ctx.provide('remote.acpResume', remote.acpResume)
      return async () => { withdraw(); await unmount() }
    },
  }
  ctx.provide('remote', mounted as unknown as WatchRemote)
}

function stubServices() {
  const tabs: Record<string, unknown>[] = []
  const bodies: { options: { name: string; key: string; locale?: string; inject: (sessionId?: string) => unknown }; component: unknown }[] = []
  const dictionaries: string[] = []
  return {
    tabs, bodies, dictionaries,
    slots: {
      inject: (_name: string, register: () => () => void) => register(),
      register(options: (typeof bodies)[number]['options'], component: unknown) {
        const entry = { options, component }
        bodies.push(entry)
        return () => { bodies.splice(bodies.indexOf(entry), 1) }
      },
    },
    sidebarRightTabs: {
      register(definition: Record<string, unknown>) {
        tabs.push(definition)
        return () => { tabs.splice(tabs.indexOf(definition), 1) }
      },
    },
    locale: {
      register(namespace: string) {
        dictionaries.push(namespace)
        return () => { dictionaries.splice(dictionaries.indexOf(namespace), 1) }
      },
      bind: () => t,
    },
  }
}

/** Bind the injected `hooks.chats` the way the slot renderer does, then render the registered body. */
function renderBody(injected: ChatsPanelInjected): void {
  const { hooks, ...rest } = injected
  function Body(): ReactNode {
    const useChats: ChatsPanelProps['useChats'] = selector =>
      selector(useSyncExternalStore((hooks.chats as Observable<ChatsSnapshot>).subscribe, hooks.chats.getSnapshot))
    return <ChatsPanel {...rest} useChats={useChats} useTabInfo={tabInfo().hook} t={t} />
  }
  render(<Body />)
}

/** Mount the actual browser plugin with one session seat and a controlled transport. */
async function panelConnection(rpc: PanelRpc, remote: RemoteStub = REMOTE_STUB) {
  const ctx = new Context()
  const services = stubServices()
  ctx.provide('slots', services.slots)
  ctx.provide('sidebarRightTabs', services.sidebarRightTabs)
  ctx.provide('locale', services.locale)
  ctx.provide('connection', { rpc })
  provideRemote(ctx, remote)
  await ctx.plugin(client)
  const list = (services.bodies[0]!.options.inject as (session: string) => ChatsPanelInjected)(TEST_SESSION)
  const detail = services.bodies[1]!.options.inject() as ChatDetailInjected
  const title = services.bodies[2]!.options.inject() as ChatDetailInjected
  return { ctx, list, detail, title }
}

describe('D35 capability boundaries', () => {
  it('shares one read across the list, restored detail and title and makes no business calls when disabled', async () => {
    vi.useFakeTimers()
    const call = vi.fn<PanelRpc['call']>(async () => ({ ok: true, value: {
      ...defaultFeatureView.features, chatToolsEnabled: false,
    } }))
    const { ctx, list, detail, title } = await panelConnection({ call })
    expect(call).not.toHaveBeenCalled()
    const useTabInfo = tabInfo(chatAddress('chat-12345678-abcd')).hook
    renderBody(list)
    render(<ChatDetail {...detail} useTabInfo={useTabInfo} t={translator(en)} />)
    render(<ChatDetailTitle {...title} useTabInfo={useTabInfo} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(screen.getByText('持久会话已关闭。')).toBeTruthy()
    expect(screen.getByText('Persistent chats are disabled.')).toBeTruthy()
    expect(screen.getByText('chat-12345678')).toBeTruthy()
    expect(call.mock.calls).toEqual([['/api', 'acpResumeInfo/features', { args: {} }]])
    cleanup()
    await ctx.fiber.dispose()
  })

  it('renders the configured start tool, then refreshes into and out of the closed state', async () => {
    let enabled = true
    const business = mockRpc()
    const { ctx, list } = await panelConnection({
      call: (channel, endpoint, payload) => endpoint === 'acpResumeInfo/features'
        ? Promise.resolve({ ok: true, value: { chatToolsEnabled: enabled, workflowEnabled: false, startToolName: 'worker_start' } })
        : business.call(channel, endpoint, payload),
    })
    renderBody(list)
    expect(await screen.findByText(/让模型调用 worker_start/)).toBeTruthy()
    enabled = false
    const count = listCalls(business)
    fireEvent.click(screen.getByRole('button', { name: '刷新会话' }))
    expect(await screen.findByText('持久会话已关闭。')).toBeTruthy()
    expect(listCalls(business)).toBe(count)
    enabled = true
    fireEvent.click(screen.getByRole('button', { name: '刷新会话' }))
    expect(await screen.findByText(/让模型调用 worker_start/)).toBeTruthy()
    cleanup()
    await ctx.fiber.dispose()
  })

  it('uses the legacy list and workflow polling but never guesses a tool prefix for a missing method', async () => {
    vi.useFakeTimers()
    let rows: PanelChat[] = []
    const rpc = mockRpc(() => rows)
    const { ctx, list } = await panelConnection({
      call: (ch, endpoint, payload) => endpoint === 'acpResumeInfo/features'
        ? Promise.resolve({ ok: false, error: { code: 'gateway/invocation-unavailable', message: 'missing' } })
        : rpc.call(ch, endpoint, payload),
    })
    renderBody(list)
    await act(async () => {})
    expect(screen.getByText('让模型创建一个持久会话。')).toBeTruthy()
    rows = [chat()]
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    const count = () => rpc.calls.filter(([, endpoint]) => endpoint === 'acpResume/workflows').length
    expect(count()).toBe(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(count()).toBe(2)
    cleanup()
    await ctx.fiber.dispose()
  })

  it.each(['disconnect', 'remote-access/denied'])('retries %s without admitting a legacy panel', async code => {
    let failing = true
    const call = vi.fn<PanelRpc['call']>(async () => {
      if (!failing) return { ok: true, value: defaultFeatureView.features }
      if (code === 'disconnect') throw new Error(code)
      return { ok: false, error: { code, message: 'access denied' } }
    })
    const features = new FeaturesSource({ call })
    const readChats = vi.fn(() => ready([]))
    const useChats: ChatsPanelProps['useChats'] = selector => selector(readChats())
    render(<ChatsPanel {...props(ready([]), { features, useChats })} />)
    expect(await screen.findByText(new RegExp(code))).toBeTruthy()
    expect(readChats).not.toHaveBeenCalled()
    failing = false
    fireEvent.click(screen.getByRole('button', { name: '刷新会话' }))
    expect(await screen.findByText(/让模型调用 acp_chat_start/)).toBeTruthy()
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('invalidates an outstanding feature read on connection/reset even with the same connection service', async () => {
    const replies: ((result: PanelRpcResult) => void)[] = []
    const call = vi.fn<PanelRpc['call']>(() => new Promise(resolve => { replies.push(resolve) }))
    const { ctx, list } = await panelConnection({ call })
    renderBody(list)
    act(() => { ctx.emit('connection/reset') })
    expect(replies).toHaveLength(2)
    await act(async () => { replies[1]!({ ok: true, value: { ...defaultFeatureView.features, chatToolsEnabled: false } }) })
    await act(async () => { replies[0]!({ ok: true, value: defaultFeatureView.features }) })
    expect(screen.getByText('持久会话已关闭。')).toBeTruthy()
    expect(call).toHaveBeenCalledTimes(2)
    cleanup()
    await ctx.fiber.dispose()
  })

  it('reads only recent workflows on opening and explicit refresh when execution is off', async () => {
    vi.useFakeTimers()
    let runs = true
    const business = mockRpc(() => [chat()])
    const history = vi.fn(() => ({ ok: true as const, value: {
      running: [], recent: runs ? [{ runId: 'r', template: 'saved', startedAt: 1, status: 'completed',
        steps: [{ id: 'review', members: [{ role: 'A', chatId: 'chat-1', outcome: 'completed' }] }] }] : [],
    } }))
    const { ctx, list } = await panelConnection({
      call: async (ch, endpoint, payload) => {
        if (endpoint === 'acpResumeInfo/features') return { ok: true, value: { ...defaultFeatureView.features, workflowEnabled: false } }
        if (endpoint === 'acpResume/workflows') return history()
        return business.call(ch, endpoint, payload)
      },
    })
    const info = tabInfo()
    const { hooks, ...rest } = list
    const useChats: ChatsPanelProps['useChats'] = selector => selector(useSyncExternalStore(hooks.chats.subscribe, hooks.chats.getSnapshot))
    const body = <ChatsPanel {...rest} useChats={useChats} useTabInfo={info.hook} t={t} />
    const opened = render(body)
    await act(async () => {})
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(history).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '展开工作流 saved' }))
    fireEvent.click(screen.getByRole('button', { name: /打开 A/ }))
    expect(info.openResource).toHaveBeenCalledWith(chatAddress('chat-1'))
    runs = false
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '刷新会话' })) })
    expect(history).toHaveBeenCalledTimes(2)
    expect(opened.container.querySelector('[data-workflows]')).toBeNull()
    opened.unmount()
    render(body)
    await act(async () => {})
    expect(history).toHaveBeenCalledTimes(3)
    cleanup()
    await ctx.fiber.dispose()
  })
})

describe('apply (client wiring)', () => {
  it('exports only apply and inject', () => {
    expect(Object.keys(client).sort()).toEqual(['apply', 'inject'])
    expect(client.inject).toEqual(['slots', 'locale', 'sidebarRightTabs', 'remote'])
  })

  it('registers the tab type, guide entry, copy, and body; the bound body fetches and acts over rpc', async () => {
    const ctx = new Context()
    const services = stubServices()
    ctx.provide('slots', services.slots)
    ctx.provide('sidebarRightTabs', services.sidebarRightTabs)
    ctx.provide('locale', services.locale)
    let rows: PanelChat[] = [chat({ title: '记住暗号P', turnCount: 1 })]
    const rpc = mockRpc(() => rows)
    ctx.provide('connection', { rpc })
    provideRemote(ctx)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fiber = await ctx.plugin(client)
    expect(warn).not.toHaveBeenCalled()

    expect(services.tabs).toHaveLength(2)
    const tab = services.tabs[0] as { id: string; kind: string; title: () => string; guide: { title: () => string }[]; patterns?: unknown; multiple?: unknown }
    expect(tab).toMatchObject({ id: 'dsh-acp-resume', kind: 'acp-resume.chats' })
    expect(tab.patterns).toBeUndefined()
    expect(tab.multiple).toBeUndefined()
    expect(tab.title()).toBe('ACP 会话')
    expect(tab.guide.map(entry => entry.title())).toEqual(['ACP 会话'])
    expect(services.dictionaries).toEqual(['acpResumePanel'])
    // The list body, the detail body, and the detail chip title.
    expect(services.bodies.map(b => [b.options.name, b.options.key])).toEqual([
      ['sidebar.right.pane.tab', 'dsh-acp-resume'],
      ['sidebar.right.pane.tab', 'dsh-acp-resume/chat'],
      ['sidebar.right.pane.tab.title', 'dsh-acp-resume/chat'],
    ])
    const body = services.bodies[0] as (typeof services.bodies)[number]
    expect(body.options).toMatchObject({ name: 'sidebar.right.pane.tab', key: 'dsh-acp-resume', locale: 'acpResumePanel' })
    expect(body.component).toBe(ChatsPanel)
    expect(services.bodies[1]?.component).toBe(ChatDetail)
    expect(services.bodies[2]?.component).toBe(ChatDetailTitle)

    const injectPanel = body.options.inject as (sessionId: string) => ChatsPanelInjected
    const injected = injectPanel(TEST_SESSION)
    expect(injected.backendStatus).toBeInstanceOf(BackendStatusSource)
    expect(injectPanel('another-session').backendStatus).toBe(injected.backendStatus)
    expect(rpc.calls).toEqual([])
    renderBody(injected)
    expect(await screen.findByText('记住暗号P')).toBeTruthy()
    expect(await screen.findByRole('button', { name: '后端状态 Codex 就绪' })).toBeTruthy()
    expect(rpc.calls[0]).toEqual(['/api', 'acpResume/list', { args: {} }])
    expect(rpc.calls).toContainEqual(['/api', 'acpResume/backends', { args: {} }])
    expect(rpc.calls.some(([, endpoint]) => endpoint === 'acpResume/checkBackends')).toBe(false)
    rows = []
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: '删除记录…' }))
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除' })) })
    expect(await screen.findByText('暂无 ACP 会话')).toBeTruthy()
    expect(rpc.calls).toContainEqual(['/api', 'acpResume/purge', { args: { chatId: `chat-${UUID_A}`, sessionId: TEST_SESSION } }])
    cleanup()

    await fiber.dispose()
    expect(services.tabs).toHaveLength(0)
    expect(services.bodies).toHaveLength(0)
    expect(services.dictionaries).toHaveLength(0)
  })

  it('registers the detail tab type as a resource type: patterns, canOpen, title; no multiple, no guide entry, no provider', async () => {
    const ctx = new Context()
    const services = stubServices()
    ctx.provide('slots', services.slots)
    ctx.provide('sidebarRightTabs', services.sidebarRightTabs)
    ctx.provide('locale', services.locale)
    ctx.provide('connection', { rpc: mockRpc() })
    provideRemote(ctx)
    const fiber = await ctx.plugin(client)
    const detail = services.tabs[1] as { id: string; kind: string; patterns: string[]; canOpen: (a: string) => boolean; title: (a: string) => string; multiple?: unknown; guide?: unknown; priority?: unknown }
    expect(detail).toMatchObject({ id: 'dsh-acp-resume/chat', kind: 'acp-resume.chat', patterns: [CHAT_ADDRESS_PATTERN] })
    expect(CHAT_ADDRESS_PATTERN).toBe('dsh-resource://acp-resume-chat/**')
    expect(detail.multiple).toBeUndefined()
    expect(detail.guide).toBeUndefined()
    expect(detail.canOpen(chatAddress(`chat-${UUID_A}`))).toBe(true)
    expect(detail.canOpen('dsh-resource://file/session/x/a.txt')).toBe(false)
    expect(detail.canOpen('dsh-resource://acp-resume-chat/')).toBe(false)
    expect(detail.title(chatAddress(`chat-${UUID_A}`))).toBe('chat-a1b2c3d4')
    // Both detail registrations hand out one source per chat, shared by body and title.
    const bodyFace = services.bodies[1]?.options.inject() as ChatDetailInjected
    const titleFace = services.bodies[2]?.options.inject() as ChatDetailInjected
    expect(bodyFace.sourceFor('chat-x')).toBe(titleFace.sourceFor('chat-x'))
    expect(bodyFace.sourceFor('chat-x')).not.toBe(bodyFace.sourceFor('chat-y'))
    await fiber.dispose()
    expect(services.tabs).toHaveLength(0)
  })

  it('without a connection service registers nothing and warns once; a later connection brings the panel in', async () => {
    const ctx = new Context()
    const services = stubServices()
    ctx.provide('slots', services.slots)
    ctx.provide('sidebarRightTabs', services.sidebarRightTabs)
    ctx.provide('locale', services.locale)
    provideRemote(ctx)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fiber = await ctx.plugin(client)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/no connection service/)
    expect(services.tabs).toHaveLength(0)
    expect(services.bodies).toHaveLength(0)

    ctx.provide('connection', { rpc: mockRpc() })
    await vi.waitFor(() => { expect(services.tabs).toHaveLength(2) })
    expect(services.bodies).toHaveLength(3)
    expect(warn).toHaveBeenCalledTimes(1)
    await fiber.dispose()
    expect(services.tabs).toHaveLength(0)
  })

  it('aborts a pending live subscription cleanly when $mount hangs, and unmounts late $mount after early dispose', async () => {
    const mountGate = Promise.withResolvers<() => void>()
    const unmount = vi.fn()
    const ctx = new Context()
    const services = stubServices()
    ctx.provide('slots', services.slots)
    ctx.provide('sidebarRightTabs', services.sidebarRightTabs)
    ctx.provide('locale', services.locale)
    ctx.provide('connection', { rpc: mockRpc() })
    provideRemote(ctx, { $mount: () => mountGate.promise })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fiber = await ctx.plugin(client)
    const detail = services.bodies[1]!.options.inject(TEST_SESSION) as ChatDetailInjected
    const views: unknown[] = []
    const stop = detail.followTurn!('chat-hang', NOW, view => { views.push(view) })
    // Unsubscribing while $mount is hung must exit via abort without emitting an error or warning.
    stop()
    // Disposing before $mount resolves must run the late unmount disposer and not throw INACTIVE_EFFECT.
    await fiber.dispose()
    mountGate.resolve(unmount)
    await vi.waitFor(() => { expect(unmount).toHaveBeenCalledTimes(1) })
    expect(views).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('ChatsPanel card click (D18)', () => {
  it('opens the detail tab at the chat address when the card is clicked anywhere', () => {
    const info = tabInfo()
    render(<ChatsPanel {...props(ready([chat({ title: '记住暗号P' })]), { useTabInfo: info.hook })} />)
    fireEvent.click(screen.getByText('记住暗号P'))
    expect(info.openResource).toHaveBeenCalledTimes(1)
    expect(info.openResource).toHaveBeenCalledWith(`dsh-resource://acp-resume-chat/chat-${UUID_A}`)
  })

  it('opens once from the name button (the keyboard way in), with an accessible name', () => {
    const info = tabInfo()
    render(<ChatsPanel {...props(ready([chat()]), { useTabInfo: info.hook })} />)
    fireEvent.click(screen.getByRole('button', { name: '查看 chat-a1b2c3d4 详情' }))
    expect(info.openResource).toHaveBeenCalledTimes(1)
  })

  it('release and delete do not open the detail tab, but still act', async () => {
    const info = tabInfo()
    const p = props(ready([chat()]), { useTabInfo: info.hook })
    render(<ChatsPanel {...p} />)
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
    await act(async () => {
      fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: '释放进程' }))
    })
    expect(p.close).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: '删除记录…' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(info.openResource).not.toHaveBeenCalled()
  })

  it('opens the right chat when several cards exist', () => {
    const info = tabInfo()
    render(<ChatsPanel {...props(ready([chat(), chat({ chatId: `chat-${UUID_B}`, title: '第二个' })]), { useTabInfo: info.hook })} />)
    fireEvent.click(screen.getByText('第二个'))
    expect(info.openResource).toHaveBeenCalledWith(`dsh-resource://acp-resume-chat/chat-${UUID_B}`)
  })
})

describe('chat address', () => {
  it('round-trips ids, including ones that need escaping', () => {
    for (const id of [`chat-${UUID_A}`, 'chat-a/b?c#d', 'chat-空格 x']) {
      expect(parseChatAddress(chatAddress(id))).toBe(id)
    }
    expect(chatAddress('chat-x')).toBe('dsh-resource://acp-resume-chat/chat-x')
  })

  it('rejects other schemes, empty ids, nested paths, and bad escapes', () => {
    for (const address of [
      'dsh-resource://file/session/s/x', 'dsh-resource://acp-resume-chat/', 'dsh-resource://acp-resume-chat/a/b',
      'dsh-resource://acp-resume-chat/a?x=1', 'dsh-resource://acp-resume-chat/%E0%A4%A', 'sidebar://acp-resume.chats', '',
    ]) {
      expect(parseChatAddress(address)).toBeUndefined()
    }
  })
})

const turn = (seq: number, overrides: Partial<TurnItem> = {}): TurnItem => ({
  seq, kind: 'turn', startedAt: NOW - 10 * 60_000, at: NOW - 9 * 60_000,
  message: `问题${seq}`, output: `回答${seq}`, messageMore: false, outputMore: false,
  stopReason: 'completed', freshSession: false, ...overrides,
})

const lostEvent = (seq: number): EventItem => ({ seq, kind: 'event', event: 'session-lost', at: NOW - 5 * 60_000 })

function detailSnapshot(overrides: Partial<DetailSnapshot> = {}): DetailSnapshot {
  const entries = overrides.entries ?? []
  return { status: 'ready', chat: chat({ label: '审阅', title: '记住暗号P', turnCount: 2 }), entries, total: entries.length, fetchedAt: NOW, ...overrides }
}

function fakeSource(snapshot: DetailSnapshot, full: (seq: number) => Promise<FullEntry> = async seq => ({ seq, kind: 'turn', message: `完整问题${seq}`, output: `完整回答${seq}` })) {
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    refresh: vi.fn(async () => {}),
    loadMore: vi.fn(async () => {}),
    loadEntry: vi.fn(full),
  } satisfies DetailSource
}

function detailProps(source: DetailSource, overrides: Partial<ChatDetailProps> = {}, info = tabInfo(chatAddress(`chat-${UUID_A}`))) {
  const injected: ChatDetailProps = {
    features: defaultFeatureStore, useTabInfo: info.hook, sourceFor: () => source, close: vi.fn(async () => {}), purge: vi.fn(async () => {}), t, ...overrides,
  }
  return { injected, info }
}

describe('ChatDetail (D18, D30 density)', () => {
  /** Open the header's "⋯" menu and pick an item. */
  const pick = (label: string): void => {
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: label }))
  }
  const head = (container: HTMLElement, seq: number): HTMLElement => container.querySelector(`[data-seq="${seq}"] [data-turn-head]`) as HTMLElement

  it('uses the same five-state dot as the panel: a running entry is ongoing, attention outranks liveness', () => {
    const state = (snapshot: DetailSnapshot): string | null | undefined => {
      const { container, unmount } = render(<ChatDetail {...detailProps(fakeSource(snapshot)).injected} />)
      const value = container.querySelector('[data-dot]')?.getAttribute('data-dot')
      unmount()
      return value
    }
    expect(state(detailSnapshot({ entries: [{ kind: 'running', message: 'm', startedAt: NOW - 1_000 }] }))).toBe('ongoing')
    expect(state(detailSnapshot({ chat: chat({ active: false, attention: 'error' }) }))).toBe('error')
    expect(state(detailSnapshot({ chat: chat({ attention: 'warning' }) }))).toBe('warning')
    expect(state(detailSnapshot({ chat: chat({ active: false }) }))).toBe('released')
  })

  it('shows one identity line and one meta line; ids, cwd, and state move into the name\'s hover text; no refresh button', () => {
    const { injected } = detailProps(fakeSource(detailSnapshot({ entries: [turn(1)] })))
    const { container } = render(<ChatDetail {...injected} />)
    const heading = screen.getByRole('heading', { level: 2 })
    expect(heading.textContent).toBe('审阅')
    expect(heading.getAttribute('title')).toBe(`chat-${UUID_A}\ncwd /tmp\n远端 4fb07582-1111-4111-8111-111111111111\n活跃`)
    expect(container.querySelector('[data-meta]')?.textContent).toBe(`2 轮 · ${formatTurnTime(t, { at: chat().lastActive }, NOW)} · tmp`)
    // Gone from the body: cwd, remote id, first-turn line, the section's turn count, the refresh button.
    expect(container.textContent).not.toMatch(/cwd|远端|首轮/)
    expect(screen.queryByRole('button', { name: '刷新会话' })).toBeNull()
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('轮次记录')
  })

  it('names the chat like the list (label, then title, then short id) and names the backend only with several', () => {
    const name = (row: PanelChat): string => {
      const { unmount } = render(<ChatDetail {...detailProps(fakeSource(detailSnapshot({ chat: row }))).injected} />)
      const text = screen.getByRole('heading', { level: 2 }).textContent ?? ''
      unmount()
      return text
    }
    expect(name(chat({ title: '首轮问题' }))).toBe('首轮问题')
    expect(name(chat())).toBe('chat-a1b2c3d4')
    const { container } = render(<ChatDetail {...detailProps(fakeSource(detailSnapshot({ chat: chat({ turnCount: 4, backend: 'review', backendDisplay: 'review', backendCount: 2 }) }))).injected} />)
    expect(container.querySelector('[data-meta]')?.textContent).toBe(`review · 4 轮 · ${formatTurnTime(t, { at: chat().lastActive }, NOW)} · tmp`)
  })

  it('lists turns newest first as cards with visible sequence numbers: question with time and non-completed tags, answer; events as one line on a rail', () => {
    const entries = [turn(1), lostEvent(2), turn(3, { stopReason: 'aborted', freshSession: true, message: '再问一次', output: '' })]
    const { injected } = detailProps(fakeSource(detailSnapshot({ entries })))
    const { container } = render(<ChatDetail {...injected} />)
    expect([...container.querySelectorAll('li')].map(li => li.getAttribute('data-seq'))).toEqual(['3', '2', '1'])
    const row3 = container.querySelector('[data-seq="3"]') as HTMLElement
    expect(within(row3).getByText('已取消').closest('[data-tag]')?.getAttribute('data-tone')).toBe('neutral')
    expect(within(row3).getByText('新会话').closest('[data-tag]')?.getAttribute('data-tone')).toBe('info')
    expect(within(row3).getByText(formatTurnTime(t, turn(3), NOW))).toBeTruthy()
    expect(row3.querySelector('[data-answer]')?.textContent).toBe('(无回答文本)')
    expect(within(row3).getByText('#3')).toBeTruthy()
    expect((row3.querySelector('[data-panel-card]') as HTMLElement).style.borderRadius).toBe('10px')
    const header = container.querySelector('header') as HTMLElement
    const scrollBody = container.querySelector('[data-detail-scroll]') as HTMLElement
    expect(header.style.position).not.toBe('sticky')
    expect(scrollBody.contains(header)).toBe(false)
    expect(scrollBody.contains(row3)).toBe(true)
    const row1 = container.querySelector('[data-seq="1"]') as HTMLElement
    expect(row1.querySelector('[data-tag]')).toBeNull()
    expect(row1.querySelector('[data-question]')?.textContent).toBe('问题1')
    expect(row1.querySelector('[data-answer]')?.textContent).toBe('回答1')
    expect(within(row1).queryByText(/^[问答]$/)).toBeNull()
    const event = container.querySelector('[data-event="session-lost"]') as HTMLElement
    expect(event.querySelector('[data-tag]')).toBeNull()
    expect(event.textContent).toBe('远端会话已丢失,已新开会话' + formatTurnTime(t, lostEvent(2), NOW))
    expect((event.querySelector('[data-panel-card]') as HTMLElement).style.borderLeft).toMatch(/3px solid/)
  })

  it('puts a running entry on top with a spinner, its first two lines, and a live timer; the meta line switches to running', async () => {
    const running: RunningItem = { kind: 'running', startedAt: NOW - 80_000, message: `第一行\n第二行\n${'长文本'.repeat(80)}` }
    const source = fakeSource(detailSnapshot({ entries: [running, turn(1)] }))
    const { container } = render(<ChatDetail {...detailProps(source).injected} />)
    const top = container.querySelector('[data-live-section]') as HTMLElement
    expect(top.closest('ul')).toBeNull()
    expect(top.querySelector('[data-rail]')?.getAttribute('data-state')).toBe('running')
    expect(top.hasAttribute('data-running')).toBe(true)
    expect(top.querySelector('[data-dot]')?.getAttribute('data-dot')).toBe('ongoing')
    expect(top.querySelector('[data-running-preview]')?.textContent).toBe('第一行\n第二行…')
    expect(within(top).getByText('已运行 1分20秒')).toBeTruthy()
    expect(container.querySelector('[data-meta]')?.textContent).toBe('进行中 1分20秒 · tmp')
    await act(async () => { fireEvent.click(within(top).getByRole('button', { name: zh.liveShowPrompt })) })
    expect(top.querySelector('[data-running-full]')?.textContent).toBe(running.message)
    expect(source.loadEntry).not.toHaveBeenCalled()
  })

  it('ticks the running time each second, and runs no timer without a turn in flight', () => {
    vi.useFakeTimers({ now: NOW })
    const running: RunningItem = { kind: 'running', startedAt: NOW - 80_000, message: 'm' }
    const { container, unmount } = render(<ChatDetail {...detailProps(fakeSource(detailSnapshot({ entries: [running] }))).injected} />)
    act(() => { vi.advanceTimersByTime(3_000) })
    expect(container.querySelector('[data-meta]')?.textContent).toBe('进行中 1分23秒 · tmp')
    unmount()
    render(<ChatDetail {...detailProps(fakeSource(detailSnapshot({ entries: [turn(1)] }))).injected} />)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('shows a reconnect failure with the unsent message', () => {
    const failed: EventItem = { seq: 1, kind: 'event', event: 'reconnect-failed', at: NOW - 60_000 * 2, message: '继续', error: 'process exited' }
    const { container } = render(<ChatDetail {...detailProps(fakeSource(detailSnapshot({ entries: [failed] }))).injected} />)
    expect((container.querySelector('[data-event="reconnect-failed"]') as HTMLElement).textContent).toBe('重连失败:process exited · 未能发送:继续' + formatTurnTime(t, failed, NOW))
  })

  it('shows one grey line for an empty log, and none while loading', () => {
    const { unmount } = render(<ChatDetail {...detailProps(fakeSource(detailSnapshot())).injected} />)
    expect(screen.getByText('暂无轮次记录')).toBeTruthy()
    unmount()
    render(<ChatDetail {...detailProps(fakeSource({ status: 'loading', entries: [], total: 0 })).injected} />)
    expect(screen.queryByText('暂无轮次记录')).toBeNull()
    expect(screen.getByText('正在读取…')).toBeTruthy()
  })

  it('previews up to two question lines and three answer lines, clamped, and flags more as full text', () => {
    const long = turn(1, { message: '问一\n\n问二\n问三', output: '答一\n答二\n答三\n答四' })
    const fits = turn(2, { message: '问一\n问二', output: '答一\n答二\n答三' })
    const { container } = render(<ChatDetail {...detailProps(fakeSource(detailSnapshot({ entries: [long, fits] }))).injected} />)
    const q = container.querySelector('[data-seq="1"] [data-question]') as HTMLElement
    const a = container.querySelector('[data-seq="1"] [data-answer]') as HTMLElement
    expect(q.textContent).toBe('问一\n问二…')
    expect(a.textContent).toBe('答一\n答二\n答三…')
    expect(q.style.webkitLineClamp).toBe('2')
    expect(a.style.webkitLineClamp).toBe('3')
    expect(container.querySelector('[data-seq="1"] [data-full-hint]')?.textContent).toBe('全文 · 4 行')
    expect(container.querySelector('[data-seq="2"] [data-full-hint]')).toBeNull()
  })

  it('uses the shared times and hover titles for today, yesterday, earlier dates and a subsecond turn', () => {
    const now = new Date(2026, 10, 26, 17).getTime()
    for (const at of [now, now - 86400000, new Date(2026, 9, 1).getTime(), new Date(2025, 1, 1).getTime()]) {
      const row = turn(1, { at, startedAt: at - 300 })
      const view = render(<ChatDetail {...detailProps(fakeSource(detailSnapshot({ fetchedAt: now, entries: [row] }))).injected} />)
      expect(screen.getByText(formatTurnTime(t, row, now)).getAttribute('title')).toBe(formatTurnTimeTitle(t, row, now))
      view.unmount()
    }
  })

  it('cleans previews and renders both expanded bodies with the official HTML omission flag', () => {
    const row = turn(1, { message: '**任务**', output: '检查 <i>结果</i>' })
    const { container } = render(<ChatDetail {...detailProps(fakeSource(detailSnapshot({ entries: [row] }))).injected} />)
    expect(container.querySelector('[data-question]')?.textContent).toBe('任务')
    fireEvent.click(head(container, 1))
    const body = container.querySelector('[data-full="output"] [data-md="body"]')!
    expect(body.getAttribute('data-omit-html')).toBe('true')
    expect(body.textContent).toBe('检查 结果')
    expect(body.querySelector('i')).toBeNull()
  })

  it('rails a turn red for an error, orange for a stop short or a fresh-session answer, and none when it completed plainly', () => {
    const entries = [
      turn(1),
      turn(2, { stopReason: 'error' }),
      turn(3, { stopReason: 'aborted' }),
      turn(4, { stopReason: 'max-tokens' }),
      turn(5, { freshSession: true }),
    ]
    const { container } = render(<ChatDetail {...detailProps(fakeSource(detailSnapshot({ entries }))).injected} />)
    fireEvent.click(screen.getByRole('button', { name: /更早的 2 条记录/ }))
    const rail = (seq: number): [string | null, string] => {
      const row = container.querySelector(`[data-seq="${seq}"]`) as HTMLElement
      return [row.getAttribute('data-rail'), (row.querySelector('[data-panel-card]') as HTMLElement).style.borderLeft]
    }
    expect(rail(1)[0]).toBeNull()
    expect(rail(2)[0]).toBe('error')
    expect(rail(2)[1]).toMatch(/3px solid var\(--dsw-alias-state-error-primary\)/)
    for (const seq of [3, 4, 5]) {
      expect(rail(seq)[0]).toBe('warn')
      expect(rail(seq)[1]).toMatch(/3px solid var\(--dsw-alias-state-warn-primary\)/)
    }
  })

  it('ends the meta line with the cwd\'s last segment only', () => {
    expect(cwdName('/Users/me/Developer/dsh-acp-resume')).toBe('dsh-acp-resume')
    expect(cwdName('C:\\work\\repo\\')).toBe('repo')
    expect(cwdName('/')).toBe('/')
    const { container } = render(<ChatDetail {...detailProps(fakeSource(detailSnapshot({ chat: chat({ cwd: '/Users/me/Developer/dsh-acp-resume', turnCount: 12 }) }))).injected} />)
    expect(container.querySelector('[data-meta]')?.textContent).toBe(`12 轮 · ${formatTurnTime(t, { at: chat().lastActive }, NOW)} · dsh-acp-resume`)
    expect(screen.getByRole('heading', { level: 2 }).getAttribute('title')).toContain('cwd /Users/me/Developer/dsh-acp-resume')
  })

  it('marks a cut turn with "full text · N lines" at the end of the answer line, and a fully shown one with nothing', () => {
    const entries = [turn(1, { message: '一\n二\n三', messageMore: true }), turn(2, { message: '就一行', output: '也一行' })]
    const { container } = render(<ChatDetail {...detailProps(fakeSource(detailSnapshot({ entries }))).injected} />)
    expect(container.querySelector('[data-seq="1"] [data-full-hint]')?.textContent).toBe('展开全文')
    expect(container.querySelector('[data-seq="2"] [data-full-hint]')).toBeNull()
  })

  it('toggles a turn from its whole row (click or Enter), and the open turn ends with a collapse button', async () => {
    const { container } = render(<ChatDetail {...detailProps(fakeSource(detailSnapshot({ entries: [turn(1, { messageMore: true })] }))).injected} />)
    const row = head(container, 1)
    expect(row.getAttribute('role')).toBe('button')
    expect(row.getAttribute('tabindex')).toBe('0')
    expect(row.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { fireEvent.click(row) })
    expect(row.getAttribute('aria-expanded')).toBe('true')
    const reply = container.querySelector('[data-full="output"]') as HTMLElement
    fireEvent.mouseDown(reply)
    fireEvent.click(reply)
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect((container.querySelector('[data-full="message"]') as HTMLElement).style.maxHeight).toBe('160px')
    expect(container.querySelector('[data-seq="1"] [data-full-hint]')).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '收起第 1 条' })) })
    expect(row.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { fireEvent.keyDown(row, { key: 'Enter' }) })
    expect(row.getAttribute('aria-expanded')).toBe('true')
  })

  it('keeps at most one turn open: opening another closes the first', async () => {
    const { container } = render(<ChatDetail {...detailProps(fakeSource(detailSnapshot({ entries: [turn(1), turn(2)] }))).injected} />)
    await act(async () => { fireEvent.click(head(container, 1)) })
    expect(container.querySelectorAll('[data-open]')).toHaveLength(1)
    await act(async () => { fireEvent.click(head(container, 2)) })
    expect([...container.querySelectorAll('[data-open]')].map(li => li.getAttribute('data-seq'))).toEqual(['2'])
  })

  it('fetches the full text once when the preview is cut, and never when it is complete', async () => {
    const source = fakeSource(detailSnapshot({ entries: [turn(1, { message: '问…', output: '答…', messageMore: true, outputMore: true }), turn(2)] }))
    const { container } = render(<ChatDetail {...detailProps(source).injected} />)
    expect(container.querySelector('[data-full]')).toBeNull()
    await act(async () => { fireEvent.click(head(container, 1)) })
    expect(source.loadEntry).toHaveBeenCalledWith(1)
    expect(container.querySelector('[data-seq="1"] [data-full="message"]')?.textContent).toBe('完整问题1')
    expect(container.querySelector('[data-seq="1"] [data-full="output"]')?.textContent).toBe('完整回答1')
    await act(async () => { fireEvent.click(head(container, 1)) })
    await act(async () => { fireEvent.click(head(container, 1)) })
    expect(source.loadEntry).toHaveBeenCalledTimes(1)
    await act(async () => { fireEvent.click(head(container, 2)) })
    expect(source.loadEntry).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-seq="2"] [data-full="message"]')?.textContent).toBe('问题2')
  })

  it('hides the diagnostic behind its own toggle, and tags an error turn', async () => {
    const { container } = render(<ChatDetail {...detailProps(fakeSource(detailSnapshot({ entries: [turn(2, { stopReason: 'error', diagnostic: 'stage: prompt' })] }))).injected} />)
    expect(within(container.querySelector('[data-seq="2"]') as HTMLElement).getByText('出错').closest('[data-tag]')?.getAttribute('data-tone')).toBe('danger')
    await act(async () => { fireEvent.click(head(container, 2)) })
    expect(container.querySelector('[data-diagnostic]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '查看诊断' }))
    expect(container.querySelector('[data-diagnostic]')?.textContent).toBe('stage: prompt')
    fireEvent.click(screen.getByRole('button', { name: '隐藏诊断' }))
    expect(container.querySelector('[data-diagnostic]')).toBeNull()
  })

  it('renders a quota-exhausted turn with warning tag, orange rail, zh/en copy, and counts it as warning rather than error (D50)', () => {
    const now = new Date(2026, 10, 26, 12).getTime()
    const day = 86400000
    const entries = [
      turn(1, { stopReason: 'error', failureKind: 'quota', at: now - 2 * day }),
      turn(2, { stopReason: 'error', at: now - day }),
      turn(3, { at: now - 30_000 }),
      turn(4, { at: now - 20_000 }),
      turn(5, { stopReason: 'error', failureKind: 'quota', at: now - 10_000 }),
    ]
    const view = render(<ChatDetail {...detailProps(fakeSource(detailSnapshot({ entries, fetchedAt: now }))).injected} />)

    // Recent quota turn (#5): warning tone tag + orange rail (not danger/red).
    const recentQuota = view.container.querySelector('[data-seq="5"]') as HTMLElement
    const zhTag = within(recentQuota).getByText(zh.stopQuota).closest('[data-tag]') as HTMLElement
    expect(zhTag.textContent).toBe('额度耗尽')
    expect(zhTag.getAttribute('data-tone')).toBe('warning')
    expect(recentQuota.getAttribute('data-rail')).toBe('warn')
    expect((recentQuota.querySelector('[data-panel-card]') as HTMLElement).style.borderLeft).toMatch(/3px solid var\(--dsw-alias-state-warn-primary\)/)

    // Folded earlier history (#1 quota + #2 generic error): 1 failed, 1 need attention (quota counted under warning, not error).
    const earlier = within(view.container.querySelector('[data-earlier]') as HTMLElement)
    expect(earlier.getByText('1 出错')).toBeTruthy()
    expect(earlier.getByText('1 需留意')).toBeTruthy()

    // English copy check.
    view.rerender(<ChatDetail {...detailProps(fakeSource(detailSnapshot({ entries, fetchedAt: now })), { t: translator(en) }).injected} />)
    const enQuota = view.container.querySelector('[data-seq="5"]') as HTMLElement
    const enTag = within(enQuota).getByText(en.stopQuota).closest('[data-tag]') as HTMLElement
    expect(enTag.textContent).toBe('quota used up')
    expect(enTag.getAttribute('data-tone')).toBe('warning')
    expect(enQuota.getAttribute('data-rail')).toBe('warn')
    const enEarlier = within(view.container.querySelector('[data-earlier]') as HTMLElement)
    expect(enEarlier.getByText('1 failed')).toBeTruthy()
    expect(enEarlier.getByText('1 need attention')).toBeTruthy()
  })

  it('shows the failure when the full text cannot be read, keeping the preview', async () => {
    const source = fakeSource(detailSnapshot({ entries: [turn(1, { message: '问…', messageMore: true })] }), async () => { throw new Error('acp-resume/unknown-turn: trimmed') })
    const { container } = render(<ChatDetail {...detailProps(source).injected} />)
    await act(async () => { fireEvent.click(head(container, 1)) })
    expect(screen.getByRole('alert').textContent).toBe('读取全文失败:acp-resume/unknown-turn: trimmed')
    expect(container.querySelector('[data-full="message"]')?.textContent).toBe('问…')
  })

  it('keeps four entries visible and folds older days, counts and paging below the newest three', () => {
    const now = new Date(2026, 10, 26, 12).getTime()
    const day = 86400000
    const rows = [lostEvent(1), turn(2, { stopReason: 'error' }), turn(3), turn(4), turn(5)]
      .map((item, i) => ({ ...item, at: now - (i === 0 ? 2 : i === 1 ? 1 : 0) * day }))
    const view = render(<ChatDetail {...detailProps(fakeSource(detailSnapshot({ entries: rows.slice(1), fetchedAt: now }))).injected} />)
    expect(view.container.querySelectorAll('li[data-seq]')).toHaveLength(4)
    expect(view.container.querySelector('[data-earlier]')).toBeNull()
    const source = fakeSource(detailSnapshot({ entries: rows, total: 8, fetchedAt: now }))
    view.rerender(<ChatDetail {...detailProps(source).injected} />)
    expect([...view.container.querySelectorAll('li[data-seq]')].map(el => el.getAttribute('data-seq'))).toEqual(['5','4','3'])
    const earlier = within(view.container.querySelector('[data-earlier]') as HTMLElement)
    expect(earlier.getByText('1 出错')).toBeTruthy()
    expect(earlier.getByText('1 事件')).toBeTruthy()
    expect(earlier.getByText('+3 条未加载')).toBeTruthy()
    expect(earlier.getByText('11-24 12:00 – 昨天 12:00')).toBeTruthy()
    expect(screen.queryByText('加载更早的记录')).toBeNull()
    fireEvent.click(earlier.getByRole('button', { name: /更早的 2 条记录/ }))
    expect(earlier.getAllByRole('heading').map(el => el.textContent)).toEqual(['昨天', '11-24'])
    fireEvent.click(earlier.getByText('加载更早的记录'))
    expect(source.loadMore).toHaveBeenCalledTimes(1)
  })

  it('offers older entries when the log holds more than is shown', () => {
    const source = fakeSource(detailSnapshot({ entries: [turn(5), turn(6)], total: 6 }))
    render(<ChatDetail {...detailProps(source).injected} />)
    expect(screen.getByText('显示最近 2 / 共 6 条')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '加载更早的记录' }))
    expect(source.loadMore).toHaveBeenCalledTimes(1)
  })

  it('shows no load-more when everything is shown', () => {
    render(<ChatDetail {...detailProps(fakeSource(detailSnapshot({ entries: [turn(1)], total: 1 }))).injected} />)
    expect(screen.queryByRole('button', { name: '加载更早的记录' })).toBeNull()
  })

  it('shows a load error above the kept data', () => {
    render(<ChatDetail {...detailProps(fakeSource(detailSnapshot({ status: 'error', error: 'HTTP 502', entries: [turn(1)] }))).injected} />)
    expect(screen.getByRole('alert').textContent).toBe('读取失败:HTTP 502')
    expect(screen.getByText('问题1')).toBeTruthy()
  })

  it('offers release, a separator, and delete in the ⋯ menu; release acts at once while idle and is disabled once released', async () => {
    const source = fakeSource(detailSnapshot())
    const { injected } = detailProps(source)
    const { unmount } = render(<ChatDetail {...injected} />)
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
    const menu = screen.getByRole('menu')
    expect([...menu.children].map(el => el.hasAttribute('data-separator') ? '—' : el.textContent)).toEqual(['释放进程', '—', '删除记录…'])
    expect(within(menu).getByRole('menuitem', { name: '删除记录…' }).hasAttribute('data-danger')).toBe(true)
    await act(async () => { fireEvent.click(within(menu).getByRole('menuitem', { name: '释放进程' })) })
    expect(injected.close).toHaveBeenCalledWith(`chat-${UUID_A}`)
    expect(source.refresh).toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
    unmount()
    render(<ChatDetail {...detailProps(fakeSource(detailSnapshot({ chat: chat({ active: false }) }))).injected} />)
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
    expect((screen.getByRole('menuitem', { name: '释放进程' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('asks before releasing while a turn is in flight; confirm releases without closing the tab', async () => {
    const { injected, info } = detailProps(fakeSource(detailSnapshot({ entries: [{ kind: 'running', message: '长任务', startedAt: NOW - 5_000 }] })))
    render(<ChatDetail {...injected} />)
    pick('释放进程')
    const dialog = screen.getByRole('dialog', { name: '释放 chat-a1b2c3d4?' })
    expect(within(dialog).getByText('将中止正在运行的本轮任务并释放进程(历史记录保留,后续仍可重连)。')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(injected.close).not.toHaveBeenCalled()
    pick('释放进程')
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '释放' })) })
    expect(injected.close).toHaveBeenCalledWith(`chat-${UUID_A}`)
    expect(injected.purge).not.toHaveBeenCalled()
    expect(info.closeTab).not.toHaveBeenCalled()
  })

  it('asks before deleting; cancel deletes nothing; confirming purges and closes the tab', async () => {
    const { injected, info } = detailProps(fakeSource(detailSnapshot()))
    render(<ChatDetail {...injected} />)
    pick('删除记录…')
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }))
    expect(injected.purge).not.toHaveBeenCalled()
    pick('删除记录…')
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除' })) })
    expect(injected.purge).toHaveBeenCalledWith(`chat-${UUID_A}`)
    expect(info.closeTab).toHaveBeenCalledTimes(1)
  })

  it('a failed delete keeps the tab open and shows the failure', async () => {
    const { injected, info } = detailProps(fakeSource(detailSnapshot()), { purge: vi.fn(async () => { throw new Error('acp-resume/unknown-chat: x') }) })
    render(<ChatDetail {...injected} />)
    pick('删除记录…')
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除' })) })
    expect(screen.getByRole('alert').textContent).toBe('操作失败:acp-resume/unknown-chat: x')
    expect(info.closeTab).not.toHaveBeenCalled()
  })

  it('a chat the host no longer knows shows a gone notice with a close-tab button', () => {
    const { injected, info } = detailProps(fakeSource({ status: 'gone', entries: [], total: 0, error: 'acp-resume/unknown-chat: x' }))
    render(<ChatDetail {...injected} />)
    expect(screen.getByText('该会话已删除')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '关闭页签' }))
    expect(info.closeTab).toHaveBeenCalledTimes(1)
  })

  it('two tabs of different chats keep separate sources and state', async () => {
    const a = fakeSource(detailSnapshot({ entries: [turn(1, { message: '甲…', messageMore: true })] }))
    const b = fakeSource(detailSnapshot({ chat: chat({ chatId: `chat-${UUID_B}`, label: '乙' }), entries: [turn(1, { message: '乙问' })] }))
    const first = detailProps(a, { sourceFor: id => (id === `chat-${UUID_A}` ? a : b) })
    const second = detailProps(b, { sourceFor: id => (id === `chat-${UUID_A}` ? a : b) }, tabInfo(chatAddress(`chat-${UUID_B}`)))
    const { container } = render(<><ChatDetail {...first.injected} /><ChatDetail {...second.injected} /></>)
    expect(screen.getByText('乙')).toBeTruthy()
    await act(async () => { fireEvent.click(head(container, 1)) })
    expect(a.loadEntry).toHaveBeenCalledTimes(1)
    expect(b.loadEntry).not.toHaveBeenCalled()
  })

  it('renders in English too', () => {
    const { injected } = detailProps(fakeSource(detailSnapshot({ entries: [turn(1, { message: 'a\nb', messageMore: true })] })), { t: translator(en) })
    const { container } = render(<ChatDetail {...injected} />)
    expect(screen.getByText('Turn history')).toBeTruthy()
    expect(container.querySelector('[data-meta]')?.textContent).toBe(`2 turns · ${formatTurnTime(translator(en), { at: chat().lastActive }, NOW)} · tmp`)
    expect(within(container.querySelector('[data-seq="1"]') as HTMLElement).getByText(formatTurnTime(translator(en), turn(1), NOW))).toBeTruthy()
    expect(container.querySelector('[data-full-hint]')?.textContent).toBe('Show full text')
    expect(screen.getByRole('button', { name: 'More actions' })).toBeTruthy()
  })

  it('an address that names no chat shows a notice instead of throwing', () => {
    const { injected } = detailProps(fakeSource(detailSnapshot()), {}, tabInfo('dsh-resource://acp-resume-chat/'))
    render(<ChatDetail {...injected} />)
    expect(screen.getByRole('alert').textContent).toBe('该会话已删除')
  })

  it('splits the fixed header from an isolated scroll container, contains RunningWorkspace, and injects static code-banner and offscreen pause CSS (D49)', () => {
    const running: RunningItem = { kind: 'running', startedAt: NOW - 5_000, message: '执行任务' }
    const { container } = render(<ChatDetail {...detailProps(fakeSource(detailSnapshot({ entries: [running, turn(1)] }))).injected} />)
    const root = container.querySelector('section[data-chat-id]') as HTMLElement
    const header = container.querySelector('header') as HTMLElement
    const scrollBody = container.querySelector('[data-detail-scroll]') as HTMLElement
    const liveSection = container.querySelector('[data-live-section]') as HTMLElement
    const styleEl = container.querySelector('style') as HTMLStyleElement

    expect(root.style.overflow).toBe('hidden')
    expect(header.style.position).not.toBe('sticky')
    expect(header.style.flex).toBe('0 0 auto')
    expect(scrollBody.contains(header)).toBe(false)
    expect(scrollBody.contains(styleEl)).toBe(false)
    expect(scrollBody.style.overflowY).toBe('auto')
    expect(scrollBody.style.isolation).toBe('isolate')
    expect(scrollBody.contains(liveSection)).toBe(true)
    expect(liveSection.style.contain).toBe('layout paint')
    expect(styleEl.textContent).toContain('.md-code-block > :has(> [data-code-block-banner]) { position: static; z-index: auto; }')
    expect(styleEl.textContent).toContain('[data-detail-offscreen]')
    expect(styleEl.textContent).toContain('animation-play-state: paused !important')
  })

  it('pauses RunningWorkspace shimmer/animations and offscreen scroll updates via IntersectionObserver and tab visibility (D49)', () => {
    let observerCallback: IntersectionObserverCallback | undefined
    let observedRoot: Element | Document | null | undefined
    const observedTargets: Element[] = []
    const disconnect = vi.fn()
    class MockIntersectionObserver {
      constructor(cb: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        observerCallback = cb
        observedRoot = options?.root
      }
      observe(el: Element) { observedTargets.push(el) }
      unobserve() {}
      disconnect() { disconnect() }
      takeRecords() { return [] }
      readonly root = null
      readonly rootMargin = ''
      readonly thresholds = []
    }
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)

    const running: RunningItem = { kind: 'running', startedAt: NOW - 5_000, message: '长任务' }
    let push!: (frame: LiveFrame) => void
    const follow: FollowTurn = (_id, _at, listener) => { push = listener; return () => {} }
    const base = detailProps(fakeSource(detailSnapshot({ entries: [running, turn(1)] })), { followTurn: follow }).injected
    const renderDetail = (visible: boolean) => <ChatDetail {...base} useTabInfo={() => ({ tab: { ...base.useTabInfo().tab, visible } })} />

    const view = render(renderDetail(true))
    const header = view.container.querySelector('header') as HTMLElement
    const scrollBody = view.container.querySelector('[data-detail-scroll]') as HTMLElement
    const liveSection = view.container.querySelector('[data-live-section]') as HTMLElement

    expect(observedRoot).toBe(scrollBody)
    expect(observedTargets).toContain(liveSection)
    expect(header.hasAttribute('data-detail-offscreen')).toBe(false)
    expect(liveSection.hasAttribute('data-detail-offscreen')).toBe(false)
    expect(liveSection.querySelector('[data-shimmer="true"]')?.textContent).toBe(zh.liveRunning)

    // Expand live viewport so we also cover LiveViewport's shimmer + scrollTop pause while offscreen.
    fireEvent.click(screen.getByRole('button', { name: zh.runningExpand }))
    const box = view.container.querySelector('[data-live-output]') as HTMLElement
    expect(box.querySelector('[data-shimmer="true"]')?.textContent).toBe(zh.liveWaiting)
    Object.defineProperties(box, { scrollHeight: { value: 300, configurable: true }, clientHeight: { value: 100 } })
    box.scrollTop = 0

    // Scroll RunningWorkspace out of the detail scrollport: animations pause, shimmer unmounts, scrollTop stays untouched.
    act(() => {
      observerCallback?.([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver)
    })
    expect(liveSection.hasAttribute('data-detail-offscreen')).toBe(true)
    expect(liveSection.querySelector('[data-shimmer="true"]')).toBeNull()
    expect(header.hasAttribute('data-detail-offscreen')).toBe(false)
    act(() => { push({ kind: 'snapshot', seq: 1, text: '第一段输出', truncated: false }) })
    expect(box.scrollTop).toBe(0)

    // Scroll RunningWorkspace back into view: shimmer resumes and LiveViewport snaps to bottom.
    act(() => {
      observerCallback?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
    })
    expect(liveSection.hasAttribute('data-detail-offscreen')).toBe(false)
    expect(liveSection.querySelector('[data-shimmer="true"]')?.textContent).toBe(zh.liveRunning)
    expect(box.scrollTop).toBe(300)

    // Hide the whole tab: both header and live section mark offscreen so animations pause.
    view.rerender(renderDetail(false))
    expect(header.hasAttribute('data-detail-offscreen')).toBe(true)
    expect(liveSection.hasAttribute('data-detail-offscreen')).toBe(true)
    expect(liveSection.querySelector('[data-shimmer="true"]')).toBeNull()

    view.unmount()
    expect(disconnect).toHaveBeenCalledTimes(1)
  })
})

describe('ChatDetailTitle', () => {
  it('shows the label when there is one, else the short id', () => {
    const labelled = detailProps(fakeSource(detailSnapshot()))
    const { container, unmount } = render(<ChatDetailTitle features={defaultFeatureStore} useTabInfo={labelled.injected.useTabInfo} sourceFor={labelled.injected.sourceFor} />)
    expect(container.textContent).toBe('审阅')
    unmount()
    const bare = detailProps(fakeSource(detailSnapshot({ chat: chat() })))
    const second = render(<ChatDetailTitle features={defaultFeatureStore} useTabInfo={bare.injected.useTabInfo} sourceFor={bare.injected.sourceFor} />)
    expect(second.container.textContent).toBe('chat-a1b2c3d4')
  })
})

/** Mock carrier for the detail source: `acpResume/turns` and `acpResume/turn`. */
function detailRpc(handlers: { turns?: (args: Record<string, unknown>) => PanelRpcResult | Promise<PanelRpcResult>; turn?: (args: Record<string, unknown>) => PanelRpcResult } = {}) {
  const calls: [string, string, { args: Record<string, unknown> }][] = []
  const rpc: PanelRpc & { calls: typeof calls } = {
    calls,
    call: vi.fn(async (channel: string, endpoint: string, payload: unknown): Promise<PanelRpcResult> => {
      if (endpoint === 'acpResumeInfo/features') return { ok: true, value: defaultFeatureView.features }
      const body = payload as { args: Record<string, unknown> }
      calls.push([channel, endpoint, body])
      if (endpoint === 'acpResume/turns') {
        return handlers.turns?.(body.args) ?? { ok: true, value: { chat: chat(), entries: [turn(1)], total: 1 } }
      }
      if (endpoint === 'acpResume/turn') return handlers.turn?.(body.args) ?? { ok: true, value: { seq: 1, kind: 'turn', message: 'm', output: 'o' } }
      return { ok: true, value: null }
    }),
  }
  return rpc
}

describe('ChatDetailSource', () => {
  it('fetches turns for its chat on the first subscription, polls while subscribed, and stops after the last leaves', async () => {
    vi.useFakeTimers()
    const rpc = detailRpc()
    const source = new ChatDetailSource(rpc, `chat-${UUID_A}`, () => NOW)
    expect(source.getSnapshot().status).toBe('loading')
    const stop = source.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(rpc.calls).toEqual([['/api', 'acpResume/turns', { args: { chatId: `chat-${UUID_A}`, limit: DETAIL_PAGE } }]])
    expect(source.getSnapshot()).toEqual({ status: 'ready', chat: chat(), entries: [turn(1)], total: 1, fetchedAt: NOW })
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(rpc.calls).toHaveLength(2)
    stop()
    await vi.advanceTimersByTimeAsync(3 * POLL_INTERVAL_MS)
    expect(rpc.calls).toHaveLength(2)
  })

  it('does not poll before anyone subscribes', async () => {
    vi.useFakeTimers()
    const rpc = detailRpc()
    new ChatDetailSource(rpc, 'chat-x')
    await vi.advanceTimersByTimeAsync(3 * POLL_INTERVAL_MS)
    expect(rpc.calls).toHaveLength(0)
  })

  it('loadMore raises the limit by a page, up to the host ceiling of 200', async () => {
    const rpc = detailRpc()
    const source = new ChatDetailSource(rpc, 'chat-x', () => NOW)
    await source.loadMore()
    await source.loadMore()
    await source.loadMore()
    await source.loadMore()
    await source.loadMore()
    expect(rpc.calls.map(c => c[2].args.limit)).toEqual([100, 150, 200, 200, 200])
  })

  it('reads one entry in full with the chatId and seq', async () => {
    const rpc = detailRpc({ turn: () => ({ ok: true, value: { seq: 7, kind: 'turn', message: '全文问', output: '全文答' } }) })
    const source = new ChatDetailSource(rpc, 'chat-x')
    await expect(source.loadEntry(7)).resolves.toEqual({ seq: 7, kind: 'turn', message: '全文问', output: '全文答' })
    expect(rpc.calls).toEqual([['/api', 'acpResume/turn', { args: { chatId: 'chat-x', seq: 7 } }]])
  })

  it('rejects a failed entry read with the host code', async () => {
    const rpc = detailRpc({ turn: () => ({ ok: false, error: { code: 'acp-resume/unknown-turn', message: 'gone' } }) })
    await expect(new ChatDetailSource(rpc, 'chat-x').loadEntry(1)).rejects.toThrow('acp-resume/unknown-turn: gone')
  })

  it('publishes gone and stops polling when the host reports the chat unknown', async () => {
    vi.useFakeTimers()
    const rpc = detailRpc({ turns: () => ({ ok: false, error: { code: 'acp-resume/unknown-chat', message: 'acp-resume: unknown chat x' } }) })
    const source = new ChatDetailSource(rpc, 'chat-x')
    source.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(source.getSnapshot()).toMatchObject({ status: 'gone', entries: [], total: 0 })
    await vi.advanceTimersByTimeAsync(3 * POLL_INTERVAL_MS)
    expect(rpc.calls).toHaveLength(1)
  })

  it('keeps the last good data under an error status when a refresh fails', async () => {
    let fail = false
    const rpc = detailRpc({ turns: () => {
      if (fail) throw new Error('transport failure: HTTP 502')
      return { ok: true, value: { chat: chat(), entries: [turn(1)], total: 1 } }
    } })
    const source = new ChatDetailSource(rpc, 'chat-x', () => NOW)
    await source.refresh()
    fail = true
    await source.refresh()
    expect(source.getSnapshot()).toEqual({
      status: 'error', chat: chat(), entries: [turn(1)], total: 1, fetchedAt: NOW, error: 'transport failure: HTTP 502',
    })
  })

  it('rejects an answer without a chat as an error, and drops stale answers and everything after dispose', async () => {
    const answers: ((value: PanelRpcResult) => void)[] = []
    const rpc: PanelRpc = { call: () => new Promise((resolve) => { answers.push(resolve) }) }
    const source = new ChatDetailSource(rpc, 'chat-x', () => NOW)
    const first = source.refresh()
    const second = source.refresh()
    answers[1]?.({ ok: true, value: { chat: chat({ cwd: '/new' }), entries: [], total: 0 } })
    answers[0]?.({ ok: true, value: { chat: chat({ cwd: '/old' }), entries: [], total: 0 } })
    await Promise.all([first, second])
    expect(source.getSnapshot().chat?.cwd).toBe('/new')
    const third = source.refresh()
    answers[2]?.({ ok: true, value: null })
    await third
    expect(source.getSnapshot()).toMatchObject({ status: 'error', error: 'acpResume/turns returned no detail' })
    const fourth = source.refresh()
    source.dispose()
    answers[3]?.({ ok: true, value: { chat: chat({ cwd: '/late' }), entries: [], total: 0 } })
    await fourth
    expect(source.getSnapshot().chat?.cwd).toBe('/new')
  })
})

describe('ChatDetailSource snapshot stability (D21)', () => {
  it('keeps the same snapshot reference across unchanged polls and publishes a new one on change', async () => {
    vi.useFakeTimers()
    let value: { chat: PanelChat; entries: (TurnItem | EventItem)[]; total: number } = { chat: chat(), entries: [turn(1)], total: 1 }
    const rpc = detailRpc({ turns: () => ({ ok: true, value }) })
    const notified: number[] = []
    const source = new ChatDetailSource(rpc, `chat-${UUID_A}`, () => NOW)
    source.subscribe(() => { notified.push(1) })
    await vi.advanceTimersByTimeAsync(0)
    const first = source.getSnapshot()
    expect(notified).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(source.getSnapshot()).toBe(first)
    expect(notified).toHaveLength(1)
    // A new turn changes the content → new reference, one notification.
    value = { chat: chat({ turnCount: 2 }), entries: [turn(1), turn(2)], total: 2 }
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(source.getSnapshot()).not.toBe(first)
    expect(source.getSnapshot().entries).toHaveLength(2)
    expect(notified).toHaveLength(2)
  })

  it('backs off to the idle interval after unchanged polls and resets to fast on a change', async () => {
    vi.useFakeTimers()
    let value: { chat: PanelChat; entries: (TurnItem | EventItem)[]; total: number } = { chat: chat(), entries: [turn(1)], total: 1 }
    const rpc = detailRpc({ turns: () => ({ ok: true, value }) })
    const source = new ChatDetailSource(rpc, 'chat-x', () => NOW, POLL_INTERVAL_MS, IDLE_POLL_INTERVAL_MS)
    source.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < QUIET_POLLS_BEFORE_BACKOFF; i += 1) await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    const idle = rpc.calls.filter(c => c[1] === 'acpResume/turns').length
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(rpc.calls.filter(c => c[1] === 'acpResume/turns')).toHaveLength(idle)
    await vi.advanceTimersByTimeAsync(IDLE_POLL_INTERVAL_MS - POLL_INTERVAL_MS)
    expect(rpc.calls.filter(c => c[1] === 'acpResume/turns')).toHaveLength(idle + 1)
    // loadMore is a deliberate widen: fast cadence resumes.
    value = { chat: chat(), entries: [turn(1), turn(2)], total: 2 }
    await source.loadMore()
    const afterLoad = rpc.calls.filter(c => c[1] === 'acpResume/turns').length
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(rpc.calls.filter(c => c[1] === 'acpResume/turns')).toHaveLength(afterLoad + 1)
  })

  it('publishes the gone status even though its content differs from a prior ready snapshot', async () => {
    vi.useFakeTimers()
    let gone = false
    const rpc = detailRpc({ turns: () => gone
      ? { ok: false, error: { code: 'acp-resume/unknown-chat', message: 'gone' } }
      : { ok: true, value: { chat: chat(), entries: [turn(1)], total: 1 } } })
    const source = new ChatDetailSource(rpc, 'chat-x', () => NOW)
    source.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(source.getSnapshot().status).toBe('ready')
    gone = true
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(source.getSnapshot().status).toBe('gone')
  })

  it('keeps the same snapshot reference across unchanged polls while a running entry is present, without backing off (D49)', async () => {
    vi.useFakeTimers()
    let tick = NOW
    const running: RunningItem = { kind: 'running', startedAt: NOW - 5_000, message: '执行中' }
    const rpc = detailRpc({ turns: () => ({ ok: true, value: { chat: chat(), entries: [running, turn(1)], total: 1 } }) })
    const notified: number[] = []
    const source = new ChatDetailSource(rpc, 'chat-x', () => tick, POLL_INTERVAL_MS, IDLE_POLL_INTERVAL_MS)
    source.subscribe(() => { notified.push(1) })
    await vi.advanceTimersByTimeAsync(0)
    const first = source.getSnapshot()
    expect(notified).toHaveLength(1)
    for (let i = 0; i < QUIET_POLLS_BEFORE_BACKOFF + 2; i += 1) {
      tick += POLL_INTERVAL_MS
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    }
    expect(source.getSnapshot()).toBe(first)
    expect(notified).toHaveLength(1)
    expect(rpc.calls.filter(c => c[1] === 'acpResume/turns')).toHaveLength(QUIET_POLLS_BEFORE_BACKOFF + 3)
  })
})

describe('snapshot-equal (D21)', () => {
  it('chatEqual compares every rendered field, including ownerSessionId', () => {
    const base = chat({ label: 'x', title: 't', turnCount: 3, ownerSessionId: 's1' })
    expect(chatEqual(base, { ...base })).toBe(true)
    for (const diff of [{ label: 'y' }, { title: 'u' }, { turnCount: 4 }, { active: false }, { lastActive: base.lastActive + 1 }, { cwd: '/z' }, { remoteSessionId: 'r2' }, { ownerSessionId: 's2' }, { backend: 'review' }, { backendCount: 2 }] as Partial<PanelChat>[]) {
      expect(chatEqual(base, { ...base, ...diff })).toBe(false)
    }
  })

  it('chatEqual tracks backend, role and latestTurn', () => {
    const base = chat({
      backend: 'default',
      backendCount: 2,
      role: 'coder',
      latestTurn: { seq: 1, startedAt: NOW - 10_000, at: NOW - 5_000, message: 'm', output: 'o', stopReason: 'completed', freshSession: false },
    })
    expect(chatEqual(base, { ...base, latestTurn: { ...base.latestTurn! } })).toBe(true)
    expect(chatEqual(base, { ...base, backend: 'review' })).toBe(false)
    expect(chatEqual(base, { ...base, backendCount: 1 })).toBe(false)
    expect(chatEqual(base, { ...base, backendDisplay: 'kiro-cli' })).toBe(false)
    expect(chatEqual(base, { ...base, attention: 'error' })).toBe(false)
    expect(chatEqual(base, { ...base, lastCompleted: true })).toBe(false)
    expect(chatEqual(base, { ...base, role: 'reviewer' })).toBe(false)
    expect(chatEqual(base, { ...base, role: undefined })).toBe(false)
    expect(chatEqual(base, { ...base, latestTurn: { ...base.latestTurn!, output: 'changed' } })).toBe(false)
    expect(chatEqual(base, { ...base, latestTurn: undefined })).toBe(false)
  })

  it('chatsEqual is order- and length-sensitive', () => {
    const a = chat({ chatId: 'c1' })
    const b = chat({ chatId: 'c2' })
    expect(chatsEqual([a, b], [a, b])).toBe(true)
    expect(chatsEqual([a, b], [b, a])).toBe(false)
    expect(chatsEqual([a], [a, b])).toBe(false)
  })

  it('listSnapshotEqual ignores fetchedAt but tracks status, error, and rows', () => {
    const rows = [chat()]
    expect(listSnapshotEqual({ status: 'ready', chats: rows, fetchedAt: 1 }, { status: 'ready', chats: [chat()], fetchedAt: 999 })).toBe(true)
    expect(listSnapshotEqual({ status: 'ready', chats: rows }, { status: 'error', chats: rows })).toBe(false)
    expect(listSnapshotEqual({ status: 'error', chats: rows, error: 'a' }, { status: 'error', chats: rows, error: 'b' })).toBe(false)
    expect(listSnapshotEqual({ status: 'ready', chats: [chat()] }, { status: 'ready', chats: [chat({ turnCount: 1 })] })).toBe(false)
  })

  it('detailSnapshotEqual ignores fetchedAt but tracks entries, chat, total, status', () => {
    const base = { status: 'ready' as const, chat: chat(), entries: [turn(1)], total: 1 }
    expect(detailSnapshotEqual({ ...base, fetchedAt: 1 }, { ...base, chat: chat(), entries: [turn(1)], fetchedAt: 2 })).toBe(true)
    expect(detailSnapshotEqual(base, { ...base, total: 2 })).toBe(false)
    expect(detailSnapshotEqual(base, { ...base, entries: [turn(1), turn(2)] })).toBe(false)
    expect(detailSnapshotEqual(base, { ...base, entries: [turn(1, { output: 'changed' })] })).toBe(false)
    expect(detailSnapshotEqual(base, { ...base, entries: [turn(1, { outputLines: 12 })] })).toBe(false)
    expect(detailSnapshotEqual(base, { status: 'ready', entries: [turn(1)], total: 1 })).toBe(false)
  })
})


describe('D44 per-chat controls', () => {
  it.each([['zh', zh], ['en', en]] as const)('renders the three reported agy catalogs and refreshes once per selection in %s', async (_, copy) => {
    let model = neon
    const read = vi.fn(async () => ({ backend: 'agy', supported: true, canChange: true, ...readSessionChoices({ configOptions: configOptions(model) }) }))
    const change = vi.fn(async (_id: string, field: 'model' | 'effort', value: string) => { if (field === 'model') model = value })
    const settings = { read, change }
    render(<ChatsPanel {...props(ready([chat()]), { settings, t: translator(copy) })} />)
    expect(read).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(copy.sessionSettings) }))
    const modelInput = await screen.findByRole('combobox', { name: copy.sessionModel })
    const effortLabels = () => within(screen.getByRole('combobox', { name: copy.sessionEffort })).getAllByRole('option').map(option => option.textContent)
    expect(effortLabels()).toEqual(['Low', 'Medium', 'High', 'Extra'])
    expect((modelInput as HTMLSelectElement).selectedOptions[0]?.text).toBe('Gemini 4 Neon')
    await act(async () => { fireEvent.change(modelInput, { target: { value: sonnet } }) })
    expect((modelInput as HTMLSelectElement).selectedOptions[0]?.text).toBe('Claude Sonnet 5.5')
    expect(effortLabels()).toEqual(['Low', 'Medium', 'High'])
    await act(async () => { fireEvent.change(modelInput, { target: { value: orchestrator } }) })
    expect((modelInput as HTMLSelectElement).selectedOptions[0]?.text).toBe('Orchestrator (Neon)')
    expect(screen.queryByRole('combobox', { name: copy.sessionEffort })).toBeNull()
    expect(screen.getByText(copy.sessionEffort + ' · ' + copy.effortNotOffered)).toBeTruthy()
    expect(read).toHaveBeenCalledTimes(3)
    expect(change).toHaveBeenCalledTimes(2)
  })

  it('renders disabled selectors during a turn and explanations for released and Codex chats', async () => {
    const show = async (data: ChatOptions, active: boolean) => {
      const inFlight = data.reason === 'running' ? { chatId: 'a', startedAt: NOW, message: 'test' } : undefined
      render(<ChatsPanel {...props(ready([chat({ active, inFlight })]), {
        settings: { read: async () => data, change: vi.fn() }, t: translator(en),
      })} />)
      if (!active) fireEvent.click(screen.getByRole('button', { name: /^Released \(1\)/ }))
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Settings for this chat/ })) })
    }
    await show({ ...readSessionChoices({ configOptions: configOptions(neon) }), supported: true, canChange: false, backend: 'agy', reason: 'running' }, true)
    expect(screen.getAllByRole('combobox').every(el => (el as HTMLSelectElement).disabled)).toBe(true)
    expect(screen.getByText(en.switchRunning)).toBeTruthy()
    cleanup()
    await show({ supported: true, canChange: false, backend: 'agy', reason: 'released' }, false)
    expect(screen.getByText(en.switchReleased)).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
    cleanup()
    await show({ supported: false, canChange: false, backend: 'codex', reason: 'codex session-level switch is not available yet' }, true)
    expect(screen.getByText(en.switchUnsupported)).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('localizes only the old host signature or missing new endpoint and never resends a legacy command', async () => {
    for (const method of ['close', 'purge', 'chatOptions', 'setChatModel', 'setChatEffort'] as const) {
      const failures = [{ code: 'gateway/arguments-invalid', message: 'args fields do not match the descriptor: unexpected "sessionId"' }]
      if (method !== 'close' && method !== 'purge') failures.push({ code: 'gateway/invocation-unavailable', message: 'no active Remote method' })
      for (const error of failures) {
        const call = vi.fn<PanelRpc['call']>(async () => ({ ok: false, error }))
        const cause = await callPanel({ call }, method, { chatId: 'a', sessionId: 'owner' }).catch(e => e)
        expect(panelActionError(cause, translator(zh))).toBe(zh.restartForChatActions)
        expect(panelActionError(cause, translator(en))).toBe(en.restartForChatActions)
        expect(call).toHaveBeenCalledTimes(1)
      }
    }
    const call = vi.fn<PanelRpc['call']>(async () => ({ ok: false, error: { code: 'gateway/arguments-invalid', message: 'unexpected "model"' } }))
    const cause = await callPanel({ call }, 'close', { chatId: 'a', sessionId: 'owner' }).catch(e => e)
    expect(panelActionError(cause, translator(en))).toContain('unexpected "model"')
    await expect(callPanel({ call }, 'purge', { chatId: 'a' })).rejects.toThrow('sessionId is required')
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('updates the list row after a confirmed change and surfaces the restart hint on a rejected release', async () => {
    let model = neon
    const baseRpc = mockRpc(() => [chat({ currentModel: model, currentEffort: 'high' })])
    const call = vi.fn<PanelRpc['call']>(async (channel, endpoint, payload) => {
      if (endpoint === 'acpResumeInfo/features') return { ok: true, value: defaultFeatureView.features }
      if (endpoint === 'acpResume/chatOptions') return { ok: true, value: {
        ...readSessionChoices({ configOptions: configOptions(model) }), backend: 'agy', supported: true, canChange: true,
      } }
      if (endpoint === 'acpResume/setChatModel') {
        const { args } = payload as { args: { model: string; sessionId: string } }
        expect(args.sessionId).toBe(TEST_SESSION)
        model = args.model
        return { ok: true, value: null }
      }
      if (endpoint === 'acpResume/close') return { ok: false, error: { code: 'gateway/arguments-invalid', message: 'unexpected "sessionId"' } }
      return baseRpc.call(channel, endpoint, payload)
    })
    const { ctx, list } = await panelConnection({ call })
    try {
      renderBody(list)
      fireEvent.click(await screen.findByRole('button', { name: /仅此会话设置/ }))
      expect(document.querySelector('[data-chat-settings] [data-disclosure-row]')).toBeTruthy()
      expect(document.querySelector('[data-chat-settings] [data-icon="sliders"]')).toBeTruthy()
      expect(document.querySelector('[data-chat-settings]')?.textContent).not.toMatch(/[▾▴]/)
      fireEvent.change(await screen.findByRole('combobox', { name: '模型' }), { target: { value: sonnet } })
      expect(await screen.findByText(sonnet + ' · high')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
      fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: '释放进程' }))
      expect(await screen.findByText(zh.restartForChatActions)).toBeTruthy()
      expect(call.mock.calls.filter(args => args[1] === 'acpResume/close')).toHaveLength(1)
    } finally { cleanup(); await ctx.fiber.dispose() }
  })

  it('renders running, released-editable, choicesUnknown, Codex, and active copy in zh and en (D48)', async () => {
    for (const copy of [zh, en]) {
      // Active idle
      render(<ChatsPanel {...props(ready([chat({ active: true })]), {
        settings: { read: async () => ({ ...readSessionChoices({ configOptions: configOptions(neon) }), backend: 'agy', supported: true, canChange: true }), change: vi.fn() },
        t: translator(copy),
      })} />)
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: new RegExp(copy.sessionSettings) })) })
      expect(screen.getByText(copy.switchLifetime)).toBeTruthy()
      cleanup()

      // Running
      render(<ChatsPanel {...props(ready([chat({ active: true, inFlight: { chatId: 'a', startedAt: NOW, message: 'work' } })]), {
        settings: { read: async () => ({ ...readSessionChoices({ configOptions: configOptions(neon) }), backend: 'agy', supported: true, canChange: false, reason: 'running' }), change: vi.fn() },
        t: translator(copy),
      })} />)
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: new RegExp(copy.sessionSettings) })) })
      expect(screen.getByText(copy.switchRunning)).toBeTruthy()
      expect(screen.getAllByRole('combobox').every(el => (el as HTMLSelectElement).disabled)).toBe(true)
      cleanup()

      // Released (editable): dropdowns enabled, change succeeds, displays "next reconnect" copy
      let selectedModel = neon
      const change = vi.fn(async (_id: string, field: 'model' | 'effort', value: string) => { if (field === 'model') selectedModel = value })
      render(<ChatsPanel {...props(ready([chat({ active: false })]), {
        settings: {
          read: async () => ({ ...readSessionChoices({ configOptions: configOptions(selectedModel) }), backend: 'agy', supported: true, canChange: true, reason: 'released' }),
          change,
        },
        t: translator(copy),
      })} />)
      fireEvent.click(screen.getByRole('button', { name: new RegExp(copy.releasedGroup.replace('{count}', '1').replace(/[()]/g, '\\$&')) }))
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: new RegExp(copy.sessionSettings) })) })
      const modelSelect = screen.getByRole('combobox', { name: copy.sessionModel }) as HTMLSelectElement
      expect(modelSelect.disabled).toBe(false)
      expect(screen.getByText(copy.switchReleased)).toBeTruthy()
      await act(async () => { fireEvent.change(modelSelect, { target: { value: sonnet } }) })
      expect(change).toHaveBeenCalledWith(chat().chatId, 'model', sonnet)
      expect((screen.getByRole('combobox', { name: copy.sessionModel }) as HTMLSelectElement).value).toBe(sonnet)
      expect(screen.getByText(copy.switchReleased)).toBeTruthy()
      cleanup()

      // Released (choicesUnknown): no selects, no error, shows unknown copy
      render(<ChatsPanel {...props(ready([chat({ active: false })]), {
        settings: { read: async () => ({ backend: 'agy', supported: true, canChange: true, choicesUnknown: true, reason: 'released' }), change: vi.fn() },
        t: translator(copy),
      })} />)
      fireEvent.click(screen.getByRole('button', { name: new RegExp(copy.releasedGroup.replace('{count}', '1').replace(/[()]/g, '\\$&')) }))
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: new RegExp(copy.sessionSettings) })) })
      expect(screen.getByText(copy.switchChoicesUnknown)).toBeTruthy()
      expect(screen.queryByRole('combobox')).toBeNull()
      expect(screen.queryByRole('alert')).toBeNull()
      cleanup()

      // Codex unsupported
      render(<ChatsPanel {...props(ready([chat({ active: true })]), {
        settings: { read: async () => ({ backend: 'codex', supported: false, canChange: false, reason: 'codex session-level switch is not available yet' }), change: vi.fn() },
        t: translator(copy),
      })} />)
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: new RegExp(copy.sessionSettings) })) })
      expect(screen.getByText(copy.switchUnsupported)).toBeTruthy()
      cleanup()
    }
    // Locale key parity check
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    for (const key of Object.keys(zh) as (keyof typeof zh)[]) {
      expect(zh[key].length).toBeGreaterThan(0)
      expect(en[key].length).toBeGreaterThan(0)
    }
  })

  it('wires backendDefaults metadata from BackendStatus into ProfileSettings and blocks invalid effort (D48)', async () => {
    const mutate = vi.fn(async () => true)
    const form = (value: Record<string, unknown>) => {
      const snap = { status: 'ready', writable: true, revision: 3, value }
      return { getSnapshot: () => snap, subscribe: () => () => {}, mutate }
    }
    const statusSnapshot = {
      status: 'ready' as const,
      checking: false,
      data: {
        checking: false,
        dispatchEnabled: true,
        defaultBackend: 'default',
        backends: [
          { id: 'default', label: 'kiro-cli', configured: true, effortKind: 'kiro' as const, staticModel: 'claude-opus-5.5', compatibility: 'supported' as const, readiness: 'ready' as const },
          { id: 'agy', label: 'Antigravity CLI (agy)', configured: false, automatic: true as const, effortKind: 'agy' as const, compatibility: 'supported' as const, readiness: 'ready' as const },
          { id: 'codex', label: 'Codex', configured: false, automatic: true as const, effortKind: 'codex' as const, compatibility: 'supported' as const, readiness: 'ready' as const },
        ],
      },
    }
    const backendStatus = {
      getSnapshot: () => statusSnapshot,
      subscribe: () => () => {},
      check: async () => {},
    }
    const forms = { main: form({ roles: true, workflow: false, backendDefaults: {} }), dispatcher: form({}) }
    render(<ChatsPanel {...props(ready([]), {
      backendStatus,
      profileForms: () => forms,
      t: translator(zh),
    })} />)
    fireEvent.click(screen.getByRole('button', { name: zh.profileSettings }))
    // The defaults block is a div inside the settings `<section>`; the save/validation `status` is a sibling of the block, inside that `<section>`.
    const section = (document.querySelector('[data-backend-defaults-section]') as HTMLElement).closest('section') as HTMLElement
    expect(section).toBeTruthy()
    expect(within(section).getAllByText(zh.backendAutomatic)).toHaveLength(2)
    expect(within(section).getByRole('combobox', { name: 'agy 缺省思考强度' })).toBeTruthy()
    expect(within(section).getByRole('textbox', { name: 'codex 缺省思考强度' })).toBeTruthy()
    const agyEffort = within(section).getByRole('combobox', { name: 'agy 缺省思考强度' }) as HTMLSelectElement
    const invalidOpt = document.createElement('option')
    invalidOpt.value = 'max'
    agyEffort.appendChild(invalidOpt)
    fireEvent.change(agyEffort, { target: { value: 'max' } })
    // The panel itself has a persistent screen-reader `status`; look for the settings one inside the section.
    // The panel itself has a persistent screen-reader `status`; look for the settings one inside the section.
    expect(within(section).getByRole('status').textContent).toContain('is not a valid effort level for agy')
    expect(mutate).not.toHaveBeenCalled()
  })

  it('binds both detail mutations to the viewing seat sessionId', async () => {
    const call = vi.fn<PanelRpc['call']>(async () => ({ ok: true, value: [] }))
    const ctx = new Context()
    const services = stubServices()
    ctx.provide('slots', services.slots)
    ctx.provide('sidebarRightTabs', services.sidebarRightTabs)
    ctx.provide('locale', services.locale)
    ctx.provide('connection', { rpc: { call } })
    provideRemote(ctx)
    try {
      await ctx.plugin(client)
      const view = services.bodies[1]!.options.inject(TEST_SESSION) as ChatDetailInjected
      await view.close('chat-a')
      await view.purge('chat-a')
      for (const method of ['close', 'purge']) expect(call).toHaveBeenCalledWith('/api', 'acpResume/' + method, { args: { chatId: 'chat-a', sessionId: TEST_SESSION } })
    } finally { await ctx.fiber.dispose() }
  })
})

describe('live detail body (D46)', () => {
  const running = { kind: 'running', startedAt: NOW - 1200, message: '检查改动' } as const

  it.each([zh, en])('only follows an expanded visible running row, cancelling on hide, collapse and unmount', copy => {
    const opened = vi.fn(), stop = vi.fn()
    const follow: FollowTurn = (id, start, listener) => {
      opened(id, start)
      listener({ kind: 'snapshot', seq: 1, text: '已读取配置', truncated: true })
      return stop
    }
    const props = detailProps(fakeSource(detailSnapshot({ entries: [running] })), { followTurn: follow, t: translator(copy) }).injected
    const renderDetail = (visible: boolean) => <ChatDetail {...props} useTabInfo={() => ({ tab: { ...props.useTabInfo().tab, visible } })} />
    const view = render(renderDetail(true))
    expect(opened).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: copy.runningExpand }))
    expect(screen.getByText(copy.liveOutput + ' · ' + copy.liveTail)).toBeTruthy()
    expect(screen.getByText('已读取配置')).toBeTruthy()
    view.rerender(renderDetail(false))
    expect(stop).toHaveBeenCalledTimes(1)
    view.rerender(renderDetail(true))
    expect(opened).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: copy.runningCollapse }))
    expect(stop).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: copy.runningExpand }))
    view.unmount()
    expect(stop).toHaveBeenCalledTimes(3)
  })

  it('warns only on unexpected stream failure and renders the localized fallback without the raw cause', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cause = new Error('fixture transport disconnected')
    let opens = 0
    const live = new LiveSource(async function* (_, __, signal) {
      if (++opens === 1) await new Promise<void>((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      throw cause
    }, vi.fn())
    const follow: FollowTurn = (id, start, fn) => live.subscribe(id, TEST_SESSION, start, fn)
    const { injected } = detailProps(fakeSource(detailSnapshot({ entries: [running] })), { followTurn: follow })
    const { container } = render(<ChatDetail {...injected} />)
    fireEvent.click(screen.getByRole('button', { name: zh.runningExpand }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: zh.runningCollapse })))
    expect(warn).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh.runningExpand }))
    expect(await screen.findByText(zh.liveError)).toBeTruthy()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(`dsh-acp-resume: live output stream failed for chat-${UUID_A}`, cause)
    expect(container.textContent).not.toContain(cause.message)
  })

  it('pauses following while scrolled up and replaces the stream with the logged turn on settled', async () => {
    let snapshot = detailSnapshot({ entries: [running] })
    const logReady = Promise.withResolvers<void>()
    const subscribers = new Set<() => void>()
    const source: DetailSource = { ...fakeSource(snapshot), getSnapshot: () => snapshot,
      subscribe(fn) { subscribers.add(fn); return () => { subscribers.delete(fn) } },
      async refresh() {
        await logReady.promise
        snapshot = detailSnapshot({ entries: [turn(1, { startedAt: running.startedAt, message: running.message, output: '配置检查完成' })] })
        for (const fn of subscribers) fn()
      },
    }
    let push!: (frame: LiveFrame) => void
    const live = new LiveSource(async function* (_, __, signal) {
      let next = Promise.withResolvers<LiveFrame>()
      push = frame => next.resolve(frame)
      yield { kind: 'snapshot', seq: 1, text: '已读取配置', truncated: false }
      while (!signal.aborted) {
        const frame = await next.promise
        next = Promise.withResolvers<LiveFrame>()
        yield frame
      }
    }, () => { void source.refresh() })
    const follow: FollowTurn = (id, start, fn) => live.subscribe(id, TEST_SESSION, start, fn)
    const { container } = render(<ChatDetail {...detailProps(source, { followTurn: follow }).injected} />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: zh.runningExpand })))
    const box = container.querySelector('[data-live-output]') as HTMLElement
    expect(box.querySelector('[data-streaming="true"]')).toBeTruthy()
    Object.defineProperties(box, { scrollHeight: { value: 400 }, clientHeight: { value: 100 } })
    box.scrollTop = 40
    fireEvent.scroll(box)
    await act(async () => push({ kind: 'snapshot', seq: 2, text: '已读取配置，正在核对', truncated: false }))
    expect(box.scrollTop).toBe(40)
    expect(screen.getByRole('button', { name: zh.liveBottom })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.liveBottom }))
    await act(async () => push({ kind: 'snapshot', seq: 3, text: '已核对', truncated: false }))
    expect(box.scrollTop).toBe(400)
    await act(async () => push({ kind: 'settled', seq: 4 }))
    expect(screen.getByText(zh.liveSettling)).toBeTruthy()
    expect(box.textContent).toBe('已核对')
    expect(box.querySelector('[data-streaming="false"]')).toBeTruthy()
    expect(container.querySelector('li[data-open]')).toBeNull()
    await act(async () => logReady.resolve())
    expect(container.querySelector('[data-running]')).toBeNull()
    expect(container.querySelector('[data-live-output]')).toBeNull()
    expect(container.querySelector('li[data-open] [data-full="message"]')?.textContent).toBe('检查改动')
    expect(screen.getAllByText('配置检查完成')).toHaveLength(1)
  })

  it('retains the settled tail when an unrelated history arrives; the deleted state takes precedence', () => {
    vi.useFakeTimers()
    let snapshot = detailSnapshot({ entries: [running] })
    let push!: (frame: LiveFrame) => void
    const source = { ...fakeSource(snapshot), getSnapshot: () => snapshot }
    const follow: FollowTurn = (_id, _at, fn) => { push = fn; return () => {} }
    const { injected } = detailProps(source, { followTurn: follow })
    const view = render(<ChatDetail {...injected} />)
    fireEvent.click(screen.getByRole('button', { name: zh.runningExpand }))
    act(() => { push({ kind: 'snapshot', seq: 1, text: '末帧', truncated: false }); push({ kind: 'settled', seq: 2 }) })
    snapshot = detailSnapshot({ entries: [turn(7)] })
    view.rerender(<ChatDetail {...injected} />)
    expect(screen.getByText(zh.liveSettling)).toBeTruthy()
    act(() => vi.advanceTimersByTime(3000))
    expect(screen.getByText(zh.liveMissing)).toBeTruthy()
    expect(screen.getByText('末帧')).toBeTruthy()
    expect(view.container.querySelector('li[data-open]')).toBeNull()
    snapshot = { status: 'gone', entries: [], total: 0 }
    view.rerender(<ChatDetail {...injected} />)
    expect(screen.getByText(zh.goneTitle)).toBeTruthy()
    expect(screen.queryByText('末帧')).toBeNull()
  })

  it('keeps the matched history collapsed after the user closes the live viewport', () => {
    let snapshot = detailSnapshot({ entries: [running] })
    const source = { ...fakeSource(snapshot), getSnapshot: () => snapshot }
    const { injected } = detailProps(source, { followTurn: () => () => {} })
    const view = render(<ChatDetail {...injected} />)
    fireEvent.click(screen.getByRole('button', { name: zh.runningExpand }))
    fireEvent.click(screen.getByRole('button', { name: zh.runningCollapse }))
    snapshot = detailSnapshot({ entries: [turn(8, { startedAt: running.startedAt })] })
    view.rerender(<ChatDetail {...injected} />)
    expect(view.container.querySelector('[data-running]')).toBeNull()
    expect(view.container.querySelector('[data-seq="8"]')?.hasAttribute('data-open')).toBe(false)
  })

  it('shares one stream per viewer session/chat/turn and aborts only on last unsubscribe', async () => {
    const signals: AbortSignal[] = []
    const source = new LiveSource(async function* (_, __, signal) {
      signals.push(signal)
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    }, vi.fn())
    const first = source.subscribe('chat', 'owner', NOW, vi.fn())
    const second = source.subscribe('chat', 'owner', NOW, vi.fn())
    expect(signals).toHaveLength(1)
    first()
    expect(signals[0]?.aborted).toBe(false)
    second()
    expect(signals[0]?.aborted).toBe(true)
  })

  it('does not open watch for the list or a restored chip title', async () => {
    const watch = vi.fn<WatchRemote['acpResume']['watch']>()
    const { list, title, ctx } = await panelConnection({ call: async (_, endpoint) => {
      if (endpoint.endsWith('/features')) return { ok: true, value: defaultFeatureView.features }
      if (endpoint.endsWith('/turns')) return { ok: true, value: detailSnapshot({ entries: [running] }) }
      if (endpoint.endsWith('/backends')) return { ok: true, value: backendFixture }
      if (!endpoint.endsWith('/list')) return { ok: true, value: [] }
      return { ok: true, value: [chat({ inFlight: { chatId: 'chat', message: running.message, startedAt: NOW } })] }
    } }, { $mount: async () => () => {}, acpResume: { watch } })
    try {
      renderBody(list)
      render(<ChatDetailTitle {...title} useTabInfo={tabInfo(chatAddress('chat-' + UUID_A)).hook} />)
      await screen.findByText('审阅')
      expect(watch).not.toHaveBeenCalled()
    } finally { cleanup(); await ctx.fiber.dispose() }
})
})

describe('ChatsPanel header icons and settings drawer (D47 Step 2)', () => {
  function readyForm(value: Record<string, unknown>) {
    const snapshot = { status: 'ready', writable: true, revision: 1, value }
    return {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      mutate: vi.fn(async () => true),
    }
  }

  function settingsForms() {
    return () => ({
      main: readyForm({ roles: true, workflow: false }),
      dispatcher: readyForm({ dispatcherTools: { web: true }, dispatcherPrompt: { extraRules: '', overrideRules: false } }),
    })
  }

  it('renders official refresh and settings icon buttons without raw gear unicode and triggers refresh', () => {
    const refresh = vi.fn()
    const { container } = render(<ChatsPanel {...props(ready([]), { refresh, profileForms: settingsForms() })} />)
    const refreshBtn = screen.getByRole('button', { name: zh.refresh })
    const settingsBtn = screen.getByRole('button', { name: zh.profileSettings })
    expect(refreshBtn.querySelector('[data-icon="refresh"]')).toBeTruthy()
    expect(settingsBtn.querySelector('[data-icon="settings"]')).toBeTruthy()
    expect(container.textContent).not.toContain('⚙')
    fireEvent.click(refreshBtn)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('toggles the inline settings drawer open and closed from the header settings button', () => {
    render(<ChatsPanel {...props(ready([]), { profileForms: settingsForms() })} />)
    const settingsBtn = screen.getByRole('button', { name: zh.profileSettings })
    expect(settingsBtn.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText(zh.profileMain)).toBeNull()

    fireEvent.click(settingsBtn)
    expect(settingsBtn.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(zh.profileMain)).toBeTruthy()
    expect(screen.getAllByRole('switch')).toHaveLength(11)

    fireEvent.click(settingsBtn)
    expect(settingsBtn.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText(zh.profileMain)).toBeNull()
  })

  it('resets the settings drawer back to collapsed after unmounting and remounting (tab switch)', () => {
    const panelProps = props(ready([]), { profileForms: settingsForms() })
    const first = render(<ChatsPanel {...panelProps} />)
    fireEvent.click(screen.getByRole('button', { name: zh.profileSettings }))
    expect(screen.getByText(zh.profileMain)).toBeTruthy()

    first.unmount()
    render(<ChatsPanel {...panelProps} />)
    const settingsBtn = screen.getByRole('button', { name: zh.profileSettings })
    expect(settingsBtn.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText(zh.profileMain)).toBeNull()
  })

  it('keeps zh and en locale dictionaries complete with identical keys and non-empty strings', () => {
    const zhKeys = Object.keys(zh).sort()
    const enKeys = Object.keys(en).sort()
    expect(enKeys).toEqual(zhKeys)
    for (const key of zhKeys as PanelCopyKey[]) {
      expect(zh[key].trim().length).toBeGreaterThan(0)
      expect(en[key].trim().length).toBeGreaterThan(0)
    }
  })
})

describe('TeamSection & mutual exclusion (D47 Step 5)', () => {
  const fiveStates = (): PanelChat[] => [
    chat({
      chatId: 'chat-role-idle',
      role: 'planner',
      active: true,
      lastActive: NOW - 5 * 60_000,
    }),
    chat({
      chatId: 'chat-role-done',
      role: 'reviewer',
      active: false,
      lastActive: NOW - 2 * 60_000,
      latestTurn: {
        seq: 2,
        startedAt: NOW - 150_000,
        at: NOW - 120_000,
        message: '**审核 D47 改动**',
        output: '结论：`3 处边界` 已核实无误。',
        stopReason: 'completed',
        freshSession: false,
      },
    }),
    chat({
      chatId: 'chat-role-cancel',
      role: 'auditor',
      active: true,
      latestTurn: {
        seq: 1,
        startedAt: NOW - 80_000,
        at: NOW - 60_000,
        message: '检查配置',
        output: '部分完成',
        stopReason: 'aborted',
        freshSession: false,
      },
    }),
    chat({
      chatId: 'chat-role-err',
      role: 'researcher',
      active: false,
      attention: 'error',
      latestTurn: {
        seq: 1,
        startedAt: NOW - 50_000,
        at: NOW - 40_000,
        message: '调研组件',
        output: '',
        stopReason: 'error',
        freshSession: false,
      },
    }),
    chat({
      chatId: 'chat-role-run',
      role: 'coder',
      active: true,
      inFlight: { chatId: 'chat-role-run', message: '## 修复 **超时** 用例', startedAt: NOW - 80_000 },
    }),
  ]

  it('shows unconfigured hint when no roles exist, and renders five urgency-ordered states in zh and en', () => {
    const { container, rerender } = render(<ChatsPanel {...props(ready([chat()]))} />)
    expect(container.querySelector('[data-section="team"]')?.getAttribute('data-team-mode')).toBe('unconfigured')
    expect(within(container.querySelector('[data-section="active-chats"]') as HTMLElement).getByRole('heading', { level: 3 }).textContent).toBe(zh.activeChatsHeading)

    rerender(<ChatsPanel {...props(ready(fiveStates()))} />)
    const section = container.querySelector('[data-section="team"]') as HTMLElement
    expect(section).toBeTruthy()
    expect(within(section).getByRole('heading', { level: 3 }).textContent).toBe(zh.teamHeading)
    expect(section.textContent).toContain('5 角色')
    const cards = [...section.querySelectorAll('[data-team-role]')] as HTMLElement[]
    expect(cards.map(c => [c.getAttribute('data-team-role'), c.getAttribute('data-team-state'), c.querySelector('[data-panel-card]')?.getAttribute('data-state')])).toEqual([
      ['coder', 'running', 'running'],
      ['researcher', 'error', 'error'],
      ['auditor', 'cancelled', 'warn'],
      ['reviewer', 'completed', 'none'],
      ['planner', 'idle', 'none'],
    ])
    // Verify zh rendered copy across all five states (Markdown stripped on task/reply).
    expect(cards[0]?.querySelector('[data-team-task]')?.textContent).toBe('↗ 修复 超时 用例')
    expect(cards[0]?.querySelector('[data-team-hint]')?.textContent).toBe(zh.teamRunningHint)
    expect(within(cards[1]!).getByText(zh.stopError)).toBeTruthy()
    expect(cards[1]?.querySelector('[data-team-reply]')?.textContent).toBe(zh.noAnswer)
    expect(within(cards[2]!).getByText(zh.stopAborted)).toBeTruthy()
    expect(cards[3]?.querySelector('[data-team-task]')?.textContent).toBe('↗ 审核 D47 改动')
    expect(cards[3]?.querySelector('[data-team-reply]')?.textContent).toBe('结论：3 处边界 已核实无误。')
    expect(cards[3]?.querySelector('[data-team-released]')?.textContent).toBe(zh.teamRoleReleased)
    expect(cards[4]?.querySelector('[data-team-hint]')?.textContent).toBe(zh.teamIdleHint)

    // Verify en rendered copy across all five states.
    rerender(<ChatsPanel {...props(ready(fiveStates()), { t: translator(en) })} />)
    const enCards = [...container.querySelectorAll('[data-team-role]')] as HTMLElement[]
    expect(within(container.querySelector('[data-section="team"]') as HTMLElement).getByRole('heading', { level: 3 }).textContent).toBe(en.teamHeading)
    expect(enCards[0]?.querySelector('[data-team-hint]')?.textContent).toBe(en.teamRunningHint)
    expect(within(enCards[1]!).getByText(en.stopError)).toBeTruthy()
    expect(enCards[1]?.querySelector('[data-team-reply]')?.textContent).toBe(en.noAnswer)
    expect(within(enCards[2]!).getByText(en.stopAborted)).toBeTruthy()
    expect(enCards[3]?.querySelector('[data-team-released]')?.textContent).toBe(en.teamRoleReleased)
    expect(enCards[4]?.querySelector('[data-team-hint]')?.textContent).toBe(en.teamIdleHint)
  })

  it('mutually excludes team chats from standalone lists, enforces owner isolation, and keeps full 6-section order', () => {
    const view = { status: 'ready', checking: false, data: backendFixture } as const
    const backendStatus = { getSnapshot: () => view, subscribe: () => () => {}, check: vi.fn(async () => {}) }
    const wfSnapshot: WorkflowsSnapshot = {
      status: 'ready',
      fetchedAt: NOW,
      running: [{ runId: 'r1', template: 'dual_review', startedAt: NOW - 10_000, currentStep: 'review', steps: [] }],
      recent: [],
    }
    const rows = [
      chat({ chatId: 'chat-role-live', role: 'coder', active: true }),
      chat({ chatId: 'chat-role-rel', role: 'reviewer', active: false }),
      chat({ chatId: 'chat-free-live', active: true, title: '临时会话' }),
      chat({ chatId: 'chat-free-rel', active: false, title: '旧自由会话' }),
      chat({ chatId: 'chat-other-owner', ownerSessionId: OTHER_SESSION, role: 'alien', active: true }),
    ]
    const { container } = render(<ChatsPanel {...props(ready(rows), {
      backendStatus,
      workflowsFor: () => ({ getSnapshot: () => wfSnapshot, subscribe: () => () => {} }),
    })} />)
    // Full 6-section authoritative DOM order.
    const order = [...container.querySelectorAll('[data-section]')].map(el => el.getAttribute('data-section'))
    expect(order).toEqual(['header', 'team', 'workflows', 'active-chats', 'backend', 'released-chats'])
    // Standalone active section title switches to "其他活跃会话".
    expect(within(container.querySelector('[data-section="active-chats"]') as HTMLElement).getByRole('heading', { level: 3 }).textContent).toBe(zh.otherActiveChatsHeading)

    // Expand released standalone chats and assert every chatId appears at most once and cross-owner is absent.
    fireEvent.click(screen.getByRole('button', { name: '已释放 (1) · 展开' }))
    const allRenderedIds = [...container.querySelectorAll('[data-chat-id]')].map(el => el.getAttribute('data-chat-id'))
    expect(new Set(allRenderedIds).size).toBe(allRenderedIds.length)
    expect(allRenderedIds).toEqual(['chat-role-live', 'chat-role-rel', 'chat-free-live', 'chat-free-rel'])
    expect(container.querySelector('[data-chat-id="chat-other-owner"]')).toBeNull()
  })

  it('opens detail when clicking a team card and executes release/delete from its ⋯ menu without opening detail', async () => {
    const info = tabInfo()
    const p = props(ready([chat({ chatId: 'chat-role-click', role: 'coder', active: true })]), { useTabInfo: info.hook })
    const { container } = render(<ChatsPanel {...p} />)
    const card = container.querySelector('[data-team-role="coder"]') as HTMLElement
    fireEvent.click(card)
    expect(info.openResource).toHaveBeenCalledTimes(1)
    expect(info.openResource).toHaveBeenCalledWith(chatAddress('chat-role-click'))

    fireEvent.click(within(card).getByRole('button', { name: zh.moreActions }))
    await act(async () => { fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: zh.releaseProcess })) })
    expect(p.close).toHaveBeenCalledWith('chat-role-click')
    expect(info.openResource).toHaveBeenCalledTimes(1)
  })

  it('does not increase acpResume/list polling frequency when rendering team chats', async () => {
    vi.useFakeTimers()
    const standaloneRpc = mockRpc(() => [chat({ chatId: 'chat-a', active: true })])
    const teamRpc = mockRpc(() => [
      chat({ chatId: 'chat-a', role: 'coder', active: true, latestTurn: { seq: 1, startedAt: NOW - 2000, at: NOW - 1000, message: 'm', output: 'o', stopReason: 'completed', freshSession: false } }),
      chat({ chatId: 'chat-b', role: 'reviewer', active: true }),
    ])
    const standaloneSource = new ChatsSource(standaloneRpc, () => NOW)
    const teamSource = new ChatsSource(teamRpc, () => NOW)
    const stopA = standaloneSource.subscribe(() => {})
    const stopB = teamSource.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(listCalls(teamRpc)).toBe(listCalls(standaloneRpc))
    expect(teamRpc.calls.every(([, ep]) => ep === 'acpResume/list')).toBe(true)
    stopA()
    stopB()
    standaloneSource.dispose()
    teamSource.dispose()
  })

  it('groups a quota-exhausted role under error urgency with orange rail and warning stopQuota tag in zh and en (D50)', () => {
    const rows: PanelChat[] = [
      chat({
        chatId: 'chat-role-cancel',
        role: 'auditor',
        active: true,
        latestTurn: { seq: 1, startedAt: NOW - 80_000, at: NOW - 60_000, message: '检查', output: '停', stopReason: 'aborted', freshSession: false },
      }),
      chat({
        chatId: 'chat-role-quota',
        role: 'coder',
        active: false,
        attention: 'warning',
        latestTurn: { seq: 2, startedAt: NOW - 50_000, at: NOW - 40_000, message: '写代码', output: '', stopReason: 'error', failureKind: 'quota', freshSession: false },
      }),
    ]
    const { container, rerender } = render(<ChatsPanel {...props(ready(rows))} />)
    const cards = [...container.querySelectorAll('[data-team-role]')] as HTMLElement[]
    expect(cards.map(c => [c.getAttribute('data-team-role'), c.getAttribute('data-team-state')])).toEqual([
      ['coder', 'error'],
      ['auditor', 'cancelled'],
    ])
    const quotaCard = cards[0] as HTMLElement
    expect(quotaCard.querySelector('[data-panel-card]')?.getAttribute('data-state')).toBe('warn')
    expect((quotaCard.querySelector('[data-panel-card]') as HTMLElement).style.borderLeft).toMatch(/3px solid var\(--dsw-alias-state-warn-primary\)/)
    expect(quotaCard.querySelector('[data-dot]')?.getAttribute('data-dot')).toBe('warning')
    const zhTag = within(quotaCard).getByText(zh.stopQuota).closest('[data-tag]') as HTMLElement
    expect(zhTag.textContent).toBe('额度耗尽')
    expect(zhTag.getAttribute('data-tone')).toBe('warning')

    rerender(<ChatsPanel {...props(ready(rows), { t: translator(en) })} />)
    const enCard = container.querySelector('[data-team-role="coder"]') as HTMLElement
    const enTag = within(enCard).getByText(en.stopQuota).closest('[data-tag]') as HTMLElement
    expect(enTag.textContent).toBe('quota used up')
    expect(enTag.getAttribute('data-tone')).toBe('warning')
  })

  it('renders three discoverable TeamSection states in zh and en: defined idle cards, unconfigured hint with <code>, and hidden when roles is off (0.7.8)', () => {
    const info = tabInfo()

    // State 1a: Workspace defines roles, zero chats yet -> renders TeamSection with non-clickable, menu-less idle cards.
    const unprovisionedSnapshot: ChatsSnapshot = { ...ready([]), teamRoles: ['coder', 'reviewer'] }
    const { container, rerender } = render(<ChatsPanel {...props(unprovisionedSnapshot, { useTabInfo: info.hook })} />)
    const teamZh = container.querySelector('[data-section="team"]') as HTMLElement
    expect(teamZh).toBeTruthy()
    expect(teamZh.getAttribute('data-team-mode')).toBe('roles')
    expect(within(teamZh).getByRole('heading', { level: 3 }).textContent).toBe('团队派工')
    expect(teamZh.textContent).toContain('2 角色')
    const idleCardsZh = [...teamZh.querySelectorAll('[data-team-role]')] as HTMLElement[]
    expect(idleCardsZh.map(c => c.getAttribute('data-team-role'))).toEqual(['coder', 'reviewer'])
    for (const card of idleCardsZh) {
      expect(card.getAttribute('data-team-state')).toBe('idle')
      expect(card.hasAttribute('data-chat-id')).toBe(false)
      expect(card.querySelector('[data-dot]')?.getAttribute('data-dot')).toBe('idle')
      expect(card.querySelector('[data-state-dot]')?.getAttribute('data-state')).toBe('idle')
      expect(card.querySelector('[data-team-hint]')?.textContent).toBe('空闲 · 等待派工')
      expect(within(card).queryByRole('button', { name: zh.moreActions })).toBeNull()
      expect(within(card).queryByText(zh.releaseProcess)).toBeNull()
      expect(within(card).queryByText(zh.deleteRecord)).toBeNull()
      fireEvent.click(card)
    }
    expect(info.openResource).not.toHaveBeenCalled()

    // State 1a in en.
    rerender(<ChatsPanel {...props(unprovisionedSnapshot, { useTabInfo: info.hook, t: translator(en) })} />)
    const teamEn = container.querySelector('[data-section="team"]') as HTMLElement
    expect(within(teamEn).getByRole('heading', { level: 3 }).textContent).toBe('Team dispatch')
    expect(teamEn.textContent).toContain('2 roles')
    expect(teamEn.querySelector('[data-team-role="coder"] [data-team-hint]')?.textContent).toBe('Idle · awaiting task')

    // State 1b: Mixed dispatched + unprovisioned defined roles (no duplicates; dispatched clickable, idle not).
    const mixedSnapshot: ChatsSnapshot = {
      ...ready([chat({ chatId: 'chat-role-coder', role: 'coder', active: true })]),
      teamRoles: ['coder', 'reviewer'],
    }
    rerender(<ChatsPanel {...props(mixedSnapshot, { useTabInfo: info.hook })} />)
    const mixedCards = [...container.querySelectorAll('[data-team-role]')] as HTMLElement[]
    expect(mixedCards.map(c => [c.getAttribute('data-team-role'), c.getAttribute('data-chat-id')])).toEqual([
      ['coder', 'chat-role-coder'],
      ['reviewer', null],
    ])
    expect(within(mixedCards[0]!).getByRole('button', { name: zh.moreActions })).toBeTruthy()
    expect(within(mixedCards[1]!).queryByRole('button', { name: zh.moreActions })).toBeNull()
    fireEvent.click(mixedCards[1]!)
    expect(info.openResource).not.toHaveBeenCalled()
    fireEvent.click(mixedCards[0]!)
    expect(info.openResource).toHaveBeenCalledExactlyOnceWith(chatAddress('chat-role-coder'))

    // State 2: Workspace defines no roles -> renders one-line gray hint with <code>.agents/acp-team.yml</code> in zh and en.
    const unconfiguredSnapshot: ChatsSnapshot = { ...ready([]), teamRoles: [] }
    rerender(<ChatsPanel {...props(unconfiguredSnapshot, { useTabInfo: info.hook })} />)
    const emptyZh = container.querySelector('[data-section="team"]') as HTMLElement
    expect(emptyZh).toBeTruthy()
    expect(emptyZh.getAttribute('data-team-mode')).toBe('unconfigured')
    expect(emptyZh.querySelector('[data-team-empty]')?.textContent).toBe('此工作区未定义角色。创建 .agents/acp-team.yml 后可按角色派工。')
    expect(emptyZh.querySelector('[data-team-empty] code')?.textContent).toBe('.agents/acp-team.yml')

    rerender(<ChatsPanel {...props(unconfiguredSnapshot, { useTabInfo: info.hook, t: translator(en) })} />)
    const emptyEn = container.querySelector('[data-section="team"]') as HTMLElement
    expect(emptyEn.querySelector('[data-team-empty]')?.textContent).toBe('No roles are defined for this workspace. Add .agents/acp-team.yml to dispatch by role.')
    expect(emptyEn.querySelector('[data-team-empty] code')?.textContent).toBe('.agents/acp-team.yml')

    // State 3: Connection-level roles switch is off (D33) -> hides TeamSection completely.
    const rolesOffView = {
      status: 'ready' as const,
      features: { chatToolsEnabled: true, rolesEnabled: false, workflowEnabled: false, startToolName: 'acp_chat_start' },
    }
    const rolesOffStore = { getSnapshot: () => rolesOffView, subscribe: () => () => {}, refresh: async () => {} }
    rerender(<ChatsPanel {...props(unprovisionedSnapshot, { features: rolesOffStore, useTabInfo: info.hook })} />)
    expect(container.querySelector('[data-section="team"]')).toBeNull()
    rerender(<ChatsPanel {...props(unconfiguredSnapshot, { features: rolesOffStore, useTabInfo: info.hook })} />)
    expect(container.querySelector('[data-section="team"]')).toBeNull()
  })

  it('polls acpResume/teamRoles on the exact same cadence as acpResume/list without adding a timer (0.7.8)', async () => {
    vi.useFakeTimers()
    let defined: readonly string[] = ['coder', 'reviewer']
    const rpc = mockRpc(() => [chat()], () => ({ ok: true, value: [] }), () => defined)
    const teamRolesCalls = () => rpc.calls.filter(c => c[1] === 'acpResume/teamRoles').length
    const source = new ChatsSource(rpc, () => NOW, POLL_INTERVAL_MS, IDLE_POLL_INTERVAL_MS)
    const view = source.forSession(TEST_SESSION)
    const notified: number[] = []
    const stop = view.subscribe(() => { notified.push(1) })

    // Initial fetch: 1 list + 1 teamRoles with sessionId.
    await vi.advanceTimersByTimeAsync(0)
    expect(listCalls(rpc)).toBe(1)
    expect(teamRolesCalls()).toBe(1)
    expect(rpc.calls).toContainEqual(['/api', 'acpResume/teamRoles', { args: { sessionId: TEST_SESSION } }])
    const first = view.getSnapshot()
    expect(first.teamRoles).toEqual(['coder', 'reviewer'])
    expect(notified).toHaveLength(1)

    // Unchanged fast polls through backoff: teamRoles call count stays identical to list, snapshot reference stable.
    for (let i = 0; i < QUIET_POLLS_BEFORE_BACKOFF; i += 1) {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    }
    expect(teamRolesCalls()).toBe(listCalls(rpc))
    expect(view.getSnapshot()).toBe(first)
    expect(notified).toHaveLength(1)

    // Backed off to idle interval: a fast tick triggers neither; idle interval triggers one of each.
    const beforeIdle = listCalls(rpc)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(listCalls(rpc)).toBe(beforeIdle)
    expect(teamRolesCalls()).toBe(beforeIdle)

    defined = ['coder', 'reviewer', 'tester']
    await vi.advanceTimersByTimeAsync(IDLE_POLL_INTERVAL_MS - POLL_INTERVAL_MS)
    expect(listCalls(rpc)).toBe(beforeIdle + 1)
    expect(teamRolesCalls()).toBe(beforeIdle + 1)
    expect(view.getSnapshot()).not.toBe(first)
    expect(view.getSnapshot().teamRoles).toEqual(['coder', 'reviewer', 'tester'])
    expect(notified).toHaveLength(2)

    // Unsubscribe stops both completely.
    stop()
    const afterStop = listCalls(rpc)
    await vi.advanceTimersByTimeAsync(2 * IDLE_POLL_INTERVAL_MS)
    expect(listCalls(rpc)).toBe(afterStop)
    expect(teamRolesCalls()).toBe(afterStop)
    source.dispose()
  })
})
