<template>
  <div class="flex h-full overflow-hidden bg-chat-bg" data-testid="task-tracker">
    <ResizableSidebar
      v-if="!sidebarCollapsed"
      storage-key="msgnr:sidebar-width:task:v1"
      :default-width="240"
      :min-width="220"
      :max-width="520"
    >
      <TaskTrackerSidebar
        :model-value="modelValue"
        :current-view="currentView"
        @update:modelValue="emit('update:modelValue', $event)"
        @open-list="emit('openList')"
        @open-kanban="emit('openKanban')"
      />
    </ResizableSidebar>
    <main class="flex-1 min-w-0 overflow-hidden">
      <TaskCard
        v-if="viewMode === 'card'"
        :template-filter="modelValue"
        @back="emit('back')"
      />
      <!-- Keep the current list across cards; list and kanban share store state. -->
      <KeepAlive :max="1">
        <TaskKanbanView
          v-if="viewMode === 'kanban'"
          :template-filter="modelValue"
          @open-task="emit('openTask', $event)"
        />
        <TaskListView
          v-else-if="viewMode === 'list'"
          :template-filter="modelValue"
          @open-task="emit('openTask', $event)"
        />
      </KeepAlive>
    </main>
    <TaskCreateDialog :initial-template-id="modelValue" />
  </div>
</template>

<script setup lang="ts">
import ResizableSidebar from '@/components/ResizableSidebar.vue'
import TaskTrackerSidebar from '@/components/tasks/TaskTrackerSidebar.vue'
import TaskCard from '@/components/tasks/TaskCard.vue'
import TaskListView from '@/components/tasks/TaskListView.vue'
import TaskKanbanView from '@/components/tasks/TaskKanbanView.vue'
import TaskCreateDialog from '@/components/tasks/TaskCreateDialog.vue'

defineProps<{
  modelValue: string | null
  sidebarCollapsed: boolean
  currentView: 'tasks-list' | 'tasks-kanban'
  viewMode: 'list' | 'kanban' | 'card'
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string | null]
  openList: []
  openKanban: []
  openTask: [publicId: string]
  back: []
}>()
</script>
