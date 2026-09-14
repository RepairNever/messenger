<template>
  <div
    class="relative h-full shrink-0"
    :style="{ width: `${sidebarWidth}px` }"
    data-testid="resizable-sidebar"
  >
    <div class="h-full w-full min-w-0">
      <slot />
    </div>
    <div
      class="group absolute inset-y-0 z-20 flex w-2 cursor-col-resize touch-none select-none items-stretch justify-center"
      :class="[
        handleSide === 'left' ? 'left-0' : 'right-0',
        isResizing ? 'bg-accent/15' : 'hover:bg-accent/10',
      ]"
      :aria-label="resizeTitle"
      :aria-orientation="'vertical'"
      :aria-valuemin="minWidth"
      :aria-valuemax="maxWidth"
      :aria-valuenow="sidebarWidth"
      role="separator"
      data-testid="resizable-sidebar-handle"
      @pointerdown.prevent="startResize"
    >
      <span
        class="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-white/10 transition-colors group-hover:bg-accent/60"
        :class="isResizing ? 'bg-accent/70' : ''"
      />
      <span class="pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-transparent" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { loadSidebarWidth, saveSidebarWidth } from '@/services/storage/sidebarWidthStorage'

const props = withDefaults(defineProps<{
  storageKey: string
  defaultWidth: number
  minWidth?: number
  maxWidth?: number
  resizeTitle?: string
  handleSide?: 'left' | 'right'
}>(), {
  minWidth: 220,
  maxWidth: 520,
  resizeTitle: 'Resize sidebar',
  handleSide: 'right',
})

const sidebarWidth = ref(clampWidth(loadSidebarWidth(props.storageKey, props.defaultWidth)))
const isResizing = ref(false)

let pointerStartX = 0
let widthStart = sidebarWidth.value
let activePointerId: number | null = null

function clampWidth(width: number): number {
  return Math.min(Math.max(Math.round(width), props.minWidth), props.maxWidth)
}

function persistWidth() {
  saveSidebarWidth(props.storageKey, sidebarWidth.value)
}

function updateBodyDragState(active: boolean) {
  document.body.style.cursor = active ? 'col-resize' : ''
  document.body.style.userSelect = active ? 'none' : ''
}

function handlePointerMove(event: PointerEvent) {
  if (!isResizing.value || event.pointerId !== activePointerId) return
  const deltaX = event.clientX - pointerStartX
  sidebarWidth.value = clampWidth(props.handleSide === 'left' ? widthStart - deltaX : widthStart + deltaX)
}

function stopResize(event?: PointerEvent) {
  if (!isResizing.value) return
  if (event && event.pointerId !== activePointerId) return

  isResizing.value = false
  activePointerId = null
  updateBodyDragState(false)

  window.removeEventListener('pointermove', handlePointerMove)
  window.removeEventListener('pointerup', stopResize)
  window.removeEventListener('pointercancel', stopResize)
  persistWidth()
}

function startResize(event: PointerEvent) {
  if (isResizing.value) return

  isResizing.value = true
  activePointerId = event.pointerId
  pointerStartX = event.clientX
  widthStart = sidebarWidth.value
  updateBodyDragState(true)

  window.addEventListener('pointermove', handlePointerMove)
  window.addEventListener('pointerup', stopResize)
  window.addEventListener('pointercancel', stopResize)
}

onMounted(() => {
  persistWidth()
})

onBeforeUnmount(() => {
  stopResize()
})
</script>
