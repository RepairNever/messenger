<template>
  <Transition name="pwa-banner">
    <div
      v-if="needRefresh || offlineReady"
      class="fixed bottom-4 left-1/2 z-[9000] -translate-x-1/2"
      role="alert"
      aria-live="polite"
    >
      <div
        class="flex items-center gap-3 rounded-lg border border-chat-border bg-chat-header/95 px-4 py-3 shadow-2xl backdrop-blur"
      >
        <!-- Icon -->
        <div class="shrink-0">
          <svg
            v-if="needRefresh"
            class="h-5 w-5 text-accent"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              fill-rule="evenodd"
              d="M15.312 11.424a5.5 5.5 0 0 1-9.201 2.466l-.312-.311V15.5a.75.75 0 0 1-1.5 0v-4.25a.75.75 0 0 1 .75-.75h4.25a.75.75 0 0 1 0 1.5H7.378l.313.312a4 4 0 0 0 6.693-1.794.75.75 0 1 1 1.428.45ZM4.688 8.576a5.5 5.5 0 0 1 9.201-2.466l.312.311V4.5a.75.75 0 0 1 1.5 0v4.25a.75.75 0 0 1-.75.75h-4.25a.75.75 0 0 1 0-1.5h1.921l-.312-.312a4 4 0 0 0-6.694 1.794.75.75 0 0 1-1.428-.45Z"
              clip-rule="evenodd"
            />
          </svg>
          <svg
            v-else
            class="h-5 w-5 text-green-400"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              fill-rule="evenodd"
              d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.857-9.809a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 1 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5Z"
              clip-rule="evenodd"
            />
          </svg>
        </div>

        <!-- Message -->
        <span class="text-sm text-gray-200">
          {{ needRefresh ? 'New version available' : 'Ready for offline use' }}
        </span>

        <!-- Actions -->
        <div class="flex items-center gap-2">
          <button
            v-if="needRefresh"
            class="rounded bg-accent px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-accent-hover"
            @click="updateServiceWorker(true)"
          >
            Update
          </button>
          <button
            class="rounded px-2 py-1 text-xs text-gray-400 transition-colors hover:text-gray-200"
            @click="close"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { watch, onBeforeUnmount } from 'vue'
import { usePwaUpdate } from '@/composables/usePwaUpdate'

const { needRefresh, offlineReady, updateServiceWorker, close } = usePwaUpdate()

// Auto-dismiss "offline ready" after 5 seconds.
// Track the timer so we can cancel it if the component unmounts first.
let autoCloseTimer: ReturnType<typeof setTimeout> | null = null

watch(offlineReady, (ready) => {
  if (ready) {
    autoCloseTimer = setTimeout(() => {
      autoCloseTimer = null
      if (offlineReady.value && !needRefresh.value) {
        close()
      }
    }, 5000)
  }
})

onBeforeUnmount(() => {
  if (autoCloseTimer) {
    clearTimeout(autoCloseTimer)
    autoCloseTimer = null
  }
})
</script>

<style scoped>
.pwa-banner-enter-active,
.pwa-banner-leave-active {
  transition: opacity 0.3s ease, transform 0.3s ease;
}

.pwa-banner-enter-from,
.pwa-banner-leave-to {
  opacity: 0;
  transform: translate(-50%, 1rem);
}
</style>
