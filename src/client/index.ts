/**
 * Browser half of dsh-acp-resume (D15, PANEL-DESIGN §3.6.2): registers the
 * "persistent chats" right-sidebar page type (opened from the tab guide,
 * ruling A) and its body in the `sidebar.right.pane.tab` seat, plus the
 * chat detail tab type (D18): a resource type claiming
 * `dsh-resource://acp-resume-chat/**`, one tab per chat, opened from a card.
 * It registers no resource provider; each tab's data comes from a per-chat
 * source that polls only while the tab is mounted. Data comes
 * from the host `acpResume/*` Remote methods over `ctx.connection.rpc`
 * (§3.6.1 channel B). Everything registers inside the `connection` service's
 * scope: without that service nothing registers (one console warning), and it
 * withdraws if the service leaves. Exports only `apply` and `inject`.
 * @module dsh-acp-resume/client
 */

import type { Context } from '@deepseek-ai/cordis'
import { ChatsPanel, shortChatId } from './ChatsPanel.tsx'
import { ChatDetail, ChatDetailTitle } from './ChatDetail.tsx'
import { CHAT_ADDRESS_PATTERN, parseChatAddress } from './chat-address.ts'
import { ChatsSource, type PanelRpc } from './chats-source.ts'
import { ChatDetailSource } from './detail-source.ts'
import type { ChatDetailInjected, ChatsPanelInjected, DetailSource } from './face.ts'
import { en, PANEL_LOCALE, zh, type PanelCopyKey } from './locales.ts'

/** Tab implementation id, also the slot key of its body. */
const PANEL_ID = 'dsh-acp-resume'
/** Tab type discriminator. */
const PANEL_KIND = 'acp-resume.chats'
/** Detail tab implementation id, also the slot key of its body and chip title. */
const DETAIL_ID = 'dsh-acp-resume/chat'
/** Detail tab type discriminator. */
const DETAIL_KIND = 'acp-resume.chat'

type Disposer = () => void

/**
 * The official Client services this plugin reads, restated structurally on the
 * Cordis Context (no official Client package types are imported; §3.6.2).
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Connection carrier: generic logical RPC over the current transport. */
    connection: { readonly rpc: PanelRpc }
    /** Locale registry and translators. */
    locale: {
      register(namespace: string, dictionaries: Readonly<Record<'zh' | 'en', Readonly<Record<string, string>>>>): Disposer
      bind(namespace: string): (key: PanelCopyKey) => string
    }
    /** Right-sidebar tab type registry. */
    sidebarRightTabs: { register(definition: object): Disposer }
    /** Slot declarations and registrations. */
    slots: {
      inject(name: string, register: () => Disposer): Disposer
      register(options: object, component: unknown): Disposer
    }
  }
}

/** Required Cordis services; `connection` is taken reactively inside `apply`. */
export const inject = ['slots', 'locale', 'sidebarRightTabs']

/**
 * Register the panel while the `connection` service is present.
 * @param ctx - Client Cordis context.
 */
export function apply(ctx: Context): void {
  if (ctx.get('connection') === undefined) {
    console.warn('dsh-acp-resume: no connection service; the persistent-chat panel is not registered until one appears')
  }
  ctx.inject(['connection'], (scope) => {
    const source = new ChatsSource(scope.connection.rpc)
    scope.effect(() => () => { source.dispose() }, 'dsh-acp-resume.panel-source')
    const injected: ChatsPanelInjected = {
      hooks: { chats: source },
      refresh: () => { void source.refresh() },
      close: chatId => source.close(chatId),
      purge: chatId => source.purge(chatId),
    }
    // One source per chat, shared by the tab body and its chip title; each
    // polls only while one of them is mounted.
    const details = new Map<string, ChatDetailSource>()
    scope.effect(() => () => {
      for (const detail of details.values()) detail.dispose()
      details.clear()
    }, 'dsh-acp-resume.detail-sources')
    const detailInjected: ChatDetailInjected = {
      sourceFor: (chatId): DetailSource => {
        let detail = details.get(chatId)
        if (detail === undefined) {
          detail = new ChatDetailSource(scope.connection.rpc, chatId)
          details.set(chatId, detail)
        }
        return detail
      },
      close: chatId => source.close(chatId),
      purge: chatId => source.purge(chatId),
    }
    const t = scope.locale.bind(PANEL_LOCALE)
    scope.effect(() => scope.locale.register(PANEL_LOCALE, { zh, en }), 'dsh-acp-resume.copy')
    scope.effect(() => scope.sidebarRightTabs.register({
      id: PANEL_ID,
      kind: PANEL_KIND,
      title: () => t('title'),
      guide: [{ id: 'open', order: 90, title: () => t('title'), description: () => t('guideDescription') }],
    }), 'dsh-acp-resume.tab-type')
    scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register(
      { name: 'sidebar.right.pane.tab', key: PANEL_ID, locale: PANEL_LOCALE, inject: () => injected },
      ChatsPanel,
    )), 'dsh-acp-resume.tab-body')
    scope.effect(() => scope.sidebarRightTabs.register({
      id: DETAIL_ID,
      kind: DETAIL_KIND,
      patterns: [CHAT_ADDRESS_PATTERN],
      canOpen: (address: string) => parseChatAddress(address) !== undefined,
      title: (address: string) => {
        const chatId = parseChatAddress(address)
        return chatId === undefined ? t('title') : shortChatId(chatId)
      },
    }), 'dsh-acp-resume.detail-tab-type')
    scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register(
      { name: 'sidebar.right.pane.tab', key: DETAIL_ID, locale: PANEL_LOCALE, inject: () => detailInjected },
      ChatDetail,
    )), 'dsh-acp-resume.detail-body')
    scope.effect(() => scope.slots.inject('sidebar.right.pane.tab.title', () => scope.slots.register(
      { name: 'sidebar.right.pane.tab.title', key: DETAIL_ID, inject: () => detailInjected },
      ChatDetailTitle,
    )), 'dsh-acp-resume.detail-title')
  })
}
