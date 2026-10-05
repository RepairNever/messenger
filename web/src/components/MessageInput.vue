<template>
  <div class="shrink-0 px-4 pb-4 pt-2">
    <div v-if="attachments.length > 0" class="mb-2 rounded-2xl border border-chat-border bg-chat-input/70 p-2.5">
      <p class="mb-1 text-[11px] text-app-muted">Attachments ({{ attachments.length }}/{{ MAX_ATTACHMENTS }})</p>
      <ul class="space-y-1">
        <li
          v-for="attachment in attachments"
          :key="attachment.id"
          class="flex items-center justify-between gap-2 rounded border border-chat-border bg-chat-input px-2 py-1"
        >
          <div class="min-w-0">
            <p class="truncate text-xs text-app-text">{{ attachment.fileName }}</p>
            <p class="text-[11px] text-app-muted">{{ formatFileSize(attachment.fileSize) }}</p>
          </div>
          <button
            class="rounded p-1 text-app-muted hover:bg-chat-msgHover hover:text-app-text"
            title="Remove attachment"
            :disabled="removingAttachmentIds.has(attachment.id)"
            @click="removeAttachment(attachment.id)"
          >
            <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </li>
      </ul>
    </div>

    <div
      class="flex items-end gap-1 rounded-[24px] border bg-chat-input px-2 py-2 transition-colors focus-within:border-accent/50"
      :class="isDragOver ? 'border-accent' : 'border-chat-border'"
    >
      <input
        ref="fileInputEl"
        type="file"
        class="hidden"
        multiple
        @change="onFileInputChange"
      >

      <RichTextComposer
        ref="composerRef"
        v-model="text"
        v-model:entities="entities"
        data-testid="composer-editor"
        class="min-w-0 self-center px-2"
        :placeholder="placeholder || `Message #${channelName}`"
        :disabled="disabled"
        :focus-token="focusToken"
        :max-lines="MAX_COMPOSER_LINES"
        :enable-message-entities="!encrypted"
        :conversation-id="conversationId"
        :submit-on-enter="true"
        :on-files="encrypted ? null : handleComposerFiles"
        @submit="submit"
        @pending-task-url-paste-change="pendingTaskUrlPaste = $event"
        @empty-arrow-up="requestEditLastMessage"
        @resize="handleComposerResize"
      />

      <div data-testid="composer-controls-row" class="flex shrink-0 items-center gap-0.5 pb-0.5">
        <button
          data-testid="composer-attach-button"
          class="grid h-8 w-8 place-items-center rounded-full text-app-muted transition-colors hover:bg-app-hover hover:text-app-text disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="disabled || encrypted || uploading || !conversationId || attachments.length >= MAX_ATTACHMENTS"
          :title="attachButtonTitle"
          @click="openFilePicker"
        >
          <svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
            <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
          </svg>
        </button>

        <button
          ref="pickerToggleButton"
          data-testid="composer-emoji-button"
          class="grid h-8 w-8 place-items-center rounded-full text-app-muted transition-colors hover:bg-app-hover hover:text-app-text disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="disabled"
          title="Add emoji"
          @click.stop="toggleEmojiPicker"
        >
          <svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="9" />
            <path d="M8.5 14.5s1.2 1.8 3.5 1.8 3.5-1.8 3.5-1.8" />
            <line x1="9" y1="9.5" x2="9.01" y2="9.5" />
            <line x1="15" y1="9.5" x2="15.01" y2="9.5" />
          </svg>
        </button>

        <button
          data-testid="composer-send-button"
          class="grid h-9 w-9 place-items-center rounded-full transition-colors"
          :class="canSend
            ? 'bg-accent text-app-onAccent shadow-[0_0_14px_rgb(var(--color-accent)/0.35)] hover:bg-accent-hover'
            : 'text-app-muted cursor-not-allowed opacity-60'"
          :disabled="!canSend"
          title="Send"
          @click="submit"
        >
          <svg class="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
            <path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z"/>
          </svg>
        </button>
      </div>
    </div>

    <Teleport to="body">
      <div
        v-if="showEmojiPicker"
        ref="pickerRoot"
        class="z-20 emoji-picker-dark"
        :style="emojiPickerStyle"
        @click.stop
      >
        <component
          :is="pickerComponent"
          v-if="pickerComponent && emojiIndex"
          :data="emojiIndex"
          :native="true"
          set="apple"
          title="Add emoji"
          emoji="slightly_smiling_face"
          :show-preview="true"
          :show-skin-tones="false"
          :infinite-scroll="true"
          :emoji-size="26"
          :per-line="9"
          :color="emojiPickerAccentColor"
          @select="onSelectEmoji"
          @selected="onSelectEmoji"
        />
        <div
          v-else
          class="rounded-md border border-chat-border bg-chat-header px-3 py-2 text-xs text-app-muted shadow-xl"
        >
          Loading emoji...
        </div>
      </div>
    </Teleport>

    <p class="mt-1.5 flex items-center justify-between gap-4 px-3 text-[11px] text-app-muted">
      <span class="truncate text-app-muted">{{ typingLabel || '' }}</span>
      <span class="whitespace-nowrap">
        <kbd class="rounded border border-chat-border bg-app-tertiary px-1 py-px text-[10.5px]">Enter</kbd> sends from a plain paragraph ·
        <kbd class="rounded border border-chat-border bg-app-tertiary px-1 py-px text-[10.5px]">Shift+Enter</kbd> newline ·
        <kbd class="rounded border border-chat-border bg-app-tertiary px-1 py-px text-[10.5px]">Ctrl/Cmd+Enter</kbd> send anywhere
      </span>
    </p>

    <div v-if="uploading" class="mt-1 pl-1">
      <div class="mb-1 flex items-center justify-between gap-2 text-[11px] text-app-muted">
        <span class="truncate">
          Uploading{{ currentUploadingFileName ? ` ${currentUploadingFileName}` : ' attachments' }}...
        </span>
        <span class="tabular-nums">{{ uploadProgressPercent }}%</span>
      </div>
      <div class="h-1.5 w-full overflow-hidden rounded bg-chat-border">
        <div
          class="h-full bg-accent transition-[width] duration-150"
          :style="{ width: `${uploadProgressPercent}%` }"
        />
      </div>
    </div>
    <p v-else-if="attachmentWarning" class="mt-1 pl-1 text-[11px] text-amber-300">{{ attachmentWarning }}</p>
    <p v-else-if="attachmentError" class="mt-1 pl-1 text-[11px] text-red-400">{{ attachmentError }}</p>
    <p v-else-if="bodyLimitExceeded" class="mt-1 pl-1 text-[11px] text-amber-300">
      Message is too long: {{ bodyRuneCount.toLocaleString() }} / {{ MAX_MESSAGE_BODY_RUNES.toLocaleString() }} characters
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { deleteChatAttachment, uploadChatAttachment } from '@/services/http/chatApi'
import {
  clearChatDraft,
  loadChatDraft,
  saveChatDraft,
  type ChatDraftScope,
} from '@/services/storage/chatDraftStorage'
import { useComposerEmojiPicker } from '@/composables/useComposerEmojiPicker'
import { useColorTheme } from '@/composables/useColorTheme'
import { MAX_MESSAGE_BODY_RUNES, isMessageBodyWithinLimit, messageBodyRuneCount } from '@/utils/messageLimits'
import type { MessageEntity } from '@/stores/chat'
import RichTextComposer from './RichTextComposer.vue'

interface ComposerAttachment {
  id: string
  fileName: string
  fileSize: number
  mimeType: string
  thumbnailMimeType?: string
  thumbnailFileSize?: number
  thumbnailVersion?: number
}

interface ComposerSendPayload {
  body: string
  entities: MessageEntity[]
  attachmentIds: string[]
  attachments: ComposerAttachment[]
}

const MAX_ATTACHMENTS = 5
const MAX_COMPOSER_LINES = 8

const props = defineProps<{
  channelName: string
  conversationId?: string
  draftScope?: ChatDraftScope | null
  placeholder?: string
  encrypted?: boolean
  disabled?: boolean
  typingLabel?: string
  online?: boolean
  focusToken?: number
}>()

const emit = defineEmits<{
  send: [payload: ComposerSendPayload]
  typing: [active: boolean]
  resize: [deltaPx: number]
  'edit-last-message': []
}>()

const text = ref('')
const entities = ref<MessageEntity[]>([])
const pendingTaskUrlPaste = ref(false)
const composerRef = ref<InstanceType<typeof RichTextComposer> | null>(null)
const fileInputEl = ref<HTMLInputElement | null>(null)
const attachments = ref<ComposerAttachment[]>([])
const uploading = ref(false)
const uploadProgressPercent = ref(0)
const currentUploadingFileName = ref('')
const attachmentError = ref('')
const removingAttachmentIds = ref(new Set<string>())
const isDragOver = ref(false)
const syncingDraft = ref(false)
const { currentTheme } = useColorTheme()
const emojiPickerAccentColor = computed(() => currentTheme.value.tokens.accent)

const {
  showEmojiPicker,
  pickerRoot,
  pickerToggleButton,
  pickerComponent,
  emojiIndex,
  emojiPickerStyle,
  toggleEmojiPicker,
  closeEmojiPicker,
  onSelectEmoji,
} = useComposerEmojiPicker({
  onSelect: (emoji) => {
    composerRef.value?.insertText(emoji)
  },
})

const attachmentWarning = computed(() => {
  if (props.encrypted) {
    return 'Attachments are disabled in encrypted DMs'
  }
  if (attachments.value.length > 0 && props.online === false) {
    return 'Reconnect to send attachments'
  }
  return ''
})

const bodyRuneCount = computed(() => messageBodyRuneCount(text.value))
const bodyLimitExceeded = computed(() => !isMessageBodyWithinLimit(text.value))

const canSend = computed(() => {
  if (props.disabled || uploading.value || pendingTaskUrlPaste.value) return false
  if (!text.value.trim() && attachments.value.length === 0) return false
  if (attachments.value.length > 0 && props.online === false) return false
  if (bodyLimitExceeded.value) return false
  return true
})

const attachButtonTitle = computed(() => {
  if (props.encrypted) return 'Encrypted DM attachments are not available yet'
  if (!props.conversationId) return 'Open a conversation to attach files'
  if (attachments.value.length >= MAX_ATTACHMENTS) return `Max ${MAX_ATTACHMENTS} attachments per message`
  return 'Attach file'
})

function normalizedEntitiesForSend(body: string): MessageEntity[] {
  const trimmedDelta = text.value.length - text.value.trimStart().length
  return entities.value
    .map(entity => ({
      ...entity,
      start: entity.start - trimmedDelta,
      end: entity.end - trimmedDelta,
    }))
    .filter(entity => entity.start >= 0 && entity.end <= body.length)
}

function submit() {
  if (!canSend.value) return
  const body = text.value.trim()
  emit('send', {
    body,
    entities: props.encrypted ? [] : normalizedEntitiesForSend(body),
    attachmentIds: attachments.value.map(item => item.id),
    attachments: attachments.value.slice(),
  })
  if (props.draftScope) {
    clearChatDraft(props.draftScope)
  }
  text.value = ''
  entities.value = []
  attachments.value = []
  attachmentError.value = ''
  closeEmojiPicker()
  emitTyping(false)
}

function emitTyping(active: boolean) {
  if (props.disabled) return
  emit('typing', active)
}

function handleComposerResize(deltaPx: number) {
  emit('resize', deltaPx)
}

function requestEditLastMessage() {
  if (props.disabled || uploading.value) return
  if (attachments.value.length > 0) return
  if (text.value.trim().length > 0) return
  emit('edit-last-message')
}

async function handleComposerFiles(files: File[]) {
  if (props.encrypted) return
  if (!props.conversationId || props.disabled || uploading.value) return
  isDragOver.value = false
  await uploadFiles(files)
}

function openFilePicker() {
  if (props.encrypted) return
  fileInputEl.value?.click()
}

async function onFileInputChange(event: Event) {
  const target = event.target as HTMLInputElement
  const files = Array.from(target.files ?? [])
  target.value = ''
  if (files.length === 0) return
  await uploadFiles(files)
}

async function uploadFiles(files: File[]) {
  if (props.encrypted) return
  if (!props.conversationId) return
  if (props.disabled || uploading.value) return
  attachmentError.value = ''
  const remainingSlots = MAX_ATTACHMENTS - attachments.value.length
  if (remainingSlots <= 0) {
    attachmentError.value = `Max ${MAX_ATTACHMENTS} attachments per message`
    return
  }
  const selected = files.slice(0, remainingSlots)
  if (selected.length < files.length) {
    attachmentError.value = `Only ${MAX_ATTACHMENTS} attachments are allowed per message`
  }

  uploading.value = true
  uploadProgressPercent.value = 0
  currentUploadingFileName.value = ''
  try {
    const totalBytes = selected.reduce((sum, file) => sum + Math.max(0, file.size), 0)
    let uploadedBytes = 0
    for (const file of selected) {
      currentUploadingFileName.value = file.name
      const fileBytes = Math.max(0, file.size)
      const uploaded = await uploadChatAttachment(props.conversationId, file, (loaded, total) => {
        const effectiveTotal = Math.max(1, total || fileBytes || loaded)
        const clampedCurrent = Math.min(Math.max(0, loaded), effectiveTotal)
        const overallLoaded = uploadedBytes + clampedCurrent
        const overallTotal = Math.max(1, totalBytes || effectiveTotal)
        uploadProgressPercent.value = Math.min(100, Math.round((overallLoaded / overallTotal) * 100))
      })
      attachments.value.push({
        id: uploaded.id,
        fileName: uploaded.file_name,
        fileSize: uploaded.file_size,
        mimeType: uploaded.mime_type,
        thumbnailMimeType: uploaded.thumbnail_mime_type || undefined,
        thumbnailFileSize: uploaded.thumbnail_file_size && uploaded.thumbnail_file_size > 0
          ? uploaded.thumbnail_file_size
          : undefined,
        thumbnailVersion: uploaded.thumbnail_version && uploaded.thumbnail_version > 0
          ? uploaded.thumbnail_version
          : undefined,
      })
      uploadedBytes += fileBytes
      const overallTotal = Math.max(1, totalBytes || uploadedBytes || 1)
      uploadProgressPercent.value = Math.min(100, Math.round((uploadedBytes / overallTotal) * 100))
    }
  } catch (error) {
    attachmentError.value = error instanceof Error ? error.message : 'Failed to upload attachment'
  } finally {
    currentUploadingFileName.value = ''
    uploadProgressPercent.value = 0
    uploading.value = false
    isDragOver.value = false
  }
}

async function removeAttachment(attachmentId: string) {
  removingAttachmentIds.value.add(attachmentId)
  attachmentError.value = ''
  try {
    await deleteChatAttachment(attachmentId)
    attachments.value = attachments.value.filter(item => item.id !== attachmentId)
  } catch (error) {
    attachmentError.value = error instanceof Error ? error.message : 'Failed to remove attachment'
  } finally {
    removingAttachmentIds.value.delete(attachmentId)
  }
}

async function cleanupStagedAttachments() {
  const stagedIds = attachments.value.map(item => item.id)
  attachments.value = []
  await Promise.allSettled(stagedIds.map(async id => {
    try {
      await deleteChatAttachment(id)
    } catch {
      // Best-effort cleanup only.
    }
  }))
}

watch(text, (next) => {
  emitTyping(next.trim().length > 0)
})

watch(
  () => props.draftScope,
  (scope) => {
    syncingDraft.value = true
    if (!scope) {
      text.value = ''
      entities.value = []
      syncingDraft.value = false
      return
    }
    const draft = loadChatDraft(scope)
    text.value = draft.body
    entities.value = draft.entities
    syncingDraft.value = false
  },
  { immediate: true, deep: true },
)

watch(
  () => [props.draftScope, text.value, JSON.stringify(entities.value)] as const,
  ([scope]) => {
    if (props.encrypted) return
    if (!scope || syncingDraft.value) return
    saveChatDraft(scope, {
      body: text.value,
      entities: entities.value,
    })
  },
  { deep: true },
)

watch(() => props.encrypted, (encrypted) => {
  if (!encrypted) return
  entities.value = []
  if (attachments.value.length > 0) {
    void cleanupStagedAttachments()
  }
})

watch(() => props.conversationId, (next, prev) => {
  closeEmojiPicker()
  if (prev && prev !== next && attachments.value.length > 0) {
    void cleanupStagedAttachments()
  }
})

onBeforeUnmount(() => {
  closeEmojiPicker()
  if (attachments.value.length > 0) {
    void cleanupStagedAttachments()
  }
})

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}
</script>
