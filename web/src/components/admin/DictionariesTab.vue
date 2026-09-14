<template>
  <div>
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-base font-semibold text-white">Enum Dictionaries</h2>
      <button
        class="flex items-center gap-1.5 px-3 py-1.5 bg-accent hover:bg-accent-hover text-white text-sm rounded transition-colors"
        @click="openCreate"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path d="M12 5v14M5 12h14"/>
        </svg>
        Create Dictionary
      </button>
    </div>

    <div v-if="listError" class="text-red-400 text-sm mb-3">{{ listError }}</div>

    <div class="bg-chat-input border border-chat-border rounded-lg overflow-hidden mb-6">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-chat-border text-gray-400 text-xs uppercase tracking-wide">
            <th class="text-left px-4 py-3">Code</th>
            <th class="text-left px-4 py-3">Name</th>
            <th class="text-left px-4 py-3">Is Public</th>
            <th class="text-left px-4 py-3">Filtration</th>
            <th class="text-left px-4 py-3">Current Version</th>
            <th class="px-4 py-3"/>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading">
            <td colspan="6" class="px-4 py-6 text-center text-gray-500">Loading...</td>
          </tr>
          <tr v-else-if="dictionaries.length === 0">
            <td colspan="6" class="px-4 py-6 text-center text-gray-500">No dictionaries</td>
          </tr>
          <tr
            v-for="d in dictionaries"
            :key="d.id"
            class="border-t border-chat-border hover:bg-white/5 transition-colors"
          >
            <td class="px-4 py-3 font-mono text-gray-300">{{ d.code }}</td>
            <td class="px-4 py-3 text-white">{{ d.name }}</td>
            <td class="px-4 py-3">
              <button
                class="inline-flex min-w-[86px] items-center justify-center rounded px-2 py-1 text-xs transition-colors"
                :class="d.is_public
                  ? 'bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25'
                  : 'bg-white/10 text-gray-300 hover:bg-white/15'"
                :disabled="toggleLoadingById[d.id]"
                @click="toggleDictionarySetting(d, 'is_public')"
              >
                {{ toggleLoadingById[d.id] ? 'Saving...' : (d.is_public ? 'Public' : 'Private') }}
              </button>
            </td>
            <td class="px-4 py-3">
              <button
                class="inline-flex min-w-[86px] items-center justify-center rounded px-2 py-1 text-xs transition-colors"
                :class="d.participates_in_filtration
                  ? 'bg-blue-500/15 text-blue-300 hover:bg-blue-500/25'
                  : 'bg-white/10 text-gray-300 hover:bg-white/15'"
                :disabled="toggleLoadingById[d.id]"
                @click="toggleDictionarySetting(d, 'participates_in_filtration')"
              >
                {{ toggleLoadingById[d.id] ? 'Saving...' : (d.participates_in_filtration ? 'Enabled' : 'Disabled') }}
              </button>
            </td>
            <td class="px-4 py-3 text-gray-400">v{{ d.current_version }}</td>
            <td class="px-4 py-3 text-right space-x-2">
              <button
                class="text-xs text-blue-400 hover:text-blue-300 px-2 py-1 rounded hover:bg-blue-400/10 transition-colors"
                @click="openVersions(d.id)"
              >Versions</button>
              <button
                class="text-xs text-green-400 hover:text-green-300 px-2 py-1 rounded hover:bg-green-400/10 transition-colors"
                @click="() => openNewVersion(d)"
              >Edit Items</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Version detail panel -->
    <div v-if="activeDictId" class="bg-chat-input border border-chat-border rounded-lg overflow-hidden">
      <div class="flex items-center justify-between px-4 py-3 border-b border-chat-border">
        <h3 class="text-sm font-semibold text-white">Versions</h3>
        <button class="text-gray-400 hover:text-white text-xs" @click="activeDictId = null">Close</button>
      </div>
      <div v-if="versionsLoading" class="px-4 py-4 text-center text-gray-500 text-sm">Loading...</div>
      <div v-else-if="versionsError" class="px-4 py-4 text-red-400 text-sm">{{ versionsError }}</div>
      <table v-else class="w-full text-sm">
        <thead>
          <tr class="border-b border-chat-border text-gray-400 text-xs uppercase tracking-wide">
            <th class="text-left px-4 py-3">Version</th>
            <th class="text-left px-4 py-3">Created</th>
            <th class="px-4 py-3"/>
          </tr>
        </thead>
        <tbody>
          <tr v-if="versions.length === 0">
            <td colspan="3" class="px-4 py-4 text-center text-gray-500">No versions</td>
          </tr>
          <tr
            v-for="ver in versions"
            :key="ver.id"
            class="border-t border-chat-border hover:bg-white/5"
          >
            <td class="px-4 py-3 text-white">v{{ ver.version }}</td>
            <td class="px-4 py-3 text-gray-400">{{ formatDate(ver.created_at) }}</td>
            <td class="px-4 py-3 text-right">
              <button
                class="text-xs text-blue-400 hover:text-blue-300 px-2 py-1 rounded hover:bg-blue-400/10 transition-colors"
                @click="loadItems(activeDictId!, ver.id)"
              >View Items</button>
            </td>
          </tr>
        </tbody>
      </table>
      <!-- Items inline -->
      <div v-if="activeItems.length > 0" class="border-t border-chat-border px-4 py-3">
        <h4 class="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Items</h4>
        <div v-if="itemsError" class="text-red-400 text-sm mb-2">{{ itemsError }}</div>
        <div class="w-full overflow-x-auto">
          <div class="min-w-full space-y-1">
          <div
            v-for="item in activeItems"
            :key="item.id"
            class="grid w-full grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-3 text-sm"
            :class="item.is_active ? 'text-gray-200' : 'text-gray-500 line-through'"
          >
            <span class="min-w-0 font-mono text-xs text-gray-400">{{ item.value_code }}</span>
            <span class="min-w-0">{{ item.value_name }}</span>
            <span v-if="!item.is_active" class="text-xs text-gray-500 justify-self-end">(inactive)</span>
          </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Create dictionary dialog -->
    <Teleport to="body">
      <div v-if="createOpen" class="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" @click.self="createOpen = false">
        <div class="bg-[#222529] border border-chat-border rounded-xl shadow-2xl w-full max-w-sm p-6">
          <h3 class="text-lg font-bold text-white mb-4">Create Dictionary</h3>
          <div class="space-y-3">
            <div>
              <label class="block text-sm text-gray-400 mb-1">Code</label>
              <input v-model="createForm.code" type="text" class="w-full bg-chat-input border border-chat-border rounded px-3 py-2 text-white text-sm font-mono outline-none focus:border-accent" placeholder="priority" />
            </div>
            <div>
              <label class="block text-sm text-gray-400 mb-1">Name</label>
              <input v-model="createForm.name" type="text" class="w-full bg-chat-input border border-chat-border rounded px-3 py-2 text-white text-sm outline-none focus:border-accent" placeholder="Priority" />
            </div>
            <label class="flex items-center gap-2 rounded border border-chat-border px-3 py-2 text-sm text-gray-300">
              <input v-model="createForm.is_public" type="checkbox" class="rounded border-chat-border bg-chat-input text-accent focus:ring-accent" />
              Is Public
            </label>
            <label class="flex items-center gap-2 rounded border border-chat-border px-3 py-2 text-sm text-gray-300">
              <input v-model="createForm.participates_in_filtration" type="checkbox" class="rounded border-chat-border bg-chat-input text-accent focus:ring-accent" />
              Participates in filtration
            </label>
          </div>
          <div v-if="createError" class="text-red-400 text-sm mt-3">{{ createError }}</div>
          <div class="flex gap-3 mt-5">
            <button class="flex-1 py-2 rounded bg-white/10 hover:bg-white/20 text-gray-200 text-sm transition-colors" @click="createOpen = false">Cancel</button>
            <button class="flex-1 py-2 rounded bg-accent hover:bg-accent-hover text-white text-sm font-medium transition-colors" :disabled="createLoading" @click="submitCreate">
              {{ createLoading ? 'Creating...' : 'Create' }}
            </button>
          </div>
        </div>
      </div>

      <!-- Dictionary items dialog -->
      <div v-if="versionOpen" class="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" @click.self="versionOpen = false">
        <div class="bg-[#222529] border border-chat-border rounded-xl shadow-2xl w-full max-w-none max-h-[90vh] p-6 flex flex-col">
          <h3 class="text-lg font-bold text-white mb-1 shrink-0">Edit Items</h3>
          <p class="text-sm text-gray-400 mb-4 shrink-0">Dictionary: <span class="text-gray-200 font-mono">{{ versionDictCode }}</span></p>
          <div v-if="versionLoading" class="text-center text-gray-500 py-8">Loading current items...</div>
          <template v-else>
            <div class="flex-1 min-h-0 overflow-y-auto pr-1">
              <div class="space-y-2 mb-3">
              <div class="grid grid-cols-[24px_minmax(0,1fr)_minmax(0,1fr)_56px] gap-3 text-xs text-gray-400 uppercase tracking-wide px-1">
                <span></span><span>Code</span><span>Name</span><span class="text-center">Active</span>
              </div>
              <div
                v-for="(item, idx) in versionItems"
                :key="idx"
                class="grid grid-cols-[24px_minmax(0,1fr)_minmax(0,1fr)_56px] gap-3 items-center"
                :data-testid="`dictionary-item-row-${idx}`"
                draggable="true"
                @dragstart="onDragStart(item)"
                @dragover.prevent="onDragOver(item)"
                @drop.prevent="onDrop"
              >
                <div class="flex justify-center">
                  <span class="text-gray-600 cursor-grab select-none">⠿</span>
                </div>
                <input v-model="item.value_code" type="text" class="bg-chat-input border border-chat-border rounded px-2 py-1.5 text-white text-sm font-mono outline-none focus:border-accent" placeholder="code" />
                <input v-model="item.value_name" type="text" class="bg-chat-input border border-chat-border rounded px-2 py-1.5 text-white text-sm outline-none focus:border-accent" placeholder="Name" />
                <div class="flex justify-center">
                  <button
                    class="relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200"
                    :class="item.is_active ? 'bg-accent' : 'bg-white/20'"
                    @click="item.is_active = !item.is_active"
                  >
                    <span class="pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition duration-200" :class="item.is_active ? 'translate-x-4' : 'translate-x-0'" />
                  </button>
                </div>
              </div>
              </div>
            </div>
            <button class="w-full py-1.5 text-sm text-gray-400 hover:text-white border border-dashed border-white/20 rounded hover:border-white/40 transition-colors mt-4 mb-4 shrink-0" @click="addItem">+ Add Item</button>
            <div v-if="versionError" class="text-red-400 text-sm mb-3 shrink-0">{{ versionError }}</div>
            <div class="flex gap-3 shrink-0">
              <button class="flex-1 py-2 rounded bg-white/10 hover:bg-white/20 text-gray-200 text-sm transition-colors" @click="versionOpen = false">Cancel</button>
              <button class="flex-1 py-2 rounded bg-accent hover:bg-accent-hover text-white text-sm font-medium transition-colors" :disabled="versionLoading" @click="submitVersion">
                {{ versionLoading ? 'Saving...' : 'Save Changes' }}
              </button>
            </div>
          </template>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import {
  tasksListDictionaries, tasksCreateDictionary, tasksUpdateDictionary,
  tasksListDictionaryVersions, tasksCreateDictionaryVersion, tasksGetDictionaryVersionItems,
  type EnumDictionary, type EnumDictionaryVersion, type EnumDictionaryVersionItem,
} from '@/services/http/tasksApi'

const dictionaries = ref<EnumDictionary[]>([])
const loading = ref(false)
const listError = ref<string | null>(null)

// Version panel
const activeDictId = ref<string | null>(null)
const versions = ref<EnumDictionaryVersion[]>([])
const versionsLoading = ref(false)
const versionsError = ref<string | null>(null)
const activeItems = ref<EnumDictionaryVersionItem[]>([])
const itemsError = ref<string | null>(null)

// Create dialog
const createOpen = ref(false)
const createLoading = ref(false)
const createError = ref<string | null>(null)
const createForm = ref({ code: '', name: '', is_public: false, participates_in_filtration: false })
const toggleLoadingById = ref<Record<string, boolean>>({})

// Dictionary items dialog
const versionOpen = ref(false)
const versionLoading = ref(false)
const versionError = ref<string | null>(null)
const versionDictId = ref<string | null>(null)
const versionDictCode = ref('')
const versionItems = ref<{ value_code: string; value_name: string; sort_order: number; is_active: boolean }[]>([])
const dragSource = ref<{ value_code: string; value_name: string; sort_order: number; is_active: boolean } | null>(null)
const dragOver = ref<{ value_code: string; value_name: string; sort_order: number; is_active: boolean } | null>(null)

async function load() {
  loading.value = true
  listError.value = null
  try {
    dictionaries.value = await tasksListDictionaries()
  } catch (e: unknown) {
    listError.value = e instanceof Error ? e.message : 'Failed to load dictionaries'
  } finally {
    loading.value = false
  }
}

function openCreate() {
  createForm.value = { code: '', name: '', is_public: false, participates_in_filtration: false }
  createError.value = null
  createOpen.value = true
}

async function submitCreate() {
  createLoading.value = true
  createError.value = null
  try {
    await tasksCreateDictionary(createForm.value)
    createOpen.value = false
    await load()
  } catch (e: unknown) {
    createError.value = e instanceof Error ? e.message : 'Failed to create dictionary'
  } finally {
    createLoading.value = false
  }
}

async function toggleDictionarySetting(
  dictionary: EnumDictionary,
  field: 'is_public' | 'participates_in_filtration',
) {
  toggleLoadingById.value = { ...toggleLoadingById.value, [dictionary.id]: true }
  listError.value = null
  try {
    const updated = await tasksUpdateDictionary(dictionary.id, {
      is_public: field === 'is_public' ? !dictionary.is_public : dictionary.is_public,
      participates_in_filtration: field === 'participates_in_filtration'
        ? !dictionary.participates_in_filtration
        : dictionary.participates_in_filtration,
    })
    dictionaries.value = dictionaries.value.map(item => item.id === updated.id ? updated : item)
  } catch (e: unknown) {
    listError.value = e instanceof Error ? e.message : 'Failed to update dictionary'
  } finally {
    toggleLoadingById.value = { ...toggleLoadingById.value, [dictionary.id]: false }
  }
}

async function openVersions(id: string) {
  activeDictId.value = id
  activeItems.value = []
  itemsError.value = null
  versionsLoading.value = true
  versionsError.value = null
  try {
    versions.value = await tasksListDictionaryVersions(id)
  } catch (e: unknown) {
    versionsError.value = e instanceof Error ? e.message : 'Failed to load versions'
  } finally {
    versionsLoading.value = false
  }
}

async function loadItems(dictId: string, versionId: string) {
  itemsError.value = null
  try {
    activeItems.value = await tasksGetDictionaryVersionItems(dictId, versionId)
  } catch (e: unknown) {
    itemsError.value = e instanceof Error ? e.message : 'Failed to load items'
  }
}

async function openNewVersion(d: EnumDictionary) {
  versionDictId.value = d.id
  versionDictCode.value = d.code
  versionError.value = null
  versionLoading.value = true
  versionOpen.value = false

  try {
    // Backend returns versions newest-first.
    const versions = await tasksListDictionaryVersions(d.id)

    if (versions.length > 0) {
      const latestVersion = versions[0]
      const items = await tasksGetDictionaryVersionItems(d.id, latestVersion.id)

      // Prefill with the latest item order; drag-and-drop will renumber on save.
      versionItems.value = items.map(item => ({
        value_code: item.value_code,
        value_name: item.value_name,
        sort_order: item.sort_order,
        is_active: item.is_active
      }))
    } else {
      // No previous version, start with empty item
      versionItems.value = [{ value_code: '', value_name: '', sort_order: 1, is_active: true }]
    }
    versionOpen.value = true
  } catch (e: unknown) {
    versionItems.value = []
    versionError.value = e instanceof Error ? e.message : 'Failed to load current items'
    listError.value = versionError.value
  } finally {
    versionLoading.value = false
  }
}

function addItem() {
  versionItems.value.push({ value_code: '', value_name: '', sort_order: versionItems.value.length + 1, is_active: true })
}

function onDragStart(item: { value_code: string; value_name: string; sort_order: number; is_active: boolean }) {
  dragSource.value = item
}

function onDragOver(item: { value_code: string; value_name: string; sort_order: number; is_active: boolean }) {
  dragOver.value = item
}

function renumberItems(items: { value_code: string; value_name: string; sort_order: number; is_active: boolean }[]) {
  return items.map((item, idx) => ({
    ...item,
    sort_order: idx + 1,
  }))
}

function onDrop() {
  const src = dragSource.value
  const tgt = dragOver.value
  dragSource.value = null
  dragOver.value = null

  if (!src || !tgt || src === tgt) return

  const srcIdx = versionItems.value.indexOf(src)
  const tgtIdx = versionItems.value.indexOf(tgt)
  if (srcIdx === -1 || tgtIdx === -1) return

  const reordered = [...versionItems.value]
  reordered.splice(srcIdx, 1)
  reordered.splice(tgtIdx, 0, src)
  versionItems.value = renumberItems(reordered)
}

async function submitVersion() {
  versionLoading.value = true
  versionError.value = null
  try {
    await tasksCreateDictionaryVersion(versionDictId.value!, renumberItems(versionItems.value))
    versionOpen.value = false
    await load()
    if (activeDictId.value && activeDictId.value === versionDictId.value) {
      await openVersions(activeDictId.value)
    }
  } catch (e: unknown) {
    versionError.value = e instanceof Error ? e.message : 'Failed to save items'
  } finally {
    versionLoading.value = false
  }
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return iso
  }
}

onMounted(load)
</script>
