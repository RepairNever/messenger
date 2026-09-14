<template>
  <div class="min-h-0 flex-1 overflow-auto" data-testid="dayoffs-timeline">
    <div class="w-max min-w-full" data-testid="dayoffs-calendar-grid">
      <div class="sticky top-0 z-20 flex border-b border-chat-border bg-chat-header">
        <div class="sticky left-0 z-30 flex w-56 shrink-0 items-center border-r border-chat-border bg-chat-header px-4 py-3 text-xs font-medium text-app-muted">
          Employee
        </div>
        <div
          v-for="day in days"
          :key="day.key"
          class="flex w-10 shrink-0 flex-col items-center border-r border-chat-border px-0.5 py-2 text-[10px]"
          :class="day.isWeekend ? 'bg-app-tertiary text-app-secondaryText' : 'text-app-secondaryText'"
          :data-testid="`dayoffs-header-${day.key}`"
        >
          <span class="uppercase">{{ day.weekdayLabel }}</span>
          <span
            class="mt-0.5 flex h-5 w-5 items-center justify-center rounded-full text-xs font-medium"
            :class="day.isToday ? 'bg-accent text-app-onAccent' : ''"
          >
            {{ day.dayNumber }}
          </span>
        </div>
      </div>

      <div v-for="employee in employees" :key="employee.id" class="flex min-h-16 border-b border-chat-border">
        <button
          type="button"
          class="sticky left-0 z-10 flex w-56 shrink-0 items-center gap-3 border-r border-chat-border bg-app-bg px-4 py-3 text-left transition-colors hover:bg-chat-msgHover focus:outline-none focus:ring-2 focus:ring-inset focus:ring-accent"
          :class="employee.id === selectedEmployeeId ? 'bg-chat-msgHover' : ''"
          :aria-label="`Show ${employee.displayName}'s dayoffs`"
          @click="$emit('selectEmployee', employee.id)"
        >
          <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-app-tertiary text-xs font-semibold text-app-secondaryText" aria-hidden="true">
            {{ initials(employee.displayName) }}
          </span>
          <span class="min-w-0">
            <span class="block truncate text-sm font-medium text-app-text">{{ employee.displayName }}</span>
            <span v-if="employee.role" class="block truncate text-xs text-app-muted">{{ employee.role }}</span>
          </span>
        </button>
        <div
          v-for="day in days"
          :key="day.key"
          class="relative w-10 shrink-0 border-r border-chat-border"
          :class="day.isWeekend ? 'bg-app-tertiary/80' : ''"
          :data-testid="`dayoffs-cell-${employee.id}-${day.key}`"
        >
          <template v-if="recordFor(employee.id, day.key) && !day.isWeekend">
            <div
              class="absolute inset-y-3 z-0"
              :class="barClass(recordFor(employee.id, day.key)!, day.dayNumber)"
              :style="dayoffTypePresentation(recordFor(employee.id, day.key)!.type).barStyle"
              :title="recordTitle(recordFor(employee.id, day.key)!)"
              role="img"
              :aria-label="recordTitle(recordFor(employee.id, day.key)!)"
            />
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { Dayoff, DayoffEmployee } from '@/stores/dayoffs'
import { rangeSegmentsForMonth, type DayoffRangeSegment } from '@/utils/dayoffsCalendar'
import {
  calendarDaysForMonth,
  recordForCalendarDay,
} from './calendar'
import { dayoffTypeLabel, dayoffTypePresentation } from './dayoffPresentation'

const props = defineProps<{
  employees: DayoffEmployee[]
  records: Dayoff[]
  month: Date
  selectedEmployeeId: string | null
}>()

defineEmits<{
  selectEmployee: [employeeId: string]
}>()

const days = computed(() => calendarDaysForMonth(props.month))
const rangeSegmentsByRecordId = computed(() => {
  const segments = new Map<string, DayoffRangeSegment[]>()
  for (const record of props.records) {
    segments.set(record.id, rangeSegmentsForMonth(record.startDate, record.endDate, props.month))
  }
  return segments
})

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  return parts.slice(0, 2).map(part => part[0]?.toUpperCase()).join('')
}

function recordFor(employeeId: string, dayKey: string): Dayoff | null {
  return recordForCalendarDay(props.records, employeeId, dayKey)
}

function barClass(record: Dayoff, dayNumber: number): string {
  const segment = rangeSegmentsByRecordId.value.get(record.id)
    ?.find(candidate => candidate.startDay <= dayNumber && candidate.endDay >= dayNumber)
  if (!segment) return 'left-1 right-1 rounded-md'
  const isStart = segment.startDay === dayNumber
  const isEnd = segment.endDay === dayNumber
  return [
    isStart ? 'left-1' : 'left-0',
    isEnd ? 'right-1' : 'right-0',
    isStart ? 'rounded-l-md' : '',
    isEnd ? 'rounded-r-md' : '',
  ].filter(Boolean).join(' ')
}

function recordTitle(record: Dayoff): string {
  const note = record.note?.trim()
  return `${dayoffTypeLabel(record.type)}: ${record.startDate} – ${record.endDate}${note ? ` — ${note}` : ''}`
}
</script>
