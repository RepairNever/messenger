<template>
  <div class="flex flex-col h-full overflow-hidden">
    <TaskTrackerFilters
      :template-filter="templateFilter"
      :total="tasksStore.taskListTotal"
      :show-created-date-filter="!isGrouped"
      @filters-change="onFiltersChange"
    >
      <template #after-controls>
        <div class="view-mode-switch">
          <label class="view-mode-option" :class="viewMode === 'list' ? 'active' : ''">
            <input
              type="radio"
              class="sr-only"
              name="tasks-view-mode"
              :checked="viewMode === 'list'"
              @change="setViewMode('list')"
            />
            list
          </label>
          <label class="view-mode-option" :class="viewMode === 'grouped' ? 'active' : ''">
            <input
              type="radio"
              class="sr-only"
              name="tasks-view-mode"
              :checked="viewMode === 'grouped'"
              @change="setViewMode('grouped')"
            />
            group by status
          </label>
        </div>
      </template>
    </TaskTrackerFilters>

    <div v-if="tasksStore.taskListLoading && isEmptyForMode" class="flex-1 flex items-center justify-center text-gray-500 text-sm">
      Loading…
    </div>
    <div v-else-if="tasksStore.taskListError" class="flex-1 flex items-center justify-center text-red-400 text-sm">
      {{ tasksStore.taskListError }}
    </div>

    <div v-else class="flex-1 overflow-y-auto">
      <div
        v-if="isEmptyForMode"
        class="flex flex-col items-center justify-center h-full text-gray-500 text-sm gap-2"
      >
        <svg class="w-10 h-10 text-gray-600" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
          <rect x="4" y="4" width="16" height="16" rx="2" /><path d="M9 11h6M9 15h4" />
        </svg>
        <span>No tasks found</span>
        <button class="text-accent hover:underline text-xs mt-1" @click="tasksStore.openCreateDialog">Create a task</button>
      </div>

      <table v-else-if="!isGrouped" class="w-full text-sm">
        <thead class="sticky top-0 bg-chat-bg z-10">
          <tr class="border-b border-chat-border text-left">
            <th class="th w-28" @click="toggleSort('id')">ID <SortIcon field="id" :current="sortBy" :order="sortOrder" /></th>
            <th class="th" @click="toggleSort('title')">Title <SortIcon field="title" :current="sortBy" :order="sortOrder" /></th>
            <th class="th w-36" @click="toggleSort('status')">Status <SortIcon field="status" :current="sortBy" :order="sortOrder" /></th>
            <th class="th w-36" @click="toggleSort('created_at')">Created <SortIcon field="created_at" :current="sortBy" :order="sortOrder" /></th>
            <th class="th w-36" @click="toggleSort('updated_at')">Updated <SortIcon field="updated_at" :current="sortBy" :order="sortOrder" /></th>
          </tr>
        </thead>
        <tbody>
          <TaskRow
            v-for="item in tasksStore.taskList"
            :key="item.id"
            :item="item"
            :status-name="statusName(item.status_id)"
            @click="emit('openTask', item.public_id)"
          />
        </tbody>
      </table>

      <template v-else>
        <template v-for="group in groupedVisibleGroups" :key="group.status.id">
          <div class="px-6 py-2 border-b border-chat-border bg-chat-input/30 sticky top-0 z-10">
            <button
              class="w-full flex items-center justify-between text-left text-xs font-semibold text-gray-300 uppercase tracking-wider"
              @click="toggleStatusCollapsed(group.status.id)"
            >
              <span class="flex items-center gap-2">
                <svg
                  class="w-3 h-3 transition-transform"
                  :class="isStatusCollapsed(group.status.id) ? '-rotate-90' : ''"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.5"
                  viewBox="0 0 24 24"
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
                {{ group.status.name }}
                <span class="text-gray-500 font-normal normal-case">{{ group.total }}</span>
              </span>
            </button>
          </div>

          <table v-if="!isStatusCollapsed(group.status.id)" class="w-full text-sm">
            <tbody>
              <tr
                v-for="item in group.items"
                :key="item.public_id"
                class="border-b border-chat-border hover:bg-white/5 cursor-pointer transition-colors"
                @click="emit('openTask', item.public_id)"
              >
                <td class="px-4 py-2.5 shrink-0">
                  <span class="font-mono text-public_id bg-app-taskIdBg border border-public_id/20 px-1.5 py-0.5 rounded whitespace-nowrap">
                    {{ item.public_id }}
                  </span>
                </td>
                <td class="px-4 py-2.5 text-gray-100 max-w-0 w-full">
                  <span class="block truncate">{{ item.title }}</span>
                </td>
                <td class="px-4 py-2.5 text-gray-300">
                  <div class="flex items-center gap-2 min-w-0">
                    <UserAvatar
                      :user-id="item.created_by.id"
                      :display-name="creatorDisplayName(item)"
                      :avatar-url="item.created_by.avatar_url"
                      :custom-status="userCustomStatusFromDto(item.created_by.custom_status)"
                      size="xs"
                    />
                    <span class="truncate">{{ creatorDisplayName(item) }}</span>
                  </div>
                </td>
                <td class="px-4 py-2.5 text-gray-500 whitespace-nowrap text-xs">{{ formatDate(item.updated_at) }}</td>
              </tr>
            </tbody>
          </table>

          <div
            v-if="!isStatusCollapsed(group.status.id) && group.has_more"
            class="px-6 py-2 border-b border-chat-border"
          >
            <button
              class="text-xs text-accent hover:underline disabled:opacity-60 disabled:no-underline"
              :disabled="group.loading_more"
              @click="loadMoreForStatus(group.status.id)"
            >
              {{ group.loading_more ? 'Loading…' : 'show more…' }}
            </button>
          </div>

          <div
            v-if="!isStatusCollapsed(group.status.id) && group.load_more_error"
            class="px-6 pb-2 border-b border-chat-border text-xs text-red-400"
          >
            {{ group.load_more_error }}
          </div>
        </template>
      </template>
    </div>

    <div
      v-if="!isGrouped && totalPages > 1"
      class="shrink-0 flex items-center justify-center gap-1 px-6 py-3 border-t border-chat-border text-sm"
    >
      <button class="page-btn" :disabled="currentPage <= 1" @click="goToPage(currentPage - 1)">‹</button>
      <template v-for="p in pageRange" :key="p">
        <span v-if="p === '...'" class="px-2 text-gray-500">…</span>
        <button
          v-else
          class="page-btn"
          :class="p === currentPage ? 'bg-accent text-white border-accent' : ''"
          @click="goToPage(p as number)"
        >{{ p }}</button>
      </template>
      <button class="page-btn" :disabled="currentPage >= totalPages" @click="goToPage(currentPage + 1)">›</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useTasksStore } from '@/stores/tasks'
import type { SortBy, SortOrder, TaskFilterPayload, TaskGroupedItem, TaskListParams } from '@/services/http/tasksApi'
import TaskRow from './TaskRow.vue'
import SortIcon from './SortIcon.vue'
import UserAvatar from '@/components/UserAvatar.vue'
import { userCustomStatusFromDto } from '@/types/userStatus'
import TaskTrackerFilters from './TaskTrackerFilters.vue'
import {
  loadTaskListViewMode,
  saveTaskListViewMode,
  type TaskListViewMode,
} from '@/services/storage/taskListViewModeStorage'
import {
  loadCollapsedTaskStatusIds,
  saveCollapsedTaskStatusIds,
} from '@/services/storage/taskGroupCollapseStorage'

const props = defineProps<{ templateFilter: string | null }>()
const emit = defineEmits<{ openTask: [publicId: string] }>()

const tasksStore = useTasksStore()
const baseFilters = ref<TaskFilterPayload>({})

const sortBy = ref<SortBy>('updated_at')
const sortOrder = ref<SortOrder>('desc')

const viewMode = ref<TaskListViewMode>(loadTaskListViewMode())
const isGrouped = computed(() => viewMode.value === 'grouped')
const collapsedStatusIds = ref<string[]>(loadCollapsedTaskStatusIds())

const currentPage = computed(() => tasksStore.listParams.page ?? 1)
const pageSize = computed(() => tasksStore.listParams.page_size ?? 50)
const totalPages = computed(() => Math.max(1, Math.ceil(tasksStore.taskListTotal / pageSize.value)))

const groupedVisibleGroups = computed(() => {
  const out: Array<NonNullable<(typeof tasksStore.groupedTaskGroupsByStatus)[string]>> = []
  for (const statusId of tasksStore.groupedTaskStatusOrder) {
    const group = tasksStore.groupedTaskGroupsByStatus[statusId]
    if (group && group.total > 0) out.push(group)
  }
  return out
})

const isEmptyForMode = computed(() => (
  isGrouped.value
    ? groupedVisibleGroups.value.length === 0
    : tasksStore.taskList.length === 0
))

function statusName(id: string): string {
  return tasksStore.statusById(id)?.name ?? id
}

function creatorDisplayName(item: TaskGroupedItem): string {
  const displayName = item.created_by.display_name?.trim()
  return displayName !== '' ? displayName : 'Unknown user'
}

function isStatusCollapsed(statusId: string): boolean {
  return collapsedStatusIds.value.includes(statusId)
}

function toggleStatusCollapsed(statusId: string) {
  if (isStatusCollapsed(statusId)) {
    collapsedStatusIds.value = collapsedStatusIds.value.filter(id => id !== statusId)
  } else {
    collapsedStatusIds.value = [...collapsedStatusIds.value, statusId]
  }
  saveCollapsedTaskStatusIds(collapsedStatusIds.value)
}

function setViewMode(mode: TaskListViewMode) {
  if (mode === viewMode.value) return
  viewMode.value = mode
  saveTaskListViewMode(mode)
}

function onFiltersChange(payload: TaskFilterPayload) {
  baseFilters.value = payload
  applyParams()
}

function applyParams() {
  const commonParams = {
    ...baseFilters.value,
    page: 1,
  }

  if (isGrouped.value) {
    const { created_from: _createdFrom, created_to: _createdTo, ...groupedParams } = commonParams
    tasksStore.setListParams(groupedParams, 'grouped')
    return
  }

  tasksStore.setListParams({
    ...commonParams,
    sort_by: sortBy.value,
    sort_order: sortOrder.value,
  }, 'list')
}

function toggleSort(field: SortBy) {
  if (sortBy.value === field) {
    sortOrder.value = sortOrder.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortBy.value = field
    sortOrder.value = defaultSortOrderFor(field)
  }
  applyParams()
}

function defaultSortOrderFor(field: SortBy): SortOrder {
  return field === 'created_at' || field === 'updated_at' ? 'desc' : 'asc'
}

function goToPage(page: number) {
  tasksStore.loadTaskList({ page })
}

function loadMoreForStatus(statusId: string) {
  tasksStore.loadMoreGroupedStatus(statusId)
}

const pageRange = computed<(number | '...')[]>(() => {
  const total = totalPages.value
  const current = currentPage.value
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const pages: (number | '...')[] = [1]
  if (current > 3) pages.push('...')
  for (let p = Math.max(2, current - 1); p <= Math.min(total - 1, current + 1); p += 1) pages.push(p)
  if (current < total - 2) pages.push('...')
  pages.push(total)
  return pages
})

function formatDate(v: string): string {
  if (!v) return ''
  return new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}
</script>

<style scoped>
.th {
  @apply px-4 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wide cursor-pointer select-none hover:text-white transition-colors;
}
.page-btn {
  @apply w-8 h-8 flex items-center justify-center rounded border border-chat-border text-sm
         text-gray-300 hover:text-white hover:border-accent/40 transition-colors
         disabled:opacity-30 disabled:cursor-not-allowed;
}
.view-mode-switch {
  @apply inline-flex items-center rounded border border-chat-border overflow-hidden;
}
.view-mode-option {
  @apply px-2.5 py-1.5 text-xs text-gray-300 border-r border-chat-border last:border-r-0 cursor-pointer
         select-none transition-colors hover:text-white hover:bg-white/5;
}
.view-mode-option.active {
  @apply text-accent bg-accent/10;
}
</style>
