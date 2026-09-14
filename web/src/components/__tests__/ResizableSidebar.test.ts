import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import ResizableSidebar from '@/components/ResizableSidebar.vue'

function dispatchPointerEvent(target: EventTarget, type: string, clientX: number, pointerId = 1) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
  })
  Object.defineProperty(event, 'pointerId', {
    value: pointerId,
  })
  target.dispatchEvent(event)
}

describe('ResizableSidebar', () => {
  beforeEach(() => {
    localStorage.clear()
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  })

  it('loads the persisted width on mount', async () => {
    localStorage.setItem('msgnr:sidebar-width:test:v1', '316')

    const wrapper = mount(ResizableSidebar, {
      props: {
        storageKey: 'msgnr:sidebar-width:test:v1',
        defaultWidth: 240,
        minWidth: 220,
        maxWidth: 520,
      },
      slots: {
        default: '<aside data-testid="sidebar-stub" />',
      },
      attachTo: document.body,
    })
    await nextTick()

    expect((wrapper.get('[data-testid="resizable-sidebar"]').element as HTMLElement).style.width).toBe('316px')
  })

  it('updates and persists the width after dragging the handle', async () => {
    const wrapper = mount(ResizableSidebar, {
      props: {
        storageKey: 'msgnr:sidebar-width:test:v1',
        defaultWidth: 240,
        minWidth: 220,
        maxWidth: 520,
      },
      slots: {
        default: '<aside data-testid="sidebar-stub" />',
      },
      attachTo: document.body,
    })
    await nextTick()

    const handle = wrapper.get('[data-testid="resizable-sidebar-handle"]')
    dispatchPointerEvent(handle.element, 'pointerdown', 240, 1)
    dispatchPointerEvent(window, 'pointermove', 320, 1)
    dispatchPointerEvent(window, 'pointerup', 320, 1)
    await nextTick()

    expect((wrapper.get('[data-testid="resizable-sidebar"]').element as HTMLElement).style.width).toBe('320px')
    expect(localStorage.getItem('msgnr:sidebar-width:test:v1')).toBe('320')
  })

  it('keeps text selection enabled inside the sidebar while the resize handle stays non-selectable', async () => {
    const wrapper = mount(ResizableSidebar, {
      props: {
        storageKey: 'msgnr:sidebar-width:test:v1',
        defaultWidth: 240,
        minWidth: 220,
        maxWidth: 520,
      },
      slots: {
        default: '<aside data-testid="sidebar-stub">selectable text</aside>',
      },
    })
    await nextTick()

    expect(wrapper.get('[data-testid="resizable-sidebar"]').classes()).not.toContain('select-none')
    expect(wrapper.get('[data-testid="resizable-sidebar-handle"]').classes()).toContain('select-none')
  })
})
