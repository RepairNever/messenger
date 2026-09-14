<template>
  <section class="flex h-full min-h-0 flex-col bg-chat-bg">
    <header class="flex items-center justify-between border-b border-chat-border bg-chat-header px-4 py-3">
      <div>
        <h1 class="text-sm font-semibold text-white">Saved Message</h1>
        <p class="mt-1 text-xs text-gray-400">Messages saved across conversations.</p>
      </div>
      <button
        type="button"
        class="rounded border border-chat-border px-2.5 py-1 text-xs text-gray-300 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-50"
        :disabled="chatStore.savedMessagesLoading"
        @click="chatStore.refreshSavedMessages()"
      >
        Refresh
      </button>
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <div v-if="chatStore.savedMessagesLoading && chatStore.savedMessageItems.length === 0" class="px-4 py-6 text-sm text-gray-400">
        Loading saved messages...
      </div>

      <div v-else-if="chatStore.savedMessagesError && chatStore.savedMessageItems.length === 0" class="px-4 py-6 text-sm text-red-300">
        {{ chatStore.savedMessagesError }}
      </div>

      <div v-else-if="chatStore.savedMessageItems.length === 0" class="px-4 py-8 text-center text-sm text-gray-500">
        No saved messages.
      </div>

      <div v-else class="divide-y divide-chat-border/70">
        <div
          v-for="item in chatStore.savedMessageItems"
          :key="item.id"
          role="button"
          tabindex="0"
          class="block w-full cursor-pointer px-4 py-3 text-left transition-colors hover:bg-white/5 focus:outline-none focus:ring-1 focus:ring-inset focus:ring-cyan-400/40"
          @click="$emit('open-item', item)"
          @keydown.enter.prevent="$emit('open-item', item)"
          @keydown.space.prevent="$emit('open-item', item)"
        >
          <div class="flex items-start gap-3">
            <span class="mt-0.5 inline-flex rounded-full bg-cyan-500/20 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-cyan-200">
              Saved
            </span>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 text-xs text-gray-400">
                <span class="truncate">{{ conversationLabel(item) }}</span>
                <span class="shrink-0">{{ formatTimestamp(item.savedAt) }}</span>
              </div>
              <div class="mt-1 truncate text-sm font-medium text-white">
                {{ item.senderName || item.conversationTitle }}
              </div>
              <div
                v-if="item.forwardedFrom"
                data-testid="saved-message-forwarded-banner"
                class="mt-1 inline-flex max-w-full items-center rounded border border-chat-border bg-chat-input/70 px-2 py-0.5 text-[11px] text-app-muted"
                :title="formatForwardedMessageLabel(item.forwardedFrom)"
              >
                <span class="truncate">{{ formatForwardedMessageLabel(item.forwardedFrom) }}</span>
              </div>
              <div
                v-if="item.body"
                class="markdown-body mt-1 line-clamp-2 text-sm text-gray-300"
                v-html="renderSavedMessageBody(item)"
              ></div>
              <div v-else class="mt-1 line-clamp-2 text-sm text-gray-300">
                Saved attachment message.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { useChatStore, type SavedMessageItem } from '@/stores/chat'
import { renderMessageBodyWithEntities } from '@/utils/renderMessageEntities'
import { formatForwardedMessageLabel } from '@/utils/forwardedMessages'

defineEmits<{
  'open-item': [item: SavedMessageItem]
}>()

const chatStore = useChatStore()

function conversationLabel(item: SavedMessageItem) {
  if (item.conversationKind === 'dm') return `@${item.conversationTitle}`
  return item.conversationVisibility === 'private'
    ? `Private · #${item.conversationTitle}`
    : `#${item.conversationTitle}`
}

function renderSavedMessageBody(item: SavedMessageItem) {
  return renderMessageBodyWithEntities(item.body, item.entities ?? [])
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
