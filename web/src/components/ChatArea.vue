<template>
  <div class="flex h-full min-h-0 bg-chat-bg">
    <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">

    <!-- Top bar -->
    <header class="flex items-center gap-3 px-4 py-3 border-b border-chat-border bg-chat-header shrink-0">
      <div class="flex items-center gap-1.5 font-bold text-white truncate">
        <span class="text-gray-400 font-normal text-lg">{{ conversationPrefix }}</span>
        {{ conversation?.title ?? '…' }}
      </div>
      <div v-if="conversation" class="h-5 w-px bg-chat-border mx-1 shrink-0" />
      <div class="ml-auto flex items-center gap-2 shrink-0">
        <div
          v-if="activeConversationCall"
          class="relative"
          data-testid="active-call-members-trigger"
          @mouseenter="openCallMembersPopover"
          @mouseleave="closeCallMembersPopover"
          @focusin="openCallMembersPopover"
          @focusout="handleCallMembersFocusOut"
        >
          <button
            class="p-1.5 rounded transition-colors flex items-center gap-1 text-sm"
            :class="activeConversationCall ? 'bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25' : 'hover:bg-white/10 text-gray-400 hover:text-white'"
            :disabled="!conversation"
            :aria-expanded="callMembersPopoverOpen"
            aria-haspopup="true"
            @click="handleCallClick"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.9.33 1.78.63 2.63a2 2 0 0 1-.45 2.11L8.1 9.91a16 16 0 0 0 6 6l1.45-1.19a2 2 0 0 1 2.11-.45c.85.3 1.73.51 2.63.63A2 2 0 0 1 22 16.92z"/>
            </svg>
            <span class="hidden sm:inline">Call active</span>
          </button>

          <div
            v-show="callMembersPopoverOpen"
            data-testid="call-members-popover"
            class="absolute right-0 top-full z-40 mt-2 w-80 overflow-hidden rounded-xl border border-chat-border bg-chat-header shadow-2xl ring-1 ring-black/20"
          >
            <div class="border-b border-chat-border px-4 py-3">
              <div class="text-sm font-semibold text-white">Call members</div>
            </div>

            <div v-if="remoteActiveCallMembersLoading" class="px-4 py-5 text-sm text-gray-400">
              Loading active members...
            </div>

            <div v-else-if="remoteActiveCallMembersError" class="px-4 py-5 text-sm text-red-300">
              {{ remoteActiveCallMembersError }}
            </div>

            <div v-else-if="activeCallMembers.length === 0" class="px-4 py-5 text-sm text-gray-400">
              No active members
            </div>

            <div v-else class="max-h-72 overflow-y-auto py-1">
              <div
                v-for="member in activeCallMembers"
                :key="member.userId"
                class="flex items-center gap-3 px-4 py-2.5"
              >
                <UserAvatar
                  :user-id="member.userId"
                  :display-name="member.displayName"
                  :avatar-url="member.avatarUrl"
                  :custom-status="member.customStatus"
                  size="sm"
                />
                <div class="min-w-0">
                  <div class="truncate text-sm text-white">{{ member.displayName }}</div>
                  <div v-if="member.isSelf" class="text-xs text-emerald-300">You</div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <button
          v-else
          class="p-1.5 rounded transition-colors flex items-center gap-1 text-sm"
          :class="activeConversationCall ? 'bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25' : 'hover:bg-white/10 text-gray-400 hover:text-white'"
          :disabled="!conversation"
          @click="handleCallClick"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.9.33 1.78.63 2.63a2 2 0 0 1-.45 2.11L8.1 9.91a16 16 0 0 0 6 6l1.45-1.19a2 2 0 0 1 2.11-.45c.85.3 1.73.51 2.63.63A2 2 0 0 1 22 16.92z"/>
          </svg>
          <span class="hidden sm:inline">Call</span>
        </button>
        <button
          data-testid="conversation-search-button"
          class="p-1.5 rounded hover:bg-white/10 text-gray-400 hover:text-white transition-colors disabled:opacity-50"
          :disabled="!conversation"
          title="Search conversation"
          aria-label="Search conversation"
          @click="emit('search-conversation')"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
        </button>
        <button
          class="p-1.5 rounded transition-colors flex items-center gap-1 text-sm"
          :class="isConversationPinned ? 'bg-cyan-500/15 text-cyan-200' : 'hover:bg-white/10 text-gray-400 hover:text-white'"
          :disabled="!conversation"
          title="Pin conversation"
          aria-label="Pin conversation"
          data-testid="pin-conversation-button"
          @click="pinActiveConversation"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path d="M12 17v5" />
            <path d="M7 4h10" />
            <path d="M9 4v5l-3 4h12l-3-4V4" />
          </svg>
          <span class="hidden sm:inline">Pin</span>
        </button>
        <button
          class="p-1.5 rounded transition-colors flex items-center gap-1 text-sm"
          :class="isMembersPanelOpen ? 'bg-white/15 text-white' : 'hover:bg-white/10 text-gray-400 hover:text-white'"
          :disabled="!conversation"
          @click="toggleMembersPanel"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>
          </svg>
          <span class="hidden sm:inline">Members</span>
        </button>
      </div>
    </header>
    <!-- Messages list -->
    <div class="relative flex-1 min-h-0">
      <div
        ref="scrollEl"
        class="h-full overflow-y-auto px-4 py-4 space-y-0.5"
        style="overflow-anchor: none; overscroll-behavior-y: contain;"
        @scroll.passive="handleScroll"
      >
        <template v-if="messages.length === 0">
          <div class="flex min-h-full flex-col items-center justify-center text-gray-500 gap-2">
            <svg class="w-10 h-10" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
              <path d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 0 1 2 2v8a2 2 0 01-2 2h-5l-5 5v-5z"/>
            </svg>
            <span class="text-sm">No messages yet. Start the conversation!</span>
            <span v-if="wsStore.state === 'BOOTSTRAPPING' || wsStore.state === 'RECOVERING_GAP' || wsStore.state === 'STALE_REBOOTSTRAP'" class="text-xs text-gray-600">
              {{ statusLabel }}
            </span>
          </div>
        </template>

        <VirtualMessageTimeline
          v-else
          ref="messageTimeline"
          :items="messages"
          :scroll-container="scrollEl"
          :keep-rendered-ids="timelinePinnedMessageIds"
        >
          <template #default="{ item: msg, index: idx }">
            <div
              :data-message-id="msg.id"
              :class="msg.id === chatStore.focusedMessageId ? 'rounded-md bg-amber-500/10 ring-1 ring-amber-300/40' : ''"
            >
              <MessageBubble
                :message="msg"
                :show-header="shouldShowHeader(idx)"
                :thread-reply-count="threadReplyCount(msg.id)"
                :is-active-thread="chatStore.activeThreadRootId === msg.id"
                :edit-request-token="editRequestTokenFor(msg.id)"
                @edit-open="handleInlineEditOpen"
                @edit-close="handleInlineEditClose"
                @edit-resize="handleInlineEditResize"
                @open-thread="openThreadFromMessage"
              />
            </div>
          </template>
        </VirtualMessageTimeline>
      </div>

      <div
        v-if="loadingOlderHistory"
        data-testid="history-loading-spinner"
        class="pointer-events-none absolute top-2 left-0 right-0 z-10 flex justify-center"
      >
        <div class="inline-flex items-center gap-2 rounded-full border border-chat-border bg-chat-header/90 px-2.5 py-1 text-[11px] text-gray-300 backdrop-blur">
          <svg class="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle class="opacity-25" cx="12" cy="12" r="9" stroke="currentColor" stroke-width="3" />
            <path class="opacity-90" d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
          </svg>
          <span>Loading history</span>
        </div>
      </div>

      <div
        v-if="showConversationLoadingOverlay"
        data-testid="conversation-loading-overlay"
        class="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-chat-bg/65 backdrop-blur-[1px]"
      >
        <div class="inline-flex items-center gap-2 rounded-full border border-chat-border bg-chat-header/90 px-3 py-1.5 text-xs text-gray-200">
          <svg class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle class="opacity-25" cx="12" cy="12" r="9" stroke="currentColor" stroke-width="3" />
            <path class="opacity-90" d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
          </svg>
          <span>Loading conversation...</span>
        </div>
      </div>

      <Transition name="scroll-btn">
        <button
          v-if="!isAtBottom"
          data-testid="scroll-to-bottom-btn"
          class="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 rounded-full border border-chat-border bg-chat-header/90 px-4 py-2.5 text-sm font-medium text-white shadow-xl backdrop-blur hover:bg-chat-header transition-colors"
          aria-label="Scroll to latest message"
          @click="handleScrollDownBtn"
        >
          <svg class="h-4 w-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/>
          </svg>
          <span
            v-if="unreadWhileScrolledAway > 0"
            class="rounded-full bg-accent px-2 py-1 text-xs font-semibold leading-none"
          >{{ unreadWhileScrolledAway }}</span>
        </button>
      </Transition>
    </div>

    <!-- Message input -->
    <MessageInput
      :channel-name="conversation?.title ?? 'conversation'"
      :conversation-id="chatStore.activeChannelId"
      :draft-scope="conversationDraftScope"
      :placeholder="composerPlaceholder"
      :encrypted="isEncryptedDMConversation"
      :disabled="!canComposeMessage"
      :typing-label="typingLabel"
      :online="wsStore.state !== 'DISCONNECTED' && wsStore.state !== 'CONNECTING'"
      :focus-token="chatStore.conversationComposerFocusToken"
      @send="handleSend"
      @typing="handleTyping"
      @edit-last-message="handleEditLastMessage"
      @resize="handleComposerResize"
    />
    </div>

    <!-- Threads now open in global pinned workspace, not legacy local drawer. -->

    <MembersPanel
      v-if="isMembersPanelOpen"
      :visibility="conversation?.visibility"
      @close="closeMembersPanel"
    />

    <div
      v-if="channelCallDialogOpen"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      @click.self="closeChannelCallDialog"
    >
      <div class="w-full max-w-md overflow-hidden rounded-xl border border-chat-border bg-chat-header shadow-2xl">
        <div class="border-b border-chat-border px-4 py-3">
          <div class="text-sm font-semibold text-white">Start team call</div>
          <div class="mt-1 text-xs text-gray-400">Select members to invite. You will be added automatically.</div>
        </div>

        <div v-if="channelCallError" class="border-b border-chat-border px-4 py-2 text-xs text-red-300">
          {{ channelCallError }}
        </div>

        <div class="border-b border-chat-border px-4 py-3">
          <input
            v-model="channelCallSearch"
            type="text"
            data-testid="channel-call-invite-search"
            placeholder="Search by nickname or email..."
            class="w-full rounded border border-chat-border bg-chat-input px-3 py-2 text-sm text-app-text placeholder-app-muted outline-none focus:border-accent"
            autofocus
          >
        </div>

        <div class="max-h-72 overflow-y-auto">
          <div v-if="channelCallLoading" class="px-4 py-6 text-center text-xs text-gray-400">
            Loading members...
          </div>
          <div v-else-if="channelCallMembers.length === 0" class="px-4 py-6 text-center text-xs text-gray-400">
            No other members available
          </div>
          <div v-else-if="filteredChannelCallMembers.length === 0" class="px-4 py-6 text-center text-xs text-gray-400">
            No members match your search.
          </div>
          <template v-else>
            <button
              v-for="member in filteredChannelCallMembers"
              :key="member.userId"
              :data-testid="`channel-call-invite-candidate-${member.userId}`"
              class="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-white/5"
              @click="toggleChannelCallInvitee(member.userId)"
            >
              <input
                type="checkbox"
                class="h-4 w-4"
                :checked="selectedChannelCallInvitees.includes(member.userId)"
                @click.stop
                @change="toggleChannelCallInvitee(member.userId)"
              >
              <UserAvatar
                :user-id="member.userId"
                :display-name="member.displayName || member.email"
                :avatar-url="member.avatarUrl"
                :custom-status="member.customStatus"
                size="sm"
              />
              <div class="min-w-0">
                <div class="truncate text-sm text-white">{{ member.displayName || member.email }}</div>
                <div class="truncate text-xs text-gray-400">{{ member.email }}</div>
              </div>
            </button>
          </template>
        </div>

        <div class="flex justify-end gap-2 border-t border-chat-border px-4 py-3">
          <button class="rounded px-3 py-1.5 text-xs text-gray-300 hover:bg-white/10" @click="closeChannelCallDialog">
            Cancel
          </button>
          <button
            class="rounded bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-50"
            :disabled="channelCallLoading || startingChannelCall"
            @click="startChannelCall"
          >
            Start call
          </button>
        </div>
      </div>
    </div>

    <BusyCallConfirmDialog
      :open="busyCallConfirmOpen"
      :user-names="busyCallConfirmNames"
      :confirm-label="busyCallConfirmLabel"
      @cancel="cancelBusyCallConfirm"
      @confirm="confirmBusyCallAction"
    />

  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import type { ChatDraftScope } from '@/services/storage/chatDraftStorage'
import { useChatStore, type Message } from '@/stores/chat'
import { pinnedDialogueId, usePinnedDialogsStore } from '@/stores/pinnedDialogs'
import { useAuthStore } from '@/stores/auth'
import { useWsStore } from '@/stores/ws'
import { useCallStore } from '@/stores/call'
import { generateId } from '@/services/id'
import { matchesCallInviteSearch, normalizeCallInviteSearchQuery } from '@/utils/callInviteSearch'
import MessageBubble from './MessageBubble.vue'
import MessageInput from './MessageInput.vue'
import MembersPanel from './MembersPanel.vue'
import UserAvatar from './UserAvatar.vue'
import BusyCallConfirmDialog from './BusyCallConfirmDialog.vue'
import VirtualMessageTimeline from './chat/VirtualMessageTimeline.vue'
import { OUTBOUND_PERSISTENCE_FAILURE_REASON, useOfflineQueue } from '@/composables/useOfflineQueue'
import { userCustomStatusFromProto, type UserCustomStatus } from '@/types/userStatus'
import { encryptDMMessage, ensureEncryptedDMDevice } from '@/services/e2ee/dmE2ee'

const emit = defineEmits<{
  'search-conversation': []
}>()

const chatStore = useChatStore()
const pinnedDialogsStore = usePinnedDialogsStore()
const authStore = useAuthStore()
const wsStore = useWsStore()
const callStore = useCallStore()
const offlineQueue = useOfflineQueue()
const scrollEl = ref<HTMLElement | null>(null)
interface VirtualMessageTimelineHandle {
  restoreAnchor: (messageId: string | number, offsetFromViewportTop: number) => boolean
  scrollToMessage: (messageId: string | number, options?: ScrollIntoViewOptions) => Promise<boolean>
}
const messageTimeline = ref<VirtualMessageTimelineHandle | null>(null)
const openRenderProbe = ref<{ conversationId: string; startedAt: number } | null>(null)
const loadingOlderHistory = ref(false)
const forceScrollToBottomOnNextRender = ref(false)
const composerBottomStickArmed = ref(false)
const activeInlineEditMessageId = ref('')
const inlineEditRequest = ref({ messageId: '', token: 0 })
const pendingSwitchAutoScrollConversationId = ref('')
let scheduledBottomStickFrame: number | null = null
let scheduledBottomStickToken = 0
const TOP_PRELOAD_THRESHOLD_PX = 120
const TOP_PRELOAD_REARM_GAP_PX = 72
const BOTTOM_STICK_THRESHOLD_PX = 72
const DEBUG_CHAT_COMPOSER_SCROLL = import.meta.env.DEV
const topPreloadArmed = ref(true)
const isAtBottom = ref(true)
const unreadWhileScrolledAway = ref(0)
let previousLastMessageId = ''

interface ScrollAnchor {
  messageId: string
  offsetFromViewportTop: number
}

interface ScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  distanceFromBottom: number
}

type BottomStickReason = 'conversation-open' | 'send' | 'composer-resize' | 'inline-edit'

const conversation = computed(() => chatStore.activeConversation)
const isEncryptedDMConversation = computed(() =>
  conversation.value?.kind === 'dm' && conversation.value.encryptionMode === 'dm_pairwise_signal_v1'
)
const conversationDraftScope = computed<ChatDraftScope | null>(() => {
  if (!chatStore.activeChannelId) return null
  if (isEncryptedDMConversation.value) return null
  return {
    kind: 'conversation',
    conversationId: chatStore.activeChannelId,
  }
})
const messages = computed(() => chatStore.activeMessages)
const timelinePinnedMessageIds = computed(() => [
  chatStore.focusedMessageId,
  activeInlineEditMessageId.value,
].filter((messageId): messageId is string => Boolean(messageId)))
const isMembersPanelOpen = ref(false)
function toggleMembersPanel() { isMembersPanelOpen.value = !isMembersPanelOpen.value }
function closeMembersPanel() { isMembersPanelOpen.value = false }
const conversationPrefix = computed(() => conversation.value?.kind === 'dm' ? '@' : '#')
const isConversationPinned = computed(() => {
  const conversationId = conversation.value?.id
  if (!conversationId) return false
  const kind = conversation.value?.kind === 'dm' ? 'dm' : 'channel'
  return pinnedDialogsStore.isPinned(pinnedDialogueId(kind, conversationId))
})
const canComposeMessage = computed(() => Boolean(conversation.value))
const composerPlaceholder = computed(() =>
  isEncryptedDMConversation.value ? 'Encrypted message' : undefined
)
watch(isEncryptedDMConversation, (encrypted) => {
  if (encrypted) void ensureEncryptedDMDevice().catch(() => {})
}, { immediate: true })
const activeConversationCall = computed(() => {
  const conversationId = conversation.value?.id
  if (!conversationId) return null
  return chatStore.activeCalls.find(call => call.conversationId === conversationId) ?? null
})
type ActiveCallMember = {
  userId: string
  displayName: string
  avatarUrl: string
  customStatus: UserCustomStatus | null
  isSelf: boolean
}
const callMembersPopoverOpen = ref(false)
const remoteActiveCallMembers = ref<ActiveCallMember[]>([])
const remoteActiveCallMembersLoading = ref(false)
const remoteActiveCallMembersError = ref('')
let remoteActiveCallMembersRequestSeq = 0
const hasLiveActiveCallRoom = computed(() =>
  Boolean(
    activeConversationCall.value
    && callStore.room
    && callStore.activeConversationId === activeConversationCall.value.conversationId,
  ),
)
const liveActiveCallMembers = computed<ActiveCallMember[]>(() => {
  void callStore.mediaVersion
  if (!activeConversationCall.value || !hasLiveActiveCallRoom.value) return []
  const currentRoom = callStore.room
  if (!currentRoom) return []

  const selfUserId = currentRoom.localParticipant.identity?.trim()
    || chatStore.workspace?.selfUserId
    || authStore.user?.id
    || ''
  const members = new Map<string, ActiveCallMember>()

  if (selfUserId) {
    members.set(selfUserId, {
      userId: selfUserId,
      displayName: chatStore.resolveDisplayName(selfUserId),
      avatarUrl: chatStore.resolveAvatarUrl(selfUserId),
      customStatus: chatStore.resolveUserCustomStatus(selfUserId),
      isSelf: true,
    })
  }

  for (const participant of currentRoom.remoteParticipants.values()) {
    const userId = participant.identity?.trim()
    if (!userId || members.has(userId)) continue
    members.set(userId, {
      userId,
      displayName: chatStore.resolveDisplayName(userId),
      avatarUrl: chatStore.resolveAvatarUrl(userId),
      customStatus: chatStore.resolveUserCustomStatus(userId),
      isSelf: false,
    })
  }

  return Array.from(members.values()).sort((a, b) => {
    if (a.isSelf && !b.isSelf) return -1
    if (!a.isSelf && b.isSelf) return 1
    return a.displayName.localeCompare(b.displayName) || a.userId.localeCompare(b.userId)
  })
})
const activeCallMembers = computed<ActiveCallMember[]>(() =>
  hasLiveActiveCallRoom.value ? liveActiveCallMembers.value : remoteActiveCallMembers.value
)
const typingLabel = computed(() => {
  const entries = chatStore.typingByConversationId[chatStore.activeChannelId] ?? []
  const visible = entries.filter(entry => entry.userId !== chatStore.workspace?.selfUserId)
  if (visible.length === 0) return ''
  if (visible.length === 1) {
    return `${chatStore.resolveDisplayName(visible[0].userId)} is typing...`
  }
  return `${visible.length} people are typing...`
})
const threadReplyCountsFromTimeline = computed<Record<string, number>>(() => {
  const counts: Record<string, number> = {}
  for (const msg of messages.value) {
    const rootId = msg.threadRootMessageId
    if (!rootId || rootId === msg.id) continue
    counts[rootId] = (counts[rootId] ?? 0) + 1
  }
  return counts
})
const channelCallDialogOpen = ref(false)
const channelCallLoading = ref(false)
const startingChannelCall = ref(false)
const channelCallError = ref('')
const channelCallSearch = ref('')
const channelCallMembers = ref<Array<{
  userId: string
  displayName: string
  email: string
  avatarUrl: string
  customStatus: UserCustomStatus | null
}>>([])
const selectedChannelCallInvitees = ref<string[]>([])
const busyCallConfirmOpen = ref(false)
const busyCallConfirmNames = ref<string[]>([])
const busyCallConfirmLabel = ref('Continue')
let busyCallPendingAction: (() => Promise<void> | void) | null = null
const filteredChannelCallMembers = computed(() => {
  const query = normalizeCallInviteSearchQuery(channelCallSearch.value)
  if (!query) return channelCallMembers.value
  return channelCallMembers.value.filter(member => matchesCallInviteSearch(member, query))
})
const statusLabel = computed(() => {
  switch (wsStore.state) {
    case 'BOOTSTRAPPING':
      return 'Loading conversations...'
    case 'RECOVERING_GAP':
      return 'Recovering missed events...'
    case 'STALE_REBOOTSTRAP':
      return 'Refreshing snapshot...'
    default:
      return ''
  }
})
const showConversationLoadingOverlay = computed(() =>
  chatStore.isConversationInitialLoading(chatStore.activeChannelId)
)
let typingIdleTimer: ReturnType<typeof setTimeout> | null = null
let typingConversationId = ''
let typingIsActive = false
let typingLastSentAtMs = 0

function clearTypingIdleTimer() {
  if (typingIdleTimer) {
    clearTimeout(typingIdleTimer)
    typingIdleTimer = null
  }
}

function stopTypingPresence(sendStop: boolean) {
  clearTypingIdleTimer()
  if (sendStop && typingIsActive && typingConversationId && wsStore.state === 'LIVE_SYNCED') {
    wsStore.sendTyping(typingConversationId, false)
  }
  typingIsActive = false
  typingConversationId = ''
  typingLastSentAtMs = 0
}

function scheduleTypingIdleStop() {
  clearTypingIdleTimer()
  typingIdleTimer = setTimeout(() => {
    typingIdleTimer = null
    if (!typingIsActive || !typingConversationId || wsStore.state !== 'LIVE_SYNCED') return
    wsStore.sendTyping(typingConversationId, false)
    typingIsActive = false
    typingConversationId = ''
    typingLastSentAtMs = 0
  }, 1000)
}

function openCallMembersPopover() {
  if (!activeConversationCall.value) return
  callMembersPopoverOpen.value = true
}

function closeCallMembersPopover() {
  callMembersPopoverOpen.value = false
}

function handleCallMembersFocusOut(event: FocusEvent) {
  const nextTarget = event.relatedTarget as Node | null
  if (nextTarget && (event.currentTarget as HTMLElement | null)?.contains(nextTarget)) return
  closeCallMembersPopover()
}

function resetRemoteActiveCallMembers() {
  remoteActiveCallMembers.value = []
  remoteActiveCallMembersLoading.value = false
  remoteActiveCallMembersError.value = ''
}

async function refreshActiveCallMembers() {
  const currentConversationId = conversation.value?.id ?? ''
  if (!currentConversationId || !activeConversationCall.value) {
    resetRemoteActiveCallMembers()
    return
  }
  if (hasLiveActiveCallRoom.value) {
    remoteActiveCallMembersError.value = ''
    remoteActiveCallMembersLoading.value = false
    return
  }

  const requestSeq = ++remoteActiveCallMembersRequestSeq
  remoteActiveCallMembersLoading.value = true
  remoteActiveCallMembersError.value = ''
  try {
    const response = await wsStore.requestActiveCallMembers(currentConversationId)
    if (requestSeq !== remoteActiveCallMembersRequestSeq || conversation.value?.id !== currentConversationId) return
    remoteActiveCallMembers.value = response.members.map(member => ({
      userId: member.userId,
      displayName: member.displayName || member.email,
      avatarUrl: member.avatarUrl,
      customStatus: userCustomStatusFromProto(member.customStatus),
      isSelf: member.userId === (authStore.user?.id ?? chatStore.workspace?.selfUserId ?? ''),
    }))
  } catch (err) {
    if (requestSeq !== remoteActiveCallMembersRequestSeq || conversation.value?.id !== currentConversationId) return
    remoteActiveCallMembers.value = []
    remoteActiveCallMembersError.value = err instanceof Error ? err.message : 'Failed to load active members'
  } finally {
    if (requestSeq === remoteActiveCallMembersRequestSeq && conversation.value?.id === currentConversationId) {
      remoteActiveCallMembersLoading.value = false
    }
  }
}

function chatComposerScrollDebug(event: string, payload: Record<string, unknown>) {
  if (!DEBUG_CHAT_COMPOSER_SCROLL) return
  console.debug(`[debug][chat-composer-scroll] ${event}`, payload)
}

function getScrollMetrics(el: HTMLElement): ScrollMetrics {
  return {
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    distanceFromBottom: el.scrollHeight - (el.scrollTop + el.clientHeight),
  }
}

function hasPendingSwitchAutoScroll(conversationId: string = chatStore.activeChannelId): boolean {
  return conversationId !== '' && pendingSwitchAutoScrollConversationId.value === conversationId
}

function clearForceBottomFlag() {
  forceScrollToBottomOnNextRender.value = false
}

function cancelScheduledBottomStick() {
  scheduledBottomStickToken += 1
  if (scheduledBottomStickFrame !== null) {
    cancelAnimationFrame(scheduledBottomStickFrame)
    scheduledBottomStickFrame = null
  }
}

function clearPendingConversationOpenScroll(reason: string, conversationId = pendingSwitchAutoScrollConversationId.value) {
  if (!pendingSwitchAutoScrollConversationId.value) return
  if (conversationId && pendingSwitchAutoScrollConversationId.value !== conversationId) return
  chatComposerScrollDebug('conversation-open-scroll-clear', {
    reason,
    conversationId: pendingSwitchAutoScrollConversationId.value,
  })
  pendingSwitchAutoScrollConversationId.value = ''
}

function scheduleStableBottomStick(reason: BottomStickReason, options: { persistForce?: boolean } = {}) {
  const el = scrollEl.value
  if (!el) return
  const persistForce = options.persistForce === true
  forceScrollToBottomOnNextRender.value = true
  cancelScheduledBottomStick()

  const token = scheduledBottomStickToken
  scrollToBottom()
  void nextTick(() => {
    if (token !== scheduledBottomStickToken) return
    scheduledBottomStickFrame = requestAnimationFrame(() => {
      scheduledBottomStickFrame = null
      if (token !== scheduledBottomStickToken) return
      scrollToBottom()
      if (!persistForce) {
        clearForceBottomFlag()
      }
      chatComposerScrollDebug('bottom-stick-stable', {
        reason,
        conversationId: chatStore.activeChannelId,
        metrics: scrollEl.value ? getScrollMetrics(scrollEl.value) : null,
      })
    })
  })
}

function shouldShowHeader(idx: number): boolean {
  if (idx === 0) return true
  const prev = messages.value[idx - 1]
  const curr = messages.value[idx]
  if (prev.senderId !== curr.senderId) return true
  const prevTime = new Date(prev.createdAt).getTime()
  const currTime = new Date(curr.createdAt).getTime()
  return currTime - prevTime > 5 * 60 * 1000
}

function threadReplyCount(rootMessageId: string): number {
  const summaryCount = chatStore.threadSummaries[rootMessageId]?.replyCount ?? 0
  const timelineCount = threadReplyCountsFromTimeline.value[rootMessageId] ?? 0
  return Math.max(summaryCount, timelineCount)
}

function canInlineEditMessage(message: Message): boolean {
  const selfUserId = authStore.user?.id || chatStore.workspace?.selfUserId || ''
  return Boolean(selfUserId)
    && message.senderId === selfUserId
    && !message.sendStatus
    && !message.pending
    && message.contentMode !== 'dm_pairwise_signal_v1'
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
  const target = [...messages.value].reverse().find(canInlineEditMessage)
  if (!target) return
  requestInlineEdit(target.id)
}

function openThreadFromMessage(message: Message) {
  if (message.contentMode === 'dm_pairwise_signal_v1') return
  // Keep main conversation visible. Thread opens only in global pinned workspace.
  pinnedDialogsStore.ensureThreadPinned(message.channelId, message.id)
}

function pinActiveConversation() {
  const conversationId = conversation.value?.id
  if (!conversationId) return
  const kind = conversation.value?.kind === 'dm' ? 'dm' : 'channel'
  const pinId = pinnedDialogueId(kind, conversationId)
  if (pinnedDialogsStore.isPinned(pinId)) {
    pinnedDialogsStore.unpin(pinId)
    return
  }
  pinnedDialogsStore.ensureConversationPinned(conversationId)
}

type OutboundMessageAttachment = {
  id: string
  fileName: string
  fileSize: number
  mimeType: string
  thumbnailMimeType?: string
  thumbnailFileSize?: number
  thumbnailVersion?: number
}

async function handleSend(
  body: string | { body: string; entities: NonNullable<Message['entities']>; attachmentIds: string[]; attachments: OutboundMessageAttachment[] },
) {
  const payload = typeof body === 'string'
    ? { body, entities: [] as NonNullable<Message['entities']>, attachmentIds: [], attachments: [] as OutboundMessageAttachment[] }
    : body
  const messageBody = payload.body
  const channelId = chatStore.activeChannelId
  const user = authStore.user
  const senderId = user?.id ?? chatStore.workspace?.selfUserId ?? ''
  const senderName = (
    (user?.displayName?.trim() || '')
    || (chatStore.workspace?.selfDisplayName?.trim() || '')
    || (user?.email?.trim() || '')
    || senderId.slice(0, 8)
  )
  const senderAvatarUrl = (
    (user?.avatarUrl?.trim() || '')
    || (chatStore.workspace?.selfAvatarUrl?.trim() || '')
    || (chatStore.resolveAvatarUrl(senderId).trim() || '')
  )
  if (!channelId || !senderId) return

  if (!messageBody.trim() && payload.attachmentIds.length === 0) return
  if ((wsStore.state === 'DISCONNECTED' || wsStore.state === 'CONNECTING') && payload.attachmentIds.length > 0) {
    return
  }

  const clientMsgId = generateId()
  let encrypted: Awaited<ReturnType<typeof encryptDMMessage>> | undefined
  if (isEncryptedDMConversation.value) {
    if (payload.attachmentIds.length > 0 || payload.entities.length > 0) return
    if (wsStore.state !== 'LIVE_SYNCED') return
    try {
      encrypted = await encryptDMMessage(channelId, clientMsgId, messageBody)
    } catch (err) {
      console.error('[e2ee] failed to encrypt direct message', err)
      return
    }
  }
  const now = new Date().toISOString()
  const isOffline = wsStore.state !== 'LIVE_SYNCED'
  scheduleStableBottomStick('send')

  // Optimistic message — shown immediately regardless of connection state
  const optimisticMessage: Message = {
    id: clientMsgId,
    channelId,
    senderId,
    senderName,
    senderAvatarUrl: senderAvatarUrl || undefined,
    body: messageBody,
    entities: payload.entities,
    channelSeq: 0n,
    threadSeq: 0n,
    mentionedUserIds: payload.entities.filter(entity => entity.kind === 'user').map(entity => entity.targetId),
    mentionEveryone: false,
    createdAt: now,
    reactions: [],
    myReactions: [],
    contentMode: encrypted ? 'dm_pairwise_signal_v1' : 'plaintext',
    senderDeviceId: encrypted?.senderDeviceId,
    attachments: payload.attachments.map(att => ({
      id: att.id,
      fileName: att.fileName,
      fileSize: att.fileSize,
      mimeType: att.mimeType,
      thumbnailMimeType: att.thumbnailMimeType,
      thumbnailFileSize: att.thumbnailFileSize,
      thumbnailVersion: att.thumbnailVersion,
    })),
    clientMsgId,
    sendStatus: isOffline ? 'queued' : 'sending',
  }
  chatStore.addOptimisticMessage(optimisticMessage)

  // Plaintext sends are persisted before their first write, not only after a
  // disconnect. The record is removed when its correlated ACK arrives.
  if (!encrypted) {
    const persisted = await offlineQueue.enqueue({
      conversationId: channelId,
      body: messageBody,
      entities: payload.entities,
      clientMsgId,
      attachmentIds: payload.attachmentIds,
      attachments: payload.attachments.map(attachment => ({ ...attachment })),
    })
    if (!persisted) {
      chatStore.updateSendStatus(channelId, clientMsgId, 'failed', OUTBOUND_PERSISTENCE_FAILURE_REASON)
      return
    }
  }

  if (wsStore.state !== 'LIVE_SYNCED') {
    if (encrypted) {
      chatStore.updateSendStatus(channelId, clientMsgId, 'failed', 'Connection lost')
    } else {
      chatStore.updateSendStatus(channelId, clientMsgId, 'queued')
    }
    return
  }

  if (!encrypted) {
    // A concurrent queue flush can win the race after the durable commit.
    // Exactly one path may write this client message ID for the live session.
    if (!offlineQueue.claimInFlight(clientMsgId)) return
    chatStore.updateSendStatus(channelId, clientMsgId, 'sending')
  }

  const sent = encrypted
    ? wsStore.sendMessage(channelId, '', clientMsgId, undefined, [], [], {
        senderDeviceId: encrypted.senderDeviceId,
        recipients: encrypted.envelopes,
      })
    : payload.entities.length > 0
    ? wsStore.sendMessage(channelId, messageBody, clientMsgId, undefined, payload.attachmentIds, payload.entities)
    : wsStore.sendMessage(channelId, messageBody, clientMsgId, undefined, payload.attachmentIds)
  if (!sent) {
    if (!encrypted) offlineQueue.releaseInFlight(clientMsgId)
    chatStore.requeueInFlightPlaintextMessages()
    wsStore.invalidateTransport('Message could not be sent')
  } else {
    chatStore.startSendTimeout(channelId, clientMsgId, false)
  }
}

async function flushPendingSwitchAutoScroll(trigger: string) {
  const targetConversationId = pendingSwitchAutoScrollConversationId.value
  if (!targetConversationId) return
  if (targetConversationId !== chatStore.activeChannelId) return
  if (chatStore.isConversationInitialLoading(targetConversationId)) return

  scheduleStableBottomStick('conversation-open', { persistForce: true })
  await nextTick()
  await new Promise(resolve => requestAnimationFrame(() => resolve(null)))
  if (targetConversationId !== chatStore.activeChannelId) return

  const current = scrollEl.value
  if (!current) return
  const metrics = getScrollMetrics(current)
  chatComposerScrollDebug('switch-auto-scroll-flush', {
    trigger,
    conversationId: targetConversationId,
    metrics,
  })

  clearPendingConversationOpenScroll('stable-frame', targetConversationId)
  clearForceBottomFlag()
}

// When ChatArea remounts (e.g. returning from task-tracker mode), the active
// channel hasn't changed so the channel-switch watcher won't fire. Scroll to
// the bottom explicitly so the user lands at the latest message.
onMounted(() => {
  const activeConversationId = chatStore.activeChannelId
  if (activeConversationId) {
    pendingSwitchAutoScrollConversationId.value = activeConversationId
  }
  void flushPendingSwitchAutoScroll('mounted')
})

function handleTyping(active: boolean) {
  const channelId = chatStore.activeChannelId
  if (!channelId || wsStore.state !== 'LIVE_SYNCED') return
  if (!active) {
    stopTypingPresence(typingConversationId === channelId)
    return
  }

  if (typingConversationId !== channelId) {
    if (typingConversationId) {
      stopTypingPresence(true)
    }
    typingConversationId = channelId
    typingIsActive = true
    typingLastSentAtMs = performance.now()
    wsStore.sendTyping(channelId, true)
    scheduleTypingIdleStop()
    return
  }

  typingIsActive = true
  scheduleTypingIdleStop()
  const now = performance.now()
  if (now - typingLastSentAtMs >= 1000) {
    typingLastSentAtMs = now
    wsStore.sendTyping(channelId, true)
  }
}

function userIsBusyInAnotherCall(userId: string): boolean {
  return (chatStore.userCallPresenceByUserId[userId] ?? 0) > 0
}

function requestBusyCallConfirm(userNames: string[], confirmLabel: string, action: () => Promise<void> | void) {
  busyCallConfirmNames.value = userNames
  busyCallConfirmLabel.value = confirmLabel
  busyCallPendingAction = action
  busyCallConfirmOpen.value = true
}

function cancelBusyCallConfirm() {
  busyCallConfirmOpen.value = false
  busyCallConfirmNames.value = []
  busyCallConfirmLabel.value = 'Continue'
  busyCallPendingAction = null
}

async function confirmBusyCallAction() {
  const action = busyCallPendingAction
  busyCallConfirmOpen.value = false
  busyCallConfirmNames.value = []
  busyCallConfirmLabel.value = 'Continue'
  busyCallPendingAction = null
  await action?.()
}

async function startDmCall(conversationId: string) {
  try {
    await callStore.startOrJoinCall({
      conversationId,
      kind: 'dm',
      visibility: 'dm',
    })
  } catch {
    // store surface handles call errors.
  }
}

async function joinChannelCall(conversationId: string, visibility: 'public' | 'private' | 'dm') {
  try {
    await callStore.startOrJoinCall({
      conversationId,
      kind: 'channel',
      visibility,
    })
  } catch {
    // store surface handles call errors.
  }
}

async function handleCallClick() {
  if (!conversation.value) return
  if (
    activeConversationCall.value
    && callStore.activeConversationId === conversation.value.id
    && (callStore.connected || callStore.connecting)
  ) {
    return
  }
  if (conversation.value.kind === 'dm') {
    const dm = chatStore.directMessages.find(item => item.id === conversation.value?.id)
    const conversationId = conversation.value.id
    if (dm && userIsBusyInAnotherCall(dm.userId)) {
      requestBusyCallConfirm([dm.displayName || chatStore.resolveDisplayName(dm.userId)], 'Call anyway', () => startDmCall(conversationId))
      return
    }
    await startDmCall(conversationId)
    return
  }
  if (activeConversationCall.value) {
    await joinChannelCall(conversation.value.id, conversation.value.visibility)
    return
  }
  await openChannelCallDialog()
}

async function openChannelCallDialog() {
  if (!conversation.value) return
  channelCallDialogOpen.value = true
  channelCallLoading.value = true
  channelCallError.value = ''
  channelCallSearch.value = ''
  selectedChannelCallInvitees.value = []
  try {
    const response = await wsStore.requestConversationMembers(conversation.value.id)
    const selfUserId = authStore.user?.id ?? chatStore.workspace?.selfUserId ?? ''
    channelCallMembers.value = response.members
      .filter(member => member.userId !== selfUserId)
      .map(member => ({
        userId: member.userId,
        displayName: member.displayName,
        email: member.email,
        avatarUrl: member.avatarUrl,
        customStatus: userCustomStatusFromProto(member.customStatus),
      }))
  } catch (err) {
    channelCallError.value = err instanceof Error ? err.message : 'Failed to load members'
    channelCallMembers.value = []
  } finally {
    channelCallLoading.value = false
  }
}

function closeChannelCallDialog() {
  channelCallDialogOpen.value = false
  channelCallError.value = ''
  channelCallSearch.value = ''
}

function toggleChannelCallInvitee(userId: string) {
  if (selectedChannelCallInvitees.value.includes(userId)) {
    selectedChannelCallInvitees.value = selectedChannelCallInvitees.value.filter(id => id !== userId)
    return
  }
  selectedChannelCallInvitees.value = [...selectedChannelCallInvitees.value, userId]
}

function busyChannelInviteNames(inviteeIds: string[]): string[] {
  const byId = new Map(channelCallMembers.value.map(member => [member.userId, member]))
  return inviteeIds
    .filter(userIsBusyInAnotherCall)
    .map(userId => {
      const member = byId.get(userId)
      return member?.displayName || member?.email || chatStore.resolveDisplayName(userId)
    })
}

async function startChannelCallConfirmed(inviteeUserIds: string[]) {
  if (!conversation.value) return
  startingChannelCall.value = true
  channelCallError.value = ''
  try {
    await callStore.startOrJoinCall({
      conversationId: conversation.value.id,
      kind: 'channel',
      visibility: conversation.value.visibility,
      inviteeUserIds,
    })
    closeChannelCallDialog()
  } catch (err) {
    channelCallError.value = err instanceof Error ? err.message : 'Failed to start call'
  } finally {
    startingChannelCall.value = false
  }
}

async function startChannelCall() {
  const inviteeUserIds = [...selectedChannelCallInvitees.value]
  const busyNames = busyChannelInviteNames(inviteeUserIds)
  if (busyNames.length > 0) {
    requestBusyCallConfirm(busyNames, 'Start call', () => startChannelCallConfirmed(inviteeUserIds))
    return
  }
  await startChannelCallConfirmed(inviteeUserIds)
}

function scrollToBottom() {
  const el = scrollEl.value
  if (!el) return
  el.scrollTop = el.scrollHeight
}

function isLastTimelineMessage(messageId: string): boolean {
  if (!messageId) return false
  const lastMessage = messages.value[messages.value.length - 1]
  return lastMessage?.id === messageId
}

function stickToBottomAfterComposerResize() {
  scheduleStableBottomStick('composer-resize')
}

function keepTailInlineEditVisible() {
  composerBottomStickArmed.value = true
  scheduleStableBottomStick('inline-edit')
}

function handleInlineEditOpen(messageId: string) {
  activeInlineEditMessageId.value = messageId
  if (!isLastTimelineMessage(messageId)) return
  void nextTick(() => {
    if (activeInlineEditMessageId.value !== messageId) return
    if (!isLastTimelineMessage(messageId)) return
    keepTailInlineEditVisible()
  })
}

function handleInlineEditClose(messageId: string) {
  if (activeInlineEditMessageId.value === messageId) {
    activeInlineEditMessageId.value = ''
  }
  if (inlineEditRequest.value.messageId === messageId) {
    inlineEditRequest.value = { messageId: '', token: inlineEditRequest.value.token }
  }
  composerBottomStickArmed.value = isNearBottom()
}

function handleInlineEditResize(messageId: string, deltaPx: number) {
  if (deltaPx === 0) return
  activeInlineEditMessageId.value = messageId
  if (!isLastTimelineMessage(messageId)) return
  keepTailInlineEditVisible()
}

function handleComposerResize(deltaPx: number) {
  const el = scrollEl.value
  if (!el || deltaPx === 0) return
  const before = getScrollMetrics(el)
  const nearBottomNow = before.distanceFromBottom <= BOTTOM_STICK_THRESHOLD_PX
  const estimatedDistanceBeforeResize = before.distanceFromBottom - deltaPx
  const nearBottomBeforeResize = estimatedDistanceBeforeResize <= BOTTOM_STICK_THRESHOLD_PX
  const shouldStickToBottom = composerBottomStickArmed.value
    || nearBottomBeforeResize
    || nearBottomNow
    || forceScrollToBottomOnNextRender.value
  chatComposerScrollDebug('before-resize-handler', {
    conversationId: chatStore.activeChannelId,
    deltaPx,
    nearBottomNow,
    nearBottomBeforeResize,
    composerBottomStickArmed: composerBottomStickArmed.value,
    shouldStickToBottom,
    forceScrollToBottomOnNextRender: forceScrollToBottomOnNextRender.value,
    metrics: before,
  })
  if (shouldStickToBottom) {
    composerBottomStickArmed.value = true
    stickToBottomAfterComposerResize()
  }
  const after = getScrollMetrics(el)
  chatComposerScrollDebug('after-resize-handler', {
    conversationId: chatStore.activeChannelId,
    deltaPx,
    composerBottomStickArmed: composerBottomStickArmed.value,
    metrics: after,
  })
}

function isNearBottom(thresholdPx = BOTTOM_STICK_THRESHOLD_PX): boolean {
  const el = scrollEl.value
  if (!el) return true
  return el.scrollHeight - (el.scrollTop + el.clientHeight) <= thresholdPx
}

async function preloadOlderHistory() {
  const conversationId = chatStore.activeChannelId
  const el = scrollEl.value
  if (!conversationId || !el || loadingOlderHistory.value) return
  if (hasPendingSwitchAutoScroll(conversationId) && showConversationLoadingOverlay.value) return
  if (el.scrollTop > TOP_PRELOAD_THRESHOLD_PX) return

  cancelScheduledBottomStick()
  clearForceBottomFlag()
  clearPendingConversationOpenScroll('older-history-prepend')
  loadingOlderHistory.value = true
  const anchor = captureTopVisibleAnchor(el)
  const previousHeight = el.scrollHeight
  const previousTop = el.scrollTop
  try {
    const loadedCount = await chatStore.loadOlderConversationHistory(conversationId)
    if (loadedCount <= 0) return
    await nextTick()
    const current = scrollEl.value
    if (!current) return
    if (!restoreAnchorPosition(current, anchor)) {
      current.scrollTop = previousTop + (current.scrollHeight - previousHeight)
    }
  } finally {
    loadingOlderHistory.value = false
  }
}

function handleScrollDownBtn() {
  scrollToBottom()
  unreadWhileScrolledAway.value = 0
}

function handleScroll() {
  const el = scrollEl.value
  if (!el) return
  const nearBottom = isNearBottom()
  composerBottomStickArmed.value = nearBottom
  isAtBottom.value = nearBottom
  if (nearBottom) {
    unreadWhileScrolledAway.value = 0
  }
  if (hasPendingSwitchAutoScroll() && !nearBottom) {
    cancelScheduledBottomStick()
    clearForceBottomFlag()
    clearPendingConversationOpenScroll('user-scrolled-away')
  }
  if (el.scrollTop > TOP_PRELOAD_THRESHOLD_PX + TOP_PRELOAD_REARM_GAP_PX) {
    topPreloadArmed.value = true
  }
  if (loadingOlderHistory.value || !topPreloadArmed.value) return
  if (hasPendingSwitchAutoScroll() && showConversationLoadingOverlay.value) return
  if (el.scrollTop <= TOP_PRELOAD_THRESHOLD_PX) {
    topPreloadArmed.value = false
    void preloadOlderHistory()
  }
}

function captureTopVisibleAnchor(container: HTMLElement): ScrollAnchor | null {
  const containerRect = container.getBoundingClientRect()
  const rows = container.querySelectorAll<HTMLElement>('[data-message-id]')
  for (const row of rows) {
    const messageId = row.dataset.messageId?.trim()
    if (!messageId) continue
    const rowRect = row.getBoundingClientRect()
    if (rowRect.bottom >= containerRect.top) {
      return {
        messageId,
        offsetFromViewportTop: rowRect.top - containerRect.top,
      }
    }
  }
  return null
}

function messageIdSelector(messageId: string): string {
  const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(messageId)
    : messageId.replace(/["\\]/g, '\\$&')
  return `[data-message-id="${escaped}"]`
}

function restoreAnchorPosition(container: HTMLElement, anchor: ScrollAnchor | null): boolean {
  if (!anchor) return false
  const target = container.querySelector<HTMLElement>(messageIdSelector(anchor.messageId))
  if (target) {
    const containerRect = container.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    const delta = (targetRect.top - containerRect.top) - anchor.offsetFromViewportTop
    if (Math.abs(delta) < 0.5) return true
    container.scrollTop += delta
    return true
  }

  if (!messageTimeline.value?.restoreAnchor(anchor.messageId, anchor.offsetFromViewportTop)) return false
  return true
}

async function scrollMessageIntoView(messageId: string) {
  if (!messageId) return
  const container = scrollEl.value
  if (!container) return
  if (await messageTimeline.value?.scrollToMessage(messageId, { block: 'center' })) {
    cancelScheduledBottomStick()
    clearForceBottomFlag()
    clearPendingConversationOpenScroll('focused-message')
    return
  }
  const target = container.querySelector<HTMLElement>(messageIdSelector(messageId))
  if (!target) return
  cancelScheduledBottomStick()
  clearForceBottomFlag()
  clearPendingConversationOpenScroll('focused-message')
  target.scrollIntoView({ block: 'center' })
}

watch(() => {
  const list = messages.value
  const last = list[list.length - 1]
  return `${chatStore.activeChannelId}|${list.length}|${last?.id ?? ''}`
}, async () => {
  const shouldStick = isNearBottom()
  const list = messages.value
  const lastId = list[list.length - 1]?.id ?? ''
  if (!shouldStick && !forceScrollToBottomOnNextRender.value && lastId && lastId !== previousLastMessageId) {
    unreadWhileScrolledAway.value += 1
  }
  previousLastMessageId = lastId
  await nextTick()
  if ((shouldStick || forceScrollToBottomOnNextRender.value) && !loadingOlderHistory.value) {
    scrollToBottom()
  }
  const probe = openRenderProbe.value
  if (DEBUG_CHAT_COMPOSER_SCROLL && probe && probe.conversationId === chatStore.activeChannelId) {
    openRenderProbe.value = null
    requestAnimationFrame(() => {
      const elapsedMs = Math.round((performance.now() - probe.startedAt) * 100) / 100
      console.debug('[perf][conversation-open] render:messages-updated', {
        conversationId: probe.conversationId,
        messageCount: messages.value.length,
        elapsedMs,
      })
    })
  }
  void flushPendingSwitchAutoScroll('messages-watch')
})

watch(() => chatStore.activeChannelId, async (conversationId) => {
  const startedAt = DEBUG_CHAT_COMPOSER_SCROLL ? performance.now() : 0
  cancelScheduledBottomStick()
  clearForceBottomFlag()
  openRenderProbe.value = DEBUG_CHAT_COMPOSER_SCROLL ? { conversationId, startedAt } : null
  activeInlineEditMessageId.value = ''
  inlineEditRequest.value = { messageId: '', token: inlineEditRequest.value.token }
  composerBottomStickArmed.value = true
  isAtBottom.value = true
  unreadWhileScrolledAway.value = 0
  previousLastMessageId = ''
  pendingSwitchAutoScrollConversationId.value = conversationId
  topPreloadArmed.value = true
  remoteActiveCallMembersRequestSeq += 1
  resetRemoteActiveCallMembers()
  closeCallMembersPopover()
  if (typingConversationId && typingConversationId !== conversationId) {
    stopTypingPresence(true)
  }
  if (DEBUG_CHAT_COMPOSER_SCROLL) {
    console.debug('[perf][conversation-open] render:active-channel-changed', {
      conversationId,
      at: new Date().toISOString(),
      currentMessageCount: messages.value.length,
    })
  }
  await nextTick()
  if (DEBUG_CHAT_COMPOSER_SCROLL) {
    requestAnimationFrame(() => {
      const elapsedMs = Math.round((performance.now() - startedAt) * 100) / 100
      console.debug('[perf][conversation-open] render:first-frame', {
        conversationId,
        messageCount: messages.value.length,
        elapsedMs,
      })
    })
  }
  void flushPendingSwitchAutoScroll('active-channel-watch')
})

watch(() => showConversationLoadingOverlay.value, (loading) => {
  if (!loading) {
    void flushPendingSwitchAutoScroll('loading-overlay-watch')
  }
})

watch(() => [chatStore.focusedMessageId, chatStore.activeChannelId], async ([messageId]) => {
  if (!messageId) return
  await nextTick()
  await scrollMessageIntoView(messageId)
})

watch(() => [
  callMembersPopoverOpen.value,
  conversation.value?.id ?? '',
  activeConversationCall.value?.id ?? '',
  activeConversationCall.value?.participantCount ?? 0,
  hasLiveActiveCallRoom.value,
], ([isOpen, conversationId, activeCallId]) => {
  if (!isOpen) return
  if (!conversationId || !activeCallId) {
    resetRemoteActiveCallMembers()
    return
  }
  void refreshActiveCallMembers()
})

watch(() => wsStore.state, (state) => {
  if (state !== 'LIVE_SYNCED') {
    stopTypingPresence(false)
  }
})

onBeforeUnmount(() => {
  clearForceBottomFlag()
  cancelScheduledBottomStick()
  stopTypingPresence(true)
})
</script>

<style scoped>
.scroll-btn-enter-active,
.scroll-btn-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.scroll-btn-enter-from,
.scroll-btn-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(8px);
}
</style>
