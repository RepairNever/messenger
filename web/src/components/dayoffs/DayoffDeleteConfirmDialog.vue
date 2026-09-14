<template>
  <Teleport to="body">
    <div
      v-if="open && record"
      class="fixed inset-0 z-50 flex items-center justify-center bg-app-tertiary/80 p-4 backdrop-blur-sm"
      @click.self="close"
      @keydown.esc="close"
    >
      <section
        class="w-full max-w-sm rounded-xl border border-chat-border bg-chat-header p-5 shadow-2xl"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="dayoff-delete-heading"
        aria-describedby="dayoff-delete-description"
      >
        <h2 id="dayoff-delete-heading" class="text-base font-semibold text-app-text">Delete dayoff?</h2>
        <p id="dayoff-delete-description" class="mt-2 text-sm text-app-secondaryText">
          {{ dayoffTypeLabel(record.type) }} from {{ formatDateRange(record) }} will be permanently removed.
        </p>
        <p v-if="error" class="mt-3 text-sm text-app-danger" role="alert">{{ error }}</p>
        <div class="mt-5 flex justify-end gap-2">
          <button
            type="button"
            class="rounded-md px-3 py-2 text-sm text-app-secondaryText transition-colors hover:bg-chat-msgHover hover:text-app-text disabled:opacity-50"
            :disabled="saving"
            autofocus
            @click="close"
          >
            Cancel
          </button>
          <button
            type="button"
            class="rounded-md bg-app-danger px-3 py-2 text-sm font-medium text-app-onAccent transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="dayoffs-delete-confirm"
            :disabled="saving"
            @click="$emit('confirm')"
          >
            {{ saving ? 'Deleting...' : 'Delete' }}
          </button>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import type { Dayoff } from '@/stores/dayoffs'
import { formatDateRange } from './calendar'
import { dayoffTypeLabel } from './dayoffPresentation'

const props = defineProps<{
  open: boolean
  record: Dayoff | null
  saving: boolean
  error: string
}>()

const emit = defineEmits<{
  close: []
  confirm: []
}>()

function close() {
  if (props.saving) return
  emit('close')
}
</script>
