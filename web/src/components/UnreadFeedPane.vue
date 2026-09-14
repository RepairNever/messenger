<template>
  <section class="flex h-full min-h-0 flex-col bg-chat-bg">
    <header class="flex items-center justify-between border-b border-chat-border bg-chat-header px-4 py-3">
      <div>
        <h1 class="text-sm font-semibold text-white">Unread</h1>
        <p class="mt-1 text-xs text-gray-400">All unread messages, mentions, and thread replies.</p>
      </div>
      <button
        type="button"
        class="rounded border border-chat-border px-2.5 py-1 text-xs text-gray-300 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-50"
        :disabled="chatStore.unreadFeedLoading"
        @click="chatStore.refreshUnreadFeed()"
      >
        Refresh
      </button>
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <div v-if="chatStore.unreadFeedLoading && chatStore.unreadFeedItems.length === 0" class="px-4 py-6 text-sm text-gray-400">
        Loading unread items...
      </div>

      <div v-else-if="chatStore.unreadFeedError && chatStore.unreadFeedItems.length === 0" class="px-4 py-6 text-sm text-red-300">
        {{ chatStore.unreadFeedError }}
      </div>

      <div v-else-if="chatStore.unreadFeedItems.length === 0" class="px-4 py-8 text-center text-sm text-gray-500">
        No unread events.
      </div>

      <div v-else class="divide-y divide-chat-border/70">
        <button
          v-for="item in chatStore.unreadFeedItems"
          :key="item.id"
          type="button"
          class="block w-full px-4 py-3 text-left transition-colors hover:bg-white/5"
          @click="$emit('open-item', item)"
        >
          <div class="flex items-start gap-3">
            <span
              class="mt-0.5 inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
              :class="itemKindClass(item.kind)"
            >
              {{ itemKindLabel(item.kind) }}
            </span>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 text-xs text-gray-400">
                <span class="truncate">{{ conversationLabel(item) }}</span>
                <span class="shrink-0">{{ formatTimestamp(item.createdAt) }}</span>
              </div>
              <div class="mt-1 truncate text-sm font-medium text-white">
                {{ item.senderName || item.conversationTitle }}
              </div>
              <div class="mt-1 line-clamp-2 text-sm text-gray-300">
                {{ item.body || emptyBodyLabel(item.kind) }}
              </div>
            </div>
          </div>
        </button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { useChatStore, type UnreadFeedItem } from '@/stores/chat'

defineEmits<{
  'open-item': [item: UnreadFeedItem]
}>()

const chatStore = useChatStore()

function itemKindLabel(kind: UnreadFeedItem['kind']) {
  if (kind === 'mention') return 'Mention'
  if (kind === 'thread') return 'Thread'
  return 'Message'
}

function itemKindClass(kind: UnreadFeedItem['kind']) {
  if (kind === 'mention') return 'bg-amber-500/20 text-amber-200'
  if (kind === 'thread') return 'bg-cyan-500/20 text-cyan-200'
  return 'bg-emerald-500/20 text-emerald-200'
}

function conversationLabel(item: UnreadFeedItem) {
  if (item.conversationKind === 'dm') return `@${item.conversationTitle}`
  return item.conversationVisibility === 'private'
    ? `Private · #${item.conversationTitle}`
    : `#${item.conversationTitle}`
}

function emptyBodyLabel(kind: UnreadFeedItem['kind']) {
  if (kind === 'mention') return 'You were mentioned.'
  if (kind === 'thread') return 'There is a new thread reply.'
  return 'New unread message.'
}

function formatTimestamp(value: string) {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return ''
  return parsed.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}
</script>
