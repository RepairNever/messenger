<template>
  <section
    ref="sectionRef"
    class="border-t border-chat-border pt-4"
    data-testid="task-change-history"
  >
    <div class="mb-3 flex items-center justify-between gap-3">
      <h2 class="field-label mb-0">Change history</h2>
      <span v-if="loading" class="text-xs text-app-muted">Loading…</span>
    </div>

    <p v-if="!historyStarted" class="text-sm italic text-app-muted">
      Scroll here to load change history.
    </p>

    <div v-else-if="historyItems.length" class="overflow-x-auto rounded border border-chat-border">
      <table class="w-full min-w-[760px] text-left text-sm">
        <thead class="bg-chat-input text-xs uppercase tracking-wide text-app-muted">
          <tr>
            <th class="px-3 py-2 font-medium">Initiator</th>
            <th class="px-3 py-2 font-medium">Field</th>
            <th class="px-3 py-2 font-medium">Value</th>
            <th class="whitespace-nowrap px-3 py-2 font-medium">Date</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-chat-border">
          <template v-for="item in historyItems" :key="item.id">
            <tr class="bg-chat-header align-top">
              <td class="px-3 py-2.5">
                <div class="flex min-w-[170px] items-center gap-2">
                  <UserAvatar
                    :user-id="item.actor.id"
                    :display-name="actorName(item)"
                    :avatar-url="item.actor.avatar_url"
                    :custom-status="userCustomStatusFromDto(item.actor.custom_status)"
                    size="xs"
                  />
                  <span class="min-w-0 truncate text-app-text">{{ actorName(item) }}</span>
                </div>
              </td>
              <td class="px-3 py-2.5 text-app-text">{{ item.field_name }}</td>
              <td class="px-3 py-2.5 text-app-text">
                <template v-if="item.change_kind === 'created'">
                  <span>Created</span>
                  <div
                    v-if="creationAttachments(item).length"
                    class="mt-2 min-w-[260px] overflow-hidden rounded border border-chat-border bg-chat-input/60"
                    data-testid="task-change-history-created-attachments"
                  >
                    <div class="border-b border-chat-border px-3 py-2 text-xs font-semibold uppercase tracking-wide text-app-muted">
                      Attachments
                    </div>
                    <div class="divide-y divide-chat-border">
                      <div
                        v-for="attachment in creationAttachments(item)"
                        :key="attachment.id"
                        class="flex items-center gap-2 px-3 py-2"
                      >
                        <svg class="h-4 w-4 shrink-0 text-app-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
                          <path d="m21.4 11.6-8.8 8.8a6 6 0 0 1-8.5-8.5l8.1-8.1a4 4 0 1 1 5.7 5.7l-8.1 8.1a2 2 0 0 1-2.9-2.8l7.4-7.4" />
                        </svg>
                        <span class="min-w-0 flex-1 truncate">{{ attachment.file_name }}</span>
                        <span class="shrink-0 text-xs text-app-muted">{{ formatFileSize(attachment.file_size) }}</span>
                      </div>
                    </div>
                  </div>
                </template>
                <button
                  v-else-if="isDescriptionChange(item)"
                  type="button"
                  class="text-accent hover:text-accent-hover underline underline-offset-2"
                  :data-testid="`task-change-history-diff-${item.id}`"
                  @click="toggleDescriptionDiff(item.id)"
                >
                  {{ selectedDescriptionID === item.id ? 'Hide diff' : 'View diff' }}
                </button>
                <div
                  v-else-if="isAttachmentChange(item)"
                  class="min-w-[260px] overflow-hidden rounded border border-chat-border bg-chat-input/60"
                  :data-testid="`task-change-history-attachments-${item.id}`"
                >
                  <div class="border-b border-chat-border px-3 py-2 text-xs font-semibold uppercase tracking-wide text-app-muted">
                    Attachments
                  </div>
                  <div class="divide-y divide-chat-border">
                    <div
                      v-for="attachment in attachmentChangeItems(item)"
                      :key="attachment.id"
                      class="flex items-center gap-2 px-3 py-2"
                    >
                      <svg class="h-4 w-4 shrink-0 text-app-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
                        <path d="m21.4 11.6-8.8 8.8a6 6 0 0 1-8.5-8.5l8.1-8.1a4 4 0 1 1 5.7 5.7l-8.1 8.1a2 2 0 0 1-2.9-2.8l7.4-7.4" />
                      </svg>
                      <span class="min-w-0 flex-1 truncate">{{ attachment.file_name }}</span>
                      <span class="shrink-0 text-xs text-app-muted">{{ formatFileSize(attachment.file_size) }}</span>
                      <span
                        class="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                        :class="attachmentAction(item) === 'Added'
                          ? 'bg-emerald-500/15 text-emerald-300'
                          : 'bg-red-500/15 text-red-300'"
                      >
                        {{ attachmentAction(item) }}
                      </span>
                    </div>
                  </div>
                </div>
                <template v-else>
                  <span
                    class="break-words"
                    :class="historyValueClass(item.before_value, 'before')"
                    data-testid="task-change-history-before-value"
                  >{{ valueText(item, item.before_value) }}</span>
                  <span class="px-1.5 text-app-muted" aria-hidden="true">→</span>
                  <span
                    class="break-words"
                    :class="historyValueClass(item.after_value, 'after')"
                    data-testid="task-change-history-after-value"
                  >{{ valueText(item, item.after_value) }}</span>
                </template>
              </td>
              <td class="whitespace-nowrap px-3 py-2.5 text-app-muted">{{ formatDatetime(item.created_at) }}</td>
            </tr>

            <tr v-if="selectedDescriptionID === item.id" data-testid="task-change-history-diff-panel">
              <td colspan="4" class="bg-chat-input/50 px-3 py-3">
                <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div class="inline-flex overflow-hidden rounded text-xs">
                    <button
                      type="button"
                      class="px-2 py-1"
                      :class="diffMode === 'unified'
                        ? 'bg-accent text-app-onAccent'
                        : 'bg-chat-header text-app-muted hover:text-app-text'"
                      data-testid="task-change-history-diff-unified"
                      @click="diffMode = 'unified'"
                    >
                      Unified
                    </button>
                    <button
                      type="button"
                      class="border-l border-chat-border px-2 py-1"
                      :class="diffMode === 'inline'
                        ? 'bg-accent text-app-onAccent'
                        : 'bg-chat-header text-app-muted hover:text-app-text'"
                      data-testid="task-change-history-diff-inline"
                      @click="diffMode = 'inline'"
                    >
                      Inline
                    </button>
                  </div>
                  <button
                    v-if="descriptionDiffLines.length > COLLAPSE_LINE_COUNT"
                    type="button"
                    class="text-xs text-accent hover:text-accent-hover"
                    data-testid="task-change-history-diff-collapse"
                    @click="diffExpanded = !diffExpanded"
                  >
                    {{ diffExpanded ? 'Collapse' : `Expand (${descriptionDiffLines.length} lines)` }}
                  </button>
                </div>

                <div
                  v-if="diffMode === 'unified'"
                  data-testid="task-change-history-diff-unified-body"
                  class="overflow-x-auto rounded border border-chat-border bg-chat-header font-mono text-xs leading-5"
                >
                  <template v-for="(entry, index) in visibleDescriptionDiffLines" :key="`unified:${index}`">
                    <div
                      v-if="entry.kind === 'hidden'"
                      class="flex min-w-max border-y border-chat-border bg-chat-input/80 text-app-muted"
                      data-testid="task-change-history-diff-hidden-lines"
                    >
                      <span class="w-7 shrink-0 select-none px-2 text-right opacity-70">⋮</span>
                      <span class="pr-3">{{ entry.count }} lines hidden</span>
                    </div>
                    <div
                      v-else
                      class="flex min-w-max whitespace-pre"
                      :class="entry.line.kind === 'removed'
                        ? 'bg-red-500/10 text-red-200'
                        : entry.line.kind === 'added'
                          ? 'bg-emerald-500/10 text-emerald-200'
                          : 'text-app-secondaryText'"
                    >
                      <span class="w-7 shrink-0 select-none px-2 text-right opacity-70">{{ unifiedPrefix(entry.line.kind) }}</span>
                      <span class="pr-3">
                        <template v-if="entry.line.segments">
                          <span
                            v-for="(segment, segmentIndex) in entry.line.segments"
                            :key="`${segment.kind}:${segmentIndex}:${segment.value}`"
                            :class="unifiedSegmentClass(segment.kind)"
                            :data-testid="segment.kind === 'removed'
                              ? 'task-change-history-diff-word-removed'
                              : segment.kind === 'added'
                                ? 'task-change-history-diff-word-added'
                                : undefined"
                          >{{ segment.value }}</span>
                        </template>
                        <template v-else>{{ entry.line.value || ' ' }}</template>
                      </span>
                    </div>
                  </template>
                </div>

                <div
                  v-else
                  data-testid="task-change-history-diff-inline-body"
                  class="overflow-x-auto rounded border border-chat-border bg-chat-header font-mono text-xs leading-5"
                >
                  <div class="grid min-w-[720px] grid-cols-2 divide-x divide-chat-border">
                    <div class="bg-red-500/5 px-3 py-1 text-[10px] uppercase tracking-wide text-red-200">Before</div>
                    <div class="bg-emerald-500/5 px-3 py-1 text-[10px] uppercase tracking-wide text-emerald-200">After</div>
                    <template v-for="(entry, index) in visibleInlineDescriptionDiffLines" :key="`inline:${index}`">
                      <div
                        v-if="entry.kind === 'hidden'"
                        class="col-span-2 border-y border-chat-border bg-chat-input/80 px-3 text-app-muted"
                        data-testid="task-change-history-diff-hidden-rows"
                      >⋮ {{ entry.count }} diff rows hidden</div>
                      <template v-else>
                        <div
                          class="min-h-5 whitespace-pre-wrap px-3"
                          :class="inlineLineClass(entry.line.before, 'before')"
                        >{{ entry.line.before?.value || ' ' }}</div>
                        <div
                          class="min-h-5 whitespace-pre-wrap px-3"
                          :class="inlineLineClass(entry.line.after, 'after')"
                        >{{ entry.line.after?.value || ' ' }}</div>
                      </template>
                    </template>
                  </div>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <p v-else-if="historyLoaded && !loading" class="text-sm italic text-app-muted">No changes yet.</p>

    <p v-if="loadError" class="mt-3 text-sm text-app-warning" data-testid="task-change-history-error">
      {{ loadError }}
      <button type="button" class="ml-2 text-accent hover:text-accent-hover underline" @click="loadNextPage">Retry</button>
    </p>

    <div
      v-if="historyStarted && nextCursor"
      ref="sentinelRef"
      class="h-1"
      aria-hidden="true"
      data-testid="task-change-history-sentinel"
    />
    <p v-else-if="historyStarted && historyLoaded && !loadError" class="mt-3 text-center text-xs text-app-muted">
      End of change history
    </p>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { TaskChangeHistoryItem } from '@/services/http/tasksApi'
import { useTasksStore } from '@/stores/tasks'
import UserAvatar from '@/components/UserAvatar.vue'
import { userCustomStatusFromDto } from '@/types/userStatus'
import {
  diffTaskChangeMarkdown,
  inlineTaskChangeDiff,
  unifiedTaskChangeDiff,
  type TaskChangeDiffKind,
  type TaskChangeDiffLine,
  type TaskChangeDiffSegmentKind,
} from '@/utils/taskChangeHistoryDiff'

const PAGE_SIZE = 50
const COLLAPSE_LINE_COUNT = 30
const COLLAPSE_HEAD_LINE_COUNT = COLLAPSE_LINE_COUNT / 2

type CollapsedDiffEntry<T> =
  | { kind: 'line'; line: T }
  | { kind: 'hidden'; count: number }

const props = defineProps<{
  taskId: string
  scrollRoot: HTMLElement | null
}>()

const tasksStore = useTasksStore()
const sectionRef = ref<HTMLElement | null>(null)
const sentinelRef = ref<HTMLElement | null>(null)
const historyItems = ref<TaskChangeHistoryItem[]>([])
const historyStarted = ref(false)
const historyLoaded = ref(false)
const loading = ref(false)
const loadError = ref('')
const nextCursor = ref<string | null>(null)
const selectedDescriptionID = ref<string | null>(null)
const diffMode = ref<'unified' | 'inline'>('unified')
const diffExpanded = ref(false)
let observer: IntersectionObserver | null = null

const selectedDescriptionChange = computed(() =>
  historyItems.value.find(item => item.id === selectedDescriptionID.value) ?? null,
)
const descriptionDiffLines = computed(() => {
  const item = selectedDescriptionChange.value
  if (!item) return []
  return diffTaskChangeMarkdown(markdownValue(item.before_value), markdownValue(item.after_value))
})
const unifiedDescriptionDiffLines = computed(() => unifiedTaskChangeDiff(descriptionDiffLines.value))
const visibleDescriptionDiffLines = computed(() =>
  collapseDiffLines(unifiedDescriptionDiffLines.value, diffExpanded.value),
)
const inlineDescriptionDiffLines = computed(() => inlineTaskChangeDiff(descriptionDiffLines.value))
const visibleInlineDescriptionDiffLines = computed(() =>
  collapseDiffLines(inlineDescriptionDiffLines.value, diffExpanded.value),
)

function collapseDiffLines<T>(lines: T[], expanded: boolean): CollapsedDiffEntry<T>[] {
  if (expanded || lines.length <= COLLAPSE_LINE_COUNT) {
    return lines.map(line => ({ kind: 'line', line }))
  }
  return [
    ...lines.slice(0, COLLAPSE_HEAD_LINE_COUNT).map(line => ({ kind: 'line' as const, line })),
    { kind: 'hidden' as const, count: lines.length - COLLAPSE_LINE_COUNT },
    ...lines.slice(-COLLAPSE_HEAD_LINE_COUNT).map(line => ({ kind: 'line' as const, line })),
  ]
}

function resetHistory() {
  historyItems.value = []
  historyStarted.value = false
  historyLoaded.value = false
  loading.value = false
  loadError.value = ''
  nextCursor.value = null
  selectedDescriptionID.value = null
  diffExpanded.value = false
}

function disconnectObserver() {
  observer?.disconnect()
  observer = null
}

function installObserver() {
  disconnectObserver()
  if (!sectionRef.value || typeof IntersectionObserver === 'undefined') return
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      if (entry.target === sectionRef.value && !historyStarted.value) {
        void loadNextPage()
      }
      if (entry.target === sentinelRef.value && historyStarted.value && nextCursor.value) {
        void loadNextPage()
      }
    }
  }, {
    root: props.scrollRoot,
    rootMargin: '0px 0px 240px 0px',
  })
  observer.observe(sectionRef.value)
  if (sentinelRef.value) observer.observe(sentinelRef.value)
}

async function loadNextPage() {
  if (loading.value) return
  if (historyLoaded.value && !nextCursor.value) return

  const requestedTaskID = props.taskId
  historyStarted.value = true
  loading.value = true
  loadError.value = ''
  try {
    const page = await tasksStore.listTaskChangeHistory(requestedTaskID, {
      cursor: nextCursor.value ?? undefined,
      limit: PAGE_SIZE,
    })
    if (requestedTaskID !== props.taskId) return
    historyItems.value = nextCursor.value
      ? [...historyItems.value, ...page.items]
      : page.items
    nextCursor.value = page.next_cursor ?? null
    historyLoaded.value = true
  } catch (error) {
    if (requestedTaskID === props.taskId) {
      loadError.value = error instanceof Error ? error.message : 'Unable to load change history.'
    }
  } finally {
    if (requestedTaskID === props.taskId) loading.value = false
  }
  await nextTick()
  installObserver()
}

function actorName(item: TaskChangeHistoryItem): string {
  return item.actor.display_name || 'Unknown user'
}

function isDescriptionChange(item: TaskChangeHistoryItem): boolean {
  return item.field_key === 'description'
}

interface HistoryAttachment {
  id: string
  file_name: string
  file_size: number
  mime_type: string
}

function isHistoryAttachment(value: unknown): value is HistoryAttachment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.id === 'string'
    && typeof candidate.file_name === 'string'
    && typeof candidate.file_size === 'number'
    && typeof candidate.mime_type === 'string'
}

function attachmentList(value: unknown): HistoryAttachment[] {
  return Array.isArray(value) ? value.filter(isHistoryAttachment) : []
}

function isAttachmentChange(item: TaskChangeHistoryItem): boolean {
  return item.field_key === 'attachments'
    && (item.field_type === 'attachments_added' || item.field_type === 'attachments_removed')
}

function attachmentChangeItems(item: TaskChangeHistoryItem): HistoryAttachment[] {
  return item.field_type === 'attachments_removed'
    ? attachmentList(item.before_value)
    : attachmentList(item.after_value)
}

function creationAttachments(item: TaskChangeHistoryItem): HistoryAttachment[] {
  if (item.change_kind !== 'created' || !item.after_value || typeof item.after_value !== 'object') return []
  return attachmentList((item.after_value as { attachments?: unknown }).attachments)
}

function attachmentAction(item: TaskChangeHistoryItem): 'Added' | 'Removed' {
  return item.field_type === 'attachments_removed' ? 'Removed' : 'Added'
}

function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return 'Unknown size'
  if (size < 1024) return `${size} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = size / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`
}

function toggleDescriptionDiff(id: string) {
  selectedDescriptionID.value = selectedDescriptionID.value === id ? null : id
  diffMode.value = 'unified'
  diffExpanded.value = false
}

function markdownValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function resolveUserName(id: string): string {
  const user = tasksStore.users.find(candidate => candidate.id === id)
  return user?.display_name || user?.email || id
}

function isEmptyHistoryValue(value: unknown): boolean {
  return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)
}

function historyValueClass(value: unknown, side: 'before' | 'after'): string {
  if (isEmptyHistoryValue(value)) return 'italic text-app-muted'
  return side === 'before'
    ? 'text-red-300 line-through decoration-red-400/70'
    : 'text-emerald-300'
}

function valueText(item: TaskChangeHistoryItem, value: unknown): string {
  if (isEmptyHistoryValue(value)) return 'empty'
  if (item.field_type === 'status' && typeof value === 'object' && !Array.isArray(value)) {
    const name = (value as { name?: unknown }).name
    return typeof name === 'string' ? name : 'Unknown status'
  }
  if (item.field_type === 'user' && typeof value === 'string') return resolveUserName(value)
  if (item.field_type === 'users' && Array.isArray(value)) {
    return value.map(candidate => typeof candidate === 'string' ? resolveUserName(candidate) : String(candidate)).join(', ') || 'empty'
  }
  if (Array.isArray(value)) return value.map(String).join(', ') || 'empty'
  if (item.field_type === 'datetime' && typeof value === 'string') return formatDatetime(value)
  return String(value)
}

function formatDatetime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date)
}

function unifiedPrefix(kind: TaskChangeDiffKind): string {
  if (kind === 'added') return '+'
  if (kind === 'removed') return '−'
  return ' '
}

function unifiedSegmentClass(kind: TaskChangeDiffSegmentKind): string {
  if (kind === 'removed') return 'rounded-sm bg-red-400/35 text-red-50'
  if (kind === 'added') return 'rounded-sm bg-emerald-400/35 text-emerald-50'
  return ''
}

function inlineLineClass(line: TaskChangeDiffLine | null, side: 'before' | 'after'): string {
  if (!line) return 'bg-chat-header text-app-muted'
  if (line.kind === 'removed') return 'bg-red-500/10 text-red-200'
  if (line.kind === 'added') return 'bg-emerald-500/10 text-emerald-200'
  return side === 'before' ? 'text-app-secondaryText' : 'text-app-secondaryText'
}

watch(() => props.taskId, () => {
  resetHistory()
  void nextTick(installObserver)
})
watch(() => props.scrollRoot, () => {
  void nextTick(installObserver)
})
onMounted(installObserver)
onBeforeUnmount(disconnectObserver)
</script>
