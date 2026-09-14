import { defineComponent, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import VirtualMessageTimeline from '@/components/chat/VirtualMessageTimeline.vue'

interface TimelineItem {
  id: string
  body: string
}

type ObservedResize = { target: Element; height: number }

class TestResizeObserver {
  static instances: TestResizeObserver[] = []

  readonly observe = vi.fn((element: Element) => {
    this.observed.add(element)
  })

  readonly unobserve = vi.fn((element: Element) => {
    this.observed.delete(element)
  })

  readonly disconnect = vi.fn(() => {
    this.observed.clear()
  })

  private readonly observed = new Set<Element>()

  constructor(private readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this)
  }

  trigger(entries: ObservedResize[]) {
    this.callback(entries.map(({ target, height }) => ({
      target,
      contentRect: { height },
    })) as ResizeObserverEntry[], this as unknown as ResizeObserver)
  }
}

function buildItems(start: number, count: number): TimelineItem[] {
  return Array.from({ length: count }, (_, offset) => ({
    id: `message-${start + offset}`,
    body: `Message ${start + offset}`,
  }))
}

function mountTimeline(items: TimelineItem[], pinnedIds: string[] = [], withBefore = false) {
  const Host = defineComponent({
    components: { VirtualMessageTimeline },
    setup() {
      const scrollEl = ref<HTMLElement | null>(null)
      const timeline = ref<{
        restoreAnchor: (messageId: string, offsetFromViewportTop: number) => boolean
      } | null>(null)
      const timelineItems = ref(items)
      const pinned = ref(pinnedIds)
      return { scrollEl, timeline, timelineItems, pinned }
    },
    template: `
      <div ref="scrollEl" data-testid="scroll">
        <VirtualMessageTimeline
          ref="timeline"
          :items="timelineItems"
          :scroll-container="scrollEl"
          :keep-rendered-ids="pinned"
        >
          <template v-if="${withBefore}" #before>
            <div data-testid="timeline-before">Thread root</div>
          </template>
          <template #default="{ item }">
            <div :data-testid="'row-' + item.id">{{ item.body }}</div>
          </template>
        </VirtualMessageTimeline>
      </div>
    `,
  })

  return mount(Host)
}

function rowResizeObserver(): TestResizeObserver {
  const observer = TestResizeObserver.instances[0]
  if (!observer) throw new Error('row ResizeObserver was not created')
  return observer
}

function staticResizeObserver(): TestResizeObserver {
  const observer = TestResizeObserver.instances[1]
  if (!observer) throw new Error('static ResizeObserver was not created')
  return observer
}

function installScrollMetrics(scroll: HTMLDivElement, initialHeight: number, clientHeight = 400) {
  let scrollHeight = initialHeight
  Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: clientHeight })
  Object.defineProperty(scroll, 'scrollHeight', {
    configurable: true,
    get: () => scrollHeight,
  })
  return {
    setScrollHeight(nextHeight: number) {
      scrollHeight = nextHeight
    },
  }
}

async function flushTimelineLayout() {
  await nextTick()
  await nextTick()
}

describe('VirtualMessageTimeline', () => {
  beforeEach(() => {
    TestResizeObserver.instances = []
    vi.stubGlobal('ResizeObserver', TestResizeObserver)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('bounds mounted rows while retaining a focused or edited offscreen row', async () => {
    const wrapper = mountTimeline(buildItems(0, 200), ['message-199'])
    const scroll = wrapper.get('[data-testid="scroll"]').element as HTMLDivElement
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 400 })
    scroll.dispatchEvent(new Event('scroll'))
    await nextTick()

    const rows = wrapper.findAll('[data-testid^="row-"]')
    expect(rows.length).toBeLessThan(200)
    expect(wrapper.find('[data-testid="row-message-199"]').exists()).toBe(true)
  })

  it('restores an existing visible message at the same viewport offset after a prepend', async () => {
    const wrapper = mountTimeline(buildItems(20, 100))
    const scroll = wrapper.get('[data-testid="scroll"]').element as HTMLDivElement
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 400 })
    await nextTick()

    const timeline = (wrapper.vm as unknown as {
      timeline: { restoreAnchor: (messageId: string, offsetFromViewportTop: number) => boolean } | null
    }).timeline
    if (!timeline) throw new Error('timeline was not mounted')
    expect(timeline.restoreAnchor('message-80', 17)).toBe(true)
    expect(scroll.scrollTop).toBe(60 * 96 - 17)

    const host = wrapper.vm as unknown as { timelineItems: TimelineItem[] }
    host.timelineItems = [...buildItems(10, 10), ...host.timelineItems]
    await nextTick()

    expect(timeline.restoreAnchor('message-80', 17)).toBe(true)
    expect(scroll.scrollTop).toBe(70 * 96 - 17)
  })

  it('preserves the visible message offset after an above-viewport row is measured', async () => {
    const wrapper = mountTimeline(buildItems(0, 200))
    const scroll = wrapper.get('[data-testid="scroll"]').element as HTMLDivElement
    installScrollMetrics(scroll, 200 * 96)
    scroll.scrollTop = 100 * 96 + 20
    scroll.dispatchEvent(new Event('scroll'))
    await flushTimelineLayout()

    const row = wrapper.get('[data-testid="row-message-95"]').element.parentElement
    if (!row) throw new Error('expected virtual row wrapper')
    rowResizeObserver().trigger([{ target: row, height: 144 }])
    await flushTimelineLayout()

    expect(scroll.scrollTop).toBe(100 * 96 + 20 + 48)

    rowResizeObserver().trigger([{ target: row, height: 144 }])
    await flushTimelineLayout()
    expect(scroll.scrollTop).toBe(100 * 96 + 20 + 48)
  })

  it('does not compensate for a measurement on the partially visible row itself', async () => {
    const wrapper = mountTimeline(buildItems(0, 200))
    const scroll = wrapper.get('[data-testid="scroll"]').element as HTMLDivElement
    installScrollMetrics(scroll, 200 * 96)
    scroll.scrollTop = 95 * 96 + 20
    scroll.dispatchEvent(new Event('scroll'))
    await flushTimelineLayout()

    const row = wrapper.get('[data-testid="row-message-95"]').element.parentElement
    if (!row) throw new Error('expected virtual row wrapper')
    rowResizeObserver().trigger([{ target: row, height: 144 }])
    await flushTimelineLayout()

    expect(scroll.scrollTop).toBe(95 * 96 + 20)
  })

  it('keeps the tail pinned when its measured height changes', async () => {
    const wrapper = mountTimeline(buildItems(0, 200))
    const scroll = wrapper.get('[data-testid="scroll"]').element as HTMLDivElement
    const metrics = installScrollMetrics(scroll, 200 * 96)
    scroll.scrollTop = 200 * 96 - 400
    scroll.dispatchEvent(new Event('scroll'))
    await flushTimelineLayout()

    const row = wrapper.get('[data-testid="row-message-199"]').element.parentElement
    if (!row) throw new Error('expected virtual row wrapper')
    metrics.setScrollHeight(200 * 96 + 54)
    rowResizeObserver().trigger([{ target: row, height: 150 }])
    await flushTimelineLayout()

    expect(scroll.scrollTop).toBe(200 * 96 + 54)
  })

  it('preserves the first visible reply when the shared before slot changes height', async () => {
    const wrapper = mountTimeline(buildItems(0, 200), [], true)
    const scroll = wrapper.get('[data-testid="scroll"]').element as HTMLDivElement
    installScrollMetrics(scroll, 200 * 96 + 160)
    const before = wrapper.get('[data-testid="timeline-before"]').element.parentElement
    if (!before) throw new Error('expected timeline before-slot wrapper')
    let beforeHeight = 0
    Object.defineProperty(before, 'offsetHeight', {
      configurable: true,
      get: () => beforeHeight,
    })

    beforeHeight = 100
    staticResizeObserver().trigger([{ target: before, height: 100 }])
    await flushTimelineLayout()

    scroll.scrollTop = 100 + 100 * 96 + 20
    scroll.dispatchEvent(new Event('scroll'))
    await flushTimelineLayout()

    beforeHeight = 160
    staticResizeObserver().trigger([{ target: before, height: 160 }])
    await flushTimelineLayout()

    expect(scroll.scrollTop).toBe(160 + 100 * 96 + 20)
  })

  it('does not re-register a mounted row observer when the virtual viewport rerenders', async () => {
    const wrapper = mountTimeline(buildItems(0, 200))
    const scroll = wrapper.get('[data-testid="scroll"]').element as HTMLDivElement
    installScrollMetrics(scroll, 200 * 96)
    scroll.scrollTop = 100 * 96
    scroll.dispatchEvent(new Event('scroll'))
    await flushTimelineLayout()

    const observer = rowResizeObserver()
    const observedCount = observer.observe.mock.calls.length
    scroll.scrollTop += 1
    scroll.dispatchEvent(new Event('scroll'))
    await flushTimelineLayout()

    expect(observer.observe).toHaveBeenCalledTimes(observedCount)
  })
})
