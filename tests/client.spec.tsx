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
import * as client from '../src/client/index.ts'
import { ChatsPanel, relativeTime, shortChatId, type ChatsPanelProps } from '../src/client/ChatsPanel.tsx'
import { ChatsSource, IDLE_POLL_INTERVAL_MS, POLL_INTERVAL_MS, QUIET_POLLS_BEFORE_BACKOFF, type PanelRpc, type PanelRpcResult } from '../src/client/chats-source.ts'
import { ChatDetail, ChatDetailTitle, type ChatDetailProps } from '../src/client/ChatDetail.tsx'
import { CHAT_ADDRESS_PATTERN, chatAddress, parseChatAddress } from '../src/client/chat-address.ts'
import { ChatDetailSource, DETAIL_PAGE } from '../src/client/detail-source.ts'
import { chatEqual, chatsEqual, detailSnapshotEqual, listSnapshotEqual } from '../src/client/snapshot-equal.ts'
import type {
  ChatDetailInjected, ChatsPanelInjected, ChatsSnapshot, DetailSnapshot, DetailSource, EventItem, FullEntry, Observable,
  PanelChat, TabInfoHook, TurnItem,
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
}))

afterEach(() => {
  cleanup()
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

function chat(overrides: Partial<PanelChat> = {}): PanelChat {
  return {
    chatId: `chat-${UUID_A}`,
    remoteSessionId: '4fb07582-1111-4111-8111-111111111111',
    cwd: '/tmp',
    active: true,
    lastActive: NOW - 3 * 60_000,
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
    currentSessionId: undefined,
    refresh: vi.fn(),
    close: vi.fn(async () => {}),
    purge: vi.fn(async () => {}),
    t,
    ...overrides,
  }
}

const ready = (chats: readonly PanelChat[]): ChatsSnapshot => ({ status: 'ready', chats, fetchedAt: NOW })

describe('ChatsPanel', () => {
  it('shows the empty state with the start tool named', () => {
    render(<ChatsPanel {...props(ready([]))} />)
    expect(screen.getByText('暂无持久会话')).toBeTruthy()
    expect(screen.getByText('让模型调用 acp_chat_start 创建;之后的每一轮对话都在这里可见。')).toBeTruthy()
  })

  it('shows loading before the first answer and the failure text on error', () => {
    const { unmount } = render(<ChatsPanel {...props({ status: 'loading', chats: [] })} />)
    expect(screen.getByText('正在读取…')).toBeTruthy()
    unmount()
    render(<ChatsPanel {...props({ status: 'error', chats: [], error: 'gateway/internal: boom', fetchedAt: NOW })} />)
    expect(screen.getByRole('alert').textContent).toBe('读取失败:gateway/internal: boom')
  })

  it('renders one card per chat with every field, label when present, and placeholders for old rows', () => {
    const labelled = chat({ label: '审阅', title: '记住暗号P', turnCount: 12 })
    const legacy = chat({ chatId: `chat-${UUID_B}`, remoteSessionId: '9c0d1e2f-2222', cwd: '/work', active: false, lastActive: NOW - 2 * 3_600_000 })
    render(<ChatsPanel {...props(ready([labelled, legacy]))} />)
    fireEvent.click(screen.getByRole('button', { name: '已释放 (1) · 展开' }))
    const cards = screen.getAllByRole('listitem')
    expect(cards).toHaveLength(2)

    const first = within(cards[0] as HTMLElement)
    expect(first.getByText('●')).toBeTruthy()
    expect(first.getByText('审阅')).toBeTruthy()
    expect(first.getByText('chat-a1b2c3d4')).toBeTruthy()
    expect(first.getByText('记住暗号P')).toBeTruthy()
    expect(first.getByText('活跃 · 12 轮 · 3 分钟前', { exact: false })).toBeTruthy()
    expect(first.getByText('cwd /tmp · 远端 4fb07582')).toBeTruthy()

    const second = within(cards[1] as HTMLElement)
    expect(second.getByText('○')).toBeTruthy()
    expect(second.getByText('chat-e5f6a7b8')).toBeTruthy()
    expect(second.getByText('—')).toBeTruthy()
    expect(second.getByText('已释放(下次发送自动重连) · — 轮 · 2 小时前', { exact: false })).toBeTruthy()
    expect(second.getByText('cwd /work · 远端 9c0d1e2f')).toBeTruthy()
    // A released chat has nothing to release.
    expect((second.getByRole('button', { name: '释放 chat-e5f6a7b8' }) as HTMLButtonElement).disabled).toBe(true)
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
    expect(screen.queryByText('暂无持久会话')).toBeNull()
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
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(p.refresh).toHaveBeenCalledTimes(1)
  })
})

const MY_SESSION = 'session-mine-0001'
const OTHER_SESSION = 'session-other-0002'

describe('ChatsPanel attribution filter (D20)', () => {
  const rows = (): PanelChat[] => [
    chat({ chatId: 'chat-mine', ownerSessionId: MY_SESSION, lastActive: NOW - 1_000 }),
    chat({ chatId: 'chat-other', ownerSessionId: OTHER_SESSION, lastActive: NOW - 2_000 }),
    chat({ chatId: 'chat-legacy', lastActive: NOW - 3_000 }),
  ]
  const ids = (container: HTMLElement): (string | null)[] => [...container.querySelectorAll('li')].map(li => li.getAttribute('data-chat-id'))

  it('marks each card with its origin: this session (unmarked), other session, unknown', () => {
    const { container } = render(<ChatsPanel {...props(ready(rows()), { currentSessionId: MY_SESSION })} />)
    const meta = (id: string): HTMLElement => container.querySelector(`[data-chat-id="${id}"] [data-origin]`) as HTMLElement
    expect(meta('chat-mine').getAttribute('data-origin')).toBe('mine')
    expect(meta('chat-mine').textContent).not.toContain('其他会话')
    expect(meta('chat-mine').textContent).not.toContain('来源未知')
    expect(meta('chat-mine').textContent).not.toContain('本会话')
    expect(meta('chat-other').getAttribute('data-origin')).toBe('other')
    expect(meta('chat-other').textContent).toContain('其他会话')
    expect(meta('chat-legacy').getAttribute('data-origin')).toBe('unknown')
    expect(meta('chat-legacy').textContent).toContain('来源未知')
  })

  it('defaults to "all"; toggling to "this session" shows only this session\'s chats and back', () => {
    const { container } = render(<ChatsPanel {...props(ready(rows()), { currentSessionId: MY_SESSION })} />)
    // Default view: all three, count says 共 3 条.
    expect(ids(container)).toEqual(['chat-mine', 'chat-other', 'chat-legacy'])
    expect((container.querySelector('[data-count="all"]') as HTMLElement).textContent).toBe('共 3 条')
    const toggle = screen.getByRole('button', { name: '过滤范围' })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(toggle.textContent).toBe('全部')

    fireEvent.click(toggle)
    expect(ids(container)).toEqual(['chat-mine'])
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(toggle.textContent).toBe('本会话')
    expect((container.querySelector('[data-count="mine"]') as HTMLElement).textContent).toBe('本会话 1 条 / 共 3 条')

    fireEvent.click(toggle)
    expect(ids(container)).toEqual(['chat-mine', 'chat-other', 'chat-legacy'])
  })

  it('the "this session" filter shows a notice, not the empty state, when this session opened nothing', () => {
    const { container } = render(<ChatsPanel {...props(ready(rows()), { currentSessionId: 'session-fresh-9999' })} />)
    fireEvent.click(screen.getByRole('button', { name: '过滤范围' }))
    expect(ids(container)).toEqual([])
    expect(container.querySelector('[data-empty="mine"]')?.textContent).toBe('本会话 0 条 / 共 3 条')
    // Not the "no persistent chats" empty state: the chats exist, just not this session's.
    expect(screen.queryByText('暂无持久会话')).toBeNull()
  })

  it('offers no filter and no origin marks when no session is on screen', () => {
    const { container } = render(<ChatsPanel {...props(ready(rows()), { currentSessionId: undefined })} />)
    expect(screen.queryByRole('button', { name: '过滤范围' })).toBeNull()
    // Owner is known but there is no viewer to compare against, so owned chats read as "other".
    expect((container.querySelector('[data-chat-id="chat-mine"] [data-origin]') as HTMLElement).getAttribute('data-origin')).toBe('other')
    expect((container.querySelector('[data-chat-id="chat-legacy"] [data-origin]') as HTMLElement).getAttribute('data-origin')).toBe('unknown')
    expect(ids(container)).toEqual(['chat-mine', 'chat-other', 'chat-legacy'])
  })

  it('has the filter and origin copy in both locales', () => {
    for (const key of ['filterAll', 'filterMine', 'filterLabel', 'countAll', 'countMine', 'originOther', 'originUnknown'] as const) {
      expect(zh[key]).toBeTruthy()
      expect(en[key]).toBeTruthy()
    }
    const { container } = render(<ChatsPanel {...props(ready(rows()), { currentSessionId: MY_SESSION, t: translator(en) })} />)
    expect((container.querySelector('[data-chat-id="chat-other"] [data-origin]') as HTMLElement).textContent).toContain('other session')
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }))
    expect((container.querySelector('[data-count="mine"]') as HTMLElement).textContent).toBe('This session 1 of 3')
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
function mockRpc(rows: () => unknown = () => []): PanelRpc & { calls: [string, string, unknown][] } {
  const calls: [string, string, unknown][] = []
  return {
    calls,
    call: vi.fn(async (channel: string, endpoint: string, payload: unknown): Promise<PanelRpcResult> => {
      calls.push([channel, endpoint, payload])
      return endpoint === 'acpResume/list' ? { ok: true, value: rows() } : { ok: true, value: null }
    }),
  }
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
    expect(source.getSnapshot()).toEqual({ status: 'ready', chats: [chat()], fetchedAt: NOW })
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
      status: 'error', chats: [chat()], fetchedAt: NOW, error: 'transport failure for /api/acpResume/list: HTTP 502',
    })
  })

  it('drops an answer older than the latest refresh, and everything after dispose', async () => {
    const answers: ((value: PanelRpcResult) => void)[] = []
    const rpc: PanelRpc = { call: () => new Promise((resolve) => { answers.push(resolve) }) }
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
    expect(tab.title()).toBe('持久会话')
    expect(tab.guide.map(entry => entry.title())).toEqual(['持久会话'])
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

    renderBody(body.options.inject() as ChatsPanelInjected)
    expect(await screen.findByText('记住暗号P')).toBeTruthy()
    expect(rpc.calls[0]).toEqual(['/api', 'acpResume/list', { args: {} }])
    rows = []
    fireEvent.click(screen.getByRole('button', { name: '删除 chat-a1b2c3d4' }))
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除' })) })
    expect(await screen.findByText('暂无持久会话')).toBeTruthy()
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

describe('ChatDetail (D18)', () => {
  it('shows the chat identity and meta, turns newest first with status tags, fresh badge, and a reconnect event set apart', () => {
    const entries = [turn(1), lostEvent(2), turn(3, { stopReason: 'aborted', freshSession: true, message: '再问一次', output: '' })]
    const { injected } = detailProps(fakeSource(detailSnapshot({ entries })))
    const { container } = render(<ChatDetail {...injected} />)
    // Zone 1: identity is the heading, with a state dot and the short id beside it.
    expect((screen.getByRole('heading', { level: 2 })).textContent).toBe('审阅')
    expect(container.querySelector('[data-state-dot]')?.getAttribute('data-state')).toBe('done')
    expect(screen.getByText('chat-a1b2c3d4')).toBeTruthy()
    // Zone 2: meta strip, quiet and factual.
    expect(screen.getByText('活跃')).toBeTruthy()
    expect(screen.getByText('首轮:记住暗号P')).toBeTruthy()
    expect(screen.getByText('cwd /tmp')).toBeTruthy()
    expect(screen.getByText('远端 4fb07582')).toBeTruthy()
    // Zone 3: turns newest first; events keep their place in the sequence.
    expect([...container.querySelectorAll('li')].map(li => li.getAttribute('data-seq'))).toEqual(['3', '2', '1'])
    // Stop reason is a status tag, not run-together text; time and seq are demoted.
    const card3 = container.querySelector('[data-seq="3"]') as HTMLElement
    expect(within(card3).getByText('已取消').closest('[data-tag]')?.getAttribute('data-tone')).toBe('neutral')
    expect(within(card3).getByText('新会话').closest('[data-tag]')?.getAttribute('data-tone')).toBe('info')
    expect(within(card3).getByText('#3')).toBeTruthy()
    expect(within(card3).getByText('9 分钟前')).toBeTruthy()
    const card1 = container.querySelector('[data-seq="1"]') as HTMLElement
    expect(within(card1).getByText('已完成').closest('[data-tag]')?.getAttribute('data-tone')).toBe('success')
    // Collapsed Q/A previews carry labelled first lines.
    expect(within(card1).getByText('问题1')).toBeTruthy()
    expect(within(card1).getByText('回答1')).toBeTruthy()
    expect(within(card3).getByText('(无回答文本)')).toBeTruthy()
    // The reconnect event is an event card with a "connection" tag, visually set
    // apart from turns: no expand control, no Q/A structure.
    const event = container.querySelector('[data-event="session-lost"]') as HTMLElement
    expect(within(event).queryByRole('button')).toBeNull()
    expect(within(event).queryByText('问')).toBeNull()
    expect(within(event).getByText('连接').closest('[data-tag]')?.getAttribute('data-tone')).toBe('warning')
    expect(within(event).getByText('远端会话已丢失,已新开会话')).toBeTruthy()
    expect(within(event).getByText('5 分钟前')).toBeTruthy()
    // An event sits in a distinct left-rail container, not the turn-card style.
    expect((event.getAttribute('style') ?? '')).toMatch(/border-left/)
  })

  it('shows a reconnect failure with the unsent message', () => {
    const failed: EventItem = { seq: 1, kind: 'event', event: 'reconnect-failed', at: NOW - 60_000 * 2, message: '继续', error: 'process exited' }
    const { injected } = detailProps(fakeSource(detailSnapshot({ entries: [failed] })))
    const { container } = render(<ChatDetail {...injected} />)
    const event = container.querySelector('[data-event="reconnect-failed"]') as HTMLElement
    expect(within(event).getByText('连接')).toBeTruthy()
    expect(within(event).getByText('重连失败:process exited · 未能发送:继续')).toBeTruthy()
  })

  it('shows a placeholder for an empty log, and none while loading', () => {
    const { injected } = detailProps(fakeSource(detailSnapshot()))
    const { unmount } = render(<ChatDetail {...injected} />)
    expect(screen.getByText('暂无轮次记录(此前的轮次没有被记录)。')).toBeTruthy()
    unmount()
    const loading = detailProps(fakeSource({ status: 'loading', entries: [], total: 0 }))
    render(<ChatDetail {...loading.injected} />)
    expect(screen.queryByText('暂无轮次记录(此前的轮次没有被记录)。')).toBeNull()
    expect(screen.getByText('正在读取…')).toBeTruthy()
  })

  it('the primary expand entry is a bottom button on the reading line, which toggles to a collapse button in place', async () => {
    const { injected } = detailProps(fakeSource(detailSnapshot({ entries: [turn(1, { messageMore: true })] })))
    const { container } = render(<ChatDetail {...injected} />)
    const card = container.querySelector('[data-seq="1"]') as HTMLElement
    const foot = within(card).getByRole('button', { name: '展开第 1 条' })
    // It is the bottom-of-card button (not the header row), carrying the hint text.
    expect(foot.getAttribute('data-turn-foot')).toBe('')
    expect(foot.textContent).toContain('展开查看全文')
    expect(foot.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { fireEvent.click(foot) })
    // Same place becomes a collapse button once open.
    const collapse = within(card).getByRole('button', { name: '收起第 1 条' })
    expect(collapse.getAttribute('data-turn-foot')).toBe('')
    expect(collapse.textContent).toBe('收起')
    expect(collapse.getAttribute('aria-expanded')).toBe('true')
    await act(async () => { fireEvent.click(collapse) })
    expect(within(card).getByRole('button', { name: '展开第 1 条' }).getAttribute('aria-expanded')).toBe('false')
  })

  it('shows a line count on the expand button for a multi-line body', () => {
    const { injected } = detailProps(fakeSource(detailSnapshot({ entries: [turn(1, { message: '一\n二\n三', messageMore: true })] })))
    const { container } = render(<ChatDetail {...injected} />)
    expect(within(container.querySelector('[data-seq="1"]') as HTMLElement).getByRole('button', { name: '展开第 1 条' }).textContent).toBe('展开查看全文 · 共 3 行')
  })

  it('the turn header row toggles the turn and carries aria-expanded; there is no corner chevron', async () => {
    const { injected } = detailProps(fakeSource(detailSnapshot({ entries: [turn(1, { messageMore: true })] })))
    const { container } = render(<ChatDetail {...injected} />)
    const card = container.querySelector('[data-seq="1"]') as HTMLElement
    const head = card.querySelector('[data-turn-head]') as HTMLElement
    expect(head.getAttribute('role')).toBe('button')
    expect(head.getAttribute('aria-expanded')).toBe('false')
    expect(head.getAttribute('tabindex')).toBe('0')
    // The corner chevron is gone entirely: the header row is clickable, no angle marker.
    expect(card.querySelector('[data-chevron]')).toBeNull()
    expect(card.textContent).not.toContain('▾')
    expect(within(head).queryByRole('button')).toBeNull()
    await act(async () => { fireEvent.click(head) })
    expect(head.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('[data-seq="1"] [data-full="message"]')).not.toBeNull()
    // Keyboard reaches the row.
    await act(async () => { fireEvent.keyDown(head, { key: 'Enter' }) })
    expect(head.getAttribute('aria-expanded')).toBe('false')
    // The row's only clickability cue is its pointer cursor and a hover tint.
    expect(head.style.cursor).toBe('pointer')
    expect(head.style.background).toBe('')
    fireEvent.mouseEnter(head)
    expect(head.style.background).not.toBe('')
    fireEvent.mouseLeave(head)
    expect(head.style.background).toBe('')
  })

  it('a fully-shown turn offers no expand button; its header still toggles', async () => {
    const { injected } = detailProps(fakeSource(detailSnapshot({ entries: [turn(1, { message: '就一行', output: '也一行' })] })))
    const { container } = render(<ChatDetail {...injected} />)
    const card = container.querySelector('[data-seq="1"]') as HTMLElement
    expect(within(card).queryByRole('button', { name: /^展开第 1 条$/ })).toBeNull()
    expect(card.querySelector('[data-turn-foot]')).toBeNull()
    // The header still responds (it opens the same full regions, harmless when short).
    await act(async () => { fireEvent.click(card.querySelector('[data-turn-head]') as HTMLElement) })
    expect(container.querySelector('[data-seq="1"] [data-full="message"]')).not.toBeNull()
    // Open state offers the collapse button at the tail.
    expect(within(card).getByRole('button', { name: '收起第 1 条' }).textContent).toBe('收起')
  })

  it('previews show the first non-empty line, not a raw character slice of a multi-line message', () => {
    const multi = turn(1, { message: '\n  首行问题  \n第二行不该出现\n第三行', output: '首行回答\n第二行回答' })
    const { injected } = detailProps(fakeSource(detailSnapshot({ entries: [multi] })))
    const { container } = render(<ChatDetail {...injected} />)
    const card = container.querySelector('[data-seq="1"]') as HTMLElement
    expect(within(card).getByText('首行问题')).toBeTruthy()
    expect(within(card).queryByText(/第二行不该出现/)).toBeNull()
    expect(within(card).getByText('首行回答')).toBeTruthy()
    // A multi-line body is expandable even when the first line is short.
    expect(within(card).getByRole('button', { name: '展开第 1 条' })).toBeTruthy()
  })

  it('expands a turn on click: full text fetched once when the preview is cut, no fetch when it is complete', async () => {
    const cut = turn(1, { message: '问…', output: '答…', messageMore: true, outputMore: true })
    const whole = turn(2)
    const source = fakeSource(detailSnapshot({ entries: [cut, whole] }))
    const { injected } = detailProps(source)
    const { container } = render(<ChatDetail {...injected} />)
    expect(container.querySelector('[data-full]')).toBeNull()

    // The cut turn has a bottom expand button; the whole turn is opened from its header row.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '展开第 1 条' })) })
    expect(source.loadEntry).toHaveBeenCalledWith(1)
    // The full text sits in labelled, scrollable regions that keep line breaks.
    expect(container.querySelector('[data-seq="1"] [data-full="message"]')?.textContent).toBe('完整问题1')
    expect(container.querySelector('[data-seq="1"] [data-full="output"]')?.textContent).toBe('完整回答1')

    // Collapse, expand again: no second fetch.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '收起第 1 条' })) })
    expect(container.querySelector('[data-seq="1"] [data-full]')).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '展开第 1 条' })) })
    expect(source.loadEntry).toHaveBeenCalledTimes(1)

    // A turn whose preview is complete shows its text without asking the host (opened from the header row).
    await act(async () => { fireEvent.click(container.querySelector('[data-seq="2"] [data-turn-head]') as HTMLElement) })
    expect(source.loadEntry).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-seq="2"] [data-full="message"]')?.textContent).toBe('问题2')
  })

  it('keeps expansion independent per turn; the diagnostic hides behind its own toggle', async () => {
    const failed = turn(2, { stopReason: 'error', diagnostic: 'stage: prompt' })
    const { injected } = detailProps(fakeSource(detailSnapshot({ entries: [turn(1), failed] })))
    const { container } = render(<ChatDetail {...injected} />)
    await act(async () => { fireEvent.click(container.querySelector('[data-seq="2"] [data-turn-head]') as HTMLElement) })
    expect(container.querySelector('[data-seq="2"] [data-full]')).not.toBeNull()
    expect(container.querySelector('[data-seq="1"] [data-full]')).toBeNull()
    // The diagnostic is collapsed by default, behind a toggle.
    expect(container.querySelector('[data-diagnostic]')).toBeNull()
    const diagToggle = screen.getByRole('button', { name: '查看诊断' })
    fireEvent.click(diagToggle)
    expect(container.querySelector('[data-diagnostic]')?.textContent).toBe('stage: prompt')
    fireEvent.click(screen.getByRole('button', { name: '隐藏诊断' }))
    expect(container.querySelector('[data-diagnostic]')).toBeNull()
    // The error turn carries a danger status tag.
    const card2 = container.querySelector('[data-seq="2"]') as HTMLElement
    expect(within(card2).getByText('出错').closest('[data-tag]')?.getAttribute('data-tone')).toBe('danger')
  })

  it('shows the failure when the full text cannot be read, keeping the preview', async () => {
    const cut = turn(1, { message: '问…', messageMore: true })
    const source = fakeSource(detailSnapshot({ entries: [cut] }), async () => { throw new Error('acp-resume/unknown-turn: trimmed') })
    const { injected } = detailProps(source)
    const { container } = render(<ChatDetail {...injected} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '展开第 1 条' })) })
    expect(screen.getByRole('alert').textContent).toBe('读取全文失败:acp-resume/unknown-turn: trimmed')
    // The preview text is the fallback shown in the full region when the fetch failed.
    expect(container.querySelector('[data-full="message"]')?.textContent).toBe('问…')
  })

  it('offers older entries when the log holds more than is shown', () => {
    const source = fakeSource(detailSnapshot({ entries: [turn(5), turn(6)], total: 6 }))
    const { injected } = detailProps(source)
    render(<ChatDetail {...injected} />)
    expect(screen.getByText('显示最近 2 / 共 6 条')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '加载更早的记录' }))
    expect(source.loadMore).toHaveBeenCalledTimes(1)
  })

  it('shows no load-more when everything is shown', () => {
    const { injected } = detailProps(fakeSource(detailSnapshot({ entries: [turn(1)], total: 1 })))
    render(<ChatDetail {...injected} />)
    expect(screen.queryByRole('button', { name: '加载更早的记录' })).toBeNull()
  })

  it('refreshes from the header, and shows a load error above the kept data', () => {
    const source = fakeSource(detailSnapshot({ status: 'error', error: 'HTTP 502', entries: [turn(1)] }))
    const { injected } = detailProps(source)
    render(<ChatDetail {...injected} />)
    expect(screen.getByRole('alert').textContent).toBe('读取失败:HTTP 502')
    expect(screen.getByText('问题1')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(source.refresh).toHaveBeenCalledTimes(1)
  })

  it('releases from the detail page, and a released chat has nothing to release', async () => {
    const source = fakeSource(detailSnapshot())
    const { injected } = detailProps(source)
    const { unmount } = render(<ChatDetail {...injected} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '释放 chat-a1b2c3d4' })) })
    expect(injected.close).toHaveBeenCalledWith(`chat-${UUID_A}`)
    expect(source.refresh).toHaveBeenCalled()
    unmount()
    const released = detailProps(fakeSource(detailSnapshot({ chat: chat({ active: false }) })))
    render(<ChatDetail {...released.injected} />)
    expect((screen.getByRole('button', { name: '释放 chat-a1b2c3d4' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/已释放\(下次发送自动重连\)/)).toBeTruthy()
  })

  it('asks before deleting; cancel deletes nothing; confirming purges and closes the tab', async () => {
    const source = fakeSource(detailSnapshot())
    const { injected, info } = detailProps(source)
    render(<ChatDetail {...injected} />)
    fireEvent.click(screen.getByRole('button', { name: '删除 chat-a1b2c3d4' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }))
    expect(injected.purge).not.toHaveBeenCalled()
    expect(info.closeTab).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '删除 chat-a1b2c3d4' }))
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除' })) })
    expect(injected.purge).toHaveBeenCalledWith(`chat-${UUID_A}`)
    expect(info.closeTab).toHaveBeenCalledTimes(1)
  })

  it('a failed delete keeps the tab open and shows the failure', async () => {
    const { injected, info } = detailProps(fakeSource(detailSnapshot()), { purge: vi.fn(async () => { throw new Error('acp-resume/unknown-chat: x') }) })
    render(<ChatDetail {...injected} />)
    fireEvent.click(screen.getByRole('button', { name: '删除 chat-a1b2c3d4' }))
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
    render(<><ChatDetail {...first.injected} /><ChatDetail {...second.injected} /></>)
    expect(screen.getByText('乙')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: '展开第 1 条' })[0] as HTMLElement) })
    expect(a.loadEntry).toHaveBeenCalledTimes(1)
    expect(b.loadEntry).not.toHaveBeenCalled()
  })

  it('renders in English too', () => {
    const { injected } = detailProps(fakeSource(detailSnapshot({ entries: [turn(1, { messageMore: true })] })), { t: translator(en) })
    const { container } = render(<ChatDetail {...injected} />)
    expect(screen.getByText('Turn history')).toBeTruthy()
    const card = container.querySelector('[data-seq="1"]') as HTMLElement
    expect(within(card).getByText('completed')).toBeTruthy()
    expect(within(card).getByText('9 min ago')).toBeTruthy()
    expect((card.querySelector('[data-turn-foot]') as HTMLElement).textContent).toBe('Expand full text')
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
    for (const diff of [{ label: 'y' }, { title: 'u' }, { turnCount: 4 }, { active: false }, { lastActive: base.lastActive + 1 }, { cwd: '/z' }, { remoteSessionId: 'r2' }, { ownerSessionId: 's2' }] as Partial<PanelChat>[]) {
      expect(chatEqual(base, { ...base, ...diff })).toBe(false)
    }
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
