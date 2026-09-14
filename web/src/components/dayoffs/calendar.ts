import type { CalendarDay as SharedCalendarDay } from '@/utils/dayoffsCalendar'
import {
  calendarDays,
  formatDateOnly as formatDateOnlyKey,
  isDateWithinRange,
  parseDateOnly,
} from '@/utils/dayoffsCalendar'
import type { Dayoff } from '@/stores/dayoffs'

export interface CalendarDay extends SharedCalendarDay {
  key: string
  dayNumber: number
  weekdayLabel: string
  isToday: boolean
}

export function dateOnlyKey(date: Date): string {
  return formatDateOnlyKey(date)
}

export function dateFromDateOnly(value: string): Date {
  return parseDateOnly(value)
}

export function monthLabel(month: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'long',
    year: 'numeric',
  }).format(month)
}

export function formatDayoffDate(value: string): string {
  const date = dateFromDateOnly(value)
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date)
}

export function formatDateRange(record: Pick<Dayoff, 'startDate' | 'endDate'>): string {
  if (record.startDate === record.endDate) return formatDayoffDate(record.startDate)
  return `${formatDayoffDate(record.startDate)} – ${formatDayoffDate(record.endDate)}`
}

export function calendarDaysForMonth(month: Date): CalendarDay[] {
  const todayKey = dateOnlyKey(new Date())
  const weekdayFormatter = new Intl.DateTimeFormat(undefined, { weekday: 'short' })

  return calendarDays(month).map((sharedDay) => {
    const key = sharedDay.dateKey
    return {
      ...sharedDay,
      key,
      dayNumber: sharedDay.day,
      weekdayLabel: weekdayFormatter.format(sharedDay.date).replace('.', '').slice(0, 2),
      isToday: key === todayKey,
    }
  })
}

export function recordForCalendarDay(records: Dayoff[], userId: string, dayKey: string): Dayoff | null {
  return records.find(record => (
    record.userId === userId
    && isDateWithinRange(parseDateOnly(dayKey), record.startDate, record.endDate)
  )) ?? null
}
