/** Mount business subscriptions only after the shared capability decision (D35).
 * @module dsh-acp-resume/client/PanelFeatureGate
 */
import { useSyncExternalStore, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PanelFeatures } from '../panel-features.ts'
import type { FeatureStore } from './face.ts'
import type { PanelTranslate } from './locales.ts'

/** Tab bodies provide a translator; a title uses its resource address as the fallback. */
export function PanelFeatureGate({ source, t, fallback, children }: {
  source: FeatureStore
  t?: PanelTranslate
  fallback?: string
  children: (features?: PanelFeatures) => ReactNode
}): ReactNode {
  const view = useSyncExternalStore(source.subscribe, source.getSnapshot)
  if (view.status === 'legacy') return children()
  if (view.status === 'ready' && view.features.chatToolsEnabled) return children(view.features)
  if (!t) return fallback
  if (view.status === 'loading') return <p>{t('loading')}</p>
  return <p>{view.status === 'error' ? t('loadFailed', { message: view.message }) : t('chatsDisabled')}{' '}
    <Button size="sm" variant="ghost" onClick={() => { void source.refresh() }}>{t('refresh')}</Button>
  </p>
}
