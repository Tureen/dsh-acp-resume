/** Safe Markdown bodies and plain-text excerpts for the ACP detail tab. @module */
import { MarkdownText, MARKDOWN_COMPACT_CLASS, cleanPreviewResult, useMarkdownLabels } from './panel-chrome.tsx'
import type { PanelTranslate } from './locales.ts'

/** Extract readable lines before applying the narrow sidebar's excerpt limits. */
export function detailPreview(text: string, maxLines: number) {
  return cleanPreviewResult(text, { maxLines, maxChars: 200 })
}

/** Stable labels retain the official streaming renderer's block cache. */
export function DetailMarkdown({ text, t, streaming = false }: { text: string; t: PanelTranslate; streaming?: boolean }) {
  const labels = useMarkdownLabels(t)
  return <div className={MARKDOWN_COMPACT_CLASS}>
    <MarkdownText text={text} variant="body" streaming={streaming} omitHtml={true} labels={labels} />
  </div>
}
