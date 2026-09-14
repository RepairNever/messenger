<template>
  <div ref="contentEl" class="min-h-full">
    <div ref="beforeEl">
      <slot name="before" />
    </div>

    <div class="relative" :style="{ height: `${layout.totalHeight}px` }">
      <div
        v-for="entry in renderedEntries"
        :key="entry.id"
        :ref="(element) => setRowElement(entry.id, element)"
        class="absolute inset-x-0 top-0"
        :style="{ transform: `translateY(${entry.start}px)` }"
      >
        <slot :item="entry.item" :index="entry.index" />
      </div>
    </div>

    <div ref="afterEl">
      <slot name="after" />
    </div>
  </div>
</template>

<script setup lang="ts" generic="T extends { id: string | number }">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type ComponentPublicInstance,
} from 'vue'

interface VirtualTimelineEntry<T> {
  id: string
  index: number
  item: T
  start: number
  height: number
}

interface TimelineLayout<T> {
  entries: VirtualTimelineEntry<T>[]
  entryById: Map<string, VirtualTimelineEntry<T>>
  totalHeight: number
}

const props = withDefaults(
  defineProps<{
    items: T[]
    scrollContainer: HTMLElement | null
    estimatedRowHeight?: number
    overscan?: number
    rowGap?: number
    bottomStickThreshold?: number
    keepRenderedIds?: Array<string | number>
  }>(),
  {
    estimatedRowHeight: 96,
    overscan: 720,
    rowGap: 0,
    bottomStickThreshold: 72,
    keepRenderedIds: () => [],
  },
)

const VIRTUALIZE_AFTER = 80
const FALLBACK_VIEWPORT_HEIGHT = 800

const contentEl = ref<HTMLElement | null>(null)
const beforeEl = ref<HTMLElement | null>(null)
const afterEl = ref<HTMLElement | null>(null)
const viewportTop = ref(0)
const viewportHeight = ref(0)
const beforeHeight = ref(0)
const measurementVersion = ref(0)
const rowHeights = new Map<string, number>()
const rowElements = new Map<string, HTMLElement>()
const rowIds = new WeakMap<HTMLElement, string>()

let rowResizeObserver: ResizeObserver | null = null
let staticResizeObserver: ResizeObserver | null = null
let observedScrollContainer: HTMLElement | null = null
let pendingLayoutAnchor: TimelineScrollAnchor | null = null
let layoutCorrectionQueued = false
let disposed = false

type TimelineScrollAnchor =
  | { kind: 'bottom' }
  | { kind: 'entry'; messageId: string; offsetFromEntryTop: number }
  | { kind: 'static'; scrollTop: number }

function itemId(item: T): string {
  return String(item.id)
}

const layout = computed<TimelineLayout<T>>(() => {
  // Make row measurements a dependency without copying a potentially large map.
  measurementVersion.value

  let offset = 0
  const entries: VirtualTimelineEntry<T>[] = []
  const entryById = new Map<string, VirtualTimelineEntry<T>>()

  for (let index = 0; index < props.items.length; index += 1) {
    if (index > 0) offset += props.rowGap
    const item = props.items[index]
    const id = itemId(item)
    const height = rowHeights.get(id) ?? props.estimatedRowHeight
    const entry = { id, index, item, start: offset, height }
    entries.push(entry)
    entryById.set(id, entry)
    offset += height
  }

  return { entries, entryById, totalHeight: offset }
})

function updateViewport() {
  const container = props.scrollContainer
  if (!container) return

  viewportTop.value = container.scrollTop
  viewportHeight.value = container.clientHeight || FALLBACK_VIEWPORT_HEIGHT
}

function syncStaticHeight(): boolean {
  const nextHeight = beforeEl.value?.offsetHeight ?? 0
  if (nextHeight === beforeHeight.value) return false

  beforeHeight.value = nextHeight
  return true
}

function findEntryAtOffset(offset: number): VirtualTimelineEntry<T> | undefined {
  const entries = layout.value.entries
  let low = 0
  let high = entries.length - 1

  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const entry = entries[middle]
    if (offset < entry.start) {
      high = middle - 1
    } else if (offset >= entry.start + entry.height) {
      low = middle + 1
    } else {
      return entry
    }
  }

  return entries[Math.max(0, Math.min(low, entries.length - 1))]
}

const renderedEntries = computed(() => {
  const entries = layout.value.entries
  if (entries.length <= VIRTUALIZE_AFTER) return entries

  const top = Math.max(0, viewportTop.value - beforeHeight.value - props.overscan)
  const bottom = Math.max(
    top,
    viewportTop.value - beforeHeight.value + (viewportHeight.value || FALLBACK_VIEWPORT_HEIGHT) + props.overscan,
  )
  const first = findEntryAtOffset(top)?.index ?? 0
  const last = findEntryAtOffset(bottom)?.index ?? entries.length - 1
  const selectedIndexes = new Set<number>()

  for (let index = Math.max(0, first); index <= Math.min(entries.length - 1, last); index += 1) {
    selectedIndexes.add(index)
  }

  for (const id of props.keepRenderedIds) {
    const entry = layout.value.entryById.get(String(id))
    if (entry) selectedIndexes.add(entry.index)
  }

  return Array.from(selectedIndexes)
    .sort((left, right) => left - right)
    .map((index) => entries[index])
})

function setRowElement(id: string, element: Element | ComponentPublicInstance | null) {
  const next = element instanceof HTMLElement ? element : null
  const previous = rowElements.get(id)
  if (previous === next) return

  if (previous) {
    rowResizeObserver?.unobserve(previous)
    rowElements.delete(id)
    rowIds.delete(previous)
  }

  if (!next) return
  rowElements.set(id, next)
  rowIds.set(next, id)
  rowResizeObserver?.observe(next)
}

function handleRowResize(entries: ResizeObserverEntry[]) {
  let changed = false
  let anchor: TimelineScrollAnchor | null = null

  for (const entry of entries) {
    const row = entry.target as HTMLElement
    const rowId = rowIds.get(row)
    if (!rowId) continue

    const nextHeight = Math.max(1, Math.ceil(entry.contentRect.height))
    const previousHeight = rowHeights.get(rowId) ?? props.estimatedRowHeight
    if (nextHeight === previousHeight) continue

    anchor ??= captureTimelineAnchor()
    rowHeights.set(rowId, nextHeight)
    changed = true
  }

  if (!changed) return

  measurementVersion.value += 1
  queueLayoutCorrection(anchor)
}

function isNearBottom(container: HTMLElement): boolean {
  return container.scrollHeight - (container.scrollTop + container.clientHeight) <= props.bottomStickThreshold
}

function captureTimelineAnchor(): TimelineScrollAnchor | null {
  const container = props.scrollContainer
  if (!container) return null
  if (isNearBottom(container)) return { kind: 'bottom' }

  const timelineTop = container.scrollTop - beforeHeight.value
  if (timelineTop < 0) return { kind: 'static', scrollTop: container.scrollTop }

  const entry = findEntryAtOffset(timelineTop)
  if (!entry) return { kind: 'static', scrollTop: container.scrollTop }
  return {
    kind: 'entry',
    messageId: entry.id,
    offsetFromEntryTop: timelineTop - entry.start,
  }
}

function restoreTimelineAnchor(anchor: TimelineScrollAnchor) {
  const container = props.scrollContainer
  if (!container) return

  if (anchor.kind === 'bottom') {
    container.scrollTop = container.scrollHeight
  } else if (anchor.kind === 'entry') {
    const entry = layout.value.entryById.get(anchor.messageId)
    if (!entry) return
    container.scrollTop = Math.max(0, beforeHeight.value + entry.start + anchor.offsetFromEntryTop)
  } else {
    container.scrollTop = Math.max(0, anchor.scrollTop)
  }
  updateViewport()
}

function queueLayoutCorrection(anchor: TimelineScrollAnchor | null) {
  if (!anchor) return
  if (!pendingLayoutAnchor) pendingLayoutAnchor = anchor
  if (layoutCorrectionQueued) return

  layoutCorrectionQueued = true
  void nextTick().then(() => {
    layoutCorrectionQueued = false
    const pending = pendingLayoutAnchor
    pendingLayoutAnchor = null
    if (!pending || disposed) return
    restoreTimelineAnchor(pending)
  })
}

function handleStaticResize(entries: ResizeObserverEntry[]) {
  let contentChanged = false
  let anchor: TimelineScrollAnchor | null = null

  for (const entry of entries) {
    if (entry.target === observedScrollContainer) {
      updateViewport()
      continue
    }
    if (entry.target !== beforeEl.value && entry.target !== afterEl.value) continue

    anchor ??= captureTimelineAnchor()
    if (entry.target === beforeEl.value) {
      const nextHeight = Math.max(0, Math.ceil(entry.contentRect.height))
      if (nextHeight === beforeHeight.value) continue
      beforeHeight.value = nextHeight
    }
    contentChanged = true
  }

  if (contentChanged) queueLayoutCorrection(anchor)
}

function attachScrollContainer(container: HTMLElement | null) {
  if (observedScrollContainer === container) return

  if (observedScrollContainer) {
    observedScrollContainer.removeEventListener('scroll', updateViewport)
    staticResizeObserver?.unobserve(observedScrollContainer)
  }

  observedScrollContainer = container
  if (!container) return

  container.addEventListener('scroll', updateViewport, { passive: true })
  staticResizeObserver?.observe(container)
  updateViewport()
}

function restoreAnchor(messageId: string | number, offsetFromViewportTop: number): boolean {
  const entry = layout.value.entryById.get(String(messageId))
  const container = props.scrollContainer
  if (!entry || !container) return false

  container.scrollTop = Math.max(0, beforeHeight.value + entry.start - offsetFromViewportTop)
  updateViewport()
  return true
}

async function scrollToMessage(messageId: string | number, options: ScrollIntoViewOptions = { block: 'center' }): Promise<boolean> {
  const entry = layout.value.entryById.get(String(messageId))
  const container = props.scrollContainer
  if (!entry || !container) return false

  const targetTop = beforeHeight.value + entry.start
  if (options.block === 'start') {
    container.scrollTop = targetTop
  } else if (options.block === 'end') {
    container.scrollTop = Math.max(0, targetTop + entry.height - container.clientHeight)
  } else {
    container.scrollTop = Math.max(0, targetTop - Math.max(0, (container.clientHeight - entry.height) / 2))
  }
  updateViewport()
  await nextTick()
  rowElements.get(entry.id)?.scrollIntoView(options)
  return true
}

function removeMissingMeasurements() {
  const currentIds = new Set(props.items.map(itemId))
  let removed = false
  for (const id of rowHeights.keys()) {
    if (!currentIds.has(id)) {
      rowHeights.delete(id)
      removed = true
    }
  }
  if (removed) measurementVersion.value += 1
}

watch(
  () => props.scrollContainer,
  (container) => attachScrollContainer(container),
  { immediate: true },
)

watch(
  () => props.items.map(itemId).join('\u0000'),
  async () => {
    removeMissingMeasurements()
    await nextTick()
    const anchor = captureTimelineAnchor()
    if (syncStaticHeight()) queueLayoutCorrection(anchor)
    updateViewport()
  },
)

onMounted(() => {
  if (typeof ResizeObserver !== 'undefined') {
    rowResizeObserver = new ResizeObserver(handleRowResize)
    staticResizeObserver = new ResizeObserver(handleStaticResize)
    if (beforeEl.value) staticResizeObserver.observe(beforeEl.value)
    if (afterEl.value) staticResizeObserver.observe(afterEl.value)
    if (props.scrollContainer) staticResizeObserver.observe(props.scrollContainer)
    for (const row of rowElements.values()) rowResizeObserver.observe(row)
  }
  attachScrollContainer(props.scrollContainer)
  void nextTick().then(() => {
    const anchor = captureTimelineAnchor()
    if (syncStaticHeight()) queueLayoutCorrection(anchor)
  })
})

onBeforeUnmount(() => {
  disposed = true
  pendingLayoutAnchor = null
  if (observedScrollContainer) {
    observedScrollContainer.removeEventListener('scroll', updateViewport)
  }
  rowResizeObserver?.disconnect()
  staticResizeObserver?.disconnect()
  rowElements.clear()
})

defineExpose({
  restoreAnchor,
  scrollToMessage,
  contentElement: contentEl,
})
</script>
