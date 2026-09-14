import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  dayoffsCreate,
  dayoffsDelete,
  dayoffsList,
  dayoffsUpdate,
  type CreateDayoffInput,
  type Dayoff,
  type DayoffEmployee,
  type DayoffType,
  type DayoffYearTotal,
  type UpdateDayoffInput,
} from '@/services/http/dayoffsApi'
import { startOfMonth } from '@/utils/dayoffsCalendar'

export type {
  CreateDayoffInput,
  Dayoff,
  DayoffEmployee,
  DayoffType,
  DayoffYearTotal,
  UpdateDayoffInput,
} from '@/services/http/dayoffsApi'
export {
  DAYOFF_WEEKEND_DAYS,
  calendarDays,
  daysInMonth,
  isDayoffWeekend,
  isWeekend,
  monthBounds,
  rangeSegmentsForMonth,
} from '@/utils/dayoffsCalendar'

export function isDayoffManagerRole(role: string | null | undefined): boolean {
  return role === 'admin' || role === 'owner'
}

export function canManageDayoff(
  record: Dayoff,
  currentUserId: string | null | undefined,
  currentUserRole: string | null | undefined,
): boolean {
  return isDayoffManagerRole(currentUserRole) || record.userId === currentUserId
}

export const useDayoffsStore = defineStore('dayoffs', () => {
  const records = ref<Dayoff[]>([])
  const employees = ref<DayoffEmployee[]>([])
  const yearTotals = ref<DayoffYearTotal[]>([])
  const selectedMonth = ref(startOfMonth(new Date()))
  const selectedEmployeeId = ref<string | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const isSaving = ref(false)

  let loadRequestId = 0
  let savingRequestCount = 0

  const selectedEmployee = computed(() => (
    selectedEmployeeId.value === null
      ? null
      : employees.value.find(employee => employee.id === selectedEmployeeId.value) ?? null
  ))

  const visibleRecords = computed(() => (
    selectedEmployeeId.value === null
      ? records.value
      : records.value.filter(record => record.userId === selectedEmployeeId.value)
  ))

  const selectedEmployeeYearTotal = computed<DayoffYearTotal | null>(() => {
    const employeeId = selectedEmployeeId.value
    if (employeeId === null) return null
    return yearTotals.value.find(total => total.userId === employeeId) ?? {
      userId: employeeId,
      vacationDays: 0,
      sickLeaveDays: 0,
      personalDays: 0,
    }
  })

  function setSelectedEmployee(id: string | null): void {
    selectedEmployeeId.value = id
  }

  /**
   * Loads records for the selected local calendar month. A later request wins
   * so rapid month navigation cannot replace the calendar with stale data.
   */
  async function load(): Promise<void> {
    const month = startOfMonth(selectedMonth.value)
    const requestId = ++loadRequestId
    loading.value = true
    error.value = null

    try {
      const response = await dayoffsList(month.getFullYear(), month.getMonth() + 1)
      if (requestId !== loadRequestId) return

      employees.value = response.employees
      records.value = response.records
      yearTotals.value = response.yearTotals
      if (
        selectedEmployeeId.value !== null
        && !response.employees.some(employee => employee.id === selectedEmployeeId.value)
      ) {
        selectedEmployeeId.value = null
      }
    } catch (cause) {
      if (requestId !== loadRequestId) return
      error.value = cause instanceof Error ? cause.message : 'Failed to load dayoffs'
    } finally {
      if (requestId === loadRequestId) {
        loading.value = false
      }
    }
  }

  /** Selects a month and immediately refreshes its calendar data. */
  async function setMonth(month: Date): Promise<void> {
    selectedMonth.value = startOfMonth(month)
    await load()
  }

  async function mutate<T>(operation: () => Promise<T>): Promise<T> {
    savingRequestCount += 1
    isSaving.value = true
    error.value = null
    try {
      const result = await operation()
      // Reload from the server so all month intersections and employee data
      // stay authoritative after a create, update, or delete.
      await load()
      return result
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : 'Failed to save dayoff'
      throw cause
    } finally {
      savingRequestCount -= 1
      isSaving.value = savingRequestCount > 0
    }
  }

  async function create(input: CreateDayoffInput): Promise<Dayoff> {
    return mutate(() => dayoffsCreate(input))
  }

  async function update(id: string, input: UpdateDayoffInput): Promise<Dayoff> {
    return mutate(() => dayoffsUpdate(id, input))
  }

  async function remove(id: string): Promise<void> {
    await mutate(() => dayoffsDelete(id))
  }

  function clearError(): void {
    error.value = null
  }

  function reset(): void {
    loadRequestId += 1
    records.value = []
    employees.value = []
    yearTotals.value = []
    selectedEmployeeId.value = null
    loading.value = false
    error.value = null
    savingRequestCount = 0
    isSaving.value = false
  }

  return {
    records,
    employees,
    yearTotals,
    selectedMonth,
    selectedEmployeeId,
    selectedEmployee,
    selectedEmployeeYearTotal,
    visibleRecords,
    loading,
    error,
    isSaving,
    setSelectedEmployee,
    load,
    setMonth,
    create,
    update,
    remove,
    clearError,
    reset,
    canManage: canManageDayoff,
  }
})
