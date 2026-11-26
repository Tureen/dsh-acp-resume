/** Connection-local selectors. Fetch on expansion and after an edit. @module */
import { useEffect, useRef, useState } from 'react'
import { panelActionError } from './chats-source.ts'
import type { ChatOptions, Selection } from '../chat-options.ts'
import type { ChatSettingsActions, PanelChat } from './face.ts'
import type { PanelTranslate } from './locales.ts'

interface Props {
  chat: PanelChat
  actions: ChatSettingsActions
  t: PanelTranslate
}

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
    if (!entry?.options.length) return <p>{title} · {t('optionsUnreported')}</p>
    return <label>{title}{' '}
      <select value={entry.current ?? ''} disabled={saving || running || data?.reason === 'changing'}
        onChange={event => { void change(field, event.target.value) }}>
        {!entry.options.some(o => o.value === entry.current) && <option value={entry.current ?? ''} disabled>{entry.current ?? t('optionsUnreported')}</option>}
        {entry.options.map(option => <option key={option.value} value={option.value}>{option.name}</option>)}
      </select>
    </label>
  }
  return <>
    {error && <p role="alert">{error}</p>}
    {!data ? !error && <p>{t('loading')}</p> : !data.supported ? <p>{t('switchUnsupported')}</p>
      : data.reason === 'released' || !chat.active ? <p>{t('switchReleased')}</p>
      : <div>
        {select('model', data.model)}{' '}
        {data.effort === 'not-offered' ? <p>{t('sessionEffort')} · {t('effortNotOffered')}</p> : select('effort', data.effort)}
        {running && <p>{t('switchRunning')}</p>}
        <p>{t('switchLifetime')}</p>
      </div>}
  </>
}

export function ChatSettings(props: Props) {
  const [expanded, setExpanded] = useState(false)
  return <div onClick={event => event.stopPropagation()}>
    <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      {props.t('sessionSettings')} {expanded ? '▴' : '▾'}
    </button>
    {expanded && <SettingsForm {...props} />}
  </div>
}
