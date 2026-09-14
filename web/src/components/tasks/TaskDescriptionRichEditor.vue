<template>
  <div class="flex min-h-0 flex-1 flex-col gap-2">
    <BubbleMenu
      v-if="editor && editable"
      :editor="editor"
      :tippy-options="{ placement: 'top', duration: 120, maxWidth: 'none' }"
      class="task-editor-floating-menu"
      data-testid="task-description-bubble-menu"
    >
      <div class="task-editor-menu-panel">
        <button
          type="button"
          class="toolbar-btn"
          :class="isActive('paragraph') ? 'toolbar-btn-active' : ''"
          @click="editor?.chain().focus().setParagraph().run()"
        >
          P
        </button>
        <button
          type="button"
          class="toolbar-btn"
          :class="isActive('heading', { level: 1 }) ? 'toolbar-btn-active' : ''"
          @click="editor?.chain().focus().toggleHeading({ level: 1 }).run()"
        >
          H1
        </button>
        <button
          type="button"
          class="toolbar-btn"
          :class="isActive('heading', { level: 2 }) ? 'toolbar-btn-active' : ''"
          @click="editor?.chain().focus().toggleHeading({ level: 2 }).run()"
        >
          H2
        </button>
        <button
          type="button"
          class="toolbar-btn"
          :class="isActive('heading', { level: 3 }) ? 'toolbar-btn-active' : ''"
          @click="editor?.chain().focus().toggleHeading({ level: 3 }).run()"
        >
          H3
        </button>
        <button
          type="button"
          class="toolbar-btn"
          :class="isActive('bold') ? 'toolbar-btn-active' : ''"
          @click="editor?.chain().focus().toggleBold().run()"
        >
          Bold
        </button>
        <button
          type="button"
          class="toolbar-btn"
          :class="isActive('italic') ? 'toolbar-btn-active' : ''"
          @click="editor?.chain().focus().toggleItalic().run()"
        >
          Italic
        </button>
        <button
          type="button"
          class="toolbar-btn"
          :class="isActive('strike') ? 'toolbar-btn-active' : ''"
          @click="editor?.chain().focus().toggleStrike().run()"
        >
          Strike
        </button>
        <button
          type="button"
          class="toolbar-btn"
          :class="isActive('code') ? 'toolbar-btn-active' : ''"
          @click="editor?.chain().focus().toggleCode().run()"
        >
          Code
        </button>
        <button
          type="button"
          class="toolbar-btn"
          data-testid="task-description-bubble-code-block"
          :class="isActive('codeBlock') ? 'toolbar-btn-active' : ''"
          @click="convertSelectionToCodeBlock"
        >
          Code Block
        </button>
        <button
          type="button"
          class="toolbar-btn"
          :class="isActive('link') ? 'toolbar-btn-active' : ''"
          @click="toggleLink"
        >
          Link
        </button>
      </div>
    </BubbleMenu>

    <FloatingMenu
      v-if="editor && editable"
      :editor="editor"
      :tippy-options="{ placement: 'top-start', duration: 120, maxWidth: 'none' }"
      class="task-editor-floating-menu"
      data-testid="task-description-floating-menu"
    >
      <div class="task-editor-menu-panel">
        <button
          type="button"
          class="toolbar-btn"
          :class="isActive('paragraph') ? 'toolbar-btn-active' : ''"
          @click="editor?.chain().focus().setParagraph().run()"
        >
          P
        </button>
        <button
          type="button"
          class="toolbar-btn"
          :class="isActive('heading', { level: 1 }) ? 'toolbar-btn-active' : ''"
          @click="editor?.chain().focus().toggleHeading({ level: 1 }).run()"
        >
          H1
        </button>
        <button
          type="button"
          class="toolbar-btn"
          :class="isActive('heading', { level: 2 }) ? 'toolbar-btn-active' : ''"
          @click="editor?.chain().focus().toggleHeading({ level: 2 }).run()"
        >
          H2
        </button>
        <button
          type="button"
          class="toolbar-btn"
          :class="isActive('heading', { level: 3 }) ? 'toolbar-btn-active' : ''"
          @click="editor?.chain().focus().toggleHeading({ level: 3 }).run()"
        >
          H3
        </button>
        <button
          type="button"
          class="toolbar-btn"
          :class="isActive('bulletList') ? 'toolbar-btn-active' : ''"
          @click="editor?.chain().focus().toggleBulletList().run()"
        >
          UL
        </button>
        <button
          type="button"
          class="toolbar-btn"
          :class="isActive('orderedList') ? 'toolbar-btn-active' : ''"
          @click="editor?.chain().focus().toggleOrderedList().run()"
        >
          OL
        </button>
        <button
          type="button"
          class="toolbar-btn"
          :class="isActive('blockquote') ? 'toolbar-btn-active' : ''"
          @click="editor?.chain().focus().toggleBlockquote().run()"
        >
          Quote
        </button>
        <button
          type="button"
          class="toolbar-btn"
          :class="isActive('codeBlock') ? 'toolbar-btn-active' : ''"
          @click="editor?.chain().focus().toggleCodeBlock().run()"
        >
          Code Block
        </button>
        <button
          type="button"
          class="toolbar-btn"
          :class="isActive('table') ? 'toolbar-btn-active' : ''"
          @click="insertTable"
        >
          Table
        </button>
      </div>
    </FloatingMenu>

    <div
      v-if="tableToolbarVisible"
      class="task-table-toolbar"
      data-testid="task-description-table-toolbar"
      @mousedown.prevent
    >
      <button
        type="button"
        class="toolbar-btn"
        data-testid="task-description-table-add-row"
        :disabled="!canRunTableCommand('addRowAfter')"
        @click.prevent="runTableCommand('addRowAfter')"
      >
        + row
      </button>
      <button
        type="button"
        class="toolbar-btn"
        data-testid="task-description-table-delete-row"
        :disabled="!canRunTableCommand('deleteRow')"
        @click.prevent="runTableCommand('deleteRow')"
      >
        - row
      </button>
      <button
        type="button"
        class="toolbar-btn"
        data-testid="task-description-table-add-column"
        :disabled="!canRunTableCommand('addColumnAfter')"
        @click.prevent="runTableCommand('addColumnAfter')"
      >
        + col
      </button>
      <button
        type="button"
        class="toolbar-btn"
        data-testid="task-description-table-delete-column"
        :disabled="!canRunTableCommand('deleteColumn')"
        @click.prevent="runTableCommand('deleteColumn')"
      >
        - col
      </button>
      <button
        type="button"
        class="toolbar-btn toolbar-btn-danger"
        data-testid="task-description-table-delete-table"
        :disabled="!canRunTableCommand('deleteTable')"
        @click.prevent="runTableCommand('deleteTable')"
      >
        Delete table
      </button>
    </div>

    <div
      v-if="showRenderedFallback"
      data-testid="task-description-editor-fallback"
      class="min-h-[140px] px-3 py-2"
    >
      <AttachmentMarkdownContent :markdown="markdownDraft" />
    </div>

    <EditorContent
      v-if="editor"
      v-show="!showRenderedFallback"
      :editor="editor"
      class="task-description-editor-content markdown-body"
      data-testid="task-description-editor-content"
    />

    <Teleport to="body">
      <div
        v-if="imagePreview.open"
        data-testid="task-description-image-lightbox"
        class="fixed inset-0 z-[10000] flex items-center justify-center bg-black/85 p-4 sm:p-6"
        role="dialog"
        aria-modal="true"
        :aria-label="imagePreview.fileName || 'Image preview'"
        @click.self="closeImagePreview"
      >
        <div class="relative max-h-[calc(100vh-2rem)] max-w-[calc(100vw-2rem)] rounded-xl bg-black/20 p-2 shadow-xl sm:max-h-[calc(100vh-3rem)] sm:max-w-[calc(100vw-3rem)] sm:p-3">
          <button
            data-testid="task-description-image-lightbox-close"
            type="button"
            class="absolute right-2 top-2 rounded-md border border-white/20 bg-black/55 p-1.5 text-white/90 transition-colors hover:bg-black/75 hover:text-white"
            aria-label="Close image preview"
            @click="closeImagePreview"
          >
            <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
          <img
            v-if="imagePreview.src"
            data-testid="task-description-image-lightbox-img"
            :src="imagePreview.src"
            :alt="imagePreview.fileName"
            class="max-h-[calc(100vh-5rem)] max-w-[calc(100vw-5rem)] rounded-lg object-contain sm:max-h-[calc(100vh-6rem)] sm:max-w-[calc(100vw-6rem)]"
          >
        </div>
      </div>
    </Teleport>

    <MessageTagPicker
      :open="mentionPickerOpen"
      :loading="mentionPickerLoading"
      :error="mentionPickerError"
      :style="mentionPickerStyle"
      :selected-index="selectedMentionIndex"
      :users="mentionPickerUsers"
      :tasks="mentionPickerTasks"
      :documents="mentionPickerDocuments"
      @select="selectMentionItem"
    />
  </div>

</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { Doc as YDoc } from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import { Node as TiptapNode, type AnyExtension } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import Link from '@tiptap/extension-link'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { Table } from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableHeader from '@tiptap/extension-table-header'
import TableCell from '@tiptap/extension-table-cell'
import { DOMParser as ProseMirrorDOMParser } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { prosemirrorJSONToYXmlFragment } from '@tiptap/y-tiptap'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import { BubbleMenu, FloatingMenu } from '@tiptap/vue-3/menus'
import router from '@/router'
import AttachmentMarkdownContent from '@/components/AttachmentMarkdownContent.vue'
import MessageTagPicker, { type MessageTagPickerItem } from '@/components/MessageTagPicker.vue'
import { fetchOwnedAttachmentBlob, type OwnedAttachmentUpload } from '@/services/http/attachmentOwnersApi'
import { tasksFetchStagedAttachmentBlob } from '@/services/http/tasksApi'
import { createOrOpenDm } from '@/services/http/chatApi'
import { userCustomStatusFromDto } from '@/types/userStatus'
import { openBlobInBrowser } from '@/utils/attachmentBrowser'
import {
  buildAttachmentUrl,
  buildTaskStagedAttachmentUrl,
  parseAttachmentUrl,
  type AttachmentOwnerKind,
} from '@/utils/attachmentMarkdown'
import {
  decorateDescriptionMentionAnchors,
  parseUserMentionHref,
  searchDescriptionMentionSuggestions,
  warmDescriptionMentionUsersCache,
} from '@/utils/descriptionMentions'
import { handleMarkdownLinkClick } from '@/utils/linkNavigation'
import { renderTaskMarkdownToHtml } from '@/utils/taskMarkdown'
import { tiptapJsonToMarkdown } from '@/utils/tiptapMarkdown'
import { CodeBlockHighlightExtension } from '@/editor/codeBlockHighlight'
import { FenceOnEnterExtension } from '@/editor/richTextShortcuts'
import { TASK_TABLE_CELL_MIN_WIDTH, TaskTableNodeViewExtension } from '@/editor/taskTableView'
import { useChatStore } from '@/stores/chat'
import { NotificationLevel } from '@/shared/proto/packets_pb'

type TableCommand = 'addRowAfter' | 'deleteRow' | 'addColumnAfter' | 'deleteColumn' | 'deleteTable'
type TableCommandRunner = Record<TableCommand, () => { run: () => boolean }>

const props = withDefaults(defineProps<{
  modelValue: string
  editable?: boolean
  collabDoc?: YDoc | null
  collabProvider?: { awareness: Awareness } | null
  collabField?: string
  allowLocalDraftSeed?: boolean
  collabHasRemotePeers?: boolean
  forceLocalSyncToken?: number
  ownerKind?: AttachmentOwnerKind | null
  ownerId?: string | null
  attachmentUploadMode?: 'owner' | 'task-staged'
  collabUser?: {
    id: string
    name: string
    color: string
  } | null
  uploadAttachments: (files: File[]) => Promise<OwnedAttachmentUpload[] | null>
}>(), {
  editable: true,
  collabDoc: null,
  collabProvider: null,
  collabField: 'task_description',
  allowLocalDraftSeed: true,
  collabHasRemotePeers: false,
  forceLocalSyncToken: 0,
  ownerKind: null,
  ownerId: null,
  attachmentUploadMode: 'owner',
  collabUser: null,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'blur': []
}>()

const SCROLL_SELECTION_VISIBILITY_MARGIN_PX = 4

const markdownDraft = ref(props.modelValue ?? '')
const suppressEditorSync = ref(false)
const syncingFromEditor = ref(false)
const syncingFromModel = ref(0)
const editorContentEmpty = ref(true)
const editorViewVersion = ref(0)
let seedInProgress = false
const DEBUG_TASK_DESC = import.meta.env.DEV

const collabEnabled = computed(() => !!props.collabDoc)
const editable = computed(() => !!props.editable)
const chatStore = useChatStore()
const showRenderedFallback = computed(() =>
  collabEnabled.value &&
  markdownDraft.value.trim() !== '' &&
  editorContentEmpty.value,
)
const attachmentObjectUrls = new Map<string, string>()
const attachmentLoadsInFlight = new Set<string>()
const imagePreview = ref({
  open: false,
  src: '',
  fileName: '',
})
const mentionPickerOpen = ref(false)
const mentionPickerLoading = ref(false)
const mentionPickerError = ref('')
const mentionPickerStyle = ref<Record<string, string>>({
  top: '0px',
  left: '0px',
})
const selectedMentionIndex = ref(0)
const mentionPickerItems = ref<MessageTagPickerItem[]>([])
const activeMentionQueryRange = ref<{ from: number; to: number; query: string } | null>(null)
let mentionSearchDebounceTimer: ReturnType<typeof setTimeout> | null = null
let mentionSearchRequestToken = 0

const mentionPickerUsers = computed(() => mentionPickerItems.value.filter(item => item.kind === 'user'))
const mentionPickerTasks = computed(() => mentionPickerItems.value.filter(item => item.kind === 'task'))
const mentionPickerDocuments = computed(() => mentionPickerItems.value.filter(item => item.kind === 'document'))
const tableToolbarVisible = computed(() => {
  editorViewVersion.value
  return !!editor.value && editable.value && editor.value.isActive('table')
})

const AttachmentImage = TiptapNode.create({
  name: 'image',
  group: 'block',
  draggable: true,
  selectable: true,
  atom: true,
  addAttributes() {
    return {
      src: { default: null },
      alt: { default: '' },
      title: { default: null },
    }
  },
  parseHTML() {
    return [{ tag: 'img[src]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['img', HTMLAttributes]
  },
})

function markdownSignature(input: string): string {
  let hash = 0
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) - hash) + input.charCodeAt(i)
    hash |= 0
  }
  const preview = input.slice(0, 80).replace(/\n/g, '\\n')
  return `len=${input.length},hash=${hash},preview="${preview}"`
}

function descLog(event: string, payload: Record<string, unknown>) {
  if (!DEBUG_TASK_DESC) return
  console.debug('[task-desc-editor]', event, payload)
}

function editorStateSnapshot() {
  if (!editor.value) {
    return { mounted: false }
  }
  const state = editor.value.state
  const selection = state.selection
  return {
    mounted: true,
    from: selection.from,
    to: selection.to,
    empty: selection.empty,
    anchorParent: selection.$anchor.parent.type.name,
    headParent: selection.$head.parent.type.name,
    docChildCount: state.doc.childCount,
    docSize: state.doc.content.size,
    htmlLength: editor.value.getHTML().length,
  }
}

async function openAttachmentLinkFromEditor(href: string): Promise<void> {
  const parsed = parseAttachmentUrl(href)
  if (!parsed) return

  try {
    await openBlobInBrowser(() => fetchEditorAttachmentBlob(parsed.ownerKind, parsed.ownerId, parsed.attachmentId))
  } catch {
    return
  }
}

function fetchEditorAttachmentBlob(ownerKind: AttachmentOwnerKind | 'task-staged', ownerId: string, attachmentId: string): Promise<Blob> {
  if (ownerKind === 'task-staged') {
    return tasksFetchStagedAttachmentBlob(attachmentId)
  }
  return fetchOwnedAttachmentBlob(ownerKind, ownerId, attachmentId)
}

function openImagePreview(image: HTMLImageElement): boolean {
  const attachmentUrl = image.dataset.attachmentUrl ?? image.getAttribute('src') ?? ''
  if (!parseAttachmentUrl(attachmentUrl)) return false
  const src = (attachmentObjectUrls.get(attachmentUrl) ?? image.currentSrc) || image.src
  if (!src || parseAttachmentUrl(src)) return false

  imagePreview.value = {
    open: true,
    src,
    fileName: image.alt || image.title || 'Image',
  }
  return true
}

function closeImagePreview() {
  imagePreview.value = {
    open: false,
    src: '',
    fileName: '',
  }
}

function onImagePreviewKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !imagePreview.value.open) return
  event.preventDefault()
  event.stopPropagation()
  closeImagePreview()
}

function revokeAttachmentObjectUrls() {
  for (const url of attachmentObjectUrls.values()) {
    URL.revokeObjectURL(url)
  }
  attachmentObjectUrls.clear()
  attachmentLoadsInFlight.clear()
}

async function resolveEditorAttachmentImages() {
  const root = editor.value?.view.dom as HTMLElement | undefined
  if (!root) return
  const imageEls = Array.from(root.querySelectorAll([
    'img[src^="msgnr-attachment://"]',
    'img[data-attachment-url^="msgnr-attachment://"]',
    'img[src^="msgnr-staged-attachment://"]',
    'img[data-attachment-url^="msgnr-staged-attachment://"]',
  ].join(', '))) as HTMLImageElement[]
  for (const imageEl of imageEls) {
    const attachmentUrl = imageEl.dataset.attachmentUrl ?? imageEl.getAttribute('src') ?? ''
    const parsed = parseAttachmentUrl(attachmentUrl)
    if (!parsed) continue
    imageEl.dataset.attachmentUrl = attachmentUrl
    if (attachmentObjectUrls.has(attachmentUrl)) {
      imageEl.src = attachmentObjectUrls.get(attachmentUrl) ?? ''
      continue
    }
    if (attachmentLoadsInFlight.has(attachmentUrl)) continue
    attachmentLoadsInFlight.add(attachmentUrl)
    fetchEditorAttachmentBlob(parsed.ownerKind, parsed.ownerId, parsed.attachmentId)
      .then((blob) => {
        const objectUrl = URL.createObjectURL(blob)
        attachmentObjectUrls.set(attachmentUrl, objectUrl)
        const currentRoot = editor.value?.view.dom as HTMLElement | undefined
        const pendingEls = currentRoot
          ? Array.from(currentRoot.querySelectorAll(`img[data-attachment-url="${attachmentUrl}"]`)) as HTMLImageElement[]
          : []
        for (const pendingEl of pendingEls) {
          pendingEl.src = objectUrl
          pendingEl.classList.add('attachment-editor-inline-image')
        }
      })
      .catch(() => {
        imageEl.alt = `${imageEl.alt || 'Attachment'} (unavailable)`
      })
      .finally(() => {
        attachmentLoadsInFlight.delete(attachmentUrl)
      })
  }
}

function queueResolveEditorAttachmentImages() {
  queueMicrotask(() => {
    void resolveEditorAttachmentImages()
  })
}

function queueDecorateEditorMentionAnchors() {
  queueMicrotask(() => {
    const root = editor.value?.view.dom as HTMLElement | undefined
    if (!root) return
    decorateDescriptionMentionAnchors(root)
  })
}

function closeMentionPicker() {
  if (mentionSearchDebounceTimer) {
    clearTimeout(mentionSearchDebounceTimer)
    mentionSearchDebounceTimer = null
  }
  mentionSearchRequestToken += 1
  mentionPickerOpen.value = false
  mentionPickerLoading.value = false
  mentionPickerError.value = ''
  selectedMentionIndex.value = 0
  activeMentionQueryRange.value = null
  mentionPickerItems.value = []
}

async function ensureMentionUsersLoaded() {
  try {
    await warmDescriptionMentionUsersCache()
  } catch {
    return
  }
}

function updateMentionPickerPosition() {
  if (!editor.value) return
  const root = editor.value.view.dom as HTMLElement
  let top = 0
  let left = 0
  try {
    const position = activeMentionQueryRange.value?.to ?? editor.value.state.selection.from
    const coords = editor.value.view.coordsAtPos(position)
    top = coords.bottom + 8
    left = coords.left
  } catch {
    const rect = root.getBoundingClientRect()
    top = rect.top + 40
    left = rect.left
  }
  mentionPickerStyle.value = {
    position: 'fixed',
    top: `${top}px`,
    left: `${left}px`,
  }
}

function findMentionQueryAtCursor(): { from: number; to: number; query: string } | null {
  if (!editor.value) return null
  if (editor.value.isActive('code') || editor.value.isActive('codeBlock')) return null

  const selection = editor.value.state.selection
  if (!selection.empty) return null

  const parent = selection.$from.parent
  if (!parent.isTextblock) return null

  const cursorOffset = selection.$from.parentOffset
  const textBefore = parent.textBetween(0, cursorOffset, '\n', '\uFFFC')
  const match = textBefore.match(/(?:^|[\s([{])@([^\s@]*)$/)
  if (!match) return null

  const query = match[1] ?? ''
  return {
    from: selection.from - query.length - 1,
    to: selection.from,
    query,
  }
}

function refreshMentionSearch() {
  if (!editable.value) {
    closeMentionPicker()
    return
  }

  const query = findMentionQueryAtCursor()
  if (!query) {
    closeMentionPicker()
    return
  }

  activeMentionQueryRange.value = query
  mentionPickerOpen.value = true
  mentionPickerError.value = ''
  updateMentionPickerPosition()

  if (mentionSearchDebounceTimer) {
    clearTimeout(mentionSearchDebounceTimer)
  }

  mentionSearchDebounceTimer = setTimeout(async () => {
    const token = ++mentionSearchRequestToken
    mentionPickerLoading.value = true
    mentionPickerError.value = ''
    try {
      const results = await searchDescriptionMentionSuggestions(query.query)
      if (token !== mentionSearchRequestToken) return
      mentionPickerItems.value = results
      selectedMentionIndex.value = 0
      const userItems = results.filter(item => item.kind === 'user')
      if (userItems.length > 0) {
        void ensureMentionUsersLoaded()
      }
    } catch (error) {
      if (token !== mentionSearchRequestToken) return
      mentionPickerError.value = error instanceof Error ? error.message : 'Mention search failed'
      mentionPickerItems.value = []
    } finally {
      if (token === mentionSearchRequestToken) {
        mentionPickerLoading.value = false
      }
    }
  }, 120)
}

function refreshEditorViewState() {
  editorViewVersion.value += 1
}

async function openDirectMessageFromMention(href: string) {
  const mention = parseUserMentionHref(href)
  if (!mention) return

  try {
    const dm = await createOrOpenDm(mention.userId)
    chatStore.openDirectMessage({
      id: dm.conversation_id,
      userId: dm.user_id,
      displayName: dm.display_name || dm.email,
      avatarUrl: dm.avatar_url,
      customStatus: userCustomStatusFromDto(dm.custom_status),
      presence: 'offline',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    })
    if (router.currentRoute.value.name !== 'main') {
      await router.push({ name: 'main' })
    }
  } catch (error) {
    descLog('openDirectMessageFromMention:error', {
      href,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

function selectMentionItem(item: MessageTagPickerItem) {
  if (!editor.value || !activeMentionQueryRange.value) return
  editor.value.chain().focus().insertContentAt(
    { from: activeMentionQueryRange.value.from, to: activeMentionQueryRange.value.to },
    [
      {
        type: 'text',
        text: item.label,
        marks: [{
          type: 'link',
          attrs: {
            href: item.href,
          },
        }],
      },
      {
        type: 'text',
        text: ' ',
      },
    ],
  ).run()
  closeMentionPicker()
  nextTick(() => {
    queueDecorateEditorMentionAnchors()
  })
}

function buildEditorAttachmentNodes(rows: OwnedAttachmentUpload[]) {
  return rows.map((row) => {
    const url = props.attachmentUploadMode === 'task-staged'
      ? buildTaskStagedAttachmentUrl(row.id)
      : buildAttachmentUrl(props.ownerKind!, props.ownerId!, row.id)
    if (row.mime_type.startsWith('image/')) {
      return {
        type: 'image',
        attrs: {
          src: url,
          alt: row.file_name,
          title: row.file_name,
        },
      }
    }
    return {
      type: 'paragraph',
      content: [{
        type: 'text',
        text: row.file_name,
        marks: [{
          type: 'link',
          attrs: {
            href: url,
          },
        }],
      }],
    }
  })
}

async function uploadAndInsertFiles(files: File[]) {
  if (!files.length) return
  if (props.attachmentUploadMode !== 'task-staged' && (!props.ownerKind || !props.ownerId)) return
  const uploaded = await props.uploadAttachments(files)
  if (!uploaded || !editor.value) return
  editor.value.chain().focus().insertContent(buildEditorAttachmentNodes(uploaded)).run()
  queueResolveEditorAttachmentImages()
}

function isScrollableY(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element)
  const overflowY = style.overflowY
  if (overflowY !== 'auto' && overflowY !== 'scroll' && overflowY !== 'overlay') return false
  return element.scrollHeight > element.clientHeight + 1
}

function findNearestVerticalScrollContainer(start: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = start.parentElement
  while (node && node !== document.body && node !== document.documentElement) {
    if (isScrollableY(node)) return node
    node = node.parentElement
  }
  return null
}

function isFiniteRect(rect: Pick<DOMRect, 'top' | 'bottom'>): boolean {
  return Number.isFinite(rect.top) && Number.isFinite(rect.bottom)
}

function shouldKeepCurrentScrollForSelection(view: EditorView): boolean {
  try {
    const scrollContainer = findNearestVerticalScrollContainer(view.dom as HTMLElement)
    if (!scrollContainer) return false

    const selectionRect = view.coordsAtPos(view.state.selection.head, 1)
    const containerRect = scrollContainer.getBoundingClientRect()
    if (!isFiniteRect(selectionRect) || !isFiniteRect(containerRect)) return false

    const visibleTop = containerRect.top + SCROLL_SELECTION_VISIBILITY_MARGIN_PX
    const visibleBottom = containerRect.bottom - SCROLL_SELECTION_VISIBILITY_MARGIN_PX
    return selectionRect.top >= visibleTop && selectionRect.bottom <= visibleBottom
  } catch {
    return false
  }
}

const extensions = computed(() => {
  const list: AnyExtension[] = [
    StarterKit.configure({
      undoRedo: collabEnabled.value ? false : {},
      link: false,
    }),
    FenceOnEnterExtension,
    CodeBlockHighlightExtension,
    Link.configure({
      openOnClick: false,
      autolink: false,
      defaultProtocol: 'https',
    }),
    TaskList,
    TaskItem.configure({
      nested: true,
      HTMLAttributes: {
        'data-type': 'taskItem',
      },
    }),
    AttachmentImage,
    TaskTableNodeViewExtension,
    Table.configure({
      cellMinWidth: TASK_TABLE_CELL_MIN_WIDTH,
      resizable: false,
    }),
    TableRow,
    TableHeader,
    TableCell,
  ]

  if (collabEnabled.value && props.collabDoc) {
    list.push(Collaboration.configure({
      document: props.collabDoc,
      field: props.collabField,
    }))
    if (props.collabProvider) {
      list.push(CollaborationCaret.configure({
        provider: props.collabProvider,
        user: {
          id: props.collabUser?.id ?? '',
          name: props.collabUser?.name ?? 'User',
          color: props.collabUser?.color ?? '#60a5fa',
        },
      }))
    }
  }

  return list
})

const editor = useEditor({
  extensions: extensions.value,
  content: collabEnabled.value ? '' : renderTaskMarkdownToHtml(markdownDraft.value),
  editable: editable.value,
  editorProps: {
    attributes: {
      class: 'min-h-[140px] text-sm text-gray-100 outline-none',
    },
    handleScrollToSelection(view) {
      return shouldKeepCurrentScrollForSelection(view)
    },
    handleKeyDown(_view, event) {
      if (mentionPickerOpen.value) {
        if (event.key === 'ArrowDown') {
          if (mentionPickerItems.value.length === 0) return false
          event.preventDefault()
          selectedMentionIndex.value = (selectedMentionIndex.value + 1) % mentionPickerItems.value.length
          return true
        }
        if (event.key === 'ArrowUp') {
          if (mentionPickerItems.value.length === 0) return false
          event.preventDefault()
          selectedMentionIndex.value = (selectedMentionIndex.value - 1 + mentionPickerItems.value.length) % mentionPickerItems.value.length
          return true
        }
        if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
          const item = mentionPickerItems.value[selectedMentionIndex.value]
          if (!item) return false
          event.preventDefault()
          selectMentionItem(item)
          return true
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          closeMentionPicker()
          return true
        }
      }

      if (event.key === 'Escape') {
        closeMentionPicker()
      }

      return false
    },
    handleDOMEvents: {
      mousedown(_view, event) {
        const handled = handleMarkdownLinkClick(event as MouseEvent, router, {
          onAttachmentLink: openAttachmentLinkFromEditor,
          onUserMentionLink: openDirectMessageFromMention,
        })
        if (handled) {
          event.stopPropagation()
        }
        return handled
      },
      click(_view, event) {
        const target = event.target
        if (!(target instanceof HTMLImageElement) || !openImagePreview(target)) return false
        event.preventDefault()
        event.stopPropagation()
        return true
      },
    },
    handlePaste(_view, event) {
      const files = Array.from(event.clipboardData?.files ?? [])
      if (!files.length) return false
      event.preventDefault()
      void uploadAndInsertFiles(files)
      return true
    },
    handleDrop(view, event) {
      const files = Array.from(event.dataTransfer?.files ?? [])
      if (!files.length) return false
      const coords = view.posAtCoords({ left: event.clientX, top: event.clientY })
      if (coords) {
        view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(coords.pos))))
      }
      event.preventDefault()
      void uploadAndInsertFiles(files)
      return true
    },
  },
  onBlur() {
    emit('blur')
  },
  onCreate() {
    refreshEditorViewState()
    syncEditorContentEmpty('onCreate')
    queueResolveEditorAttachmentImages()
    queueDecorateEditorMentionAnchors()
  },
  onUpdate({ editor: nextEditor }) {
    refreshEditorViewState()
    syncEditorContentEmpty('onUpdate:start')
    if (suppressEditorSync.value) return
    const nextMarkdown = tiptapJsonToMarkdown(nextEditor.getJSON())
    descLog('onUpdate', {
      collab: collabEnabled.value,
      next: markdownSignature(nextMarkdown),
      current: markdownSignature(markdownDraft.value),
      snapshot: editorStateSnapshot(),
    })
    if (nextMarkdown === markdownDraft.value) return
    syncingFromEditor.value = true
    markdownDraft.value = nextMarkdown
    emit('update:modelValue', nextMarkdown)
    syncingFromEditor.value = false
    syncEditorContentEmpty('onUpdate:done')
    queueResolveEditorAttachmentImages()
    queueDecorateEditorMentionAnchors()
    refreshMentionSearch()
  },
  onSelectionUpdate() {
    refreshEditorViewState()
    updateMentionPickerPosition()
    refreshMentionSearch()
  },
})

function isActive(name: string, attrs?: Record<string, unknown>) {
  return editor.value?.isActive(name, attrs) ?? false
}

function canRunTableCommand(command: TableCommand): boolean {
  if (!editor.value || !editable.value || !isActive('table')) return false
  try {
    const chain = editor.value.can().chain().focus() as unknown as TableCommandRunner
    return chain[command]().run()
  } catch {
    return false
  }
}

function runTableCommand(command: TableCommand) {
  if (!editor.value || !editable.value || !canRunTableCommand(command)) return
  const chain = editor.value.chain().focus() as unknown as TableCommandRunner
  chain[command]().run()
  refreshEditorViewState()
}

function setContentWithSafeSelection(html: string): boolean {
  if (!editor.value || !props.collabDoc) return false
  const schema = editor.value.schema
  const wrapper = document.createElement('div')
  wrapper.innerHTML = html
  const parsedDoc = ProseMirrorDOMParser.fromSchema(schema).parse(wrapper)
  const fragment = props.collabDoc.getXmlFragment(props.collabField)
  props.collabDoc.transact(() => {
    fragment.delete(0, fragment.length)
    prosemirrorJSONToYXmlFragment(schema, parsedDoc.toJSON(), fragment)
  })
  return true
}

function setEditorContentFromMarkdown(markdown: string, emitUpdate: boolean, reason: string) {
  if (!editor.value) return
  const beforeSnapshot = editorStateSnapshot()
  descLog('setEditorContentFromMarkdown', {
    reason,
    collab: collabEnabled.value,
    emitUpdate,
    markdown: markdownSignature(markdown),
    beforeSnapshot,
  })
  const html = renderTaskMarkdownToHtml(markdown)
  try {
    if (!emitUpdate) {
      suppressEditorSync.value = true
    }
    const strategy = collabEnabled.value ? 'safe-transaction' : 'setContent'
    const ok = collabEnabled.value
      ? setContentWithSafeSelection(html)
      : editor.value.commands.setContent(html, { emitUpdate })
    descLog('setEditorContentFromMarkdown:done', {
      reason,
      collab: collabEnabled.value,
      emitUpdate,
      strategy,
      ok,
      htmlLength: html.length,
      afterSnapshot: editorStateSnapshot(),
      afterMarkdown: markdownSignature(tiptapJsonToMarkdown(editor.value.getJSON())),
    })
    syncEditorContentEmpty(`setEditorContentFromMarkdown:${reason}`)
    queueResolveEditorAttachmentImages()
    queueDecorateEditorMentionAnchors()
  } catch (error) {
    descLog('setEditorContentFromMarkdown:error', {
      reason,
      collab: collabEnabled.value,
      emitUpdate,
      htmlLength: html.length,
      error: error instanceof Error ? error.message : String(error),
      afterSnapshot: editorStateSnapshot(),
    })
    throw error
  } finally {
    if (!emitUpdate) {
      suppressEditorSync.value = false
    }
  }
}

function isEditorEffectivelyEmpty(): boolean {
  if (!editor.value) return true
  const currentMarkdown = tiptapJsonToMarkdown(editor.value.getJSON()).trim()
  return currentMarkdown.length === 0
}

function syncEditorContentEmpty(reason: string) {
  const empty = isEditorEffectivelyEmpty()
  editorContentEmpty.value = empty
  descLog('syncEditorContentEmpty', {
    reason,
    collab: collabEnabled.value,
    empty,
    markdown: markdownSignature(markdownDraft.value),
    snapshot: editorStateSnapshot(),
  })
}

function maybeSeedCollabEditorFromDraft(reason: string) {
  if (!collabEnabled.value || !editor.value) return
  if (seedInProgress) {
    descLog('maybeSeedCollabEditorFromDraft:skip-in-progress', { reason })
    return
  }
  const draft = markdownDraft.value
  const empty = isEditorEffectivelyEmpty()
  descLog('maybeSeedCollabEditorFromDraft', {
    reason,
    allowLocalDraftSeed: props.allowLocalDraftSeed,
    draft: markdownSignature(draft),
    empty,
    snapshot: editorStateSnapshot(),
  })
  if (!props.allowLocalDraftSeed) return
  if (draft.trim() === '') return
  if (!empty) return
  seedInProgress = true
  try {
    setEditorContentFromMarkdown(draft, false, reason)
  } finally {
    seedInProgress = false
  }
}

function normalizeMarkdownForSyncComparison(markdown: string): string {
  // Markdown <-> ProseMirror round-trips can normalize trailing whitespace/newlines.
  return markdown.replace(/\r\n/g, '\n').trimEnd()
}

function syncCollabEditorFromDraftIfNeeded(reason: string) {
  if (!collabEnabled.value || !editor.value) return
  if (props.collabHasRemotePeers) {
    descLog('syncCollabEditorFromDraftIfNeeded:skip-remote-peers', { reason })
    return
  }
  const currentMarkdown = tiptapJsonToMarkdown(editor.value.getJSON())
  const normalizedCurrent = normalizeMarkdownForSyncComparison(currentMarkdown)
  const normalizedDraft = normalizeMarkdownForSyncComparison(markdownDraft.value)
  descLog('syncCollabEditorFromDraftIfNeeded', {
    reason,
    current: markdownSignature(currentMarkdown),
    draft: markdownSignature(markdownDraft.value),
    normalizedCurrent: markdownSignature(normalizedCurrent),
    normalizedDraft: markdownSignature(normalizedDraft),
  })
  if (normalizedCurrent === normalizedDraft) return
  setEditorContentFromMarkdown(markdownDraft.value, false, reason)
}

function toggleLink() {
  if (!editor.value || !editable.value) return
  const previous = String(editor.value.getAttributes('link').href ?? '')
  const input = window.prompt('Enter URL', previous || 'https://')
  if (input === null) return
  const href = input.trim()
  if (!href) {
    editor.value.chain().focus().unsetLink().run()
    return
  }
  editor.value.chain().focus().setLink({ href }).run()
}

function convertSelectionToCodeBlock() {
  if (!editor.value || !editable.value) return
  const { state, view } = editor.value
  const { selection, schema } = state
  if (selection.empty) return

  const codeBlock = schema.nodes.codeBlock
  if (!codeBlock) return

  const selectedText = state.doc.textBetween(selection.from, selection.to, '\n', '\n')
  if (!selectedText) return

  const node = codeBlock.create(
    { language: null },
    schema.text(selectedText),
  )
  view.dispatch(state.tr.replaceSelectionWith(node, false).scrollIntoView())
  view.focus()
}

function insertTable() {
  if (!editor.value || !editable.value) return
  if (editor.value.isActive('table')) return
  editor.value.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
}

watch(
  () => props.modelValue,
  (next) => {
    const normalized = next ?? ''
    descLog('watch:modelValue', {
      collab: collabEnabled.value,
      next: markdownSignature(normalized),
      current: markdownSignature(markdownDraft.value),
    })
    if (normalized === markdownDraft.value) return
    syncingFromModel.value += 1
    markdownDraft.value = normalized
    queueMicrotask(() => {
      syncingFromModel.value = Math.max(0, syncingFromModel.value - 1)
    })
    if (collabEnabled.value) {
      nextTick(() => {
        maybeSeedCollabEditorFromDraft('watch-modelValue-collab-seed')
      })
      return
    }
    setEditorContentFromMarkdown(normalized, true, 'watch-modelValue')
  },
)

watch(markdownDraft, (next) => {
  descLog('watch:markdownDraft', {
    collab: collabEnabled.value,
    syncingFromEditor: syncingFromEditor.value,
    syncingFromModel: syncingFromModel.value,
    next: markdownSignature(next),
    modelValue: markdownSignature(props.modelValue ?? ''),
  })
  if (syncingFromModel.value > 0) {
    nextTick(() => {
      maybeSeedCollabEditorFromDraft('watch-markdownDraft-syncingFromModel-collab-seed')
    })
    return
  }
  if (next !== props.modelValue) {
    emit('update:modelValue', next)
  }
  if (syncingFromEditor.value) return
  if (!collabEnabled.value) return
  maybeSeedCollabEditorFromDraft('watch-markdownDraft-rendered-collab-seed')
})

watch(
  () => props.editable,
  (next) => {
    editor.value?.setEditable(!!next)
  },
)

watch(
  () => props.allowLocalDraftSeed,
  (next, prev) => {
    if (!collabEnabled.value || !next || prev === next) return
    nextTick(() => {
      maybeSeedCollabEditorFromDraft('watch-allowLocalDraftSeed-enabled-collab-seed')
    })
  },
)

watch(
  () => props.forceLocalSyncToken,
  (next, prev) => {
    if (!collabEnabled.value || next === prev) return
    syncCollabEditorFromDraftIfNeeded('watch-forceLocalSyncToken')
  },
)

watch(editor, (next) => {
  if (!next) return
  next.on('transaction', ({ transaction }) => {
    refreshEditorViewState()
    syncEditorContentEmpty('transaction')
    descLog('transaction', {
      collab: collabEnabled.value,
      docChanged: transaction.docChanged,
      selectionSet: transaction.selectionSet,
      snapshot: editorStateSnapshot(),
    })
    if (transaction.docChanged) {
      queueResolveEditorAttachmentImages()
    }
    queueDecorateEditorMentionAnchors()
  })
  if (collabEnabled.value) {
    descLog('watch:editor', { collab: true, skip: true })
    syncEditorContentEmpty('watch-editor:collab')
    maybeSeedCollabEditorFromDraft('watch-editor-collab-initial-seed')
    if (props.forceLocalSyncToken > 0) {
      syncCollabEditorFromDraftIfNeeded('watch-editor-forceLocalSyncToken')
    }
    return
  }
  syncEditorContentEmpty('watch-editor:non-collab')
  setEditorContentFromMarkdown(markdownDraft.value, false, 'watch-editor-immediate')
}, { immediate: true })

watch(showRenderedFallback, (next, prev) => {
  if (!collabEnabled.value) return
  if (next === prev) return
  descLog('showRenderedFallback', {
    next,
    collab: collabEnabled.value,
    allowLocalDraftSeed: props.allowLocalDraftSeed,
    markdown: markdownSignature(markdownDraft.value),
    snapshot: editorStateSnapshot(),
  })
}, { immediate: true })

watch(() => imagePreview.value.open, (open) => {
  if (open) {
    window.addEventListener('keydown', onImagePreviewKeydown, true)
    return
  }
  window.removeEventListener('keydown', onImagePreviewKeydown, true)
})

onBeforeUnmount(() => {
  if (mentionSearchDebounceTimer) {
    clearTimeout(mentionSearchDebounceTimer)
    mentionSearchDebounceTimer = null
  }
  window.removeEventListener('keydown', onImagePreviewKeydown, true)
  revokeAttachmentObjectUrls()
})

defineExpose<{
  editor: typeof editor
  convertSelectionToCodeBlock: typeof convertSelectionToCodeBlock
}>({
  editor,
  convertSelectionToCodeBlock,
})
</script>

<style scoped>
.toolbar-btn {
  @apply rounded border border-chat-border bg-chat-bg px-2 py-1 text-xs text-gray-300 transition-colors hover:border-accent/60 hover:text-white;
}

.toolbar-btn:disabled {
  @apply cursor-not-allowed opacity-50 hover:border-chat-border hover:text-gray-300;
}

.toolbar-btn-active {
  @apply border-accent bg-accent/20 text-white;
}

.toolbar-btn-danger {
  @apply hover:border-red-400/70 hover:text-red-200;
}

.task-editor-menu-panel {
  @apply flex flex-wrap gap-1 rounded border border-chat-border bg-chat-bg/95 p-1 shadow-lg;
}

.task-table-toolbar {
  @apply flex flex-wrap gap-1 rounded border border-chat-border bg-chat-bg/95 p-1 shadow-lg;
}

.task-description-editor-content :deep(.ProseMirror) {
  @apply min-h-[140px] text-base leading-relaxed text-gray-300 outline-none;
}

.task-description-editor-content :deep(.task-table-wrapper) {
  position: relative;
  display: grid;
  grid-template-areas: "viewport";
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: minmax(0, auto);
  width: 100%;
  max-width: 100%;
  min-width: 0;
  margin: 16px 0;
}

.task-description-editor-content :deep(.task-table-wrapper--editable) {
  grid-template-areas:
    "viewport column"
    "row spacer";
  grid-template-columns: minmax(0, 1fr) 20px;
  grid-template-rows: minmax(0, auto) 20px;
}

.task-description-editor-content :deep(.task-table-scroll) {
  grid-area: viewport;
  min-width: 0;
  max-width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior-inline: contain;
}

.task-description-editor-content :deep(.task-table-scroll > table) {
  margin: 0;
  max-width: none;
}

.task-description-editor-content :deep(.task-table-add) {
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: rgb(var(--color-bg-tertiary));
  color: rgb(var(--color-text-muted));
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition: opacity 140ms ease, background-color 140ms ease, color 140ms ease;
}

.task-description-editor-content :deep(.task-table-wrapper:hover .task-table-add),
.task-description-editor-content :deep(.task-table-wrapper:focus-within .task-table-add),
.task-description-editor-content :deep(.task-table-add:focus-visible) {
  opacity: 1;
}

.task-description-editor-content :deep(.task-table-add:hover),
.task-description-editor-content :deep(.task-table-add:focus-visible) {
  outline: 0;
  background: rgb(var(--color-accent) / 0.16);
  color: rgb(var(--color-accent));
}

.task-description-editor-content :deep(.task-table-add:disabled) {
  display: none;
}

.task-description-editor-content :deep(.task-table-add--column) {
  grid-area: column;
  width: 20px;
  min-height: 0;
}

.task-description-editor-content :deep(.task-table-add--row) {
  grid-area: row;
  width: 100%;
  height: 20px;
}

.task-description-editor-content :deep(.task-table-column-actions) {
  position: absolute;
  z-index: 10;
  display: grid;
  width: 20px;
  height: 20px;
  place-items: center;
  padding: 0;
  border: 1px solid rgb(var(--color-divider) / 0.8);
  border-radius: 5px;
  background: rgb(var(--color-bg-tertiary));
  color: rgb(var(--color-text-secondary));
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  box-shadow: 0 2px 8px rgb(0 0 0 / 0.22);
}

.task-description-editor-content :deep(.task-table-column-actions[hidden]),
.task-description-editor-content :deep(.task-table-column-menu[hidden]) {
  display: none !important;
}

.task-description-editor-content :deep(.task-table-column-actions:hover),
.task-description-editor-content :deep(.task-table-column-actions:focus-visible) {
  outline: 0;
  border-color: rgb(var(--color-accent) / 0.7);
  background: rgb(var(--color-accent) / 0.14);
  color: rgb(var(--color-accent));
}

.task-description-editor-content :deep(.task-table-column-menu) {
  position: absolute;
  z-index: 20;
  min-width: 164px;
  padding: 4px;
  border: 1px solid rgb(var(--color-divider));
  border-radius: 7px;
  background: rgb(var(--color-bg-secondary));
  box-shadow: 0 10px 24px rgb(0 0 0 / 0.3);
}

.task-description-editor-content :deep(.task-table-column-menu-item) {
  display: block;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: rgb(var(--color-text-secondary));
  font: inherit;
  font-size: 0.8125rem;
  text-align: left;
  cursor: pointer;
}

.task-description-editor-content :deep(.task-table-column-menu-item:hover),
.task-description-editor-content :deep(.task-table-column-menu-item:focus-visible) {
  outline: 0;
  background: rgb(var(--color-accent) / 0.13);
}

.task-description-editor-content :deep(.task-table-column-menu-item--danger:hover),
.task-description-editor-content :deep(.task-table-column-menu-item--danger:focus-visible) {
  background: rgb(248 113 113 / 0.13);
  color: rgb(248 113 113);
}

.task-description-editor-content :deep(.task-table-column-menu-item:disabled) {
  cursor: not-allowed;
  opacity: 0.55;
}

.task-description-editor-content :deep(th),
.task-description-editor-content :deep(td) {
  position: relative;
}

.task-description-editor-content :deep(.task-table-resize-edge-hover::after),
.task-description-editor-content :deep(.task-table-resize-edge-active::after) {
  content: "";
  position: absolute;
  top: -1px;
  right: -1px;
  bottom: -1px;
  z-index: 5;
  width: 2px;
  background: rgb(var(--color-accent));
  pointer-events: none;
}

:global(body.task-table-is-resizing),
:global(body.task-table-is-resizing *) {
  cursor: col-resize !important;
  user-select: none !important;
}

.task-description-editor-content :deep(.attachment-editor-inline-image) {
  @apply max-h-[260px] max-w-full cursor-zoom-in rounded-lg border border-chat-border/70 bg-chat-input/60 shadow-sm transition-colors hover:border-accent/70;
}

.task-description-editor-content :deep(.collaboration-carets__caret) {
  border-left-width: 2px;
  border-left-style: solid;
  margin-left: -1px;
  margin-right: -1px;
  pointer-events: none;
  position: relative;
}

.task-description-editor-content :deep(.collaboration-carets__label) {
  @apply absolute -top-5 left-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] text-white;
}
</style>
