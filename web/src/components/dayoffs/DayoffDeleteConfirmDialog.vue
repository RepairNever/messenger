<template>
  <Teleport to="body">
    <div
      v-if="open && record"
      class="dlg-overlay z-50"
      @click.self="close"
      @keydown.esc="close"
    >
      <section
        class="dlg-window max-w-sm p-5"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="dayoff-delete-heading"
        aria-describedby="dayoff-delete-description"
      >
        <h2 id="dayoff-delete-heading" class="dlg-title">Delete dayoff?</h2>
        <p id="dayoff-delete-description" class="mt-2 text-sm text-app-secondaryText">
          {{ dayoffTypeLabel(record.type) }} from {{ formatDateRange(record) }} will be permanently removed.
        </p>
        <p v-if="error" class="mt-3 text-sm text-app-danger" role="alert">{{ error }}</p>
        <div class="mt-5 flex justify-end gap-2">
          <button
            type="button"
            class="dlg-btn dlg-btn-ghost"
            :disabled="saving"
            autofocus
            @click="close"
          >
            Cancel
          </button>
          <button
            type="button"
            class="dlg-btn dlg-btn-danger"
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
