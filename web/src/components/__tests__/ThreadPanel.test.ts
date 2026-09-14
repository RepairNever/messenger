import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import ThreadPanel from '@/components/ThreadPanel.vue'
import { useAuthStore } from '@/stores/auth'
import { useChatStore } from '@/stores/chat'
import { useWsStore } from '@/stores/ws'
import { NotificationLevel } from '@/shared/proto/packets_pb'

describe('ThreadPanel reaction affordance', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      value: vi.fn(),
      configurable: true,
      writable: true,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('disables first-reaction hover button on root and enables it for replies', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.state = 'LIVE_SYNCED'

    chat.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chat.activeThreadConversationId = 'channel-1'
    chat.activeThreadRootId = 'root-1'
    chat.messages = {
      'channel-1': [{
        id: 'root-1',
        channelId: 'channel-1',
        senderId: 'user-1',
        senderName: 'Ada',
        body: 'root',
        channelSeq: 1n,
        threadSeq: 0n,
        mentionedUserIds: [],
        mentionEveryone: false,
        createdAt: '2026-03-06T00:00:00Z',
        reactions: [],
        myReactions: [],
      }],
    }
    chat.threadMessages = {
      'root-1': [{
        id: 'reply-1',
        channelId: 'channel-1',
        senderId: 'user-2',
        senderName: 'Bob',
        body: 'reply',
        channelSeq: 2n,
        threadSeq: 1n,
        threadRootMessageId: 'root-1',
        mentionedUserIds: [],
        mentionEveryone: false,
        createdAt: '2026-03-06T00:00:01Z',
        reactions: [],
        myReactions: [],
      }],
    }

    const wrapper = mount(ThreadPanel, {
      global: {
        stubs: {
          MessageBubble: {
            props: ['message', 'showFirstReactionAction'],
            template: '<div class="bubble-props" :data-id="message.id" :data-first-reaction="String(showFirstReactionAction)" />',
          },
          MessageInput: true,
        },
      },
    })

    const bubbles = wrapper.findAll('.bubble-props')
    expect(bubbles).toHaveLength(2)
    expect(bubbles[0].attributes('data-id')).toBe('root-1')
    expect(bubbles[0].attributes('data-first-reaction')).toBe('false')
    expect(bubbles[1].attributes('data-id')).toBe('reply-1')
    expect(bubbles[1].attributes('data-first-reaction')).toBe('true')
  })

  it('passes the thread focus token to the thread composer', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.state = 'LIVE_SYNCED'

    chat.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chat.activeThreadConversationId = 'channel-1'
    chat.activeThreadRootId = 'root-1'
    chat.threadComposerFocusToken = 5
    chat.messages = {
      'channel-1': [{
        id: 'root-1',
        channelId: 'channel-1',
        senderId: 'user-1',
        senderName: 'Ada',
        body: 'root',
        channelSeq: 1n,
        threadSeq: 0n,
        mentionedUserIds: [],
        mentionEveryone: false,
        createdAt: '2026-03-06T00:00:00Z',
        reactions: [],
        myReactions: [],
      }],
    }

    const wrapper = mount(ThreadPanel, {
      global: {
        stubs: {
          MessageBubble: true,
          MessageInput: {
            props: ['focusToken'],
            template: '<div data-testid="thread-focus-token">{{ focusToken }}</div>',
          },
        },
      },
    })

    expect(wrapper.get('[data-testid="thread-focus-token"]').text()).toBe('5')
  })

  it('passes the thread draft scope to the thread composer', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.state = 'LIVE_SYNCED'

    chat.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chat.activeThreadConversationId = 'channel-1'
    chat.activeThreadRootId = 'root-1'
    chat.messages = {
      'channel-1': [{
        id: 'root-1',
        channelId: 'channel-1',
        senderId: 'user-1',
        senderName: 'Ada',
        body: 'root',
        channelSeq: 1n,
        threadSeq: 0n,
        mentionedUserIds: [],
        mentionEveryone: false,
        createdAt: '2026-03-06T00:00:00Z',
        reactions: [],
        myReactions: [],
      }],
    }

    const wrapper = mount(ThreadPanel, {
      global: {
        stubs: {
          MessageBubble: true,
          MessageInput: {
            props: ['draftScope'],
            template: '<div data-testid="thread-draft-scope">{{ JSON.stringify(draftScope) }}</div>',
          },
        },
      },
    })

    expect(wrapper.get('[data-testid="thread-draft-scope"]').text()).toBe(JSON.stringify({
      kind: 'thread',
      conversationId: 'channel-1',
      rootMessageId: 'root-1',
    }))
  })

  it('requests inline edit for the latest editable own thread reply', async () => {
    const auth = useAuthStore()
    const chat = useChatStore()
    const ws = useWsStore()
    auth.user = { id: 'user-1', email: 'u1@example.com', displayName: 'U1', role: 'member' }
    ws.state = 'LIVE_SYNCED'

    chat.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chat.activeThreadConversationId = 'channel-1'
    chat.activeThreadRootId = 'root-1'
    chat.messages = {
      'channel-1': [{
        id: 'root-1',
        channelId: 'channel-1',
        senderId: 'user-1',
        senderName: 'U1',
        body: 'root should not be targeted',
        channelSeq: 1n,
        threadSeq: 0n,
        mentionedUserIds: [],
        mentionEveryone: false,
        createdAt: '2026-03-06T00:00:00Z',
        reactions: [],
        myReactions: [],
      }],
    }
    chat.threadMessages = {
      'root-1': [
        {
          id: 'reply-own',
          channelId: 'channel-1',
          senderId: 'user-1',
          senderName: 'U1',
          body: 'editable',
          channelSeq: 2n,
          threadSeq: 1n,
          threadRootMessageId: 'root-1',
          mentionedUserIds: [],
          mentionEveryone: false,
          createdAt: '2026-03-06T00:00:01Z',
          reactions: [],
          myReactions: [],
        },
        {
          id: 'reply-other',
          channelId: 'channel-1',
          senderId: 'user-2',
          senderName: 'Bob',
          body: 'not mine',
          channelSeq: 3n,
          threadSeq: 2n,
          threadRootMessageId: 'root-1',
          mentionedUserIds: [],
          mentionEveryone: false,
          createdAt: '2026-03-06T00:00:02Z',
          reactions: [],
          myReactions: [],
        },
        {
          id: 'reply-queued',
          channelId: 'channel-1',
          senderId: 'user-1',
          senderName: 'U1',
          body: 'queued',
          channelSeq: 0n,
          threadSeq: 3n,
          threadRootMessageId: 'root-1',
          mentionedUserIds: [],
          mentionEveryone: false,
          createdAt: '2026-03-06T00:00:03Z',
          reactions: [],
          myReactions: [],
          sendStatus: 'queued',
        },
      ],
    }

    const wrapper = mount(ThreadPanel, {
      global: {
        stubs: {
          MessageBubble: {
            props: ['message', 'editRequestToken'],
            template: '<div class="msg" :data-id="message.id" :data-edit-token="editRequestToken" />',
          },
          MessageInput: {
            emits: ['edit-last-message'],
            template: '<button data-testid="edit-last" @click="$emit(\'edit-last-message\')">edit</button>',
          },
        },
      },
    })

    await wrapper.get('[data-testid="edit-last"]').trigger('click')
    await nextTick()

    expect(wrapper.get('[data-id="root-1"]').attributes('data-edit-token')).toBeUndefined()
    expect(wrapper.get('[data-id="reply-own"]').attributes('data-edit-token')).toBe('1')
    expect(wrapper.get('[data-id="reply-other"]').attributes('data-edit-token')).toBe('0')
    expect(wrapper.get('[data-id="reply-queued"]').attributes('data-edit-token')).toBe('0')
  })

  it('scrolls to the latest reply when the panel opens', async () => {
    vi.useFakeTimers()

    const chat = useChatStore()
    const ws = useWsStore()
    ws.state = 'LIVE_SYNCED'

    chat.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chat.activeThreadConversationId = 'channel-1'
    chat.activeThreadRootId = 'root-1'
    chat.messages = {
      'channel-1': [{
        id: 'root-1',
        channelId: 'channel-1',
        senderId: 'user-1',
        senderName: 'Ada',
        body: 'root',
        channelSeq: 1n,
        threadSeq: 0n,
        mentionedUserIds: [],
        mentionEveryone: false,
        createdAt: '2026-03-06T00:00:00Z',
        reactions: [],
        myReactions: [],
      }],
    }
    chat.threadMessages = {
      'root-1': [
        {
          id: 'reply-1',
          channelId: 'channel-1',
          senderId: 'user-2',
          senderName: 'Bob',
          body: 'reply 1',
          channelSeq: 2n,
          threadSeq: 1n,
          threadRootMessageId: 'root-1',
          mentionedUserIds: [],
          mentionEveryone: false,
          createdAt: '2026-03-06T00:01:00Z',
          reactions: [],
          myReactions: [],
        },
        {
          id: 'reply-2',
          channelId: 'channel-1',
          senderId: 'user-2',
          senderName: 'Bob',
          body: 'reply 2',
          channelSeq: 3n,
          threadSeq: 2n,
          threadRootMessageId: 'root-1',
          mentionedUserIds: [],
          mentionEveryone: false,
          createdAt: '2026-03-06T00:02:00Z',
          reactions: [],
          myReactions: [],
        },
      ],
    }

    const wrapper = mount(ThreadPanel, {
      global: {
        stubs: {
          MessageBubble: true,
          MessageInput: true,
        },
      },
    })

    const el = wrapper.find('.overflow-y-auto').element as HTMLDivElement
    Object.defineProperty(el, 'scrollHeight', { value: 2400, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true })
    el.scrollTop = 0

    await nextTick()
    vi.runAllTimers()
    await nextTick()

    expect(el.scrollTop).toBe(2400)
  })

  it('scrolls to the latest reply after delayed thread replay arrives', async () => {
    vi.useFakeTimers()

    const chat = useChatStore()
    const ws = useWsStore()
    ws.state = 'LIVE_SYNCED'

    chat.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chat.activeThreadConversationId = 'channel-1'
    chat.activeThreadRootId = 'root-1'
    chat.threadReplayVersionByRoot = { 'root-1': 0 }
    chat.threadSummaries = {
      'root-1': {
        replyCount: 2,
        lastThreadSeq: 2n,
      },
    }
    chat.messages = {
      'channel-1': [{
        id: 'root-1',
        channelId: 'channel-1',
        senderId: 'user-1',
        senderName: 'Ada',
        body: 'root',
        channelSeq: 1n,
        threadSeq: 0n,
        mentionedUserIds: [],
        mentionEveryone: false,
        createdAt: '2026-03-06T00:00:00Z',
        reactions: [],
        myReactions: [],
      }],
    }
    chat.threadMessages = {
      'root-1': [],
    }

    const wrapper = mount(ThreadPanel, {
      global: {
        stubs: {
          MessageBubble: true,
          MessageInput: true,
        },
      },
    })

    const el = wrapper.find('.overflow-y-auto').element as HTMLDivElement
    Object.defineProperty(el, 'scrollHeight', {
      configurable: true,
      get: () => chat.threadMessages['root-1'].length > 0 ? 2400 : 400,
    })
    Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true })
    el.scrollTop = 0

    await nextTick()
    vi.advanceTimersByTime(500)
    await nextTick()

    chat.threadMessages = {
      'root-1': [
        {
          id: 'reply-1',
          channelId: 'channel-1',
          senderId: 'user-2',
          senderName: 'Bob',
          body: 'reply 1',
          channelSeq: 2n,
          threadSeq: 1n,
          threadRootMessageId: 'root-1',
          mentionedUserIds: [],
          mentionEveryone: false,
          createdAt: '2026-03-06T00:01:00Z',
          reactions: [],
          myReactions: [],
        },
        {
          id: 'reply-2',
          channelId: 'channel-1',
          senderId: 'user-2',
          senderName: 'Bob',
          body: 'reply 2',
          channelSeq: 3n,
          threadSeq: 2n,
          threadRootMessageId: 'root-1',
          mentionedUserIds: [],
          mentionEveryone: false,
          createdAt: '2026-03-06T00:02:00Z',
          reactions: [],
          myReactions: [],
        },
      ],
    }
    chat.threadReplayVersionByRoot = { 'root-1': 1 }

    await nextTick()
    vi.runAllTimers()
    await nextTick()

    expect(el.scrollTop).toBe(2400)
  })

  it('centers the focused reply instead of forcing bottom scroll on link-driven open', async () => {
    vi.useFakeTimers()

    const chat = useChatStore()
    const ws = useWsStore()
    ws.state = 'LIVE_SYNCED'

    chat.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chat.activeThreadConversationId = 'channel-1'
    chat.activeThreadRootId = 'root-1'
    chat.focusedThreadMessageId = 'reply-1'
    chat.messages = {
      'channel-1': [{
        id: 'root-1',
        channelId: 'channel-1',
        senderId: 'user-1',
        senderName: 'Ada',
        body: 'root',
        channelSeq: 1n,
        threadSeq: 0n,
        mentionedUserIds: [],
        mentionEveryone: false,
        createdAt: '2026-03-06T00:00:00Z',
        reactions: [],
        myReactions: [],
      }],
    }
    chat.threadMessages = {
      'root-1': [
        {
          id: 'reply-1',
          channelId: 'channel-1',
          senderId: 'user-2',
          senderName: 'Bob',
          body: 'reply 1',
          channelSeq: 2n,
          threadSeq: 1n,
          threadRootMessageId: 'root-1',
          mentionedUserIds: [],
          mentionEveryone: false,
          createdAt: '2026-03-06T00:01:00Z',
          reactions: [],
          myReactions: [],
        },
        {
          id: 'reply-2',
          channelId: 'channel-1',
          senderId: 'user-2',
          senderName: 'Bob',
          body: 'reply 2',
          channelSeq: 3n,
          threadSeq: 2n,
          threadRootMessageId: 'root-1',
          mentionedUserIds: [],
          mentionEveryone: false,
          createdAt: '2026-03-06T00:02:00Z',
          reactions: [],
          myReactions: [],
        },
      ],
    }

    const wrapper = mount(ThreadPanel, {
      global: {
        stubs: {
          MessageBubble: true,
          MessageInput: true,
        },
      },
    })

    const el = wrapper.find('.overflow-y-auto').element as HTMLDivElement
    Object.defineProperty(el, 'scrollHeight', { value: 2400, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true })
    el.scrollTop = 0

    const focusedReply = wrapper.get('[data-thread-message-id="reply-1"]').element as HTMLElement
    const scrollIntoView = vi.fn()
    Object.defineProperty(focusedReply, 'scrollIntoView', {
      value: scrollIntoView,
      configurable: true,
    })

    await nextTick()
    vi.runAllTimers()
    await nextTick()

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' })
    expect(el.scrollTop).toBe(0)
  })

  it('centers the focused reply after delayed thread replay arrives', async () => {
    vi.useFakeTimers()

    const chat = useChatStore()
    const ws = useWsStore()
    ws.state = 'LIVE_SYNCED'

    chat.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chat.activeThreadConversationId = 'channel-1'
    chat.activeThreadRootId = 'root-1'
    chat.focusedThreadMessageId = 'reply-2'
    chat.messages = {
      'channel-1': [{
        id: 'root-1',
        channelId: 'channel-1',
        senderId: 'user-1',
        senderName: 'Ada',
        body: 'root',
        channelSeq: 1n,
        threadSeq: 0n,
        mentionedUserIds: [],
        mentionEveryone: false,
        createdAt: '2026-03-06T00:00:00Z',
        reactions: [],
        myReactions: [],
      }],
    }
    chat.threadMessages = {
      'root-1': [],
    }

    const wrapper = mount(ThreadPanel, {
      global: {
        stubs: {
          MessageBubble: true,
          MessageInput: true,
        },
      },
    })

    const el = wrapper.find('.overflow-y-auto').element as HTMLDivElement
    Object.defineProperty(el, 'scrollHeight', { value: 2400, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true })
    el.scrollTop = 0

    await nextTick()
    vi.advanceTimersByTime(500)
    await nextTick()

    chat.threadMessages['root-1'] = [
      {
        id: 'reply-1',
        channelId: 'channel-1',
        senderId: 'user-2',
        senderName: 'Bob',
        body: 'reply 1',
        channelSeq: 2n,
        threadSeq: 1n,
        threadRootMessageId: 'root-1',
        mentionedUserIds: [],
        mentionEveryone: false,
        createdAt: '2026-03-06T00:01:00Z',
        reactions: [],
        myReactions: [],
      },
      {
        id: 'reply-2',
        channelId: 'channel-1',
        senderId: 'user-2',
        senderName: 'Bob',
        body: 'reply 2',
        channelSeq: 3n,
        threadSeq: 2n,
        threadRootMessageId: 'root-1',
        mentionedUserIds: [],
        mentionEveryone: false,
        createdAt: '2026-03-06T00:02:00Z',
        reactions: [],
        myReactions: [],
      },
    ]
    await nextTick()

    const focusedReply = wrapper.get('[data-thread-message-id="reply-2"]').element as HTMLElement
    const scrollIntoView = vi.fn()
    Object.defineProperty(focusedReply, 'scrollIntoView', {
      value: scrollIntoView,
      configurable: true,
    })

    await nextTick()
    vi.runAllTimers()
    await nextTick()

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' })
    expect(el.scrollTop).toBe(0)
  })

  it('scrolls to bottom when switching from a focused thread to a different thread', async () => {
    vi.useFakeTimers()

    const chat = useChatStore()
    const ws = useWsStore()
    ws.state = 'LIVE_SYNCED'

    chat.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chat.activeThreadConversationId = 'channel-1'
    chat.activeThreadRootId = 'root-1'
    chat.focusedThreadMessageId = 'reply-1'
    chat.threadReplayVersionByRoot = { 'root-1': 1, 'root-2': 0 }
    chat.messages = {
      'channel-1': [
        {
          id: 'root-1',
          channelId: 'channel-1',
          senderId: 'user-1',
          senderName: 'Ada',
          body: 'root 1',
          channelSeq: 1n,
          threadSeq: 0n,
          mentionedUserIds: [],
          mentionEveryone: false,
          createdAt: '2026-03-06T00:00:00Z',
          reactions: [],
          myReactions: [],
        },
        {
          id: 'root-2',
          channelId: 'channel-1',
          senderId: 'user-1',
          senderName: 'Ada',
          body: 'root 2',
          channelSeq: 2n,
          threadSeq: 0n,
          mentionedUserIds: [],
          mentionEveryone: false,
          createdAt: '2026-03-06T00:03:00Z',
          reactions: [],
          myReactions: [],
        },
      ],
    }
    chat.threadMessages = {
      'root-1': [
        {
          id: 'reply-1',
          channelId: 'channel-1',
          senderId: 'user-2',
          senderName: 'Bob',
          body: 'reply 1',
          channelSeq: 3n,
          threadSeq: 1n,
          threadRootMessageId: 'root-1',
          mentionedUserIds: [],
          mentionEveryone: false,
          createdAt: '2026-03-06T00:01:00Z',
          reactions: [],
          myReactions: [],
        },
      ],
      'root-2': [],
    }

    const wrapper = mount(ThreadPanel, {
      global: {
        stubs: {
          MessageBubble: true,
          MessageInput: true,
        },
      },
    })

    const el = wrapper.find('.overflow-y-auto').element as HTMLDivElement
    Object.defineProperty(el, 'scrollHeight', {
      configurable: true,
      get: () => chat.activeThreadRootId === 'root-2' && chat.threadMessages['root-2']?.length
        ? 2600
        : 500,
    })
    Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true })

    chat.focusedThreadMessageId = ''
    chat.activeThreadRootId = 'root-2'
    await nextTick()
    vi.advanceTimersByTime(500)
    await nextTick()

    chat.threadMessages = {
      ...chat.threadMessages,
      'root-2': [
        {
          id: 'reply-2',
          channelId: 'channel-1',
          senderId: 'user-3',
          senderName: 'Carol',
          body: 'reply 2',
          channelSeq: 4n,
          threadSeq: 1n,
          threadRootMessageId: 'root-2',
          mentionedUserIds: [],
          mentionEveryone: false,
          createdAt: '2026-03-06T00:04:00Z',
          reactions: [],
          myReactions: [],
        },
      ],
    }
    chat.threadReplayVersionByRoot = { 'root-1': 1, 'root-2': 1 }

    await nextTick()
    vi.runAllTimers()
    await nextTick()

    expect(el.scrollTop).toBe(2600)
  })
})
