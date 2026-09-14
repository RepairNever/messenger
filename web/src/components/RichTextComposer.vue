<template>
  <div class="relative min-h-0 flex-1">
    <EditorContent
      v-if="editor"
      ref="editorContentRef"
      :editor="editor"
      class="rich-text-composer"
      :data-testid="dataTestid"
    />

    <MessageTagPicker
      v-if="enableMessageEntities"
      :open="tagPickerOpen"
      :loading="tagPickerLoading"
      :error="tagPickerError"
      :style="tagPickerStyle"
      :selected-index="selectedTagIndex"
      :users="tagPickerUsers"
      :tasks="tagPickerTasks"
      :documents="tagPickerDocuments"
      @select="selectTagItem"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Editor as TiptapEditor, JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import type { MessageEntity } from '@/stores/chat'
import { searchTagEntities, type TagSearchResponse } from '@/services/http/chatApi'
import { tasksGet } from '@/services/http/tasksApi'
import {
  PendingPasteCandidatesExtension,
  addPendingPasteCandidateToTransaction,
  clearPendingPasteCandidates,
  findPendingPasteCandidate,
  removePendingPasteCandidate,
  removePendingPasteCandidateFromTransaction,
} from '@/editor/pendingPasteCandidates'
import { renderMarkdownToHtml } from '@/utils/markdown'
import { renderTaskMarkdownToHtml } from '@/utils/taskMarkdown'
import { tiptapJsonToMarkdown } from '@/utils/tiptapMarkdown'
import { MessageEntityNode } from '@/editor/messageEntity'
import { FenceOnEnterExtension, shouldSubmitOnEnter } from '@/editor/richTextShortcuts'
import { renderMessageEditorHtml, tiptapJsonToMessagePayload } from '@/utils/messageRichText'
import { buildTaskMentionHref, buildTaskMentionLabel } from '@/utils/descriptionMentions'
import { findStandaloneCurrentWorkspaceTaskUrl } from '@/utils/taskUrlMention'
import MessageTagPicker, { type MessageTagPickerItem } from './MessageTagPicker.vue'
import { userCustomStatusFromDto } from '@/types/userStatus'

const props = withDefaults(defineProps<{
  modelValue: string
  entities?: MessageEntity[]
  placeholder?: string
  disabled?: boolean
  focusToken?: number
  maxLines?: number | null
  enableTaskItems?: boolean
  enableMessageEntities?: boolean
  conversationId?: string
  submitOnEnter?: boolean
  dataTestid?: string
  onFiles?: ((files: File[]) => void | Promise<void>) | null
}>(), {
  entities: () => [],
  placeholder: '',
  disabled: false,
  focusToken: 0,
  maxLines: null,
  enableTaskItems: false,
  enableMessageEntities: false,
  conversationId: '',
  submitOnEnter: false,
  dataTestid: 'rich-text-composer',
  onFiles: null,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'update:entities': [value: MessageEntity[]]
  submit: [{ body: string; entities: MessageEntity[] }]
  'pending-task-url-paste-change': [pending: boolean]
  'empty-arrow-up': []
  blur: []
  resize: [deltaPx: number]
}>()

const editorContentRef = ref<InstanceType<typeof EditorContent> | null>(null)
const textDraft = ref(props.modelValue ?? '')
const entitiesDraft = ref<MessageEntity[]>([...(props.entities ?? [])])
const suppressEditorSync = ref(false)
const lastMeasuredHeight = ref(0)

interface PendingTaskUrlPaste {
  url: string
  sliceJson: string
}

let handledFocusToken = 0
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null
let searchRequestToken = 0
let pendingTaskUrlPasteSequence = 0
let composerUnmounted = false
const pendingTaskUrlPastes = new Map<string, PendingTaskUrlPaste>()

const tagPickerOpen = ref(false)
const tagPickerLoading = ref(false)
const tagPickerError = ref('')
const tagPickerStyle = ref<Record<string, string>>({
  top: '0px',
  left: '0px',
})
const selectedTagIndex = ref(0)
const tagSearchResults = ref<TagSearchResponse>({
  users: [],
  tasks: [],
  documents: [],
})
const activeQueryRange = ref<{ from: number; to: number; query: string } | null>(null)

const tagPickerUsers = computed<MessageTagPickerItem[]>(() =>
  (tagSearchResults.value.users ?? []).map((item, index) => ({
    kind: 'user',
    id: item.user_id,
    label: `@${item.display_name || item.email}`,
    subtitle: item.email,
    href: '',
    icon: '@',
    avatarUrl: item.avatar_url,
    customStatus: userCustomStatusFromDto(item.custom_status),
    flatIndex: index,
    meta: {
      email: item.email,
      presence: item.presence,
    },
  })),
)

const tagPickerTasks = computed<MessageTagPickerItem[]>(() =>
  (tagSearchResults.value.tasks ?? []).map((item, index) => ({
    kind: 'task',
    id: item.task_id,
    label: item.label,
    subtitle: item.title,
    href: item.href,
    icon: '#',
    flatIndex: tagPickerUsers.value.length + index,
  })),
)

const tagPickerDocuments = computed<MessageTagPickerItem[]>(() =>
  (tagSearchResults.value.documents ?? []).map((item, index) => ({
    kind: 'document',
    id: item.document_id,
    label: item.label,
    subtitle: item.title,
    href: item.href,
    icon: 'D',
    flatIndex: tagPickerUsers.value.length + tagPickerTasks.value.length + index,
  })),
)

const flatTagItems = computed(() => [
  ...tagPickerUsers.value,
  ...tagPickerTasks.value,
  ...tagPickerDocuments.value,
])

function renderValueAsHtml(body: string, nextEntities: MessageEntity[]): string {
  if (props.enableMessageEntities) {
    return renderMessageEditorHtml(body, nextEntities)
  }
  if (props.enableTaskItems) {
    return renderTaskMarkdownToHtml(body)
  }
  return renderMarkdownToHtml(body)
}

function closeTagPicker() {
  tagPickerOpen.value = false
  tagPickerLoading.value = false
  tagPickerError.value = ''
  selectedTagIndex.value = 0
  activeQueryRange.value = null
}

function updateTagPickerPosition() {
  const root = editor.value?.view.dom as HTMLElement | undefined
  if (!root) return
  const rect = root.getBoundingClientRect()
  tagPickerStyle.value = {
    position: 'fixed',
    top: `${rect.top - 8}px`,
    left: `${rect.left}px`,
    transform: 'translateY(-100%)',
  }
}

function findMentionQueryAtCursor(): { from: number; to: number; query: string } | null {
  if (!props.enableMessageEntities || !props.conversationId || !editor.value) return null
  if (editor.value.isActive('code') || editor.value.isActive('codeBlock')) return null

  const selection = editor.value.state.selection
  if (!selection.empty) return null

  const parent = selection.$from.parent
  if (!parent.isTextblock) return null

  const cursorOffset = selection.$from.parentOffset
  const textBefore = parent.textBetween(0, cursorOffset, '\n', '\uFFFC')
  const boundary = Math.max(
    textBefore.lastIndexOf(' '),
    textBefore.lastIndexOf('\n'),
    textBefore.lastIndexOf('\r'),
    textBefore.lastIndexOf('\t'),
    textBefore.lastIndexOf('\uFFFC'),
  )
  const token = textBefore.slice(boundary + 1)
  if (!token.startsWith('@')) return null

  const tokenStartOffset = cursorOffset - token.length
  return {
    from: selection.$from.start() + tokenStartOffset,
    to: selection.from,
    query: token.slice(1),
  }
}

function refreshTagSearch() {
  if (!props.enableMessageEntities || !props.conversationId) {
    closeTagPicker()
    return
  }

  const query = findMentionQueryAtCursor()
  if (!query) {
    closeTagPicker()
    return
  }

  activeQueryRange.value = query
  tagPickerOpen.value = true
  updateTagPickerPosition()

  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer)
  }

  searchDebounceTimer = setTimeout(async () => {
    const token = ++searchRequestToken
    tagPickerLoading.value = true
    tagPickerError.value = ''
    try {
      const results = await searchTagEntities(props.conversationId!, query.query)
      if (token !== searchRequestToken) return
      tagSearchResults.value = results
      selectedTagIndex.value = 0
    } catch (error) {
      if (token !== searchRequestToken) return
      tagPickerError.value = error instanceof Error ? error.message : 'Search failed'
      tagSearchResults.value = { users: [], tasks: [], documents: [] }
    } finally {
      if (token === searchRequestToken) {
        tagPickerLoading.value = false
      }
    }
  }, 120)
}

function serializeCurrentState(doc: JSONContent | null | undefined = editor.value?.getJSON()) {
  if (!doc) {
    return {
      body: '',
      entities: [] as MessageEntity[],
    }
  }
  if (props.enableMessageEntities) {
    return tiptapJsonToMessagePayload(doc)
  }
  return {
    body: tiptapJsonToMarkdown(doc),
    entities: [] as MessageEntity[],
  }
}

function parsePx(value: string | null | undefined): number {
  const parsed = Number.parseFloat(value ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

function syncComposerHeight() {
  const root = editor.value?.view.dom as HTMLElement | undefined
  if (!root) return

  root.style.height = 'auto'
  const style = window.getComputedStyle(root)
  const fontSize = parsePx(style.fontSize) || 16
  const lineHeight = parsePx(style.lineHeight) || (fontSize * 1.5)
  const paddingTop = parsePx(style.paddingTop)
  const paddingBottom = parsePx(style.paddingBottom)
  const minHeight = Math.ceil(lineHeight + paddingTop + paddingBottom)
  let nextHeight = Math.max(root.scrollHeight, minHeight)

  if (typeof props.maxLines === 'number') {
    const maxHeight = Math.ceil((lineHeight * props.maxLines) + paddingTop + paddingBottom)
    root.style.maxHeight = `${maxHeight}px`
    nextHeight = Math.min(nextHeight, maxHeight)
    root.style.overflowY = root.scrollHeight > maxHeight ? 'auto' : 'hidden'
  } else {
    root.style.maxHeight = ''
    root.style.overflowY = 'hidden'
  }

  root.style.height = `${nextHeight}px`
  if (lastMeasuredHeight.value !== 0 && lastMeasuredHeight.value !== nextHeight) {
    emit('resize', nextHeight - lastMeasuredHeight.value)
  }
  lastMeasuredHeight.value = nextHeight
}

function shouldShowPlaceholder(): boolean {
  if (!editor.value) return true
  if (!editor.value.isEmpty) return false

  const doc = editor.value.state.doc
  if (doc.childCount === 0) return true
  if (doc.childCount > 1) return false

  const firstChild = doc.firstChild
  return firstChild?.type.name === 'paragraph' && firstChild.childCount === 0
}

function syncPlaceholderState(placeholder = props.placeholder) {
  const root = editor.value?.view.dom as HTMLElement | undefined
  if (!root) return
  root.dataset.placeholder = placeholder
  root.classList.toggle('is-empty', shouldShowPlaceholder())
}

async function handleFiles(files: File[]) {
  if (!files.length || !props.onFiles) return
  await props.onFiles(files)
}

function applyValue(body: string, nextEntities: MessageEntity[] = [], emitUpdates = true) {
  const normalizedBody = body ?? ''
  const normalizedEntities = [...(nextEntities ?? [])]
  clearAllPendingTaskUrlPastes()
  textDraft.value = normalizedBody
  entitiesDraft.value = normalizedEntities

  if (editor.value) {
    suppressEditorSync.value = true
    editor.value.commands.setContent(renderValueAsHtml(normalizedBody, normalizedEntities), { emitUpdate: false })
    suppressEditorSync.value = false
  }

  if (emitUpdates) {
    emit('update:modelValue', normalizedBody)
    emit('update:entities', normalizedEntities)
  }

  nextTick(() => {
    syncPlaceholderState()
    syncComposerHeight()
    refreshTagSearch()
  })
}

function emitSubmit() {
  if (pendingTaskUrlPastes.size > 0) return
  const payload = serializeCurrentState()
  emit('submit', payload)
}

const editor = useEditor({
  extensions: [
    StarterKit.configure({
      link: false,
    }),
    Link.configure({
      openOnClick: false,
      autolink: false,
      defaultProtocol: 'https',
    }),
    FenceOnEnterExtension,
    ...(props.enableTaskItems
      ? [
          TaskList,
          TaskItem.configure({
            nested: true,
            HTMLAttributes: {
              'data-type': 'taskItem',
            },
          }),
        ]
      : []),
    ...(props.enableMessageEntities ? [MessageEntityNode] : []),
    ...(props.enableMessageEntities ? [PendingPasteCandidatesExtension] : []),
  ],
  content: renderValueAsHtml(textDraft.value, entitiesDraft.value),
  editable: !props.disabled,
  editorProps: {
    attributes: {
      class: 'rich-text-composer__content min-h-[24px] whitespace-pre-wrap break-words bg-transparent text-sm leading-relaxed text-app-text outline-none',
    },
    handleKeyDown(_view, event) {
      if (tagPickerOpen.value) {
        if (event.key === 'ArrowDown') {
          if (flatTagItems.value.length === 0) return false
          event.preventDefault()
          selectedTagIndex.value = (selectedTagIndex.value + 1) % flatTagItems.value.length
          return true
        }
        if (event.key === 'ArrowUp') {
          if (flatTagItems.value.length === 0) return false
          event.preventDefault()
          selectedTagIndex.value = (selectedTagIndex.value - 1 + flatTagItems.value.length) % flatTagItems.value.length
          return true
        }
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          const item = flatTagItems.value[selectedTagIndex.value]
          if (item) selectTagItem(item)
          return true
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          closeTagPicker()
          return true
        }
      }

      if (event.key === 'Escape') {
        closeTagPicker()
        return false
      }

      if (
        event.key === 'ArrowUp'
        && !event.altKey
        && !event.ctrlKey
        && !event.metaKey
        && !event.shiftKey
        && !event.isComposing
        && serializeCurrentState().body.trim().length === 0
      ) {
        event.preventDefault()
        emit('empty-arrow-up')
        return true
      }

      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        emitSubmit()
        return true
      }

      if (event.key === 'Enter' && event.shiftKey) {
        if (editor.value?.isActive('codeBlock')) return false
        event.preventDefault()
        return editor.value?.commands.setHardBreak() ?? false
      }

      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && props.submitOnEnter && shouldSubmitOnEnter(editor.value!)) {
        event.preventDefault()
        emitSubmit()
        return true
      }

      return false
    },
    handlePaste(view, event) {
      const files = Array.from(event.clipboardData?.files ?? [])
      if (files.length && props.onFiles) {
        event.preventDefault()
        void handleFiles(files)
        return true
      }

      if (!props.enableMessageEntities || props.disabled || editor.value?.isActive('code') || editor.value?.isActive('codeBlock')) {
        return false
      }

      const pastedText = event.clipboardData?.getData('text/plain') ?? ''
      const currentWorkspaceOrigin = `${window.location.protocol}//${window.location.host}`
      const taskUrl = findStandaloneCurrentWorkspaceTaskUrl(pastedText, currentWorkspaceOrigin)
      if (!taskUrl) return false

      event.preventDefault()
      const { from, to } = view.state.selection
      const id = `task-url-paste-${++pendingTaskUrlPasteSequence}`
      const transaction = view.state.tr.insertText(pastedText, from, to)
      const registered = addPendingPasteCandidateToTransaction(transaction, {
        id,
        from: from + taskUrl.start,
        to: from + taskUrl.end,
      })
      view.dispatch(transaction)
      if (!registered) return true

      const pendingRange = findPendingPasteCandidate(view.state, id)
      if (!pendingRange) return true

      pendingTaskUrlPastes.set(id, {
        url: taskUrl.url,
        sliceJson: JSON.stringify(view.state.doc.slice(pendingRange.from, pendingRange.to).toJSON()),
      })
      emit('pending-task-url-paste-change', true)
      void resolveTaskUrlPaste(id, taskUrl)
      return true
    },
    handleDrop(_view, event) {
      const files = Array.from(event.dataTransfer?.files ?? [])
      if (!files.length || !props.onFiles) return false
      event.preventDefault()
      void handleFiles(files)
      return true
    },
  },
  onCreate() {
    syncPlaceholderState()
    syncComposerHeight()
    refreshTagSearch()
  },
  onUpdate({ editor: nextEditor }) {
    if (suppressEditorSync.value) return
    clearModifiedTaskUrlPastes(nextEditor)
    const payload = serializeCurrentState(nextEditor.getJSON())
    textDraft.value = payload.body
    entitiesDraft.value = payload.entities
    emit('update:modelValue', payload.body)
    emit('update:entities', payload.entities)
    syncPlaceholderState()
    syncComposerHeight()
    refreshTagSearch()
  },
  onSelectionUpdate() {
    refreshTagSearch()
  },
  onBlur() {
    emit('blur')
  },
})

function selectTagItem(item: MessageTagPickerItem) {
  if (!editor.value || !activeQueryRange.value) return
  editor.value.chain().focus().insertContentAt(
    { from: activeQueryRange.value.from, to: activeQueryRange.value.to },
    [
      {
        type: 'messageEntity',
        attrs: {
          kind: item.kind,
          targetId: item.id,
          label: item.label,
          href: item.href,
        },
      },
      {
        type: 'text',
        text: ' ',
      },
    ],
  ).run()
  closeTagPicker()
  nextTick(() => {
    syncComposerHeight()
  })
}

function clearPendingTaskUrlPaste(id: string) {
  const removed = pendingTaskUrlPastes.delete(id)
  if (removed) {
    emit('pending-task-url-paste-change', pendingTaskUrlPastes.size > 0)
  }
  const nextEditor = editor.value
  if (composerUnmounted || !nextEditor || nextEditor.isDestroyed) return
  if (findPendingPasteCandidate(nextEditor.state, id)) {
    removePendingPasteCandidate(nextEditor.view, id)
  }
}

function clearAllPendingTaskUrlPastes() {
  const wasPending = pendingTaskUrlPastes.size > 0
  if (!wasPending) return

  pendingTaskUrlPastes.clear()
  emit('pending-task-url-paste-change', false)

  const nextEditor = editor.value
  if (composerUnmounted || !nextEditor || nextEditor.isDestroyed) return
  clearPendingPasteCandidates(nextEditor.view)
}

function clearModifiedTaskUrlPastes(nextEditor: TiptapEditor) {
  for (const [id, pendingPaste] of pendingTaskUrlPastes) {
    const pendingRange = findPendingPasteCandidate(nextEditor.state, id)
    if (!pendingRange || !pendingTaskUrlPasteMatches(nextEditor, pendingRange, pendingPaste)) {
      clearPendingTaskUrlPaste(id)
    }
  }
}

function pendingTaskUrlPasteMatches(
  nextEditor: TiptapEditor,
  pendingRange: { from: number; to: number },
  pendingPaste: PendingTaskUrlPaste,
): boolean {
  return nextEditor.state.doc.textBetween(pendingRange.from, pendingRange.to, '\n', '\uFFFC') === pendingPaste.url
    && JSON.stringify(nextEditor.state.doc.slice(pendingRange.from, pendingRange.to).toJSON()) === pendingPaste.sliceJson
}

async function resolveTaskUrlPaste(
  id: string,
  taskUrl: NonNullable<ReturnType<typeof findStandaloneCurrentWorkspaceTaskUrl>>,
) {
  try {
    const task = await tasksGet(taskUrl.publicId)
    const nextEditor = editor.value
    const pendingPaste = pendingTaskUrlPastes.get(id)
    if (composerUnmounted || !pendingPaste || !nextEditor || nextEditor.isDestroyed) return

    const pendingRange = findPendingPasteCandidate(nextEditor.state, id)
    if (!pendingRange) return
    if (!pendingTaskUrlPasteMatches(nextEditor, pendingRange, pendingPaste)) return

    const taskEntity = nextEditor.state.schema.nodes.messageEntity
    if (!taskEntity || task.public_id.trim() !== taskUrl.publicId) return

    const transaction = nextEditor.state.tr.replaceWith(
      pendingRange.from,
      pendingRange.to,
      taskEntity.create({
        kind: 'task',
        targetId: task.id,
        label: buildTaskMentionLabel(task.public_id, task.title),
        href: buildTaskMentionHref(task.public_id),
      }),
    )
    removePendingPasteCandidateFromTransaction(transaction, id)
    pendingTaskUrlPastes.delete(id)
    emit('pending-task-url-paste-change', pendingTaskUrlPastes.size > 0)
    nextEditor.view.dispatch(transaction)
  } catch {
    // A failed task lookup must leave the already-pasted URL as normal text.
  } finally {
    clearPendingTaskUrlPaste(id)
  }
}

function focusAtEnd() {
  if (!editor.value || props.disabled) return
  const root = editor.value.view.dom as HTMLElement | undefined
  root?.focus()
  editor.value.commands.focus('end', { scrollIntoView: false })
}

function getEditor() {
  return editor.value
}

async function maybeApplyFocusToken() {
  const token = props.focusToken ?? 0
  if (token === 0 || token === handledFocusToken || props.disabled) return
  await nextTick()
  focusAtEnd()
  handledFocusToken = token
}

function insertText(text: string) {
  if (!editor.value || props.disabled) return
  ;(editor.value.view.dom as HTMLElement | undefined)?.focus()
  editor.value.chain().focus('end', { scrollIntoView: false }).insertContent(text).run()
  syncComposerHeight()
}

watch(() => props.disabled, (next) => {
  editor.value?.setEditable(!next)
})

watch(() => props.placeholder, syncPlaceholderState)

watch(
  () => [props.modelValue, JSON.stringify(props.entities ?? [])] as const,
  ([nextBody, nextEntitiesJson]) => {
    const normalizedBody = nextBody ?? ''
    if (normalizedBody === textDraft.value && nextEntitiesJson === JSON.stringify(entitiesDraft.value)) {
      return
    }
    const normalizedEntities = JSON.parse(nextEntitiesJson) as MessageEntity[]
    applyValue(normalizedBody, normalizedEntities, false)
  },
)

watch(() => props.focusToken, () => {
  void maybeApplyFocusToken()
}, { immediate: true })

onMounted(() => {
  composerUnmounted = false
  void nextTick(() => {
    syncPlaceholderState()
    syncComposerHeight()
  })
})

onBeforeUnmount(() => {
  composerUnmounted = true
  pendingTaskUrlPastes.clear()
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer)
    searchDebounceTimer = null
  }
  editor.value?.destroy()
})

defineExpose<{
  editor: typeof editor
  getEditor: () => typeof editor.value
  insertText: (text: string) => void
  receiveFiles: (files: File[]) => Promise<void>
  setValue: (body: string, nextEntities?: MessageEntity[]) => void
  focusAtEnd: () => void
}>({
  editor,
  getEditor,
  insertText,
  receiveFiles: handleFiles,
  setValue: applyValue,
  focusAtEnd,
})
</script>

<style scoped>
.rich-text-composer :deep(.ProseMirror) {
  min-height: 24px;
}

.rich-text-composer :deep(.ProseMirror ul) {
  list-style: disc;
  padding-left: 1.25rem;
}

.rich-text-composer :deep(.ProseMirror ol) {
  list-style: decimal;
  padding-left: 1.25rem;
}

.rich-text-composer :deep(.ProseMirror li) {
  margin-bottom: 0.25rem;
}

.rich-text-composer :deep(.ProseMirror blockquote) {
  border-left: 3px solid rgb(var(--color-divider));
  margin: 0.5rem 0;
  padding-left: 0.75rem;
  color: rgb(var(--color-text-secondary));
}

.rich-text-composer :deep(.ProseMirror code) {
  border-radius: 0.375rem;
  background: rgb(var(--color-surface-hover));
  padding: 0.1rem 0.35rem;
}

.rich-text-composer :deep(.ProseMirror pre) {
  overflow-x: auto;
  border-radius: 0.5rem;
  background: rgb(var(--color-surface-hover));
  padding: 0.75rem;
}

.rich-text-composer :deep(.ProseMirror pre code) {
  background: transparent;
  padding: 0;
}

.rich-text-composer :deep(.ProseMirror.is-empty::before) {
  content: attr(data-placeholder);
  color: rgb(var(--color-text-muted));
  pointer-events: none;
  float: left;
  height: 0;
}

.rich-text-composer :deep(.message-entity-chip) {
  display: inline-flex;
  align-items: center;
  border-radius: 9999px;
  background: rgb(var(--color-selection-bg));
  color: rgb(var(--color-selection-text));
  box-shadow: inset 0 0 0 1px rgb(var(--color-selection-border) / 0.28);
  padding: 0 0.4rem;
  white-space: nowrap;
}
</style>
