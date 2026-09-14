<template>
  <div class="flex h-full min-h-0 flex-col bg-chat-bg">
    <div
      ref="scrollEl"
      class="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-0.5"
      @scroll.passive="handleScroll"
    >
      <template v-if="messages.length === 0">
        <div class="flex h-full flex-col items-center justify-center gap-2 text-gray-500">
          <svg class="h-10 w-10" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
            <path d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-5l-5 5v-5z"/>
          </svg>
          <div class="text-sm">No messages yet</div>
        </div>
      </template>

      <VirtualMessageTimeline
        v-else
        ref="messageTimeline"
        :items="messages"
        :scroll-container="scrollEl"
        :row-gap="2"
        :keep-rendered-ids="timelinePinnedMessageIds"
      >
        <template #default="{ item: msg, index: idx }">
          <div :data-conversation-message-id="msg.id">
            <MessageBubble
              :message="msg"
              :show-header="shouldShowHeader(idx)"
              :thread-reply-count="threadReplyCount(msg.id)"
              :is-active-thread="false"
              :edit-request-token="editRequestTokenFor(msg.id)"
              @edit-close="handleInlineEditClose"
              @open-thread="emit('openThread', $event)"
            />
          </div>
        </template>
      </VirtualMessageTimeline>
    </div>

    <MessageInput
      :channel-name="conversation?.title ?? 'conversation'"
      :conversation-id="conversationId"
      :draft-scope="conversationDraftScope"
      :disabled="!conversationId"
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
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ChatDraftScope } from '@/services/storage/chatDraftStorage'
import { useChatStore, type Message, type MessageAttachment } from '@/stores/chat'
import { useAuthStore } from '@/stores/auth'
import { useWsStore } from '@/stores/ws'
import MessageBubble from '@/components/MessageBubble.vue'
import MessageInput from '@/components/MessageInput.vue'
import VirtualMessageTimeline from '@/components/chat/VirtualMessageTimeline.vue'

const props = defineProps<{
  conversationId: string
  mode?: 'main' | 'pinned'
  showEmbeddedThreadPanel?: boolean
}>()

const emit = defineEmits<{
  openThread: [message: Message]
}>()

const chatStore = useChatStore()
const authStore = useAuthStore()
const wsStore = useWsStore()
const scrollEl = ref<HTMLElement | null>(null)
interface VirtualMessageTimelineHandle {
  scrollToMessage: (messageId: string | number, options?: ScrollIntoViewOptions) => Promise<boolean>
}
const messageTimeline = ref<VirtualMessageTimelineHandle | null>(null)
const isNearBottom = ref(true)
const inlineEditRequest = ref({ messageId: '', token: 0 })
let typingIdleTimer: ReturnType<typeof setTimeout> | null = null
let typingIsActive = false
let typingLastSentAtMs = 0

const conversation = computed(() => chatStore.getConversationById(props.conversationId))
const messages = computed(() => chatStore.getMessagesForConversation(props.conversationId))
const timelinePinnedMessageIds = computed(() => [inlineEditRequest.value.messageId].filter(Boolean))
const conversationDraftScope = computed<ChatDraftScope>(() => ({
  kind: 'conversation',
  conversationId: props.conversationId,
}))
const typingLabel = computed(() => {
  const entries = chatStore.getTypingForConversation(props.conversationId)
    .filter(entry => entry.userId !== chatStore.workspace?.selfUserId)
  if (entries.length === 0) return ''
  if (entries.length === 1) return `${chatStore.resolveDisplayName(entries[0].userId)} is typing...`
  return `${entries.length} people are typing...`
})
const timelineThreadReplyCounts = computed<Record<string, number>>(() => {
  const counts: Record<string, number> = {}
  for (const msg of messages.value) {
    const rootId = msg.threadRootMessageId
    if (!rootId || rootId === msg.id) continue
    counts[rootId] = (counts[rootId] ?? 0) + 1
  }
  return counts
})

function scrollToBottom() {
  const el = scrollEl.value
  if (!el) return
  el.scrollTop = el.scrollHeight
}

async function scrollMessageIntoView(messageId: string) {
  if (!messageId) return
  const el = scrollEl.value
  if (!el) return
  if (await messageTimeline.value?.scrollToMessage(messageId, { block: 'center' })) return
  const target = el.querySelector<HTMLElement>(`[data-conversation-message-id="${messageId}"]`)
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

function shouldShowHeader(idx: number): boolean {
  if (idx === 0) return true
  const prev = messages.value[idx - 1]
  const curr = messages.value[idx]
  if (!prev || !curr) return true
  if (prev.senderId !== curr.senderId) return true
  return new Date(curr.createdAt).getTime() - new Date(prev.createdAt).getTime() > 5 * 60 * 1000
}

function threadReplyCount(rootMessageId: string): number {
  const summaryCount = chatStore.threadSummaries[rootMessageId]?.replyCount ?? 0
  const timelineCount = timelineThreadReplyCounts.value[rootMessageId] ?? 0
  return Math.max(summaryCount, timelineCount)
}

function canInlineEditMessage(message: Message): boolean {
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
  const target = [...messages.value].reverse().find(canInlineEditMessage)
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
  chatStore.sendMessageToConversation(props.conversationId, payload.body, payload.attachmentIds, payload.attachments, payload.entities)
  stopTypingPresence(true)
  void nextTick(() => scrollToBottom())
}

watch(() => props.conversationId, async (conversationId) => {
  inlineEditRequest.value = { messageId: '', token: inlineEditRequest.value.token }
  if (!conversationId) return
  await chatStore.ensureConversationHistory(conversationId)
  await nextTick()
  scrollToBottom()
}, { immediate: true })

watch(() => messages.value.length, async () => {
  if (!isNearBottom.value) return
  await nextTick()
  scrollToBottom()
})

onMounted(() => {
  void nextTick(() => scrollToBottom())
})

onBeforeUnmount(() => {
  stopTypingPresence(true)
})
</script>
