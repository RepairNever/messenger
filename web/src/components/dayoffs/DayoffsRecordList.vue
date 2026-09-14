<template>
  <section class="border-t border-chat-border bg-chat-header px-5 py-4" data-testid="dayoffs-record-list">
    <template v-if="employee">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 class="text-sm font-semibold text-app-text">
            {{ employee.id === selfUserId ? 'My dayoffs' : `${employee.displayName}'s dayoffs` }}
          </h2>
          <p class="mt-0.5 text-xs text-app-muted">Records that overlap the selected month</p>
        </div>
        <button
          v-if="canCreateForEmployee"
          type="button"
          class="rounded-md border border-accent/60 px-3 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent hover:text-app-onAccent focus:outline-none focus:ring-2 focus:ring-accent"
          data-testid="dayoffs-add-selected"
          @click="$emit('create')"
        >
          Add dayoff
        </button>
      </div>

      <section
        class="mb-4 rounded-lg border border-chat-border bg-app-bg/30 px-3 py-3"
        data-testid="dayoffs-year-summary"
        :aria-label="`${year} dayoff totals for ${employee.displayName}`"
      >
        <div class="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 class="text-xs font-semibold uppercase tracking-wider text-app-secondaryText">{{ year }} totals</h3>
          <p class="text-xs text-app-muted">{{ totalDays }} {{ totalDays === 1 ? 'day' : 'days' }} used</p>
        </div>
        <div class="grid gap-2 sm:grid-cols-3">
          <div
            v-for="option in DAYOFF_TYPE_OPTIONS"
            :key="option.type"
            class="flex items-center justify-between gap-2 rounded-md border px-2.5 py-2 text-xs"
            :data-testid="`dayoffs-year-summary-${option.type}`"
            :style="option.style"
          >
            <span class="flex items-center gap-1.5">
              <span class="h-2 w-2 rounded-full" :style="option.barStyle" aria-hidden="true" />
              {{ option.label }}
            </span>
            <strong>{{ daysLabel(totalForType(option.type)) }}</strong>
          </div>
        </div>
      </section>

      <div v-if="employeeRecords.length" class="space-y-2">
        <article
          v-for="record in employeeRecords"
          :key="record.id"
          class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2"
          :style="dayoffTypePresentation(record.type).style"
        >
          <span class="text-xs font-semibold">{{ dayoffTypeLabel(record.type) }}</span>
          <span class="text-xs opacity-90">{{ formatDateRange(record) }}</span>
          <span v-if="record.note" class="min-w-0 flex-1 truncate text-xs opacity-80">{{ record.note }}</span>
          <span v-else class="flex-1" aria-hidden="true" />
          <div v-if="canManage(record)" class="ml-auto flex items-center gap-1">
            <button
              type="button"
              class="rounded p-1 text-current transition-colors hover:bg-app-bg/20 focus:outline-none focus:ring-2 focus:ring-accent"
              :data-testid="`dayoffs-edit-${record.id}`"
              :aria-label="`Edit ${dayoffTypeLabel(record.type)} record`"
              @click="$emit('edit', record)"
            >
              <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
              </svg>
            </button>
            <button
              type="button"
              class="rounded p-1 text-current transition-colors hover:bg-app-bg/20 focus:outline-none focus:ring-2 focus:ring-accent"
              :data-testid="`dayoffs-delete-${record.id}`"
              :aria-label="`Delete ${dayoffTypeLabel(record.type)} record`"
              @click="$emit('delete', record)"
            >
              <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M4 7h16M10 11v5M14 11v5M6 7l1 13h10l1-13M9 7V4h6v3" />
              </svg>
            </button>
          </div>
        </article>
      </div>
      <p v-else class="rounded-lg border border-dashed border-chat-border px-3 py-4 text-sm text-app-muted">
        No dayoffs for {{ employee.displayName }} this month.
      </p>
    </template>
    <p v-else class="text-sm text-app-muted">Select an employee to review their dayoffs.</p>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { Dayoff, DayoffEmployee, DayoffType, DayoffYearTotal } from '@/stores/dayoffs'
import { formatDateRange } from './calendar'
import {
  DAYOFF_TYPE_OPTIONS,
  dayoffTypeLabel,
  dayoffTypePresentation,
} from './dayoffPresentation'

const props = defineProps<{
  employee: DayoffEmployee | null
  records: Dayoff[]
  year: number
  yearTotal: DayoffYearTotal | null
  selfUserId: string
  canCreateForEmployee: boolean
  canManage: (record: Dayoff) => boolean
}>()

defineEmits<{
  create: []
  edit: [record: Dayoff]
  delete: [record: Dayoff]
}>()

const employeeRecords = computed(() => {
  if (!props.employee) return []
  return props.records
    .filter(record => record.userId === props.employee?.id)
    .slice()
    .sort((left, right) => left.startDate.localeCompare(right.startDate) || left.endDate.localeCompare(right.endDate))
})

const totalDays = computed(() => (
  (props.yearTotal?.vacationDays ?? 0)
  + (props.yearTotal?.sickLeaveDays ?? 0)
  + (props.yearTotal?.personalDays ?? 0)
))

function totalForType(type: DayoffType): number {
  switch (type) {
    case 'vacation':
      return props.yearTotal?.vacationDays ?? 0
    case 'sick_leave':
      return props.yearTotal?.sickLeaveDays ?? 0
    case 'personal_day':
      return props.yearTotal?.personalDays ?? 0
  }
}

function daysLabel(value: number): string {
  return `${value} ${value === 1 ? 'day' : 'days'}`
}
</script>
