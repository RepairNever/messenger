<template>
  <div class="shrink-0 px-6 py-3 border-b border-chat-border space-y-2">
    <div class="flex items-center gap-3">
      <div class="relative flex-1 max-w-sm">
        <svg
          class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none"
          fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"
        >
          <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
        </svg>
        <input
          v-model="searchInput"
          type="text"
          placeholder="Search by ID, title, description…"
          class="w-full bg-chat-input border border-chat-border rounded pl-9 pr-3 py-1.5 text-sm text-white placeholder-gray-500 outline-none focus:border-accent"
          @input="onSearchInput"
        />
      </div>

      <button
        class="toolbar-btn"
        :class="filtersVisible ? 'border-accent/60 text-accent' : ''"
        @click="filtersVisible = !filtersVisible"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path d="M3 6h18M7 12h10M11 18h2" />
        </svg>
        Filters
        <span v-if="activeFilterCount > 0" class="ml-1 bg-accent text-white text-xs rounded-full px-1.5 py-0.5 leading-none">
          {{ activeFilterCount }}
        </span>
      </button>

      <slot name="after-controls" />

      <div class="flex-1" />

      <span class="text-xs text-gray-500">
        {{ total }} task{{ total === 1 ? '' : 's' }}
      </span>
    </div>

    <div v-if="filtersVisible" class="flex items-center gap-3 flex-wrap">
      <div class="relative" ref="statusDropdownEl">
        <button
          class="filter-chip"
          :class="selectedStatusIds.length ? 'active' : ''"
          @click="statusDropdownOpen = !statusDropdownOpen"
        >
          Status
          <span v-if="selectedStatusIds.length" class="filter-chip-count">{{ selectedStatusIds.length }}</span>
          <svg class="w-3 h-3 ml-1" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" /></svg>
        </button>
        <div v-if="statusDropdownOpen" class="dropdown-menu dropdown-menu--tall">
          <label v-for="s in tasksStore.activeStatuses" :key="s.id" class="dropdown-item">
            <input type="checkbox" :value="s.id" v-model="selectedStatusIds" class="mr-2 accent-accent" />
            {{ s.name }}
          </label>
          <div v-if="tasksStore.activeStatuses.length === 0" class="px-3 py-2 text-xs text-gray-500">No statuses</div>
        </div>
      </div>

      <div class="relative" ref="templateDropdownEl">
        <button
          class="filter-chip"
          :class="selectedTemplateId ? 'active' : ''"
          @click="templateDropdownOpen = !templateDropdownOpen"
        >
          Template
          <span v-if="selectedTemplateId" class="filter-chip-count font-mono">{{ selectedTemplatePrefix }}</span>
          <svg class="w-3 h-3 ml-1" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" /></svg>
        </button>
        <div v-if="templateDropdownOpen" class="dropdown-menu dropdown-menu--tall">
          <button class="dropdown-item w-full text-left" @click="selectTemplate(null)">
            <span :class="!selectedTemplateId ? 'text-accent' : ''">All templates</span>
          </button>
          <button
            v-for="t in tasksStore.activeTemplates"
            :key="t.id"
            class="dropdown-item w-full text-left font-mono"
            @click="selectTemplate(t.id)"
          >
            <span :class="selectedTemplateId === t.id ? 'text-accent' : ''">{{ t.prefix }}</span>
          </button>
        </div>
      </div>

      <div v-if="hasAssigneeFields" class="relative" ref="assigneeDropdownEl">
        <button
          class="filter-chip"
          :class="selectedAssigneeIds.length ? 'active' : ''"
          @click="assigneeDropdownOpen = !assigneeDropdownOpen"
        >
          Assignee
          <span v-if="selectedAssigneeIds.length" class="filter-chip-count">{{ selectedAssigneeIds.length }}</span>
          <svg class="w-3 h-3 ml-1" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" /></svg>
        </button>
        <div v-if="assigneeDropdownOpen" class="dropdown-menu dropdown-menu--tall dropdown-menu--assignee w-56">
          <div
            v-if="selectedAssigneeIds.length && !resolveAssigneeFieldId()"
            class="px-3 py-2 text-xs text-amber-400 border-b border-chat-border"
          >
            Select a template to apply this filter.
          </div>
          <div class="p-2 border-b border-chat-border">
            <input
              v-model="assigneeSearch"
              type="text"
              placeholder="Search users…"
              class="w-full bg-chat-bg border border-chat-border rounded px-2 py-1 text-white text-sm outline-none focus:border-accent"
            />
          </div>
          <div class="assignee-dropdown-list py-1">
            <div v-if="filteredUserOptions.length === 0" class="px-3 py-2 text-xs text-gray-500">No users found</div>
            <label
              v-for="u in filteredUserOptions"
              :key="u.value"
              class="dropdown-item cursor-pointer"
            >
              <input type="checkbox" :value="u.value" v-model="selectedAssigneeIds" class="mr-2 accent-accent shrink-0" />
              <UserAvatar
                :user-id="u.value"
                :display-name="u.label"
                :avatar-url="u.avatarUrl"
                :custom-status="null"
                size="xs"
              />
              <span
                v-if="activeStatus(u.customStatus)"
                class="shrink-0 text-base leading-none"
                :title="statusTitle(activeStatus(u.customStatus))"
                :aria-label="statusTitle(activeStatus(u.customStatus))"
              >
                {{ activeStatus(u.customStatus)?.emoji }}
              </span>
              <span class="truncate">{{ u.label }}</span>
            </label>
          </div>
        </div>
      </div>

      <div
        v-for="dictionary in tasksStore.filterableEnumDictionaries"
        :key="dictionary.id"
        class="relative"
        data-dictionary-filter-root="true"
      >
        <button
          class="filter-chip"
          :class="selectedDictionaryCodes(dictionary.id).length ? 'active' : ''"
          @click="toggleDictionaryDropdown(dictionary.id)"
        >
          {{ dictionary.name }}
          <span v-if="selectedDictionaryCodes(dictionary.id).length" class="filter-chip-count">{{ selectedDictionaryCodes(dictionary.id).length }}</span>
          <svg class="w-3 h-3 ml-1" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" /></svg>
        </button>
        <div v-if="dictionaryDropdownOpenById[dictionary.id]" class="dropdown-menu dropdown-menu--tall dropdown-menu--dictionary w-64">
          <div class="p-2 border-b border-chat-border">
            <input
              :value="dictionarySearchById[dictionary.id] ?? ''"
              type="text"
              placeholder="Search values..."
              class="w-full bg-chat-bg border border-chat-border rounded px-2 py-1 text-white text-sm outline-none focus:border-accent"
              @input="onDictionarySearchInput(dictionary.id, $event)"
            />
          </div>
          <div class="dictionary-dropdown-list py-1">
            <div v-if="filteredDictionaryItems(dictionary.id).length === 0" class="px-3 py-2 text-xs text-gray-500">No values found</div>
            <label
              v-for="item in filteredDictionaryItems(dictionary.id)"
              :key="item.value_code"
              class="dropdown-item cursor-pointer"
            >
              <input
                type="checkbox"
                class="mr-2 accent-accent shrink-0"
                :checked="selectedDictionaryCodes(dictionary.id).includes(item.value_code)"
                @change="setDictionaryCodeSelected(dictionary.id, item.value_code, $event)"
              />
              <span class="min-w-0 flex-1 truncate">{{ item.value_name }}</span>
              <span class="ml-2 shrink-0 font-mono text-[11px] text-gray-500">{{ item.value_code }}</span>
            </label>
          </div>
        </div>
      </div>

      <div v-if="showCreatedDateFilter" class="created-date-filters">
        <label class="created-date-filter">
          <span>Created from</span>
          <input
            v-model="createdFrom"
            type="date"
            aria-label="Created from"
            class="created-date-input"
            @change="emitFilters"
          />
        </label>
        <label class="created-date-filter">
          <span>Created to</span>
          <input
            v-model="createdTo"
            type="date"
            aria-label="Created to"
            class="created-date-input"
            @change="emitFilters"
          />
        </label>
      </div>

      <label
        class="inline-flex items-center gap-2 rounded border border-chat-border px-2.5 py-1 text-xs text-gray-300 transition-colors hover:border-accent/40 hover:text-white"
        :class="showSubtasks ? 'border-accent/60 text-accent' : ''"
      >
        <input
          v-model="showSubtasks"
          type="checkbox"
          class="h-3.5 w-3.5 rounded border-chat-border bg-chat-input accent-accent"
        />
        Show subtasks
      </label>

      <button v-if="activeFilterCount > 0" class="text-xs text-gray-500 hover:text-gray-300 transition-colors" @click="clearFilters">
        Clear all
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { DictionaryFilter, FieldFilter, TaskFilterPayload } from '@/services/http/tasksApi'
import { useTasksStore } from '@/stores/tasks'
import { useTaskFilters } from '@/composables/useTaskFilters'
import UserAvatar from '@/components/UserAvatar.vue'
import {
  formatUserCustomStatusTitle,
  isUserCustomStatusActive,
  userCustomStatusFromDto,
  type UserCustomStatus,
} from '@/types/userStatus'

const props = defineProps<{
  templateFilter: string | null
  total: number
  showCreatedDateFilter?: boolean
}>()

const emit = defineEmits<{
  filtersChange: [payload: TaskFilterPayload]
}>()

const tasksStore = useTasksStore()
const {
  searchInput,
  filtersVisible,
  selectedStatusIds,
  selectedTemplateId,
  selectedAssigneeIds,
  selectedDictionaryEnumCodes,
  createdFrom,
  createdTo,
  showSubtasks,
} = useTaskFilters()

const statusDropdownOpen = ref(false)
const templateDropdownOpen = ref(false)

const statusDropdownEl = ref<HTMLElement | null>(null)
const templateDropdownEl = ref<HTMLElement | null>(null)
const assigneeDropdownEl = ref<HTMLElement | null>(null)

const assigneeDropdownOpen = ref(false)
const assigneeSearch = ref('')
const dictionaryDropdownOpenById = ref<Record<string, boolean>>({})
const dictionarySearchById = ref<Record<string, string>>({})

const selectedTemplatePrefix = computed(() =>
  tasksStore.activeTemplates.find(t => t.id === selectedTemplateId.value)?.prefix ?? '',
)

const hasAssigneeFields = computed(() => tasksStore.assigneeFieldIds.length > 0)

const userOptions = computed(() =>
  tasksStore.users.map(u => ({
    value: u.id,
    label: u.display_name || u.email,
    avatarUrl: u.avatar_url,
    customStatus: userCustomStatusFromDto(u.custom_status),
  })),
)

const filteredUserOptions = computed(() => {
  const q = assigneeSearch.value.trim().toLowerCase()
  return q ? userOptions.value.filter(o => o.label.toLowerCase().includes(q)) : userOptions.value
})

function activeStatus(status: UserCustomStatus | null | undefined): UserCustomStatus | null {
  return isUserCustomStatusActive(status) && status.emoji.trim() ? status : null
}

function statusTitle(status: UserCustomStatus | null): string {
  return status ? formatUserCustomStatusTitle(status) : ''
}

const dictionaryActiveFilterCount = computed(() =>
  tasksStore.filterableEnumDictionaries.filter(dictionary => selectedDictionaryCodes(dictionary.id).length > 0).length,
)

const activeFilterCount = computed(() =>
  (selectedStatusIds.value.length > 0 ? 1 : 0) +
  (selectedTemplateId.value ? 1 : 0) +
  (selectedAssigneeIds.value.length > 0 ? 1 : 0) +
  dictionaryActiveFilterCount.value +
  (props.showCreatedDateFilter && (createdFrom.value || createdTo.value) ? 1 : 0) +
  (showSubtasks.value ? 1 : 0),
)

function resolveAssigneeFieldId(): string | null {
  const ids = tasksStore.assigneeFieldIds

  if (selectedTemplateId.value) {
    const templateFields = tasksStore.activeFieldsFor(selectedTemplateId.value)
    return templateFields.find(f => f.field_role === 'assignee')?.id ?? null
  }

  return ids.length === 1 ? ids[0] : null
}

function buildFilterPayload(): TaskFilterPayload {
  const prefix = selectedTemplateId.value
    ? tasksStore.activeTemplates.find(t => t.id === selectedTemplateId.value)?.prefix
    : undefined

  const resolvedAssigneeFieldId = resolveAssigneeFieldId()
  const fieldFilters: FieldFilter[] | undefined =
    selectedAssigneeIds.value.length && resolvedAssigneeFieldId
      ? [{ field_definition_id: resolvedAssigneeFieldId, user_ids: selectedAssigneeIds.value }]
      : undefined
  const dictionaryFilters: DictionaryFilter[] = tasksStore.filterableEnumDictionaries
    .map(dictionary => ({
      dictionary_id: dictionary.id,
      enum_codes: selectedDictionaryCodes(dictionary.id),
    }))
    .filter(filter => filter.enum_codes.length > 0)
  const createdDateFilters = props.showCreatedDateFilter
    ? {
        created_from: createdFrom.value || undefined,
        created_to: createdTo.value || undefined,
      }
    : {}

  return {
    search: searchInput.value.trim() || undefined,
    status_ids: selectedStatusIds.value.length ? selectedStatusIds.value : undefined,
    prefixes: prefix ? [prefix] : undefined,
    include_subtasks: showSubtasks.value,
    ...createdDateFilters,
    field_filters: fieldFilters,
    dictionary_filters: dictionaryFilters.length ? dictionaryFilters : undefined,
  }
}

function emitFilters() {
  emit('filtersChange', buildFilterPayload())
}

let searchTimer: ReturnType<typeof setTimeout> | null = null
function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(emitFilters, 300)
}

function selectTemplate(id: string | null) {
  selectedTemplateId.value = id
  templateDropdownOpen.value = false
  emitFilters()
}

function selectedDictionaryCodes(dictionaryId: string): string[] {
  return selectedDictionaryEnumCodes.value[dictionaryId] ?? []
}

function filteredDictionaryItems(dictionaryId: string) {
  const q = (dictionarySearchById.value[dictionaryId] ?? '').trim().toLowerCase()
  return tasksStore.enumItemsFor(dictionaryId)
    .filter(item => item.is_active)
    .filter(item => {
      if (!q) return true
      return item.value_name.toLowerCase().includes(q) || item.value_code.toLowerCase().includes(q)
    })
}

function toggleDictionaryDropdown(dictionaryId: string) {
  dictionaryDropdownOpenById.value = {
    ...dictionaryDropdownOpenById.value,
    [dictionaryId]: !dictionaryDropdownOpenById.value[dictionaryId],
  }
}

function closeDictionaryDropdowns() {
  if (!Object.values(dictionaryDropdownOpenById.value).some(Boolean)) return
  dictionaryDropdownOpenById.value = {}
}

function setDictionaryCodeSelected(dictionaryId: string, code: string, event: Event) {
  const selected = event.target instanceof HTMLInputElement ? event.target.checked : false
  const current = selectedDictionaryCodes(dictionaryId)
  const next = selected
    ? Array.from(new Set([...current, code]))
    : current.filter(item => item !== code)
  selectedDictionaryEnumCodes.value = {
    ...selectedDictionaryEnumCodes.value,
    [dictionaryId]: next,
  }
  emitFilters()
}

async function onDictionarySearchInput(dictionaryId: string, event: Event) {
  const query = event.target instanceof HTMLInputElement ? event.target.value : ''
  dictionarySearchById.value = {
    ...dictionarySearchById.value,
    [dictionaryId]: query,
  }
  await tasksStore.searchEnumItemsFor(dictionaryId, query, selectedDictionaryCodes(dictionaryId), 20)
}

function clearFilters() {
  selectedStatusIds.value = []
  selectedTemplateId.value = null
  selectedAssigneeIds.value = []
  selectedDictionaryEnumCodes.value = {}
  createdFrom.value = ''
  createdTo.value = ''
  showSubtasks.value = false
  emitFilters()
}

function onDocClick(e: MouseEvent) {
  if (statusDropdownEl.value && !statusDropdownEl.value.contains(e.target as Node)) {
    statusDropdownOpen.value = false
  }
  if (templateDropdownEl.value && !templateDropdownEl.value.contains(e.target as Node)) {
    templateDropdownOpen.value = false
  }
  if (assigneeDropdownEl.value && !assigneeDropdownEl.value.contains(e.target as Node)) {
    assigneeDropdownOpen.value = false
  }
  if (e.target instanceof Element && !e.target.closest('[data-dictionary-filter-root="true"]')) {
    closeDictionaryDropdowns()
  }
}

watch(selectedStatusIds, () => emitFilters(), { deep: true })
watch(selectedAssigneeIds, () => emitFilters(), { deep: true })
watch(showSubtasks, () => emitFilters())
watch(() => props.showCreatedDateFilter, () => emitFilters())

watch(() => props.templateFilter, (val) => {
  selectedTemplateId.value = val
  emitFilters()
})

onMounted(() => {
  document.addEventListener('click', onDocClick, true)
  tasksStore.loadConfig().then(async () => {
    if (props.templateFilter !== null) {
      selectedTemplateId.value = props.templateFilter
    }
    await Promise.all([
      tasksStore.loadAllTemplateFields(),
      tasksStore.loadUsers(),
      tasksStore.loadFilterableDictionaries(),
    ])
    await Promise.all(
      tasksStore.filterableEnumDictionaries.map(dictionary =>
        tasksStore.loadEnumItemsFor(dictionary.id, selectedDictionaryCodes(dictionary.id)),
      ),
    )
    emitFilters()
  })
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick, true)
  if (searchTimer) clearTimeout(searchTimer)
})
</script>

<style scoped>
.toolbar-btn {
  @apply flex items-center gap-1.5 px-3 py-1.5 rounded border border-chat-border text-sm text-gray-300
         hover:text-white hover:border-accent/40 transition-colors;
}
.filter-chip {
  @apply flex items-center gap-1 px-2.5 py-1 rounded border border-chat-border text-xs text-gray-400
         hover:border-accent/50 hover:text-white transition-colors;
}
.filter-chip.active {
  @apply border-accent/60 text-accent;
}
.filter-chip-count {
  @apply ml-1 bg-accent text-white text-xs rounded-full px-1.5 py-0.5 leading-none;
}
.dropdown-menu {
  @apply absolute top-full left-0 mt-1 min-w-[160px] bg-chat-input border border-chat-border
         rounded shadow-xl z-30 py-1 overflow-y-auto;
}
.dropdown-menu--tall {
  @apply max-h-72;
}
.dropdown-menu--assignee {
  @apply py-0 overflow-hidden flex flex-col;
}
.dropdown-menu--dictionary {
  @apply py-0 overflow-hidden flex flex-col;
}
.assignee-dropdown-list {
  @apply flex-1 min-h-0 overflow-y-auto;
}
.dictionary-dropdown-list {
  @apply flex-1 min-h-0 overflow-y-auto;
}
.dropdown-item {
  @apply flex items-center px-3 py-1.5 text-sm text-gray-200 hover:bg-white/10 cursor-pointer;
}
.created-date-filters {
  @apply flex items-center gap-2 rounded border border-chat-border px-2.5 py-1;
}
.created-date-filter {
  @apply flex items-center gap-1.5 text-xs text-gray-400;
}
.created-date-input {
  @apply h-7 w-32 rounded border border-chat-border bg-chat-input px-2 text-xs text-gray-200 outline-none transition-colors
         focus:border-accent;
}
</style>
