<template>
  <span class="inline-block ml-0.5" :class="isActive ? 'text-accent' : 'text-gray-600'">
    <svg class="inline w-3 h-3" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
      <path d="M12 19V5M5 12l7-7 7 7" :opacity="isActive && order === 'asc' ? 1 : 0.35" />
      <path d="M12 5v14M5 12l7 7 7-7" :opacity="isActive && order === 'desc' ? 1 : 0.35" />
    </svg>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { SortBy, SortOrder } from '@/services/http/tasksApi'

const props = defineProps<{
  field: SortBy
  current: SortBy
  order: SortOrder
}>()

const isActive = computed(() => props.field === props.current)
</script>
