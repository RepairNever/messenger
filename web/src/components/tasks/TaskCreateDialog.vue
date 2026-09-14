<template>
  <Teleport to="body">
    <div
      v-if="tasksStore.createDialogOpen"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div class="w-[80vw] max-w-[80vw] rounded-xl border border-chat-border bg-chat-header shadow-2xl flex flex-col max-h-[90vh]">
        <!-- Header -->
        <div class="flex items-center justify-between px-6 py-4 border-b border-chat-border shrink-0">
          <h2 class="text-base font-semibold text-app-text">New task</h2>
          <button
            class="text-app-muted hover:text-app-text transition-colors"
            aria-label="Close"
            @click="close"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path d="M18 6 6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <!-- Body -->
        <div class="overflow-y-auto px-6 py-4 space-y-4">
          <div v-if="tasksStore.configError" class="text-red-400 text-sm">
            {{ tasksStore.configError }}
          </div>

          <div v-else-if="tasksStore.configLoading" class="text-app-muted text-sm">
            Loading...
          </div>

          <div v-else-if="tasksStore.activeTemplates.length === 0" class="text-app-muted text-sm">
            No active templates. Ask an administrator to create one.
          </div>

          <template v-else>
            <!-- Template selector -->
            <div>
              <label class="form-label">Template</label>
              <div class="flex gap-2 flex-wrap">
                <button
                  v-for="tpl in tasksStore.activeTemplates"
                  :key="tpl.id"
                  type="button"
                  class="px-3 py-1 rounded text-sm border transition-colors"
                  :class="selectedTemplateId === tpl.id
                    ? 'bg-accent border-accent text-app-onAccent'
                    : 'border-chat-border text-app-secondaryText hover:border-accent/60 hover:text-app-text'"
                  @click="selectTemplate(tpl.id)"
                >
                  {{ tpl.prefix }}
                </button>
              </div>
            </div>

            <!-- System fields -->
            <div>
              <label class="form-label">Title <span class="text-red-400">*</span></label>
              <input
                v-model="form.title"
                type="text"
                class="form-input"
                placeholder="Task title"
                autofocus
              />
            </div>

            <div>
              <label class="form-label">Description</label>
              <TaskDescriptionEditor
                v-model="form.description"
                :task-staged-attachment-upload="uploadTaskStagedAttachments"
                placeholder="Optional description"
              />
            </div>

            <div>
              <label class="form-label">Status <span class="text-red-400">*</span></label>
              <select v-model="form.statusId" class="form-input">
                <option value="">— select status —</option>
                <option v-for="s in tasksStore.activeStatuses" :key="s.id" :value="s.id">
                  {{ s.name }}
                </option>
              </select>
            </div>

            <!-- Custom fields -->
            <template v-for="field in activeFields" :key="field.id">
              <div>
                <label
                  v-if="!isCopyableDropdownField(field)"
                  class="form-label"
                  :class="isFieldMissing(field.id) ? 'text-red-400' : ''"
                >
                  {{ field.name }}
                  <span v-if="field.required" class="text-red-400">*</span>
                </label>
                <TaskFieldInput
                  :field="field"
                  :value="customValues[field.id]"
                  mode="edit"
                  :users="tasksStore.users"
                  :enum-items="field.enum_dictionary_id ? tasksStore.enumItemsFor(field.enum_dictionary_id) : undefined"
                  :enum-known-items="field.enum_dictionary_id ? tasksStore.enumKnownItemsFor(field.enum_dictionary_id) : undefined"
                  :enum-dictionary="field.enum_dictionary_id ? tasksStore.enumDictionaryFor(field.enum_dictionary_id) : undefined"
                  :creating-enum-item="field.enum_dictionary_id ? tasksStore.enumItemCreateLoadingFor(field.enum_dictionary_id) : false"
                  :enum-items-loading="field.enum_dictionary_id ? tasksStore.enumItemSearchLoadingFor(field.enum_dictionary_id) : false"
                  @update:value="customValues[field.id] = $event"
                  @create:enum-item="onCreateFieldEnumItem(field, $event)"
                  @search:enum-items="onSearchFieldEnumItems(field, $event)"
                >
                  <template #label>
                    <label
                      class="form-label"
                      :class="isFieldMissing(field.id) ? 'text-red-400' : ''"
                    >
                      {{ field.name }}
                      <span v-if="field.required" class="text-red-400">*</span>
                    </label>
                  </template>
                </TaskFieldInput>
                <p v-if="isFieldMissing(field.id)" class="text-red-400 text-xs mt-1">
                  This field is required
                </p>
              </div>
            </template>
          </template>
        </div>

        <!-- Footer -->
        <div class="flex justify-end gap-3 px-6 py-4 border-t border-chat-border shrink-0">
          <div v-if="submitError" class="flex-1 text-red-400 text-sm self-center">
            {{ submitError }}
          </div>
          <button
            type="button"
            class="px-4 py-2 rounded text-sm text-app-secondaryText hover:text-app-text hover:bg-chat-msgHover transition-colors"
            :disabled="submitting"
            @click="cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            class="px-4 py-2 rounded bg-accent hover:bg-accent-hover text-app-onAccent text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            :disabled="!canSubmit || submitting"
            @click="submit"
          >
            {{ submitting ? 'Creating...' : 'Create task' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useTasksStore } from '@/stores/tasks'
import {
  tasksDeleteStagedAttachment,
  tasksUploadStagedAttachment,
  type TaskFieldDefinition,
  type TaskStagedAttachment,
} from '@/services/http/tasksApi'
import { buildFieldValues, missingRequiredFields } from '@/composables/useTaskFieldValues'
import {
  clearTaskCreateDraft,
  loadTaskCreateDraft,
  saveTaskCreateDraft,
} from '@/services/storage/taskCreateDraftStorage'
import { extractTaskStagedAttachmentIds } from '@/utils/attachmentMarkdown'
import TaskDescriptionEditor from './TaskDescriptionEditor.vue'
import TaskFieldInput from './TaskFieldInput.vue'

const props = defineProps<{
  initialTemplateId: string | null
}>()

const tasksStore = useTasksStore()

const selectedTemplateId = ref<string>('')
const submitting = ref(false)
const submitError = ref('')
const showValidation = ref(false)
const hydratingDraft = ref(false)
const stagedAttachments = ref<TaskStagedAttachment[]>([])

const form = reactive({
  title: '',
  description: '',
  statusId: '',
})

const customValues = reactive<Record<string, unknown>>({})

const activeFields = computed<TaskFieldDefinition[]>(() =>
  selectedTemplateId.value ? tasksStore.activeFieldsFor(selectedTemplateId.value) : [],
)

const missingFields = computed(() =>
  missingRequiredFields(activeFields.value, customValues),
)

const canSubmit = computed(() =>
  !!selectedTemplateId.value &&
  form.title.trim() !== '' &&
  form.statusId !== '' &&
  tasksStore.activeTemplates.length > 0 &&
  missingFields.value.length === 0,
)

function resolveInitialTemplateId(): string {
  const initialTemplateIsActive = !!props.initialTemplateId
    && tasksStore.activeTemplates.some(tpl => tpl.id === props.initialTemplateId)
  return initialTemplateIsActive
    ? props.initialTemplateId!
    : tasksStore.activeTemplates[0]?.id ?? ''
}

function isFieldMissing(id: string): boolean {
  return showValidation.value && missingFields.value.includes(id)
}

function isCopyableDropdownField(field: TaskFieldDefinition): boolean {
  return field.type === 'user' ||
    field.type === 'users' ||
    field.type === 'enum' ||
    field.type === 'multi_enum'
}

async function selectTemplate(id: string) {
  if (selectedTemplateId.value === id) return
  selectedTemplateId.value = id
  Object.keys(customValues).forEach(k => delete customValues[k])
  await tasksStore.loadFieldsFor(id)
  preloadSupportingData()
}

function preloadSupportingData() {
  // Load users once if any user/users field exists
  if (activeFields.value.some(f => f.type === 'user' || f.type === 'users')) {
    tasksStore.loadUsers()
  }
  // Load enum items for each enum field
  activeFields.value
    .filter(f => (f.type === 'enum' || f.type === 'multi_enum') && f.enum_dictionary_id)
    .forEach(f => tasksStore.loadEnumItemsFor(f.enum_dictionary_id!, selectedCodesForField(f)))
}

function selectedCodesForField(field: TaskFieldDefinition): string[] {
  const current = customValues[field.id]
  if (field.type === 'enum') {
    return current ? [String(current)] : []
  }
  if (field.type === 'multi_enum' && Array.isArray(current)) {
    return current as string[]
  }
  return []
}

function applyCreatedEnumValue(field: TaskFieldDefinition, createdCode: string) {
  if (field.type === 'enum') {
    customValues[field.id] = createdCode
    return
  }
  const current = Array.isArray(customValues[field.id]) ? customValues[field.id] as string[] : []
  customValues[field.id] = current.includes(createdCode) ? current : [...current, createdCode]
}

async function onCreateFieldEnumItem(field: TaskFieldDefinition, value: string) {
  if (!field.enum_dictionary_id) return
  submitError.value = ''
  try {
    const created = await tasksStore.createPublicDictionaryItem(field.enum_dictionary_id, value)
    applyCreatedEnumValue(field, created.value_code)
  } catch (e) {
    submitError.value = e instanceof Error ? e.message : 'Failed to add dictionary value'
  }
}

async function onSearchFieldEnumItems(field: TaskFieldDefinition, query: string) {
  if (!field.enum_dictionary_id) return
  await tasksStore.searchEnumItemsFor(field.enum_dictionary_id, query, selectedCodesForField(field), 20)
}

function rememberStagedAttachments(rows: TaskStagedAttachment[]) {
  const byID = new Map(stagedAttachments.value.map(item => [item.id, item]))
  for (const row of rows) {
    byID.set(row.id, row)
  }
  stagedAttachments.value = Array.from(byID.values())
}

async function uploadTaskStagedAttachments(files: File[]): Promise<TaskStagedAttachment[] | null> {
  if (!files.length) return null
  const uploaded = await Promise.all(files.map(file => tasksUploadStagedAttachment(file)))
  rememberStagedAttachments(uploaded)
  return uploaded
}

async function deleteStagedAttachments(ids: string[]) {
  await Promise.allSettled(ids.map(id => tasksDeleteStagedAttachment(id)))
}

function referencedStagedAttachmentIds(): string[] {
  return extractTaskStagedAttachmentIds(form.description)
}

async function cleanupUnreferencedStagedAttachments(referencedIds: string[]) {
  const keep = new Set(referencedIds)
  const unreferencedIds = stagedAttachments.value
    .map(item => item.id)
    .filter(id => !keep.has(id))
  if (unreferencedIds.length > 0) {
    await deleteStagedAttachments(unreferencedIds)
  }
  stagedAttachments.value = stagedAttachments.value.filter(item => keep.has(item.id))
}

function close() {
  if (submitting.value) return
  tasksStore.closeCreateDialog()
}

async function cancel() {
  if (submitting.value) return
  const ids = stagedAttachments.value.map(item => item.id)
  stagedAttachments.value = []
  await deleteStagedAttachments(ids)
  clearTaskCreateDraft()
  tasksStore.closeCreateDialog()
}

function reset() {
  form.title = ''
  form.description = ''
  form.statusId = tasksStore.activeStatuses[0]?.id ?? ''
  Object.keys(customValues).forEach(k => delete customValues[k])
  submitError.value = ''
  showValidation.value = false
  selectedTemplateId.value = resolveInitialTemplateId()
  stagedAttachments.value = []
}

async function submit() {
  showValidation.value = true
  if (!canSubmit.value || submitting.value) return
  submitting.value = true
  submitError.value = ''
  try {
    const stagedAttachmentIds = referencedStagedAttachmentIds()
    await cleanupUnreferencedStagedAttachments(stagedAttachmentIds)
    await tasksStore.createTask({
      template_id: selectedTemplateId.value,
      title: form.title.trim(),
      description: form.description.trim() || null,
      status_id: form.statusId,
      field_values: buildFieldValues(activeFields.value, customValues, tasksStore.enumVersionFor),
      staged_attachment_ids: stagedAttachmentIds,
    })
    stagedAttachments.value = []
    clearTaskCreateDraft()
    tasksStore.closeCreateDialog()
  } catch (e) {
    submitError.value = e instanceof Error ? e.message : 'Failed to create task'
  } finally {
    submitting.value = false
  }
}

// Initialise when dialog opens; reset when it closes
watch(() => tasksStore.createDialogOpen, async (open) => {
  if (!open) {
    hydratingDraft.value = false
    reset()
    return
  }
  hydratingDraft.value = true
  try {
    await tasksStore.loadConfig()
    // Set defaults after config is loaded
    selectedTemplateId.value = resolveInitialTemplateId()
    form.statusId = tasksStore.activeStatuses[0]?.id ?? ''
    if (selectedTemplateId.value) {
      await tasksStore.loadFieldsFor(selectedTemplateId.value)
      preloadSupportingData()
    }
    const draft = loadTaskCreateDraft()
    form.title = draft.title
    form.description = draft.description
    stagedAttachments.value = draft.stagedAttachments
  } finally {
    hydratingDraft.value = false
  }
})

watch(
  [() => form.title, () => form.description, () => stagedAttachments.value.map(item => item.id).join('|')],
  () => {
    if (!tasksStore.createDialogOpen || hydratingDraft.value) return
    saveTaskCreateDraft({
      title: form.title,
      description: form.description,
      stagedAttachments: stagedAttachments.value,
    })
  },
  { flush: 'sync' },
)
</script>

<style scoped>
.form-label {
  @apply block text-sm text-app-muted mb-1;
}
.form-input {
  @apply w-full bg-chat-input border border-chat-border rounded px-3 py-2 text-app-text placeholder-app-muted text-sm outline-none focus:border-accent transition-colors;
}
</style>
