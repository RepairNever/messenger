<template>
  <tr
    class="border-b border-chat-border hover:bg-white/5 cursor-pointer transition-colors"
    @click="emit('click')"
  >
    <td class="px-4 py-2.5 shrink-0">
      <span class="font-mono text-public_id bg-app-taskIdBg border border-public_id/20 px-1.5 py-0.5 rounded whitespace-nowrap">
        {{ item.public_id }}
      </span>
    </td>
    <td class="px-4 py-2.5 text-gray-100 max-w-0 w-full">
      <span class="block truncate">{{ item.title }}</span>
    </td>
    <td class="px-4 py-2.5 text-gray-300 whitespace-nowrap">{{ statusName }}</td>
    <td class="px-4 py-2.5 text-gray-500 whitespace-nowrap text-xs">{{ formatDate(item.created_at) }}</td>
    <td class="px-4 py-2.5 text-gray-500 whitespace-nowrap text-xs">{{ formatDate(item.updated_at) }}</td>
  </tr>
</template>

<script setup lang="ts">
import type { TaskListItem } from '@/services/http/tasksApi'

defineProps<{
  item: TaskListItem
  statusName: string
}>()

const emit = defineEmits<{ click: [] }>()

function formatDate(v: string): string {
  if (!v) return ''
  return new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}
</script>
