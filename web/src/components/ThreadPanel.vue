<template>
  <aside class="w-[360px] max-w-[42vw] h-full min-h-0 border-l border-chat-border bg-chat-header flex flex-col">
    <!-- Header -->
    <header class="flex items-center justify-between px-4 py-3 border-b border-chat-border shrink-0">
      <div class="flex items-center gap-2">
        <svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        <span class="text-sm font-semibold text-white">Thread</span>
      </div>
      <button
        class="h-7 w-7 rounded flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
        title="Close thread"
        @click="$emit('close')"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path d="M18 6L6 18M6 6l12 12"/>
        </svg>
      </button>
    </header>

    <!-- Scrollable body -->
    <div ref="scrollEl" class="flex-1 min-h-0 overflow-y-auto">
      <div v-if="!rootMessage" class="px-4 py-6 text-xs text-gray-400">
        Root message not available.
      </div>

      <template v-else>
        <!-- Root message -->
        <div
          class="border-b border-chat-border/50 px-2 py-2"
          :data-thread-message-id="rootMessage.id"
          :class="chat.focusedThreadMessageId === rootMessage.id ? 'bg-amber-500/10 ring-1 ring-inset ring-amber-300/40' : ''"
        >
          <MessageBubble
            :message="rootMessage"
            :show-header="true"
            :show-thread-action="false"
            :show-first-reaction-action="false"
          />
        </div>

        <!-- Replies divider -->
        <div class="flex items-center gap-3 px-4 py-2">
          <div class="flex-1 h-px bg-chat-border" />
          <span class="text-[11px] text-gray-500 shrink-0">
            {{ replyCount === 0 ? 'No replies yet' : `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}` }}
          </span>
          <div class="flex-1 h-px bg-chat-border" />
        </div>

        <!-- Thread replies -->
        <div v-if="replies.length > 0" class="pb-2">
          <div
            v-for="(reply, idx) in replies"
            :key="reply.id"
            :data-thread-message-id="reply.id"
            :class="chat.focusedThreadMessageId === reply.id ? 'rounded-md bg-amber-500/10 ring-1 ring-amber-300/40' : ''"
          >
            <MessageBubble
              :message="reply"
              :show-header="shouldShowHeader(idx)"
              :show-thread-action="false"
              :show-first-reaction-action="true"
              :edit-request-token="editRequestTokenFor(reply.id)"
            />
          </div>
        </div>

        <div v-else class="px-4 pb-4 text-xs text-gray-500 text-center">
          Be the first to reply
        </div>
      </template>
    </div>

    <MessageInput
      :channel-name="rootMessage?.senderName ?? 'thread'"
      :conversation-id="chat.activeThreadConversationId"
      :draft-scope="threadDraftScope"
      :disabled="!chat.activeThreadConversationId"
      :online="ws.state !== 'DISCONNECTED' && ws.state !== 'CONNECTING'"
      :focus-token="chat.threadComposerFocusToken"
      @send="sendReply"
      @edit-last-message="handleEditLastMessage"
      @resize="handleComposerResize"
    />
  </aside>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { ChatDraftScope } from '@/services/storage/chatDraftStorage'
import { useChatStore, type Message, type MessageAttachment } from '@/stores/chat'
import { useAuthStore } from '@/stores/auth'
import { useWsStore } from '@/stores/ws'
import MessageBubble from './MessageBubble.vue'
import MessageInput from './MessageInput.vue'

defineEmits<{ close: [] }>()

const chat = useChatStore()
const auth = useAuthStore()
const ws = useWsStore()

const rootMessage = computed(() => chat.activeThreadRootMessage)
const replies = computed(() => chat.activeThreadReplies)
const replayVersion = computed(() => chat.activeThreadReplayVersion)
const threadDraftScope = computed<ChatDraftScope | null>(() => {
  if (!chat.activeThreadConversationId || !chat.activeThreadRootId) return null
  return {
    kind: 'thread',
    conversationId: chat.activeThreadConversationId,
    rootMessageId: chat.activeThreadRootId,
  }
})
const replyCount = computed(() =>
  chat.threadSummaries[rootMessage.value?.id ?? '']?.replyCount
  ?? replies.value.length
)
const scrollEl = ref<HTMLElement | null>(null)
const forceScrollToBottomOnNextRender = ref(false)
const pendingBottomScroll = ref(false)
const pendingBottomScrollRootId = ref('')
const pendingBottomScrollReplayVersion = ref(0)
const pendingFocusedMessageId = ref('')
const inlineEditRequest = ref({ messageId: '', token: 0 })
let bottomScrollTimers: ReturnType<typeof setTimeout>[] = []
let focusScrollTimers: ReturnType<typeof setTimeout>[] = []

function clearScheduledTimers(timers: ReturnType<typeof setTimeout>[]) {
  for (const timer of timers) {
    clearTimeout(timer)
  }
  timers.length = 0
}

function scrollToBottom() {
  const el = scrollEl.value
  if (!el) return
  el.scrollTop = el.scrollHeight
}

function scrollMessageIntoView(messageId: string) {
  if (!messageId) return
  const el = scrollEl.value
  if (!el) return false
  const target = el.querySelector<HTMLElement>(`[data-thread-message-id="${messageId}"]`)
  if (!target) return false
  target.scrollIntoView({ block: 'center' })
  return true
}

function clearPendingBottomScroll() {
  pendingBottomScroll.value = false
  pendingBottomScrollRootId.value = ''
  pendingBottomScrollReplayVersion.value = 0
  clearScheduledTimers(bottomScrollTimers)
}

function scheduleGuaranteedBottomScroll(immediate = false) {
  clearPendingBottomScroll()
  clearScheduledTimers(focusScrollTimers)
  pendingFocusedMessageId.value = ''
  forceScrollToBottomOnNextRender.value = true

  const runScroll = () => {
    scrollToBottom()
  }

  if (immediate) {
    runScroll()
  }
  void nextTick(() => {
    runScroll()
    void nextTick(() => {
      runScroll()
    })
  })

  bottomScrollTimers.push(setTimeout(runScroll, 60))
  bottomScrollTimers.push(setTimeout(runScroll, 140))
  bottomScrollTimers.push(setTimeout(() => {
    forceScrollToBottomOnNextRender.value = false
  }, 260))
}

function scheduleReplayAwareBottomScroll(rootId: string) {
  clearPendingBottomScroll()
  clearScheduledTimers(focusScrollTimers)
  forceScrollToBottomOnNextRender.value = false
  pendingFocusedMessageId.value = ''
  pendingBottomScroll.value = true
  pendingBottomScrollRootId.value = rootId
  pendingBottomScrollReplayVersion.value = chat.threadReplayVersionByRoot[rootId] ?? 0

  const runScroll = () => {
    if (pendingBottomScrollRootId.value !== rootId) return
    scrollToBottom()
  }

  void nextTick(() => {
    runScroll()
    void nextTick(() => {
      runScroll()
    })
  })

  bottomScrollTimers.push(setTimeout(runScroll, 60))
  bottomScrollTimers.push(setTimeout(runScroll, 140))
}

function scheduleFocusedMessageScroll(messageId: string) {
  if (!messageId) return
  clearPendingBottomScroll()
  clearScheduledTimers(focusScrollTimers)
  forceScrollToBottomOnNextRender.value = false
  pendingFocusedMessageId.value = messageId

  const runScroll = () => {
    if (scrollMessageIntoView(messageId)) {
      pendingFocusedMessageId.value = ''
      clearScheduledTimers(focusScrollTimers)
    }
  }

  void nextTick(() => {
    runScroll()
    void nextTick(() => {
      runScroll()
    })
  })

  focusScrollTimers.push(setTimeout(runScroll, 60))
  focusScrollTimers.push(setTimeout(runScroll, 140))
}

function isNearBottom(thresholdPx = 72): boolean {
  const el = scrollEl.value
  if (!el) return true
  return el.scrollHeight - (el.scrollTop + el.clientHeight) <= thresholdPx
}

function handleComposerResize(deltaPx: number) {
  const el = scrollEl.value
  if (!el || deltaPx === 0) return
  if (isNearBottom() || forceScrollToBottomOnNextRender.value) {
    scrollToBottom()
  }
}

function sendReply(payload: { body: string; entities: NonNullable<Message['entities']>; attachmentIds: string[]; attachments: MessageAttachment[] }) {
  chat.sendThreadReply(payload.body, payload.attachmentIds, payload.attachments, payload.entities)
  scheduleGuaranteedBottomScroll(true)
}

function canInlineEditReply(message: Message): boolean {
  const selfUserId = auth.user?.id || chat.workspace?.selfUserId || ''
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
    scrollMessageIntoView(messageId)
  })
}

function handleEditLastMessage() {
  const target = [...replies.value].reverse().find(canInlineEditReply)
  if (!target) return
  requestInlineEdit(target.id)
}

function shouldShowHeader(idx: number): boolean {
  if (idx === 0) return true
  const prev = replies.value[idx - 1] as Message
  const curr = replies.value[idx] as Message
  if (prev.senderId !== curr.senderId) return true
  const prevTime = new Date(prev.createdAt).getTime()
  const currTime = new Date(curr.createdAt).getTime()
  return currTime - prevTime > 5 * 60 * 1000
}

watch(() => rootMessage.value?.id ?? '', (rootId) => {
  inlineEditRequest.value = { messageId: '', token: inlineEditRequest.value.token }
  if (!rootId) return
  if (chat.focusedThreadMessageId) {
    scheduleFocusedMessageScroll(chat.focusedThreadMessageId)
    return
  }
  scheduleReplayAwareBottomScroll(rootId)
}, { immediate: true })

watch(() => {
  const list = replies.value
  const last = list[list.length - 1]
  return `${list.length}|${last?.id ?? ''}`
}, async () => {
  await nextTick()
  if (pendingFocusedMessageId.value) {
    if (scrollMessageIntoView(pendingFocusedMessageId.value)) {
      pendingFocusedMessageId.value = ''
      clearScheduledTimers(focusScrollTimers)
      return
    }
  }
  if (pendingBottomScroll.value) {
    scrollToBottom()
    if (chat.activeThreadRootId === pendingBottomScrollRootId.value && replies.value.length > 0) {
      clearPendingBottomScroll()
    }
    return
  }
  if (!forceScrollToBottomOnNextRender.value) return
  scrollToBottom()
})

watch(() => replayVersion.value, async () => {
  await nextTick()
  if (pendingFocusedMessageId.value) {
    if (scrollMessageIntoView(pendingFocusedMessageId.value)) {
      pendingFocusedMessageId.value = ''
      clearScheduledTimers(focusScrollTimers)
    }
    return
  }
  if (!pendingBottomScroll.value) return
  if (!chat.activeThreadRootId || pendingBottomScrollRootId.value !== chat.activeThreadRootId) return
  if (replayVersion.value <= pendingBottomScrollReplayVersion.value) return
  scrollToBottom()
  clearPendingBottomScroll()
})

watch(() => chat.focusedThreadMessageId, (messageId) => {
  if (!messageId) {
    pendingFocusedMessageId.value = ''
    clearScheduledTimers(focusScrollTimers)
    return
  }
  scheduleFocusedMessageScroll(messageId)
})

onBeforeUnmount(() => {
  clearPendingBottomScroll()
  clearScheduledTimers(focusScrollTimers)
})
</script>
