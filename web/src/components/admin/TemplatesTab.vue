<template>
  <div>
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-base font-semibold text-white">Task Templates</h2>
      <button
        class="flex items-center gap-1.5 px-3 py-1.5 bg-accent hover:bg-accent-hover text-white text-sm rounded transition-colors"
        @click="openCreate"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path d="M12 5v14M5 12h14"/>
        </svg>
        Create Template
      </button>
    </div>

    <div v-if="listError" class="text-red-400 text-sm mb-3">{{ listError }}</div>
    <div v-if="actionError" class="text-red-400 text-sm mb-3">{{ actionError }}</div>

    <div v-if="loading" class="text-gray-500 text-sm px-2 py-4">Loading...</div>
    <div v-else-if="templates.length === 0" class="text-gray-500 text-sm px-2 py-4">No templates</div>

    <!-- Template rows with inline field accordions -->
    <div v-else class="space-y-2">
      <div
        v-for="tpl in templates"
        :key="tpl.id"
        class="bg-chat-input border border-chat-border rounded-lg overflow-hidden"
        :class="tpl.deleted_at ? 'opacity-50' : ''"
      >
        <!-- Template header row -->
        <div class="flex items-center gap-3 px-4 py-3">
          <!-- Expand / collapse toggle -->
          <button
            v-if="!tpl.deleted_at"
            class="text-gray-500 hover:text-gray-300 transition-colors w-4 shrink-0"
            :title="expandedId === tpl.id ? 'Collapse fields' : 'Expand fields'"
            @click="toggleExpand(tpl.id)"
          >
            <svg
              class="w-4 h-4 transition-transform"
              :class="expandedId === tpl.id ? 'rotate-90' : ''"
              fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"
            >
              <path d="M9 18l6-6-6-6"/>
            </svg>
          </button>
          <span v-else class="w-4 shrink-0"/>

          <span class="font-mono text-accent font-semibold w-20 shrink-0">{{ tpl.prefix }}</span>
          <span class="text-gray-500 text-xs w-12 shrink-0">{{ tpl.sort_order }}</span>

          <span
            class="px-2 py-0.5 rounded text-xs shrink-0"
            :class="tpl.deleted_at ? 'bg-red-500/20 text-red-400' : 'bg-green-500/20 text-green-400'"
          >
            {{ tpl.deleted_at ? 'Deleted' : 'Active' }}
          </span>

          <div class="flex-1"/>

          <button
            v-if="!tpl.deleted_at"
            class="text-xs text-blue-400 hover:text-blue-300 px-2 py-1 rounded hover:bg-blue-400/10 transition-colors"
            @click="openEdit(tpl)"
          >Edit</button>
          <button
            v-if="!tpl.deleted_at"
            class="text-xs text-red-400 hover:text-red-300 px-2 py-1 rounded hover:bg-red-400/10 transition-colors"
            :disabled="actionLoading === tpl.id"
            @click="deleteTemplate(tpl.id)"
          >Delete</button>
        </div>

        <!-- Inline fields accordion -->
        <div v-if="expandedId === tpl.id" class="border-t border-chat-border px-4 pb-3">
          <FieldsPanel :template-id="tpl.id" />
        </div>
      </div>
    </div>

    <!-- Create / Edit dialog -->
    <Teleport to="body">
      <div
        v-if="dialogOpen"
        class="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
        @click.self="dialogOpen = false"
      >
        <div class="bg-[#222529] border border-chat-border rounded-xl shadow-2xl w-full max-w-sm p-6">
          <h3 class="text-lg font-bold text-white mb-4">
            {{ dialogMode === 'create' ? 'Create Template' : 'Edit Template' }}
          </h3>
          <div class="space-y-3">
            <div>
              <label class="block text-sm text-gray-400 mb-1">
                Prefix <span class="text-gray-500">(uppercase A–Z only)</span>
              </label>
              <input
                v-model="form.prefix"
                type="text"
                class="w-full bg-chat-input border border-chat-border rounded px-3 py-2 text-white text-sm font-mono outline-none focus:border-accent uppercase"
                placeholder="DEV"
                @input="form.prefix = (form.prefix as string).toUpperCase().replace(/[^A-Z]/g, '')"
              />
            </div>
            <div>
              <label class="block text-sm text-gray-400 mb-1">Sort Order</label>
              <input
                v-model.number="form.sort_order"
                type="number"
                class="w-full bg-chat-input border border-chat-border rounded px-3 py-2 text-white text-sm outline-none focus:border-accent"
              />
            </div>
          </div>
          <div v-if="dialogError" class="text-red-400 text-sm mt-3">{{ dialogError }}</div>
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
import { ref, onMounted } from 'vue'
import {
  tasksListTemplates, tasksCreateTemplate, tasksUpdateTemplate, tasksDeleteTemplate,
  type TaskTemplate,
} from '@/services/http/tasksApi'
import FieldsPanel from './FieldsPanel.vue'

const templates     = ref<TaskTemplate[]>([])
const loading       = ref(false)
const listError     = ref<string | null>(null)
const actionLoading = ref<string | null>(null)
const actionError   = ref<string | null>(null)
const expandedId    = ref<string | null>(null)

const dialogOpen    = ref(false)
const dialogMode    = ref<'create' | 'edit'>('create')
const dialogLoading = ref(false)
const dialogError   = ref<string | null>(null)
const editId        = ref<string | null>(null)
const form          = ref({ prefix: '', sort_order: 0 })

async function load() {
  loading.value = true
  listError.value = null
  try {
    templates.value = await tasksListTemplates(true)
  } catch (e: unknown) {
    listError.value = e instanceof Error ? e.message : 'Failed to load templates'
  } finally {
    loading.value = false
  }
}

function toggleExpand(id: string) {
  expandedId.value = expandedId.value === id ? null : id
}

function openCreate() {
  dialogMode.value = 'create'
  editId.value = null
  form.value = { prefix: '', sort_order: templates.value.filter(t => !t.deleted_at).length + 1 }
  dialogError.value = null
  dialogOpen.value = true
}

function openEdit(tpl: TaskTemplate) {
  dialogMode.value = 'edit'
  editId.value = tpl.id
  form.value = { prefix: tpl.prefix, sort_order: tpl.sort_order }
  dialogError.value = null
  dialogOpen.value = true
}

async function submitDialog() {
  dialogLoading.value = true
  dialogError.value = null
  try {
    if (dialogMode.value === 'create') {
      await tasksCreateTemplate(form.value)
    } else {
      await tasksUpdateTemplate(editId.value!, {
        prefix: form.value.prefix,
        sort_order: form.value.sort_order,
      })
    }
    dialogOpen.value = false
    await load()
  } catch (e: unknown) {
    dialogError.value = e instanceof Error ? e.message : 'Failed to save template'
  } finally {
    dialogLoading.value = false
  }
}

async function deleteTemplate(id: string) {
  actionLoading.value = id
  actionError.value = null
  try {
    await tasksDeleteTemplate(id)
    if (expandedId.value === id) expandedId.value = null
    await load()
  } catch (e: unknown) {
    actionError.value = e instanceof Error ? e.message : 'Failed to delete template'
  } finally {
    actionLoading.value = null
  }
}

onMounted(load)
</script>
