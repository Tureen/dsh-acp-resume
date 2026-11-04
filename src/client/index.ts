/**
 * Browser half of dsh-acp-resume (D15, PANEL-DESIGN §3.6.2): registers the
 * "persistent chats" right-sidebar page type (opened from the tab guide,
 * ruling A) and its body in the `sidebar.right.pane.tab` seat. Data comes
 * from the host `acpResume/*` Remote methods over `ctx.connection.rpc`
 * (§3.6.1 channel B). Everything registers inside the `connection` service's
 * scope: without that service nothing registers (one console warning), and it
 * withdraws if the service leaves. Exports only `apply` and `inject`.
 * @module dsh-acp-resume/client
 */

import type { Context } from '@deepseek-ai/cordis'
import { ChatsPanel } from './ChatsPanel.tsx'
import { ChatsSource, type PanelRpc } from './chats-source.ts'
import type { ChatsPanelInjected } from './face.ts'
import { en, PANEL_LOCALE, zh, type PanelCopyKey } from './locales.ts'

/** Tab implementation id, also the slot key of its body. */
const PANEL_ID = 'dsh-acp-resume'
/** Tab type discriminator. */
const PANEL_KIND = 'acp-resume.chats'

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
  })
}
