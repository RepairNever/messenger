<template>
  <section class="flex h-full min-h-0 min-w-0 bg-app-bg" data-testid="dayoffs-mode" aria-label="Dayoffs calendar">
    <aside v-if="!sidebarCollapsed" class="flex w-60 shrink-0 flex-col border-r border-chat-border bg-sidebar-bg max-sm:w-52" data-testid="dayoffs-sidebar">
      <div class="border-b border-chat-border px-4 py-4">
        <h1 class="text-base font-semibold text-app-text">Dayoffs</h1>
        <p class="mt-0.5 text-xs text-app-muted">Team availability calendar</p>
      </div>
      <div class="px-3 py-3">
        <button
          type="button"
          class="flex w-full items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-app-onAccent transition-colors hover:bg-accent-hover focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-sidebar-bg disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="dayoffs-add"
          :disabled="!selfUserId || dayoffsStore.isSaving"
          @click="openCreate()"
        >
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Add dayoff
        </button>
      </div>

      <DayoffsEmployeeSelector
        :employees="dayoffsStore.employees"
        :records="dayoffsStore.records"
        :selected-employee-id="dayoffsStore.selectedEmployeeId"
        :self-user-id="selfUserId"
        @select="selectEmployee"
      />

      <div class="space-y-2 border-t border-chat-border px-4 py-4">
        <p class="text-[11px] font-semibold uppercase tracking-wider text-app-muted">Leave types</p>
        <div v-for="option in DAYOFF_TYPE_OPTIONS" :key="option.type" class="flex items-center gap-2 text-xs text-app-secondaryText">
          <span class="h-2.5 w-2.5 rounded-sm" :style="option.barStyle" aria-hidden="true" />
          {{ option.label }}
        </div>
      </div>
    </aside>

    <div class="flex min-w-0 flex-1 flex-col">
      <header class="flex shrink-0 flex-wrap items-center gap-2 border-b border-chat-border bg-chat-header px-4 py-3 sm:px-5">
        <div class="flex items-center gap-1">
          <button
            type="button"
            class="rounded p-2 text-app-muted transition-colors hover:bg-chat-msgHover hover:text-app-text focus:outline-none focus:ring-2 focus:ring-accent"
            data-testid="dayoffs-month-previous"
            aria-label="Previous month"
            :disabled="dayoffsStore.loading"
            @click="changeMonth(-1)"
          >
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
          <h2 class="min-w-40 text-center text-sm font-semibold capitalize text-app-text" data-testid="dayoffs-month-label">
            {{ monthLabel(dayoffsStore.selectedMonth) }}
          </h2>
          <button
            type="button"
            class="rounded p-2 text-app-muted transition-colors hover:bg-chat-msgHover hover:text-app-text focus:outline-none focus:ring-2 focus:ring-accent"
            data-testid="dayoffs-month-next"
            aria-label="Next month"
            :disabled="dayoffsStore.loading"
            @click="changeMonth(1)"
          >
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="m9 18 6-6-6-6" />
            </svg>
          </button>
        </div>
        <p class="ml-auto text-xs text-app-muted">
          {{ displayedEmployees.length }} {{ displayedEmployees.length === 1 ? 'employee' : 'employees' }}
          <span v-if="dayoffsStore.loading" class="ml-2" role="status">Refreshing...</span>
        </p>
      </header>

      <div v-if="dayoffsStore.error && hasTimelineContent" class="flex shrink-0 items-center justify-between gap-3 border-b border-app-danger/40 bg-app-danger/10 px-5 py-2 text-sm text-app-danger" role="alert">
        <span>{{ dayoffsStore.error }}</span>
        <button
          type="button"
          class="shrink-0 rounded border border-current px-2 py-1 text-xs font-medium transition-colors hover:bg-app-danger/10 focus:outline-none focus:ring-2 focus:ring-accent"
          @click="reload"
        >
          Retry
        </button>
      </div>

      <div v-if="dayoffsStore.loading && !hasTimelineContent" class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center" role="status">
        <span class="h-7 w-7 animate-spin rounded-full border-2 border-app-muted border-t-accent" aria-hidden="true" />
        <p class="text-sm text-app-muted">Loading dayoffs calendar...</p>
      </div>
      <div v-else-if="dayoffsStore.error && !hasTimelineContent" class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <p class="text-sm text-app-danger" role="alert">{{ dayoffsStore.error }}</p>
        <button
          type="button"
          class="rounded-md bg-accent px-3 py-2 text-sm font-medium text-app-onAccent hover:bg-accent-hover focus:outline-none focus:ring-2 focus:ring-accent"
          @click="reload"
        >
          Retry
        </button>
      </div>
      <div v-else-if="!dayoffsStore.employees.length" class="flex min-h-0 flex-1 items-center justify-center px-6 text-center">
        <div>
          <h2 class="text-base font-semibold text-app-text">No active employees</h2>
          <p class="mt-1 text-sm text-app-muted">The shared calendar will appear when active employees are available.</p>
        </div>
      </div>
      <template v-else>
        <DayoffsTimeline
          :employees="displayedEmployees"
          :records="dayoffsStore.records"
          :month="dayoffsStore.selectedMonth"
          :selected-employee-id="dayoffsStore.selectedEmployeeId"
          @select-employee="selectEmployee"
        />
        <DayoffsRecordList
          :employee="dayoffsStore.selectedEmployee"
          :records="dayoffsStore.records"
          :year="dayoffsStore.selectedMonth.getFullYear()"
          :year-total="dayoffsStore.selectedEmployeeYearTotal"
          :self-user-id="selfUserId"
          :can-create-for-employee="canCreateForSelectedEmployee"
          :can-manage="canManage"
          @create="openCreateForSelected"
          @edit="openEdit"
          @delete="openDelete"
        />
      </template>
    </div>

    <DayoffDialog
      :open="dialogOpen"
      :record="editingRecord"
      :employees="dayoffsStore.employees"
      :self-user-id="selfUserId"
      :initial-user-id="dialogInitialUserId"
      :is-elevated="isElevated"
      :saving="dayoffsStore.isSaving"
      :error="dialogError"
      @close="closeDialog"
      @submit="saveDayoff"
    />
    <DayoffDeleteConfirmDialog
      :open="deleteDialogOpen"
      :record="deletingRecord"
      :saving="dayoffsStore.isSaving"
      :error="deleteError"
      @close="closeDeleteDialog"
      @confirm="deleteDayoff"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useChatStore } from '@/stores/chat'
import {
  isDayoffManagerRole,
  useDayoffsStore,
  type CreateDayoffInput,
  type Dayoff,
  type DayoffEmployee,
} from '@/stores/dayoffs'
import DayoffDeleteConfirmDialog from './DayoffDeleteConfirmDialog.vue'
import DayoffDialog, { type DayoffFormValues } from './DayoffDialog.vue'
import DayoffsEmployeeSelector from './DayoffsEmployeeSelector.vue'
import DayoffsRecordList from './DayoffsRecordList.vue'
import DayoffsTimeline from './DayoffsTimeline.vue'
import { monthLabel } from './calendar'
import { DAYOFF_TYPE_OPTIONS } from './dayoffPresentation'

const props = withDefaults(defineProps<{
  sidebarCollapsed?: boolean
}>(), {
  sidebarCollapsed: false,
})

const authStore = useAuthStore()
const chatStore = useChatStore()
const dayoffsStore = useDayoffsStore()

const dialogOpen = ref(false)
const editingRecord = ref<Dayoff | null>(null)
const dialogInitialUserId = ref('')
const dialogError = ref('')
const deleteDialogOpen = ref(false)
const deletingRecord = ref<Dayoff | null>(null)
const deleteError = ref('')

// A restored session can have a valid WS identity before its profile is
// hydrated. Reuse the authoritative bootstrap identity in that interval.
const selfUserId = computed(() => authStore.user?.id ?? chatStore.workspace?.selfUserId ?? '')
const currentRole = computed(() => authStore.effectiveRole ?? chatStore.workspace?.selfRole ?? '')
const isElevated = computed(() => isDayoffManagerRole(currentRole.value))
const hasTimelineContent = computed(() => dayoffsStore.employees.length > 0)
const displayedEmployees = computed<DayoffEmployee[]>(() => {
  const selected = dayoffsStore.selectedEmployee
  return selected ? [selected] : dayoffsStore.employees
})
const canCreateForSelectedEmployee = computed(() => {
  const selected = dayoffsStore.selectedEmployee
  if (!selected || !selfUserId.value) return false
  return isElevated.value || selected.id === selfUserId.value
})

onMounted(() => {
  void dayoffsStore.load()
})

function selectEmployee(employeeId: string | null) {
  dayoffsStore.setSelectedEmployee(employeeId)
}

async function changeMonth(direction: -1 | 1) {
  const current = dayoffsStore.selectedMonth
  await dayoffsStore.setMonth(new Date(current.getFullYear(), current.getMonth() + direction, 1))
}

async function reload() {
  await dayoffsStore.load()
}

function canManage(record: Dayoff): boolean {
  return dayoffsStore.canManage(record, selfUserId.value, currentRole.value)
}

function openCreate(targetUserId = selfUserId.value) {
  if (!selfUserId.value) return
  editingRecord.value = null
  dialogInitialUserId.value = isElevated.value ? targetUserId || selfUserId.value : selfUserId.value
  dialogError.value = ''
  dayoffsStore.clearError()
  dialogOpen.value = true
}

function openCreateForSelected() {
  const selected = dayoffsStore.selectedEmployee
  if (!selected || !canCreateForSelectedEmployee.value) return
  openCreate(selected.id)
}

function openEdit(record: Dayoff) {
  if (!canManage(record)) return
  editingRecord.value = record
  dialogInitialUserId.value = record.userId
  dialogError.value = ''
  dayoffsStore.clearError()
  dialogOpen.value = true
}

function closeDialog() {
  if (dayoffsStore.isSaving) return
  dialogOpen.value = false
  editingRecord.value = null
  dialogError.value = ''
}

function dayoffInputFrom(values: DayoffFormValues): CreateDayoffInput {
  return {
    ...(isElevated.value ? { userId: values.userId } : {}),
    type: values.type,
    startDate: values.startDate,
    endDate: values.endDate,
    note: values.note || null,
  }
}

async function saveDayoff(values: DayoffFormValues) {
  if (dayoffsStore.isSaving) return
  dialogError.value = ''
  try {
    const input = dayoffInputFrom(values)
    if (editingRecord.value) {
      await dayoffsStore.update(editingRecord.value.id, input)
    } else {
      await dayoffsStore.create(input)
    }
    closeDialog()
  } catch (error) {
    dialogError.value = error instanceof Error ? error.message : 'Unable to save the dayoff.'
  }
}

function openDelete(record: Dayoff) {
  if (!canManage(record)) return
  deletingRecord.value = record
  deleteError.value = ''
  dayoffsStore.clearError()
  deleteDialogOpen.value = true
}

function closeDeleteDialog() {
  if (dayoffsStore.isSaving) return
  deleteDialogOpen.value = false
  deletingRecord.value = null
  deleteError.value = ''
}

async function deleteDayoff() {
  const record = deletingRecord.value
  if (!record || !canManage(record) || dayoffsStore.isSaving) return
  deleteError.value = ''
  try {
    await dayoffsStore.remove(record.id)
    closeDeleteDialog()
  } catch (error) {
    deleteError.value = error instanceof Error ? error.message : 'Unable to delete the dayoff.'
  }
}
</script>
