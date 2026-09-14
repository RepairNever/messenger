<template>
  <template v-if="pinned.hasItems">
    <ResizableSidebar
      v-if="activeItem"
      storage-key="msgnr:sidebar-width:pinned:v1"
      :default-width="360"
      :min-width="0"
      :max-width="1400"
      handle-side="left"
      resize-title="Resize pinned panel"
    >
      <!-- Product decision: header close hides active workspace but keeps pin in strip. -->
      <aside class="flex h-full min-h-0 w-full flex-col border-l border-chat-border bg-chat-header">
        <header class="flex items-center gap-3 border-b border-chat-border px-4 py-3">
          <div class="min-w-0 flex-1">
            <div class="truncate text-sm font-semibold text-white">
              {{ headerTitle }}
            </div>
          </div>
          <button
            class="flex h-7 w-7 items-center justify-center rounded text-gray-400 transition-colors hover:bg-white/10 hover:text-white"
            aria-label="Close pinned panel"
            @click="pinned.deactivate()"
          >
            <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
          </button>
        </header>

        <ConversationWorkspace
          v-if="activeItem.kind === 'dm' || activeItem.kind === 'channel'"
          :conversation-id="activeItem.conversationId"
          @open-thread="openPinnedThread"
        />
        <ThreadWorkspace
          v-else-if="activeItem.threadRootMessageId"
          :conversation-id="activeItem.conversationId"
          :root-message-id="activeItem.threadRootMessageId"
          mode="pinned"
        />
      </aside>
    </ResizableSidebar>

    <aside class="flex h-full min-h-0 w-[45px] shrink-0 flex-col overflow-y-auto overflow-x-hidden border-l border-chat-border bg-sidebar-bg/90 px-0.5 py-1">
      <div
        v-for="item in pinned.items"
        :key="item.id"
        tabindex="0"
        role="button"
        class="group relative mb-1 flex min-h-[124px] w-full flex-col items-center justify-between rounded-lg border px-0.5 py-1 transition-all"
        :class="cardClass(item)"
        :aria-label="`Open pinned ${item.kind}: ${item.title}`"
        :data-testid="`pinned-card-${item.id}`"
        @click="pinned.activate(item.id)"
        @keydown.enter.prevent="pinned.activate(item.id)"
        @keydown.space.prevent="pinned.activate(item.id)"
      >
        <div class="flex h-8 w-8 items-center justify-center rounded-md ring-1" :class="pinned.itemTypeMeta(item.kind).iconAccentClass">
          <UserAvatar
            v-if="item.kind === 'dm' && item.userId"
            :user-id="item.userId"
            :display-name="item.title"
            :avatar-url="item.avatarUrl"
            size="sm"
          />
          <svg v-else-if="item.kind === 'channel'" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path d="M4 9h16M4 15h16M9 4 7 20M17 4l-2 16" />
          </svg>
          <svg v-else class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path d="M9 17H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-4" />
            <path d="m8 13 4 4 4-4" />
          </svg>
        </div>

        <span
          class="flex-1 overflow-hidden text-ellipsis py-1 text-center text-[12px] font-semibold tracking-wide"
          :class="item.id === pinned.activeId ? 'font-bold text-white' : 'text-gray-200'"
          style="writing-mode: vertical-rl;"
        >
          {{ item.title }}
        </span>

        <button
          type="button"
          class="flex h-5 w-5 items-center justify-center rounded text-gray-300 transition-colors hover:bg-white/10 hover:text-white"
          :aria-label="`Unpin ${item.title}`"
          @click.stop="pinned.unpin(item.id)"
        >
          <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>
    </aside>
  </template>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import ConversationWorkspace from '@/components/ConversationWorkspace.vue'
import ThreadWorkspace from '@/components/ThreadWorkspace.vue'
import UserAvatar from '@/components/UserAvatar.vue'
import ResizableSidebar from '@/components/ResizableSidebar.vue'
import { usePinnedDialogsStore, type PinnedDialogue } from '@/stores/pinnedDialogs'
import type { Message } from '@/stores/chat'

const pinned = usePinnedDialogsStore()

const activeItem = computed(() => pinned.activeItem)
const headerTitle = computed(() => {
  const item = activeItem.value
  if (!item) return ''
  if (item.kind === 'thread') return `# ${item.title} > Conversation`
  return item.title
})

function openPinnedThread(message: Message) {
  pinned.ensureThreadPinned(message.channelId, message.id)
}

function cardClass(item: PinnedDialogue) {
  const base = pinned.itemTypeMeta(item.kind)
  if (item.id === pinned.activeId) return `${base.activeClass} shadow-lg`
  return `${base.accentClass} border-white/10 hover:bg-white/10 hover:text-white`
}
</script>
