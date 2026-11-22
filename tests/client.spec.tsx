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
import type { BackendStatusSnapshot } from '../src/backend-status.ts'
import * as client from '../src/client/index.ts'
import { BackendStatusSource } from '../src/client/backend-status-source.ts'
import { ChatsPanel, formatDuration, relativeTime, resetChatsPanelViewState, shortChatId, type ChatsPanelProps } from '../src/client/ChatsPanel.tsx'
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

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children, variant: _variant, size: _size, icon: _icon, ...rest }: Record<string, unknown> & { children?: ReactNode }) =>
    <button type="button" {...rest}>{children}</button>,
  Modal: ({ open, title, description, footer }: { open: boolean; title: string; description?: string; footer?: ReactNode }) =>
    open ? <div role="dialog" aria-label={title}><h3>{title}</h3><p>{description}</p>{footer}</div> : null,
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

function props(snapshot: ChatsSnapshot, overrides: Partial<ChatsPanelProps> = {}): ChatsPanelProps {
  return {
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
    { id: 'kiro', label: 'Kiro', configured: true, version: '2.0.0', compatibility: 'unsupported', readiness: 'unavailable', reason: 'unsupported-version' },
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
    expect(within(rows[1]!).getByText('Compatibility: Unsupported')).toBeTruthy()
    expect(within(rows[1]!).getByText('Install a CLI version in the supported range, then check again.')).toBeTruthy()
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

  it('renders one single-line row per chat: name by label, else title, else short id; the rest in the hover text', () => {
    const labelled = chat({ label: '审阅', title: '记住暗号P', turnCount: 12 })
    const titled = chat({ chatId: 'chat-titled', title: '首轮问题', lastActive: NOW - 4 * 60_000 })
    const legacy = chat({ chatId: `chat-${UUID_B}`, remoteSessionId: '9c0d1e2f-2222', cwd: '/work', active: false, lastActive: NOW - 2 * 3_600_000 })
    render(<ChatsPanel {...props(ready([labelled, titled, legacy]))} />)
    fireEvent.click(screen.getByRole('button', { name: '已释放 (1) · 展开' }))
    const cards = screen.getAllByRole('listitem') as HTMLElement[]
    expect(cards).toHaveLength(3)
    const name = (card: HTMLElement): string => (card.querySelector('[data-name]') as HTMLElement).textContent ?? ''

    expect(name(cards[0] as HTMLElement)).toBe('审阅 chat-a1b2c3d4')
    expect((cards[0] as HTMLElement).getAttribute('title')).toBe('首轮:记住暗号P\n活跃 · 12 轮 · 3 分钟前')
    expect(name(cards[1] as HTMLElement)).toBe('首轮问题 chat-titled')
    expect(name(cards[2] as HTMLElement)).toBe('chat-e5f6a7b8')
    expect((cards[2] as HTMLElement).getAttribute('title')).toBe('已释放(下次发送自动重连) · — 轮 · 2 小时前')
    // cwd, remote id, and owner live on the detail tab, not on the row.
    for (const card of cards) {
      expect(card.textContent).not.toMatch(/cwd|远端|归属/)
      expect(card.querySelectorAll('p')).toHaveLength(0)
    }
    // A released chat has nothing to release.
    expect((within(cards[2] as HTMLElement).getByRole('button', { name: '释放 chat-e5f6a7b8' }) as HTMLButtonElement).disabled).toBe(true)
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
      const { container, rerender } = render(<ChatsPanel {...props(ready([chat()]), { workflows: staticWorkflows({ status: 'ready', running: [], recent: [] }) })} />)
      expect(container.querySelector('[data-workflows]')).toBeNull()
      rerender(<ChatsPanel {...props(ready([chat()]), { workflows: staticWorkflows(snapshot) })} />)
      const section = container.querySelector('[data-workflows]') as HTMLElement
      expect(within(section).getByRole('heading', { level: 3 }).textContent).toBe('工作流 · 1 进行中')
      const rows = [...section.querySelectorAll('[data-workflow]')] as HTMLElement[]
      expect(rows.map(r => r.getAttribute('data-workflow'))).toEqual(['run-live', 'run-ok', 'run-bad', 'run-cut'])
      expect(rows.map(r => r.querySelector('[data-dot]')?.getAttribute('data-dot'))).toEqual(['ongoing', 'done', 'error', 'warning'])
      expect(rows[0]?.textContent).toBe('dual_review · independent已运行 3分12秒')
      expect(rows[1]?.textContent).toBe('chain20 分钟前')
      expect((rows[2]?.querySelector('button') as HTMLElement).getAttribute('title')).toBe('失败: step independent: every role failed')
      // The block sits after the active chats and before the released group.
      const order = [...container.querySelectorAll('[data-chat-id], [data-workflows]')].map(el => el.hasAttribute('data-workflows') ? 'workflows' : 'chat')
      expect(order).toEqual(['chat', 'workflows'])
    })

    it('expands a row into steps and members, and a member opens its chat detail tab', () => {
      const info = tabInfo()
      const { container } = render(<ChatsPanel {...props(ready([chat()]), { workflows: staticWorkflows(snapshot), useTabInfo: info.hook })} />)
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
    const source = new WorkflowsSource(rpc, 'session-x', () => NOW)
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

  it('releases directly, without a confirmation dialog', async () => {
    const p = props(ready([chat()]))
    render(<ChatsPanel {...p} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '释放 chat-a1b2c3d4' })) })
    expect(p.close).toHaveBeenCalledWith(`chat-${UUID_A}`)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('asks before releasing a chat with a turn in flight; cancel keeps it, confirm releases', async () => {
    const p = props(ready([chat({ inFlight: { chatId: `chat-${UUID_A}`, message: 'm', startedAt: NOW - 5_000 } })]))
    render(<ChatsPanel {...p} />)
    fireEvent.click(screen.getByRole('button', { name: '释放 chat-a1b2c3d4' }))
    const dialog = screen.getByRole('dialog', { name: '释放 chat-a1b2c3d4?' })
    expect(within(dialog).getByText('将中止正在运行的本轮任务并释放进程(历史记录保留,后续仍可重连)。')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(p.close).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '释放 chat-a1b2c3d4' }))
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
    fireEvent.click(screen.getByRole('button', { name: '删除 chat-a1b2c3d4' }))
    const dialog = screen.getByRole('dialog', { name: '删除 chat-a1b2c3d4?' })
    expect(within(dialog).getByText('将释放进程并删除本地记录,之后无法重连该会话。')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(p.purge).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '删除 chat-a1b2c3d4' }))
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除' }))
    })
    expect(p.purge).toHaveBeenCalledWith(`chat-${UUID_A}`)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows a failed command and calls refresh from the header button', async () => {
    const p = props(ready([chat()]), { close: vi.fn(async () => { throw new Error('acp-resume/unknown-chat: gone') }) })
    render(<ChatsPanel {...p} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '释放 chat-a1b2c3d4' })) })
    expect(screen.getByRole('alert').textContent).toBe('操作失败:acp-resume/unknown-chat: gone')
    fireEvent.click(screen.getByRole('button', { name: '刷新会话' }))
    expect(p.refresh).toHaveBeenCalledTimes(1)
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
function mockRpc(rows: () => unknown = () => [], usage: () => PanelRpcResult = () => ({ ok: true, value: [] })): PanelRpc & { calls: [string, string, unknown][]; usageCalls: number } {
  const calls: [string, string, unknown][] = []
  const rpc = {
    calls,
    usageCalls: 0,
    call: vi.fn(async (channel: string, endpoint: string, payload: unknown): Promise<PanelRpcResult> => {
      if (endpoint === 'acpResume/usage') {
        rpc.usageCalls += 1
        return usage()
      }
      calls.push([channel, endpoint, payload])
      if (endpoint === 'acpResume/backends') return { ok: true, value: backendFixture }
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
    await source.close('chat-x')
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(listCalls(rpc)).toBeGreaterThan(idle + 1)
  })

  it('sorts newest first, sends close/purge with the chatId, and refreshes after each command', async () => {
    const older = chat({ chatId: `chat-${UUID_B}`, lastActive: NOW - 9_000_000 })
    const rpc = mockRpc(() => [older, chat()])
    const source = new ChatsSource(rpc, () => NOW)
    await source.refresh()
    expect(source.getSnapshot().chats.map(c => c.chatId)).toEqual([`chat-${UUID_A}`, `chat-${UUID_B}`])
    await source.close(`chat-${UUID_A}`)
    await source.purge(`chat-${UUID_B}`)
    await vi.waitFor(() => { expect(listCalls(rpc)).toBe(3) })
    expect(rpc.calls.filter(c => c[1] !== 'acpResume/list')).toEqual([
      ['/api', 'acpResume/close', { args: { chatId: `chat-${UUID_A}` } }],
      ['/api', 'acpResume/purge', { args: { chatId: `chat-${UUID_B}` } }],
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
    await expect(source.purge('x')).rejects.toThrow('acp-resume/unknown-chat: acp-resume: unknown chat x')
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
function stubServices() {
  const tabs: Record<string, unknown>[] = []
  const bodies: { options: { name: string; key: string; locale?: string; inject: () => unknown }; component: unknown }[] = []
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

describe('apply (client wiring)', () => {
  it('exports only apply and inject', () => {
    expect(Object.keys(client).sort()).toEqual(['apply', 'inject'])
    expect(client.inject).toEqual(['slots', 'locale', 'sidebarRightTabs'])
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
    fireEvent.click(screen.getByRole('button', { name: '删除 chat-a1b2c3d4' }))
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除' })) })
    expect(await screen.findByText('暂无 ACP 会话')).toBeTruthy()
    expect(rpc.calls).toContainEqual(['/api', 'acpResume/purge', { args: { chatId: `chat-${UUID_A}` } }])
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
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '释放 chat-a1b2c3d4' })) })
    expect(p.close).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '删除 chat-a1b2c3d4' }))
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
    useTabInfo: info.hook, sourceFor: () => source, close: vi.fn(async () => {}), purge: vi.fn(async () => {}), t, ...overrides,
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
    expect(container.querySelector('[data-meta]')?.textContent).toBe('2 轮 · 3 分钟前 · tmp')
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
    expect(container.querySelector('[data-meta]')?.textContent).toBe('review · 4 轮 · 3 分钟前 · tmp')
  })

  it('lists turns newest first as two borderless lines: question with time and non-completed tags, answer; events as one line on a rail', () => {
    const entries = [turn(1), lostEvent(2), turn(3, { stopReason: 'aborted', freshSession: true, message: '再问一次', output: '' })]
    const { injected } = detailProps(fakeSource(detailSnapshot({ entries })))
    const { container } = render(<ChatDetail {...injected} />)
    expect([...container.querySelectorAll('li')].map(li => li.getAttribute('data-seq'))).toEqual(['3', '2', '1'])
    const row3 = container.querySelector('[data-seq="3"]') as HTMLElement
    expect(within(row3).getByText('已取消').closest('[data-tag]')?.getAttribute('data-tone')).toBe('neutral')
    expect(within(row3).getByText('新会话').closest('[data-tag]')?.getAttribute('data-tone')).toBe('info')
    expect(within(row3).getByText('9 分钟前')).toBeTruthy()
    expect(row3.querySelector('[data-answer]')?.textContent).toBe('(无回答文本)')
    // The seq moved into the hover text; no Q/A labels, no border around the row.
    expect(row3.textContent).not.toContain('#3')
    expect(head(container, 3).getAttribute('title')).toBe('#3')
    expect(row3.style.border).toBe('')
    expect(row3.style.borderBottom).toMatch(/1px solid/)
    const row1 = container.querySelector('[data-seq="1"]') as HTMLElement
    expect(row1.querySelector('[data-tag]')).toBeNull()
    expect(row1.querySelector('[data-question]')?.textContent).toBe('问题1')
    expect(row1.querySelector('[data-answer]')?.textContent).toBe('回答1')
    expect(within(row1).queryByText(/^[问答]$/)).toBeNull()
    const event = container.querySelector('[data-event="session-lost"]') as HTMLElement
    expect(event.querySelector('[data-tag]')).toBeNull()
    expect(event.textContent).toBe('远端会话已丢失,已新开会话5 分钟前')
    expect(event.style.borderLeft).toMatch(/3px solid/)
  })

  it('puts a running entry on top with a spinner, its first two lines, and a live timer; the meta line switches to running', async () => {
    const running: RunningItem = { kind: 'running', startedAt: NOW - 80_000, message: `第一行\n第二行\n${'长文本'.repeat(80)}` }
    const source = fakeSource(detailSnapshot({ entries: [running, turn(1)] }))
    const { container } = render(<ChatDetail {...detailProps(source).injected} />)
    const top = container.querySelector('li') as HTMLElement
    expect(top.hasAttribute('data-running')).toBe(true)
    expect(top.querySelector('[data-dot]')?.getAttribute('data-dot')).toBe('ongoing')
    expect(top.querySelector('[data-running-preview]')?.textContent).toBe('第一行\n第二行')
    expect(within(top).getByText('已运行 1分20秒')).toBeTruthy()
    expect(container.querySelector('[data-meta]')?.textContent).toBe('进行中 1分20秒 · tmp')
    await act(async () => { fireEvent.click(within(top).getByRole('button', { name: '展开进行中的消息' })) })
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
    expect((container.querySelector('[data-event="reconnect-failed"]') as HTMLElement).textContent).toBe('重连失败:process exited · 未能发送:继续2 分钟前')
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
    expect(q.textContent).toBe('问一\n问二')
    expect(a.textContent).toBe('答一\n答二\n答三')
    expect(q.style.webkitLineClamp).toBe('2')
    expect(a.style.webkitLineClamp).toBe('3')
    expect(container.querySelector('[data-seq="1"] [data-full-hint]')?.textContent).toBe('全文 · 4 行')
    expect(container.querySelector('[data-seq="2"] [data-full-hint]')).toBeNull()
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
    const rail = (seq: number): [string | null, string] => {
      const row = container.querySelector(`[data-seq="${seq}"]`) as HTMLElement
      return [row.getAttribute('data-rail'), row.style.borderLeft]
    }
    expect(rail(1)).toEqual([null, ''])
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
    expect(container.querySelector('[data-meta]')?.textContent).toBe('12 轮 · 3 分钟前 · dsh-acp-resume')
    expect(screen.getByRole('heading', { level: 2 }).getAttribute('title')).toContain('cwd /Users/me/Developer/dsh-acp-resume')
  })

  it('marks a cut turn with "full text · N lines" at the end of the answer line, and a fully shown one with nothing', () => {
    const entries = [turn(1, { message: '一\n二\n三', messageMore: true }), turn(2, { message: '就一行', output: '也一行' })]
    const { container } = render(<ChatDetail {...detailProps(fakeSource(detailSnapshot({ entries }))).injected} />)
    expect(container.querySelector('[data-seq="1"] [data-full-hint]')?.textContent).toBe('全文 · 3 行')
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

  it('shows the failure when the full text cannot be read, keeping the preview', async () => {
    const source = fakeSource(detailSnapshot({ entries: [turn(1, { message: '问…', messageMore: true })] }), async () => { throw new Error('acp-resume/unknown-turn: trimmed') })
    const { container } = render(<ChatDetail {...detailProps(source).injected} />)
    await act(async () => { fireEvent.click(head(container, 1)) })
    expect(screen.getByRole('alert').textContent).toBe('读取全文失败:acp-resume/unknown-turn: trimmed')
    expect(container.querySelector('[data-full="message"]')?.textContent).toBe('问…')
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
    expect(container.querySelector('[data-meta]')?.textContent).toBe('2 turns · 3 min ago · tmp')
    expect(within(container.querySelector('[data-seq="1"]') as HTMLElement).getByText('9 min ago')).toBeTruthy()
    expect(container.querySelector('[data-full-hint]')?.textContent).toBe('full text · 2 lines')
    expect(screen.getByRole('button', { name: 'More actions' })).toBeTruthy()
  })

  it('an address that names no chat shows a notice instead of throwing', () => {
    const { injected } = detailProps(fakeSource(detailSnapshot()), {}, tabInfo('dsh-resource://acp-resume-chat/'))
    render(<ChatDetail {...injected} />)
    expect(screen.getByRole('alert').textContent).toBe('该会话已删除')
  })
})

describe('ChatDetailTitle', () => {
  it('shows the label when there is one, else the short id', () => {
    const labelled = detailProps(fakeSource(detailSnapshot()))
    const { container, unmount } = render(<ChatDetailTitle useTabInfo={labelled.injected.useTabInfo} sourceFor={labelled.injected.sourceFor} />)
    expect(container.textContent).toBe('审阅')
    unmount()
    const bare = detailProps(fakeSource(detailSnapshot({ chat: chat() })))
    const second = render(<ChatDetailTitle useTabInfo={bare.injected.useTabInfo} sourceFor={bare.injected.sourceFor} />)
    expect(second.container.textContent).toBe('chat-a1b2c3d4')
  })
})

/** Mock carrier for the detail source: `acpResume/turns` and `acpResume/turn`. */
function detailRpc(handlers: { turns?: (args: Record<string, unknown>) => PanelRpcResult | Promise<PanelRpcResult>; turn?: (args: Record<string, unknown>) => PanelRpcResult } = {}) {
  const calls: [string, string, { args: Record<string, unknown> }][] = []
  const rpc: PanelRpc & { calls: typeof calls } = {
    calls,
    call: vi.fn(async (channel: string, endpoint: string, payload: unknown): Promise<PanelRpcResult> => {
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
})

describe('snapshot-equal (D21)', () => {
  it('chatEqual compares every rendered field, including ownerSessionId', () => {
    const base = chat({ label: 'x', title: 't', turnCount: 3, ownerSessionId: 's1' })
    expect(chatEqual(base, { ...base })).toBe(true)
    for (const diff of [{ label: 'y' }, { title: 'u' }, { turnCount: 4 }, { active: false }, { lastActive: base.lastActive + 1 }, { cwd: '/z' }, { remoteSessionId: 'r2' }, { ownerSessionId: 's2' }, { backend: 'review' }, { backendCount: 2 }] as Partial<PanelChat>[]) {
      expect(chatEqual(base, { ...base, ...diff })).toBe(false)
    }
  })

  it('chatEqual tracks backend', () => {
    const base = chat({ backend: 'default', backendCount: 2 })
    expect(chatEqual(base, { ...base, backend: 'review' })).toBe(false)
    expect(chatEqual(base, { ...base, backendCount: 1 })).toBe(false)
    expect(chatEqual(base, { ...base, backendDisplay: 'kiro-cli' })).toBe(false)
    expect(chatEqual(base, { ...base, attention: 'error' })).toBe(false)
    expect(chatEqual(base, { ...base, lastCompleted: true })).toBe(false)
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
    expect(detailSnapshotEqual(base, { status: 'ready', entries: [turn(1)], total: 1 })).toBe(false)
  })
})
