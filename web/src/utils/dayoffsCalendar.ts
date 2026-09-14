/**
 * The only definition of non-working weekend days for the Dayoffs feature.
 * Native Date#getDay uses Sunday = 0 through Saturday = 6.
 */
export const DAYOFF_WEEKEND_DAYS = [0, 6] as const

const weekendDaySet = new Set<number>(DAYOFF_WEEKEND_DAYS)
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

export interface MonthBounds {
  start: Date
  end: Date
}

export interface CalendarDay {
  /** Local, date-only value at midnight. */
  date: Date
  /** ISO-like local date key (`YYYY-MM-DD`), safe for API date fields. */
  dateKey: string
  /** One-based day of the month. */
  day: number
  isWeekend: boolean
}

/** A contiguous, working-day-only part of a leave range within one month. */
export interface DayoffRangeSegment {
  /** One-based first visible day in the month. */
  startDay: number
  /** One-based final visible day in the month. */
  endDay: number
}

function assertValidDate(date: Date): void {
  if (Number.isNaN(date.getTime())) {
    throw new RangeError('Expected a valid date')
  }
}

function localDate(year: number, monthIndex: number, day: number): Date {
  // Date's numeric constructor treats years 0-99 as 1900-1999. setFullYear
  // preserves a literal date-only year when parsing values such as 0001-01-01.
  const date = new Date(0)
  date.setHours(0, 0, 0, 0)
  date.setFullYear(year, monthIndex, day)
  return date
}

function asLocalDate(date: Date): Date {
  assertValidDate(date)
  return localDate(date.getFullYear(), date.getMonth(), date.getDate())
}

function compareLocalDates(left: Date, right: Date): number {
  return left.getTime() - right.getTime()
}

/** Returns whether a native Date falls on the fixed Saturday/Sunday weekend. */
export function isWeekend(date: Date): boolean {
  assertValidDate(date)
  return weekendDaySet.has(date.getDay())
}

/** Alias that makes the feature scope explicit at call sites. */
export const isDayoffWeekend = isWeekend

/** Converts a date-only API value into a local calendar date without UTC drift. */
export function parseDateOnly(value: string): Date {
  const match = DATE_ONLY_PATTERN.exec(value)
  if (!match) {
    throw new RangeError(`Expected a YYYY-MM-DD date, received ${value}`)
  }

  const year = Number(match[1])
  const monthIndex = Number(match[2]) - 1
  const day = Number(match[3])
  const date = localDate(year, monthIndex, day)

  if (
    year < 1
    || monthIndex < 0
    || monthIndex > 11
    || day < 1
    || date.getFullYear() !== year
    || date.getMonth() !== monthIndex
    || date.getDate() !== day
  ) {
    throw new RangeError(`Expected a valid YYYY-MM-DD date, received ${value}`)
  }

  return date
}

/** Formats a local calendar date for the Dayoffs API's date-only fields. */
export function formatDateOnly(date: Date): string {
  const local = asLocalDate(date)
  const year = String(local.getFullYear()).padStart(4, '0')
  const month = String(local.getMonth() + 1).padStart(2, '0')
  const day = String(local.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Returns the local first day of a month. */
export function startOfMonth(date: Date): Date {
  assertValidDate(date)
  return localDate(date.getFullYear(), date.getMonth(), 1)
}

/** Returns inclusive local start/end dates for a month. */
export function monthBounds(month: Date): MonthBounds {
  const start = startOfMonth(month)
  return {
    start,
    end: localDate(start.getFullYear(), start.getMonth() + 1, 0),
  }
}

/** Returns the number of days in the month that contains `month`. */
export function daysInMonth(month: Date): number {
  return monthBounds(month).end.getDate()
}

/** Generates each local date cell for a month, including fixed weekends. */
export function calendarDays(month: Date): CalendarDay[] {
  const { start, end } = monthBounds(month)
  const result: CalendarDay[] = []

  for (let day = 1; day <= end.getDate(); day += 1) {
    const date = localDate(start.getFullYear(), start.getMonth(), day)
    result.push({
      date,
      dateKey: formatDateOnly(date),
      day,
      isWeekend: isWeekend(date),
    })
  }

  return result
}

/** Returns true when the supplied date is inside the inclusive date-only range. */
export function isDateWithinRange(date: Date, startDate: string, endDate: string): boolean {
  const local = asLocalDate(date)
  const start = parseDateOnly(startDate)
  const end = parseDateOnly(endDate)
  return compareLocalDates(start, local) <= 0 && compareLocalDates(local, end) <= 0
}

/**
 * Splits an inclusive leave range into visible working-day portions for one
 * month. Saturday and Sunday are omitted and therefore never bridged by a
 * rendered bar.
 */
export function rangeSegmentsForMonth(
  startDate: string,
  endDate: string,
  month: Date,
): DayoffRangeSegment[] {
  const rangeStart = parseDateOnly(startDate)
  const rangeEnd = parseDateOnly(endDate)
  if (compareLocalDates(rangeStart, rangeEnd) > 0) {
    throw new RangeError('A leave range cannot end before it starts')
  }

  const bounds = monthBounds(month)
  const visibleStart = compareLocalDates(rangeStart, bounds.start) > 0 ? rangeStart : bounds.start
  const visibleEnd = compareLocalDates(rangeEnd, bounds.end) < 0 ? rangeEnd : bounds.end
  if (compareLocalDates(visibleStart, visibleEnd) > 0) return []

  const segments: DayoffRangeSegment[] = []
  let segmentStart: number | null = null
  let previousDay: number | null = null
  const cursor = asLocalDate(visibleStart)

  while (compareLocalDates(cursor, visibleEnd) <= 0) {
    const day = cursor.getDate()
    if (!isWeekend(cursor)) {
      if (segmentStart === null || previousDay === null || day !== previousDay + 1) {
        if (segmentStart !== null && previousDay !== null) {
          segments.push({ startDay: segmentStart, endDay: previousDay })
        }
        segmentStart = day
      }
      previousDay = day
    } else if (segmentStart !== null && previousDay !== null) {
      segments.push({ startDay: segmentStart, endDay: previousDay })
      segmentStart = null
      previousDay = null
    }
    cursor.setDate(cursor.getDate() + 1)
  }

  if (segmentStart !== null && previousDay !== null) {
    segments.push({ startDay: segmentStart, endDay: previousDay })
  }

  return segments
}
