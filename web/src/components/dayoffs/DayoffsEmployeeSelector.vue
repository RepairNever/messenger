<template>
  <nav class="min-h-0 flex-1 overflow-y-auto px-2 py-3" aria-label="Employees">
    <p class="px-2 pb-2 text-[11px] font-semibold uppercase tracking-wider text-app-muted">Employees</p>
    <button
      type="button"
      data-testid="dayoffs-employee-all"
      class="mb-1 flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-accent"
      :class="selectedEmployeeId === null
        ? 'theme-selection'
        : 'text-app-secondaryText hover:bg-chat-msgHover hover:text-app-text'"
      :aria-pressed="selectedEmployeeId === null"
      @click="$emit('select', null)"
    >
      <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-app-tertiary text-app-secondaryText" aria-hidden="true">
        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="4" y="5" width="16" height="14" rx="2" />
          <path d="M8 3v4M16 3v4M4 10h16" />
        </svg>
      </span>
      <span class="truncate">All employees</span>
      <span class="ml-auto text-xs opacity-70">{{ employees.length }}</span>
    </button>

    <button
      v-for="employee in employees"
      :key="employee.id"
      type="button"
      :data-testid="`dayoffs-employee-${employee.id}`"
      class="mb-1 flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-accent"
      :class="selectedEmployeeId === employee.id
        ? 'theme-selection'
        : 'text-app-secondaryText hover:bg-chat-msgHover hover:text-app-text'"
      :aria-pressed="selectedEmployeeId === employee.id"
      @click="$emit('select', employee.id)"
    >
      <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-app-tertiary text-[10px] font-semibold text-app-secondaryText" aria-hidden="true">
        {{ initials(employee.displayName) }}
      </span>
      <span class="min-w-0 flex-1 truncate">
        {{ employee.displayName }}
        <span v-if="employee.id === selfUserId" class="ml-1 text-xs opacity-70">(you)</span>
      </span>
      <span
        v-if="recordCount(employee.id) > 0"
        class="rounded-full bg-app-tertiary px-1.5 py-0.5 text-[11px] text-app-muted"
        :aria-label="`${recordCount(employee.id)} dayoff records`"
      >
        {{ recordCount(employee.id) }}
      </span>
    </button>
  </nav>
</template>

<script setup lang="ts">
import type { Dayoff, DayoffEmployee } from '@/stores/dayoffs'

const props = defineProps<{
  employees: DayoffEmployee[]
  records: Dayoff[]
  selectedEmployeeId: string | null
  selfUserId: string
}>()

defineEmits<{
  select: [employeeId: string | null]
}>()

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  return parts.slice(0, 2).map(part => part[0]?.toUpperCase()).join('')
}

function recordCount(employeeId: string): number {
  return props.records.filter(record => record.userId === employeeId).length
}
</script>
