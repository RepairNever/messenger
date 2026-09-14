<template>
  <!-- View mode -->
  <template v-if="mode === 'view'">
    <span v-if="isEmpty" class="text-gray-500 italic text-sm">—</span>

    <span v-else-if="field.type === 'text'" class="text-sm text-gray-200 whitespace-pre-wrap">{{ value }}</span>

    <span v-else-if="field.type === 'number'" class="text-sm text-gray-200">{{ value }}</span>

    <span v-else-if="field.type === 'date'" class="text-sm text-gray-200">{{ formatDate(value as string) }}</span>

    <span v-else-if="field.type === 'datetime'" class="text-sm text-gray-200">{{ formatDatetime(value as string) }}</span>

    <span v-else-if="field.type === 'user'" class="inline-flex items-center gap-2 text-sm text-gray-200">
      <UserAvatar
        :user-id="(value as string) || ''"
        :display-name="resolveUser(value as string)"
        :avatar-url="resolveUserAvatar(value as string)"
        :custom-status="null"
        size="xs"
      />
      <span
        v-if="activeStatus(resolveUserCustomStatus(value as string))"
        class="shrink-0 text-base leading-none"
        :title="statusTitle(activeStatus(resolveUserCustomStatus(value as string)))"
        :aria-label="statusTitle(activeStatus(resolveUserCustomStatus(value as string)))"
      >
        {{ activeStatus(resolveUserCustomStatus(value as string))?.emoji }}
      </span>
      <span>{{ resolveUser(value as string) }}</span>
    </span>

    <span v-else-if="field.type === 'users'" class="inline-flex flex-wrap gap-2 text-sm text-gray-200">
      <span v-for="userId in ((value as string[]) ?? [])" :key="userId" class="inline-flex items-center gap-1.5">
        <UserAvatar
          :user-id="userId"
          :display-name="resolveUser(userId)"
          :avatar-url="resolveUserAvatar(userId)"
          :custom-status="null"
          size="xs"
        />
        <span
          v-if="activeStatus(resolveUserCustomStatus(userId))"
          class="shrink-0 text-base leading-none"
          :title="statusTitle(activeStatus(resolveUserCustomStatus(userId)))"
          :aria-label="statusTitle(activeStatus(resolveUserCustomStatus(userId)))"
        >
          {{ activeStatus(resolveUserCustomStatus(userId))?.emoji }}
        </span>
        <span>{{ resolveUser(userId) }}</span>
      </span>
    </span>

    <span v-else-if="field.type === 'enum'" class="text-sm text-gray-200">{{ resolveEnumLabel(value as string) }}</span>

    <span v-else-if="field.type === 'multi_enum'" class="text-sm text-gray-200">
      {{ (value as string[]).map(resolveEnumLabel).join(', ') }}
    </span>
  </template>

  <!-- Edit mode -->
  <template v-else>
    <input
      v-if="field.type === 'text'"
      :value="value as string"
      type="text"
      class="field-input"
      :placeholder="field.name"
      @input="emit('update:value', ($event.target as HTMLInputElement).value)"
    />

    <input
      v-else-if="field.type === 'number'"
      :value="value as string"
      type="number"
      class="field-input"
      :placeholder="field.name"
      @input="emit('update:value', ($event.target as HTMLInputElement).value)"
    />

    <input
      v-else-if="field.type === 'date'"
      :value="value as string"
      type="date"
      class="field-input"
      @input="emit('update:value', ($event.target as HTMLInputElement).value)"
    />

    <input
      v-else-if="field.type === 'datetime'"
      :value="value as string"
      type="datetime-local"
      class="field-input"
      @input="emit('update:value', ($event.target as HTMLInputElement).value)"
    />

    <div
      v-else-if="isCopyableDropdownField"
      class="field-dropdown-stack"
    >
      <div class="field-dropdown-label-row">
        <div class="min-w-0 flex-1">
          <slot name="label" />
        </div>
        <button
          type="button"
          class="field-copy-button"
          :disabled="!canCopySelected"
          :title="canCopySelected ? 'Copy selected values' : 'No selected values to copy'"
          aria-label="Copy selected values"
          data-testid="task-field-copy-selected"
          @click="copySelectedLabels"
        >
          <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
        </button>
      </div>

      <MultiSelect
        v-if="field.type === 'user'"
        class="min-w-0 w-full"
        :model-value="(value ? [value as string] : [])"
        :options="userOptions"
        placeholder="— select user —"
        single
        @update:model-value="emit('update:value', $event[0] || null)"
      />

      <MultiSelect
        v-else-if="field.type === 'users'"
        class="min-w-0 w-full"
        :model-value="(value as string[] | null) ?? []"
        :options="userOptions"
        placeholder="— select users —"
        @update:model-value="emit('update:value', $event)"
      />

      <MultiSelect
        v-else-if="field.type === 'enum'"
        class="min-w-0 w-full"
        :model-value="(value ? [value as string] : [])"
        :options="enumOptions"
        placeholder="— select value —"
        :allow-create="canCreateEnumItem"
        :loading="creatingEnumItem || enumItemsLoading"
        server-search
        create-label="Add"
        single
        @update:model-value="emit('update:value', $event[0] || null)"
        @create="emit('create:enum-item', $event)"
        @search-change="emit('search:enum-items', $event)"
      />

      <MultiSelect
        v-else-if="field.type === 'multi_enum'"
        class="min-w-0 w-full"
        :model-value="(value as string[] | null) ?? []"
        :options="enumOptions"
        placeholder="— select values —"
        :allow-create="canCreateEnumItem"
        :loading="creatingEnumItem || enumItemsLoading"
        server-search
        create-label="Add"
        @update:model-value="emit('update:value', $event)"
        @create="emit('create:enum-item', $event)"
        @search-change="emit('search:enum-items', $event)"
      />
    </div>
  </template>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { TaskFieldDefinition, TaskUser, EnumDictionary, EnumDictionaryVersionItem } from '@/services/http/tasksApi'
import MultiSelect from './MultiSelect.vue'
import UserAvatar from '@/components/UserAvatar.vue'
import {
  formatUserCustomStatusTitle,
  isUserCustomStatusActive,
  userCustomStatusFromDto,
  type UserCustomStatus,
} from '@/types/userStatus'

interface SelectOption {
  value: string
  label: string
  searchText?: string
}

const props = defineProps<{
  field: TaskFieldDefinition
  value: unknown
  mode: 'view' | 'edit'
  /** Injected from the store — only required for user/users field types */
  users?: TaskUser[]
  /** Injected from the store — only required for enum/multi_enum field types */
  enumItems?: EnumDictionaryVersionItem[]
  enumKnownItems?: EnumDictionaryVersionItem[]
  enumDictionary?: EnumDictionary
  creatingEnumItem?: boolean
  enumItemsLoading?: boolean
}>()

const emit = defineEmits<{
  'update:value': [value: unknown]
  'create:enum-item': [value: string]
  'search:enum-items': [query: string]
}>()

const isEmpty = computed(() => {
  const v = props.value
  if (v === null || v === undefined || v === '') return true
  if (Array.isArray(v) && v.length === 0) return true
  return false
})

// ---- Users ----
const userOptions = computed(() =>
  (props.users ?? []).map(u => ({
    value: u.id,
    label: u.display_name || u.email,
    userId: u.id,
    avatarUrl: u.avatar_url,
    customStatus: userCustomStatusFromDto(u.custom_status),
  })),
)

function resolveUser(id: string): string {
  const u = props.users?.find(u => u.id === id)
  return u ? (u.display_name || u.email) : id
}

function resolveUserAvatar(id: string): string {
  const u = props.users?.find(u => u.id === id)
  return u?.avatar_url ?? ''
}

function resolveUserCustomStatus(id: string) {
  const u = props.users?.find(u => u.id === id)
  return userCustomStatusFromDto(u?.custom_status)
}

function activeStatus(status: UserCustomStatus | null | undefined): UserCustomStatus | null {
  return isUserCustomStatusActive(status) && status.emoji.trim() ? status : null
}

function statusTitle(status: UserCustomStatus | null): string {
  return status ? formatUserCustomStatusTitle(status) : ''
}

// ---- Enum ----
const activeEnumItems = computed(() =>
  (props.enumItems ?? []).filter(i => i.is_active),
)

const knownActiveEnumItems = computed(() =>
  (props.enumKnownItems ?? props.enumItems ?? []).filter(i => i.is_active),
)

const selectedEnumCodes = computed(() => {
  if (props.field.type === 'enum') {
    return props.value ? [props.value as string] : []
  }
  if (props.field.type === 'multi_enum') {
    return Array.isArray(props.value) ? props.value as string[] : []
  }
  return []
})

const enumOptions = computed<SelectOption[]>(() =>
  {
    const merged = new Map<string, SelectOption>()
    for (const item of activeEnumItems.value) {
      merged.set(item.value_code, {
        value: item.value_code,
        label: item.value_name,
      })
    }
    for (const code of selectedEnumCodes.value) {
      const selectedItem = knownActiveEnumItems.value.find(item => item.value_code === code)
      if (merged.has(code)) continue
      if (!selectedItem) {
        merged.set(code, {
          value: code,
          label: code,
        })
        continue
      }
      merged.set(code, {
        value: selectedItem.value_code,
        label: selectedItem.value_name,
      })
    }
    return Array.from(merged.values())
  },
)

const canCreateEnumItem = computed(() =>
  !!props.enumDictionary?.is_public,
)

const isCopyableDropdownField = computed(() =>
  props.field.type === 'user' ||
  props.field.type === 'users' ||
  props.field.type === 'enum' ||
  props.field.type === 'multi_enum',
)

const selectedCopyLabels = computed(() => {
  if (props.field.type === 'user') {
    return props.value ? [resolveUser(props.value as string)] : []
  }
  if (props.field.type === 'users') {
    return Array.isArray(props.value) ? (props.value as string[]).map(resolveUser) : []
  }
  if (props.field.type === 'enum') {
    return props.value ? [resolveEnumLabel(props.value as string)] : []
  }
  if (props.field.type === 'multi_enum') {
    return Array.isArray(props.value) ? (props.value as string[]).map(resolveEnumLabel) : []
  }
  return []
})

const canCopySelected = computed(() => selectedCopyLabels.value.length > 0)

function copySelectedLabels() {
  if (!canCopySelected.value || !navigator.clipboard) return
  void navigator.clipboard.writeText(selectedCopyLabels.value.join(', '))
}

function resolveEnumLabel(code: string): string {
  const item = (props.enumKnownItems ?? props.enumItems)?.find(i => i.value_code === code)
  return item ? item.value_name : code
}

// ---- Formatters ----
function formatDate(v: string): string {
  return v ? new Date(v).toLocaleDateString() : ''
}

function formatDatetime(v: string): string {
  return v ? new Date(v).toLocaleString() : ''
}
</script>

<style scoped>
.field-input {
  @apply w-full bg-chat-input border border-chat-border rounded px-3 py-1.5 text-white text-sm outline-none focus:border-accent transition-colors;
}

.field-dropdown-stack {
  @apply space-y-1;
}

.field-dropdown-label-row {
  @apply flex items-center gap-2;
}

.field-copy-button {
  @apply flex h-5 w-5 shrink-0 items-center justify-center rounded border border-transparent bg-transparent text-app-secondaryText transition-colors hover:border-chat-border hover:bg-chat-input hover:text-app-text disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-transparent disabled:hover:bg-transparent disabled:hover:text-app-secondaryText;
}
</style>
