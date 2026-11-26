/** Connection-local selectors. Fetch on expansion and after an edit. @module */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { panelActionError } from './chats-source.ts'
import type { ChatOptions, Selection } from '../chat-options.ts'
import type { ChatSettingsActions, PanelChat } from './face.ts'
import type { PanelTranslate } from './locales.ts'
import { DisclosureRow, IconSlidersTwoOutlineRegular } from './panel-chrome.tsx'

interface Props {
  chat: PanelChat
  actions: ChatSettingsActions
  t: PanelTranslate
}

const styles = {
  wrap: { marginTop: 2 },
  body: { display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 6 },
  field: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
  select: {
    flex: 1, minWidth: 0, maxWidth: 200, padding: '3px 6px', borderRadius: 6, fontSize: 12, font: 'inherit',
    background: 'var(--dsw-specific-selector)', color: 'var(--dsw-alias-label-primary)',
    border: '1px solid var(--dsw-alias-border-l3)',
  },
  hint: { margin: 0, fontSize: 11, lineHeight: 1.45, color: 'var(--dsw-alias-label-tertiary)' },
  notice: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
  error: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' },
} satisfies Record<string, CSSProperties>

function SettingsForm({ chat, actions, t }: Props) {
  const [data, setData] = useState<ChatOptions>()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const latest = useRef({ actions, t })
  latest.current = { actions, t }
  const readAt = useRef(chat.lastActive)
  const running = !!chat.inFlight || (data?.reason === 'running' && readAt.current === chat.lastActive)
  useEffect(() => {
    let mounted = true
    latest.current.actions.read(chat.chatId).then(value => { if (mounted) setData(value) },
      cause => { if (mounted) setError(panelActionError(cause, latest.current.t)) })
    return () => { mounted = false }
  }, [chat.chatId])

  async function change(field: 'model' | 'effort', value: string) {
    setSaving(true)
    setError('')
    try {
      await actions.change(chat.chatId, field, value)
      readAt.current = chat.lastActive
      setData(await actions.read(chat.chatId))
    } catch (cause) { setError(panelActionError(cause, t)) }
    finally { setSaving(false) }
  }
  function select(field: 'model' | 'effort', entry?: Selection) {
    const title = t(field === 'model' ? 'sessionModel' : 'sessionEffort')
    if (!entry?.options.length) return <p style={styles.hint}>{title} · {t('optionsUnreported')}</p>
    return (
      <label style={styles.field}>
        <span>{title}</span>
        <select style={styles.select} value={entry.current ?? ''} disabled={saving || running || data?.reason === 'changing'}
          onChange={event => { void change(field, event.target.value) }}>
          {!entry.options.some(o => o.value === entry.current) && <option value={entry.current ?? ''} disabled>{entry.current ?? t('optionsUnreported')}</option>}
          {entry.options.map(option => <option key={option.value} value={option.value}>{option.name}</option>)}
        </select>
      </label>
    )
  }
  return (
    <div style={styles.body} data-chat-settings-body="">
      {error && <p role="alert" style={styles.error}>{error}</p>}
      {!data ? !error && <p style={styles.notice}>{t('loading')}</p> : !data.supported ? <p style={styles.hint}>{t('switchUnsupported')}</p>
        : data.reason === 'released' || !chat.active ? <p style={styles.hint}>{t('switchReleased')}</p>
        : <>
          {select('model', data.model)}
          {data.effort === 'not-offered' ? <p style={styles.hint}>{t('sessionEffort')} · {t('effortNotOffered')}</p> : select('effort', data.effort)}
          {running && <p style={styles.hint}>{t('switchRunning')}</p>}
          <p style={styles.hint}>{t('switchLifetime')}</p>
        </>}
    </div>
  )
}

export function ChatSettings(props: Props) {
  const [expanded, setExpanded] = useState(false)
  const toggle = useCallback(() => { setExpanded(open => !open) }, [])
  return (
    <div style={styles.wrap} data-chat-settings="" onClick={event => event.stopPropagation()}>
      <DisclosureRow
        icon={<IconSlidersTwoOutlineRegular size={14} />}
        title={props.t('sessionSettings')}
        open={expanded}
        expandable
        expandOnRowClick
        onToggle={toggle}
      >
        <SettingsForm {...props} />
      </DisclosureRow>
    </div>
  )
}
