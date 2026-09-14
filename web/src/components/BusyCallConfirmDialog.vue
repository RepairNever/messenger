<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4"
      data-testid="busy-call-confirm-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="busy-call-confirm-title"
      @click.self="$emit('cancel')"
    >
      <div class="w-full max-w-md overflow-hidden rounded-lg border border-chat-border bg-chat-header text-app-text shadow-2xl">
        <div class="border-b border-chat-border px-4 py-3">
          <div id="busy-call-confirm-title" class="text-sm font-semibold text-app-text">
            Already in another call
          </div>
        </div>

        <div class="px-4 py-4 text-sm text-app-secondaryText">
          <p>{{ message }}</p>
          <div class="mt-3 rounded border border-chat-border bg-chat-input px-3 py-2 text-xs text-app-muted">
            {{ busyUserList }}
          </div>
        </div>

        <div class="flex justify-end gap-2 border-t border-chat-border px-4 py-3">
          <button
            class="rounded px-3 py-1.5 text-xs text-app-secondaryText hover:bg-chat-msgHover"
            data-testid="busy-call-confirm-cancel"
            type="button"
            @click="$emit('cancel')"
          >
            Cancel
          </button>
          <button
            class="rounded bg-accent px-3 py-1.5 text-xs text-app-onAccent hover:bg-accent-hover"
            data-testid="busy-call-confirm-confirm"
            type="button"
            @click="$emit('confirm')"
          >
            {{ confirmLabel }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  open: boolean
  userNames: string[]
  confirmLabel?: string
}>(), {
  confirmLabel: 'Continue',
})

defineEmits<{
  cancel: []
  confirm: []
}>()

const busyUserList = computed(() => props.userNames.join(', '))
const message = computed(() => {
  const count = props.userNames.length
  if (count === 1) {
    return `${props.userNames[0]} is already in another call. Send the invitation anyway?`
  }
  return `${count} selected users are already in another call. Send the invitations anyway?`
})
</script>
