/** One capability read per shared panel opening or connection reset (D35).
 * @module dsh-acp-resume/client/features-source
 */
import type { PanelFeatures } from '../panel-features.ts'
import type { PanelRpc } from './chats-source.ts'
import type { FeatureStore, FeatureView } from './face.ts'

function isFeatures(value: unknown): value is PanelFeatures {
  if (typeof value !== 'object' || value === null) return false
  const fields: Partial<PanelFeatures> = value
  return typeof fields.chatToolsEnabled === 'boolean' && typeof fields.workflowEnabled === 'boolean'
    && (fields.rolesEnabled === undefined || typeof fields.rolesEnabled === 'boolean')
    && typeof fields.startToolName === 'string'
}

const loading: FeatureView = { status: 'loading' }

/** Shares in-flight reads. Explicit refresh, reopening and reconnecting revalidate configuration. */
export class FeaturesSource implements FeatureStore {
  private view: FeatureView = loading
  private readonly listeners = new Set<() => void>()
  private generation = 0
  private pending?: Promise<void>
  private disposed = false
  private recheckOnOpen = true

  constructor(private readonly rpc: PanelRpc) {}

  readonly getSnapshot = (): FeatureView => this.view

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    if (this.recheckOnOpen) {
      this.recheckOnOpen = false
      void this.refresh()
    }
    return () => {
      if (!this.listeners.delete(listener)) return
      // A body may reopen while another tab or its title still holds a subscription.
      this.recheckOnOpen = true
      if (!this.listeners.size) this.reset()
    }
  }

  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const generation = this.generation
    return this.pending ??= this.read(generation).finally(() => {
      if (generation === this.generation) this.pending = undefined
    })
  }

  /** Discard the previous transport's answer, including a read that has yet to settle. */
  reset(): void {
    this.generation++
    this.pending = undefined
    this.publish(loading)
    if (this.listeners.size) void this.refresh()
  }

  dispose(): void {
    this.disposed = true
    this.listeners.clear()
    this.reset()
  }

  private async read(generation: number): Promise<void> {
    let next: FeatureView
    try {
      const result = await this.rpc.call('/api', 'acpResumeInfo/features', { args: {} })
      if (!result.ok) {
        next = result.error.code === 'gateway/invocation-unavailable'
          ? { status: 'legacy' }
          : { status: 'error', message: `${result.error.code}: ${result.error.message}` }
      } else {
        if (!isFeatures(result.value)) throw new Error('Invalid acpResumeInfo/features response')
        next = { status: 'ready', features: result.value }
      }
    } catch (error) {
      next = { status: 'error', message: error instanceof Error ? error.message : String(error) }
    }
    if (generation === this.generation) this.publish(next)
  }

  private publish(next: FeatureView): void {
    if (next.status === this.view.status) {
      if (next.status === 'legacy' || next.status === 'loading') return
      if (next.status === 'ready' && this.view.status === 'ready') {
        const old = this.view.features
        if (old.chatToolsEnabled === next.features.chatToolsEnabled
          && old.rolesEnabled === next.features.rolesEnabled
          && old.workflowEnabled === next.features.workflowEnabled
          && old.startToolName === next.features.startToolName) return
      }
      if (next.status === 'error' && this.view.status === 'error' && next.message === this.view.message) return
    }
    this.view = next
    for (const listener of this.listeners) listener()
  }
}
