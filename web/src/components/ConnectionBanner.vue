<template>
  <Transition
    enter-active-class="transition-all duration-200 ease-out"
    enter-from-class="-translate-y-full opacity-0"
    enter-to-class="translate-y-0 opacity-100"
    leave-active-class="transition-all duration-150 ease-in"
    leave-from-class="translate-y-0 opacity-100"
    leave-to-class="-translate-y-full opacity-0"
  >
    <div
      v-if="showBanner"
      class="flex items-center gap-3 px-4 py-2 bg-amber-900/60 border-b border-amber-700/50 text-amber-200 text-sm shrink-0 overflow-hidden"
      role="status"
      aria-live="polite"
    >
      <!-- Spinner -->
      <svg
        class="h-3.5 w-3.5 shrink-0 animate-spin text-amber-300"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <circle class="opacity-25" cx="12" cy="12" r="9" stroke="currentColor" stroke-width="3" />
        <path
          class="opacity-90"
          d="M21 12a9 9 0 0 0-9-9"
          stroke="currentColor"
          stroke-width="3"
          stroke-linecap="round"
        />
      </svg>

      <!-- Message -->
      <span class="flex-1 truncate">
        {{ statusText }}
        <span v-if="showReconnectAttempt" class="text-amber-400/80">
          (attempt {{ reconnectAttempt }})
        </span>
        <span v-if="queueLength > 0" class="ml-1 text-amber-300">
          · {{ queueLength }} message{{ queueLength === 1 ? '' : 's' }} queued
        </span>
      </span>

      <!-- Reconnect now button -->
      <button
        data-testid="connection-banner-retry"
        class="shrink-0 rounded border border-amber-500/50 px-2.5 py-0.5 text-xs font-medium text-amber-200 hover:bg-amber-700/40 hover:text-white transition-colors"
        @click="emit('reconnect-now')"
      >
        Retry now
      </button>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  isReconnecting: boolean
  reconnectAttempt: number
  queueLength: number
  isAuthDegraded?: boolean
}>()

const emit = defineEmits<{ 'reconnect-now': [] }>()

const showBanner = computed(() => props.isReconnecting || props.isAuthDegraded === true)
const showReconnectAttempt = computed(() => (
  props.isAuthDegraded !== true && props.isReconnecting && props.reconnectAttempt > 0
))
const statusText = computed(() => (
  props.isAuthDegraded
    ? 'Session unavailable - retrying'
    : 'Disconnected - reconnecting'
))
</script>
