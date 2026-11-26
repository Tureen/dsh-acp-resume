/** Edit the two live plugin entries using the official revision-fenced ConfigForm. @module */
import { useMemo, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { OVERRIDE_REQUIRES_RULES, WORKFLOW_REQUIRES_ROLES } from '../settings-rules.ts'
import type { PanelCopyKey, PanelTranslate } from './locales.ts'
import { Button, Input, Modal, PanelCard, SectionHeading, Switch } from './panel-chrome.tsx'

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

const styles = {
  drawer: { display: 'flex', flexDirection: 'column', gap: 12, padding: 12 },
  section: { display: 'flex', flexDirection: 'column', gap: 8 },
  sectionDivider: { paddingTop: 12, borderTop: '1px solid var(--dsw-alias-border-l2)' },
  fieldStack: { display: 'flex', flexDirection: 'column', gap: 4 },
  switchRow: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 },
  switchText: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 },
  label: { fontSize: 12, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' },
  help: { fontSize: 11, lineHeight: 1.45, color: 'var(--dsw-alias-label-tertiary)', overflowWrap: 'anywhere' },
  code: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },
  select: {
    width: '100%', boxSizing: 'border-box', padding: '5px 8px', borderRadius: 6, fontSize: 12, font: 'inherit',
    background: 'var(--dsw-specific-input-major)', color: 'var(--dsw-alias-label-primary)',
    border: '1px solid var(--dsw-alias-border-l3)',
  },
  textarea: {
    width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: 6, fontSize: 12, font: 'inherit',
    lineHeight: 1.5, resize: 'vertical',
    background: 'var(--dsw-specific-input-major)', color: 'var(--dsw-alias-label-primary)',
    border: '1px solid var(--dsw-alias-border-l3)',
  },
  numberInput: { width: '100%', boxSizing: 'border-box', fontSize: 12 },
  status: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
  error: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' },
} satisfies Record<string, CSSProperties>

function Section({ form, fields, backends, t, onSaved, blocked, lock, sessionId, divided = false }: {
  sessionId?: string
  blocked: boolean; lock(value: boolean): void
  form: SettingsForm; fields: readonly string[]; backends: readonly string[]; t: PanelTranslate; onSaved: (path: string) => void
  divided?: boolean
}) {
  const subscription = useMemo(() => ({ subscribe: (fn: () => void) => form.subscribe(fn), read: () => form.getSnapshot() }), [form])
  const snapshot = useSyncExternalStore(subscription.subscribe, subscription.read)
  const [confirm, setConfirm] = useState<Edit>()
  const [status, setStatus] = useState('')
  const [statusError, setStatusError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [draft, setDraft] = useState<{ field: string; text: string; revision: number }>()
  async function save(edit: Edit) {
    setConfirm(undefined)
    lock(true)
    setSaving(true)
    setStatusError(false)
    setStatus(t('profileSaving'))
    try {
      const { path, value } = edit
      const ok = await form.mutate([value === undefined ? { op: 'unset', path } : { op: 'set', path, value }], edit.revision)
      setStatusError(!ok)
      setStatus(t(ok ? 'profileSaved' : 'profileRefused'))
      if (ok) onSaved(path.join('.'))
    } catch {
      setStatusError(true)
      setStatus(t('profileTransportError'))
    }
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
    if (invalid) { setStatusError(true); setStatus(invalid); setDraft(undefined); return }
    const edit = { path, value, revision }
    if (acknowledged(sessionId)) void save(edit)
    else { lock(true); setConfirm(edit) }
  }
  const heading = t(fields === mainFields ? 'profileMain' : 'profileDispatcher')
  const sectionStyle = divided ? { ...styles.section, ...styles.sectionDivider } : styles.section
  if (snapshot.status !== 'ready') {
    return (
      <section style={sectionStyle} aria-label={heading}>
        <SectionHeading title={heading} />
        <p style={styles.status}>{t(snapshot.status === 'loading' ? 'loading' : 'profileUnavailable')}</p>
      </section>
    )
  }
  const disabled = blocked || !snapshot.writable || saving || !!confirm
  const dismissConfirm = () => { setConfirm(undefined); setDraft(undefined); lock(false) }
  return (
    <section style={sectionStyle} aria-label={heading}>
      <SectionHeading title={heading} />
      {fields.map(field => {
        const path = field.split('.')
        const key = path.at(-1) as Field
        const value = at(snapshot.value, path)
        const label = t(('pref_' + key) as PanelCopyKey)
        const help = <div style={styles.help}><code style={styles.code}>{field}</code> · {t(('prefHelp_' + key) as PanelCopyKey)}</div>
        if (key === 'defaultBackend') {
          const names = new Set([...backends, ...(typeof value === 'string' ? [value] : [])])
          return (
            <div key={field} style={styles.fieldStack}>
              <span style={styles.label}>{label}</span>
              <select aria-label={label} disabled={disabled} style={styles.select} value={String(value ?? '')}
                onChange={e => submit(field, e.target.value || undefined)}>
                <option value="">{t('profileAutomatic')}</option>
                {[...names].map(name => <option key={name} value={name}>{name}</option>)}
              </select>
              {help}
            </div>
          )
        }
        if (key === 'extraRules' || key.endsWith('TimeoutMs')) {
          const text = draft?.field === field ? draft.text : String(value ?? '')
          const common = {
            'aria-label': label,
            disabled,
            value: text,
            onChange: (e: { target: { value: string } }) => setDraft({ field, text: e.target.value, revision: draft?.revision ?? snapshot.revision! }),
            onBlur: () => { if (draft?.field === field) submit(field, key === 'extraRules' ? text : text === '' ? undefined : Number(text), draft.revision) },
          }
          return (
            <div key={field} style={styles.fieldStack}>
              <span style={styles.label}>{label}</span>
              {key === 'extraRules'
                ? <textarea {...common} rows={3} style={styles.textarea} />
                : <Input {...common} type="number" min={key === 'probeTimeoutMs' ? 1 : 0} max={2147483647} step={key === 'probeTimeoutMs' ? 1 : 'any'} style={styles.numberInput} />}
              {help}
            </div>
          )
        }
        return (
          <div key={field} style={styles.switchRow}>
            <div style={styles.switchText}>
              <span style={styles.label}>{label}</span>
              {help}
            </div>
            <Switch checked={value === true} disabled={disabled} label={label} onChange={next => submit(field, next)} />
          </div>
        )
      })}
      <Modal
        open={confirm !== undefined}
        tone="warning"
        title={t('profileConfirmTitle')}
        description={t('profileConfirm')}
        closeLabel={t('dismiss')}
        onClose={dismissConfirm}
        footer={(
          <>
            <Button size="sm" variant="outline" data-modal-autofocus onClick={dismissConfirm}>{t('cancel')}</Button>
            <Button size="sm" variant="primary" onClick={() => {
              if (confirm !== undefined) { remember(sessionId); void save(confirm) }
            }}>{t('profileConfirmSave')}</Button>
          </>
        )}
      />
      {status && <p role="status" style={statusError ? styles.error : styles.status}>{status}</p>}
    </section>
  )
}

export function ProfileSettings({ forms, backends, t, onSaved, sessionId }: { sessionId?: string; forms?: ProfileForms; backends: readonly string[]; t: PanelTranslate; onSaved: (path: string) => void }) {
  const [locked, setLocked] = useState(false)
  return (
    <PanelCard style={styles.drawer} data-profile-settings="">
      {forms ? <>
        <Section sessionId={sessionId} blocked={locked} lock={setLocked} form={forms.main} fields={mainFields} backends={backends} t={t} onSaved={onSaved} />
        <Section sessionId={sessionId} blocked={locked} lock={setLocked} form={forms.dispatcher} fields={dispatcherFields} backends={backends} t={t} onSaved={onSaved} divided />
      </> : <p style={styles.status}>{t('profileUnavailable')}</p>}
    </PanelCard>
  )
}
