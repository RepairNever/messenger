<template>
  <div ref="rootEl">
    <div class="mb-3">
      <span class="text-xs text-gray-500 uppercase tracking-wide">
        Comments ({{ comments.length }})
      </span>
    </div>

    <p v-if="error" class="mb-2 text-xs text-red-400">{{ error }}</p>

    <div class="space-y-2">
      <div v-if="stagedAttachments.length > 0" class="rounded-lg border border-chat-border bg-chat-input/70 p-2">
        <p class="mb-1 text-[11px] text-gray-500">Attachments ({{ stagedAttachments.length }}/{{ MAX_ATTACHMENTS }})</p>
        <ul class="space-y-1">
          <li
            v-for="attachment in stagedAttachments"
            :key="attachment.id"
            class="flex items-center justify-between gap-2 rounded border border-chat-border bg-chat-input px-2 py-1"
          >
            <div class="min-w-0">
              <p class="truncate text-xs text-gray-200">{{ attachment.file_name }}</p>
              <p class="text-[11px] text-gray-500">{{ formatFileSize(attachment.file_size) }}</p>
            </div>
            <button
              class="rounded p-1 text-gray-400 hover:bg-white/10 hover:text-white"
              title="Remove attachment"
              :disabled="removingAttachmentIds.has(attachment.id)"
              @click="removeStagedAttachment(attachment.id)"
            >
              <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </li>
        </ul>
      </div>

      <div
        class="flex flex-col gap-2 rounded-lg border px-3 py-2 transition-colors"
        :class="isDragOver ? 'border-accent bg-chat-input/90' : 'border-chat-border bg-chat-input'"
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
          v-model="newBody"
          data-testid="task-comment-composer"
          :placeholder="'Add a comment…'"
          :disabled="submitting"
          :max-lines="MAX_COMPOSER_LINES"
          :enable-task-items="true"
          :submit-on-enter="true"
          :on-files="uploadFiles"
          @submit="submit"
          @resize="preserveScrollOnComposerResize"
        />

        <div data-testid="task-comment-controls-row" class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <button
              data-testid="task-comment-attach-button"
              class="shrink-0 text-gray-400 transition-colors hover:text-gray-200 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="submitting || uploading || stagedAttachments.length >= MAX_ATTACHMENTS"
              :title="attachButtonTitle"
              @click="openFilePicker"
            >
              <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path d="M12 5v14M5 12h14"/>
              </svg>
            </button>

            <button
              ref="pickerToggleButton"
              data-testid="task-comment-emoji-button"
              class="shrink-0 text-gray-400 transition-colors hover:text-gray-200 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="submitting"
              title="Add emoji"
              @click.stop="toggleEmojiPicker"
            >
              <span class="text-lg leading-none">🙂</span>
            </button>
          </div>

          <button
            data-testid="task-comment-send-button"
            class="shrink-0 rounded p-1.5 transition-colors"
            :class="canSubmit
              ? 'bg-accent text-white hover:bg-accent-hover'
              : 'cursor-not-allowed text-gray-600'"
            :disabled="!canSubmit"
            @click="submit"
          >
            <svg class="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z"/>
            </svg>
          </button>
        </div>
      </div>

      <div class="flex items-center justify-between">
        <span v-if="uploading" class="text-[11px] text-gray-500">Uploading attachments...</span>
        <span v-else-if="attachmentError" class="text-[11px] text-red-400">{{ attachmentError }}</span>
        <span v-else class="text-xs text-gray-500">Enter to post · Shift+Enter for new line</span>
        <span class="text-xs text-gray-500">{{ submitting ? 'Posting…' : '' }}</span>
      </div>
    </div>

    <div v-if="loading" class="text-sm text-gray-500 italic">Loading…</div>

    <p v-else-if="!comments.length && !submitting" class="mb-3 text-sm text-gray-500 italic">
      No comments yet
    </p>

    <ul v-else class="mb-4 space-y-3">
      <li
        v-for="comment in comments"
        :key="comment.id"
        :data-task-comment-id="comment.id"
        class="flex gap-3 rounded-lg transition-colors"
        :class="isHighlightedComment(comment) ? 'bg-amber-500/10 ring-1 ring-inset ring-amber-300/40' : ''"
      >
        <UserAvatar
          :user-id="comment.author_id"
          :display-name="authorName(comment.author_id)"
          :avatar-url="authorAvatar(comment.author_id)"
          :custom-status="authorCustomStatus(comment.author_id)"
          size="sm"
        />

        <div class="min-w-0 flex-1">
          <div class="mb-1 flex items-baseline gap-2">
            <span class="text-sm font-medium text-gray-200">{{ authorName(comment.author_id) }}</span>
            <span class="text-xs text-gray-500">{{ formatDatetime(comment.created_at) }}</span>
            <span
              v-if="isEditedComment(comment)"
              data-testid="task-comment-edited-marker"
              class="text-[11px] text-gray-500"
            >(edited)</span>
            <button
              v-if="canEditComment(comment) && editingCommentId !== comment.id"
              data-testid="task-comment-edit-button"
              class="rounded px-1.5 py-0.5 text-[11px] text-accent transition-colors hover:bg-accent/10 hover:text-accent-hover"
              @click="startEditingComment(comment)"
            >
              Edit
            </button>
            <button
              data-testid="task-comment-thread-button"
              class="rounded px-1.5 py-0.5 text-[11px] text-amber-300 transition-colors hover:bg-white/10 hover:text-amber-200 disabled:cursor-wait disabled:opacity-60"
              :disabled="openingThreadCommentIds.has(comment.id)"
              @click="openCommentThread(comment)"
            >
              Thread<span v-if="comment.thread_reply_count"> ({{ comment.thread_reply_count }})</span>
            </button>
          </div>

          <template v-if="editingCommentId === comment.id">
            <div
              class="flex flex-col gap-2 rounded-lg border px-3 py-2 transition-colors"
              :class="editDragOver ? 'border-accent bg-chat-input/90' : 'border-chat-border bg-chat-input'"
            >
              <input
                :ref="setEditFileInputRef"
                type="file"
                class="hidden"
                multiple
                @change="onEditFileInputChange"
              >

              <div v-if="editAttachments.length > 0" class="rounded-lg border border-chat-border bg-chat-input/70 p-2">
                <p class="mb-1 text-[11px] text-gray-500">Attachments ({{ editAttachments.length }}/{{ MAX_ATTACHMENTS }})</p>
                <ul class="space-y-1">
                  <li
                    v-for="attachment in editAttachments"
                    :key="attachment.id"
                    class="flex items-center justify-between gap-2 rounded border border-chat-border bg-chat-input px-2 py-1"
                  >
                    <div class="min-w-0">
                      <p class="truncate text-xs text-gray-200">{{ attachment.file_name }}</p>
                      <p class="text-[11px] text-gray-500">{{ formatFileSize(attachment.file_size) }}</p>
                    </div>
                    <button
                      class="rounded p-1 text-gray-400 hover:bg-white/10 hover:text-white"
                      title="Remove attachment"
                      :disabled="editRemovingAttachmentIds.has(attachment.id)"
                      @click="removeEditAttachment(attachment)"
                    >
                      <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                        <path d="M18 6 6 18M6 6l12 12" />
                      </svg>
                    </button>
                  </li>
                </ul>
              </div>

              <RichTextComposer
                :ref="setEditComposerRef"
                v-model="editBody"
                data-testid="task-comment-edit-textarea"
                :placeholder="'Edit comment…'"
                :disabled="editSaving"
                :max-lines="MAX_COMPOSER_LINES"
                :enable-task-items="true"
                :submit-on-enter="true"
                :on-files="uploadEditFiles"
                @submit="saveEditingComment"
              />

              <div class="flex items-center justify-between">
                <div class="flex items-center gap-2">
                  <button
                    data-testid="task-comment-edit-attach-button"
                    class="shrink-0 text-gray-400 transition-colors hover:text-gray-200 disabled:cursor-not-allowed disabled:opacity-50"
                    :disabled="editSaving || editUploading || editAttachments.length >= MAX_ATTACHMENTS"
                    :title="editAttachButtonTitle"
                    @click="openEditFilePicker"
                  >
                    <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                      <path d="M12 5v14M5 12h14"/>
                    </svg>
                  </button>

                  <button
                    :ref="setEditPickerToggleButtonRef"
                    data-testid="task-comment-edit-emoji-button"
                    class="shrink-0 text-gray-400 transition-colors hover:text-gray-200 disabled:cursor-not-allowed disabled:opacity-50"
                    :disabled="editSaving"
                    title="Add emoji"
                    @click.stop="toggleEditEmojiPicker"
                  >
                    <span class="text-lg leading-none">🙂</span>
                  </button>
                </div>

                <div class="flex items-center gap-2">
                  <button
                    data-testid="task-comment-edit-cancel"
                    class="rounded px-2.5 py-1 text-xs text-gray-300 transition-colors hover:bg-white/10 hover:text-white"
                    :disabled="editSaving"
                    @click="cancelEditingComment"
                  >
                    Cancel
                  </button>
                  <button
                    data-testid="task-comment-edit-save"
                    class="rounded px-2.5 py-1 text-xs transition-colors"
                    :class="canSaveEditedComment
                      ? 'bg-accent text-white hover:bg-accent-hover'
                      : 'cursor-not-allowed text-gray-600'"
                    :disabled="!canSaveEditedComment"
                    @click="saveEditingComment"
                  >
                    {{ editSaving ? 'Saving…' : 'Save' }}
                  </button>
                </div>
              </div>
            </div>

            <div class="mt-1 flex items-center justify-between gap-2">
              <span v-if="editUploading" class="text-[11px] text-gray-500">Uploading attachments...</span>
              <span v-else-if="editAttachmentError" class="text-[11px] text-red-400">{{ editAttachmentError }}</span>
              <span v-else class="text-xs text-gray-500">Enter to save · Shift+Enter for new line</span>
              <span class="text-xs text-red-400">{{ editError }}</span>
            </div>
          </template>

          <template v-else>
            <div
              v-if="comment.body"
              class="markdown-body break-words text-sm text-gray-300"
              v-html="renderCommentBody(comment.body)"
              @click="onMarkdownClick"
            />

            <div v-if="comment.attachments?.length" class="mt-2 space-y-2">
            <div
              v-for="attachment in comment.attachments"
              :key="attachment.id"
              :class="isImageAttachment(attachment) ? '' : 'rounded-md border border-chat-border bg-chat-input/70 p-2'"
            >
              <div v-if="isImageAttachment(attachment)" class="group/image relative w-fit">
                <button
                  data-testid="task-comment-image-thumbnail"
                  class="block max-w-[180px] overflow-hidden rounded-lg bg-chat-input/60 shadow-sm transition-colors hover:bg-chat-input/80 sm:max-w-[280px] cursor-pointer"
                  @click="openImagePreview(comment.id, attachment)"
                >
                  <img
                    v-if="attachmentUrl(attachment)"
                    data-testid="task-comment-image-thumbnail-img"
                    :src="attachmentUrl(attachment)"
                    :alt="attachment.file_name"
                    class="max-h-[180px] w-full object-contain sm:max-h-[220px]"
                  >
                  <div v-else class="flex h-24 items-center justify-center text-xs text-gray-500">
                    {{ loadingAttachmentIds.has(attachment.id) ? 'Loading image...' : 'Preview unavailable' }}
                  </div>
                </button>
                <button
                  class="absolute right-2 top-2 rounded-md border border-white/20 bg-black/55 p-1 text-white/90 opacity-0 transition-opacity group-hover/image:opacity-100 hover:bg-black/75 hover:text-white"
                  title="Download"
                  @click.stop="downloadAttachment(comment.id, attachment)"
                >
                  <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7,10 12,15 17,10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                </button>
              </div>

              <template v-else>
                <div class="mb-1 flex items-center justify-between gap-2">
                  <p class="truncate text-xs text-gray-300">{{ attachment.file_name }}</p>
                  <button
                    class="rounded p-1 text-gray-400 hover:bg-white/10 hover:text-white"
                    title="Download"
                    @click="downloadAttachment(comment.id, attachment)"
                  >
                    <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7,10 12,15 17,10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                  </button>
                </div>

                <div v-if="isVideoAttachment(attachment)">
                <video
                  v-if="attachmentUrl(attachment)"
                  class="w-full rounded border border-chat-border/70 bg-black/50"
                  controls
                  preload="metadata"
                  :src="attachmentUrl(attachment)"
                />
                <p v-else class="text-[11px] text-gray-500">
                  {{ loadingAttachmentIds.has(attachment.id) ? 'Loading video...' : 'Preview unavailable' }}
                </p>
                </div>

                <div v-else-if="isAudioAttachment(attachment)">
                <audio
                  v-if="attachmentUrl(attachment)"
                  class="w-full"
                  controls
                  preload="metadata"
                  :src="attachmentUrl(attachment)"
                />
                <p v-else class="text-[11px] text-gray-500">
                  {{ loadingAttachmentIds.has(attachment.id) ? 'Loading audio...' : 'Preview unavailable' }}
                </p>
                </div>

                <p v-else class="text-[11px] text-gray-500">
                  {{ formatFileSize(attachment.file_size) }}
                </p>
              </template>
            </div>
          </div>
          </template>
        </div>
      </li>
    </ul>

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

    <Teleport to="body">
      <div
        v-if="showEditEmojiPicker"
        ref="editPickerRoot"
        class="z-20 emoji-picker-dark"
        :style="editEmojiPickerStyle"
        @click.stop
      >
        <component
          :is="editPickerComponent"
          v-if="editPickerComponent && editEmojiIndex"
          :data="editEmojiIndex"
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
          @select="onSelectEditEmoji"
          @selected="onSelectEditEmoji"
        />
        <div
          v-else
          class="rounded-md border border-chat-border bg-chat-header px-3 py-2 text-xs text-app-muted shadow-xl"
        >
          Loading emoji...
        </div>
      </div>
    </Teleport>

    <div
      v-if="imagePreview.open"
      data-testid="task-comment-image-lightbox"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      @click.self="closeImagePreview"
    >
      <div class="relative rounded-xl bg-black/20 p-2 shadow-xl sm:p-3">
        <div class="flex items-center justify-end px-1 py-1">
          <button
            data-testid="task-comment-image-lightbox-close"
            class="rounded-md border border-white/20 bg-black/55 p-1.5 text-white/90 transition-colors hover:bg-black/75 hover:text-white"
            @click="closeImagePreview"
          >
            <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <img
          data-testid="task-comment-image-lightbox-img"
          :src="imagePreview.src"
          :alt="imagePreview.fileName"
          class="max-h-[60vh] max-w-[86vw] rounded-lg object-contain sm:max-h-[70vh] sm:max-w-[74vw]"
        >
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, nextTick, reactive, type ComponentPublicInstance } from 'vue'
import router from '@/router'
import { useTasksStore } from '@/stores/tasks'
import { useAuthStore } from '@/stores/auth'
import { usePinnedDialogsStore } from '@/stores/pinnedDialogs'
import UserAvatar from '@/components/UserAvatar.vue'
import { useComposerEmojiPicker } from '@/composables/useComposerEmojiPicker'
import { useColorTheme } from '@/composables/useColorTheme'
import { renderMarkdownToHtml } from '@/utils/markdown'
import { handleMarkdownLinkClick } from '@/utils/linkNavigation'
import { userCustomStatusFromDto } from '@/types/userStatus'
import RichTextComposer from '@/components/RichTextComposer.vue'
import {
  tasksListComments,
  tasksCreateComment,
  tasksUpdateComment,
  tasksEnsureCommentThread,
  tasksUploadCommentAttachment,
  tasksDeleteCommentAttachment,
  tasksFetchCommentAttachmentBlob,
  type TaskComment,
  type TaskCommentAttachment,
} from '@/services/http/tasksApi'

const MAX_ATTACHMENTS = 10
const MAX_COMPOSER_LINES = 8

const props = defineProps<{ taskId: string }>()

const tasksStore = useTasksStore()
const authStore = useAuthStore()
const pinnedDialogs = usePinnedDialogsStore()
const { currentTheme } = useColorTheme()
const emojiPickerAccentColor = computed(() => currentTheme.value.tokens.accent)
const comments = ref<TaskComment[]>([])
const loading = ref(false)
const error = ref('')
const newBody = ref('')
const submitting = ref(false)
const openingThreadCommentIds = ref(new Set<string>())

const fileInputEl = ref<HTMLInputElement | null>(null)
const stagedAttachments = ref<TaskCommentAttachment[]>([])
const uploading = ref(false)
const attachmentError = ref('')
const removingAttachmentIds = ref(new Set<string>())
const isDragOver = ref(false)
const editFileInputEl = ref<HTMLInputElement | null>(null)
const composerRef = ref<InstanceType<typeof RichTextComposer> | null>(null)
const editComposerRef = ref<InstanceType<typeof RichTextComposer> | null>(null)
const rootEl = ref<HTMLElement | null>(null)
const highlightedCommentId = computed(() => {
  const raw = router.currentRoute.value.query.comment
  return typeof raw === 'string' ? raw : ''
})

const editingCommentId = ref<string | null>(null)
const editBody = ref('')
const editAttachments = ref<TaskCommentAttachment[]>([])
const editSaving = ref(false)
const editUploading = ref(false)
const editError = ref('')
const editAttachmentError = ref('')
const editRemovingAttachmentIds = ref(new Set<string>())
const editDragOver = ref(false)

const attachmentUrls = ref<Record<string, string>>({})
const loadingAttachmentIds = ref(new Set<string>())

const imagePreview = reactive({
  open: false,
  src: '',
  fileName: '',
})

function asElement<T extends HTMLElement>(value: Element | ComponentPublicInstance | null): T | null {
  return value instanceof HTMLElement ? value as T : null
}

function setEditFileInputRef(value: Element | ComponentPublicInstance | null) {
  editFileInputEl.value = asElement<HTMLInputElement>(value)
}

function setEditTextareaRef(value: Element | ComponentPublicInstance | null) {
  editComposerRef.value = value as InstanceType<typeof RichTextComposer> | null
}

function setEditComposerRef(value: Element | ComponentPublicInstance | null) {
  editComposerRef.value = value as InstanceType<typeof RichTextComposer> | null
}

function setEditPickerToggleButtonRef(value: Element | ComponentPublicInstance | null) {
  editPickerToggleButton.value = asElement<HTMLElement>(value)
}

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
  onSelect: insertEmojiAtCursor,
})
const {
  showEmojiPicker: showEditEmojiPicker,
  pickerRoot: editPickerRoot,
  pickerToggleButton: editPickerToggleButton,
  pickerComponent: editPickerComponent,
  emojiIndex: editEmojiIndex,
  emojiPickerStyle: editEmojiPickerStyle,
  toggleEmojiPicker: toggleEditEmojiPicker,
  closeEmojiPicker: closeEditEmojiPicker,
  onSelectEmoji: onSelectEditEmoji,
} = useComposerEmojiPicker({
  onSelect: insertEditEmojiAtCursor,
})

const canSubmit = computed(() => {
  if (submitting.value || uploading.value) return false
  if (newBody.value.trim().length > 0) return true
  return stagedAttachments.value.length > 0
})
const canSaveEditedComment = computed(() => {
  if (!editingCommentId.value || editSaving.value || editUploading.value) return false
  if (editBody.value.trim().length > 0) return true
  return editAttachments.value.length > 0
})

function renderCommentBody(body: string): string {
  return renderMarkdownToHtml(body)
}

function onMarkdownClick(event: MouseEvent) {
  handleMarkdownLinkClick(event, router)
}

const attachButtonTitle = computed(() => {
  if (stagedAttachments.value.length >= MAX_ATTACHMENTS) return `Max ${MAX_ATTACHMENTS} attachments per comment`
  return 'Attach file'
})
const editAttachButtonTitle = computed(() => {
  if (editAttachments.value.length >= MAX_ATTACHMENTS) return `Max ${MAX_ATTACHMENTS} attachments per comment`
  return 'Attach file'
})

async function load() {
  loading.value = true
  error.value = ''
  try {
    comments.value = sortCommentsNewestFirst(await tasksListComments(props.taskId))
    preloadAttachmentUrls()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load comments'
  } finally {
    loading.value = false
  }
}

function openFilePicker() {
  fileInputEl.value?.click()
}

function openEditFilePicker() {
  editFileInputEl.value?.click()
}

async function onFileInputChange(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (files.length === 0) return
  await uploadFiles(files)
}

async function onEditFileInputChange(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (files.length === 0) return
  await uploadEditFiles(files)
}

async function uploadFiles(files: File[]) {
  if (submitting.value || uploading.value) return
  attachmentError.value = ''
  const remainingSlots = MAX_ATTACHMENTS - stagedAttachments.value.length
  if (remainingSlots <= 0) {
    attachmentError.value = `Max ${MAX_ATTACHMENTS} attachments per comment`
    return
  }
  const selected = files.slice(0, remainingSlots)
  if (selected.length < files.length) {
    attachmentError.value = `Only ${MAX_ATTACHMENTS} attachments are allowed per comment`
  }

  uploading.value = true
  try {
    for (const file of selected) {
      const uploaded = await tasksUploadCommentAttachment(props.taskId, file)
      stagedAttachments.value.push(uploaded)
    }
  } catch (e) {
    attachmentError.value = e instanceof Error ? e.message : 'Failed to upload attachment'
  } finally {
    uploading.value = false
  }
}

async function uploadEditFiles(files: File[]) {
  if (!editingCommentId.value || editSaving.value || editUploading.value) return
  editAttachmentError.value = ''
  const remainingSlots = MAX_ATTACHMENTS - editAttachments.value.length
  if (remainingSlots <= 0) {
    editAttachmentError.value = `Max ${MAX_ATTACHMENTS} attachments per comment`
    return
  }
  const selected = files.slice(0, remainingSlots)
  if (selected.length < files.length) {
    editAttachmentError.value = `Only ${MAX_ATTACHMENTS} attachments are allowed per comment`
  }

  editUploading.value = true
  try {
    for (const file of selected) {
      const uploaded = await tasksUploadCommentAttachment(props.taskId, file)
      editAttachments.value.push(uploaded)
    }
  } catch (e) {
    editAttachmentError.value = e instanceof Error ? e.message : 'Failed to upload attachment'
  } finally {
    editUploading.value = false
  }
}

async function removeStagedAttachment(attachmentId: string) {
  removingAttachmentIds.value.add(attachmentId)
  attachmentError.value = ''
  try {
    await tasksDeleteCommentAttachment(props.taskId, attachmentId)
    stagedAttachments.value = stagedAttachments.value.filter(item => item.id !== attachmentId)
  } catch (e) {
    attachmentError.value = e instanceof Error ? e.message : 'Failed to remove attachment'
  } finally {
    removingAttachmentIds.value.delete(attachmentId)
  }
}

async function removeEditAttachment(attachment: TaskCommentAttachment) {
  editRemovingAttachmentIds.value.add(attachment.id)
  editAttachmentError.value = ''
  try {
    if (!attachment.comment_id) {
      await tasksDeleteCommentAttachment(props.taskId, attachment.id)
    }
    editAttachments.value = editAttachments.value.filter(item => item.id !== attachment.id)
  } catch (e) {
    editAttachmentError.value = e instanceof Error ? e.message : 'Failed to remove attachment'
  } finally {
    editRemovingAttachmentIds.value.delete(attachment.id)
  }
}

async function cleanupStagedAttachments(taskId: string = props.taskId) {
  const ids = stagedAttachments.value.map(item => item.id)
  stagedAttachments.value = []
  await Promise.allSettled(ids.map(async id => {
    try {
      await tasksDeleteCommentAttachment(taskId, id)
    } catch {
      // Best-effort cleanup only.
    }
  }))
}

async function cleanupEditStagedAttachments(taskId: string = props.taskId) {
  const ids = editAttachments.value
    .filter(item => !item.comment_id)
    .map(item => item.id)
  await Promise.allSettled(ids.map(async id => {
    try {
      await tasksDeleteCommentAttachment(taskId, id)
    } catch {
      // Best-effort cleanup only.
    }
  }))
}

function isFileDragEvent(event: DragEvent): boolean {
  return event.dataTransfer?.types?.includes('Files') ?? false
}

function clipboardFileKey(file: File): string {
  return `${file.name}:${file.size}:${file.type}:${file.lastModified}`
}

function extractClipboardFiles(event: ClipboardEvent): File[] {
  const data = event.clipboardData
  if (!data) return []

  const files: File[] = []
  const seen = new Set<string>()
  const pushFile = (file: File | null | undefined) => {
    if (!file) return
    const key = clipboardFileKey(file)
    if (seen.has(key)) return
    seen.add(key)
    files.push(file)
  }

  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue
    pushFile(item.getAsFile())
  }
  for (const file of Array.from(data.files ?? [])) {
    pushFile(file)
  }

  return files
}

function insertEmojiAtCursor(emoji: string) {
  composerRef.value?.insertText(emoji)
}

function insertEditEmojiAtCursor(emoji: string) {
  editComposerRef.value?.insertText(emoji)
}

function findNearestScrollContainer(start: HTMLElement | null): HTMLElement | null {
  let node: HTMLElement | null = start?.parentElement ?? null
  while (node) {
    const style = window.getComputedStyle(node)
    const overflowY = style.overflowY
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 1) {
      return node
    }
    node = node.parentElement
  }
  return null
}

function preserveScrollOnComposerResize(deltaPx: number) {
  if (deltaPx === 0) return
  const container = findNearestScrollContainer(rootEl.value)
  if (!container) return
  const nearBottom = container.scrollHeight - (container.scrollTop + container.clientHeight) <= 72
  if (nearBottom) {
    container.scrollTop = container.scrollHeight
  }
}

async function submit() {
  const body = newBody.value.trim()
  if ((!body && stagedAttachments.value.length === 0) || submitting.value || uploading.value) return
  submitting.value = true
  error.value = ''
  attachmentError.value = ''
  try {
    const comment = await tasksCreateComment(props.taskId, {
      body,
      attachment_ids: stagedAttachments.value.map(item => item.id),
    })
    comments.value = sortCommentsNewestFirst([comment, ...comments.value])
    newBody.value = ''
    stagedAttachments.value = []
    closeEmojiPicker()
    preloadAttachmentUrls()
    tasksStore.loadUsers()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to post comment'
  } finally {
    submitting.value = false
  }
}

function canEditComment(comment: TaskComment): boolean {
  return authStore.user?.id === comment.author_id
}

function isEditedComment(comment: TaskComment): boolean {
  return new Date(comment.updated_at).getTime() > new Date(comment.created_at).getTime()
}

function isHighlightedComment(comment: TaskComment): boolean {
  return highlightedCommentId.value === comment.id
}

function scrollHighlightedCommentIntoView() {
  const commentId = highlightedCommentId.value
  const root = rootEl.value
  if (!commentId || !root) return
  const target = root.querySelector<HTMLElement>(`[data-task-comment-id="${commentId}"]`)
  target?.scrollIntoView({ block: 'center' })
}

async function openCommentThread(comment: TaskComment) {
  if (openingThreadCommentIds.value.has(comment.id)) return
  openingThreadCommentIds.value.add(comment.id)
  error.value = ''
  try {
    const thread = await tasksEnsureCommentThread(props.taskId, comment.id)
    comments.value = comments.value.map(item => item.id === comment.id
      ? {
          ...item,
          thread_root_message_id: thread.thread_root_message_id,
          thread_reply_count: thread.reply_count,
        }
      : item)
    const title = tasksStore.selectedTask?.public_id
      ? `Task ${tasksStore.selectedTask.public_id}`
      : 'Task'
    pinnedDialogs.ensureThreadPinned(thread.conversation_id, thread.thread_root_message_id, title)
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to open thread'
  } finally {
    openingThreadCommentIds.value.delete(comment.id)
  }
}

async function startEditingComment(comment: TaskComment) {
  if (!canEditComment(comment)) return
  if (editingCommentId.value && editingCommentId.value !== comment.id) {
    await cleanupEditStagedAttachments()
  }
  closeEditEmojiPicker()
  editingCommentId.value = comment.id
  editBody.value = comment.body
  editAttachments.value = (comment.attachments ?? []).map(item => ({ ...item }))
  editError.value = ''
  editAttachmentError.value = ''
  editDragOver.value = false
  nextTick(() => {
    editComposerRef.value?.focusAtEnd()
  })
}

async function cancelEditingComment() {
  if (editSaving.value) return
  await cleanupEditStagedAttachments()
  closeEditEmojiPicker()
  editingCommentId.value = null
  editBody.value = ''
  editAttachments.value = []
  editError.value = ''
  editAttachmentError.value = ''
  editDragOver.value = false
}

async function saveEditingComment() {
  const commentId = editingCommentId.value
  if (!commentId || !canSaveEditedComment.value) return
  editSaving.value = true
  editError.value = ''
  editAttachmentError.value = ''
  try {
    const updated = await tasksUpdateComment(props.taskId, commentId, {
      body: editBody.value.trim(),
      attachment_ids: editAttachments.value.map(item => item.id),
    })
    comments.value = comments.value.map(comment => (comment.id === commentId ? updated : comment))
    closeEditEmojiPicker()
    editingCommentId.value = null
    editBody.value = ''
    editAttachments.value = []
    preloadAttachmentUrls()
    void tasksStore.loadUsers()
  } catch (e) {
    editError.value = e instanceof Error ? e.message : 'Failed to update comment'
  } finally {
    editSaving.value = false
  }
}

function authorName(authorId: string): string {
  const user = tasksStore.users.find(u => u.id === authorId)
  return user?.display_name ?? authorId.slice(0, 8)
}

function authorAvatar(authorId: string): string {
  const user = tasksStore.users.find(u => u.id === authorId)
  return user?.avatar_url ?? ''
}

function authorCustomStatus(authorId: string) {
  const user = tasksStore.users.find(u => u.id === authorId)
  return userCustomStatusFromDto(user?.custom_status)
}

function sortCommentsNewestFirst(items: TaskComment[]): TaskComment[] {
  return [...items].sort((a, b) => {
    const createdA = new Date(a.created_at).getTime()
    const createdB = new Date(b.created_at).getTime()
    return createdB - createdA
  })
}

function formatDatetime(v: string): string {
  return v ? new Date(v).toLocaleString() : ''
}

function isImageAttachment(attachment: TaskCommentAttachment): boolean {
  return attachment.mime_type.startsWith('image/')
}

function isVideoAttachment(attachment: TaskCommentAttachment): boolean {
  return attachment.mime_type.startsWith('video/')
}

function isAudioAttachment(attachment: TaskCommentAttachment): boolean {
  return attachment.mime_type.startsWith('audio/')
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function attachmentUrl(attachment: TaskCommentAttachment): string {
  return attachmentUrls.value[attachment.id] ?? ''
}

function revokeAttachmentUrl(attachmentId: string) {
  const url = attachmentUrls.value[attachmentId]
  if (!url) return
  URL.revokeObjectURL(url)
  delete attachmentUrls.value[attachmentId]
}

function revokeAllAttachmentUrls() {
  for (const id of Object.keys(attachmentUrls.value)) {
    revokeAttachmentUrl(id)
  }
  attachmentUrls.value = {}
  loadingAttachmentIds.value.clear()
}

async function ensureAttachmentUrl(commentId: string, attachment: TaskCommentAttachment) {
  if (attachmentUrls.value[attachment.id]) return
  if (loadingAttachmentIds.value.has(attachment.id)) return

  loadingAttachmentIds.value.add(attachment.id)
  try {
    const blob = await tasksFetchCommentAttachmentBlob(props.taskId, commentId, attachment.id)
    attachmentUrls.value[attachment.id] = URL.createObjectURL(blob)
  } catch {
    // Preview remains unavailable; keep UI fallback text.
  } finally {
    loadingAttachmentIds.value.delete(attachment.id)
  }
}

function preloadAttachmentUrls() {
  for (const comment of comments.value) {
    for (const attachment of comment.attachments ?? []) {
      if (isImageAttachment(attachment) || isVideoAttachment(attachment) || isAudioAttachment(attachment)) {
        void ensureAttachmentUrl(comment.id, attachment)
      }
    }
  }
}

async function downloadAttachment(commentId: string, attachment: TaskCommentAttachment) {
  try {
    const blob = await tasksFetchCommentAttachmentBlob(props.taskId, commentId, attachment.id)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = attachment.file_name
    a.click()
    URL.revokeObjectURL(url)
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to download attachment'
  }
}

async function openImagePreview(commentId: string, attachment: TaskCommentAttachment) {
  let src = attachmentUrl(attachment)
  if (!src) {
    await ensureAttachmentUrl(commentId, attachment)
    src = attachmentUrl(attachment)
  }
  if (!src) return
  imagePreview.open = true
  imagePreview.src = src
  imagePreview.fileName = attachment.file_name
}

function closeImagePreview() {
  imagePreview.open = false
  imagePreview.src = ''
  imagePreview.fileName = ''
}

function handleEscape(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  if (!imagePreview.open) return
  closeImagePreview()
}

watch(comments, () => {
  preloadAttachmentUrls()
}, { deep: true })

watch(() => [highlightedCommentId.value, comments.value.length] as const, async () => {
  if (!highlightedCommentId.value) return
  await nextTick()
  scrollHighlightedCommentIntoView()
}, { immediate: true })

watch(() => props.taskId, (next, prev) => {
  closeEmojiPicker()
  closeEditEmojiPicker()
  if (prev && prev !== next) {
    void cleanupStagedAttachments(prev)
    void cleanupEditStagedAttachments(prev)
    revokeAllAttachmentUrls()
    newBody.value = ''
    editingCommentId.value = null
    editBody.value = ''
    editAttachments.value = []
    editError.value = ''
    editAttachmentError.value = ''
    editDragOver.value = false
    closeImagePreview()
    void load()
  }
})

watch(() => imagePreview.open, (open) => {
  if (open) {
    document.addEventListener('keydown', handleEscape)
    return
  }
  document.removeEventListener('keydown', handleEscape)
})

onMounted(() => {
  void load()
  void tasksStore.loadUsers()
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleEscape)
  closeEmojiPicker()
  closeEditEmojiPicker()
  if (stagedAttachments.value.length > 0) {
    void cleanupStagedAttachments()
  }
  if (editAttachments.value.some(item => !item.comment_id)) {
    void cleanupEditStagedAttachments()
  }
  closeImagePreview()
  revokeAllAttachmentUrls()
})
</script>

<style scoped>
</style>
