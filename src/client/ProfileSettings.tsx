/** Edit the two live plugin entries using the official revision-fenced ConfigForm. @module */
import { useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { OVERRIDE_REQUIRES_RULES, WORKFLOW_REQUIRES_ROLES } from '../settings-rules.ts'
import type { PanelCopyKey, PanelTranslate } from './locales.ts'

type Value = boolean | number | string
interface Snapshot {
  readonly status: string
  readonly writable: boolean
  readonly revision?: number
  readonly value?: Record<string, unknown>
}
export interface SettingsForm {
  getSnapshot(): Snapshot
  subscribe(listener: () => void): () => void
  mutate(ops: readonly ({ op: 'set'; path: string[]; value: Value } | { op: 'unset'; path: string[] })[], revision?: number): Promise<boolean>
}
export interface ProfileForms { main: SettingsForm; dispatcher: SettingsForm }

const acknowledgment = 'dsh-acp-resume/profile-write-confirmed'
const sessionAcknowledgments = new Set<string | undefined>()
function acknowledged(sessionId?: string) {
  try { if (localStorage.getItem(acknowledgment) === 'true') return true } catch { /* Storage blocked. */ }
  return sessionAcknowledgments.has(sessionId)
}
function remember(sessionId?: string) {
  try { localStorage.setItem(acknowledgment, 'true') } catch { sessionAcknowledgments.add(sessionId) }
}

const mainFields = ['defaultBackend', 'roles', 'workflow', 'allowChatJobWait', 'allowUnverifiedBackends', 'idleTimeoutMs', 'probeTimeoutMs'] as const
const tools = ['readOnlyFs', 'web', 'present', 'todo', 'askUser', 'compaction'] as const
const dispatcherFields = [...tools.map(key => 'dispatcherTools.' + key), 'dispatcherPrompt.extraRules', 'dispatcherPrompt.overrideRules']
type Field = typeof mainFields[number] | typeof tools[number] | 'extraRules' | 'overrideRules'
type Edit = { path: string[]; value: Value | undefined; revision: number }
function at(value: unknown, path: string[]) {
  return path.reduce<unknown>((node, key) => node && typeof node === 'object' ? Reflect.get(node, key) : undefined, value)
}

function Section({ form, fields, backends, t, onSaved, blocked, lock, sessionId }: {
  sessionId?: string
  blocked: boolean; lock(value: boolean): void
  form: SettingsForm; fields: readonly string[]; backends: readonly string[]; t: PanelTranslate; onSaved: (path: string) => void
}) {
  const subscription = useMemo(() => ({ subscribe: (fn: () => void) => form.subscribe(fn), read: () => form.getSnapshot() }), [form])
  const snapshot = useSyncExternalStore(subscription.subscribe, subscription.read)
  const [confirm, setConfirm] = useState<Edit>()
  const [status, setStatus] = useState('')
  const [saving, setSaving] = useState(false)
  const [draft, setDraft] = useState<{ field: string; text: string; revision: number }>()
  async function save(edit: Edit) {
    setConfirm(undefined)
    lock(true)
    setSaving(true)
    setStatus(t('profileSaving'))
    try {
      const { path, value } = edit
      const ok = await form.mutate([value === undefined ? { op: 'unset', path } : { op: 'set', path, value }], edit.revision)
      setStatus(t(ok ? 'profileSaved' : 'profileRefused'))
      if (ok) onSaved(path.join('.'))
    } catch { setStatus(t('profileTransportError')) }
    finally { setSaving(false); setDraft(undefined); lock(false) }
  }
  function submit(field: string, value: Value | undefined, revision = snapshot.revision) {
    if (revision === undefined || saving || confirm) return
    const path = field.split('.')
    if (value === at(snapshot.value, path)) { setDraft(undefined); return }
    const roles = field === 'roles' ? value : snapshot.value?.roles
    const workflow = field === 'workflow' ? value : snapshot.value?.workflow
    const override = field === 'dispatcherPrompt.overrideRules' ? value : at(snapshot.value, ['dispatcherPrompt', 'overrideRules'])
    const rules = field === 'dispatcherPrompt.extraRules' ? value : at(snapshot.value, ['dispatcherPrompt', 'extraRules'])
    const invalid = workflow && roles === false ? WORKFLOW_REQUIRES_ROLES
      : override && !String(rules ?? '').trim() ? OVERRIDE_REQUIRES_RULES
      : value !== undefined && field.endsWith('TimeoutMs') && (!Number.isFinite(value) || Number(value) <= 0 || Number(value) > 2147483647 || (field === 'probeTimeoutMs' && !Number.isInteger(value)))
        ? t(field === 'probeTimeoutMs' ? 'profileInvalidDuration' : 'profileInvalidIdle') : undefined
    if (invalid) { setStatus(invalid); setDraft(undefined); return }
    const edit = { path, value, revision }
    if (acknowledged(sessionId)) void save(edit)
    else { lock(true); setConfirm(edit) }
  }
  if (snapshot.status !== 'ready') return <p>{t(snapshot.status === 'loading' ? 'loading' : 'profileUnavailable')}</p>
  return <section>
    <fieldset disabled={blocked || !snapshot.writable || saving || !!confirm}>
      <legend>{t(fields === mainFields ? 'profileMain' : 'profileDispatcher')}</legend>
      {fields.map(field => {
        const path = field.split('.')
        const key = path.at(-1) as Field
        const value = at(snapshot.value, path)
        const label = t(('pref_' + key) as PanelCopyKey)
        let input: ReactNode
        if (key === 'defaultBackend') {
          const names = new Set([...backends, ...(typeof value === 'string' ? [value] : [])])
          input = <select aria-label={label} value={String(value ?? '')} onChange={e => submit(field, e.target.value || undefined)}>
            <option value="">{t('profileAutomatic')}</option>
            {[...names].map(name => <option key={name} value={name}>{name}</option>)}
          </select>
        } else if (key === 'extraRules' || key.endsWith('TimeoutMs')) {
          const text = draft?.field === field ? draft.text : String(value ?? '')
          const props = { 'aria-label': label, value: text,
            onChange: (e: { target: { value: string } }) => setDraft({ field, text: e.target.value, revision: draft?.revision ?? snapshot.revision! }),
            onBlur: () => { if (draft?.field === field) submit(field, key === 'extraRules' ? text : text === '' ? undefined : Number(text), draft.revision) },
          }
          input = key === 'extraRules' ? <textarea {...props} rows={3} /> : <input {...props} type="number" min={key === 'probeTimeoutMs' ? 1 : 0} max={2147483647} step={key === 'probeTimeoutMs' ? 1 : 'any'} />
        } else input = <input aria-label={label} type="checkbox" checked={value === true} onChange={e => submit(field, e.target.checked)} />
        return <div key={field} style={{ marginBlock: 8 }}><label>{label} {input}</label>
          <div><code>{field}</code> · {t(('prefHelp_' + key) as PanelCopyKey)}</div></div>
      })}
    </fieldset>
    {confirm && <div role="alertdialog" aria-label={t('profileConfirmTitle')}>
      <p>{t('profileConfirm')}</p>
      <button type="button" onClick={() => { remember(sessionId); void save(confirm) }}>{t('profileConfirmSave')}</button>
      <button type="button" onClick={() => { setConfirm(undefined); setDraft(undefined); lock(false) }}>{t('cancel')}</button>
    </div>}
    {status && <p role="status">{status}</p>}
  </section>
}

export function ProfileSettings({ forms, backends, t, onSaved, sessionId }: { sessionId?: string; forms?: ProfileForms; backends: readonly string[]; t: PanelTranslate; onSaved: (path: string) => void }) {
  const [locked, setLocked] = useState(false)
  return forms ? <>
    <Section sessionId={sessionId} blocked={locked} lock={setLocked} form={forms.main} fields={mainFields} backends={backends} t={t} onSaved={onSaved} />
    <Section sessionId={sessionId} blocked={locked} lock={setLocked} form={forms.dispatcher} fields={dispatcherFields} backends={backends} t={t} onSaved={onSaved} />
  </> : <p>{t('profileUnavailable')}</p>
}
