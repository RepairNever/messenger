<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-3 py-16"
      data-testid="message-search-dialog"
      @click.self="emit('close')"
      @keydown.esc.prevent="emit('close')"
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Message search"
        class="flex w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-chat-border bg-chat-header shadow-2xl"
      >
        <header class="border-b border-chat-border px-4 py-3">
          <div class="flex items-center gap-2">
            <svg class="h-4 w-4 shrink-0 text-app-muted" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
            <input
              ref="inputEl"
              v-model="query"
              data-testid="message-search-input"
              type="search"
              class="min-w-0 flex-1 bg-transparent text-sm text-app-text outline-none placeholder:text-app-muted"
              :placeholder="placeholder"
              @keydown.enter.prevent="openFirstResult"
            >
            <button
              type="button"
              class="flex h-7 w-7 shrink-0 items-center justify-center rounded text-app-muted transition-colors hover:bg-chat-msgHover hover:text-app-text"
              aria-label="Close search"
              @click="emit('close')"
            >
              <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div class="mt-2 flex items-center justify-between gap-3 text-[11px] text-app-muted">
            <span>{{ scopeLabel }}</span>
            <span>{{ totalLabel }}</span>
          </div>
        </header>

        <div class="max-h-[64vh] min-h-52 overflow-y-auto">
          <div v-if="query.trim().length < 2" class="px-4 py-8 text-center text-sm text-app-muted">
            Type at least 2 characters.
          </div>

          <div v-else-if="loading && results.length === 0" class="px-4 py-8 text-center text-sm text-app-muted">
            Searching...
          </div>

          <div v-else-if="error && results.length === 0" class="px-4 py-8 text-center text-sm text-red-300">
            {{ error }}
          </div>

          <div v-else-if="results.length === 0" class="px-4 py-8 text-center text-sm text-app-muted">
            No matching messages.
          </div>

          <div v-else class="divide-y divide-chat-border/70">
            <button
              v-for="item in results"
              :key="item.id"
              type="button"
              data-testid="message-search-result"
              :data-result-id="item.id"
              class="block w-full px-4 py-3 text-left transition-colors hover:bg-chat-msgHover focus:bg-chat-msgHover focus:outline-none"
              @click="openResult(item)"
            >
              <div class="flex items-start gap-3">
                <span
                  class="mt-0.5 inline-flex shrink-0 rounded border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
                  :class="sourceClass(item.source)"
                >
                  {{ sourceLabel(item.source) }}
                </span>
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2 text-xs text-app-muted">
                    <span class="truncate">{{ locationLabel(item) }}</span>
                    <span class="shrink-0">{{ formatTimestamp(item.created_at) }}</span>
                  </div>
                  <div class="mt-1 truncate text-sm font-medium text-app-text">
                    {{ item.actor_name || 'Unknown sender' }}
                  </div>
                  <div
                    class="mt-1 line-clamp-2 text-sm text-app-secondaryText"
                    v-html="snippetHtml(item.body)"
                  ></div>
                </div>
              </div>
            </button>
          </div>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { searchMessages, type MessageSearchResult, type MessageSearchSource } from '@/services/http/searchApi'
import { escapeHtml } from '@/utils/markdown'

const props = defineProps<{
  open: boolean
  scope: 'global' | 'conversation'
  conversationId?: string
  conversationTitle?: string
}>()

const emit = defineEmits<{
  close: []
  'open-result': [result: MessageSearchResult]
}>()

const inputEl = ref<HTMLInputElement | null>(null)
const query = ref('')
const results = ref<MessageSearchResult[]>([])
const loading = ref(false)
const error = ref('')
const totalCount = ref(0)
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let requestToken = 0

const placeholder = computed(() => {
  if (props.scope === 'conversation') {
    return props.conversationTitle ? `Search in ${props.conversationTitle}` : 'Search in conversation'
  }
  return 'Search messages'
})

const scopeLabel = computed(() => {
  if (props.scope === 'conversation') {
    return props.conversationTitle ? `Current conversation: ${props.conversationTitle}` : 'Current conversation'
  }
  return 'All conversations and task comments'
})

const totalLabel = computed(() => {
  if (query.value.trim().length < 2) return ''
  if (loading.value) return results.value.length > 0 ? 'Updating...' : 'Searching...'
  if (error.value) return ''
  return totalCount.value === 1 ? '1 result' : `${totalCount.value} results`
})

function clearDebounce() {
  if (!debounceTimer) return
  clearTimeout(debounceTimer)
  debounceTimer = null
}

function resetState() {
  clearDebounce()
  requestToken += 1
  query.value = ''
  results.value = []
  loading.value = false
  error.value = ''
  totalCount.value = 0
}

function scheduleSearch() {
  clearDebounce()
  const token = ++requestToken
  const trimmed = query.value.trim()
  if (!props.open || trimmed.length < 2) {
    results.value = []
    loading.value = false
    error.value = ''
    totalCount.value = 0
    return
  }
  loading.value = true
  error.value = ''
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void runSearch(trimmed, token)
  }, 250)
}

async function runSearch(term: string, token: number) {
  try {
    const response = await searchMessages({
      q: term,
      conversationId: props.scope === 'conversation' ? props.conversationId : undefined,
      limit: 20,
    })
    if (token !== requestToken) return
    results.value = response.items
    totalCount.value = response.total_count
  } catch (e) {
    if (token !== requestToken) return
    results.value = []
    totalCount.value = 0
    error.value = e instanceof Error ? e.message : 'Search failed'
  } finally {
    if (token === requestToken) loading.value = false
  }
}

function openResult(item: MessageSearchResult) {
  emit('open-result', item)
  emit('close')
}

function openFirstResult() {
  const first = results.value[0]
  if (!first) return
  openResult(first)
}

function sourceLabel(source: MessageSearchSource) {
  if (source === 'task_comment') return 'Comment'
  if (source === 'task_comment_thread') return 'Task Thread'
  return 'Message'
}

function sourceClass(source: MessageSearchSource) {
  if (source === 'task_comment') return 'border-accent/30 bg-accent/10 text-accent'
  if (source === 'task_comment_thread') return 'border-app-selection bg-app-selection text-app-selectionText'
  return 'border-chat-border bg-chat-input text-app-secondaryText'
}

function locationLabel(item: MessageSearchResult) {
  if (item.source === 'task_comment' || item.source === 'task_comment_thread') {
    const task = item.task_public_id ? `Task ${item.task_public_id}` : 'Task'
    return item.source === 'task_comment_thread' ? `${task} > thread` : `${task} > comment`
  }
  const title = item.conversation_title || 'Conversation'
  const prefix = item.conversation_kind === 'dm'
    ? '@'
    : item.conversation_visibility === 'private'
      ? 'Private #'
      : '#'
  return item.thread_root_message_id ? `${prefix}${title} > thread` : `${prefix}${title}`
}

function highlightHtml(value: string, term: string) {
  const lowerValue = value.toLowerCase()
  const lowerTerm = term.toLowerCase()
  if (!lowerTerm) return escapeHtml(value)

  let cursor = 0
  let html = ''
  while (cursor < value.length) {
    const index = lowerValue.indexOf(lowerTerm, cursor)
    if (index === -1) {
      html += escapeHtml(value.slice(cursor))
      break
    }
    html += escapeHtml(value.slice(cursor, index))
    html += `<mark class="rounded bg-accent/20 px-0.5 text-app-text">${escapeHtml(value.slice(index, index + term.length))}</mark>`
    cursor = index + term.length
  }
  return html
}

function snippetHtml(body: string) {
  const text = body
  const term = query.value.trim()
  const index = text.toLowerCase().indexOf(term.toLowerCase())
  if (index === -1) return highlightHtml(text.slice(0, 180), term)
  const start = Math.max(0, index - 70)
  const end = Math.min(text.length, index + term.length + 90)
  const prefix = start > 0 ? '...' : ''
  const suffix = end < text.length ? '...' : ''
  return `${escapeHtml(prefix)}${highlightHtml(text.slice(start, end), term)}${escapeHtml(suffix)}`
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

watch(() => props.open, async (open) => {
  if (!open) {
    resetState()
    return
  }
  await nextTick()
  inputEl.value?.focus()
})

watch(() => [query.value, props.scope, props.conversationId] as const, scheduleSearch)

onBeforeUnmount(() => {
  clearDebounce()
  requestToken += 1
})
</script>
