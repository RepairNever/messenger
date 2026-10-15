<template>
  <svg
    class="h-4 w-4 shrink-0"
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    :data-document-kind="kind ?? 'markdown'"
  >
    <template v-if="kind === 'spreadsheet'">
      <rect x="2.75" y="3.5" width="14.5" height="13" rx="1.5" />
      <path d="M2.75 7.5h14.5M2.75 12h14.5M7.5 7.5v9M12.5 7.5v9" />
    </template>
    <path v-else-if="folder" d="M2.75 6.75c0-1.24 1.01-2.25 2.25-2.25h2.59c.4 0 .78.16 1.06.44l.81.81c.28.28.66.44 1.06.44h4.73c1.24 0 2.25 1.01 2.25 2.25v6.06c0 1.24-1.01 2.25-2.25 2.25H5c-1.24 0-2.25-1.01-2.25-2.25V6.75z" />
    <template v-else>
      <path d="M11.5 2.75H6.75c-1.24 0-2.25 1.01-2.25 2.25v10c0 1.24 1.01 2.25 2.25 2.25h6.5c1.24 0 2.25-1.01 2.25-2.25V6.75l-4-4z" />
      <path d="M11.5 2.75V5.5c0 .69.56 1.25 1.25 1.25h2.75" />
    </template>
  </svg>
</template>

<script setup lang="ts">
import type { DocumentKind } from '@/services/http/documentsApi'

defineProps<{ kind?: DocumentKind; folder?: boolean }>()
</script>
