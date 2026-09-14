<template>
  <div class="py-1">
    <div class="px-3 py-1 text-xs font-semibold text-gray-400 uppercase tracking-wider">Notifications</div>
    <button
      v-for="option in options"
      :key="option.level"
      class="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-left transition-colors"
      :class="option.level === modelValue
        ? 'text-white bg-white/10'
        : 'text-gray-300 hover:bg-white/5 hover:text-white'"
      @click="$emit('update:modelValue', option.level)"
    >
      <span class="w-4 h-4 shrink-0 flex items-center justify-center" v-html="option.icon" />
      <span class="flex-1">{{ option.label }}</span>
      <svg
        v-if="option.level === modelValue"
        class="w-4 h-4 shrink-0 text-green-400"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <polyline points="20 6 9 17 4 12" />
      </svg>
    </button>
  </div>
</template>

<script setup lang="ts">
import { NotificationLevel } from '@/shared/proto/packets_pb'

defineProps<{
  modelValue: NotificationLevel
}>()

defineEmits<{
  'update:modelValue': [level: NotificationLevel]
}>()

const bellIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>'
const atIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/></svg>'
const bellSlashIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5"/><path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'

const options = [
  { level: NotificationLevel.ALL, label: 'All messages', icon: bellIcon },
  { level: NotificationLevel.MENTIONS_ONLY, label: 'Mentions only', icon: atIcon },
  { level: NotificationLevel.NOTHING, label: 'Nothing', icon: bellSlashIcon },
]
</script>
