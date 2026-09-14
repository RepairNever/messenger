import { getCurrentScope, onScopeDispose, reactive, shallowRef, type CSSProperties } from 'vue'

export type FloatingDockMode = 'expanded' | 'minimized'

type DockPosition = {
  x: number
  y: number
}

type ActiveDockDrag = {
  mode: FloatingDockMode
  pointerId: number
  offsetX: number
  offsetY: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function readSize(el: HTMLElement): { width: number; height: number } {
  const rect = el.getBoundingClientRect()
  return {
    width: Math.max(0, rect.width),
    height: Math.max(0, rect.height),
  }
}

export function useFloatingDockPosition() {
  const scope = getCurrentScope()
  const canManageLifecycle = Boolean(scope)
  const elements = {
    // Element refs are side-effect inputs for layout measurement, not render state.
    expanded: shallowRef<HTMLElement | null>(null),
    minimized: shallowRef<HTMLElement | null>(null),
  }
  const positions = reactive<Record<FloatingDockMode, DockPosition | null>>({
    expanded: null,
    minimized: null,
  })
  const activeDrag = shallowRef<ActiveDockDrag | null>(null)

  function clampPosition(mode: FloatingDockMode, candidate: DockPosition): DockPosition {
    if (typeof window === 'undefined') return candidate
    const el = elements[mode].value
    if (!el) return candidate
    const { width, height } = readSize(el)
    return {
      x: clamp(candidate.x, 0, Math.max(0, window.innerWidth - width)),
      y: clamp(candidate.y, 0, Math.max(0, window.innerHeight - height)),
    }
  }

  function defaultPosition(mode: FloatingDockMode): DockPosition | null {
    if (typeof window === 'undefined') return null
    const el = elements[mode].value
    if (!el) return null
    const { width, height } = readSize(el)
    return clampPosition(mode, {
      x: window.innerWidth - width,
      y: window.innerHeight - height,
    })
  }

  function detachPointerListeners() {
    if (typeof window === 'undefined') return
    window.removeEventListener('pointermove', handlePointerMove)
    window.removeEventListener('pointerup', stopDrag)
    window.removeEventListener('pointercancel', stopDrag)
  }

  function updateDocumentDragState(active: boolean) {
    document.body.style.cursor = active ? 'move' : ''
    document.body.style.userSelect = active ? 'none' : ''
  }

  function stopDrag(event?: PointerEvent) {
    if (!activeDrag.value) return
    if (event && event.pointerId !== activeDrag.value.pointerId) return
    activeDrag.value = null
    detachPointerListeners()
    updateDocumentDragState(false)
  }

  function handlePointerMove(event: PointerEvent) {
    const drag = activeDrag.value
    if (!drag || event.pointerId !== drag.pointerId) return
    positions[drag.mode] = clampPosition(drag.mode, {
      x: event.clientX - drag.offsetX,
      y: event.clientY - drag.offsetY,
    })
  }

  function registerElement(mode: FloatingDockMode, el: HTMLElement | null) {
    elements[mode].value = el
    if (!el) return
    const position = positions[mode]
    if (position) {
      positions[mode] = clampPosition(mode, position)
    }
  }

  function startDrag(mode: FloatingDockMode, event: PointerEvent) {
    if (typeof window === 'undefined') return
    if (typeof event.isPrimary === 'boolean' && !event.isPrimary) return
    if (typeof event.button === 'number' && event.button !== 0) return

    const initialPosition = positions[mode] ?? defaultPosition(mode)
    if (!initialPosition) return

    stopDrag()
    positions[mode] = initialPosition
    activeDrag.value = {
      mode,
      pointerId: event.pointerId,
      offsetX: event.clientX - initialPosition.x,
      offsetY: event.clientY - initialPosition.y,
    }
    detachPointerListeners()
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopDrag)
    window.addEventListener('pointercancel', stopDrag)
    updateDocumentDragState(true)
    event.preventDefault()
  }

  function resetIfInvalid(mode?: FloatingDockMode) {
    if (mode) {
      const position = positions[mode]
      if (position) positions[mode] = clampPosition(mode, position)
      return
    }
    const expandedPosition = positions.expanded
    if (expandedPosition) positions.expanded = clampPosition('expanded', expandedPosition)
    const minimizedPosition = positions.minimized
    if (minimizedPosition) positions.minimized = clampPosition('minimized', minimizedPosition)
  }

  function positionStyle(mode: FloatingDockMode): CSSProperties {
    const position = positions[mode]
    if (position) {
      return {
        left: `${position.x}px`,
        top: `${position.y}px`,
      }
    }
    return {
      right: '0px',
      bottom: '0px',
    }
  }

  function handleWindowResize() {
    resetIfInvalid()
  }

  if (typeof window !== 'undefined' && canManageLifecycle) {
    window.addEventListener('resize', handleWindowResize)
    onScopeDispose(() => {
      stopDrag()
      window.removeEventListener('resize', handleWindowResize)
    })
  }

  return {
    positionStyle,
    registerElement,
    resetIfInvalid,
    startDrag,
  }
}
