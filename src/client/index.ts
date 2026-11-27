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
import { FeaturesSource } from './features-source.ts'
import { BackendStatusSource } from './backend-status-source.ts'
import { LiveSource, watchDescriptor, type WatchRemote } from './live-source.ts'
import { callPanel, ChatsSource, type PanelRpc } from './chats-source.ts'
import { ChatDetailSource } from './detail-source.ts'
import { WorkflowsSource } from './workflows-source.ts'
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
  interface Events {
    'connection/reset'(): void
  }
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
    /** Client Remote service carrying the mounted stream namespace. */
    remote: WatchRemote
  }
}

/** Required Cordis services; `connection` is taken reactively inside `apply`. */
// `remote` is injected at the top level so child scopes (`scope` and `faceScope`) can resolve
// `.remote` via the ancestor fiber chain (`scope.remote.$mount(...)` and `faceScope.remote.acpResume`).
// Access to `remote.acpResume` itself is checked on the accessing scope, so it is only read from
// a child scope that explicitly injected `remote.acpResume`.
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'remote']

/**
 * Register the panel while the `connection` service is present.
 * @param ctx - Client Cordis context.
 */
export function apply(ctx: Context): void {
  if (ctx.get('connection') === undefined) {
    console.warn('dsh-acp-resume: no connection service; the persistent-chat panel is not registered until one appears')
  }
  ctx.inject(['connection'], (scope) => {
    const features = new FeaturesSource(scope.connection.rpc)
    scope.on('connection/reset', () => features.reset())
    scope.effect(() => () => features.dispose(), 'dsh-acp-resume.panel-features')
    const source = new ChatsSource(scope.connection.rpc)
    scope.effect(() => () => { source.dispose() }, 'dsh-acp-resume.panel-source')
    const backendStatus = new BackendStatusSource(scope.connection.rpc)
    scope.effect(() => () => { backendStatus.dispose() }, 'dsh-acp-resume.backend-status-source')
    // One workflow source per on-screen session (D29); each polls only while its panel is mounted.
    const workflowSources = new Map<string, WorkflowsSource>()
    scope.effect(() => () => {
      for (const workflows of workflowSources.values()) workflows.dispose()
      workflowSources.clear()
    }, 'dsh-acp-resume.workflow-sources')
    const workflowsFor = (sessionId: string, poll: boolean): WorkflowsSource => {
      const key = `${poll ? 'live' : 'history'}:${sessionId}`
      let workflows = workflowSources.get(key)
      if (workflows === undefined) {
        workflows = new WorkflowsSource(scope.connection.rpc, sessionId, poll)
        workflowSources.set(key, workflows)
      }
      return workflows
    }
    const injectedFor = (sessionId: string | undefined): ChatsPanelInjected => ({
      features,
      hooks: { chats: source.forSession(sessionId) },
      backendStatus,
      ...(sessionId === undefined ? {} : { workflowsFor: (poll: boolean) => workflowsFor(sessionId, poll) }),
      // The seat is session-scoped: `inject(sessionId)` names the on-screen
      // session, used for filtering and owner-aware panel calls (D20/D44).
      currentSessionId: sessionId,
      profileForms: () => {
        const forms = scope.get('configForms') as { get(id: string): import('./ProfileSettings.tsx').SettingsForm } | undefined
        return forms && { main: forms.get('subagent-acp-resume'), dispatcher: forms.get('acp-dispatcher-settings') }
      },
      settings: {
        read: async chatId => await callPanel(scope.connection.rpc, 'chatOptions', { chatId, sessionId }) as import('../chat-options.ts').ChatOptions,
        change: async (chatId, field, value) => {
          const method = field === 'model' ? 'setChatModel' : 'setChatEffort'
          try { await callPanel(scope.connection.rpc, method, { chatId, sessionId, [field]: value }) }
          finally { void source.refresh() }
        },
      },
      refresh: async () => {
        await features.refresh()
        const view = features.getSnapshot()
        if (view.status !== 'legacy' && !(view.status === 'ready' && view.features.chatToolsEnabled)) return
        void source.refresh()
        if (sessionId !== undefined && view.status === 'ready' && !view.features.workflowEnabled) {
          workflowsFor(sessionId, false).refreshIfSubscribed()
        }
      },
      close: chatId => source.close(chatId, sessionId),
      purge: chatId => source.purge(chatId, sessionId),
    })
    // One source per chat, shared by the tab body and its chip title; each
    // polls only while one of them is mounted.
    const details = new Map<string, ChatDetailSource>()
    scope.effect(() => () => {
      for (const detail of details.values()) detail.dispose()
      details.clear()
    }, 'dsh-acp-resume.detail-sources')
    // `scope` inherits top-level `remote` via its parent fiber, so it mounts the stream descriptor
    // directly and saves the unmount disposer. Reading `remote.acpResume`, however, is checked by
    // Cordis on the accessing scope (`remote.<namespace>` is a separate service), so the watch face
    // is read only from a child scope that injected `remote.acpResume` — never lifted from `remote`.
    let disposed = false
    let watchScope: Context | undefined
    let watchFiber: { dispose(): Promise<void> } | undefined
    let unmountRemote: (() => void | Promise<void>) | undefined
    const mounted: Promise<void> = (async () => {
      const unmount = await scope.remote.$mount({ package: 'dsh-acp-resume', descriptors: [watchDescriptor] })
      if (disposed || scope.fiber.uid === null) {
        await unmount?.()
        return
      }
      unmountRemote = unmount
      const fiber = scope.inject(['remote.acpResume'], (faceScope) => {
        watchScope = faceScope
        return () => { watchScope = undefined }
      })
      watchFiber = fiber
      try {
        await fiber.await()
      } catch (error) {
        watchFiber = undefined
        await fiber.dispose()
        unmountRemote = undefined
        await unmount?.()
        throw error
      }
    })()
    mounted.catch(() => {})
    scope.effect(() => async () => {
      disposed = true
      const fiber = watchFiber
      watchFiber = undefined
      const unmount = unmountRemote
      unmountRemote = undefined
      if (fiber) await fiber.dispose()
      if (unmount) await unmount()
    }, 'dsh-acp-resume.remote-stream')
    const live = new LiveSource(async function* (chatId, owner, signal) {
      if (signal.aborted) return
      let onAbort: (() => void) | undefined
      try {
        await Promise.race([
          mounted,
          new Promise<void>(resolve => {
            onAbort = resolve
            signal.addEventListener('abort', onAbort, { once: true })
          }),
        ])
      } finally {
        if (onAbort) signal.removeEventListener('abort', onAbort)
      }
      if (signal.aborted) return
      const injected = watchScope
      if (!injected) throw new Error('Remote stream service unavailable')
      const handle = injected.remote.acpResume.watch(chatId, owner, signal)
      const cancel = () => handle.dispose()
      signal.addEventListener('abort', cancel, { once: true })
      try { yield* handle } finally { signal.removeEventListener('abort', cancel); cancel() }
    }, chatId => { void details.get(chatId)?.refresh() })
    scope.on('connection/reset', () => live.reset())
    scope.effect(() => () => live.dispose())
    const detailInjected = (sessionId?: string): ChatDetailInjected => ({
      followTurn: (chatId, startedAt, listener) => live.subscribe(chatId, sessionId, startedAt, listener),
      features,
      sourceFor: (chatId): DetailSource => {
        let detail = details.get(chatId)
        if (detail === undefined) {
          detail = new ChatDetailSource(scope.connection.rpc, chatId)
          details.set(chatId, detail)
        }
        return detail
      },
      close: chatId => source.close(chatId, sessionId),
      purge: chatId => source.purge(chatId, sessionId),
    })
    const t = scope.locale.bind(PANEL_LOCALE)
    scope.effect(() => scope.locale.register(PANEL_LOCALE, { zh, en }), 'dsh-acp-resume.copy')
    scope.effect(() => scope.sidebarRightTabs.register({
      id: PANEL_ID,
      kind: PANEL_KIND,
      title: () => t('title'),
      guide: [{ id: 'open', order: 90, title: () => t('title'), description: () => t('guideDescription') }],
    }), 'dsh-acp-resume.tab-type')
    scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register(
      { name: 'sidebar.right.pane.tab', key: PANEL_ID, locale: PANEL_LOCALE, inject: (sessionId: string | undefined) => injectedFor(sessionId) },
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
      { name: 'sidebar.right.pane.tab', key: DETAIL_ID, locale: PANEL_LOCALE, inject: detailInjected },
      ChatDetail,
    )), 'dsh-acp-resume.detail-body')
    scope.effect(() => scope.slots.inject('sidebar.right.pane.tab.title', () => scope.slots.register(
      { name: 'sidebar.right.pane.tab.title', key: DETAIL_ID, inject: detailInjected },
      ChatDetailTitle,
    )), 'dsh-acp-resume.detail-title')
  })
}
