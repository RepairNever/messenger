<template>
  <div v-if="documentsStore.documentLoading" class="flex h-full items-center justify-center text-sm text-app-muted">
    Loading...
  </div>
  <div v-else-if="documentsStore.documentError" class="flex h-full items-center justify-center text-sm text-app-danger" role="alert">
    {{ documentsStore.documentError }}
  </div>
  <section v-else-if="documentItem" class="flex h-full min-h-0 flex-col overflow-hidden" data-testid="spreadsheet-document-card">
    <header class="flex items-start gap-3 border-b border-chat-border px-6 py-4">
      <button type="button" class="shrink-0 text-xs text-app-muted hover:text-app-text" @click="emit('back')">Back</button>
      <div class="min-w-0 flex-1">
        <div class="mb-1 flex min-w-0 items-center gap-1 text-xs text-app-muted" data-testid="spreadsheet-document-breadcrumb">
          <span class="truncate">{{ documentItem.teamspace_name }}</span>
          <template v-for="ancestor in ancestors" :key="ancestor.id">
            <span aria-hidden="true">/</span>
            <button type="button" class="truncate hover:text-app-text" @click="emit('openParent', ancestor.id)">{{ ancestor.title }}</button>
          </template>
        </div>
        <form v-if="titleEditing" class="flex items-center gap-2" @submit.prevent="saveTitle">
          <input
            ref="titleInputRef"
            v-model="titleDraft"
            class="min-w-0 flex-1 rounded border border-chat-border bg-chat-input px-2 py-1 text-sm text-app-text outline-none focus:border-accent"
            aria-label="Spreadsheet title"
            data-testid="spreadsheet-title-input"
            :disabled="titleSaving"
            @keydown.esc.prevent="cancelTitleEdit"
          >
          <button type="submit" class="dlg-btn dlg-btn-primary" :disabled="titleSaving || !titleDraft.trim()">{{ titleSaving ? 'Saving...' : 'Save' }}</button>
          <button type="button" class="dlg-btn dlg-btn-ghost" :disabled="titleSaving" @click="cancelTitleEdit">Cancel</button>
        </form>
        <div v-else class="flex min-w-0 items-center gap-2">
          <DocumentKindIcon kind="spreadsheet" class="text-app-muted" />
          <h1 class="truncate text-sm font-semibold text-app-text">{{ documentItem.title }}</h1>
          <button type="button" class="rounded p-1 text-app-muted hover:text-app-text" aria-label="Edit spreadsheet title" data-testid="spreadsheet-edit-title" @click="startTitleEdit">
            <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" /></svg>
          </button>
        </div>
        <p v-if="titleError" class="mt-1 text-xs text-app-danger" role="alert">{{ titleError }}</p>
        <p v-if="favoriteError" class="mt-1 text-xs text-app-danger" role="alert">{{ favoriteError }}</p>
      </div>
      <button
        type="button"
        class="rounded border border-chat-border px-2 py-1 text-xs text-app-text hover:border-accent/50 disabled:opacity-50"
        data-testid="spreadsheet-favorite-toggle"
        :aria-pressed="isFavorite"
        :disabled="favoriteSaving"
        @click="toggleFavorite"
      >
        {{ isFavorite ? 'Remove from favorites' : 'Add to favorites' }}
      </button>
    </header>
    <div class="flex min-h-0 flex-1 overflow-hidden">
      <component :is="SpreadsheetEditor" :key="documentItem.id" :document-id="documentItem.id" @metadata-changed="refreshMetadata" />
    </div>
  </section>
  <div v-else class="flex h-full items-center justify-center text-sm text-app-muted">Select a spreadsheet</div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, h, nextTick, ref, shallowRef, watch } from 'vue'
import type { SidebarDocumentNode } from '@/services/http/documentsApi'
import { useDocumentsStore } from '@/stores/documents'
import DocumentKindIcon from './DocumentKindIcon.vue'

const emit = defineEmits<{ back: []; openParent: [id: string] }>()
const documentsStore = useDocumentsStore()
const documentItem = computed(() => documentsStore.selectedDocument?.kind === 'spreadsheet' ? documentsStore.selectedDocument : null)
const titleEditing = ref(false)
const titleDraft = ref('')
const titleSaving = ref(false)
const titleError = ref('')
const titleInputRef = ref<HTMLInputElement | null>(null)
const favoriteSaving = ref(false)
const favoriteError = ref('')
let metadataGeneration = 0

function loadSpreadsheetEditor() {
  return defineAsyncComponent({
    loader: () => import('./SpreadsheetEditor.vue').then(module => module.default),
    delay: 200,
    timeout: 30_000,
    loadingComponent: { render: () => h('div', { class: 'p-6 text-sm text-app-muted', role: 'status' }, 'Loading spreadsheet editor...') },
    errorComponent: { render: () => h('div', { class: 'p-6 text-sm text-app-danger', role: 'alert' }, [
      h('p', 'Unable to load the spreadsheet editor.'),
      h('button', { class: 'dlg-btn dlg-btn-ghost mt-3', type: 'button', onClick: () => { SpreadsheetEditor.value = loadSpreadsheetEditor() } }, 'Retry'),
    ]) },
  })
}
const SpreadsheetEditor = shallowRef(loadSpreadsheetEditor())

function findPath(nodes: SidebarDocumentNode[] | null | undefined, id: string): SidebarDocumentNode[] | null {
  for (const node of nodes ?? []) {
    if (node.id === id) return [node]
    const children = findPath(node.children, id)
    if (children) return [node, ...children]
  }
  return null
}
const ancestors = computed(() => {
  const current = documentItem.value
  if (!current) return []
  const teamspace = documentsStore.sidebarTeamspaces.find(row => row.id === current.teamspace_id)
  const path = findPath(teamspace?.documents, current.id)
  if (path) return path.slice(0, -1)
  return current.parent_document_id && current.parent_title ? [{ id: current.parent_document_id, title: current.parent_title }] : []
})
const isFavorite = computed(() => documentsStore.favoriteDocuments.some(row => row.id === documentItem.value?.id))

watch(() => documentItem.value?.id, () => {
  metadataGeneration += 1
  titleEditing.value = false
  titleSaving.value = false
  favoriteSaving.value = false
  titleDraft.value = documentItem.value?.title ?? ''
  titleError.value = ''
  favoriteError.value = ''
}, { immediate: true, flush: 'sync' })

watch(() => documentItem.value?.title, title => {
  if (!titleEditing.value) titleDraft.value = title ?? ''
})

async function startTitleEdit() {
  titleDraft.value = documentItem.value?.title ?? ''
  titleError.value = ''
  titleEditing.value = true
  await nextTick()
  titleInputRef.value?.focus()
  titleInputRef.value?.select()
}
function cancelTitleEdit() {
  if (titleSaving.value) return
  titleEditing.value = false
  titleError.value = ''
}
async function saveTitle() {
  const current = documentItem.value
  if (!current || titleSaving.value) return
  const generation = metadataGeneration
  const title = titleDraft.value.trim()
  if (!title) { titleError.value = 'Spreadsheet title is required'; return }
  if (title === current.title) { cancelTitleEdit(); return }
  titleSaving.value = true
  titleError.value = ''
  try {
    await documentsStore.renameDocument(current.id, title)
    if (metadataGeneration === generation && documentItem.value?.id === current.id) titleEditing.value = false
  } catch (error) {
    if (metadataGeneration === generation && documentItem.value?.id === current.id) titleError.value = error instanceof Error ? error.message : 'Failed to save spreadsheet title'
  } finally {
    if (metadataGeneration === generation && documentItem.value?.id === current.id) titleSaving.value = false
  }
}
async function toggleFavorite() {
  const current = documentItem.value
  if (!current || favoriteSaving.value) return
  const generation = metadataGeneration
  favoriteSaving.value = true
  favoriteError.value = ''
  try {
    if (isFavorite.value) await documentsStore.unfavoriteDocument(current.id)
    else await documentsStore.favoriteDocument(current.id)
  } catch (error) {
    if (metadataGeneration === generation && documentItem.value?.id === current.id) favoriteError.value = error instanceof Error ? error.message : 'Failed to update favorite'
  } finally {
    if (metadataGeneration === generation && documentItem.value?.id === current.id) favoriteSaving.value = false
  }
}

async function refreshMetadata() {
  const current = documentItem.value
  if (!current) return
  const generation = metadataGeneration
  try { await documentsStore.refreshDocumentMetadata(current.id) }
  catch (error) {
    if (metadataGeneration === generation) titleError.value = error instanceof Error ? error.message : 'Could not refresh spreadsheet details'
  }
}
</script>
