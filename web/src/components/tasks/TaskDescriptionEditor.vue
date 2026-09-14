<template>
  <div class="flex min-h-0 flex-col gap-2">
    <div class="inline-flex overflow-hidden rounded  text-[11px]">
      <button
        type="button"
        class="px-2 py-0.5"
        :class="tab === 'rendered' ? 'bg-accent text-app-onAccent' : 'bg-chat-input text-app-secondaryText hover:text-app-text'"
        data-testid="task-description-tab-rendered"
        @click="switchTab('rendered')"
      >
        Rendered
      </button>
      <button
        type="button"
        class="border-l border-chat-border px-2 py-0.5"
        :class="tab === 'markdown'
          ? 'bg-accent text-app-onAccent'
          : markdownTabDisabled
            ? 'cursor-not-allowed bg-chat-input text-app-muted opacity-70'
            : 'bg-chat-input text-app-secondaryText hover:text-app-text'"
        :disabled="markdownTabDisabled"
        data-testid="task-description-tab-markdown"
        @click="switchTab('markdown')"
      >
        Markdown
      </button>
    </div>

    <div
      v-show="tab === 'rendered'"
      class="min-h-0 flex-1 overflow-y-auto space-y-2"
      data-testid="task-description-rendered"
    >
      <AttachmentMarkdownContent
        v-if="!editable"
        :markdown="markdownDraft"
      />
      <TaskDescriptionRichEditor
        v-else
        v-model="markdownDraft"
        :editable="editable"
        :collab-doc="collabDoc"
        :collab-provider="collabProvider"
        :collab-field="collabField"
        :allow-local-draft-seed="allowLocalDraftSeed"
        :collab-has-remote-peers="collabHasRemotePeers"
        :force-local-sync-token="combinedForceLocalSyncToken"
        :owner-kind="ownerKind"
        :owner-id="ownerId"
        :attachment-upload-mode="taskStagedAttachmentUpload ? 'task-staged' : 'owner'"
        :collab-user="collabUser"
        :upload-attachments="uploadAttachments"
        @blur="emit('blur')"
      />
    </div>

    <div
      v-show="tab === 'markdown'"
      class="flex min-h-0 flex-1 flex-col"
    >
      <textarea
        ref="markdownInputRef"
        v-model="markdownDraft"
        class="min-h-[140px] w-full resize-none overflow-hidden rounded border border-chat-border bg-chat-input px-3 py-2 text-sm text-app-text placeholder-app-muted outline-none focus:border-accent"
        :placeholder="placeholder"
        :disabled="!editable || markdownTabDisabled"
        data-testid="task-description-markdown-input"
        @blur="onMarkdownBlur"
        @input="onMarkdownInput"
        @paste="onMarkdownPaste"
        @dragover="onMarkdownDragOver"
        @drop="onMarkdownDrop"
      />
    </div>

    <p
      v-if="attachmentNotice"
      data-testid="task-description-attachment-note"
      class="text-xs"
      :class="attachmentNoticeIsError ? 'text-app-warning' : 'text-app-muted'"
    >
      {{ attachmentNotice }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { Doc as YDoc } from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import AttachmentMarkdownContent from '@/components/AttachmentMarkdownContent.vue'
import { uploadOwnedAttachments, type OwnedAttachmentUpload } from '@/services/http/attachmentOwnersApi'
import {
  buildAttachmentMarkdown,
  buildTaskStagedAttachmentMarkdown,
  type AttachmentOwnerKind,
} from '@/utils/attachmentMarkdown'

type DescriptionTab = 'rendered' | 'markdown'
const MARKDOWN_DRAFT_SYNC_DEBOUNCE_MS = 300

const TaskDescriptionRichEditor = defineAsyncComponent(() => import('./TaskDescriptionRichEditor.vue'))

const props = withDefaults(defineProps<{
  modelValue: string
  defaultTab?: DescriptionTab
  placeholder?: string
  editable?: boolean
  collabDoc?: YDoc | null
  collabProvider?: { awareness: Awareness } | null
  collabField?: string
  allowLocalDraftSeed?: boolean
  collabHasRemotePeers?: boolean
  forceLocalSyncToken?: number
  ownerKind?: AttachmentOwnerKind | null
  ownerId?: string | null
  taskStagedAttachmentUpload?: ((files: File[]) => Promise<OwnedAttachmentUpload[] | null>) | null
  collabUser?: {
    id: string
    name: string
    color: string
  } | null
}>(), {
  defaultTab: 'rendered',
  placeholder: 'Description',
  editable: true,
  collabDoc: null,
  collabProvider: null,
  collabField: 'task_description',
  allowLocalDraftSeed: true,
  collabHasRemotePeers: false,
  forceLocalSyncToken: 0,
  ownerKind: null,
  ownerId: null,
  taskStagedAttachmentUpload: null,
  collabUser: null,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'blur': []
}>()

const tab = ref<DescriptionTab>(props.defaultTab)
const markdownDraft = ref(props.modelValue ?? '')
const markdownInputRef = ref<HTMLTextAreaElement | null>(null)
const attachmentNotice = ref('')
const attachmentNoticeIsError = ref(false)
const editable = computed(() => !!props.editable)
const markdownTabDisabled = computed(() => !!props.collabDoc && !!props.collabHasRemotePeers && editable.value)
const markdownDraftSyncToken = ref(0)
const combinedForceLocalSyncToken = computed(() => props.forceLocalSyncToken + markdownDraftSyncToken.value)
let markdownDraftSyncTimer: ReturnType<typeof setTimeout> | null = null
const MARKDOWN_COLLAB_NOTICE = 'Markdown editing is disabled while collaborators are active.'

function setAttachmentNotice(message: string, isError = false) {
  attachmentNotice.value = message
  attachmentNoticeIsError.value = isError
}

function clearAttachmentNotice() {
  attachmentNotice.value = ''
  attachmentNoticeIsError.value = false
}

function showMarkdownCollabNotice() {
  setAttachmentNotice(MARKDOWN_COLLAB_NOTICE)
}

function resizeMarkdownTextarea() {
  const el = markdownInputRef.value
  if (!el || tab.value !== 'markdown') return
  el.style.height = '0px'
  el.style.height = `${el.scrollHeight}px`
}

function clearMarkdownDraftSyncTimer() {
  if (!markdownDraftSyncTimer) return
  clearTimeout(markdownDraftSyncTimer)
  markdownDraftSyncTimer = null
}

function bumpMarkdownDraftSyncToken() {
  if (!props.collabDoc) return
  markdownDraftSyncToken.value += 1
}

function flushMarkdownDraftSync() {
  if (!markdownDraftSyncTimer) return
  clearMarkdownDraftSyncTimer()
  bumpMarkdownDraftSyncToken()
}

function scheduleMarkdownDraftSync() {
  if (!props.collabDoc) return
  clearMarkdownDraftSyncTimer()
  markdownDraftSyncTimer = setTimeout(() => {
    markdownDraftSyncTimer = null
    bumpMarkdownDraftSyncToken()
  }, MARKDOWN_DRAFT_SYNC_DEBOUNCE_MS)
}

function onMarkdownInput() {
  if (markdownTabDisabled.value) {
    showMarkdownCollabNotice()
    return
  }
  resizeMarkdownTextarea()
  scheduleMarkdownDraftSync()
}

function onMarkdownBlur() {
  flushMarkdownDraftSync()
  emit('blur')
}

function attachmentsEnabledForUpload(): boolean {
  return editable.value && (!!props.taskStagedAttachmentUpload || (!!props.ownerKind && !!props.ownerId))
}

function buildInsertedAttachmentMarkdown(rows: OwnedAttachmentUpload[]): string {
  const build = props.taskStagedAttachmentUpload
    ? (row: OwnedAttachmentUpload) => buildTaskStagedAttachmentMarkdown(row.id, row.file_name, row.mime_type)
    : (row: OwnedAttachmentUpload) => buildAttachmentMarkdown(
      props.ownerKind!,
      props.ownerId!,
      row.id,
      row.file_name,
      row.mime_type,
    )
  return rows.map(build).join('\n\n')
}

async function uploadAttachments(files: File[]): Promise<OwnedAttachmentUpload[] | null> {
  if (!files.length) return null
  if (!attachmentsEnabledForUpload()) {
    setAttachmentNotice('Attachments are available after save.')
    return null
  }
  if (props.taskStagedAttachmentUpload) {
    const imageFiles = files.filter(file => file.type.startsWith('image/'))
    if (!imageFiles.length) {
      setAttachmentNotice('Only images can be pasted before save.')
      return null
    }
    setAttachmentNotice(`Uploading ${imageFiles.length === 1 ? 'image' : `${imageFiles.length} images`}...`)
    try {
      const uploaded = await props.taskStagedAttachmentUpload(imageFiles)
      clearAttachmentNotice()
      return uploaded
    } catch (error) {
      setAttachmentNotice(error instanceof Error ? error.message : 'Attachment upload failed', true)
      return null
    }
  }
  const ownerKind = props.ownerKind
  const ownerId = props.ownerId
  if (!ownerKind || !ownerId) {
    setAttachmentNotice('Attachments are available after save.')
    return null
  }

  setAttachmentNotice(`Uploading ${files.length === 1 ? 'attachment' : `${files.length} attachments`}...`)
  try {
    const result = await uploadOwnedAttachments(ownerKind, ownerId, files)
    if (result.errors.length) {
      const names = result.errors.map(error => error.file_name).filter(Boolean).join(', ')
      setAttachmentNotice(`${names || 'Some attachments'} failed to upload.`, true)
    } else {
      clearAttachmentNotice()
    }
    return result.attachments.length ? result.attachments : null
  } catch (error) {
    setAttachmentNotice(error instanceof Error ? error.message : 'Attachment upload failed', true)
    return null
  }
}

function insertMarkdownAtCursor(value: string) {
  const input = markdownInputRef.value
  if (!input) {
    markdownDraft.value = [markdownDraft.value, value].filter(Boolean).join('\n\n')
    bumpMarkdownDraftSyncToken()
    emit('update:modelValue', markdownDraft.value)
    return
  }
  const start = input.selectionStart ?? markdownDraft.value.length
  const end = input.selectionEnd ?? start
  const before = markdownDraft.value.slice(0, start)
  const after = markdownDraft.value.slice(end)
  const needsLeadingBreak = before.length > 0 && !before.endsWith('\n')
  const needsTrailingBreak = after.length > 0 && !after.startsWith('\n')
  const inserted = `${needsLeadingBreak ? '\n\n' : ''}${value}${needsTrailingBreak ? '\n\n' : ''}`
  markdownDraft.value = `${before}${inserted}${after}`
  bumpMarkdownDraftSyncToken()
  emit('update:modelValue', markdownDraft.value)
  nextTick(() => {
    const caret = before.length + inserted.length
    input.focus()
    input.setSelectionRange(caret, caret)
  })
}

async function onMarkdownPaste(event: ClipboardEvent) {
  if (markdownTabDisabled.value) {
    event.preventDefault()
    showMarkdownCollabNotice()
    return
  }
  const files = Array.from(event.clipboardData?.files ?? [])
  if (!files.length) return
  event.preventDefault()
  const uploaded = await uploadAttachments(files)
  if (!uploaded) return
  insertMarkdownAtCursor(buildInsertedAttachmentMarkdown(uploaded))
}

function onMarkdownDragOver(event: DragEvent) {
  if ((event.dataTransfer?.files?.length ?? 0) > 0) {
    event.preventDefault()
    event.dataTransfer!.dropEffect = 'copy'
  }
}

async function onMarkdownDrop(event: DragEvent) {
  if (markdownTabDisabled.value) {
    event.preventDefault()
    showMarkdownCollabNotice()
    return
  }
  const files = Array.from(event.dataTransfer?.files ?? [])
  if (!files.length) return
  event.preventDefault()
  const uploaded = await uploadAttachments(files)
  if (!uploaded) return
  insertMarkdownAtCursor(buildInsertedAttachmentMarkdown(uploaded))
}

function switchTab(nextTab: DescriptionTab) {
  if (nextTab === 'markdown' && markdownTabDisabled.value) {
    showMarkdownCollabNotice()
    return
  }
  if (nextTab === 'rendered') {
    flushMarkdownDraftSync()
  }
  tab.value = nextTab
  if (nextTab === 'markdown') {
    nextTick(() => {
      resizeMarkdownTextarea()
    })
  }
}

watch(
  () => props.modelValue,
  (next) => {
    const normalized = next ?? ''
    if (normalized === markdownDraft.value) return
    markdownDraft.value = normalized
  },
)

watch(markdownDraft, (next) => {
  if (next !== props.modelValue) {
    emit('update:modelValue', next)
  }
  if (tab.value === 'markdown') {
    nextTick(() => {
      resizeMarkdownTextarea()
    })
  }
})

watch(
  tab,
  (nextTab) => {
    if (nextTab !== 'markdown') return
    nextTick(() => {
      resizeMarkdownTextarea()
    })
  },
  { immediate: true },
)

watch(
  [() => props.ownerId, () => props.ownerKind, () => props.taskStagedAttachmentUpload, editable],
  ([ownerId, ownerKind, stagedUpload, isEditable]) => {
    if (!isEditable) return
    if (stagedUpload) {
      if (!attachmentNoticeIsError.value) {
        clearAttachmentNotice()
      }
      return
    }
    if (!ownerId || !ownerKind) {
      setAttachmentNotice('Attachments are available after save.')
      return
    }
    if (!attachmentNoticeIsError.value) {
      clearAttachmentNotice()
    }
  },
  { immediate: true },
)

watch(
  markdownTabDisabled,
  (disabled) => {
    if (!disabled) {
      if (attachmentNotice.value === MARKDOWN_COLLAB_NOTICE) {
        clearAttachmentNotice()
      }
      return
    }
    clearMarkdownDraftSyncTimer()
    if (tab.value === 'markdown') {
      tab.value = 'rendered'
    }
    showMarkdownCollabNotice()
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  flushMarkdownDraftSync()
})
</script>
