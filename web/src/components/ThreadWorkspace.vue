<template>
  <div class="flex h-full min-h-0 flex-col bg-chat-header">
    <div ref="scrollEl" class="flex-1 min-h-0 overflow-y-auto" @scroll.passive="handleScroll">
      <div v-if="!rootMessage" class="px-4 py-6 text-xs text-gray-400">
        Root message not available.
      </div>

      <VirtualMessageTimeline
        v-else
        ref="replyTimeline"
        :items="replies"
        :scroll-container="scrollEl"
        :keep-rendered-ids="timelinePinnedReplyIds"
      >
        <template #before>
          <div
            class="border-b border-chat-border/50 px-2 py-2"
            :data-thread-message-id="rootMessage.id"
            :class="chatStore.focusedThreadMessageId === rootMessage.id ? 'bg-amber-500/10 ring-1 ring-inset ring-amber-300/40' : ''"
          >
            <MessageBubble
              :message="rootMessage"
              :show-header="true"
              :show-thread-action="false"
              :show-first-reaction-action="false"
            />
          </div>

          <div class="flex items-center gap-3 px-4 py-2">
            <div class="h-px flex-1 bg-chat-border" />
            <span class="shrink-0 text-[11px] text-gray-500">
              {{ replyCount === 0 ? 'No replies yet' : `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}` }}
            </span>
            <div class="h-px flex-1 bg-chat-border" />
          </div>
        </template>

        <template #default="{ item: reply, index: idx }">
          <div
            :data-thread-message-id="reply.id"
            :class="chatStore.focusedThreadMessageId === reply.id ? 'rounded-md bg-amber-500/10 ring-1 ring-inset ring-amber-300/40' : ''"
          >
            <MessageBubble
              :message="reply"
              :show-header="shouldShowHeader(idx)"
              :show-thread-action="false"
              :show-first-reaction-action="true"
              :edit-request-token="editRequestTokenFor(reply.id)"
              @edit-close="handleInlineEditClose"
            />
          </div>
        </template>

        <template #after>
          <div v-if="replies.length > 0" class="h-2" />

          <div
            v-if="replyCount > replies.length && replayStatus === 'error'"
            class="flex flex-col items-center gap-2 px-4 pb-4 text-center text-xs text-app-muted"
          >
            <span>Replies could not be loaded.</span>
            <button
              type="button"
              data-testid="thread-replay-retry"
              class="rounded border border-chat-border px-2 py-1 text-app-secondaryText transition-colors hover:bg-chat-msgHover hover:text-app-text"
              @click="retryReplay"
            >
              Retry
            </button>
          </div>

          <div v-else-if="replyCount > replies.length" class="px-4 pb-4 text-center text-xs text-app-muted">
            Loading replies...
          </div>

          <div v-else-if="replies.length === 0" class="px-4 pb-4 text-center text-xs text-app-muted">
            Be the first to reply
          </div>
        </template>
      </VirtualMessageTimeline>
    </div>

    <MessageInput
      :channel-name="rootMessage?.senderName ?? 'thread'"
      :conversation-id="conversationId"
      :draft-scope="threadDraftScope"
      :disabled="!conversationId || !rootMessageId"
      :typing-label="typingLabel"
      :online="wsStore.state !== 'DISCONNECTED' && wsStore.state !== 'CONNECTING'"
      @send="handleSend"
      @typing="handleTyping"
      @edit-last-message="handleEditLastMessage"
      @resize="handleComposerResize"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { ChatDraftScope } from '@/services/storage/chatDraftStorage'
import { useChatStore, type Message, type MessageAttachment } from '@/stores/chat'
import { useAuthStore } from '@/stores/auth'
import { useWsStore } from '@/stores/ws'
import MessageBubble from '@/components/MessageBubble.vue'
import MessageInput from '@/components/MessageInput.vue'
import VirtualMessageTimeline from '@/components/chat/VirtualMessageTimeline.vue'

const props = defineProps<{
  conversationId: string
  rootMessageId: string
  mode?: 'main' | 'pinned'
}>()

const chatStore = useChatStore()
const authStore = useAuthStore()
const wsStore = useWsStore()
const scrollEl = ref<HTMLElement | null>(null)
interface VirtualMessageTimelineHandle {
  scrollToMessage: (messageId: string | number, options?: ScrollIntoViewOptions) => Promise<boolean>
}
const replyTimeline = ref<VirtualMessageTimelineHandle | null>(null)
const isNearBottom = ref(true)
const inlineEditRequest = ref({ messageId: '', token: 0 })
let activationToken = 0
let activatedWorkspace: { conversationId: string; rootMessageId: string } | null = null
let typingIdleTimer: ReturnType<typeof setTimeout> | null = null
let typingIsActive = false
let typingLastSentAtMs = 0

const rootMessage = computed(() => chatStore.getThreadRoot(props.conversationId, props.rootMessageId))
const replies = computed(() => chatStore.getThreadReplies(props.rootMessageId))
const timelinePinnedReplyIds = computed(() => [
  chatStore.focusedThreadMessageId,
  inlineEditRequest.value.messageId,
].filter((messageId): messageId is string => Boolean(messageId) && messageId !== rootMessage.value?.id))
const threadDraftScope = computed<ChatDraftScope>(() => ({
  kind: 'thread',
  conversationId: props.conversationId,
  rootMessageId: props.rootMessageId,
}))
const replyCount = computed(() => (
  chatStore.threadSummaries[props.rootMessageId]?.replyCount ?? replies.value.length
))
const replayStatus = computed(() => chatStore.threadReplayStatus(props.rootMessageId))
const typingLabel = computed(() => {
  // Current typing presence is conversation-scoped, not thread-scoped.
  const entries = chatStore.getTypingForConversation(props.conversationId)
    .filter(entry => entry.userId !== chatStore.workspace?.selfUserId)
  if (entries.length === 0) return ''
  if (entries.length === 1) return `${chatStore.resolveDisplayName(entries[0].userId)} is typing...`
  return `${entries.length} people are typing...`
})

function shouldShowHeader(idx: number): boolean {
  if (idx === 0) return true
  const prev = replies.value[idx - 1]
  const curr = replies.value[idx]
  if (!prev || !curr) return true
  if (prev.senderId !== curr.senderId) return true
  return new Date(curr.createdAt).getTime() - new Date(prev.createdAt).getTime() > 5 * 60 * 1000
}

function scrollToBottom() {
  const el = scrollEl.value
  if (!el) return
  el.scrollTop = el.scrollHeight
}

async function scrollMessageIntoView(messageId: string) {
  if (!messageId) return
  const el = scrollEl.value
  if (!el) return
  if (messageId !== rootMessage.value?.id && await replyTimeline.value?.scrollToMessage(messageId, { block: 'center' })) return
  const target = el.querySelector<HTMLElement>(`[data-thread-message-id="${messageId}"]`)
  target?.scrollIntoView({ block: 'center' })
}

function handleScroll() {
  const el = scrollEl.value
  if (!el) return
  isNearBottom.value = el.scrollHeight - (el.scrollTop + el.clientHeight) <= 72
}

function handleComposerResize(deltaPx: number) {
  if (!deltaPx || !isNearBottom.value) return
  scrollToBottom()
}

function canInlineEditReply(message: Message): boolean {
  const selfUserId = authStore.user?.id || chatStore.workspace?.selfUserId || ''
  return Boolean(selfUserId)
    && message.senderId === selfUserId
    && !message.sendStatus
    && !message.pending
}

function editRequestTokenFor(messageId: string): number {
  return inlineEditRequest.value.messageId === messageId ? inlineEditRequest.value.token : 0
}

function requestInlineEdit(messageId: string) {
  if (!messageId) return
  inlineEditRequest.value = {
    messageId,
    token: inlineEditRequest.value.token + 1,
  }
  void nextTick(() => {
    void scrollMessageIntoView(messageId)
  })
}

function handleInlineEditClose(messageId: string) {
  if (inlineEditRequest.value.messageId !== messageId) return
  inlineEditRequest.value = { messageId: '', token: inlineEditRequest.value.token }
}

function handleEditLastMessage() {
  const target = [...replies.value].reverse().find(canInlineEditReply)
  if (!target) return
  requestInlineEdit(target.id)
}

function stopTypingPresence(sendStop: boolean) {
  if (typingIdleTimer) {
    clearTimeout(typingIdleTimer)
    typingIdleTimer = null
  }
  if (sendStop && typingIsActive && props.conversationId && wsStore.state === 'LIVE_SYNCED') {
    wsStore.sendTyping(props.conversationId, false)
  }
  typingIsActive = false
  typingLastSentAtMs = 0
}

function scheduleTypingStop() {
  if (typingIdleTimer) clearTimeout(typingIdleTimer)
  typingIdleTimer = setTimeout(() => {
    typingIdleTimer = null
    if (!typingIsActive || !props.conversationId || wsStore.state !== 'LIVE_SYNCED') return
    wsStore.sendTyping(props.conversationId, false)
    typingIsActive = false
    typingLastSentAtMs = 0
  }, 1000)
}

function handleTyping(active: boolean) {
  if (!props.conversationId) return
  if (!active) {
    stopTypingPresence(true)
    return
  }
  if (wsStore.state !== 'LIVE_SYNCED') return
  const now = Date.now()
  if (!typingIsActive || now - typingLastSentAtMs >= 3000) {
    wsStore.sendTyping(props.conversationId, true)
    typingIsActive = true
    typingLastSentAtMs = now
  }
  scheduleTypingStop()
}

function handleSend(payload: { body: string; entities: NonNullable<Message['entities']>; attachmentIds: string[]; attachments: MessageAttachment[] }) {
  chatStore.sendThreadReplyToRoot(props.conversationId, props.rootMessageId, payload.body, payload.attachmentIds, payload.attachments, payload.entities)
  stopTypingPresence(true)
  void nextTick(() => scrollToBottom())
}

function retryReplay() {
  chatStore.retryThreadReplay(props.conversationId, props.rootMessageId)
}

watch(() => [props.conversationId, props.rootMessageId] as const, async ([conversationId, rootMessageId]) => {
  const token = ++activationToken
  if (
    activatedWorkspace
    && (activatedWorkspace.conversationId !== conversationId || activatedWorkspace.rootMessageId !== rootMessageId)
  ) {
    chatStore.deactivateThreadWorkspace(activatedWorkspace.conversationId, activatedWorkspace.rootMessageId)
    activatedWorkspace = null
  }
  inlineEditRequest.value = { messageId: '', token: inlineEditRequest.value.token }
  if (!conversationId || !rootMessageId) return
  await chatStore.ensureConversationHistory(conversationId)
  if (!chatStore.getThreadRoot(conversationId, rootMessageId)) {
    await chatStore.loadMessageContext(conversationId, rootMessageId)
  }
  if (token !== activationToken) return
  chatStore.activateThreadWorkspace(conversationId, rootMessageId)
  activatedWorkspace = { conversationId, rootMessageId }
  await nextTick()
  scrollToBottom()
}, { immediate: true })

watch(() => replies.value.length, async () => {
  if (!isNearBottom.value) return
  await nextTick()
  scrollToBottom()
})

watch(() => [chatStore.focusedThreadMessageId, replies.value.length, rootMessage.value?.id ?? ''] as const, async ([messageId]) => {
  if (!messageId) return
  await nextTick()
  await scrollMessageIntoView(messageId)
}, { immediate: true })

onBeforeUnmount(() => {
  ++activationToken
  if (activatedWorkspace) {
    chatStore.deactivateThreadWorkspace(activatedWorkspace.conversationId, activatedWorkspace.rootMessageId)
    activatedWorkspace = null
  }
  stopTypingPresence(true)
})
</script>
