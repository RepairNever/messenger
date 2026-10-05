<template>
  <aside class="flex h-full w-full min-w-0 flex-col border-r border-white/10 bg-sidebar-bg select-none">
    <div class="border-b border-white/10 px-4 py-3">
      <div class="flex items-center justify-between">
        <span class="font-bold text-white text-[15px]">Documents</span>
      </div>
      <div class="relative mt-3">
        <svg
          class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          viewBox="0 0 24 24"
        >
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
        <input
          :value="searchQuery"
          type="text"
          placeholder="Search documents..."
          class="w-full rounded border border-white/10 bg-chat-input pl-9 pr-3 py-2 text-sm text-white placeholder-gray-500 outline-none transition-colors focus:border-accent"
          data-testid="documents-search-input"
          @input="emit('searchQueryChange', (($event.target as HTMLInputElement).value))"
        >
      </div>
    </div>

    <div
      class="shrink-0 border-b border-white/10 px-2 py-3"
      data-testid="documents-pinned-panel"
    >
      <button
        type="button"
        class="flex w-full items-center gap-2 rounded border border-white/10 px-3 py-2 text-left text-sm font-medium text-sidebar-text transition-colors hover:bg-sidebar-hover hover:text-white"
        data-testid="documents-teamspaces-button"
        @click="$emit('openTeamspaces')"
      >
        <svg class="h-4 w-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
        Teamspaces
      </button>

      <section class="mt-3 space-y-1" data-testid="documents-favorites-section">
        <div class="px-3 pb-1 text-xs font-semibold uppercase text-sidebar-heading">Favorites</div>
        <div v-if="documentsStore.sidebarLoading" class="space-y-1 px-2 pt-1" aria-hidden="true">
          <div class="h-6 w-4/5 animate-pulse rounded bg-sidebar-hover" />
          <div class="h-6 w-3/5 animate-pulse rounded bg-sidebar-hover" />
        </div>
        <div v-else-if="documentsStore.sidebarError" class="px-3 py-1 text-xs text-red-400">
          {{ documentsStore.sidebarError }}
        </div>
        <template v-else>
          <div v-if="documentsStore.favoriteDocuments.length === 0" class="px-3 py-1 text-xs text-gray-500">
            No favorites yet.
          </div>
          <div
            v-for="favorite in documentsStore.favoriteDocuments"
            :key="favorite.id"
            class="group flex min-h-8 w-full items-center gap-1 rounded-md pr-1.5 text-[15px] transition-colors"
            :class="selectedDocumentId === favorite.id ? 'bg-sidebar-active text-white' : 'text-sidebar-text hover:bg-sidebar-hover'"
          >
            <button
              type="button"
              class="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-0.5 text-left"
              :data-testid="`documents-favorite-${favorite.id}`"
              @click="openFavorite(favorite)"
            >
              <svg class="h-3.5 w-3.5 shrink-0 text-yellow-300" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.175 3.617a1 1 0 0 0 .95.69h3.804c.969 0 1.371 1.24.588 1.81l-3.078 2.237a1 1 0 0 0-.364 1.118l1.176 3.617c.299.921-.756 1.688-1.54 1.118l-3.077-2.236a1 1 0 0 0-1.176 0l-3.077 2.236c-.784.57-1.839-.197-1.54-1.118l1.176-3.617a1 1 0 0 0-.364-1.118L2.526 9.044c-.783-.57-.38-1.81.588-1.81h3.804a1 1 0 0 0 .95-.69l1.181-3.617z" />
              </svg>
              <span class="min-w-0 flex-1 truncate" :title="favorite.title">{{ favorite.title }}</span>
            </button>
            <button
              type="button"
              class="hidden h-5 w-5 shrink-0 items-center justify-center rounded disabled:opacity-50 group-hover:flex group-focus-within:flex"
              :class="selectedDocumentId === favorite.id
                ? 'text-white/80 hover:bg-white/10 hover:text-white'
                : 'text-sidebar-textMuted hover:bg-sidebar-hover hover:text-sidebar-text'"
              :data-testid="`documents-favorite-remove-${favorite.id}`"
              title="Remove from favorites"
              aria-label="Remove from favorites"
              :disabled="removingFavoriteId === favorite.id"
              @click.stop="removeFavorite(favorite.id)"
            >
              <svg class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M5 10h10" stroke-linecap="round" />
              </svg>
            </button>
          </div>
          <p v-if="favoriteActionError" class="px-3 py-1 text-xs text-red-400">
            {{ favoriteActionError }}
          </p>
        </template>
      </section>
    </div>

    <nav
      ref="treeScrollRef"
      class="min-h-0 flex-1 overflow-y-auto px-2 py-3"
      data-testid="documents-tree-scroll"
    >
      <div v-if="documentsStore.sidebarLoading" class="space-y-2 px-1 pt-1" aria-hidden="true">
        <div v-for="i in 3" :key="i" class="space-y-1">
          <div class="h-8 animate-pulse rounded-md bg-sidebar-hover" :style="{ width: `${Math.max(45, 88 - i * 12)}%` }" />
          <div class="ml-6 h-7 w-2/3 animate-pulse rounded-md bg-sidebar-hover" />
        </div>
      </div>
      <div v-else-if="documentsStore.sidebarError" class="px-3 py-2 text-xs text-red-400">
        {{ documentsStore.sidebarError }}
      </div>
      <template v-else>
        <div v-if="documentsStore.sidebarTeamspaces.length === 0" class="px-3 py-2 text-xs text-gray-500">
          No teamspaces joined.
        </div>

        <div v-else class="space-y-2">
          <div v-for="teamspace in documentsStore.sidebarTeamspaces" :key="teamspace.id" class="rounded border border-transparent">
            <div
              class="group flex min-h-8 items-center gap-1 rounded-md px-1.5 text-[15px]"
              :class="selectedTeamspaceId === teamspace.id && !selectedDocumentId
                ? 'bg-sidebar-active text-white'
                : 'text-sidebar-text hover:bg-sidebar-hover'"
            >
              <button
                type="button"
                class="flex min-w-0 flex-1 items-center gap-1.5 truncate text-left font-medium"
                :data-testid="`documents-teamspace-${teamspace.id}`"
                @click="toggleTeamspace(teamspace.id)"
              >
                <svg
                  class="h-3.5 w-3.5 shrink-0 transition-transform"
                  :class="isCollapsed(teamspace.id) ? '' : 'rotate-90'"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fill-rule="evenodd"
                    d="M7.21 14.77a.75.75 0 0 1 .02-1.06L11.168 10 7.23 6.29a.75.75 0 1 1 1.04-1.08l4.5 4.25a.75.75 0 0 1 0 1.08l-4.5 4.25a.75.75 0 0 1-1.06-.02z"
                    clip-rule="evenodd"
                  />
                </svg>
                <span
                  class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[11px] font-semibold text-white"
                  :style="{ backgroundColor: teamspaceBadgeColor(teamspace.id) }"
                  aria-hidden="true"
                >
                  {{ teamspaceBadgeInitial(teamspace.name) }}
                </span>
                <span class="min-w-0 flex-1 truncate" :title="teamspace.name">{{ teamspace.name }}</span>
              </button>
              <button
                type="button"
                class="hidden h-5 w-5 shrink-0 items-center justify-center rounded text-sidebar-textMuted group-hover:flex group-focus-within:flex hover:bg-sidebar-hover hover:text-sidebar-text"
                :data-testid="`documents-teamspace-add-${teamspace.id}`"
                title="Add root document"
                @click.stop="openCreateDocument(teamspace.id, null)"
              >
                +
              </button>
            </div>

            <div v-if="!isCollapsed(teamspace.id)" class="space-y-1 py-1">
              <p
                v-if="normalizeDocumentNodes(teamspace.documents).length === 0"
                class="pl-12 pr-2 py-1.5 text-xs text-sidebar-textMuted"
              >
                No documents yet
              </p>
              <DocumentsTreeNode
                v-for="node in normalizeDocumentNodes(teamspace.documents)"
                :key="node.id"
                :node="node"
                :level="0"
                :selected-document-id="selectedDocumentId"
                :collapsed-document-ids="collapsedDocumentIds"
                @open-document="$emit('openDocument', $event)"
                @add-child="openCreateDocument(teamspace.id, $event)"
                @toggle-collapse="toggleDocument"
                @documents-deleted="$emit('documentsDeleted', $event)"
              />
            </div>
          </div>
        </div>
      </template>
    </nav>
  </aside>

  <Teleport to="body">
    <div
      v-if="createModalOpen"
      class="dlg-overlay z-50"
      @click.self="closeCreateModal"
    >
      <div class="dlg-window max-w-md" role="dialog" aria-modal="true">
        <div class="mb-4 flex items-center justify-between gap-3">
          <h3 class="dlg-title">
            {{ createParentDocumentId ? 'New child document' : 'New document' }}
          </h3>
          <button
            type="button"
            class="rounded p-1 text-gray-400 transition-colors hover:text-white"
            @click="closeCreateModal"
          >
            <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div class="space-y-3">
          <div>
            <label class="dlg-label">Title</label>
            <input
              v-model="createTitle"
              type="text"
              class="dlg-input"
              placeholder="Document title"
            >
          </div>
          <div>
            <label class="dlg-label">Initial markdown</label>
            <textarea
              v-model="createContent"
              class="dlg-input min-h-[120px]"
              placeholder="# Notes"
            />
          </div>
          <p v-if="createError" class="text-xs text-app-danger">{{ createError }}</p>
        </div>

        <div class="mt-4 flex justify-end gap-2">
          <button
            type="button"
            class="dlg-btn dlg-btn-ghost"
            :disabled="createSaving"
            @click="closeCreateModal"
          >
            Cancel
          </button>
          <button
            type="button"
            class="dlg-btn dlg-btn-primary"
            :disabled="createSaving || !createTitle.trim()"
            @click="submitCreateDocument"
          >
            {{ createSaving ? 'Creating...' : 'Create' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import type { SidebarDocumentNode } from '@/services/http/documentsApi'
import type { FavoriteSidebarDocument } from '@/stores/documents'
import { useDocumentsStore } from '@/stores/documents'
import { normalizeDocumentNodes } from '@/utils/documentsUtils'
import {
  loadCollapsedDocumentsTeamspaceIds,
  saveCollapsedDocumentsTeamspaceIds,
} from '@/services/storage/documentsTeamspaceCollapseStorage'
import {
  loadCollapsedDocumentsNodeIds,
  saveCollapsedDocumentsNodeIds,
} from '@/services/storage/documentsNodeCollapseStorage'
import DocumentsTreeNode from './DocumentsTreeNode.vue'

const props = defineProps<{
  selectedTeamspaceId: string | null
  selectedDocumentId: string | null
  searchQuery: string
}>()

const emit = defineEmits<{
  openTeamspaces: []
  openDocument: [id: string]
  documentsDeleted: [ids: string[]]
  searchQueryChange: [value: string]
}>()

const documentsStore = useDocumentsStore()
const collapsedTeamspaceIds = ref<string[]>(loadCollapsedDocumentsTeamspaceIds())
const collapsedDocumentIds = ref<string[]>(loadCollapsedDocumentsNodeIds())
const createModalOpen = ref(false)
const createTeamspaceId = ref<string | null>(null)
const createParentDocumentId = ref<string | null>(null)
const createTitle = ref('')
const createContent = ref('')
const createSaving = ref(false)
const createError = ref('')
const treeScrollRef = ref<HTMLElement | null>(null)
const removingFavoriteId = ref<string | null>(null)
const favoriteActionError = ref('')

const teamspaceBadgePalette = ['#3B82F6', '#10B981', '#8B5CF6', '#F59E0B', '#EC4899', '#06B6D4']

function teamspaceBadgeColor(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i += 1) {
    hash = (Math.imul(31, hash) + id.charCodeAt(i)) | 0
  }
  return teamspaceBadgePalette[Math.abs(hash) % teamspaceBadgePalette.length]
}

function teamspaceBadgeInitial(name: string): string {
  const initial = name.trim().charAt(0).toUpperCase()
  return initial || '•'
}

onMounted(() => {
  void documentsStore.loadSidebar()
})

watch(collapsedTeamspaceIds, (value) => {
  saveCollapsedDocumentsTeamspaceIds(value)
})

watch(collapsedDocumentIds, (value) => {
  saveCollapsedDocumentsNodeIds(value)
})

watch(
  () => documentsStore.sidebarTeamspaces.map(teamspace => teamspace.id).join(','),
  () => {
    if (documentsStore.sidebarTeamspaces.length === 0) return
    const validIds = new Set(documentsStore.sidebarTeamspaces.map(teamspace => teamspace.id))
    const next = collapsedTeamspaceIds.value.filter(id => validIds.has(id))
    if (next.length !== collapsedTeamspaceIds.value.length || next.some((id, index) => id !== collapsedTeamspaceIds.value[index])) {
      collapsedTeamspaceIds.value = next
    }
  },
  { immediate: true },
)

watch(
  () => documentsStore.sidebarTeamspaces,
  () => {
    if (documentsStore.sidebarTeamspaces.length === 0) return
    const validIds = new Set(documentsStore.sidebarTeamspaces.flatMap(teamspace => collectDocumentIds(teamspace.documents)))
    const next = collapsedDocumentIds.value.filter(id => validIds.has(id))
    if (next.length !== collapsedDocumentIds.value.length || next.some((id, index) => id !== collapsedDocumentIds.value[index])) {
      collapsedDocumentIds.value = next
    }
  },
  { immediate: true },
)

function isCollapsed(teamspaceId: string): boolean {
  return collapsedTeamspaceIds.value.includes(teamspaceId)
}

function toggleTeamspace(teamspaceId: string) {
  if (isCollapsed(teamspaceId)) {
    collapsedTeamspaceIds.value = collapsedTeamspaceIds.value.filter(id => id !== teamspaceId)
    return
  }
  collapsedTeamspaceIds.value = [...collapsedTeamspaceIds.value, teamspaceId]
}

function isDocumentCollapsed(documentId: string): boolean {
  return collapsedDocumentIds.value.includes(documentId)
}

function toggleDocument(documentId: string) {
  if (isDocumentCollapsed(documentId)) {
    collapsedDocumentIds.value = collapsedDocumentIds.value.filter(id => id !== documentId)
    return
  }
  collapsedDocumentIds.value = [...collapsedDocumentIds.value, documentId]
}

function collectDocumentIds(nodes: SidebarDocumentNode[] | null | undefined): string[] {
  return normalizeDocumentNodes(nodes).flatMap(node => [node.id, ...collectDocumentIds(node.children)])
}

async function openFavorite(favorite: FavoriteSidebarDocument) {
  favoriteActionError.value = ''
  collapsedTeamspaceIds.value = collapsedTeamspaceIds.value.filter(id => id !== favorite.teamspace_id)
  if (favorite.ancestor_document_ids.length > 0) {
    const ancestorIds = new Set(favorite.ancestor_document_ids)
    collapsedDocumentIds.value = collapsedDocumentIds.value.filter(id => !ancestorIds.has(id))
  }
  await nextTick()
  treeScrollRef.value
    ?.querySelector<HTMLElement>(`[data-document-node-id="${favorite.id}"]`)
    ?.scrollIntoView({ block: 'center', inline: 'nearest' })
  emit('openDocument', favorite.id)
}

async function removeFavorite(documentId: string) {
  removingFavoriteId.value = documentId
  favoriteActionError.value = ''
  try {
    await documentsStore.unfavoriteDocument(documentId)
  } catch (e) {
    favoriteActionError.value = e instanceof Error ? e.message : 'Failed to update favorite'
  } finally {
    removingFavoriteId.value = null
  }
}

function openCreateDocument(teamspaceId: string, parentDocumentId: string | null) {
  createTeamspaceId.value = teamspaceId
  createParentDocumentId.value = parentDocumentId
  createTitle.value = ''
  createContent.value = ''
  createError.value = ''
  createModalOpen.value = true
}

function closeCreateModal() {
  createModalOpen.value = false
  createSaving.value = false
  createError.value = ''
}

async function submitCreateDocument() {
  if (!createTeamspaceId.value) return
  createSaving.value = true
  createError.value = ''
  try {
    const row = await documentsStore.createDocument({
      teamspace_id: createTeamspaceId.value,
      parent_document_id: createParentDocumentId.value,
      title: createTitle.value.trim(),
      content_markdown: createContent.value.trim() ? createContent.value : null,
    })
    closeCreateModal()
    emit('openDocument', row.id)
  } catch (e) {
    createError.value = e instanceof Error ? e.message : 'Failed to create document'
  } finally {
    createSaving.value = false
  }
}
</script>
