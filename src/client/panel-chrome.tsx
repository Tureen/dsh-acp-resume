/**
 * Shared visual primitives for the right sidebar (D47): re-exports official
 * `@deepseek-ai/dsh-client-ui-primitives` controls and adds only what the
 * shell does not ship — the four-state 3px left status rail (D30 baseline),
 * the unified 10px card surface (`border-l2` + `--dsw-alias-card-fill`),
 * section heading, reference-stable {@link useMarkdownLabels}, and plain-text
 * Markdown preview stripping via {@link extractMarkdownPlainText}.
 * @module dsh-acp-resume/client/panel-chrome
 */

import { useEffect, useMemo, useState, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react'
import {
  extractMarkdownPlainText,
  type MarkdownLabels,
  type MarkdownPlainTextMode,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PanelTranslate } from './locales.ts'
import { formatPanelDuration } from './panel-time.ts'

export {
  Button,
  DisclosureRow,
  IconArchiveOutlineRegular,
  IconChevronDownOutlineRegular,
  IconChevronUpOutlineRegular,
  IconEllipsisOutlineRegular,
  IconRefreshOutlineRegular,
  IconSettingsOutlineRegular,
  IconSlidersTwoOutlineRegular,
  IconWarningOutlineRegular,
  Input,
  MarkdownText,
  Menu,
  Modal,
  Pill,
  StateDot,
  Switch,
  Tag,
  TextShimmer,
  extractMarkdownPlainText,
  useClipboardCopy,
  type ButtonVariant,
  type DisclosureRowProps,
  type MarkdownLabels,
  type MarkdownPlainTextMode,
  type MenuEntry,
  type StateDotState,
  type TagTone,
} from '@deepseek-ai/dsh-client-ui-primitives'

/** Four-state left 3px rail semantics across the sidebar (D30 / D47). */
export type RailState = 'running' | 'error' | 'warn' | 'none'

/** CSS custom properties for the three visible rail states (`none` renders no rail). */
export const RAIL_COLORS: Readonly<Record<Exclude<RailState, 'none'>, string>> = {
  running: 'var(--dsw-alias-state-business-primary)',
  error: 'var(--dsw-alias-state-error-primary)',
  warn: 'var(--dsw-alias-state-warn-primary)',
}

/** Shared card surface border token (`border-l2` gives contrast in both light and dark themes). */
export const CARD_BORDER = '1px solid var(--dsw-alias-border-l2)'
/** Shared card fill token. */
export const CARD_SURFACE = 'var(--dsw-alias-card-fill)'
/** Shared card corner radius in pixels. */
export const CARD_RADIUS = 10

/**
 * Inline border style for a 3px left status rail.
 * @param state - rail state; `'none'` returns an empty style object.
 */
export function railStyle(state: RailState): CSSProperties {
  if (state === 'none') return {}
  return { borderLeft: `3px solid ${RAIL_COLORS[state]}` }
}

/** Props for {@link StatusRail}. */
export interface StatusRailProps extends HTMLAttributes<HTMLDivElement> {
  readonly state?: RailState
  readonly children?: ReactNode
}

/**
 * Lightweight 3px left status rail wrapper tagging `data-state` with the rail state.
 * @param props.state - `'running'` (blue), `'error'` (red), `'warn'` (orange), or `'none'` (no rail).
 */
export function StatusRail({ state = 'none', style, children, ...rest }: StatusRailProps): ReactNode {
  return (
    <div {...rest} data-rail="" data-state={state} style={{ ...railStyle(state), ...style }}>
      {children}
    </div>
  )
}

/** Props for {@link PanelCard}. */
export interface PanelCardProps extends HTMLAttributes<HTMLDivElement> {
  /** Optional 3px left status rail; defaults to `'none'`. */
  readonly rail?: RailState
  readonly children?: ReactNode
}

/**
 * Unified sidebar card shell: 10px radius, `1px solid var(--dsw-alias-border-l2)`
 * stroke, `--dsw-alias-card-fill` fill, and an optional 3px left status rail.
 * Uses explicit edge borders so toggling the left rail never conflicts with shorthand `border`.
 */
export function PanelCard({ rail = 'none', style, children, ...rest }: PanelCardProps): ReactNode {
  return (
    <div
      {...rest}
      data-panel-card=""
      data-state={rail}
      style={{
        borderRadius: CARD_RADIUS,
        borderTop: CARD_BORDER,
        borderRight: CARD_BORDER,
        borderBottom: CARD_BORDER,
        borderLeft: rail === 'none' ? CARD_BORDER : `3px solid ${RAIL_COLORS[rail]}`,
        background: CARD_SURFACE,
        ...style,
      }}
    >
      {children}
    </div>
  )
}

const sectionHeadingStyles = {
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  title: { margin: 0, fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' },
  aside: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', flex: 'none' },
} satisfies Record<string, CSSProperties>

/** Unified 12px/600 sidebar section heading with optional right-aligned summary/count. */
export function SectionHeading({ title, aside }: { readonly title: string; readonly aside?: ReactNode }): ReactNode {
  return (
    <div style={sectionHeadingStyles.row}>
      <h3 style={sectionHeadingStyles.title}>{title}</h3>
      {aside === undefined ? null : <span style={sectionHeadingStyles.aside}>{aside}</span>}
    </div>
  )
}

/**
 * Reference-stable {@link MarkdownLabels} memoized on resolved localized strings,
 * so `MarkdownText` keeps its streaming block cache even if the caller's `t`
 * closure changes identity across renders.
 * @param t - panel copy translator.
 */
export function useMarkdownLabels(t: PanelTranslate): MarkdownLabels {
  const copyLabel = t('copyText')
  const copiedLabel = t('copiedText')
  const codeLabel = t('mdCodeFallback')
  const wrapLabel = t('mdCodeWrap')
  const unwrapLabel = t('mdCodeUnwrap')
  const footnotes = t('mdFootnotes')
  return useMemo<MarkdownLabels>(() => ({
    code: {
      copyLabel,
      copiedLabel,
      toolbarLabels: { codeLabel, wrapLabel, unwrapLabel },
    },
    footnotes,
  }), [copyLabel, copiedLabel, codeLabel, wrapLabel, unwrapLabel, footnotes])
}

/** Options for {@link cleanPreview} and {@link cleanPreviewResult}. */
export interface CleanPreviewOptions {
  /** Extraction boundary passed to `extractMarkdownPlainText`; defaults to `'all'`. */
  readonly mode?: MarkdownPlainTextMode
  /** Maximum visible non-empty lines; omitted keeps all extracted lines. */
  readonly maxLines?: number
  /** Maximum code points in the returned preview; defaults to 200. */
  readonly maxChars?: number
}

/** Default preview character limit (in Unicode code points). */
export const DEFAULT_PREVIEW_CHARS = 200

/**
 * Strip Markdown syntax via official {@link extractMarkdownPlainText}, normalize
 * table tabs and blank lines, and clamp to `maxLines` / `maxChars` code points.
 * @param markdown - raw Markdown or plain text.
 * @param options - extraction boundary and truncation limits.
 * @returns normalized plain-text preview and whether truncation occurred.
 */
export function cleanPreviewResult(markdown: string, options: CleanPreviewOptions = {}): { readonly text: string; readonly clipped: boolean } {
  if (markdown.trim() === '') return { text: '', clipped: false }
  const mode = options.mode ?? 'all'
  const maxChars = options.maxChars ?? DEFAULT_PREVIEW_CHARS
  const extracted = extractMarkdownPlainText(markdown, { mode })
  const lines = extracted
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .filter(line => line !== '')
  if (lines.length === 0) return { text: '', clipped: false }
  let clipped = false
  const limitedLines = options.maxLines !== undefined && lines.length > options.maxLines
    ? (clipped = true, lines.slice(0, options.maxLines))
    : lines
  const joined = limitedLines.join('\n')
  const chars = Array.from(joined)
  if (maxChars > 0 && chars.length > maxChars) {
    const cut = chars.slice(0, maxChars).join('').trimEnd()
    return { text: `${cut}…`, clipped: true }
  }
  return { text: clipped ? `${joined}…` : joined, clipped }
}

/**
 * Plain-text preview string stripped of Markdown syntax and truncated safely by code point.
 * @param markdown - raw Markdown or plain text.
 * @param options - extraction boundary and truncation limits.
 */
export function cleanPreview(markdown: string, options: CleanPreviewOptions = {}): string {
  return cleanPreviewResult(markdown, options).text
}

/** Scoped class name for compact `MarkdownText variant="body"` rendering inside narrow sidebars. */
export const MARKDOWN_COMPACT_CLASS = 'acp-detail-md'

const MARKDOWN_COMPACT_CSS = `
.${MARKDOWN_COMPACT_CLASS} { font-size: 13px; line-height: 1.55; }
.${MARKDOWN_COMPACT_CLASS} > :first-child { margin-top: 0; }
.${MARKDOWN_COMPACT_CLASS} > :last-child { margin-bottom: 0; }
.${MARKDOWN_COMPACT_CLASS} h1, .${MARKDOWN_COMPACT_CLASS} h2, .${MARKDOWN_COMPACT_CLASS} h3 { font-size: 14px; margin: 0.7em 0 0.35em; }
.${MARKDOWN_COMPACT_CLASS} p, .${MARKDOWN_COMPACT_CLASS} ul, .${MARKDOWN_COMPACT_CLASS} ol { margin: 0.45em 0; }
.${MARKDOWN_COMPACT_CLASS} .md-code-block > :has(> [data-code-block-banner]) { position: static; z-index: auto; }
[data-detail-offscreen] *, [data-detail-offscreen] *::before, [data-detail-offscreen] *::after { animation-play-state: paused !important; }
`

/** Injects scoped typography rules for `.acp-detail-md`. */
export function MarkdownCompactStyle(): ReactNode {
  return <style>{MARKDOWN_COMPACT_CSS}</style>
}

const liveElapsedStyle: CSSProperties = {
  flex: 'none',
  fontSize: 12,
  color: 'var(--dsw-alias-label-tertiary)',
  fontVariantNumeric: 'tabular-nums',
}

/**
 * A running turn's elapsed time, ticking once a second while mounted. Mounted
 * only for an in-flight turn or workflow, so no clock runs while idle (D21).
 */
export function LiveElapsed({ startedAt, now, t, label = 'runningFor' }: {
  readonly startedAt: number
  readonly now: number
  readonly t: PanelTranslate
  /** Copy key taking `{duration}`; `runningFor` (`已运行 …`) by default. */
  readonly label?: 'runningFor' | 'inFlightFor'
}): ReactNode {
  const [drift, setDrift] = useState(0)
  useEffect(() => {
    const base = Date.now()
    setDrift(0)
    const timer = setInterval(() => { setDrift(Date.now() - base) }, 1000)
    return () => { clearInterval(timer) }
  }, [now, startedAt])
  return <span style={liveElapsedStyle} data-elapsed>{t(label, { duration: formatPanelDuration(t, now + drift - startedAt) })}</span>
}
