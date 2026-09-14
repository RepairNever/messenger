<template>
  <div class="mt-3 border-t border-chat-border pt-3">
    <!-- Header row -->
    <div class="flex items-center justify-between mb-3 px-1">
      <span class="text-xs text-gray-400 uppercase tracking-wide">Fields</span>
      <button
        class="flex items-center gap-1 px-2 py-1 bg-accent hover:bg-accent-hover text-white text-xs rounded transition-colors"
        @click="openCreate"
      >
        <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path d="M12 5v14M5 12h14"/>
        </svg>
        Add Field
      </button>
    </div>

    <div v-if="error" class="text-red-400 text-xs mb-2 px-1">{{ error }}</div>

    <!-- Loading -->
    <div v-if="loading" class="text-gray-500 text-xs px-1 py-2">Loading fields...</div>

    <!-- Empty -->
    <div v-else-if="fields.length === 0" class="text-gray-500 text-xs px-1 py-2">No fields defined.</div>

    <!-- Fields list with drag-and-drop -->
    <div v-else class="rounded border border-chat-border overflow-hidden">
      <table class="w-full text-xs">
        <thead>
          <tr class="border-b border-chat-border text-gray-500 uppercase tracking-wide">
            <th class="w-6 px-2 py-2"></th>
            <th class="text-left px-3 py-2">Code</th>
            <th class="text-left px-3 py-2">Name</th>
            <th class="text-left px-3 py-2">Type</th>
            <th class="text-left px-3 py-2">Req</th>
            <th class="text-left px-3 py-2">Role</th>
            <th class="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="field in fields"
            :key="field.id"
            class="border-t border-chat-border hover:bg-white/5 transition-colors"
            :class="field.deleted_at ? 'opacity-40' : ''"
            :draggable="!field.deleted_at"
            @dragstart="onDragStart(field)"
            @dragover.prevent="onDragOver(field)"
            @drop.prevent="onDrop"
          >
            <!-- drag handle -->
            <td class="px-2 py-2 text-center">
              <span v-if="!field.deleted_at" class="text-gray-600 cursor-grab select-none">⠿</span>
            </td>
            <td class="px-3 py-2 font-mono text-accent">{{ field.code }}</td>
            <td class="px-3 py-2 text-gray-300">{{ field.name }}</td>
            <td class="px-3 py-2 text-gray-400">
              <span class="px-1.5 py-0.5 rounded bg-white/10 font-mono">{{ field.type }}</span>
            </td>
            <td class="px-3 py-2 text-gray-400">{{ field.required ? '✓' : '—' }}</td>
            <td class="px-3 py-2 text-gray-400">
              <span v-if="field.field_role" class="px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400">
                {{ field.field_role }}
              </span>
              <span v-else>—</span>
            </td>
            <td class="px-3 py-2 text-right space-x-1">
              <button
                v-if="!field.deleted_at"
                class="text-blue-400 hover:text-blue-300 px-1.5 py-0.5 rounded hover:bg-blue-400/10 transition-colors"
                @click="openEdit(field)"
              >Edit</button>
              <button
                v-if="!field.deleted_at"
                class="text-red-400 hover:text-red-300 px-1.5 py-0.5 rounded hover:bg-red-400/10 transition-colors"
                :disabled="actionId === field.id"
                @click="deleteField(field)"
              >Delete</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Create / Edit dialog -->
    <Teleport to="body">
      <div
        v-if="dialogOpen"
        class="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
        @click.self="dialogOpen = false"
      >
        <div class="bg-[#222529] border border-chat-border rounded-xl shadow-2xl w-full max-w-sm p-6">
          <h3 class="text-base font-bold text-white mb-4">
            {{ isEdit ? 'Edit Field' : 'Add Field' }}
          </h3>

          <div class="space-y-3">
            <!-- Code (create only) -->
            <div>
              <label class="block text-xs text-gray-400 mb-1">
                Code <span class="text-gray-600">(a-z, 0-9, _; starts with letter)</span>
              </label>
              <input
                v-model="form.code"
                type="text"
                :disabled="isEdit"
                class="w-full bg-chat-input border border-chat-border rounded px-3 py-2 text-white text-sm font-mono outline-none focus:border-accent disabled:opacity-50"
                placeholder="my_field"
              />
            </div>

            <!-- Name -->
            <div>
              <label class="block text-xs text-gray-400 mb-1">Name</label>
              <input
                v-model="form.name"
                type="text"
                class="w-full bg-chat-input border border-chat-border rounded px-3 py-2 text-white text-sm outline-none focus:border-accent"
                placeholder="My Field"
              />
            </div>

            <!-- Type (create only) -->
            <div>
              <label class="block text-xs text-gray-400 mb-1">Type</label>
              <select
                v-model="form.type"
                :disabled="isEdit"
                class="w-full bg-chat-input border border-chat-border rounded px-3 py-2 text-white text-sm outline-none focus:border-accent disabled:opacity-50"
                @change="onTypeChange"
              >
                <option v-for="t in FIELD_TYPES" :key="t" :value="t">{{ t }}</option>
              </select>
            </div>

            <!-- Enum dictionary (enum / multi_enum only) -->
            <div v-if="isEnumType">
              <label class="block text-xs text-gray-400 mb-1">Dictionary</label>
              <select
                v-model="form.enum_dictionary_id"
                :disabled="isEdit"
                class="w-full bg-chat-input border border-chat-border rounded px-3 py-2 text-white text-sm outline-none focus:border-accent disabled:opacity-50"
              >
                <option value="">— select —</option>
                <option v-for="d in dictionaries" :key="d.id" :value="d.id">{{ d.name }} ({{ d.code }})</option>
              </select>
            </div>

            <!-- Field role (user / users only) -->
            <div v-if="isUserType">
              <label class="block text-xs text-gray-400 mb-1">Role</label>
              <select
                v-model="form.field_role"
                :disabled="isEdit"
                class="w-full bg-chat-input border border-chat-border rounded px-3 py-2 text-white text-sm outline-none focus:border-accent disabled:opacity-50"
              >
                <option :value="null">None</option>
                <option value="assignee">assignee</option>
              </select>
            </div>

            <!-- Required -->
            <label class="flex items-center gap-2 text-sm text-gray-200 cursor-pointer">
              <input v-model="form.required" type="checkbox" class="h-4 w-4 rounded" />
              Required
            </label>

            <!-- Sort order (create only) -->
            <div v-if="!isEdit">
              <label class="block text-xs text-gray-400 mb-1">Sort order</label>
              <input
                v-model.number="form.sort_order"
                type="number"
                class="w-full bg-chat-input border border-chat-border rounded px-3 py-2 text-white text-sm outline-none focus:border-accent"
              />
            </div>
          </div>

          <div v-if="dialogError" class="text-red-400 text-xs mt-3">{{ dialogError }}</div>

          <div class="flex gap-3 mt-5">
            <button
              class="flex-1 py-2 rounded bg-white/10 hover:bg-white/20 text-gray-200 text-sm transition-colors"
              @click="dialogOpen = false"
            >Cancel</button>
            <button
              class="flex-1 py-2 rounded bg-accent hover:bg-accent-hover text-white text-sm font-medium transition-colors"
              :disabled="dialogLoading"
              @click="submitDialog"
            >{{ dialogLoading ? 'Saving...' : 'Save' }}</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import {
  tasksListFields,
  tasksCreateField,
  tasksUpdateField,
  tasksDeleteField,
  tasksReorderFields,
  tasksListDictionaries,
  type TaskFieldDefinition,
  type FieldType,
  type EnumDictionary,
} from '@/services/http/tasksApi'

const props = defineProps<{ templateId: string }>()

const FIELD_TYPES: FieldType[] = ['text', 'number', 'user', 'users', 'enum', 'multi_enum', 'date', 'datetime']

// ---- State ----
const fields      = ref<TaskFieldDefinition[]>([])
const dictionaries = ref<EnumDictionary[]>([])
const loading     = ref(false)
const error       = ref<string | null>(null)
const actionId    = ref<string | null>(null)

const dialogOpen    = ref(false)
const dialogLoading = ref(false)
const dialogError   = ref<string | null>(null)
const editId        = ref<string | null>(null)

const defaultForm = () => ({
  code: '',
  name: '',
  type: 'text' as FieldType,
  required: false,
  sort_order: 0,
  enum_dictionary_id: null as string | null,
  field_role: null as 'assignee' | null,
})
const form = ref(defaultForm())

// ---- Computed ----
const isEdit     = computed(() => editId.value !== null)
const isEnumType = computed(() => form.value.type === 'enum' || form.value.type === 'multi_enum')
const isUserType = computed(() => form.value.type === 'user' || form.value.type === 'users')

// ---- Data loading ----
async function load() {
  loading.value = true
  error.value = null
  try {
    fields.value = await tasksListFields(props.templateId, false)
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'Failed to load fields'
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  await Promise.all([
    load(),
    tasksListDictionaries().then(d => { dictionaries.value = d }).catch(() => {}),
  ])
})

// ---- Dialog ----
function openCreate() {
  editId.value = null
  form.value = { ...defaultForm(), sort_order: fields.value.filter(f => !f.deleted_at).length + 1 }
  dialogError.value = null
  dialogOpen.value = true
}

function openEdit(field: TaskFieldDefinition) {
  editId.value = field.id
  form.value = {
    code: field.code,
    name: field.name,
    type: field.type,
    required: field.required,
    sort_order: field.sort_order,
    enum_dictionary_id: field.enum_dictionary_id,
    field_role: field.field_role,
  }
  dialogError.value = null
  dialogOpen.value = true
}

function onTypeChange() {
  if (!isEnumType.value) form.value.enum_dictionary_id = null
  if (!isUserType.value) form.value.field_role = null
}

async function submitDialog() {
  dialogLoading.value = true
  dialogError.value = null
  try {
    if (isEdit.value) {
      await tasksUpdateField(props.templateId, editId.value!, {
        name: form.value.name,
        required: form.value.required,
      })
    } else {
      await tasksCreateField(props.templateId, {
        code: form.value.code,
        name: form.value.name,
        type: form.value.type,
        required: form.value.required,
        sort_order: form.value.sort_order,
        enum_dictionary_id: isEnumType.value ? form.value.enum_dictionary_id : null,
        field_role: isUserType.value ? form.value.field_role : null,
      })
    }
    dialogOpen.value = false
    await load()
  } catch (e: unknown) {
    dialogError.value = e instanceof Error ? e.message : 'Failed to save field'
  } finally {
    dialogLoading.value = false
  }
}

async function deleteField(field: TaskFieldDefinition) {
  actionId.value = field.id
  error.value = null
  try {
    await tasksDeleteField(props.templateId, field.id)
    await load()
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'Failed to delete field'
  } finally {
    actionId.value = null
  }
}

// ---- Drag-and-drop reorder ----
const dragSource = ref<TaskFieldDefinition | null>(null)
const dragOver   = ref<TaskFieldDefinition | null>(null)

function onDragStart(field: TaskFieldDefinition) {
  dragSource.value = field
}

function onDragOver(field: TaskFieldDefinition) {
  dragOver.value = field
}

async function onDrop() {
  const src = dragSource.value
  const tgt = dragOver.value
  dragSource.value = null
  dragOver.value = null

  if (!src || !tgt || src.id === tgt.id) return

  // Reorder locally for immediate feedback.
  const active = fields.value.filter(f => !f.deleted_at)
  const srcIdx = active.findIndex(f => f.id === src.id)
  const tgtIdx = active.findIndex(f => f.id === tgt.id)
  if (srcIdx === -1 || tgtIdx === -1) return

  const reordered = [...active]
  reordered.splice(srcIdx, 1)
  reordered.splice(tgtIdx, 0, src)
  fields.value = reordered

  try {
    await tasksReorderFields(props.templateId, reordered.map(f => f.id))
    await load()
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'Failed to reorder fields'
    await load() // restore server order on failure
  }
}
</script>
