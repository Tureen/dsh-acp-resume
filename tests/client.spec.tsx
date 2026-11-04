// @vitest-environment jsdom
/**
 * Browser-half tests (PANEL-DESIGN §4): the panel component fed realistic
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
import { ChatsSource, POLL_INTERVAL_MS, type PanelRpc, type PanelRpcResult } from '../src/client/chats-source.ts'
import type { ChatsPanelInjected, ChatsSnapshot, Observable, PanelChat } from '../src/client/face.ts'
import { zh, type PanelTranslate } from '../src/client/locales.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children, variant: _variant, size: _size, icon: _icon, ...rest }: Record<string, unknown> & { children?: ReactNode }) =>
    <button type="button" {...rest}>{children}</button>,
  Modal: ({ open, title, description, footer }: { open: boolean; title: string; description?: string; footer?: ReactNode }) =>
    open ? <div role="dialog" aria-label={title}><h3>{title}</h3><p>{description}</p>{footer}</div> : null,
}))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** The zh dictionary with `{name}` interpolation, as the locale seat renders it. */
const t: PanelTranslate = (key, params) =>
  zh[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? `{${name}}`))

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

function props(snapshot: ChatsSnapshot, overrides: Partial<ChatsPanelProps> = {}): ChatsPanelProps {
  return {
    useChats: staticHook(snapshot),
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
    const cards = screen.getAllByRole('listitem')
    expect(cards).toHaveLength(2)

    const first = within(cards[0] as HTMLElement)
    expect(first.getByText('●')).toBeTruthy()
    expect(first.getByText('审阅')).toBeTruthy()
    expect(first.getByText('chat-a1b2c3d4')).toBeTruthy()
    expect(first.getByText('记住暗号P')).toBeTruthy()
    expect(first.getByText('活跃 · 12 轮 · 3 分钟前')).toBeTruthy()
    expect(first.getByText('cwd /tmp · 远端 4fb07582')).toBeTruthy()

    const second = within(cards[1] as HTMLElement)
    expect(second.getByText('○')).toBeTruthy()
    expect(second.getByText('chat-e5f6a7b8')).toBeTruthy()
    expect(second.getByText('—')).toBeTruthy()
    expect(second.getByText('已释放(下次发送自动重连) · — 轮 · 2 小时前')).toBeTruthy()
    expect(second.getByText('cwd /work · 远端 9c0d1e2f')).toBeTruthy()
    // A released chat has nothing to release.
    expect((second.getByRole('button', { name: '释放 chat-e5f6a7b8' }) as HTMLButtonElement).disabled).toBe(true)
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
    expect(source.getSnapshot()).not.toBe(before)
    stopA()
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(listCalls(rpc)).toBe(3)
    stopB()
    await vi.advanceTimersByTimeAsync(3 * POLL_INTERVAL_MS)
    expect(listCalls(rpc)).toBe(3)
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
  const bodies: { options: { name: string; key: string; locale: string; inject: () => ChatsPanelInjected }; component: unknown }[] = []
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
    return <ChatsPanel {...rest} useChats={useChats} t={t} />
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

    expect(services.tabs).toHaveLength(1)
    const tab = services.tabs[0] as { id: string; kind: string; title: () => string; guide: { title: () => string }[]; patterns?: unknown; multiple?: unknown }
    expect(tab).toMatchObject({ id: 'dsh-acp-resume', kind: 'acp-resume.chats' })
    expect(tab.patterns).toBeUndefined()
    expect(tab.multiple).toBeUndefined()
    expect(tab.title()).toBe('持久会话')
    expect(tab.guide.map(entry => entry.title())).toEqual(['持久会话'])
    expect(services.dictionaries).toEqual(['acpResumePanel'])
    expect(services.bodies).toHaveLength(1)
    const body = services.bodies[0] as (typeof services.bodies)[number]
    expect(body.options).toMatchObject({ name: 'sidebar.right.pane.tab', key: 'dsh-acp-resume', locale: 'acpResumePanel' })
    expect(body.component).toBe(ChatsPanel)

    renderBody(body.options.inject())
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
    await vi.waitFor(() => { expect(services.tabs).toHaveLength(1) })
    expect(services.bodies).toHaveLength(1)
    expect(warn).toHaveBeenCalledTimes(1)
    await fiber.dispose()
    expect(services.tabs).toHaveLength(0)
  })
})
