<template>
  <div class="relative mx-1 group">
    <button
      class="flex min-h-9 items-center gap-2 px-3 py-1 w-full text-left text-[15px] transition-colors rounded"
      :class="active
        ? 'bg-sidebar-active text-white'
        : (hasUnread && !muted ? 'text-sidebar-text hover:bg-sidebar-hover' : 'text-sidebar-textMuted hover:bg-sidebar-hover')"
      v-bind="$attrs"
    >
      <span class="shrink-0 w-8 flex items-center justify-center">
        <slot name="icon" />
      </span>
      <span class="truncate flex-1" :class="[
        hasUnread && !muted ? 'font-semibold text-white' : 'font-normal text-sidebar-text',
      ]">
        <slot />
      </span>
      <!-- Muted indicator (bell-slash icon) -->
      <span
        v-if="muted"
        class="shrink-0 w-4 h-4 text-sidebar-textMuted opacity-60"
        title="Notifications muted"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4">
          <path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5"/>
          <path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7"/>
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>
          <line x1="1" y1="1" x2="23" y2="23"/>
        </svg>
      </span>
      <!-- Unread badge (suppressed when muted) -->
      <span
        v-else-if="(unread ?? 0) > 0"
        class="shrink-0 min-w-[18px] h-[18px] text-[11px] font-bold rounded-full bg-red-500 text-sidebar-unreadBadge flex items-center justify-center px-1"
      >
        {{ unread }}
      </span>
    </button>
    <div class="absolute right-7 top-1/2 -translate-y-1/2 z-30">
      <slot name="actions" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  active?: boolean
  unread?: number
  muted?: boolean
}>()

const hasUnread = computed(() => (props.unread ?? 0) > 0)
</script>
