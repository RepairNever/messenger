import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useChatStore } from '@/stores/chat'

export type PinnedDialogueKind = 'dm' | 'channel' | 'thread'

export interface PinnedDialogue {
  id: string
  kind: PinnedDialogueKind
  conversationId: string
  title: string
  avatarUrl?: string
  userId?: string
  threadRootMessageId?: string
}

export function pinnedDialogueId(kind: PinnedDialogueKind, conversationId: string, threadRootMessageId = ''): string {
  if (kind === 'thread') return `thread:${conversationId}:${threadRootMessageId}`
  return `${kind}:${conversationId}`
}

export const usePinnedDialogsStore = defineStore('pinnedDialogs', () => {
  const chatStore = useChatStore()
  const items = ref<PinnedDialogue[]>([])
  const activeId = ref<string | null>(null)

  const hasItems = computed(() => items.value.length > 0)
  const activeItem = computed(() => items.value.find(item => item.id === activeId.value) ?? null)

  function itemTypeMeta(kind: PinnedDialogueKind) {
    switch (kind) {
      case 'dm':
        return {
          accentClass: 'border-cyan-400/60 text-cyan-200 bg-cyan-500/10',
          iconAccentClass: 'bg-cyan-500/15 text-cyan-200 ring-cyan-300/30',
          activeClass: 'bg-cyan-500/20 ring-2 ring-cyan-300/30 border-cyan-300/60 text-cyan-50',
        }
      case 'channel':
        return {
          accentClass: 'border-emerald-400/60 text-emerald-200 bg-emerald-500/10',
          iconAccentClass: 'bg-emerald-500/15 text-emerald-200 ring-emerald-300/30',
          activeClass: 'bg-emerald-500/20 ring-2 ring-emerald-300/30 border-emerald-300/60 text-emerald-50',
        }
      case 'thread':
        return {
          accentClass: 'border-amber-400/60 text-amber-200 bg-amber-500/10',
          iconAccentClass: 'bg-amber-500/15 text-amber-200 ring-amber-300/30',
          activeClass: 'bg-amber-500/20 ring-2 ring-amber-300/30 border-amber-300/60 text-amber-50',
        }
    }
  }

  function isPinned(id: string): boolean {
    return items.value.some(item => item.id === id)
  }

  function activate(id: string) {
    if (!isPinned(id)) return
    activeId.value = id
  }

  function deactivate() {
    activeId.value = null
  }

  function normalizeConversationPinned(conversationId: string): PinnedDialogue | null {
    const dm = chatStore.directMessages.find(item => item.id === conversationId)
    if (dm) {
      return {
        id: pinnedDialogueId('dm', conversationId),
        kind: 'dm',
        conversationId,
        title: dm.displayName,
        avatarUrl: dm.avatarUrl,
        userId: dm.userId,
      }
    }

    const channel = chatStore.channels.find(item => item.id === conversationId)
    if (!channel) return null
    return {
      id: pinnedDialogueId('channel', conversationId),
      kind: 'channel',
      conversationId,
      title: channel.name,
    }
  }

  function ensureConversationPinned(conversationId: string): string | null {
    const normalized = normalizeConversationPinned(conversationId)
    if (!normalized) return null
    if (!isPinned(normalized.id)) {
      items.value = [...items.value, normalized]
    }
    activeId.value = normalized.id
    return normalized.id
  }

  function ensureThreadPinned(conversationId: string, rootMessageId: string, titleOverride = ''): string | null {
    if (!conversationId || !rootMessageId) return null
    const overrideTitle = titleOverride.trim()
    const channelTitle = overrideTitle || chatStore.channels.find(item => item.id === conversationId)?.name
    const conversationTitle = channelTitle
      || chatStore.directMessages.find(item => item.id === conversationId)?.displayName
      || chatStore.getConversationById(conversationId)?.title
      || 'Conversation'

    const id = pinnedDialogueId('thread', conversationId, rootMessageId)
    if (!isPinned(id)) {
      items.value = [...items.value, {
        id,
        kind: 'thread',
        conversationId,
        threadRootMessageId: rootMessageId,
        title: conversationTitle,
      }]
    }
    activeId.value = id
    return id
  }

  function unpin(id: string) {
    const idx = items.value.findIndex(item => item.id === id)
    if (idx === -1) return
    const next = items.value.filter(item => item.id !== id)
    items.value = next
    if (activeId.value !== id) return

    const replacement = idx > 0
      ? (next[idx - 1] ?? null)
      : (next[0] ?? null)
    activeId.value = replacement?.id ?? null
  }

  function unpinActive() {
    if (!activeId.value) return
    unpin(activeId.value)
  }

  function clearAll() {
    items.value = []
    activeId.value = null
  }

  return {
    items,
    activeId,
    hasItems,
    activeItem,
    itemTypeMeta,
    isPinned,
    activate,
    deactivate,
    ensureConversationPinned,
    ensureThreadPinned,
    unpin,
    unpinActive,
    clearAll,
  }
})
