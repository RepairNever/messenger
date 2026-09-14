<template>
  <div>
    <div
      class="group flex items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors"
      :class="selectedDocumentId === node.id ? 'bg-sidebar-active text-white' : 'text-sidebar-text hover:bg-sidebar-hover'"
      :style="{ paddingLeft: `${8 + (level * 14)}px` }"
      :data-document-node-id="node.id"
    >
      <button
        v-if="hasChildren"
        type="button"
        class="flex h-4 w-4 shrink-0 items-center justify-center rounded text-sidebar-textMuted transition-colors hover:bg-sidebar-hover hover:text-sidebar-text"
        :data-testid="`documents-node-toggle-${node.id}`"
        @click.stop="$emit('toggleCollapse', node.id)"
      >
        <svg
          class="h-3 w-3 shrink-0 transition-transform"
          :class="isCollapsed ? '' : 'rotate-90'"
          fill="currentColor"
          viewBox="0 0 20 20"
        >
          <path
            fill-rule="evenodd"
            d="M7.21 14.77a.75.75 0 0 1 .02-1.06L11.168 10 7.23 6.29a.75.75 0 1 1 1.04-1.08l4.5 4.25a.75.75 0 0 1 0 1.08l-4.5 4.25a.75.75 0 0 1-1.06-.02z"
            clip-rule="evenodd"
          />
        </svg>
      </button>
      <span v-else class="h-4 w-4 shrink-0" aria-hidden="true" />
      <button
        type="button"
        class="min-w-0 flex-1 truncate text-left"
        :data-testid="`documents-node-${node.id}`"
        @click="openDocumentRow"
      >
        {{ node.title }}
      </button>
      <button
        type="button"
        class="hidden h-5 w-5 shrink-0 items-center justify-center rounded transition disabled:opacity-50 group-hover:flex group-focus-within:flex"
        :class="node.is_favorite
          ? 'text-yellow-300 hover:bg-sidebar-hover hover:text-yellow-200'
          : 'text-sidebar-textMuted hover:bg-sidebar-hover hover:text-yellow-300'"
        :data-testid="`documents-node-favorite-toggle-${node.id}`"
        :title="node.is_favorite ? 'Remove from favorites' : 'Add to favorites'"
        :aria-label="node.is_favorite ? 'Remove from favorites' : 'Add to favorites'"
        :disabled="favoriteLoading"
        @click.stop="toggleFavoriteFromRow"
      >
        <svg
          v-if="node.is_favorite"
          class="h-3.5 w-3.5"
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
          :data-testid="`documents-node-favorite-filled-${node.id}`"
        >
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.175 3.617a1 1 0 0 0 .95.69h3.804c.969 0 1.371 1.24.588 1.81l-3.078 2.237a1 1 0 0 0-.364 1.118l1.176 3.617c.299.921-.756 1.688-1.54 1.118l-3.077-2.236a1 1 0 0 0-1.176 0l-3.077 2.236c-.784.57-1.839-.197-1.54-1.118l1.176-3.617a1 1 0 0 0-.364-1.118L2.526 9.044c-.783-.57-.38-1.81.588-1.81h3.804a1 1 0 0 0 .95-.69l1.181-3.617z" />
        </svg>
        <svg
          v-else
          class="h-3.5 w-3.5"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linejoin="round"
          aria-hidden="true"
          :data-testid="`documents-node-favorite-outline-${node.id}`"
        >
          <path d="M10 2.75l2.11 4.28 4.72.69-3.41 3.32.8 4.7L10 13.52l-4.22 2.22.8-4.7-3.41-3.32 4.72-.69L10 2.75z" />
        </svg>
      </button>
      <button
        type="button"
        class="hidden h-5 w-5 shrink-0 items-center justify-center rounded text-sidebar-textMuted transition-opacity group-hover:flex group-focus-within:flex hover:bg-sidebar-hover hover:text-sidebar-text"
        :data-testid="`documents-node-add-${node.id}`"
        title="Add child document"
        @click.stop="$emit('addChild', node.id)"
      >
        +
      </button>
      <button
        ref="menuButtonRef"
        type="button"
        class="hidden h-5 w-5 shrink-0 items-center justify-center rounded text-sidebar-textMuted transition-opacity group-hover:flex group-focus-within:flex hover:bg-sidebar-hover hover:text-sidebar-text"
        :data-testid="`documents-node-menu-${node.id}`"
        title="Document actions"
        @click.stop="toggleMenu"
      >
        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="5" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="12" cy="19" r="1.8" />
        </svg>
      </button>
    </div>
    <p
      v-if="favoriteError"
      class="py-1 pr-2 text-xs text-red-400"
      :style="{ paddingLeft: `${30 + (level * 14)}px` }"
    >
      {{ favoriteError }}
    </p>

    <div v-if="hasChildren && !isCollapsed">
      <DocumentsTreeNode
        v-for="child in childNodes"
        :key="child.id"
        :node="child"
        :level="level + 1"
        :selected-document-id="selectedDocumentId"
        :collapsed-document-ids="collapsedDocumentIds"
        @open-document="$emit('openDocument', $event)"
        @add-child="$emit('addChild', $event)"
        @toggle-collapse="$emit('toggleCollapse', $event)"
        @documents-deleted="$emit('documentsDeleted', $event)"
      />
    </div>
  </div>

  <Teleport to="body">
    <div v-if="menuOpen" class="fixed inset-0 z-50" @click="closeMenu">
      <div
        class="fixed min-w-[180px] rounded-lg border border-chat-border bg-chat-header p-1 shadow-2xl"
        :style="{ top: `${menuPosition.top}px`, left: `${menuPosition.left}px` }"
        @click.stop
      >
        <button
          type="button"
          class="flex w-full items-center rounded px-3 py-2 text-left text-sm text-red-300 transition-colors hover:bg-red-500/10 hover:text-red-200"
          @click="openDeleteConfirm"
        >
          Delete
        </button>
      </div>
    </div>
  </Teleport>

  <Teleport to="body">
    <div
      v-if="deleteConfirmOpen"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      @click.self="closeDeleteConfirm"
    >
      <div class="w-full max-w-sm rounded-xl border border-chat-border bg-chat-header p-5 shadow-2xl">
        <h3 class="text-base font-semibold text-white">Delete document?</h3>
        <p class="mt-2 text-sm text-gray-300">
          This will delete "{{ node.title }}" and all nested child documents.
        </p>
        <p v-if="deleteError" class="mt-3 text-xs text-red-400">{{ deleteError }}</p>
        <div class="mt-4 flex justify-end gap-2">
          <button
            type="button"
            class="rounded border border-chat-border px-3 py-1.5 text-sm text-gray-300 transition-colors hover:text-white"
            :disabled="deleteLoading"
            @click="closeDeleteConfirm"
          >
            Cancel
          </button>
          <button
            type="button"
            class="rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50"
            :disabled="deleteLoading"
            @click="confirmDelete"
          >
            {{ deleteLoading ? 'Deleting...' : 'Delete' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { SidebarDocumentNode } from '@/services/http/documentsApi'
import { useDocumentsStore } from '@/stores/documents'
import { normalizeDocumentNodes } from '@/utils/documentsUtils'

const props = defineProps<{
  node: SidebarDocumentNode
  level: number
  selectedDocumentId: string | null
  collapsedDocumentIds: string[]
}>()

const documentsStore = useDocumentsStore()
const childNodes = computed(() => normalizeDocumentNodes(props.node.children))
const hasChildren = computed(() => childNodes.value.length > 0)
const isCollapsed = computed(() => props.collapsedDocumentIds.includes(props.node.id))
const menuOpen = ref(false)
const deleteConfirmOpen = ref(false)
const deleteLoading = ref(false)
const deleteError = ref('')
const favoriteLoading = ref(false)
const favoriteError = ref('')
const menuButtonRef = ref<HTMLButtonElement | null>(null)
const menuPosition = ref({ top: 0, left: 0 })

const emit = defineEmits<{
  openDocument: [id: string]
  addChild: [id: string]
  toggleCollapse: [id: string]
  documentsDeleted: [ids: string[]]
}>()

function openDocumentRow() {
  closeMenu()
  emit('openDocument', props.node.id)
}

function toggleMenu() {
  if (menuOpen.value) {
    closeMenu()
    return
  }
  const rect = menuButtonRef.value?.getBoundingClientRect()
  if (rect) {
    menuPosition.value = {
      top: rect.bottom + 6,
      left: Math.max(8, rect.right - 180),
    }
  }
  menuOpen.value = true
}

function closeMenu() {
  menuOpen.value = false
}

function openDeleteConfirm() {
  closeMenu()
  deleteError.value = ''
  deleteConfirmOpen.value = true
}

async function setFavoriteState(isFavorite: boolean): Promise<boolean> {
  favoriteLoading.value = true
  favoriteError.value = ''
  try {
    if (isFavorite) {
      await documentsStore.favoriteDocument(props.node.id)
    } else {
      await documentsStore.unfavoriteDocument(props.node.id)
    }
    return true
  } catch (e) {
    favoriteError.value = e instanceof Error ? e.message : 'Failed to update favorite'
    return false
  } finally {
    favoriteLoading.value = false
  }
}

async function toggleFavoriteFromRow() {
  await setFavoriteState(!props.node.is_favorite)
}

function closeDeleteConfirm() {
  if (deleteLoading.value) return
  deleteConfirmOpen.value = false
  deleteError.value = ''
}

function collectSubtreeIds(node: SidebarDocumentNode): string[] {
  return [node.id, ...normalizeDocumentNodes(node.children).flatMap(child => collectSubtreeIds(child))]
}

async function confirmDelete() {
  deleteLoading.value = true
  deleteError.value = ''
  try {
    await documentsStore.deleteDocument(props.node.id)
    deleteConfirmOpen.value = false
    emit('documentsDeleted', collectSubtreeIds(props.node))
  } catch (e) {
    deleteError.value = e instanceof Error ? e.message : 'Failed to delete document'
  } finally {
    deleteLoading.value = false
  }
}
</script>
