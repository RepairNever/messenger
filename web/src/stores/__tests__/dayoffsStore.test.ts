import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useDayoffsStore } from '@/stores/dayoffs'
import {
  dayoffsCreate,
  dayoffsDelete,
  dayoffsList,
  dayoffsUpdate,
} from '@/services/http/dayoffsApi'

vi.mock('@/services/http/dayoffsApi', () => ({
  dayoffsCreate: vi.fn(),
  dayoffsDelete: vi.fn(),
  dayoffsList: vi.fn(),
  dayoffsUpdate: vi.fn(),
}))

function makeRecord(id = 'dayoff-1', userId = 'user-1') {
  return {
    id,
    userId,
    type: 'vacation' as const,
    startDate: '2026-07-17',
    endDate: '2026-07-20',
    note: '',
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z',
  }
}

function makeResponse() {
  return {
    employees: [
      { id: 'user-1', displayName: 'Ada Lovelace', avatarUrl: '' },
      { id: 'user-2', displayName: 'Grace Hopper', avatarUrl: '' },
    ],
    records: [makeRecord()],
    yearTotals: [
      { userId: 'user-1', vacationDays: 4, sickLeaveDays: 0, personalDays: 0 },
      { userId: 'user-2', vacationDays: 0, sickLeaveDays: 2, personalDays: 1 },
    ],
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('dayoffs store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.mocked(dayoffsList).mockResolvedValue(makeResponse())
  })

  it('loads all employees including people with no leave and normalizes the selected month', async () => {
    const store = useDayoffsStore()

    await store.setMonth(new Date(2026, 6, 23))

    expect(dayoffsList).toHaveBeenCalledWith(2026, 7)
    expect(store.selectedMonth.getFullYear()).toBe(2026)
    expect(store.selectedMonth.getMonth()).toBe(6)
    expect(store.selectedMonth.getDate()).toBe(1)
    expect(store.employees.map(employee => employee.id)).toEqual(['user-1', 'user-2'])
    expect(store.records).toEqual([makeRecord()])
    expect(store.yearTotals).toEqual([
      { userId: 'user-1', vacationDays: 4, sickLeaveDays: 0, personalDays: 0 },
      { userId: 'user-2', vacationDays: 0, sickLeaveDays: 2, personalDays: 1 },
    ])
    expect(store.loading).toBe(false)
  })

  it('filters records locally without hiding employees that have no records', async () => {
    const store = useDayoffsStore()
    await store.load()

    store.setSelectedEmployee('user-2')

    expect(store.selectedEmployee?.displayName).toBe('Grace Hopper')
    expect(store.selectedEmployeeYearTotal).toEqual({
      userId: 'user-2',
      vacationDays: 0,
      sickLeaveDays: 2,
      personalDays: 1,
    })
    expect(store.visibleRecords).toEqual([])
    expect(store.employees).toHaveLength(2)
  })

  it('clears a stale employee selection when the selected person is no longer active', async () => {
    const store = useDayoffsStore()
    await store.load()
    store.setSelectedEmployee('user-2')
    vi.mocked(dayoffsList).mockResolvedValueOnce({
      employees: [{ id: 'user-1', displayName: 'Ada Lovelace', avatarUrl: '' }],
      records: [],
      yearTotals: [{ userId: 'user-1', vacationDays: 0, sickLeaveDays: 0, personalDays: 0 }],
    })

    await store.load()

    expect(store.selectedEmployeeId).toBeNull()
  })

  it('refreshes the current month after a create', async () => {
    const store = useDayoffsStore()
    vi.mocked(dayoffsCreate).mockResolvedValueOnce(makeRecord())
    vi.mocked(dayoffsList).mockResolvedValueOnce(makeResponse())
    const input = {
      type: 'vacation' as const,
      startDate: '2026-07-17',
      endDate: '2026-07-20',
      note: 'Summer break',
    }

    const result = await store.create(input)

    expect(result).toEqual(makeRecord())
    expect(dayoffsCreate).toHaveBeenCalledWith(input)
    expect(dayoffsList).toHaveBeenCalledWith(
      store.selectedMonth.getFullYear(),
      store.selectedMonth.getMonth() + 1,
    )
    expect(store.isSaving).toBe(false)
  })

  it('refreshes after update and delete mutations', async () => {
    const store = useDayoffsStore()
    vi.mocked(dayoffsUpdate).mockResolvedValueOnce(makeRecord())
    vi.mocked(dayoffsDelete).mockResolvedValueOnce(undefined)
    vi.mocked(dayoffsList).mockResolvedValue(makeResponse())
    const input = {
      type: 'sick_leave' as const,
      startDate: '2026-07-17',
      endDate: '2026-07-20',
      note: '',
    }

    await store.update('dayoff-1', input)
    await store.remove('dayoff-1')

    expect(dayoffsUpdate).toHaveBeenCalledWith('dayoff-1', input)
    expect(dayoffsDelete).toHaveBeenCalledWith('dayoff-1')
    expect(dayoffsList).toHaveBeenCalledTimes(2)
  })

  it('keeps existing data and exposes a readable error when a load fails', async () => {
    const store = useDayoffsStore()
    await store.load()
    vi.mocked(dayoffsList).mockRejectedValueOnce(new Error('Request denied'))

    await store.load()

    expect(store.records).toEqual([makeRecord()])
    expect(store.error).toBe('Request denied')
    expect(store.loading).toBe(false)
  })

  it('does not let a slower prior month response overwrite a newer month', async () => {
    const store = useDayoffsStore()
    const july = deferred<ReturnType<typeof makeResponse>>()
    const august = deferred<ReturnType<typeof makeResponse>>()
    vi.mocked(dayoffsList)
      .mockReturnValueOnce(july.promise)
      .mockReturnValueOnce(august.promise)

    const julyLoad = store.setMonth(new Date(2026, 6, 1))
    const augustLoad = store.setMonth(new Date(2026, 7, 1))
    august.resolve({
      employees: [{ id: 'user-2', displayName: 'Grace Hopper', avatarUrl: '' }],
      records: [makeRecord('august-dayoff', 'user-2')],
      yearTotals: [{ userId: 'user-2', vacationDays: 0, sickLeaveDays: 1, personalDays: 0 }],
    })
    await augustLoad
    july.resolve({
      employees: [{ id: 'user-1', displayName: 'Ada Lovelace', avatarUrl: '' }],
      records: [makeRecord('july-dayoff', 'user-1')],
      yearTotals: [{ userId: 'user-1', vacationDays: 4, sickLeaveDays: 0, personalDays: 0 }],
    })
    await julyLoad

    expect(store.records).toEqual([makeRecord('august-dayoff', 'user-2')])
    expect(store.employees.map(employee => employee.id)).toEqual(['user-2'])
    expect(store.yearTotals).toEqual([
      { userId: 'user-2', vacationDays: 0, sickLeaveDays: 1, personalDays: 0 },
    ])
    expect(store.loading).toBe(false)
  })

  it('uses owner/admin authorization only as a UI affordance', () => {
    const store = useDayoffsStore()
    const otherUsersRecord = makeRecord('dayoff-2', 'user-2')

    expect(store.canManage(otherUsersRecord, 'user-1', 'member')).toBe(false)
    expect(store.canManage(otherUsersRecord, 'user-2', 'member')).toBe(true)
    expect(store.canManage(otherUsersRecord, 'user-1', 'admin')).toBe(true)
    expect(store.canManage(otherUsersRecord, 'user-1', 'owner')).toBe(true)
  })
})
