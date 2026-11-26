/**
 * Pure time and duration formatting shared across the right sidebar (D47).
 * Uses hybrid absolute timestamps (`HH:mm`, `Yesterday HH:mm`, `MM-DD HH:mm`,
 * `YYYY-MM-DD HH:mm`) paired with settled duration (`· 2m 13s` / `<1s`), and
 * puts exact start/end timestamps plus relative distance into hover titles.
 * Accepts only existing timestamps (`startedAt`, `at`, `endedAt`) with zero
 * new persisted fields.
 * @module dsh-acp-resume/client/panel-time
 */

import type { PanelTranslate } from './locales.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Timestamp fields already present on turns, events, chats, and workflow runs. */
export interface TimeSpanInput {
  readonly startedAt?: number
  readonly at?: number
  readonly endedAt?: number
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function isYesterdayOf(target: Date, ref: Date): boolean {
  const yesterday = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - 1)
  return isSameLocalDay(target, yesterday)
}

/** `HH:mm` in local time. */
export function formatClock(ts: number): string {
  const d = new Date(ts)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** `HH:mm:ss` in local time. */
export function formatClockSeconds(ts: number): string {
  const d = new Date(ts)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** `YYYY-MM-DD HH:mm:ss` in local time. */
export function formatFullTimestamp(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${formatClockSeconds(ts)}`
}

/**
 * Coarse relative time of `then` seen from `now`. Future timestamps (clock skew)
 * clamp to zero and read as "just now".
 * @param t - panel copy.
 * @param then - epoch milliseconds.
 * @param now - reference epoch milliseconds.
 */
export function formatRelativeTime(t: PanelTranslate, then: number, now: number): string {
  if (!Number.isFinite(then) || !Number.isFinite(now)) return t('noValue')
  const elapsed = Math.max(0, now - then)
  if (elapsed < MINUTE) return t('justNow')
  if (elapsed < HOUR) return t('minutesAgo', { count: Math.floor(elapsed / MINUTE) })
  if (elapsed < DAY) return t('hoursAgo', { count: Math.floor(elapsed / HOUR) })
  return t('daysAgo', { count: Math.floor(elapsed / DAY) })
}

/**
 * A duration in at most two adjacent units: `12秒`, `3分12秒`, `1时5分`, `2天3时`
 * (`12s`, `3m 12s`, `1h 5m`, `2d 3h` in English). Negative values clamp to zero.
 * @param t - panel copy.
 * @param ms - duration in milliseconds.
 */
export function formatPanelDuration(t: PanelTranslate, ms: number): string {
  if (!Number.isFinite(ms)) return t('noValue')
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return t('durationSeconds', { s: seconds })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t('durationMinutes', { m: minutes, s: seconds % 60 })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('durationHours', { h: hours, m: minutes % 60 })
  return t('durationDays', { d: Math.floor(hours / 24), h: hours % 24 })
}

/**
 * Settled duration for completed/ended items: sub-second durations (including
 * exact 0 ms and negative clock skew) render as `<1秒` / `<1s`; durations of
 * at least 1 second delegate to {@link formatPanelDuration}.
 * @param t - panel copy.
 * @param ms - elapsed milliseconds (`end - start`).
 */
export function formatSettledDuration(t: PanelTranslate, ms: number): string {
  if (!Number.isFinite(ms)) return t('noValue')
  const clamped = Math.max(0, ms)
  if (clamped < 1000) return t('durationUnderSecond')
  return formatPanelDuration(t, clamped)
}

/**
 * Hybrid local timestamp relative to `now`:
 * - same calendar day: `15:08`
 * - calendar yesterday (including across month/year boundaries): `昨天 22:40` / `Yesterday 22:40`
 * - same calendar year: `11-24 09:15`
 * - different calendar year: `2025-11-24 09:15`
 * @param t - panel copy.
 * @param ts - target epoch milliseconds.
 * @param now - reference epoch milliseconds.
 */
export function formatHybridTime(t: PanelTranslate, ts: number, now: number): string {
  if (!Number.isFinite(ts) || !Number.isFinite(now)) return t('noValue')
  const target = new Date(ts)
  const ref = new Date(now)
  const clock = formatClock(ts)
  if (isSameLocalDay(target, ref)) return clock
  if (isYesterdayOf(target, ref)) return `${t('dateYesterday')} ${clock}`
  const md = `${pad2(target.getMonth() + 1)}-${pad2(target.getDate())}`
  if (target.getFullYear() === ref.getFullYear()) return `${md} ${clock}`
  return `${target.getFullYear()}-${md} ${clock}`
}

/**
 * Settled turn / workflow timestamp with optional duration:
 * `15:08 · 2分13秒` when both start and end are present, otherwise the hybrid
 * point timestamp of whichever boundary exists.
 * @param t - panel copy.
 * @param input - existing `startedAt` / `at` / `endedAt` timestamps.
 * @param now - reference epoch milliseconds.
 */
export function formatTurnTime(t: PanelTranslate, input: TimeSpanInput, now: number): string {
  const end = input.endedAt ?? input.at
  if (end !== undefined && input.startedAt !== undefined) {
    if (!Number.isFinite(end) || !Number.isFinite(input.startedAt) || !Number.isFinite(now)) return t('noValue')
    return `${formatHybridTime(t, end, now)} · ${formatSettledDuration(t, end - input.startedAt)}`
  }
  if (end !== undefined) return formatHybridTime(t, end, now)
  if (input.startedAt !== undefined) return formatHybridTime(t, input.startedAt, now)
  return t('noValue')
}

/**
 * Full hover `title` for a timestamp or settled span, showing exact local
 * start/end times, settled duration, and coarse relative distance.
 * @param t - panel copy.
 * @param input - existing `startedAt` / `at` / `endedAt` timestamps.
 * @param now - reference epoch milliseconds.
 */
export function formatTurnTimeTitle(t: PanelTranslate, input: TimeSpanInput, now: number): string {
  const end = input.endedAt ?? input.at
  if (end !== undefined && input.startedAt !== undefined) {
    if (!Number.isFinite(end) || !Number.isFinite(input.startedAt) || !Number.isFinite(now)) return ''
    const startDate = new Date(input.startedAt)
    const endDate = new Date(end)
    const endText = isSameLocalDay(startDate, endDate) ? formatClockSeconds(end) : formatFullTimestamp(end)
    return t('turnTimeTooltip', {
      start: formatFullTimestamp(input.startedAt),
      end: endText,
      duration: formatSettledDuration(t, end - input.startedAt),
      relative: formatRelativeTime(t, end, now),
    })
  }
  if (end !== undefined) {
    if (!Number.isFinite(end) || !Number.isFinite(now)) return ''
    return t('pointTimeTooltip', {
      time: formatFullTimestamp(end),
      relative: formatRelativeTime(t, end, now),
    })
  }
  if (input.startedAt !== undefined) {
    if (!Number.isFinite(input.startedAt)) return ''
    return t('startedAtTooltip', { time: formatFullTimestamp(input.startedAt) })
  }
  return ''
}

/**
 * Compact time span label for folded history sections (`13:10 – 14:52`).
 * @param t - panel copy.
 * @param oldest - earliest epoch milliseconds in the group.
 * @param newest - latest epoch milliseconds in the group.
 * @param now - reference epoch milliseconds.
 */
export function formatTimeRange(t: PanelTranslate, oldest: number, newest: number, now: number): string {
  if (!Number.isFinite(oldest) || !Number.isFinite(newest) || !Number.isFinite(now)) return t('noValue')
  const a = formatHybridTime(t, Math.min(oldest, newest), now)
  const b = formatHybridTime(t, Math.max(oldest, newest), now)
  return a === b ? a : `${a} – ${b}`
}

/**
 * Natural calendar day label (`今天` / `昨天` / `MM-DD` / `YYYY-MM-DD`).
 * @param t - panel copy.
 * @param ts - target epoch milliseconds.
 * @param now - reference epoch milliseconds.
 */
export function formatDayHeader(t: PanelTranslate, ts: number, now: number): string {
  if (!Number.isFinite(ts) || !Number.isFinite(now)) return t('noValue')
  const target = new Date(ts)
  const ref = new Date(now)
  if (isSameLocalDay(target, ref)) return t('dateToday')
  if (isYesterdayOf(target, ref)) return t('dateYesterday')
  const md = `${pad2(target.getMonth() + 1)}-${pad2(target.getDate())}`
  return target.getFullYear() === ref.getFullYear() ? md : `${target.getFullYear()}-${md}`
}
