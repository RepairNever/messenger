<template>
  <div>
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-base font-semibold text-white">Task Statuses</h2>
      <button
        class="flex items-center gap-1.5 px-3 py-1.5 bg-accent hover:bg-accent-hover text-white text-sm rounded transition-colors"
        @click="openCreate"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path d="M12 5v14M5 12h14"/>
        </svg>
        Create Status
      </button>
    </div>

    <div v-if="listError" class="text-red-400 text-sm mb-3">{{ listError }}</div>
    <div v-if="actionError" class="text-red-400 text-sm mb-3">{{ actionError }}</div>

    <div class="bg-chat-input border border-chat-border rounded-lg overflow-hidden">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-chat-border text-gray-400 text-xs uppercase tracking-wide">
            <th class="w-8 px-3 py-3"></th>
            <th class="text-left px-4 py-3">Code</th>
            <th class="text-left px-4 py-3">Name</th>
            <th class="text-left px-4 py-3">Status</th>
            <th class="px-4 py-3"/>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading">
            <td colspan="5" class="px-4 py-6 text-center text-gray-500">Loading...</td>
          </tr>
          <tr v-else-if="statuses.length === 0">
            <td colspan="5" class="px-4 py-6 text-center text-gray-500">No statuses</td>
          </tr>
          <tr
            v-for="st in statuses"
            :key="st.id"
            class="border-t border-chat-border hover:bg-white/5 transition-colors"
            :class="st.deleted_at ? 'opacity-50' : ''"
            :draggable="!st.deleted_at"
            :data-testid="`status-row-${st.id}`"
            @dragstart="onDragStart(st)"
            @dragover.prevent="onDragOver(st)"
            @drop.prevent="onDrop"
          >
            <td class="px-3 py-3 text-center">
              <span v-if="!st.deleted_at" class="text-gray-600 cursor-grab select-none">⠿</span>
            </td>
            <td class="px-4 py-3 font-mono text-gray-300">{{ st.code }}</td>
            <td class="px-4 py-3 text-white">{{ st.name }}</td>
            <td class="px-4 py-3">
              <span v-if="st.deleted_at" class="px-2 py-0.5 rounded text-xs bg-red-500/20 text-red-400">Deleted</span>
              <span v-else class="px-2 py-0.5 rounded text-xs bg-green-500/20 text-green-400">Active</span>
            </td>
            <td class="px-4 py-3 text-right space-x-2">
              <button
                v-if="!st.deleted_at"
                class="text-xs text-blue-400 hover:text-blue-300 px-2 py-1 rounded hover:bg-blue-400/10 transition-colors"
                @click="openEdit(st)"
              >Edit</button>
              <button
                v-if="!st.deleted_at"
                class="text-xs text-red-400 hover:text-red-300 px-2 py-1 rounded hover:bg-red-400/10 transition-colors"
                :disabled="actionLoading === st.id"
                @click="deleteStatus(st.id)"
              >Delete</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Create / Edit dialog -->
    <Teleport to="body">
      <div v-if="dialogOpen" class="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" @click.self="dialogOpen = false">
        <div class="bg-[#222529] border border-chat-border rounded-xl shadow-2xl w-full max-w-sm p-6">
          <h3 class="text-lg font-bold text-white mb-4">{{ dialogMode === 'create' ? 'Create Status' : 'Edit Status' }}</h3>
          <div class="space-y-3">
            <div>
              <label class="block text-sm text-gray-400 mb-1">Code</label>
              <input
                v-model="form.code"
                type="text"
                class="w-full bg-chat-input border border-chat-border rounded px-3 py-2 text-white text-sm font-mono outline-none focus:border-accent"
                placeholder="in_progress"
              />
            </div>
            <div>
              <label class="block text-sm text-gray-400 mb-1">Name</label>
              <input
                v-model="form.name"
                type="text"
                class="w-full bg-chat-input border border-chat-border rounded px-3 py-2 text-white text-sm outline-none focus:border-accent"
                placeholder="In Progress"
              />
            </div>
          </div>
          <div v-if="dialogError" class="text-red-400 text-sm mt-3">{{ dialogError }}</div>
          <div class="flex gap-3 mt-5">
            <button class="flex-1 py-2 rounded bg-white/10 hover:bg-white/20 text-gray-200 text-sm transition-colors" @click="dialogOpen = false">Cancel</button>
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
  tasksListStatuses, tasksCreateStatus, tasksUpdateStatus, tasksDeleteStatus, tasksReorderStatuses,
  type TaskStatus,
} from '@/services/http/tasksApi'

const statuses = ref<TaskStatus[]>([])
const loading = ref(false)
const listError = ref<string | null>(null)
const actionLoading = ref<string | null>(null)
const actionError = ref<string | null>(null)

const dialogOpen = ref(false)
const dialogMode = ref<'create' | 'edit'>('create')
const dialogLoading = ref(false)
const dialogError = ref<string | null>(null)
const editId = ref<string | null>(null)
const form = ref({ code: '', name: '', sort_order: 0 })
const dragSource = ref<TaskStatus | null>(null)
const dragOver = ref<TaskStatus | null>(null)

async function load() {
  loading.value = true
  listError.value = null
  try {
    statuses.value = await tasksListStatuses(true)
  } catch (e: unknown) {
    listError.value = e instanceof Error ? e.message : 'Failed to load statuses'
  } finally {
    loading.value = false
  }
}

function openCreate() {
  dialogMode.value = 'create'
  editId.value = null
  form.value = { code: '', name: '', sort_order: statuses.value.filter(s => !s.deleted_at).length + 1 }
  dialogError.value = null
  dialogOpen.value = true
}

function openEdit(st: TaskStatus) {
  dialogMode.value = 'edit'
  editId.value = st.id
  form.value = { code: st.code, name: st.name, sort_order: st.sort_order }
  dialogError.value = null
  dialogOpen.value = true
}

async function submitDialog() {
  dialogLoading.value = true
  dialogError.value = null
  try {
    if (dialogMode.value === 'create') {
      await tasksCreateStatus(form.value)
    } else {
      await tasksUpdateStatus(editId.value!, { code: form.value.code, name: form.value.name })
    }
    dialogOpen.value = false
    await load()
  } catch (e: unknown) {
    dialogError.value = e instanceof Error ? e.message : 'Failed to save status'
  } finally {
    dialogLoading.value = false
  }
}

async function deleteStatus(id: string) {
  actionLoading.value = id
  actionError.value = null
  try {
    await tasksDeleteStatus(id)
    await load()
  } catch (e: unknown) {
    actionError.value = e instanceof Error ? e.message : 'Failed to delete status'
  } finally {
    actionLoading.value = null
  }
}

function onDragStart(st: TaskStatus) {
  if (st.deleted_at) return
  dragSource.value = st
}

function onDragOver(st: TaskStatus) {
  if (st.deleted_at) return
  dragOver.value = st
}

function mergeActiveStatuses(items: TaskStatus[], activeOrder: TaskStatus[]): TaskStatus[] {
  const next = [...items]
  let activeIdx = 0
  for (let i = 0; i < next.length; i += 1) {
    if (next[i].deleted_at) continue
    next[i] = activeOrder[activeIdx]
    activeIdx += 1
  }
  return next
}

async function onDrop() {
  const src = dragSource.value
  const tgt = dragOver.value
  dragSource.value = null
  dragOver.value = null

  if (!src || !tgt || src.id === tgt.id) return

  const active = statuses.value.filter(st => !st.deleted_at)
  const srcIdx = active.findIndex(st => st.id === src.id)
  const tgtIdx = active.findIndex(st => st.id === tgt.id)
  if (srcIdx === -1 || tgtIdx === -1) return

  const reordered = [...active]
  reordered.splice(srcIdx, 1)
  reordered.splice(tgtIdx, 0, src)
  statuses.value = mergeActiveStatuses(statuses.value, reordered)

  try {
    await tasksReorderStatuses(reordered.map(st => st.id))
    await load()
  } catch (e: unknown) {
    actionError.value = e instanceof Error ? e.message : 'Failed to reorder statuses'
    await load()
  }
}

onMounted(load)
</script>
