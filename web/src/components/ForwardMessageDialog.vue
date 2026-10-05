<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="dlg-overlay z-[10000]"
      @click.self="close"
    >
      <div class="dlg-window max-w-lg" role="dialog" aria-modal="true" aria-label="Forward message">
        <div class="dlg-head flex items-center justify-between">
          <h2 class="dlg-title">Forward message</h2>
          <button
            class="rounded p-1 text-app-muted hover:bg-app-hover hover:text-app-text"
            title="Close"
            @click="close"
          >
            <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div class="dlg-search mx-0 mb-2">
          <svg class="h-[15px] w-[15px] shrink-0 text-app-muted" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            v-model="query"
            class="dlg-search-input"
            placeholder="Search conversations"
            @keydown.esc="close"
          >
        </div>

        <div class="dlg-list">
          <div v-if="loading" class="dlg-empty">
            Loading targets...
          </div>
          <div v-else-if="error" class="dlg-empty text-app-danger">
            {{ error }}
          </div>
          <div v-else-if="filteredConversations.length === 0" class="dlg-empty">
            No targets found
          </div>
          <template v-else>
            <section v-if="filteredConversations.length > 0" class="py-1">
              <h3 class="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-app-muted">Conversations</h3>
              <button
                v-for="target in filteredConversations"
                :key="`conversation:${target.conversation_id}`"
                class="dlg-row"
                :class="selectedKey === `conversation:${target.conversation_id}` ? 'bg-accent/15' : ''"
                @click="selectedKey = `conversation:${target.conversation_id}`"
              >
                <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-app-input text-xs font-semibold text-public_id">
                  {{ target.kind === 'dm' ? 'DM' : '#' }}
                </span>
                <span class="min-w-0 flex-1">
                  <span class="dlg-row-name block truncate">{{ target.title }}</span>
                  <span class="dlg-row-sub block truncate">{{ target.kind === 'dm' ? 'Direct message' : target.visibility }}</span>
                </span>
              </button>
            </section>
          </template>
        </div>

        <div class="dlg-foot-end">
          <button
            class="dlg-btn dlg-btn-ghost"
            :disabled="submitting"
            @click="close"
          >
            Cancel
          </button>
          <button
            class="dlg-btn dlg-btn-primary"
            :disabled="!selectedKey || submitting"
            @click="submit"
          >
            {{ submitting ? 'Forwarding...' : 'Forward' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Message } from '@/stores/chat'
import { useChatStore } from '@/stores/chat'
import {
  listForwardTargets,
  type ForwardTargetConversationItem,
} from '@/services/http/chatApi'

const props = defineProps<{
  open: boolean
  message: Message
}>()

const emit = defineEmits<{
  close: []
}>()

const chatStore = useChatStore()
const loading = ref(false)
const submitting = ref(false)
const error = ref('')
const query = ref('')
const selectedKey = ref('')
const conversations = ref<ForwardTargetConversationItem[]>([])

const normalizedQuery = computed(() => query.value.trim().toLowerCase())
function conversationKindRank(kind: ForwardTargetConversationItem['kind']) {
  if (kind === 'channel') return 0
  if (kind === 'dm') return 1
  return 2
}

const filteredConversations = computed(() => {
  const needle = normalizedQuery.value
  const filtered = needle
    ? conversations.value.filter(target => target.title.toLowerCase().includes(needle))
    : conversations.value
  return [...filtered].sort((a, b) =>
    conversationKindRank(a.kind) - conversationKindRank(b.kind)
    || a.title.localeCompare(b.title),
  )
})
async function loadTargets() {
  loading.value = true
  error.value = ''
  selectedKey.value = ''
  try {
    const data = await listForwardTargets()
    conversations.value = data.conversations
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load targets'
  } finally {
    loading.value = false
  }
}

function close() {
  if (submitting.value) return
  emit('close')
}

async function submit() {
  if (!selectedKey.value || submitting.value) return
  const [, conversationId] = selectedKey.value.split(':')
  if (!conversationId) return
  submitting.value = true
  error.value = ''
  try {
    await chatStore.forwardMessageToTarget(
      props.message,
      conversationId,
      '',
    )
    emit('close')
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to forward message'
  } finally {
    submitting.value = false
  }
}

watch(() => props.open, (open) => {
  if (!open) return
  query.value = ''
  void loadTargets()
}, { immediate: true })

watch(normalizedQuery, () => {
  selectedKey.value = ''
})
</script>
