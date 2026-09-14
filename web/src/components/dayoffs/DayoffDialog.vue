<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-center justify-center bg-app-tertiary/80 p-4 backdrop-blur-sm"
      @click.self="close"
      @keydown.esc="close"
    >
      <form
        class="flex max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-xl border border-chat-border bg-chat-header shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dayoff-dialog-heading"
        @submit.prevent="submit"
      >
        <div class="flex items-center justify-between border-b border-chat-border px-5 py-4">
          <h2 id="dayoff-dialog-heading" class="text-base font-semibold text-app-text">
            {{ record ? 'Edit dayoff' : 'Add dayoff' }}
          </h2>
          <button
            type="button"
            class="rounded p-1 text-app-muted transition-colors hover:bg-chat-msgHover hover:text-app-text focus:outline-none focus:ring-2 focus:ring-accent"
            aria-label="Close dayoff form"
            :disabled="saving"
            @click="close"
          >
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div class="space-y-4 overflow-y-auto px-5 py-4">
          <label v-if="isElevated" class="block">
            <span class="mb-1 block text-sm text-app-muted">Employee</span>
            <select
              v-model="form.userId"
              class="form-control"
              data-testid="dayoffs-form-employee"
              :disabled="saving"
            >
              <option v-for="employee in employees" :key="employee.id" :value="employee.id">
                {{ employee.displayName }}
              </option>
            </select>
          </label>
          <p v-else class="rounded-md border border-chat-border bg-chat-input/50 px-3 py-2 text-sm text-app-secondaryText">
            This dayoff will be saved for you.
          </p>

          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label class="block">
              <span class="mb-1 block text-sm text-app-muted">Start date</span>
              <input
                v-model="form.startDate"
                type="date"
                class="form-control [color-scheme:light] dark:[color-scheme:dark]"
                data-testid="dayoffs-form-start-date"
                required
                autofocus
                :disabled="saving"
              >
            </label>
            <label class="block">
              <span class="mb-1 block text-sm text-app-muted">End date</span>
              <input
                v-model="form.endDate"
                type="date"
                class="form-control [color-scheme:light] dark:[color-scheme:dark]"
                data-testid="dayoffs-form-end-date"
                required
                :disabled="saving"
              >
            </label>
          </div>

          <fieldset>
            <legend class="mb-2 text-sm text-app-muted">Leave type</legend>
            <div class="grid grid-cols-3 gap-2">
              <button
                v-for="option in DAYOFF_TYPE_OPTIONS"
                :key="option.type"
                type="button"
                class="rounded-md border px-2 py-2 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-accent"
                :class="form.type === option.type ? '' : 'border-chat-border text-app-muted hover:bg-chat-msgHover hover:text-app-text'"
                :style="form.type === option.type ? option.style : undefined"
                :aria-pressed="form.type === option.type"
                :disabled="saving"
                @click="form.type = option.type"
              >
                {{ option.shortLabel }}
              </button>
            </div>
          </fieldset>

          <label class="block">
            <span class="mb-1 block text-sm text-app-muted">Note <span class="text-xs">(optional)</span></span>
            <textarea
              v-model="form.note"
              rows="3"
              maxlength="1000"
              class="form-control resize-y"
              data-testid="dayoffs-form-note"
              placeholder="Add a note"
              :disabled="saving"
            />
          </label>

          <p v-if="validationError || error" class="text-sm text-app-danger" role="alert">
            {{ validationError || error }}
          </p>
        </div>

        <div class="flex justify-end gap-2 border-t border-chat-border px-5 py-4">
          <button
            type="button"
            class="rounded-md px-3 py-2 text-sm text-app-secondaryText transition-colors hover:bg-chat-msgHover hover:text-app-text disabled:opacity-50"
            :disabled="saving"
            @click="close"
          >
            Cancel
          </button>
          <button
            type="submit"
            class="rounded-md bg-accent px-3 py-2 text-sm font-medium text-app-onAccent transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="dayoffs-form-submit"
            :disabled="Boolean(validationError) || saving"
          >
            {{ saving ? 'Saving...' : (record ? 'Save changes' : 'Add dayoff') }}
          </button>
        </div>
      </form>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import type { Dayoff, DayoffEmployee, DayoffType } from '@/stores/dayoffs'
import { DAYOFF_TYPE_OPTIONS } from './dayoffPresentation'

export interface DayoffFormValues {
  userId: string
  type: DayoffType
  startDate: string
  endDate: string
  note: string
}

const props = defineProps<{
  open: boolean
  record: Dayoff | null
  employees: DayoffEmployee[]
  selfUserId: string
  initialUserId: string
  isElevated: boolean
  saving: boolean
  error: string
}>()

const emit = defineEmits<{
  close: []
  submit: [values: DayoffFormValues]
}>()

const form = reactive<DayoffFormValues>({
  userId: '',
  type: 'vacation',
  startDate: '',
  endDate: '',
  note: '',
})

const validationError = computed(() => {
  if (!form.startDate || !form.endDate) return 'Choose a start and end date.'
  if (form.endDate < form.startDate) return 'The end date must be on or after the start date.'
  if (props.isElevated && !form.userId) return 'Choose an employee.'
  return ''
})

function resetForm() {
  const record = props.record
  form.userId = record?.userId ?? props.initialUserId ?? props.selfUserId
  form.type = record?.type ?? 'vacation'
  form.startDate = record?.startDate ?? ''
  form.endDate = record?.endDate ?? ''
  form.note = record?.note ?? ''
}

function close() {
  if (props.saving) return
  emit('close')
}

function submit() {
  if (validationError.value || props.saving) return
  emit('submit', {
    userId: props.isElevated ? form.userId : props.selfUserId,
    type: form.type,
    startDate: form.startDate,
    endDate: form.endDate,
    note: form.note.trim(),
  })
}

watch(
  () => [props.open, props.record?.id, props.initialUserId, props.selfUserId],
  ([open]) => {
    if (open) resetForm()
  },
  { immediate: true },
)
</script>

<style scoped>
.form-control {
  @apply w-full rounded-md border border-chat-border bg-chat-input px-3 py-2 text-sm text-app-text outline-none transition-colors placeholder:text-app-muted focus:border-accent focus:ring-1 focus:ring-accent disabled:cursor-not-allowed disabled:opacity-60;
}
</style>
