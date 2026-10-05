<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="dlg-overlay z-[90]"
      data-testid="busy-call-confirm-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="busy-call-confirm-title"
      @click.self="$emit('cancel')"
    >
      <div class="dlg-window" style="max-width: 420px;">
        <div class="dlg-head">
          <div id="busy-call-confirm-title" class="dlg-title">
            Already in another call
          </div>
        </div>

        <div class="px-4 pb-4 text-[13px] leading-relaxed">
          <p>{{ message }}</p>
          <div class="mt-3 rounded-lg border border-app-divider bg-app-input px-3 py-2 text-xs text-app-muted">
            {{ busyUserList }}
          </div>
        </div>

        <div class="dlg-foot-end">
          <button
            class="dlg-btn dlg-btn-ghost"
            data-testid="busy-call-confirm-cancel"
            type="button"
            @click="$emit('cancel')"
          >
            Cancel
          </button>
          <button
            class="dlg-btn dlg-btn-primary"
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
