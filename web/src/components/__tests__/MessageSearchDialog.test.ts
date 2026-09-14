import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import MessageSearchDialog from '@/components/MessageSearchDialog.vue'
import { searchMessages } from '@/services/http/searchApi'

vi.mock('@/services/http/searchApi', () => ({
  searchMessages: vi.fn(),
}))

async function flushUi() {
  await Promise.resolve()
  await nextTick()
}

describe('MessageSearchDialog', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(searchMessages).mockReset()
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('debounces searches and renders escaped highlighted snippets', async () => {
    vi.mocked(searchMessages).mockResolvedValue({
      total_count: 1,
      items: [{
        source: 'chat_message',
        id: 'chat:message-1',
        body: '<needle> & body',
        created_at: '2026-05-12T00:00:00Z',
        actor_id: 'user-1',
        actor_name: 'Ada',
        conversation_id: 'channel-1',
        conversation_title: 'general',
        conversation_kind: 'channel',
        conversation_visibility: 'public',
        message_id: 'message-1',
      }],
    })

    mount(MessageSearchDialog, {
      props: {
        open: true,
        scope: 'global',
      },
      attachTo: document.body,
    })
    await flushUi()

    const input = document.body.querySelector('[data-testid="message-search-input"]') as HTMLInputElement
    input.value = 'needle'
    input.dispatchEvent(new Event('input'))
    await flushUi()

    expect(searchMessages).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(250)
    await flushUi()

    expect(searchMessages).toHaveBeenCalledWith({ q: 'needle', conversationId: undefined, limit: 20 })
    const result = document.body.querySelector('[data-testid="message-search-result"]')
    expect(result?.textContent).toContain('Ada')
    expect(result?.innerHTML).toContain('&lt;')
    expect(result?.innerHTML).toContain('<mark')
  })

  it('ignores stale responses', async () => {
    let resolveFirst: (value: Awaited<ReturnType<typeof searchMessages>>) => void = () => {}
    let resolveSecond: (value: Awaited<ReturnType<typeof searchMessages>>) => void = () => {}
    vi.mocked(searchMessages)
      .mockReturnValueOnce(new Promise(resolve => { resolveFirst = resolve }))
      .mockReturnValueOnce(new Promise(resolve => { resolveSecond = resolve }))

    mount(MessageSearchDialog, {
      props: {
        open: true,
        scope: 'conversation',
        conversationId: 'channel-1',
      },
      attachTo: document.body,
    })
    await flushUi()

    const input = document.body.querySelector('[data-testid="message-search-input"]') as HTMLInputElement
    input.value = 'first'
    input.dispatchEvent(new Event('input'))
    await vi.advanceTimersByTimeAsync(250)
    await flushUi()

    input.value = 'second'
    input.dispatchEvent(new Event('input'))
    await flushUi()

    resolveFirst({
      total_count: 1,
      items: [{
        source: 'chat_message',
        id: 'chat:first',
        body: 'first result',
        created_at: '2026-05-12T00:00:00Z',
        actor_id: 'user-1',
        actor_name: 'First',
        conversation_id: 'channel-1',
        conversation_title: 'general',
        conversation_kind: 'channel',
        conversation_visibility: 'public',
        message_id: 'first',
      }],
    })
    await flushUi()
    expect(document.body.textContent).not.toContain('First')

    await vi.advanceTimersByTimeAsync(250)
    await flushUi()

    resolveSecond({
      total_count: 1,
      items: [{
        source: 'chat_message',
        id: 'chat:second',
        body: 'second result',
        created_at: '2026-05-12T00:00:00Z',
        actor_id: 'user-1',
        actor_name: 'Second',
        conversation_id: 'channel-1',
        conversation_title: 'general',
        conversation_kind: 'channel',
        conversation_visibility: 'public',
        message_id: 'second',
      }],
    })
    await flushUi()

    expect(document.body.textContent).toContain('Second')
    expect(document.body.textContent).not.toContain('First')
    expect(searchMessages).toHaveBeenLastCalledWith({ q: 'second', conversationId: 'channel-1', limit: 20 })
  })

  it('emits selected results and closes', async () => {
    vi.mocked(searchMessages).mockResolvedValue({
      total_count: 1,
      items: [{
        source: 'task_comment',
        id: 'task-comment:comment-1',
        body: 'needle comment',
        created_at: '2026-05-12T00:00:00Z',
        actor_id: 'user-1',
        actor_name: 'Ada',
        task_id: 'task-1',
        task_public_id: 'TASK-1',
        task_title: 'Fix search',
        task_comment_id: 'comment-1',
      }],
    })
    const wrapper = mount(MessageSearchDialog, {
      props: {
        open: true,
        scope: 'global',
      },
      attachTo: document.body,
    })
    await flushUi()

    const input = document.body.querySelector('[data-testid="message-search-input"]') as HTMLInputElement
    input.value = 'needle'
    input.dispatchEvent(new Event('input'))
    await vi.advanceTimersByTimeAsync(250)
    await flushUi()

    const result = document.body.querySelector('[data-testid="message-search-result"]') as HTMLButtonElement
    result.click()
    await flushUi()

    expect(wrapper.emitted('open-result')?.[0]?.[0]).toMatchObject({
      source: 'task_comment',
      task_comment_id: 'comment-1',
    })
    expect(wrapper.emitted('close')).toBeTruthy()
  })
})
