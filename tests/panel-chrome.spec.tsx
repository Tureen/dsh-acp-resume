// @vitest-environment jsdom
/**
 * Unit tests for shared sidebar visual primitives (`src/client/panel-chrome.tsx`):
 * four-state 3px left status rail, unified card surface variables, Markdown
 * plain-text preview cleaning & truncation, and reference-stable `useMarkdownLabels`.
 * @module dsh-acp-resume/tests/panel-chrome.spec
 */

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { en, zh, type PanelCopyKey, type PanelTranslate } from '../src/client/locales.ts'

// `@deepseek-ai/dsh-client-ui-primitives` is a shell-shared module whose transitive
// runtime deps are provided by the host bundle rather than installed here. Provide
// a faithful GFM-to-plain-text stand-in matching `extractMarkdownPlainText`'s contract
// (strips fences, headings, emphasis, links, and table delimiters; preserves text).
const extractMock = vi.fn((markdown: string, options?: { mode?: 'all' | 'first-line' | 'first-paragraph' }): string => {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let inFence = false
  for (const raw of lines) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence
      continue
    }
    if (inFence) {
      out.push(raw.trim())
      continue
    }
    if (/^\s*\|?[\s:-]+(?:\|[\s:-]+)+\|?\s*$/.test(raw)) continue
    if (/^\s*\|.*\|\s*$/.test(raw)) {
      const cells = raw.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
      out.push(cells.join('\t'))
      continue
    }
    const stripped = raw
      .replace(/^\s*#{1,6}\s+/, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .trim()
    out.push(stripped)
  }
  const all = out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  if (options?.mode === 'first-line') return all.split('\n').find(l => l !== '') ?? ''
  if (options?.mode === 'first-paragraph') return all.split('\n\n').find(p => p.trim() !== '')?.replace(/\n+/g, ' ').trim() ?? ''
  return all
})

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: () => null,
  DisclosureRow: () => null,
  IconArchiveOutlineRegular: () => null,
  IconChevronDownOutlineRegular: () => null,
  IconChevronUpOutlineRegular: () => null,
  IconEllipsisOutlineRegular: () => null,
  IconRefreshOutlineRegular: () => null,
  IconSettingsOutlineRegular: () => null,
  IconSlidersTwoOutlineRegular: () => null,
  IconWarningOutlineRegular: () => null,
  Input: () => null,
  MarkdownText: () => null,
  Menu: () => null,
  Modal: () => null,
  Pill: () => null,
  StateDot: () => null,
  Switch: () => null,
  Tag: () => null,
  TextShimmer: () => null,
  extractMarkdownPlainText: (markdown: string, options?: { mode?: 'all' | 'first-line' | 'first-paragraph' }) =>
    extractMock(markdown, options),
  useClipboardCopy: () => ({ copied: false, copy: () => {} }),
}))

import {
  CARD_BORDER,
  CARD_RADIUS,
  CARD_SURFACE,
  PanelCard,
  RAIL_COLORS,
  StatusRail,
  cleanPreview,
  useMarkdownLabels,
  type MarkdownLabels,
  type RailState,
} from '../src/client/panel-chrome.tsx'

afterEach(() => {
  cleanup()
  extractMock.mockClear()
})

const translator = (dict: Record<PanelCopyKey, string>): PanelTranslate => (key, params) =>
  dict[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? `{${name}}`))

describe('panel-chrome', () => {
  it.each<[RailState, string]>([
    ['running', '3px solid var(--dsw-alias-state-business-primary)'],
    ['error', '3px solid var(--dsw-alias-state-error-primary)'],
    ['warn', '3px solid var(--dsw-alias-state-warn-primary)'],
    ['none', ''],
  ])('renders StatusRail with data-state="%s" and expected CSS variable', (state, expectedBorderLeft) => {
    const { container } = render(<StatusRail state={state}>body</StatusRail>)
    const el = container.firstElementChild as HTMLElement
    expect(el.getAttribute('data-state')).toBe(state)
    expect(el.style.borderLeft).toBe(expectedBorderLeft)
    if (state !== 'none') {
      expect(expectedBorderLeft).toContain(RAIL_COLORS[state])
    }
  })

  it('renders PanelCard with 10px radius, border-l2, card-fill, and four-state left rail', () => {
    const { container, rerender } = render(<PanelCard>plain</PanelCard>)
    const card = container.firstElementChild as HTMLElement
    expect(card.getAttribute('data-state')).toBe('none')
    expect(card.style.borderRadius).toBe(`${CARD_RADIUS}px`)
    expect(card.style.background).toBe(CARD_SURFACE)
    expect(card.style.borderTop).toBe(CARD_BORDER)
    expect(card.style.borderLeft).toBe(CARD_BORDER)

    rerender(<PanelCard rail="running">live</PanelCard>)
    expect(card.getAttribute('data-state')).toBe('running')
    expect(card.style.borderLeft).toBe('3px solid var(--dsw-alias-state-business-primary)')

    rerender(<PanelCard rail="error">err</PanelCard>)
    expect(card.getAttribute('data-state')).toBe('error')
    expect(card.style.borderLeft).toBe('3px solid var(--dsw-alias-state-error-primary)')

    rerender(<PanelCard rail="warn">warn</PanelCard>)
    expect(card.getAttribute('data-state')).toBe('warn')
    expect(card.style.borderLeft).toBe('3px solid var(--dsw-alias-state-warn-primary)')
  })

  it('strips Markdown syntax via extractMarkdownPlainText for plain text, code blocks, tables, and long text', () => {
    expect(cleanPreview('Plain summary text')).toBe('Plain summary text')

    const withCode = '## Result\n\n```ts\nconst answer = 42\n```\n\nDone with **bold** and `inline`.'
    const codePreview = cleanPreview(withCode)
    expect(codePreview).toBe('Result\nconst answer = 42\nDone with bold and inline.')
    expect(codePreview).not.toMatch(/```|##|\*\*|`/)

    const withTable = '| File | Status |\n| --- | --- |\n| panel-time.ts | pass |'
    const tablePreview = cleanPreview(withTable)
    expect(tablePreview).toBe('File Status\npanel-time.ts pass')
    expect(tablePreview).not.toMatch(/\||\t|---/)

    const longText = '一二三四五六七八九十'.repeat(30)
    const truncated = cleanPreview(longText, { maxChars: 20 })
    expect(Array.from(truncated)).toHaveLength(21)
    expect(truncated.endsWith('…')).toBe(true)

    expect(extractMock).toHaveBeenCalled()
  })

  it('keeps useMarkdownLabels reference-stable across re-renders even with fresh t closures, and updates on locale switch', () => {
    const seen: MarkdownLabels[] = []
    function Probe({ dict }: { readonly dict: Record<PanelCopyKey, string> }) {
      const labels = useMarkdownLabels(translator(dict))
      seen.push(labels)
      return <span>{labels.footnotes}</span>
    }

    const { rerender } = render(<Probe dict={zh} />)
    rerender(<Probe dict={zh} />)
    expect(seen).toHaveLength(2)
    expect(seen[0]).toBe(seen[1])
    expect(seen[0]?.code.copyLabel).toBe(zh.copyText)
    expect(seen[0]?.code.toolbarLabels?.codeLabel).toBe(zh.mdCodeFallback)

    rerender(<Probe dict={en} />)
    expect(seen).toHaveLength(3)
    expect(seen[2]).not.toBe(seen[1])
    expect(seen[2]?.code.copyLabel).toBe(en.copyText)
    expect(seen[2]?.footnotes).toBe(en.mdFootnotes)
  })
})
