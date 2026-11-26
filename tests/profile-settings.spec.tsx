// @vitest-environment jsdom
import type { InputHTMLAttributes, ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children, variant: _variant, size: _size, icon, ...rest }: Record<string, unknown> & { children?: ReactNode; icon?: ReactNode }) =>
    <button type="button" {...rest}>{icon}{children}</button>,
  Input: ({ icon: _icon, ...rest }: InputHTMLAttributes<HTMLInputElement> & { icon?: ReactNode }) =>
    <span><input {...rest} /></span>,
  Modal: ({ open, title, description, footer, tone }: { open: boolean; title: string; description?: string; footer?: ReactNode; tone?: string }) =>
    open ? <div role="dialog" aria-modal="true" aria-label={title} data-tone={tone}><h2>{title}</h2>{description ? <p>{description}</p> : null}{footer}</div> : null,
  Switch: ({ checked, onChange, label, disabled, title }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean; title?: string }) =>
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} title={title} onClick={() => onChange(!checked)} />,
  DisclosureRow: () => null,
  IconRefreshOutlineRegular: () => null,
  IconSettingsOutlineRegular: () => null,
  IconWarningOutlineRegular: () => null,
  MarkdownText: () => null,
  Menu: () => null,
  Pill: () => null,
  StateDot: () => null,
  Tag: () => null,
  TextShimmer: () => null,
  extractMarkdownPlainText: (text: string) => text,
  useClipboardCopy: () => ({ copied: false, copy: () => {} }),
}))

import { ProfileSettings, type SettingsForm } from '../src/client/ProfileSettings.tsx'
import { zh, en, type PanelCopyKey } from '../src/client/locales.ts'
import { WORKFLOW_REQUIRES_ROLES } from '../src/settings-rules.ts'

afterEach(cleanup)

function form(initial: Record<string, unknown>) {
  const listeners = new Set<() => void>()
  let snapshot = { status: 'ready', value: initial, writable: true, revision: 7 }
  const accepted = (value: Record<string, unknown>) => {
    snapshot = { ...snapshot, value, revision: snapshot.revision + 1 }
    for (const listener of listeners) listener()
  }
  const mutate = vi.fn<SettingsForm['mutate']>(async ops => {
    const op = ops[0]!
    accepted({ ...snapshot.value, [op.path[0]!]: op.op === 'set' ? op.value : undefined })
    return true
  })
  return { mutate, accepted, getSnapshot: () => snapshot, subscribe(listener: () => void) {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  } }
}

function mount(copy: Record<PanelCopyKey, string>) {
  const main = form({ roles: true, workflow: false, idleTimeoutMs: 600000 })
  const dispatcher = form({ dispatcherTools: { web: true }, dispatcherPrompt: { extraRules: '', overrideRules: false } })
  const onSaved = vi.fn()
  render(<ProfileSettings forms={{ main, dispatcher }} backends={['default', 'agy']} t={key => copy[key]} onSaved={onSaved} />)
  return { main, dispatcher, onSaved }
}

it.each([zh, en])('renders the fifteen editable paths and four control types', copy => {
  mount(copy)
  expect(screen.getAllByRole('switch')).toHaveLength(11)
  expect(screen.getByRole('combobox', { name: copy.pref_defaultBackend })).toBeTruthy()
  expect(screen.getAllByRole('spinbutton')).toHaveLength(2)
  expect(screen.getByRole('textbox', { name: copy.pref_extraRules }).tagName).toBe('TEXTAREA')
  for (const key of ['command', 'env', 'permission', 'sandbox', 'registryPath', 'model', 'toolPrefix']) expect(screen.queryByText(key)).toBeNull()
  for (const el of document.querySelectorAll('code')) expect(el.parentElement?.textContent?.split(' · ')[1]?.length).toBeGreaterThan(0)
})

it('rejects conflicting roles and empty override rules before opening confirmation or writing', () => {
  const { main, dispatcher } = mount(zh)
  act(() => main.accepted({ roles: true, workflow: true }))
  fireEvent.click(screen.getByLabelText(zh.pref_roles))
  expect(screen.getByText(WORKFLOW_REQUIRES_ROLES)).toBeTruthy()
  fireEvent.click(screen.getByLabelText(zh.pref_overrideRules))
  expect(screen.getByText(/requires nonempty extraRules/)).toBeTruthy()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(main.mutate).not.toHaveBeenCalled()
  expect(dispatcher.mutate).not.toHaveBeenCalled()
})

it('confirms before the first write, preserves the revision, and shows the refreshed snapshot after refusal', async () => {
  const { main, onSaved } = mount(zh)
  const toggle = screen.getByLabelText(zh.pref_allowChatJobWait)
  fireEvent.click(toggle)
  const dialog = screen.getByRole('dialog', { name: zh.profileConfirmTitle })
  expect(dialog.getAttribute('data-tone')).toBe('warning')
  expect(screen.getByText(zh.profileConfirm)).toBeTruthy()
  expect(main.mutate).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText(zh.cancel))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(main.mutate).not.toHaveBeenCalled()
  const response = Promise.withResolvers<boolean>()
  main.mutate.mockImplementationOnce(() => response.promise)
  fireEvent.click(toggle)
  fireEvent.click(screen.getByRole('button', { name: zh.profileConfirmSave }))
  expect(screen.getByText(zh.profileSaving)).toBeTruthy()
  expect(main.mutate).toHaveBeenCalledWith([{ op: 'set', path: ['allowChatJobWait'], value: true }], 7)
  await act(async () => { main.accepted({ ...main.getSnapshot().value, allowChatJobWait: true }); response.resolve(true) })
  expect(screen.getByText(zh.profileSaved)).toBeTruthy()
  expect(localStorage.getItem('dsh-acp-resume/profile-write-confirmed')).toBe('true')
  const duration = screen.getByLabelText(zh.pref_idleTimeoutMs) as HTMLInputElement
  fireEvent.change(duration, { target: { value: '5000' } })
  main.mutate.mockImplementationOnce(async () => { main.accepted({ ...main.getSnapshot().value, idleTimeoutMs: 8000 }); return false })
  await act(async () => fireEvent.blur(duration))
  expect(main.mutate).toHaveBeenLastCalledWith([{ op: 'set', path: ['idleTimeoutMs'], value: 5000 }], 8)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByText(zh.profileRefused)).toBeTruthy()
  expect(duration.value).toBe('8000')
  expect(onSaved).toHaveBeenCalledTimes(1)
})
