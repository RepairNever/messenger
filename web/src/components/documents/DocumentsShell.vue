<template>
  <div class="flex h-full overflow-hidden bg-chat-bg" data-testid="documents-mode">
    <ResizableSidebar
      v-if="!sidebarCollapsed"
      storage-key="msgnr:sidebar-width:documents:v1"
      :default-width="256"
      :min-width="220"
      :max-width="540"
    >
      <DocumentsSidebar
        :selected-teamspace-id="selectedTeamspaceId"
        :selected-document-id="selectedDocumentId"
        :search-query="searchQuery"
        @open-teamspaces="emit('openTeamspaces')"
        @open-document="emit('openDocument', $event)"
        @documents-deleted="emit('documentsDeleted', $event)"
        @search-query-change="emit('searchQueryChange', $event)"
      />
    </ResizableSidebar>
    <main class="flex-1 min-w-0 overflow-hidden">
      <DocumentCard
        v-if="viewMode === 'card'"
        @back="emit('back')"
        @open-parent="emit('openParent', $event)"
      />
      <TeamspacesView
        v-else-if="viewMode === 'teamspace'"
        :selected-teamspace-id="selectedTeamspaceId"
        @open-teamspace="emit('openTeamspace', $event)"
        @open-teamspaces="emit('openTeamspaces')"
      />
      <DocumentSearchView
        v-else-if="viewMode === 'search'"
        :query="searchQuery"
        @open-document="emit('openDocument', $event)"
      />
      <TeamspacesView
        v-else
        :selected-teamspace-id="null"
        @open-teamspace="emit('openTeamspace', $event)"
        @open-teamspaces="emit('openTeamspaces')"
      />
    </main>
  </div>
</template>

<script setup lang="ts">
import ResizableSidebar from '@/components/ResizableSidebar.vue'
import DocumentsSidebar from '@/components/documents/DocumentsSidebar.vue'
import TeamspacesView from '@/components/documents/TeamspacesView.vue'
import DocumentCard from '@/components/documents/DocumentCard.vue'
import DocumentSearchView from '@/components/documents/DocumentSearchView.vue'

defineProps<{
  sidebarCollapsed: boolean
  selectedTeamspaceId: string | null
  selectedDocumentId: string | null
  searchQuery: string
  viewMode: 'teamspaces' | 'teamspace' | 'search' | 'card'
}>()

const emit = defineEmits<{
  openTeamspaces: []
  openTeamspace: [teamspaceId: string]
  openDocument: [documentId: string]
  documentsDeleted: [documentIds: string[]]
  searchQueryChange: [value: string]
  back: []
  openParent: [documentId: string]
}>()
</script>
