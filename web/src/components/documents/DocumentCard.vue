<template>
  <div
    v-if="!documentsStore.selectedDocument && !documentsStore.documentLoading"
    class="flex h-full items-center justify-center text-sm text-gray-500"
  >
    Select a document
  </div>

  <div
    v-else-if="documentsStore.documentLoading"
    class="flex h-full items-center justify-center text-sm text-gray-500"
  >
    Loading...
  </div>

  <div
    v-else-if="documentsStore.documentError"
    class="flex h-full items-center justify-center text-sm text-red-400"
  >
    {{ documentsStore.documentError }}
  </div>

  <div v-else-if="documentItem" class="flex h-full flex-col overflow-hidden">
    <div class="flex items-start justify-between gap-4 border-b border-chat-border px-6 py-4">
      <div class="flex min-w-0 flex-1 items-center gap-3">
        <button
          type="button"
          class="shrink-0 text-xs text-gray-500 transition-colors hover:text-white"
          @click="$emit('back')"
        >
          Back
        </button>
        <div class="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-xs text-gray-500" data-testid="document-breadcrumb">
          <template v-for="(segment, index) in documentBreadcrumbSegments" :key="`${segment}:${index}`">
            <span class="truncate">{{ segment }}</span>
            <span class="shrink-0 text-gray-600">/</span>
          </template>
          <input
            v-if="titleEditing"
            ref="titleInputRef"
            v-model="titleDraft"
            type="text"
            class="min-w-0 flex-1 rounded border border-chat-border bg-chat-input px-3 py-1 text-sm text-white outline-none focus:border-accent"
            @keydown.enter.prevent="saveTitle"
            @keydown.esc.prevent="cancelTitleEdit"
            @blur="saveTitle"
          >
          <div v-else class="flex min-w-0 items-center gap-2">
            <h1 class="truncate text-sm font-semibold text-white">{{ documentItem.title }}</h1>
            <button
              type="button"
              class="rounded p-1 text-gray-500 transition-colors hover:text-white"
              title="Edit title"
              @click="startTitleEdit"
            >
              <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
              </svg>
            </button>
          </div>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <button
          type="button"
          data-testid="document-export-pdf"
          class="rounded border border-chat-border px-2 py-1 text-xs text-gray-300 transition-colors hover:border-accent/50 hover:text-white disabled:opacity-50"
          :disabled="exportingPdf"
          @click="exportDocumentPdf"
        >
          {{ exportingPdf ? 'Exporting...' : 'Export to PDF' }}
        </button>
        <button
          type="button"
          data-testid="documents-history-button"
          class="rounded border border-chat-border px-2 py-1 text-xs text-gray-300 transition-colors hover:border-accent/50 hover:text-white"
          @click="openHistoryModal"
        >
          History
        </button>
      </div>
    </div>

    <div class="flex-1 overflow-y-auto px-6 py-4">
      <div v-if="saveError" class="mb-3 text-xs text-red-400">{{ saveError }}</div>
      <div v-if="contentSaveError" class="mb-3 text-xs text-red-400">{{ contentSaveError }}</div>
      <div v-if="documentContentCollabError" class="mb-3 text-xs text-red-400">{{ documentContentCollabError }}</div>

      <TaskDescriptionEditor
        :key="contentEditorRenderKey"
        v-model="contentDraft"
        owner-kind="document"
        :owner-id="documentItem.id"
        placeholder="Document content"
        collab-field="document_content"
        :collab-doc="documentContentDoc"
        :collab-provider="documentContentProvider"
        :collab-user="collabUser"
        :allow-local-draft-seed="documentContentAllowLocalDraftSeed"
        :force-local-sync-token="contentForceLocalSyncToken"
        @blur="flushContentNow"
      />

      <div class="mt-6 flex gap-6 border-t border-chat-border pt-4 text-xs text-gray-500">
        <div>
          <span class="uppercase tracking-wide">Created</span>
          <div class="mt-0.5 text-gray-400">{{ formatDatetime(documentItem.created_at) }}</div>
        </div>
        <div>
          <span class="uppercase tracking-wide">Updated</span>
          <div class="mt-0.5 text-gray-400">{{ formatDatetime(documentItem.updated_at) }}</div>
        </div>
      </div>
    </div>
  </div>

  <Teleport to="body">
    <div
      v-if="historyModalOpen"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      @click.self="closeHistoryModal"
    >
      <div class="w-full max-w-5xl rounded-xl border border-chat-border bg-chat-header p-4 shadow-2xl">
        <h3 class="mb-3 text-base font-semibold text-white">Document History</h3>
        <div class="grid gap-4 md:grid-cols-[280px_minmax(0,1fr)]">
          <aside class="rounded border border-chat-border bg-chat-input/40 p-2">
            <div class="mb-2 text-xs uppercase tracking-wide text-gray-400">Versions</div>
            <p v-if="historyLoading" class="px-2 py-2 text-xs text-gray-500">Loading versions...</p>
            <p v-else-if="historyError" class="px-2 py-2 text-xs text-red-400">{{ historyError }}</p>
            <p v-else-if="historyItems.length === 0" class="px-2 py-2 text-xs text-gray-500">No versions yet</p>
            <ul v-else class="max-h-[420px] space-y-1 overflow-y-auto pr-1">
              <li v-for="item in historyItems" :key="`${item.created_at}:${item.edited_by}`">
                <button
                  type="button"
                  class="flex w-full items-start gap-2 rounded border border-transparent px-2 py-1.5 text-left transition-colors hover:bg-white/5"
                  :class="historyCandidate === item ? 'border-accent/50 bg-accent/20' : ''"
                  @click="selectHistoryItem(item)"
                >
                  <UserAvatar
                    :user-id="item.editor.id"
                    :display-name="item.editor.display_name"
                    :avatar-url="item.editor.avatar_url"
                    :custom-status="userCustomStatusFromDto(item.editor.custom_status)"
                    size="xs"
                  />
                  <span class="min-w-0">
                    <span class="block truncate text-xs text-gray-200">{{ item.editor.display_name }}</span>
                    <span class="block text-[11px] text-gray-500">{{ formatDatetime(item.created_at) }}</span>
                  </span>
                </button>
              </li>
            </ul>
          </aside>

          <div class="space-y-3">
            <template v-if="historyCandidate">
              <div>
                <div class="mb-1 text-xs uppercase tracking-wide text-gray-400">Title</div>
                <input
                  :value="historyCandidate.title"
                  type="text"
                  readonly
                  class="w-full rounded border border-chat-border bg-chat-input px-2 py-1 text-sm text-gray-200"
                >
              </div>
              <div>
                <div class="mb-1 text-xs uppercase tracking-wide text-gray-400">Content</div>
                <div class="max-h-[420px] overflow-y-auto pr-1">
                  <TaskDescriptionEditor v-model="historyPreviewDraft" :editable="false" />
                </div>
              </div>
            </template>
            <p v-else class="rounded border border-chat-border bg-chat-input px-3 py-4 text-sm italic text-gray-500">
              Select a history item to preview
            </p>
          </div>
        </div>
        <p v-if="historyApplyError" class="mt-3 text-xs text-red-400">{{ historyApplyError }}</p>
        <div class="mt-4 flex justify-end gap-2">
          <button
            type="button"
            class="rounded border border-chat-border px-3 py-1.5 text-sm text-gray-300 transition-colors hover:text-white"
            :disabled="historyApplying"
            @click="closeHistoryModal"
          >
            Cancel
          </button>
          <button
            type="button"
            class="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
            :disabled="historyApplying || !historyCandidate"
            @click="applyHistory"
          >
            {{ historyApplying ? 'Applying...' : 'Apply' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { DocumentHistoryItem, SidebarDocumentNode } from '@/services/http/documentsApi'
import { useDocumentContentCollab, type DocumentContentCollabUser } from '@/composables/useDocumentContentCollab'
import { getPlatformOrNull, initPlatform } from '@/platform'
import { exportDocumentToPdfBlob, buildDocumentPdfFileName } from '@/services/taskPdfExport'
import { useAuthStore } from '@/stores/auth'
import { useDocumentsStore } from '@/stores/documents'
import TaskDescriptionEditor from '@/components/tasks/TaskDescriptionEditor.vue'
import UserAvatar from '@/components/UserAvatar.vue'
import { userCustomStatusFromDto } from '@/types/userStatus'

const DESCRIPTION_AUTOSAVE_DEBOUNCE_MS = 800
const DESCRIPTION_MAX_FLUSH_MS = 10_000

defineEmits<{
  back: []
  openParent: [id: string]
}>()

const documentsStore = useDocumentsStore()
const authStore = useAuthStore()

const titleEditing = ref(false)
const titleDraft = ref('')
const contentDraft = ref('')
const saveError = ref('')
const contentSaveError = ref('')
const exportingPdf = ref(false)
const contentSaving = ref(false)
const hydratingContent = ref(false)
const lastSavedContent = ref<string | null>(null)
const contentEditorRenderKey = ref(0)
const contentForceLocalSyncToken = ref(0)
const titleInputRef = ref<HTMLInputElement | null>(null)
let contentDebounceTimer: ReturnType<typeof setTimeout> | null = null
let contentMaxFlushTimer: ReturnType<typeof setTimeout> | null = null
let contentRetryTimer: ReturnType<typeof setTimeout> | null = null
let contentRetryDelayMs = 1000

const historyModalOpen = ref(false)
const historyLoading = ref(false)
const historyError = ref('')
const historyItems = ref<DocumentHistoryItem[]>([])
const historyCandidate = ref<DocumentHistoryItem | null>(null)
const historyPreviewDraft = ref('')
const historyApplying = ref(false)
const historyApplyError = ref('')

const documentItem = computed(() => documentsStore.selectedDocument)
const collabDocumentId = computed(() => documentItem.value?.id ?? null)
const collabUser = computed<DocumentContentCollabUser | null>(() => {
  const user = authStore.user
  if (!user) return null
  const palette = ['#60a5fa', '#f97316', '#f43f5e', '#22c55e', '#8b5cf6', '#06b6d4', '#eab308', '#14b8a6']
  let hash = 0
  for (let i = 0; i < user.id.length; i += 1) {
    hash = ((hash << 5) - hash) + user.id.charCodeAt(i)
    hash |= 0
  }
  return {
    id: user.id,
    name: user.displayName || user.email,
    color: palette[Math.abs(hash) % palette.length],
  }
})
const contentCollab = useDocumentContentCollab({
  documentId: collabDocumentId,
  user: collabUser,
})
const documentContentDoc = computed(() => contentCollab.doc.value)
const documentContentProvider = computed(() => contentCollab.provider.value)
const documentContentCollabError = computed(() => contentCollab.subscribeError.value)
const documentContentAllowLocalDraftSeed = computed(() => contentCollab.allowLocalDraftSeed.value)

const documentBreadcrumbSegments = computed(() => {
  const current = documentsStore.selectedDocument
  if (!current) return []

  const teamspace = documentsStore.sidebarTeamspaces.find(item => item.id === current.teamspace_id)
  const path = teamspace ? findDocumentPath(teamspace.documents, current.id) : null
  if (path && path.length > 1) {
    return [teamspace?.name ?? current.teamspace_name, ...path.slice(0, -1)]
  }

  const fallbackSegments = [current.teamspace_name]
  if (current.parent_title) {
    fallbackSegments.push(current.parent_title)
  }
  return fallbackSegments
})

watch(
  () => documentItem.value?.id,
  (next, prev) => {
    if (prev) {
      clearContentTimers()
      void persistContent(prev, contentDraft.value, true)
    }

    titleDraft.value = documentItem.value?.title ?? ''
    hydratingContent.value = true
    contentDraft.value = documentItem.value?.content_markdown ?? ''
    lastSavedContent.value = documentItem.value?.content_markdown ?? null
    hydratingContent.value = false
    titleEditing.value = false
    saveError.value = ''
    contentSaveError.value = ''
    contentRetryDelayMs = 1000
    historyModalOpen.value = false
    historyLoading.value = false
    historyError.value = ''
    historyItems.value = []
    historyCandidate.value = null
    historyPreviewDraft.value = ''
    historyApplying.value = false
    historyApplyError.value = ''
    contentEditorRenderKey.value += 1
    contentForceLocalSyncToken.value = 0
    exportingPdf.value = false
  },
  { immediate: true },
)

watch(
  () => documentItem.value?.title,
  (next) => {
    if (titleEditing.value) return
    titleDraft.value = next ?? ''
  },
)

watch(() => contentCollab.serverMarkdown.value, (next) => {
  if (next === null) return
  hydratingContent.value = true
  contentDraft.value = next
  lastSavedContent.value = next
  hydratingContent.value = false
  contentCollab.serverMarkdown.value = null
})

watch(contentDraft, () => {
  if (hydratingContent.value || !documentItem.value) return
  scheduleContentAutosave()
}, { flush: 'sync' })

function formatDatetime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function findDocumentPath(nodes: SidebarDocumentNode[], targetId: string): string[] | null {
  for (const node of nodes) {
    if (node.id === targetId) return [node.title]
    const childPath = findDocumentPath(node.children, targetId)
    if (childPath) return [node.title, ...childPath]
  }
  return null
}

async function startTitleEdit() {
  titleEditing.value = true
  await nextTick()
  titleInputRef.value?.focus()
  titleInputRef.value?.select()
}

function cancelTitleEdit() {
  titleEditing.value = false
  titleDraft.value = documentsStore.selectedDocument?.title ?? ''
  saveError.value = ''
}

function clearContentTimers() {
  if (contentDebounceTimer) {
    clearTimeout(contentDebounceTimer)
    contentDebounceTimer = null
  }
  if (contentMaxFlushTimer) {
    clearTimeout(contentMaxFlushTimer)
    contentMaxFlushTimer = null
  }
  if (contentRetryTimer) {
    clearTimeout(contentRetryTimer)
    contentRetryTimer = null
  }
}

function contentMatchesLastSaved(value: string): boolean {
  return value === (lastSavedContent.value ?? '')
}

async function persistContent(documentId: string, source: string, force = false) {
  if (contentMatchesLastSaved(source) || contentSaving.value) {
    return
  }

  contentSaving.value = true
  try {
    const row = await documentsStore.updateDocumentContent(documentId, {
      content_markdown: source,
      ...(force ? { force_snapshot: true } : {}),
    })
    if (documentItem.value?.id === documentId) {
      lastSavedContent.value = row.content_markdown
      contentSaveError.value = ''
      if (contentRetryTimer) {
        clearTimeout(contentRetryTimer)
        contentRetryTimer = null
      }
      contentRetryDelayMs = 1000
    }
  } catch (e) {
    if (documentItem.value?.id === documentId) {
      contentSaveError.value = (e instanceof Error ? e.message : 'Failed to save document content') + '. Retrying...'
      if (!contentRetryTimer) {
        const retryDocumentId = documentId
        contentRetryTimer = setTimeout(() => {
          contentRetryTimer = null
          void persistContent(retryDocumentId, contentDraft.value, true)
          contentRetryDelayMs = Math.min(contentRetryDelayMs * 2, 15_000)
        }, contentRetryDelayMs)
      }
    }
  } finally {
    contentSaving.value = false
  }
}

function scheduleContentAutosave() {
  if (!documentItem.value) return
  const documentId = documentItem.value.id
  if (contentDebounceTimer) {
    clearTimeout(contentDebounceTimer)
  }
  contentDebounceTimer = setTimeout(() => {
    contentDebounceTimer = null
    void persistContent(documentId, contentDraft.value)
  }, DESCRIPTION_AUTOSAVE_DEBOUNCE_MS)

  if (!contentMaxFlushTimer) {
    contentMaxFlushTimer = setTimeout(() => {
      contentMaxFlushTimer = null
      if (contentDebounceTimer) {
        clearTimeout(contentDebounceTimer)
        contentDebounceTimer = null
      }
      void persistContent(documentId, contentDraft.value, true)
    }, DESCRIPTION_MAX_FLUSH_MS)
  }
}

function flushContentNow() {
  if (!documentItem.value) return
  clearContentTimers()
  void persistContent(documentItem.value.id, contentDraft.value, true)
}

async function saveTitle() {
  const current = documentItem.value
  if (!current) return
  const nextTitle = titleDraft.value.trim()
  if (nextTitle === '') {
    saveError.value = 'Document title is required'
    return
  }
  if (nextTitle === current.title) {
    titleEditing.value = false
    saveError.value = ''
    return
  }

  saveError.value = ''
  try {
    await documentsStore.updateDocument(current.id, { title: nextTitle })
    titleEditing.value = false
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : 'Failed to save document title'
  }
}

function exportTitleValue(): string {
  const draft = titleDraft.value.trim()
  if (titleEditing.value && draft !== '') {
    return draft
  }
  return documentItem.value?.title ?? ''
}

async function exportDocumentPdf() {
  const current = documentItem.value
  if (!current || exportingPdf.value) return

  exportingPdf.value = true
  saveError.value = ''
  try {
    const exportPayload = {
      title: exportTitleValue(),
      content_markdown: contentDraft.value,
    }
    const blob = await exportDocumentToPdfBlob(exportPayload)
    const platform = getPlatformOrNull() ?? await initPlatform()
    await platform.files.saveBlob({
      blob,
      suggestedName: buildDocumentPdfFileName(exportPayload),
      mimeType: 'application/pdf',
    })
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : 'Failed to export PDF'
  } finally {
    exportingPdf.value = false
  }
}

async function openHistoryModal() {
  const current = documentItem.value
  if (!current) return
  historyModalOpen.value = true
  historyLoading.value = true
  historyError.value = ''
  historyApplyError.value = ''
  historyCandidate.value = null
  try {
    historyItems.value = await documentsStore.loadDocumentHistory(current.id)
    if (historyItems.value.length > 0) {
      selectHistoryItem(historyItems.value[0])
    }
  } catch (e) {
    historyItems.value = []
    historyError.value = e instanceof Error ? e.message : 'Failed to load history'
  } finally {
    historyLoading.value = false
  }
}

function closeHistoryModal() {
  if (historyApplying.value) return
  historyModalOpen.value = false
  historyApplyError.value = ''
}

function selectHistoryItem(item: DocumentHistoryItem) {
  historyCandidate.value = item
  historyPreviewDraft.value = item.content_markdown ?? ''
}

async function applyHistory() {
  const current = documentItem.value
  const candidate = historyCandidate.value
  if (!current || !candidate || historyApplying.value) return
  clearContentTimers()
  historyApplying.value = true
  historyApplyError.value = ''
  try {
    const row = await documentsStore.updateDocumentContent(current.id, {
      content_markdown: candidate.content_markdown ?? null,
      force_snapshot: true,
    })
    contentCollab.restart?.()
    hydratingContent.value = true
    contentDraft.value = row.content_markdown ?? ''
    lastSavedContent.value = row.content_markdown
    hydratingContent.value = false
    contentForceLocalSyncToken.value += 1
    contentEditorRenderKey.value += 1
    historyModalOpen.value = false
    historyApplyError.value = ''
  } catch (e) {
    historyApplyError.value = e instanceof Error ? e.message : 'Failed to restore version'
  } finally {
    historyApplying.value = false
  }
}

function handleBeforeUnload() {
  if (!documentItem.value) return
  clearContentTimers()
  void persistContent(documentItem.value.id, contentDraft.value, true)
}

onMounted(() => {
  window.addEventListener('beforeunload', handleBeforeUnload)
})

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', handleBeforeUnload)
  clearContentTimers()
  if (documentItem.value) {
    void persistContent(documentItem.value.id, contentDraft.value, true)
  }
})
</script>
