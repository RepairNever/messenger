import { AxiosError } from 'axios'
import { createAuthenticatedClient } from './client'

const http = createAuthenticatedClient()

export type DayoffType = 'vacation' | 'sick_leave' | 'personal_day'

/** UI-facing, camelCase representation of a Dayoffs record. */
export interface Dayoff {
  id: string
  userId: string
  type: DayoffType
  startDate: string
  endDate: string
  note: string
  createdAt: string
  updatedAt: string
}

/** Active employee returned for the calendar, including people with no records. */
export interface DayoffEmployee {
  id: string
  displayName: string
  avatarUrl: string
  role?: string
  active?: boolean
}

/** Calendar-day leave totals for one employee in the selected calendar year. */
export interface DayoffYearTotal {
  userId: string
  vacationDays: number
  sickLeaveDays: number
  personalDays: number
}

export interface DayoffsListResponse {
  employees: DayoffEmployee[]
  records: Dayoff[]
  yearTotals: DayoffYearTotal[]
}

export interface CreateDayoffInput {
  /** Available only to administrators and owners; members must omit it. */
  userId?: string
  type: DayoffType
  startDate: string
  endDate: string
  note?: string | null
}

/** PATCH currently uses the full mutable record shape. */
export type UpdateDayoffInput = CreateDayoffInput

export class DayoffsApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message)
    this.name = 'DayoffsApiError'
  }
}

export class DayoffsApiConflictError extends DayoffsApiError {
  constructor(message: string, status: number) {
    super(message, status)
    this.name = 'DayoffsApiConflictError'
  }
}

interface DayoffDto {
  id: string
  user_id: string
  type: DayoffType
  start_date: string
  end_date: string
  note?: string | null
  created_at: string
  updated_at: string
}

interface DayoffEmployeeDto {
  id: string
  display_name: string
  avatar_url?: string | null
  role?: string
  active?: boolean
}

interface DayoffYearTotalDto {
  user_id: string
  vacation_days?: number
  sick_leave_days?: number
  personal_days?: number
}

interface DayoffsListResponseDto {
  employees: DayoffEmployeeDto[]
  records: DayoffDto[]
  year_totals?: DayoffYearTotalDto[]
}

interface DayoffRequestDto {
  user_id?: string
  type: DayoffType
  start_date: string
  end_date: string
  note?: string
}

function handleError(error: unknown): never {
  if (error instanceof AxiosError && error.response) {
    const message = typeof error.response.data?.error === 'string'
      ? error.response.data.error
      : error.response.statusText || 'Request failed'
    if (error.response.status === 409) {
      throw new DayoffsApiConflictError(message, error.response.status)
    }
    throw new DayoffsApiError(message, error.response.status)
  }
  throw new DayoffsApiError('Network error', 0)
}

function toDayoff(dto: DayoffDto): Dayoff {
  return {
    id: dto.id,
    userId: dto.user_id,
    type: dto.type,
    startDate: dto.start_date,
    endDate: dto.end_date,
    note: dto.note ?? '',
    createdAt: dto.created_at,
    updatedAt: dto.updated_at,
  }
}

function toDayoffEmployee(dto: DayoffEmployeeDto): DayoffEmployee {
  return {
    id: dto.id,
    displayName: dto.display_name,
    avatarUrl: dto.avatar_url ?? '',
    ...(dto.role === undefined ? {} : { role: dto.role }),
    ...(dto.active === undefined ? {} : { active: dto.active }),
  }
}

function toDayoffYearTotal(dto: DayoffYearTotalDto): DayoffYearTotal {
  return {
    userId: dto.user_id,
    vacationDays: dto.vacation_days ?? 0,
    sickLeaveDays: dto.sick_leave_days ?? 0,
    personalDays: dto.personal_days ?? 0,
  }
}

function toRequestDto(input: CreateDayoffInput): DayoffRequestDto {
  return {
    ...(input.userId === undefined ? {} : { user_id: input.userId }),
    type: input.type,
    start_date: input.startDate,
    end_date: input.endDate,
    ...(input.note === undefined ? {} : { note: input.note ?? '' }),
  }
}

function normalizeListResponse(response: DayoffsListResponseDto | DayoffDto[]): DayoffsListResponse {
  // The production contract is the envelope. Accepting a record array makes
  // older deployments fail gracefully while they are upgraded.
  if (Array.isArray(response)) {
    return { employees: [], records: response.map(toDayoff), yearTotals: [] }
  }
  return {
    employees: Array.isArray(response.employees) ? response.employees.map(toDayoffEmployee) : [],
    records: Array.isArray(response.records) ? response.records.map(toDayoff) : [],
    yearTotals: Array.isArray(response.year_totals) ? response.year_totals.map(toDayoffYearTotal) : [],
  }
}

function assertMonth(year: number, month: number): void {
  if (!Number.isInteger(year) || year < 1 || year > 9999) {
    throw new RangeError('Dayoffs year must be a four-digit calendar year')
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError('Dayoffs month must be between 1 and 12')
  }
}

/** Fetches every active employee and all records intersecting a calendar month. */
export async function dayoffsList(year: number, month: number): Promise<DayoffsListResponse> {
  assertMonth(year, month)
  try {
    const { data } = await http.get<DayoffsListResponseDto | DayoffDto[]>('/api/dayoffs', {
      params: { year, month },
    })
    return normalizeListResponse(data)
  } catch (error) {
    return handleError(error)
  }
}

export async function dayoffsCreate(input: CreateDayoffInput): Promise<Dayoff> {
  try {
    const { data } = await http.post<DayoffDto>('/api/dayoffs', toRequestDto(input))
    return toDayoff(data)
  } catch (error) {
    return handleError(error)
  }
}

export async function dayoffsUpdate(id: string, input: UpdateDayoffInput): Promise<Dayoff> {
  try {
    const { data } = await http.patch<DayoffDto>(`/api/dayoffs/${id}`, toRequestDto(input))
    return toDayoff(data)
  } catch (error) {
    return handleError(error)
  }
}

export async function dayoffsDelete(id: string): Promise<void> {
  try {
    await http.delete(`/api/dayoffs/${id}`)
  } catch (error) {
    return handleError(error)
  }
}
