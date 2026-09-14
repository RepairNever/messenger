<template>
  <div class="flex h-full flex-col overflow-hidden bg-chat-bg" data-testid="documents-search-view">
    <div class="border-b border-chat-border px-6 py-4">
      <h1 class="text-lg font-semibold text-white">Search documents</h1>
      <p class="mt-1 text-sm text-gray-400">
        {{ headingText }}
      </p>
    </div>

    <div class="flex-1 overflow-y-auto px-6 py-4">
      <div v-if="!query.trim()" class="flex h-full items-center justify-center text-sm text-gray-500">
        Type to search documents.
      </div>
      <div v-else-if="documentsStore.searchLoading" class="flex h-full items-center justify-center text-sm text-gray-500">
        Searching...
      </div>
      <div v-else-if="documentsStore.searchError" class="flex h-full items-center justify-center text-sm text-red-400">
        {{ documentsStore.searchError }}
      </div>
      <div v-else-if="documentsStore.searchResults.length === 0" class="flex h-full items-center justify-center text-sm text-gray-500">
        No documents found.
      </div>
      <div v-else class="space-y-3">
        <button
          v-for="item in documentsStore.searchResults"
          :key="item.id"
          type="button"
          class="block w-full rounded-xl border border-chat-border bg-chat-header px-4 py-3 text-left transition-colors hover:border-accent/40 hover:bg-white/5"
          :data-testid="`document-search-result-${item.id}`"
          @click="$emit('openDocument', item.id)"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <h2 class="truncate text-sm font-semibold text-white">{{ item.title }}</h2>
              <p class="mt-1 text-xs uppercase tracking-wide text-gray-500">{{ item.teamspace_name }}</p>
            </div>
          </div>
          <p v-if="item.snippet" class="mt-2 text-sm leading-6 text-gray-300">
            {{ item.snippet }}
          </p>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useDocumentsStore } from '@/stores/documents'

const props = defineProps<{
  query: string
}>()

defineEmits<{
  openDocument: [documentId: string]
}>()

const documentsStore = useDocumentsStore()

const headingText = computed(() => {
  const trimmedQuery = props.query.trim()
  if (!trimmedQuery) {
    return 'Search by title or document body across joined teamspaces.'
  }
  return `Results for "${trimmedQuery}"`
})
</script>
