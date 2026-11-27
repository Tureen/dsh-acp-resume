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
  IconArchiveOutlineRegular: () => null,
  IconChevronDownOutlineRegular: () => null,
  IconChevronUpOutlineRegular: () => null,
  IconEllipsisOutlineRegular: () => null,
  IconRefreshOutlineRegular: () => null,
  IconSettingsOutlineRegular: () => null,
  IconSlidersTwoOutlineRegular: () => null,
  IconWarningOutlineRegular: () => null,
  MarkdownText: () => null,
  Menu: () => null,
  Pill: () => null,
  StateDot: () => null,
  Tag: ({ children }: { children?: ReactNode }) => <span data-tag="">{children}</span>,
  TextShimmer: () => null,
  extractMarkdownPlainText: (text: string) => text,
  useClipboardCopy: () => ({ copied: false, onCopy: () => {} }),
}))

import { ProfileSettings, type ProfileBackendInfo, type SettingsForm } from '../src/client/ProfileSettings.tsx'
import { zh, en, type PanelCopyKey, type PanelTranslate } from '../src/client/locales.ts'
import { WORKFLOW_REQUIRES_ROLES } from '../src/settings-rules.ts'
import { within } from '@testing-library/react'

afterEach(() => { cleanup(); localStorage.clear() })

function translator(copy: Record<PanelCopyKey, string>): PanelTranslate {
  return (key, params) => {
    let text = copy[key]
    if (params) for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value))
    return text
  }
}

function setNested(obj: Record<string, unknown>, path: string[], value: unknown): Record<string, unknown> {
  if (path.length === 1) {
    const next = { ...obj }
    if (value === undefined) delete next[path[0]!]
    else next[path[0]!] = value
    return next
  }
  const [head, ...rest] = path as [string, ...string[]]
  const child = obj[head]
  const base = child && typeof child === 'object' ? child as Record<string, unknown> : {}
  return { ...obj, [head]: setNested(base, rest, value) }
}

function form(initial: Record<string, unknown>) {
  const listeners = new Set<() => void>()
  let snapshot = { status: 'ready', value: initial, writable: true, revision: 7 }
  const accepted = (value: Record<string, unknown>) => {
    snapshot = { ...snapshot, value, revision: snapshot.revision + 1 }
    for (const listener of listeners) listener()
  }
  const mutate = vi.fn<SettingsForm['mutate']>(async ops => {
    let next = snapshot.value
    for (const op of ops) next = setNested(next, op.path, op.op === 'set' ? op.value : undefined)
    accepted(next)
    return true
  })
  return { mutate, accepted, getSnapshot: () => snapshot, subscribe(listener: () => void) {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  } }
}

function mount(
  copy: Record<PanelCopyKey, string>,
  backends: readonly (string | ProfileBackendInfo)[] = ['default', 'agy'],
  initialMain: Record<string, unknown> = { roles: true, workflow: false, idleTimeoutMs: 600000, backendDefaults: {} },
) {
  const main = form(initialMain)
  const dispatcher = form({ dispatcherTools: { web: true }, dispatcherPrompt: { extraRules: '', overrideRules: false } })
  const onSaved = vi.fn()
  render(<ProfileSettings forms={{ main, dispatcher }} backends={backends} t={translator(copy)} onSaved={onSaved} />)
  return { main, dispatcher, onSaved }
}

it.each([zh, en])('renders the editable paths, control types, and per-backend default controls', copy => {
  mount(copy, [
    { id: 'default', label: 'kiro-cli', effortKind: 'kiro', staticModel: 'claude-opus-5.5', staticEffort: 'high' },
    { id: 'agy', label: 'Antigravity CLI (agy)', automatic: true, effortKind: 'agy' },
    { id: 'codex', label: 'Codex', automatic: true, effortKind: 'codex' },
  ])
  expect(screen.getAllByRole('switch')).toHaveLength(11)
  expect(screen.getByRole('combobox', { name: copy.pref_defaultBackend })).toBeTruthy()
  expect(screen.getAllByRole('spinbutton')).toHaveLength(2)
  expect(screen.getByRole('textbox', { name: copy.pref_extraRules }).tagName).toBe('TEXTAREA')
  // Per-backend effort controls: Kiro has 5 levels (with max), agy has 4 levels (no max), Codex uses textbox.
  const kiroEffort = screen.getByRole('combobox', { name: translator(copy)('profileBackendEffortLabel', { backend: 'default' }) })
  expect(within(kiroEffort).getAllByRole('option').map(o => (o as HTMLOptionElement).value)).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max'])
  const agyEffort = screen.getByRole('combobox', { name: translator(copy)('profileBackendEffortLabel', { backend: 'agy' }) })
  expect(within(agyEffort).getAllByRole('option').map(o => (o as HTMLOptionElement).value)).toEqual(['', 'low', 'medium', 'high', 'xhigh'])
  expect(screen.getByRole('textbox', { name: translator(copy)('profileBackendEffortLabel', { backend: 'codex' }) })).toBeTruthy()
  // Auto-discovered tag and fallback copy are shown.
  expect(screen.getAllByText(copy.backendAutomatic)).toHaveLength(2)
  expect(screen.getByText(copy.profileBackendClearFallback)).toBeTruthy()
  expect(screen.getAllByText(copy.profileBackendAutoHint)).toHaveLength(2)
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

it('edits backendDefaults model/effort via mutate, clears back to static fallback, and blocks invalid effort before writing (D48)', async () => {
  localStorage.setItem('dsh-acp-resume/profile-write-confirmed', 'true')
  const { main } = mount(zh, [
    { id: 'default', label: 'kiro-cli', effortKind: 'kiro', staticModel: 'static-m' },
    { id: 'agy', label: 'Antigravity CLI (agy)', automatic: true, effortKind: 'agy' },
  ], { roles: true, workflow: false, idleTimeoutMs: 600000, backendDefaults: { agy: { effort: 'high' } } })

  // Edit default model -> set backendDefaults.default.model
  const modelInput = screen.getByRole('textbox', { name: 'default 缺省模型' }) as HTMLInputElement
  fireEvent.change(modelInput, { target: { value: 'claude-opus-5.5' } })
  await act(async () => fireEvent.blur(modelInput))
  expect(main.mutate).toHaveBeenCalledWith([{ op: 'set', path: ['backendDefaults', 'default', 'model'], value: 'claude-opus-5.5' }], 7)
  expect(screen.getByText(zh.profileSaved)).toBeTruthy()

  // Edit default effort -> set backendDefaults.default.effort
  const kiroEffort = screen.getByRole('combobox', { name: 'default 缺省思考强度' })
  await act(async () => fireEvent.change(kiroEffort, { target: { value: 'max' } }))
  expect(main.mutate).toHaveBeenLastCalledWith([{ op: 'set', path: ['backendDefaults', 'default', 'effort'], value: 'max' }], 8)

  // Clear default -> unset backendDefaults.default and show fallback status
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '清除 default 缺省覆盖' })))
  expect(main.mutate).toHaveBeenLastCalledWith([{ op: 'unset', path: ['backendDefaults', 'default'] }], 9)
  expect(screen.getByText(zh.profileBackendCleared)).toBeTruthy()

  // Invalid effort on agy (e.g. max) is rejected before calling mutate
  const callsBefore = main.mutate.mock.calls.length
  const agyEffort = screen.getByRole('combobox', { name: 'agy 缺省思考强度' }) as HTMLSelectElement
  const bogus = document.createElement('option')
  bogus.value = 'max'
  bogus.text = 'max'
  agyEffort.appendChild(bogus)
  fireEvent.change(agyEffort, { target: { value: 'max' } })
  expect(screen.getByRole('status').textContent).toContain('is not a valid effort level for agy')
  expect(main.mutate).toHaveBeenCalledTimes(callsBefore)
})
