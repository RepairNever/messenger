<template>
  <div class="flex h-full flex-col overflow-hidden">
    <TaskTrackerFilters
      :template-filter="templateFilter"
      :total="tasksStore.taskListTotal"
      @filters-change="onFiltersChange"
    />

    <div v-if="tasksStore.taskListLoading && orderedColumns.length === 0" class="flex flex-1 items-center justify-center text-sm text-gray-500">
      Loading…
    </div>
    <div v-else-if="tasksStore.taskListError" class="flex flex-1 items-center justify-center text-sm text-red-400">
      {{ tasksStore.taskListError }}
    </div>
    <div v-else class="flex-1 overflow-auto px-4 py-3">
      <div class="kanban-board">
        <section
          v-for="column in orderedColumns"
          :key="column.statusId"
          class="kanban-column"
          :class="dropTargetStatusId === column.statusId ? 'kanban-column-drop' : ''"
          :data-testid="`kanban-column-${column.statusId}`"
          @dragover.prevent="onColumnDragOver(column.statusId)"
          @drop.prevent="onColumnDrop(column.statusId)"
          @dragleave="onColumnDragLeave(column.statusId)"
        >
          <header class="kanban-column-header">
            <span class="truncate">{{ column.group.status.name }}</span>
            <span class="kanban-count">{{ column.group.total }}</span>
          </header>

          <div class="kanban-cards">
            <button
              v-for="item in column.group.items"
              :key="item.id"
              type="button"
              class="kanban-card"
              :data-testid="`kanban-card-${item.id}`"
              draggable="true"
              @dragstart="onCardDragStart(item.id, column.statusId, $event)"
              @dragend="onCardDragEnd"
              @click="emit('openTask', item.public_id)"
            >
              <div class="kanban-card-id">{{ item.public_id }}</div>
              <div class="kanban-card-title text-app-text">{{ item.title }}</div>
              <div class="kanban-card-description">{{ item.description_preview }}</div>
            </button>

            <div v-if="column.group.items.length === 0" class="kanban-empty">
              No tasks
            </div>
          </div>

          <div v-if="column.group.has_more" class="kanban-more">
            <button
              type="button"
              class="text-xs text-accent hover:underline disabled:opacity-60 disabled:no-underline"
              :disabled="column.group.loading_more"
              @click="tasksStore.loadMoreGroupedStatus(column.statusId)"
            >
              {{ column.group.loading_more ? 'Loading…' : 'show more' }}
            </button>
          </div>

          <div v-if="column.group.load_more_error" class="px-3 pb-3 text-xs text-red-400">
            {{ column.group.load_more_error }}
          </div>
        </section>
      </div>

      <div v-if="moveError" class="mt-3 px-2 text-xs text-red-400">
        {{ moveError }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import type { TaskFilterPayload } from '@/services/http/tasksApi'
import { useTasksStore } from '@/stores/tasks'
import { useChatStore } from '@/stores/chat'
import TaskTrackerFilters from './TaskTrackerFilters.vue'

defineProps<{ templateFilter: string | null }>()
const emit = defineEmits<{ openTask: [publicId: string] }>()

const tasksStore = useTasksStore()
const chatStore = useChatStore()

const baseFilters = ref<TaskFilterPayload>({})
const draggingTaskId = ref('')
const draggingFromStatusId = ref('')
const dropTargetStatusId = ref('')
const moveError = ref('')
const movingTaskIds = new Set<string>()

let groupedReloadTimer: ReturnType<typeof setTimeout> | null = null
const unsubTaskStatusChanged = chatStore.onTaskStatusChanged((evt) => {
  tasksStore.applyTaskStatusChangedToGrouped(evt.taskId, evt.toStatusId)
  scheduleGroupedReload()
})

const orderedColumns = computed(() => {
  return tasksStore.groupedTaskStatusOrder
    .map((statusId) => {
      const group = tasksStore.groupedTaskGroupsByStatus[statusId]
      if (!group) return null
      return { statusId, group }
    })
    .filter((value): value is { statusId: string; group: NonNullable<(typeof tasksStore.groupedTaskGroupsByStatus)[string]> } => value !== null)
})

function onFiltersChange(payload: TaskFilterPayload) {
  baseFilters.value = payload
  tasksStore.setListParams({ ...payload, page: 1 }, 'grouped')
}

function onCardDragStart(taskId: string, fromStatusId: string, event: DragEvent) {
  if (movingTaskIds.has(taskId)) {
    event.preventDefault()
    return
  }
  draggingTaskId.value = taskId
  draggingFromStatusId.value = fromStatusId
  moveError.value = ''
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', taskId)
  }
}

function onCardDragEnd() {
  clearDragState()
}

function onColumnDragOver(statusId: string) {
  if (!draggingTaskId.value || statusId === draggingFromStatusId.value) {
    dropTargetStatusId.value = ''
    return
  }
  dropTargetStatusId.value = statusId
}

function onColumnDragLeave(statusId: string) {
  if (dropTargetStatusId.value === statusId) {
    dropTargetStatusId.value = ''
  }
}

async function onColumnDrop(toStatusId: string) {
  const taskId = draggingTaskId.value
  const fromStatusId = draggingFromStatusId.value
  clearDragState()
  if (!taskId || !fromStatusId || toStatusId === fromStatusId || movingTaskIds.has(taskId)) return

  const rollback = tasksStore.optimisticMoveGroupedTaskCard(taskId, toStatusId)
  if (!rollback) return

  movingTaskIds.add(taskId)
  moveError.value = ''
  try {
    await tasksStore.updateTaskStatus(taskId, toStatusId)
    scheduleGroupedReload()
  } catch (e) {
    rollback()
    moveError.value = e instanceof Error ? e.message : 'Failed to move task'
  } finally {
    movingTaskIds.delete(taskId)
  }
}

function scheduleGroupedReload() {
  if (groupedReloadTimer) clearTimeout(groupedReloadTimer)
  groupedReloadTimer = setTimeout(() => {
    groupedReloadTimer = null
    // Intentionally reuse the store's remembered grouped params so realtime
    // refresh keeps the current filters, including the show-subtasks toggle.
    void tasksStore.loadGroupedTaskList(undefined, tasksStore.groupedTaskPortionLimit)
  }, 350)
}

function clearDragState() {
  draggingTaskId.value = ''
  draggingFromStatusId.value = ''
  dropTargetStatusId.value = ''
}

onBeforeUnmount(() => {
  unsubTaskStatusChanged()
  if (groupedReloadTimer) clearTimeout(groupedReloadTimer)
})
</script>

<style scoped>
.kanban-board {
  @apply flex h-full min-h-[240px] gap-3;
}

.kanban-column {
  @apply flex min-w-[364px] max-w-[468px] flex-1 flex-col rounded-lg border border-chat-border bg-chat-input/30;
}

.kanban-column-drop {
  @apply border-accent/70 bg-accent/10;
}

.kanban-column-header {
  @apply flex items-center justify-between gap-2 border-b border-chat-border px-3 py-2 text-sm font-semibold text-app-text;
}

.kanban-count {
  @apply rounded bg-chat-bg px-2 py-0.5 text-xs text-app-muted;
}

.kanban-cards {
  @apply flex flex-1 flex-col gap-2 overflow-y-auto p-2;
}

.kanban-card {
  @apply w-full rounded border border-chat-border bg-chat-bg px-3 py-2 text-left transition-colors hover:border-accent/40 hover:bg-white/5;
}

.kanban-card-id {
  @apply inline-block rounded border border-public_id/20 bg-app-taskIdBg px-1.5 py-0.5 font-mono text-public_id;
}

.kanban-card-title {
  @apply mt-1 whitespace-normal break-words text-sm font-medium text-app-text;
}

.kanban-card-description {
  @apply mt-1 text-xs leading-5 text-app-muted;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.kanban-empty {
  @apply rounded border border-dashed border-chat-border p-3 text-center text-xs text-app-muted;
}

.kanban-more {
  @apply border-t border-chat-border px-3 py-2;
}
</style>
