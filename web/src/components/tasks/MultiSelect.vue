<template>
  <div ref="root" class="relative">
    <button
      type="button"
      class="multiselect-trigger"
      :class="[
        open ? 'border-accent' : '',
        disabled ? 'cursor-not-allowed opacity-60' : '',
      ]"
      :disabled="disabled"
      @click="toggleOpen"
    >
      <span v-if="selected.length === 0" class="text-gray-500 text-sm">{{ placeholder }}</span>
      <span v-else class="flex flex-wrap gap-1">
        <span
          v-for="item in selected"
          :key="item.value"
          class="inline-flex items-center gap-2 px-1.5 py-0.5 rounded bg-app-taskIdBg text-public_id"
        >
          <UserAvatar
            v-if="item.avatarUrl || item.userId"
            :user-id="item.userId || item.value"
            :display-name="item.label"
            :avatar-url="item.avatarUrl"
            :custom-status="null"
            size="xs"
            :presence="item.presence"
          />
          <span
            v-if="activeStatus(item.customStatus)"
            class="shrink-0 text-base leading-none"
            :title="statusTitle(activeStatus(item.customStatus))"
            :aria-label="statusTitle(activeStatus(item.customStatus))"
          >
            {{ activeStatus(item.customStatus)?.emoji }}
          </span>
          <span class="min-w-0 truncate">{{ item.label }}</span>
          <span
            class="leading-none hover:text-white"
            role="button"
            tabindex="0"
            @click.stop="deselect(item.value)"
            @keydown.enter.prevent.stop="deselect(item.value)"
          >
            ×
          </span>
        </span>
      </span>
      <svg
        class="ml-auto shrink-0 w-3.5 h-3.5 text-gray-500 transition-transform"
        :class="open ? 'rotate-180' : ''"
        fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"
      >
        <path d="m6 9 6 6 6-6"/>
      </svg>
    </button>

    <div
      v-if="open"
      class="absolute z-50 mt-1 w-full rounded border border-chat-border bg-chat-header shadow-xl"
    >
      <div class="p-2 border-b border-chat-border">
        <input
          ref="searchInput"
          v-model="query"
          type="text"
          class="w-full bg-chat-input border border-chat-border rounded px-2 py-1 text-white text-sm outline-none focus:border-accent"
          :placeholder="searchPlaceholder"
          @keydown="onSearchKeydown"
        >
      </div>

      <ul class="max-h-48 overflow-y-auto py-1">
        <li
          v-for="(item, index) in filtered"
          :key="item.value"
          class="flex items-center gap-2 px-3 py-1.5 cursor-pointer transition-colors"
          :class="index === activeIndex ? 'bg-white/10' : 'hover:bg-white/5'"
          @mouseenter="activeIndex = index"
          @click="toggleValue(item.value)"
        >
          <span
            class="flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors"
            :class="isSelected(item.value)
              ? 'border-accent bg-accent'
              : 'border-chat-border'"
          >
            <svg
              v-if="isSelected(item.value)"
              class="w-2.5 h-2.5 text-white"
              fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24"
            >
              <path d="M20 6 9 17l-5-5"/>
            </svg>
          </span>
          <UserAvatar
            v-if="item.avatarUrl || item.userId"
            :user-id="item.userId || item.value"
            :display-name="item.label"
            :avatar-url="item.avatarUrl"
            :custom-status="null"
            size="xs"
            :presence="item.presence"
          />
          <span
            v-if="activeStatus(item.customStatus)"
            class="shrink-0 text-base leading-none"
            :title="statusTitle(activeStatus(item.customStatus))"
            :aria-label="statusTitle(activeStatus(item.customStatus))"
          >
            {{ activeStatus(item.customStatus)?.emoji }}
          </span>
          <span class="min-w-0 flex-1 truncate text-sm text-gray-200">{{ item.label }}</span>
        </li>

        <li
          v-if="showCreate"
          class="px-3 py-1.5 cursor-pointer transition-colors text-sm text-accent"
          :class="activeIndex === filtered.length ? 'bg-white/10' : 'hover:bg-white/5'"
          @mouseenter="activeIndex = filtered.length"
          @click="emitCreate"
        >
          {{ createLabelText }}
        </li>

        <li v-if="!loading && filtered.length === 0 && !showCreate" class="px-3 py-2 text-sm text-gray-500">
          No results
        </li>
        <li v-if="loading" class="px-3 py-2 text-sm text-gray-500">
          Loading...
        </li>
      </ul>

      <div
        v-if="showSearchHint"
        class="border-t border-chat-border px-3 py-2 text-xs text-gray-500"
      >
        {{ searchHintText }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import UserAvatar from '@/components/UserAvatar.vue'
import {
  formatUserCustomStatusTitle,
  isUserCustomStatusActive,
  type UserCustomStatus,
} from '@/types/userStatus'

export interface MultiSelectOption {
  value: string
  label: string
  searchText?: string
  userId?: string
  avatarUrl?: string
  customStatus?: UserCustomStatus | null
  presence?: 'online' | 'away' | 'offline'
}

const props = withDefaults(defineProps<{
  options: MultiSelectOption[]
  modelValue: string[]
  placeholder?: string
  searchPlaceholder?: string
  single?: boolean
  disabled?: boolean
  loading?: boolean
  allowCreate?: boolean
  createLabel?: string
  initialDisplayLimit?: number
  serverSearch?: boolean
  searchDebounceMs?: number
}>(), {
  placeholder: 'Select values',
  searchPlaceholder: 'Search...',
  single: false,
  disabled: false,
  loading: false,
  allowCreate: false,
  createLabel: 'Add',
  initialDisplayLimit: 50,
  serverSearch: false,
  searchDebounceMs: 200,
})

const emit = defineEmits<{
  'update:modelValue': [value: string[]]
  create: [value: string]
  'search-change': [value: string]
}>()

const root = ref<HTMLElement | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)
const open = ref(false)
const query = ref('')
const activeIndex = ref(0)
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null

const normalizedQuery = computed(() => query.value.trim())

const selected = computed<MultiSelectOption[]>(() =>
  props.modelValue
    .map(v => props.options.find(o => o.value === v))
    .filter((o): o is MultiSelectOption => o !== undefined),
)

function matchesQuery(option: MultiSelectOption, q: string): boolean {
  const haystack = `${option.label} ${option.value} ${option.searchText ?? ''}`.toLowerCase()
  return haystack.includes(q)
}

const exactMatch = computed(() => {
  const q = normalizedQuery.value.toLowerCase()
  if (!q) return false
  return props.options.some(option => {
    const valueMatch = option.value.toLowerCase() === q
    const labelMatch = option.label.toLowerCase() === q
    return valueMatch || labelMatch
  })
})

const filtered = computed(() => {
  if (props.serverSearch) {
    return props.options
  }
  const q = normalizedQuery.value.toLowerCase()
  if (q) {
    return props.options.filter(option => matchesQuery(option, q))
  }
  const limited = props.options.slice(0, props.initialDisplayLimit)
  const selectedMissing = selected.value.filter(item => !limited.some(option => option.value === item.value))
  return [...selectedMissing, ...limited]
})

const showCreate = computed(() =>
  props.allowCreate &&
  !props.loading &&
  normalizedQuery.value !== '' &&
  !exactMatch.value,
)

const createLabelText = computed(() => `${props.createLabel} "${normalizedQuery.value}"`)
const showSearchHint = computed(() =>
  props.serverSearch
    ? !props.loading && normalizedQuery.value === ''
    : !normalizedQuery.value && props.options.length > props.initialDisplayLimit,
)
const searchHintText = computed(() =>
  props.serverSearch
    ? `Showing up to ${props.options.length} results. Type to search.`
    : `Showing first ${filtered.value.length} of ${props.options.length}. Type to search.`,
)

function isSelected(value: string): boolean {
  return props.modelValue.includes(value)
}

function activeStatus(status: UserCustomStatus | null | undefined): UserCustomStatus | null {
  return isUserCustomStatusActive(status) && status.emoji.trim() ? status : null
}

function statusTitle(status: UserCustomStatus | null): string {
  return status ? formatUserCustomStatusTitle(status) : ''
}

function resetActiveIndex() {
  activeIndex.value = filtered.value.length > 0 || showCreate.value ? 0 : -1
}

function toggleOpen() {
  if (props.disabled) return
  open.value = !open.value
  if (open.value) {
    query.value = ''
    resetActiveIndex()
    if (props.serverSearch) {
      emit('search-change', '')
    }
    nextTick(() => searchInput.value?.focus())
  }
}

function close() {
  open.value = false
}

function emitModelValue(next: string[]) {
  emit('update:modelValue', next)
}

function toggleValue(value: string) {
  let next: string[]
  if (props.single) {
    next = isSelected(value) ? [] : [value]
    emitModelValue(next)
    close()
    return
  }
  next = isSelected(value)
    ? props.modelValue.filter(v => v !== value)
    : [...props.modelValue, value]
  emitModelValue(next)
}

function deselect(value: string) {
  if (props.disabled) return
  emitModelValue(props.modelValue.filter(v => v !== value))
}

function emitCreate() {
  if (!showCreate.value) return
  emit('create', normalizedQuery.value)
}

function onSearchKeydown(event: KeyboardEvent) {
  const optionCount = filtered.value.length + (showCreate.value ? 1 : 0)
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    if (optionCount === 0) return
    activeIndex.value = activeIndex.value < optionCount - 1 ? activeIndex.value + 1 : 0
    return
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    if (optionCount === 0) return
    activeIndex.value = activeIndex.value > 0 ? activeIndex.value - 1 : optionCount - 1
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    if (activeIndex.value < 0) return
    if (activeIndex.value < filtered.value.length) {
      const option = filtered.value[activeIndex.value]
      if (option) toggleValue(option.value)
      return
    }
    if (showCreate.value) emitCreate()
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
  }
}

function onClickOutside(event: MouseEvent) {
  if (root.value && !root.value.contains(event.target as Node)) {
    close()
  }
}

watch(() => normalizedQuery.value, (value) => {
  resetActiveIndex()
  if (!open.value || !props.serverSearch) return
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer)
  }
  searchDebounceTimer = setTimeout(() => {
    emit('search-change', value)
  }, props.searchDebounceMs)
})
watch(() => props.options, () => resetActiveIndex(), { deep: true })

onMounted(() => document.addEventListener('mousedown', onClickOutside))
onUnmounted(() => {
  document.removeEventListener('mousedown', onClickOutside)
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer)
    searchDebounceTimer = null
  }
})
</script>

<style scoped>
.multiselect-trigger {
  @apply w-full flex flex-wrap items-center gap-1 min-h-[34px] bg-chat-input border border-chat-border rounded px-3 py-1.5 text-left outline-none transition-colors hover:border-accent/60;
}
</style>
