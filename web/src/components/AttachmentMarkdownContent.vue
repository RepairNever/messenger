<template>
  <div class="space-y-3">
    <template v-for="(block, index) in blocks" :key="`${block.type}:${index}`">
      <div
        v-if="block.type === 'markdown'"
        class="markdown-body break-words text-sm text-gray-300"
        v-html="renderMarkdownBlock(block.content)"
        @click="onMarkdownClick"
      />

      <div v-else-if="block.token.kind === 'image'" class="group/image relative w-fit">
        <button
          data-testid="attachment-markdown-image"
          class="block max-w-[240px] overflow-hidden rounded-lg bg-chat-input/60 shadow-sm transition-colors hover:bg-chat-input/80 sm:max-w-[360px]"
          type="button"
          @click="openImagePreview(block.token)"
        >
          <img
            v-if="attachmentUrl(block.token)"
            data-testid="attachment-markdown-image-img"
            :src="attachmentUrl(block.token)"
            :alt="block.token.fileName"
            class="max-h-[220px] w-full object-contain sm:max-h-[280px]"
          >
          <div v-else class="flex h-24 items-center justify-center px-4 text-xs text-gray-500">
            {{ unavailableAttachmentKeys.has(attachmentKey(block.token)) ? 'Attachment unavailable' : 'Loading image...' }}
          </div>
        </button>
        <button
          class="absolute right-2 top-2 rounded-md border border-white/20 bg-black/55 p-1 text-white/90 opacity-0 transition-opacity group-hover/image:opacity-100 hover:bg-black/75 hover:text-white"
          title="Download"
          type="button"
          @click.stop="downloadAttachment(block.token)"
        >
          <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7,10 12,15 17,10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </button>
      </div>

      <button
        v-else
        data-testid="attachment-markdown-file-link"
        type="button"
        class="flex items-center gap-2 rounded-md border border-chat-border bg-chat-input/70 px-3 py-2 text-left text-sm text-gray-200 transition-colors hover:border-accent/40 hover:text-white"
        @click="openAttachmentInBrowser(block.token)"
      >
        <svg class="h-4 w-4 shrink-0 text-gray-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14,2 14,8 20,8" />
        </svg>
        <span class="truncate">{{ block.token.fileName }}</span>
      </button>
    </template>
  </div>

  <Teleport to="body">
    <div
      v-if="imagePreview.open"
      data-testid="attachment-markdown-lightbox"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      @click.self="closeImagePreview"
    >
      <button
        data-testid="attachment-markdown-lightbox-close"
        type="button"
        class="absolute right-5 top-5 rounded-md border border-white/20 bg-black/55 p-2 text-white/90 transition-colors hover:bg-black/75 hover:text-white"
        @click="closeImagePreview"
      >
        <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
      <img
        v-if="imagePreview.src"
        data-testid="attachment-markdown-lightbox-img"
        :src="imagePreview.src"
        :alt="imagePreview.fileName"
        class="max-h-[85vh] max-w-[92vw] object-contain"
      >
    </div>
  </Teleport>

  <Teleport to="body">
    <div
      v-if="activeUserCard"
      ref="userCardRef"
    >
      <UserMentionCard
        data-testid="attachment-markdown-user-card"
        :user-id="activeUserCard.userId"
        :display-name="activeUserCard.displayName"
        :email="activeUserCard.email"
        :avatar-url="activeUserCard.avatarUrl"
        :custom-status="activeUserCard.customStatus"
        :top="activeUserCard.top"
        :left="activeUserCard.left"
      />
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import UserMentionCard from '@/components/UserMentionCard.vue'
import router from '@/router'
import { fetchOwnedAttachmentBlob } from '@/services/http/attachmentOwnersApi'
import { tasksFetchStagedAttachmentBlob } from '@/services/http/tasksApi'
import { openBlobInBrowser } from '@/utils/attachmentBrowser'
import {
  decorateDescriptionMentionHtml,
  getDescriptionMentionUser,
  markdownContainsUserMention,
  parseUserMentionHref,
  warmDescriptionMentionUsersCache,
} from '@/utils/descriptionMentions'
import { handleMarkdownLinkClick } from '@/utils/linkNavigation'
import {
  type AttachmentToken,
  splitMarkdownWithAttachmentBlocks,
} from '@/utils/attachmentMarkdown'
import { renderTaskMarkdownToHtml } from '@/utils/taskMarkdown'
import { userCustomStatusFromDto, type UserCustomStatus } from '@/types/userStatus'

const props = defineProps<{
  markdown: string
}>()

const blocks = computed(() => splitMarkdownWithAttachmentBlocks(props.markdown))
const attachmentUrls = ref<Record<string, string>>({})
const loadingAttachmentKeys = reactive(new Set<string>())
const unavailableAttachmentKeys = reactive(new Set<string>())
const imagePreview = reactive({
  open: false,
  src: '',
  fileName: '',
})
const userCardRef = ref<HTMLElement | null>(null)
const activeUserCard = ref<{
  userId: string
  displayName: string
  email: string
  avatarUrl: string
  customStatus: UserCustomStatus | null
  top: number
  left: number
} | null>(null)

function renderMarkdownBlock(value: string): string {
  return decorateDescriptionMentionHtml(renderTaskMarkdownToHtml(value))
}

function onMarkdownClick(event: MouseEvent) {
  const handled = handleMarkdownLinkClick(event, router, {
    onUserMentionLink: openUserMentionCard,
  })
  if (handled) {
    event.stopPropagation()
  }
}

function attachmentKey(token: AttachmentToken): string {
  return `${token.ownerKind}:${token.ownerId}:${token.attachmentId}`
}

async function fetchBlob(token: AttachmentToken): Promise<Blob> {
  if (token.ownerKind === 'task-staged') {
    return tasksFetchStagedAttachmentBlob(token.attachmentId)
  }
  return fetchOwnedAttachmentBlob(token.ownerKind, token.ownerId, token.attachmentId)
}

function attachmentUrl(token: AttachmentToken): string {
  return attachmentUrls.value[attachmentKey(token)] ?? ''
}

function revokeAttachmentUrl(key: string) {
  const url = attachmentUrls.value[key]
  if (!url) return
  URL.revokeObjectURL(url)
  const next = { ...attachmentUrls.value }
  delete next[key]
  attachmentUrls.value = next
}

async function ensureImageUrl(token: AttachmentToken) {
  const key = attachmentKey(token)
  if (attachmentUrls.value[key]) return
  if (loadingAttachmentKeys.has(key)) return
  if (unavailableAttachmentKeys.has(key)) return

  loadingAttachmentKeys.add(key)
  try {
    const blob = await fetchBlob(token)
    attachmentUrls.value = {
      ...attachmentUrls.value,
      [key]: URL.createObjectURL(blob),
    }
  } catch {
    unavailableAttachmentKeys.add(key)
  } finally {
    loadingAttachmentKeys.delete(key)
  }
}

async function downloadAttachment(token: AttachmentToken) {
  const blob = await fetchBlob(token)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = token.fileName
  a.click()
  URL.revokeObjectURL(url)
}

async function openAttachmentInBrowser(token: AttachmentToken) {
  try {
    await openBlobInBrowser(() => fetchBlob(token))
  } catch {
    // Popup blocking is browser-controlled. Keep the current view unchanged.
  }
}

async function openImagePreview(token: AttachmentToken) {
  await ensureImageUrl(token)
  const src = attachmentUrl(token)
  if (!src) return
  imagePreview.open = true
  imagePreview.src = src
  imagePreview.fileName = token.fileName
}

function closeImagePreview() {
  imagePreview.open = false
  imagePreview.src = ''
  imagePreview.fileName = ''
}

function closeUserMentionCard() {
  activeUserCard.value = null
}

async function ensureMentionUsersLoaded() {
  if (!markdownContainsUserMention(props.markdown)) return
  try {
    await warmDescriptionMentionUsersCache()
  } catch {
    return
  }
}

async function openUserMentionCard(href: string, link: HTMLAnchorElement) {
  const mention = parseUserMentionHref(href)
  if (!mention) return
  const user = await getDescriptionMentionUser(mention.userId)
  const rect = link.getBoundingClientRect()
  const fallbackName = link.textContent?.trim().replace(/^@/, '') || mention.userId
  activeUserCard.value = {
    userId: mention.userId,
    displayName: user?.display_name || fallbackName,
    email: user?.email || '',
    avatarUrl: user?.avatar_url ?? '',
    customStatus: userCustomStatusFromDto(user?.custom_status),
    top: rect.bottom + 8,
    left: rect.left,
  }
}

function onDocumentClick(event: MouseEvent) {
  const target = event.target as Node | null
  if (!target) return
  if (userCardRef.value?.contains(target)) return
  closeUserMentionCard()
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && imagePreview.open) {
    closeImagePreview()
    return
  }
  if (event.key === 'Escape' && activeUserCard.value) {
    closeUserMentionCard()
  }
}

watch(blocks, (nextBlocks) => {
  for (const block of nextBlocks) {
    if (block.type === 'attachment' && block.token.kind === 'image') {
      void ensureImageUrl(block.token)
    }
  }
}, { immediate: true })

watch(() => imagePreview.open || !!activeUserCard.value, (open) => {
  if (open) {
    window.addEventListener('keydown', onKeydown)
    document.addEventListener('click', onDocumentClick)
  } else {
    window.removeEventListener('keydown', onKeydown)
    document.removeEventListener('click', onDocumentClick)
  }
})

watch(() => props.markdown, () => {
  void ensureMentionUsersLoaded()
}, { immediate: true })

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  document.removeEventListener('click', onDocumentClick)
  for (const key of Object.keys(attachmentUrls.value)) {
    revokeAttachmentUrl(key)
  }
})
</script>
