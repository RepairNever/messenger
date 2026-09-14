import { describe, expect, it } from 'vitest'
import {
  DAYOFF_WEEKEND_DAYS,
  calendarDays,
  daysInMonth,
  formatDateOnly,
  isDateWithinRange,
  isWeekend,
  monthBounds,
  parseDateOnly,
  rangeSegmentsForMonth,
} from '@/utils/dayoffsCalendar'

describe('dayoffsCalendar', () => {
  it('defines Saturday and Sunday as the only weekend days using native getDay values', () => {
    expect(DAYOFF_WEEKEND_DAYS).toEqual([0, 6])
    expect(isWeekend(new Date(2026, 6, 18))).toBe(true) // Saturday
    expect(isWeekend(new Date(2026, 6, 19))).toBe(true) // Sunday
    expect(isWeekend(new Date(2026, 6, 20))).toBe(false) // Monday
  })

  it('uses local date-only parsing and formatting without UTC day drift', () => {
    const date = parseDateOnly('2026-02-03')

    expect(date.getFullYear()).toBe(2026)
    expect(date.getMonth()).toBe(1)
    expect(date.getDate()).toBe(3)
    expect(formatDateOnly(date)).toBe('2026-02-03')
  })

  it('rejects malformed and impossible date-only values', () => {
    expect(() => parseDateOnly('2026-02-30')).toThrow(RangeError)
    expect(() => parseDateOnly('02/03/2026')).toThrow(RangeError)
  })

  it('calculates month bounds and leap-year day counts', () => {
    const bounds = monthBounds(new Date(2028, 1, 12))

    expect(formatDateOnly(bounds.start)).toBe('2028-02-01')
    expect(formatDateOnly(bounds.end)).toBe('2028-02-29')
    expect(daysInMonth(new Date(2028, 1, 12))).toBe(29)
  })

  it('generates all month cells and marks only fixed weekend cells', () => {
    const days = calendarDays(new Date(2026, 6, 1))

    expect(days).toHaveLength(31)
    expect(days.find(day => day.dateKey === '2026-07-18')?.isWeekend).toBe(true)
    expect(days.find(day => day.dateKey === '2026-07-19')?.isWeekend).toBe(true)
    expect(days.find(day => day.dateKey === '2026-07-20')?.isWeekend).toBe(false)
  })

  it('uses inclusive date ranges', () => {
    expect(isDateWithinRange(new Date(2026, 6, 20), '2026-07-20', '2026-07-20')).toBe(true)
    expect(isDateWithinRange(new Date(2026, 6, 19), '2026-07-20', '2026-07-22')).toBe(false)
    expect(isDateWithinRange(new Date(2026, 6, 22), '2026-07-20', '2026-07-22')).toBe(true)
  })

  it('splits leave bars around Saturday and Sunday rather than drawing through them', () => {
    const segments = rangeSegmentsForMonth(
      '2026-07-17', // Friday
      '2026-07-20', // Monday
      new Date(2026, 6, 1),
    )

    expect(segments).toEqual([
      { startDay: 17, endDay: 17 },
      { startDay: 20, endDay: 20 },
    ])
  })

  it('clips a range to the selected month', () => {
    expect(rangeSegmentsForMonth('2026-06-29', '2026-07-03', new Date(2026, 6, 1))).toEqual([
      { startDay: 1, endDay: 3 },
    ])
  })
})
