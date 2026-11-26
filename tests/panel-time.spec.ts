/**
 * Unit tests for shared sidebar time formatting (`src/client/panel-time.ts`).
 * Covers same day, yesterday, earlier this year, cross-year, sub-second, exact
 * zero, month/year boundaries, future timestamps (clock skew), and hover titles.
 * @module dsh-acp-resume/tests/panel-time.spec
 */

import { describe, expect, it } from 'vitest'
import { en, zh, type PanelCopyKey, type PanelTranslate } from '../src/client/locales.ts'
import {
  formatDayHeader,
  formatHybridTime,
  formatSettledDuration,
  formatTimeRange,
  formatTurnTime,
  formatTurnTimeTitle,
} from '../src/client/panel-time.ts'

const translator = (dict: Record<PanelCopyKey, string>): PanelTranslate => (key, params) =>
  dict[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? `{${name}}`))

const tZh = translator(zh)
const tEn = translator(en)

/** Construct a local timestamp so tests are timezone-independent. */
function local(year: number, month: number, day: number, hour: number, minute: number, second = 0, ms = 0): number {
  return new Date(year, month - 1, day, hour, minute, second, ms).getTime()
}

describe('panel-time', () => {
  const now = local(2026, 11, 26, 17, 30, 0)

  it('formats same-day settled turns with hybrid clock and duration in zh and en', () => {
    const span = { startedAt: local(2026, 11, 26, 15, 5, 47), at: local(2026, 11, 26, 15, 8, 0) }
    expect(formatTurnTime(tZh, span, now)).toBe('15:08 · 2分13秒')
    expect(formatTurnTime(tEn, span, now)).toBe('15:08 · 2m 13s')
  })

  it('formats yesterday settled turns with localized yesterday prefix and duration', () => {
    const span = { startedAt: local(2026, 11, 25, 22, 39, 15), endedAt: local(2026, 11, 25, 22, 40, 0) }
    expect(formatTurnTime(tZh, span, now)).toBe('昨天 22:40 · 45秒')
    expect(formatTurnTime(tEn, span, now)).toBe('Yesterday 22:40 · 45s')
  })

  it('formats earlier-this-year timestamps without year and cross-year timestamps with year', () => {
    const sameYear = local(2026, 11, 24, 9, 15, 0)
    const prevYear = local(2025, 11, 24, 9, 15, 0)
    expect(formatHybridTime(tZh, sameYear, now)).toBe('11-24 09:15')
    expect(formatHybridTime(tEn, sameYear, now)).toBe('11-24 09:15')
    expect(formatHybridTime(tZh, prevYear, now)).toBe('2025-11-24 09:15')
    expect(formatHybridTime(tEn, prevYear, now)).toBe('2025-11-24 09:15')
    expect(formatTurnTime(tZh, { startedAt: prevYear - 70_000, at: prevYear }, now)).toBe('2025-11-24 09:15 · 1分10秒')
    expect(formatTurnTime(tEn, { startedAt: prevYear - 70_000, at: prevYear }, now)).toBe('2025-11-24 09:15 · 1m 10s')
  })

  it('formats sub-second and exact-zero settled durations as <1s', () => {
    const subSec = { startedAt: local(2026, 11, 26, 15, 8, 0, 0), at: local(2026, 11, 26, 15, 8, 0, 420) }
    const zeroSec = { startedAt: local(2026, 11, 26, 15, 8, 0, 0), at: local(2026, 11, 26, 15, 8, 0, 0) }
    expect(formatSettledDuration(tZh, 420)).toBe('<1秒')
    expect(formatSettledDuration(tEn, 420)).toBe('<1s')
    expect(formatSettledDuration(tZh, 0)).toBe('<1秒')
    expect(formatSettledDuration(tEn, 0)).toBe('<1s')
    expect(formatTurnTime(tZh, subSec, now)).toBe('15:08 · <1秒')
    expect(formatTurnTime(tEn, subSec, now)).toBe('15:08 · <1s')
    expect(formatTurnTime(tZh, zeroSec, now)).toBe('15:08 · <1秒')
    expect(formatTurnTime(tEn, zeroSec, now)).toBe('15:08 · <1s')
  })

  it('handles month and year boundaries accurately for yesterday detection', () => {
    const march1 = local(2026, 3, 1, 0, 10, 0)
    expect(formatHybridTime(tZh, local(2026, 2, 28, 23, 50, 0), march1)).toBe('昨天 23:50')
    expect(formatHybridTime(tEn, local(2026, 2, 28, 23, 50, 0), march1)).toBe('Yesterday 23:50')
    expect(formatHybridTime(tZh, local(2026, 2, 27, 23, 50, 0), march1)).toBe('02-27 23:50')

    const jan1 = local(2026, 1, 1, 0, 10, 0)
    expect(formatHybridTime(tZh, local(2025, 12, 31, 23, 55, 0), jan1)).toBe('昨天 23:55')
    expect(formatHybridTime(tEn, local(2025, 12, 31, 23, 55, 0), jan1)).toBe('Yesterday 23:55')
    expect(formatHybridTime(tZh, local(2025, 12, 30, 23, 55, 0), jan1)).toBe('2025-12-30 23:55')
    expect(formatDayHeader(tZh, local(2025, 12, 31, 23, 55, 0), jan1)).toBe('昨天')
    expect(formatDayHeader(tEn, local(2025, 12, 30, 23, 55, 0), jan1)).toBe('2025-12-30')
  })

  it('handles future timestamps and inverted spans (clock skew) without throwing', () => {
    const futureSameDay = local(2026, 11, 26, 17, 45, 0)
    const futureNextYear = local(2027, 1, 2, 8, 30, 0)
    expect(formatHybridTime(tZh, futureSameDay, now)).toBe('17:45')
    expect(formatHybridTime(tEn, futureNextYear, now)).toBe('2027-01-02 08:30')
    expect(formatTurnTime(tZh, { startedAt: futureSameDay + 5000, at: futureSameDay }, now)).toBe('17:45 · <1秒')
    expect(formatTurnTimeTitle(tZh, { at: futureSameDay }, now)).toBe('2026-11-26 17:45:00（刚刚）')
    expect(formatTurnTimeTitle(tEn, { at: futureSameDay }, now)).toBe('2026-11-26 17:45:00 (just now)')
  })

  it('builds complete hover title strings for spans, midnight crossings, points, and running starts', () => {
    const sameDay = { startedAt: local(2026, 11, 26, 15, 5, 47), at: local(2026, 11, 26, 15, 8, 0) }
    expect(formatTurnTimeTitle(tZh, sameDay, now)).toBe('开始 2026-11-26 15:05:47 · 结束 15:08:00 · 耗时 2分13秒（2 小时前）')
    expect(formatTurnTimeTitle(tEn, sameDay, now)).toBe('Started 2026-11-26 15:05:47 · Ended 15:08:00 · 2m 13s (2 h ago)')

    const crossMidnight = { startedAt: local(2026, 11, 25, 23, 59, 0), endedAt: local(2026, 11, 26, 0, 1, 0) }
    expect(formatTurnTimeTitle(tZh, crossMidnight, now)).toBe('开始 2026-11-25 23:59:00 · 结束 2026-11-26 00:01:00 · 耗时 2分0秒（17 小时前）')

    const point = { at: local(2026, 11, 26, 17, 27, 0) }
    expect(formatTurnTimeTitle(tZh, point, now)).toBe('2026-11-26 17:27:00（3 分钟前）')
    expect(formatTurnTimeTitle(tEn, point, now)).toBe('2026-11-26 17:27:00 (3 min ago)')

    const running = { startedAt: local(2026, 11, 26, 17, 18, 3) }
    expect(formatTurnTimeTitle(tZh, running, now)).toBe('开始于 2026-11-26 17:18:03')
    expect(formatTurnTimeTitle(tEn, running, now)).toBe('Started 2026-11-26 17:18:03')

    expect(formatTimeRange(tZh, local(2026, 11, 26, 13, 10, 0), local(2026, 11, 26, 14, 52, 0), now)).toBe('13:10 – 14:52')
  })
})
