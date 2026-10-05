import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { create } from '@bufbuild/protobuf'
import { EventType, MessageEventSchema, NotificationLevel, ServerEventSchema, SubscribeThreadResponseSchema } from '@/shared/proto/packets_pb'
import ThreadWorkspace from '@/components/ThreadWorkspace.vue'
import { useAuthStore } from '@/stores/auth'
import { useChatStore } from '@/stores/chat'
import { useWsStore } from '@/stores/ws'

describe('ThreadWorkspace', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      value: vi.fn(),
      configurable: true,
      writable: true,
    })
  })

  it('renders live bot replies in a hidden thread without adding a sidebar conversation', async () => {
    const chat = useChatStore()
    const ws = useWsStore()
    chat.bootstrapped = true
    ws.state = 'LIVE_SYNCED'
    chat.registerUserIdentity('bot-id', 'Bot', undefined, '/bot.png')
    chat.messages = { hidden: [{
      id: 'hidden-root', channelId: 'hidden', senderId: 'bot-id', senderName: 'Bot',
      senderAvatarUrl: '/bot.png', body: 'task comment', channelSeq: 1n, threadSeq: 0n,
      mentionedUserIds: [], mentionEveryone: false, createdAt: '2026-09-29T12:00:00Z',
      reactions: [], myReactions: [],
    }] }
    vi.spyOn(chat, 'ensureConversationHistory').mockResolvedValue(undefined)
    vi.spyOn(ws, 'sendSubscribeThread').mockReturnValue(true)
    const wrapper = mount(ThreadWorkspace, {
      props: { conversationId: 'hidden', rootMessageId: 'hidden-root', mode: 'pinned' },
      global: { stubs: {
        MessageBubble: { props: ['message'], template: '<div data-testid="thread-message" :data-avatar="message.senderAvatarUrl">{{ message.senderName }}: {{ message.body }}</div>' },
        MessageInput: true,
      } },
    })
    await flushPromises()
    expect(ws.sendSubscribeThread).toHaveBeenCalledWith('hidden', 'hidden-root', 0n)
    const event = create(ServerEventSchema, {
      eventSeq: 1n, eventId: 'hidden-reply-event', eventType: EventType.MESSAGE_CREATED,
      conversationId: 'hidden', payload: { case: 'messageCreated', value: create(MessageEventSchema, {
        conversationId: 'hidden', messageId: 'bot-reply', senderId: 'bot-id', body: 'live bot reply',
        channelSeq: 2n, threadSeq: 1n, threadRootMessageId: 'hidden-root',
      }) },
    })
    chat.handleServerEvent(event)
    chat.handleServerEvent(event)
    await flushPromises()
    const messages = wrapper.findAll('[data-testid="thread-message"]')
    expect(messages).toHaveLength(2)
    expect(messages[1].text()).toBe('Bot: live bot reply')
    expect(messages[1].attributes('data-avatar')).toBe('/bot.png')
    expect(chat.channels).toEqual([])
    wrapper.unmount()
    chat.resetRuntimeState()
    vi.restoreAllMocks()
  })

  it('keeps the mounted pinned thread active while sending in another main DM, and deactivates on close', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const chat = useChatStore()
    const ws = useWsStore()
    ws.state = 'LIVE_SYNCED'
    chat.bootstrapped = true
    chat.setClientActive(true)
    useAuthStore().user = { id: 'user-1', email: 'ada@example.com', displayName: 'Ada', role: 'member' }
    chat.directMessages = ['dm-thread', 'dm-main'].map(id => ({
      id, userId: `user-${id}`, displayName: id, presence: 'online' as const,
      unread: 0, notificationLevel: NotificationLevel.ALL,
    }))
    chat.messages = { 'dm-thread': [{
      id: 'root-1', channelId: 'dm-thread', senderId: 'user-2', senderName: 'Bob', body: 'root',
      channelSeq: 1n, threadSeq: 0n, mentionedUserIds: [], mentionEveryone: false,
      createdAt: '2026-03-06T00:00:00Z', reactions: [], myReactions: [],
    }] }
    vi.spyOn(chat, 'ensureConversationHistory').mockResolvedValue(undefined)
    vi.spyOn(ws, 'sendSubscribeThread').mockReturnValue(true)
    vi.spyOn(ws, 'sendMessage').mockReturnValue(true)
    const wrapper = mount(ThreadWorkspace, {
      props: { conversationId: 'dm-thread', rootMessageId: 'root-1', mode: 'pinned' },
      global: { plugins: [pinia], stubs: {
        MessageBubble: { props: ['message'], template: '<div>{{ message.body }}</div>' },
        MessageInput: true,
      } },
    })
    try {
      await flushPromises()
      await chat.selectChannel('dm-main')
      chat.openDirectMessage(chat.directMessages[1])
      chat.sendMessageToConversation('dm-main', 'main DM message')
      chat.handleServerEvent(create(ServerEventSchema, {
        eventSeq: 1n, eventId: 'pinned-reply-while-composing',
        payload: { case: 'messageCreated', value: create(MessageEventSchema, {
          conversationId: 'dm-thread', messageId: 'reply-1', senderId: 'user-2', body: 'visible reply',
          channelSeq: 2n, threadSeq: 1n, threadRootMessageId: 'root-1',
        }) },
      }))
      await nextTick()

      expect(wrapper.text()).toContain('visible reply')
      expect(chat.activeChannelId).toBe('dm-main')
      expect(chat.activeThreadConversationId).toBe('dm-thread')
      expect(chat.activeThreadRootId).toBe('root-1')
      expect(ws.sendSubscribeThread).toHaveBeenCalledWith('dm-thread', 'root-1', 1n)
    } finally {
      wrapper.unmount()
      expect(chat.isThreadPanelOpen).toBe(false)
      chat.resetRuntimeState()
      vi.restoreAllMocks()
    }
  })

  it('does not auto-scroll new replies when user is away from bottom', async () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.state = 'LIVE_SYNCED'
    chat.channels = [{
      id: 'channel-1',
      name: 'qa',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
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

    const wrapper = mount(ThreadWorkspace, {
      props: {
        conversationId: 'channel-1',
        rootMessageId: 'root-1',
      },
      global: {
        stubs: {
          MessageBubble: true,
          MessageInput: true,
        },
      },
    })

    const el = wrapper.find('.overflow-y-auto').element as HTMLDivElement
    Object.defineProperty(el, 'scrollHeight', { value: 2000, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: 400, configurable: true })
    el.scrollTop = 900
    await wrapper.find('.overflow-y-auto').trigger('scroll')

    chat.threadMessages = {
      'root-1': [
        ...chat.threadMessages['root-1'],
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
          createdAt: '2026-03-06T00:00:02Z',
          reactions: [],
          myReactions: [],
        },
      ],
    }

    await nextTick()

    expect(el.scrollTop).toBe(900)
  })

  it('does not force bottom on composer resize when user is away from bottom', async () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.state = 'LIVE_SYNCED'
    chat.channels = [{
      id: 'channel-1',
      name: 'qa',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
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

    const wrapper = mount(ThreadWorkspace, {
      props: {
        conversationId: 'channel-1',
        rootMessageId: 'root-1',
      },
      global: {
        stubs: {
          MessageBubble: true,
          MessageInput: {
            emits: ['resize'],
            template: '<button data-testid="resize" @click="$emit(\'resize\', 40)">resize</button>',
          },
        },
      },
    })

    const el = wrapper.find('.overflow-y-auto').element as HTMLDivElement
    Object.defineProperty(el, 'scrollHeight', { value: 2000, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: 400, configurable: true })
    el.scrollTop = 900
    await wrapper.find('.overflow-y-auto').trigger('scroll')
    await wrapper.get('[data-testid="resize"]').trigger('click')

    expect(el.scrollTop).toBe(900)
  })

  it('scrolls and highlights a focused thread reply', async () => {
    const scrollSpy = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      value: scrollSpy,
      configurable: true,
      writable: true,
    })

    const chat = useChatStore()
    const ws = useWsStore()
    ws.state = 'LIVE_SYNCED'
    chat.ensureConversationHistory = vi.fn().mockResolvedValue(undefined)
    chat.loadMessageContext = vi.fn().mockResolvedValue(undefined)
    chat.channels = [{
      id: 'channel-1',
      name: 'qa',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
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
        body: 'focused reply',
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
    chat.focusedThreadMessageId = 'reply-1'

    const wrapper = mount(ThreadWorkspace, {
      props: {
        conversationId: 'channel-1',
        rootMessageId: 'root-1',
      },
      global: {
        stubs: {
          MessageBubble: true,
          MessageInput: true,
        },
      },
    })
    await nextTick()
    await nextTick()

    const reply = wrapper.get('[data-thread-message-id="reply-1"]')
    expect(reply.classes()).toContain('bg-amber-500/10')
    expect(scrollSpy).toHaveBeenCalledWith({ block: 'center' })
  })

  it('activates the mounted thread workspace and only deactivates its own active thread', async () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.sendSubscribeThread = vi.fn()
    chat.ensureConversationHistory = vi.fn().mockResolvedValue(undefined)
    chat.loadMessageContext = vi.fn().mockResolvedValue(undefined)
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
          senderId: 'user-2',
          senderName: 'Bob',
          body: 'root 2',
          channelSeq: 2n,
          threadSeq: 0n,
          mentionedUserIds: [],
          mentionEveryone: false,
          createdAt: '2026-03-06T00:00:01Z',
          reactions: [],
          myReactions: [],
        },
      ],
    }

    const wrapper = mount(ThreadWorkspace, {
      props: {
        conversationId: 'channel-1',
        rootMessageId: 'root-1',
      },
      global: {
        stubs: {
          MessageBubble: true,
          MessageInput: true,
        },
      },
    })
    await nextTick()
    await nextTick()

    expect(chat.activeThreadConversationId).toBe('channel-1')
    expect(chat.activeThreadRootId).toBe('root-1')
    expect(ws.sendSubscribeThread).toHaveBeenCalledWith('channel-1', 'root-1', 0n)

    chat.activateThreadWorkspace('channel-1', 'root-2')
    wrapper.unmount()

    expect(chat.activeThreadConversationId).toBe('channel-1')
    expect(chat.activeThreadRootId).toBe('root-2')
  })

  it('shows replay loading and retry states when replies are missing', async () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.state = 'LIVE_SYNCED'
    ws.sendSubscribeThread = vi.fn().mockReturnValue(true)
    chat.ensureConversationHistory = vi.fn().mockResolvedValue(undefined)
    chat.loadMessageContext = vi.fn().mockResolvedValue(undefined)
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
    chat.threadSummaries = {
      'root-1': { replyCount: 7, lastThreadSeq: 7n },
    }

    const wrapper = mount(ThreadWorkspace, {
      props: {
        conversationId: 'channel-1',
        rootMessageId: 'root-1',
      },
      global: {
        stubs: {
          MessageBubble: true,
          MessageInput: true,
        },
      },
    })
    await nextTick()
    await nextTick()

    expect(wrapper.text()).toContain('Loading replies...')
    expect(wrapper.text()).not.toContain('Be the first to reply')

    const incompleteResponse = create(SubscribeThreadResponseSchema, {
      conversationId: 'channel-1',
      threadRootMessageId: 'root-1',
      currentThreadSeq: 7n,
      replyCount: 7,
      replay: [],
    })
    chat.handleSubscribeThreadResponse(incompleteResponse)
    chat.handleSubscribeThreadResponse(incompleteResponse)
    await nextTick()

    expect(wrapper.text()).toContain('Replies could not be loaded.')
    const retry = wrapper.get('[data-testid="thread-replay-retry"]')
    await retry.trigger('click')

    expect(ws.sendSubscribeThread).toHaveBeenLastCalledWith('channel-1', 'root-1', 0n)
    wrapper.unmount()
  })

  it('requests inline edit for the latest editable own thread reply', async () => {
    const auth = useAuthStore()
    const chat = useChatStore()
    const ws = useWsStore()
    auth.user = { id: 'user-1', email: 'u1@example.com', displayName: 'U1', role: 'member' }
    ws.state = 'LIVE_SYNCED'
    chat.ensureConversationHistory = vi.fn().mockResolvedValue(undefined)
    chat.loadMessageContext = vi.fn().mockResolvedValue(undefined)
    chat.channels = [{
      id: 'channel-1',
      name: 'qa',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
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
          id: 'reply-pending',
          channelId: 'channel-1',
          senderId: 'user-1',
          senderName: 'U1',
          body: 'pending',
          channelSeq: 0n,
          threadSeq: 3n,
          threadRootMessageId: 'root-1',
          mentionedUserIds: [],
          mentionEveryone: false,
          createdAt: '2026-03-06T00:00:03Z',
          reactions: [],
          myReactions: [],
          pending: true,
        },
      ],
    }

    const wrapper = mount(ThreadWorkspace, {
      props: {
        conversationId: 'channel-1',
        rootMessageId: 'root-1',
      },
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

    await nextTick()
    await wrapper.get('[data-testid="edit-last"]').trigger('click')
    await nextTick()

    expect(wrapper.get('[data-id="root-1"]').attributes('data-edit-token')).toBeUndefined()
    expect(wrapper.get('[data-id="reply-own"]').attributes('data-edit-token')).toBe('1')
    expect(wrapper.get('[data-id="reply-other"]').attributes('data-edit-token')).toBe('0')
    expect(wrapper.get('[data-id="reply-pending"]').attributes('data-edit-token')).toBe('0')
  })
})
