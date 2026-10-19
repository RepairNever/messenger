import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick, ref } from 'vue'
import { NotificationLevel } from '@/shared/proto/packets_pb'
import ChatArea from '@/components/ChatArea.vue'
import { useAuthStore } from '@/stores/auth'
import { useChatStore, type Message } from '@/stores/chat'
import { useCallStore } from '@/stores/call'
import { usePinnedDialogsStore } from '@/stores/pinnedDialogs'
import { useWsStore } from '@/stores/ws'
import { useOfflineQueue } from '@/composables/useOfflineQueue'
import * as dmE2ee from '@/services/e2ee/dmE2ee'

const cacheMocks = vi.hoisted(() => ({
  cacheConversations: vi.fn().mockResolvedValue(undefined),
  enqueueOutbound: vi.fn(),
  loadOutboundQueue: vi.fn(),
  removeOutbound: vi.fn(),
  clearOutboundQueue: vi.fn(),
}))

vi.mock('@/services/http/chatApi', () => ({
  listMessageReactionUsers: vi.fn(),
  listSavedMessages: vi.fn(),
  saveMessage: vi.fn(),
  unsaveMessage: vi.fn(),
}))

vi.mock('@/services/db/cache', () => cacheMocks)

async function flushAll() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve()
  }
  await nextTick()
}

async function flushFrames() {
  await Promise.resolve()
  await nextTick()
  await new Promise(resolve => requestAnimationFrame(() => resolve(null)))
  await new Promise(resolve => requestAnimationFrame(() => resolve(null)))
  await nextTick()
}

function buildMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'message-1',
    channelId: 'channel-1',
    senderId: 'user-1',
    senderName: 'Ada',
    body: 'hello',
    channelSeq: 1n,
    threadSeq: 0n,
    mentionedUserIds: [],
    mentionEveryone: false,
    createdAt: '2026-03-06T00:00:00Z',
    reactions: [],
    myReactions: [],
    ...overrides,
  }
}

describe('ChatArea', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    cacheMocks.enqueueOutbound.mockResolvedValue(true)
    useOfflineQueue().clear()
    class TestResizeObserver {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    }
    Object.defineProperty(globalThis, 'ResizeObserver', {
      value: TestResizeObserver,
      configurable: true,
    })
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      value: vi.fn(),
      configurable: true,
      writable: true,
    })
    const wsStore = useWsStore()
    wsStore.requestActiveCallMembers = vi.fn().mockResolvedValue({ members: [] })
    wsStore.requestConversationMembers = vi.fn().mockResolvedValue({ members: [] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends a message using bootstrap self identity when auth user is not hydrated', async () => {
    const authStore = useAuthStore()
    const chatStore = useChatStore()
    const wsStore = useWsStore()

    authStore.user = null
    chatStore.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfAvatarUrl: '/api/public/avatars/avatars/user-1/avatar.png',
      selfRole: 'member',
    }
    chatStore.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chatStore.activeChannelId = 'channel-1'
    wsStore.state = 'LIVE_SYNCED'
    wsStore.sendMessage = vi.fn()
    chatStore.addOptimisticMessage = vi.fn()
    let commitOutbound: ((persisted: boolean) => void) | undefined
    cacheMocks.enqueueOutbound.mockReturnValue(new Promise<boolean>(resolve => {
      commitOutbound = resolve
    }))

    const wrapper = mount(ChatArea, {
      global: {
        stubs: {
          MessageBubble: true,
          MessageInput: {
            template: '<button data-testid="emit-send" @click="$emit(\'send\', \'hello world\')">send</button>',
          },
        },
      },
    })

    await wrapper.get('[data-testid="emit-send"]').trigger('click')
    await vi.waitFor(() => expect(cacheMocks.enqueueOutbound).toHaveBeenCalledTimes(1))

    expect(wsStore.sendMessage).not.toHaveBeenCalled()
    expect(commitOutbound).toBeTypeOf('function')
    commitOutbound!(true)
    await vi.waitFor(() => expect(wsStore.sendMessage).toHaveBeenCalledTimes(1))

    expect(chatStore.addOptimisticMessage).toHaveBeenCalledWith(expect.objectContaining({
      channelId: 'channel-1',
      senderId: 'user-1',
      senderName: 'Ada',
      senderAvatarUrl: '/api/public/avatars/avatars/user-1/avatar.png',
      body: 'hello world',
      sendStatus: 'sending',
    }))
    expect(wsStore.sendMessage).toHaveBeenCalledWith('channel-1', 'hello world', expect.any(String), undefined, [])
  })

  it('keeps uploaded thumbnail metadata on the optimistic message', async () => {
    const authStore = useAuthStore()
    const chatStore = useChatStore()
    const wsStore = useWsStore()

    authStore.user = {
      id: 'user-1',
      displayName: 'Ada',
      email: 'ada@example.com',
      avatarUrl: '',
      role: 'member',
    }
    chatStore.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chatStore.activeChannelId = 'channel-1'
    wsStore.state = 'LIVE_SYNCED'
    wsStore.sendMessage = vi.fn(() => true)
    chatStore.addOptimisticMessage = vi.fn()

    const wrapper = mount(ChatArea, {
      global: {
        stubs: {
          MessageBubble: true,
          MessageInput: {
            template: `<button
              data-testid="emit-image-send"
              @click="$emit('send', {
                body: '',
                entities: [],
                attachmentIds: ['attachment-1'],
                attachments: [{
                  id: 'attachment-1',
                  fileName: 'photo.jpg',
                  fileSize: 2048,
                  mimeType: 'image/jpeg',
                  thumbnailMimeType: 'image/jpeg',
                  thumbnailFileSize: 256,
                  thumbnailVersion: 1,
                }],
              })"
            >send</button>`,
          },
        },
      },
    })

    await wrapper.get('[data-testid="emit-image-send"]').trigger('click')
    await flushAll()

    expect(chatStore.addOptimisticMessage).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [{
        id: 'attachment-1',
        fileName: 'photo.jpg',
        fileSize: 2048,
        mimeType: 'image/jpeg',
        thumbnailMimeType: 'image/jpeg',
        thumbnailFileSize: 256,
        thumbnailVersion: 1,
      }],
    }))
  })

  it('does not auto-encrypt a normal plaintext direct message', async () => {
    const authStore = useAuthStore()
    const chatStore = useChatStore()
    const wsStore = useWsStore()

    authStore.user = {
      id: 'user-1',
      displayName: 'Ada',
      email: 'ada@example.com',
      avatarUrl: '',
      role: 'member',
    }
    chatStore.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfAvatarUrl: '',
      selfRole: 'member',
    }
    chatStore.directMessages = [{
      id: 'dm-plain-1',
      userId: 'user-2',
      displayName: 'Bob',
      presence: 'offline',
      encryptionMode: 'none',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chatStore.activeChannelId = 'dm-plain-1'
    wsStore.state = 'LIVE_SYNCED'
    wsStore.sendMessage = vi.fn(() => true)
    chatStore.addOptimisticMessage = vi.fn()
    const markEncrypted = vi.spyOn(chatStore, 'markDirectMessageEncrypted')

    const wrapper = mount(ChatArea, {
      global: {
        stubs: {
          MessageBubble: true,
          MessageInput: {
            template: '<button data-testid="emit-send" @click="$emit(\'send\', { body: \'plain dm\', entities: [], attachmentIds: [], attachments: [] })">send</button>',
          },
        },
      },
    })

    await wrapper.get('[data-testid="emit-send"]').trigger('click')
    await flushAll()

    expect(markEncrypted).not.toHaveBeenCalled()
    expect(chatStore.addOptimisticMessage).toHaveBeenCalledWith(expect.objectContaining({
      channelId: 'dm-plain-1',
      body: 'plain dm',
      contentMode: 'plaintext',
    }))
    expect(wsStore.sendMessage).toHaveBeenCalledWith('dm-plain-1', 'plain dm', expect.any(String), undefined, [])
  })

  it('passes the conversation focus token to the main composer', () => {
    const chatStore = useChatStore()

    chatStore.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chatStore.activeChannelId = 'channel-1'
    chatStore.conversationComposerFocusToken = 7

    const wrapper = mount(ChatArea, {
      global: {
        stubs: {
          MessageBubble: true,
          MessageInput: {
            props: ['focusToken'],
            template: '<div data-testid="composer-focus-token">{{ focusToken }}</div>',
          },
        },
      },
    })

    expect(wrapper.get('[data-testid="composer-focus-token"]').text()).toBe('7')
  })

  it('passes the conversation draft scope to the main composer', () => {
    const chatStore = useChatStore()

    chatStore.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chatStore.activeChannelId = 'channel-1'

    const wrapper = mount(ChatArea, {
      global: {
        stubs: {
          MessageBubble: true,
          MessageInput: {
            props: ['draftScope'],
            template: '<div data-testid="composer-draft-scope">{{ JSON.stringify(draftScope) }}</div>',
          },
        },
      },
    })

    expect(wrapper.get('[data-testid="composer-draft-scope"]').text()).toBe(JSON.stringify({
      kind: 'conversation',
      conversationId: 'channel-1',
    }))
  })

  it('requests inline edit for the latest editable own conversation message', async () => {
    const authStore = useAuthStore()
    const chatStore = useChatStore()

    authStore.user = { id: 'user-1', email: 'u1@example.com', displayName: 'U1', role: 'member' }
    chatStore.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chatStore.activeChannelId = 'channel-1'
    chatStore.messages = {
      'channel-1': [
        {
          id: 'own-confirmed',
          channelId: 'channel-1',
          senderId: 'user-1',
          senderName: 'U1',
          body: 'editable',
          channelSeq: 1n,
          threadSeq: 0n,
          mentionedUserIds: [],
          mentionEveryone: false,
          createdAt: '2026-03-06T00:00:00Z',
          reactions: [],
          myReactions: [],
        },
        {
          id: 'other-later',
          channelId: 'channel-1',
          senderId: 'user-2',
          senderName: 'Bob',
          body: 'not mine',
          channelSeq: 2n,
          threadSeq: 0n,
          mentionedUserIds: [],
          mentionEveryone: false,
          createdAt: '2026-03-06T00:01:00Z',
          reactions: [],
          myReactions: [],
        },
        {
          id: 'own-sending',
          channelId: 'channel-1',
          senderId: 'user-1',
          senderName: 'U1',
          body: 'sending',
          channelSeq: 0n,
          threadSeq: 0n,
          mentionedUserIds: [],
          mentionEveryone: false,
          createdAt: '2026-03-06T00:02:00Z',
          reactions: [],
          myReactions: [],
          sendStatus: 'sending',
        },
      ],
    }

    const wrapper = mount(ChatArea, {
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
    await flushAll()

    expect(wrapper.get('[data-id="own-confirmed"]').attributes('data-edit-token')).toBe('1')
    expect(wrapper.get('[data-id="other-later"]').attributes('data-edit-token')).toBe('0')
    expect(wrapper.get('[data-id="own-sending"]').attributes('data-edit-token')).toBe('0')
  })

  it('sends a message when self display name is empty', async () => {
    const authStore = useAuthStore()
    const chatStore = useChatStore()
    const wsStore = useWsStore()

    authStore.user = {
      id: 'user-1',
      displayName: '',
      email: 'user1@example.com',
      avatarUrl: '/api/public/avatars/avatars/user-1/auth-avatar.png',
      role: 'member',
    }
    chatStore.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chatStore.activeChannelId = 'channel-1'
    wsStore.state = 'LIVE_SYNCED'
    wsStore.sendMessage = vi.fn()
    chatStore.addOptimisticMessage = vi.fn()

    const wrapper = mount(ChatArea, {
      global: {
        stubs: {
          MessageBubble: true,
          MessageInput: {
            template: '<button data-testid="emit-send" @click="$emit(\'send\', \'hello world\')">send</button>',
          },
        },
      },
    })

    await wrapper.get('[data-testid="emit-send"]').trigger('click')
    await flushAll()

    expect(chatStore.addOptimisticMessage).toHaveBeenCalledWith(expect.objectContaining({
      channelId: 'channel-1',
      senderId: 'user-1',
      senderName: 'user1@example.com',
      senderAvatarUrl: '/api/public/avatars/avatars/user-1/auth-avatar.png',
      body: 'hello world',
      sendStatus: 'sending',
    }))
    expect(wsStore.sendMessage).toHaveBeenCalledWith('channel-1', 'hello world', expect.any(String), undefined, [])
  })

  it('renders the active direct message title when a dm is selected', () => {
    const chatStore = useChatStore()

    chatStore.directMessages = [{
      id: 'dm-1',
      userId: 'user-2',
      displayName: 'Bob',
      presence: 'online',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chatStore.activeChannelId = 'dm-1'

    const wrapper = mount(ChatArea, {
      global: {
        stubs: {
          MessageBubble: true,
          MessageInput: true,
        },
      },
    })

    expect(wrapper.text()).toContain('Bob')
  })

  it('toggles current conversation pin from header button', async () => {
    const chatStore = useChatStore()
    const pinnedStore = usePinnedDialogsStore()

    chatStore.directMessages = [{
      id: 'dm-1',
      userId: 'user-2',
      displayName: 'Bob',
      presence: 'online',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chatStore.activeChannelId = 'dm-1'

    const wrapper = mount(ChatArea, {
      global: {
        stubs: {
          MessageBubble: true,
          MessageInput: true,
        },
      },
    })

    await wrapper.get('[data-testid="pin-conversation-button"]').trigger('click')
    expect(pinnedStore.items.map(item => item.id)).toEqual(['dm:dm-1'])

    await wrapper.get('[data-testid="pin-conversation-button"]').trigger('click')
    expect(pinnedStore.items).toEqual([])
    expect(pinnedStore.activeId).toBeNull()
  })

  it('passes derived thread reply count after refresh when thread summary is not loaded yet', () => {
    const chatStore = useChatStore()
    const wsStore = useWsStore()
    wsStore.state = 'LIVE_SYNCED'
    chatStore.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chatStore.activeChannelId = 'channel-1'
    chatStore.messages = {
      'channel-1': [
        {
          id: 'root-1',
          channelId: 'channel-1',
          senderId: 'user-1',
          senderName: 'Ada',
          body: 'Root',
          channelSeq: 1n,
          threadSeq: 0n,
          mentionedUserIds: [],
          mentionEveryone: false,
          createdAt: '2026-03-06T00:00:00Z',
          reactions: [],
          myReactions: [],
        },
        {
          id: 'reply-1',
          channelId: 'channel-1',
          senderId: 'user-2',
          senderName: 'Bob',
          body: 'Reply',
          channelSeq: 2n,
          threadSeq: 1n,
          threadRootMessageId: 'root-1',
          mentionedUserIds: [],
          mentionEveryone: false,
          createdAt: '2026-03-06T00:01:00Z',
          reactions: [],
          myReactions: [],
        },
      ],
    }
    chatStore.threadSummaries = {}

    const wrapper = mount(ChatArea, {
      global: {
        stubs: {
          MessageBubble: {
            props: ['message', 'threadReplyCount'],
            template: '<div class="msg" :data-id="message.id" :data-replies="threadReplyCount"></div>',
          },
          MessageInput: true,
        },
      },
    })

    const rootNode = wrapper.find('[data-id="root-1"]')
    expect(rootNode.exists()).toBe(true)
    expect(rootNode.attributes('data-replies')).toBe('1')
  })

  it('forces scroll to bottom when sending a long message', async () => {
    const authStore = useAuthStore()
    const chatStore = useChatStore()
    const wsStore = useWsStore()

    authStore.user = null
    chatStore.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfRole: 'member',
    }
    chatStore.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chatStore.activeChannelId = 'channel-1'
    chatStore.messages = {
      'channel-1': [{
        id: 'message-1',
        channelId: 'channel-1',
        senderId: 'user-2',
        senderName: 'Bob',
        body: 'existing',
        channelSeq: 1n,
        threadSeq: 0n,
        mentionedUserIds: [],
        mentionEveryone: false,
        createdAt: '2026-03-06T00:00:00Z',
        reactions: [],
        myReactions: [],
      }],
    }
    wsStore.state = 'LIVE_SYNCED'
    wsStore.sendMessage = vi.fn()

    const wrapper = mount(ChatArea, {
      global: {
        stubs: {
          MessageBubble: true,
          MessageInput: {
            template: '<button data-testid="emit-send" @click="$emit(\'send\', longText)">send</button>',
            data: () => ({ longText: 'x'.repeat(2000) }),
          },
        },
      },
    })

    const el = wrapper.find('.overflow-y-auto').element as HTMLDivElement
    Object.defineProperty(el, 'scrollHeight', { value: 2000, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: 500, configurable: true })
    el.scrollTop = 100

    await wrapper.get('[data-testid="emit-send"]').trigger('click')
    await flushAll()

    expect(el.scrollTop).toBe(2000)
    expect(wsStore.sendMessage).toHaveBeenCalledWith('channel-1', expect.any(String), expect.any(String), undefined, [])
  })

  it('loads older history when scrolled near top', async () => {
    const chatStore = useChatStore()
    const wsStore = useWsStore()
    wsStore.state = 'LIVE_SYNCED'
    chatStore.loadOlderConversationHistory = vi.fn().mockResolvedValue(1)
    chatStore.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chatStore.activeChannelId = 'channel-1'
    chatStore.messages = {
      'channel-1': [{
        id: 'message-1',
        channelId: 'channel-1',
        senderId: 'user-1',
        senderName: 'Ada',
        body: 'hello',
        channelSeq: 1n,
        threadSeq: 0n,
        mentionedUserIds: [],
        mentionEveryone: false,
        createdAt: '2026-03-06T00:00:00Z',
        reactions: [],
        myReactions: [],
      }],
    }

    const wrapper = mount(ChatArea, {
      global: {
        stubs: {
          MessageBubble: true,
          MessageInput: true,
        },
      },
    })

    const el = wrapper.find('.overflow-y-auto').element as HTMLDivElement
    Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true })
    el.scrollTop = 40

    await wrapper.find('.overflow-y-auto').trigger('scroll')
    await Promise.resolve()

    expect(chatStore.loadOlderConversationHistory).toHaveBeenCalledWith('channel-1')
  })

  it('re-arms top history preload only after leaving threshold zone', async () => {
    const chatStore = useChatStore()
    const wsStore = useWsStore()
    wsStore.state = 'LIVE_SYNCED'
    chatStore.loadOlderConversationHistory = vi.fn().mockResolvedValue(1)
    chatStore.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chatStore.activeChannelId = 'channel-1'
    chatStore.messages = {
      'channel-1': [{
        id: 'message-1',
        channelId: 'channel-1',
        senderId: 'user-1',
        senderName: 'Ada',
        body: 'hello',
        channelSeq: 1n,
        threadSeq: 0n,
        mentionedUserIds: [],
        mentionEveryone: false,
        createdAt: '2026-03-06T00:00:00Z',
        reactions: [],
        myReactions: [],
      }],
    }

    const wrapper = mount(ChatArea, {
      global: {
        stubs: {
          MessageBubble: true,
          MessageInput: true,
        },
      },
    })

    const el = wrapper.find('.overflow-y-auto').element as HTMLDivElement
    Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true })

    el.scrollTop = 40
    await wrapper.find('.overflow-y-auto').trigger('scroll')
    await Promise.resolve()
    expect(chatStore.loadOlderConversationHistory).toHaveBeenCalledTimes(1)

    el.scrollTop = 30
    await wrapper.find('.overflow-y-auto').trigger('scroll')
    await Promise.resolve()
    expect(chatStore.loadOlderConversationHistory).toHaveBeenCalledTimes(1)

    el.scrollTop = 240
    await wrapper.find('.overflow-y-auto').trigger('scroll')
    await Promise.resolve()

    el.scrollTop = 40
    await wrapper.find('.overflow-y-auto').trigger('scroll')
    await Promise.resolve()
    expect(chatStore.loadOlderConversationHistory).toHaveBeenCalledTimes(2)
  })

  it('shows spinner at top while loading older history', async () => {
    const chatStore = useChatStore()
    const wsStore = useWsStore()
    wsStore.state = 'LIVE_SYNCED'

    const deferredLoad: { resolve?: (value: number) => void } = {}
    chatStore.loadOlderConversationHistory = vi.fn().mockImplementation(() =>
      new Promise<number>((resolve) => {
        deferredLoad.resolve = resolve
      })
    )
    chatStore.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chatStore.activeChannelId = 'channel-1'
    chatStore.messages = {
      'channel-1': [{
        id: 'message-1',
        channelId: 'channel-1',
        senderId: 'user-1',
        senderName: 'Ada',
        body: 'hello',
        channelSeq: 1n,
        threadSeq: 0n,
        mentionedUserIds: [],
        mentionEveryone: false,
        createdAt: '2026-03-06T00:00:00Z',
        reactions: [],
        myReactions: [],
      }],
    }

    const wrapper = mount(ChatArea, {
      global: {
        stubs: {
          MessageBubble: true,
          MessageInput: true,
        },
      },
    })

    const el = wrapper.find('.overflow-y-auto').element as HTMLDivElement
    Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true })
    el.scrollTop = 40

    await wrapper.find('.overflow-y-auto').trigger('scroll')
    await nextTick()

    expect(wrapper.find('[data-testid="history-loading-spinner"]').exists()).toBe(true)

    deferredLoad.resolve?.(1)
  })

  it('shows centered overlay while initial conversation history is loading', () => {
    const chatStore = useChatStore()
    const wsStore = useWsStore()
    wsStore.state = 'LIVE_SYNCED'
    chatStore.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chatStore.activeChannelId = 'channel-1'
    chatStore.messages = { 'channel-1': [] }
    chatStore.isConversationInitialLoading = vi.fn().mockReturnValue(true)

    const wrapper = mount(ChatArea, {
      global: {
        stubs: {
          MessageBubble: true,
          MessageInput: true,
        },
      },
    })

    expect(wrapper.find('[data-testid="conversation-loading-overlay"]').exists()).toBe(true)
  })

  it('keeps short recovery silent and shows nonblocking status with retry for slow or failed recovery', async () => {
    vi.useFakeTimers()
    const chat = useChatStore()
    chat.directMessages = [{ id: 'dm-1', userId: 'user-2', displayName: 'Bob', presence: 'online', unread: 0, notificationLevel: NotificationLevel.ALL }]
    chat.activeChannelId = 'dm-1'
    chat.messages = { 'dm-1': [buildMessage({ channelId: 'dm-1' })] }
    const status = ref<'idle' | 'syncing' | 'error'>('idle')
    chat.conversationHistorySyncStatus = vi.fn(() => status.value)
    chat.retryConversationHistory = vi.fn().mockResolvedValue(undefined)
    const wrapper = mount(ChatArea, { global: { stubs: { MessageBubble: true, MessageInput: true } } })

    status.value = 'syncing'
    await nextTick()
    await vi.advanceTimersByTimeAsync(900)
    expect(wrapper.find('[data-testid="conversation-loading-overlay"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="conversation-sync-status"]').exists()).toBe(false)
    status.value = 'idle'
    await nextTick()
    await vi.advanceTimersByTimeAsync(200)
    expect(wrapper.find('[data-testid="conversation-sync-status"]').exists()).toBe(false)

    status.value = 'syncing'
    await nextTick()
    await vi.advanceTimersByTimeAsync(1000)
    expect(wrapper.get('[data-testid="conversation-sync-status"]').text()).toBe('Syncing…')
    status.value = 'error'
    await nextTick()
    expect(wrapper.get('[data-testid="conversation-sync-status"]').text()).toContain("Couldn't sync")
    await wrapper.get('[data-testid="conversation-sync-retry"]').trigger('click')
    expect(chat.retryConversationHistory).toHaveBeenCalledWith('dm-1')
    expect(wrapper.find('[data-message-id="message-1"]').exists()).toBe(true)
    status.value = 'idle'
    await nextTick()
    expect(wrapper.find('[data-testid="conversation-sync-status"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('retains encrypted send envelopes on the visible outgoing message for later history reconciliation', async () => {
    const encrypt = vi.spyOn(dmE2ee, 'encryptDMMessage').mockResolvedValue({
      senderDeviceId: 'local',
      envelopes: [{ recipientDeviceId: 'local', senderDeviceId: 'local', algorithm: 'test', sessionMessage: new Uint8Array([1, 2]), metadataAad: new Uint8Array([3]) }],
    })
    const ensureDevice = vi.spyOn(dmE2ee, 'ensureEncryptedDMDevice').mockResolvedValue({ deviceId: 'local', publicKeyJwk: {}, privateKeyJwk: {} })
    const chat = useChatStore()
    chat.workspace = { id: 'workspace', name: 'Test', selfUserId: 'user-1', selfDisplayName: 'Ada', selfAvatarUrl: '', selfRole: 'member' }
    chat.directMessages = [{ id: 'dm-1', userId: 'user-2', displayName: 'Bob', presence: 'online', unread: 0, notificationLevel: NotificationLevel.ALL, encryptionMode: 'dm_pairwise_signal_v1' }]
    chat.activeChannelId = 'dm-1'
    chat.messages = { 'dm-1': [] }
    chat.startSendTimeout = vi.fn()
    useWsStore().state = 'LIVE_SYNCED'
    useWsStore().sendMessage = vi.fn().mockReturnValue(true)
    const wrapper = mount(ChatArea, {
      global: { stubs: { MessageBubble: true, MessageInput: { template: '<button data-testid="send-encrypted" @click="$emit(\'send\', \'My reply\')">Send</button>' } } },
    })
    try {
      await wrapper.get('[data-testid="send-encrypted"]').trigger('click')
      await flushAll()
      expect(chat.messages['dm-1'][0]).toMatchObject({
        body: 'My reply', contentMode: 'dm_pairwise_signal_v1', senderDeviceId: 'local',
        encryptedDMPayloads: [{ recipient_device_id: 'local', sender_device_id: 'local', algorithm: 'test', session_message: 'AQI=', metadata_aad: 'Aw==' }],
      })
    } finally {
      wrapper.unmount()
      encrypt.mockRestore()
      ensureDevice.mockRestore()
    }
  })

  it('does not flash a loading overlay or remount the composer when messages arrive during typing', async () => {
    const chat = useChatStore()
    chat.directMessages = [{ id: 'dm-1', userId: 'user-2', displayName: 'Bob', presence: 'online', unread: 0, notificationLevel: NotificationLevel.ALL }]
    chat.activeChannelId = 'dm-1'
    chat.messages = { 'dm-1': [buildMessage({ channelId: 'dm-1' })] }
    chat.isConversationInitialLoading = vi.fn().mockReturnValue(true)
    const wrapper = mount(ChatArea, {
      attachTo: document.body,
      global: { stubs: { MessageBubble: true, MessageInput: { template: '<textarea data-testid="draft" />' } } },
    })
    const textarea = wrapper.get('[data-testid="draft"]').element as HTMLTextAreaElement
    textarea.value = 'My unfinished reply'
    textarea.focus()
    textarea.setSelectionRange(3, 7)
    const firstRow = wrapper.get('[data-message-id="message-1"]').element
    chat.messages['dm-1'].push(buildMessage({ id: 'message-2', channelId: 'dm-1', channelSeq: 2n, senderId: 'user-2' }))
    await flushAll()

    expect(wrapper.find('[data-testid="conversation-loading-overlay"]').exists()).toBe(false)
    expect(wrapper.get('[data-message-id="message-1"]').element).toBe(firstRow)
    expect(wrapper.get('[data-testid="draft"]').element).toBe(textarea)
    expect(document.activeElement).toBe(textarea)
    expect(textarea.value).toBe('My unfinished reply')
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([3, 7])
    wrapper.unmount()
  })

  it('follows the first long incoming message in an already-open empty DM', async () => {
    const chat = useChatStore()
    chat.directMessages = [{ id: 'dm-1', userId: 'user-2', displayName: 'Bob', presence: 'online', unread: 0, notificationLevel: NotificationLevel.ALL }]
    chat.activeChannelId = 'dm-1'
    chat.messages = { 'dm-1': [] }
    const wrapper = mount(ChatArea, { global: { stubs: { MessageBubble: true, MessageInput: true } } })
    const scroll = wrapper.find('.overflow-y-auto').element as HTMLDivElement
    let height = 500
    Object.defineProperty(scroll, 'scrollHeight', { get: () => height, configurable: true })
    Object.defineProperty(scroll, 'clientHeight', { value: 500, configurable: true })
    await flushFrames()
    scroll.scrollTop = 0

    chat.messages['dm-1'].push(buildMessage({ id: 'message-1', channelId: 'dm-1', senderId: 'user-2', body: 'A long message\n'.repeat(100) }))
    await nextTick()
    height = 1200
    await flushAll()
    expect(scroll.scrollTop).toBe(1200)
    expect(wrapper.find('[data-testid="conversation-loading-overlay"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('counts all new remote messages in a batch without counting prepends, duplicates, or own messages', async () => {
    const chat = useChatStore()
    chat.activeChannelId = 'dm-1'
    chat.workspace = { id: 'workspace', name: 'Test', selfUserId: 'user-1', selfDisplayName: 'Ada', selfAvatarUrl: '', selfRole: 'member' }
    chat.directMessages = [{ id: 'dm-1', userId: 'user-2', displayName: 'Bob', presence: 'online', unread: 0, notificationLevel: NotificationLevel.ALL }]
    chat.messages = { 'dm-1': [buildMessage({ id: 'message-10', channelId: 'dm-1', channelSeq: 10n })] }
    const wrapper = mount(ChatArea, { global: { stubs: { MessageBubble: true, MessageInput: true } } })
    const scroll = wrapper.find('.overflow-y-auto').element as HTMLDivElement
    Object.defineProperty(scroll, 'scrollHeight', { value: 1800, configurable: true })
    Object.defineProperty(scroll, 'clientHeight', { value: 500, configurable: true })
    scroll.scrollTop = 300
    await wrapper.find('.overflow-y-auto').trigger('scroll')
    chat.messages['dm-1'] = [
      buildMessage({ id: 'message-9', channelId: 'dm-1', channelSeq: 9n, senderId: 'user-2' }),
      ...chat.messages['dm-1'],
      ...[11, 12, 13].map(seq => buildMessage({ id: `message-${seq}`, channelId: 'dm-1', channelSeq: BigInt(seq), senderId: 'user-2' })),
      buildMessage({ id: 'message-14', channelId: 'dm-1', channelSeq: 14n, senderId: 'user-1' }),
    ]
    await flushAll()
    expect(wrapper.get('[data-testid="scroll-to-bottom-btn"]').text()).toContain('3 new messages')
    expect(scroll.scrollTop).toBe(396)
    chat.messages['dm-1'] = [...chat.messages['dm-1']]
    await flushAll()
    expect(wrapper.get('[data-testid="scroll-to-bottom-btn"]').text()).toContain('3 new messages')
    await wrapper.get('[data-testid="scroll-to-bottom-btn"]').trigger('click')
    expect(scroll.scrollTop).toBe(1800)
    expect(wrapper.get('[data-testid="scroll-to-bottom-btn"]').text()).not.toContain('new messages')
    wrapper.unmount()
  })

  it('does not force-scroll to bottom when user is reading older history', async () => {
    const chatStore = useChatStore()
    const wsStore = useWsStore()
    wsStore.state = 'LIVE_SYNCED'
    chatStore.loadOlderConversationHistory = vi.fn().mockResolvedValue(0)
    chatStore.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chatStore.activeChannelId = 'channel-1'
    chatStore.messages = {
      'channel-1': [{
        id: 'message-1',
        channelId: 'channel-1',
        senderId: 'user-1',
        senderName: 'Ada',
        body: 'hello',
        channelSeq: 1n,
        threadSeq: 0n,
        mentionedUserIds: [],
        mentionEveryone: false,
        createdAt: '2026-03-06T00:00:00Z',
        reactions: [],
        myReactions: [],
      }],
    }

    const wrapper = mount(ChatArea, {
      global: {
        stubs: {
          MessageBubble: true,
          MessageInput: true,
        },
      },
    })

    const el = wrapper.find('.overflow-y-auto').element as HTMLDivElement
    Object.defineProperty(el, 'scrollHeight', { value: 1500, configurable: true, writable: true })
    Object.defineProperty(el, 'clientHeight', { value: 500, configurable: true })
    el.scrollTop = 120

    chatStore.messages['channel-1'].push({
      id: 'message-2',
      channelId: 'channel-1',
      senderId: 'user-2',
      senderName: 'Bob',
      body: 'new message',
      channelSeq: 2n,
      threadSeq: 0n,
      mentionedUserIds: [],
      mentionEveryone: false,
      createdAt: '2026-03-06T00:00:01Z',
      reactions: [],
      myReactions: [],
    })

    await Promise.resolve()

    expect(el.scrollTop).toBe(120)
  })

  it('waits for initial conversation loading to finish before bottoming a switched channel', async () => {
    const chatStore = useChatStore()
    const wsStore = useWsStore()
    wsStore.state = 'LIVE_SYNCED'
    let loadingChannel2 = true
    chatStore.isConversationInitialLoading = vi.fn((conversationId: string) =>
      conversationId === 'channel-2' && loadingChannel2
    )
    chatStore.channels = [
      {
        id: 'channel-1',
        name: 'general',
        kind: 'channel',
        visibility: 'public',
        unread: 0,
        notificationLevel: NotificationLevel.ALL,
      },
      {
        id: 'channel-2',
        name: 'random',
        kind: 'channel',
        visibility: 'public',
        unread: 0,
        notificationLevel: NotificationLevel.ALL,
      },
    ]
    chatStore.activeChannelId = 'channel-1'
    chatStore.messages = {
      'channel-1': [buildMessage({ id: 'message-1', channelId: 'channel-1' })],
      'channel-2': [buildMessage({ id: 'message-2', channelId: 'channel-2' })],
    }

    const wrapper = mount(ChatArea, {
      global: {
        stubs: {
          MessageBubble: true,
          MessageInput: true,
        },
      },
    })

    const el = wrapper.find('.overflow-y-auto').element as HTMLDivElement
    Object.defineProperty(el, 'scrollHeight', { value: 2200, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: 500, configurable: true })
    el.scrollTop = 120

    chatStore.activeChannelId = 'channel-2'
    await flushFrames()
    expect(el.scrollTop).toBe(120)

    loadingChannel2 = false
    chatStore.activeChannelId = 'channel-1'
    await nextTick()
    chatStore.activeChannelId = 'channel-2'
    await flushFrames()
    expect(el.scrollTop).toBe(2200)
  })

  it('cancels conversation-open bottom sticking when the user scrolls away', async () => {
    const chatStore = useChatStore()
    const wsStore = useWsStore()
    wsStore.state = 'LIVE_SYNCED'
    chatStore.isConversationInitialLoading = vi.fn().mockReturnValue(true)
    chatStore.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chatStore.activeChannelId = 'channel-1'
    chatStore.messages = {
      'channel-1': [buildMessage({ id: 'message-1' })],
    }

    const wrapper = mount(ChatArea, {
      global: {
        stubs: {
          MessageBubble: true,
          MessageInput: true,
        },
      },
    })

    const el = wrapper.find('.overflow-y-auto').element as HTMLDivElement
    Object.defineProperty(el, 'scrollHeight', { value: 2400, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: 500, configurable: true })
    el.scrollTop = 300

    await wrapper.find('.overflow-y-auto').trigger('scroll')
    chatStore.isConversationInitialLoading = vi.fn().mockReturnValue(false)
    await wrapper.setProps({})
    await flushFrames()

    expect(el.scrollTop).toBe(300)
  })

  it('preserves the visible top anchor when older history is prepended', async () => {
    const chatStore = useChatStore()
    const wsStore = useWsStore()
    wsStore.state = 'LIVE_SYNCED'
    chatStore.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chatStore.activeChannelId = 'channel-1'
    chatStore.messages = {
      'channel-1': [
        buildMessage({ id: 'message-1', channelSeq: 1n }),
        buildMessage({ id: 'message-2', channelSeq: 2n }),
      ],
    }
    chatStore.loadOlderConversationHistory = vi.fn().mockImplementation(async () => {
      chatStore.messages['channel-1'].unshift(buildMessage({ id: 'message-0', channelSeq: 0n }))
      return 1
    })
    const wrapper = mount(ChatArea, {
      global: { stubs: { MessageBubble: true, MessageInput: true } },
    })
    const el = wrapper.find('.overflow-y-auto').element as HTMLDivElement
    Object.defineProperty(el, 'scrollHeight', { value: 1600, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true })
    el.scrollTop = 40

    await wrapper.find('.overflow-y-auto').trigger('scroll')
    await flushAll()

    // Only the timeline compensates for the new estimated row (96px).
    expect(el.scrollTop).toBe(136)
    expect(wrapper.get('[data-testid="scroll-to-bottom-btn"]').text()).not.toContain('new message')
    wrapper.unmount()
  })

  it('increments unread without moving scroll when a remote message arrives while scrolled away', async () => {
    const chatStore = useChatStore()
    const wsStore = useWsStore()
    wsStore.state = 'LIVE_SYNCED'
    chatStore.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chatStore.activeChannelId = 'channel-1'
    chatStore.messages = {
      'channel-1': [buildMessage({ id: 'message-1', channelSeq: 1n })],
    }

    const wrapper = mount(ChatArea, {
      global: {
        stubs: {
          MessageBubble: true,
          MessageInput: true,
        },
      },
    })

    const el = wrapper.find('.overflow-y-auto').element as HTMLDivElement
    Object.defineProperty(el, 'scrollHeight', { value: 1800, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: 500, configurable: true })
    el.scrollTop = 300
    await wrapper.find('.overflow-y-auto').trigger('scroll')

    chatStore.messages['channel-1'].push(buildMessage({
      id: 'message-2',
      channelSeq: 2n,
      senderId: 'user-2',
      senderName: 'Bob',
      body: 'remote',
    }))
    await flushAll()

    expect(el.scrollTop).toBe(300)
    expect(wrapper.get('[data-testid="scroll-to-bottom-btn"]').text()).toContain('1')
  })

  it('keeps the last inline edit bottom-anchored while the editor grows', async () => {
    const chatStore = useChatStore()
    const wsStore = useWsStore()
    wsStore.state = 'LIVE_SYNCED'
    chatStore.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chatStore.activeChannelId = 'channel-1'
    chatStore.messages = {
      'channel-1': [
        {
          id: 'message-1',
          channelId: 'channel-1',
          senderId: 'user-1',
          senderName: 'Ada',
          body: 'older',
          channelSeq: 1n,
          threadSeq: 0n,
          mentionedUserIds: [],
          mentionEveryone: false,
          createdAt: '2026-03-06T00:00:00Z',
          reactions: [],
          myReactions: [],
        },
        {
          id: 'message-2',
          channelId: 'channel-1',
          senderId: 'user-1',
          senderName: 'Ada',
          body: 'latest',
          channelSeq: 2n,
          threadSeq: 0n,
          mentionedUserIds: [],
          mentionEveryone: false,
          createdAt: '2026-03-06T00:01:00Z',
          reactions: [],
          myReactions: [],
        },
      ],
    }

    const wrapper = mount(ChatArea, {
      global: {
        stubs: {
          MessageBubble: {
            props: ['message'],
            emits: ['edit-open', 'edit-close', 'edit-resize'],
            template: `
              <div>
                <button
                  v-if="message.id === 'message-2'"
                  data-testid="tail-edit-open"
                  @click="$emit('edit-open', message.id)"
                >
                  open
                </button>
                <button
                  v-if="message.id === 'message-2'"
                  data-testid="tail-edit-grow"
                  @click="$emit('edit-resize', message.id, 120)"
                >
                  grow
                </button>
              </div>
            `,
          },
          MessageInput: true,
        },
      },
    })

    const el = wrapper.find('.overflow-y-auto').element as HTMLDivElement
    let scrollHeight = 1500
    Object.defineProperty(el, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    })
    Object.defineProperty(el, 'clientHeight', { value: 500, configurable: true })
    el.scrollTop = 1000

    scrollHeight = 1580
    await wrapper.get('[data-testid="tail-edit-open"]').trigger('click')
    await flushAll()
    expect(el.scrollTop).toBe(1580)

    scrollHeight = 1700
    await wrapper.get('[data-testid="tail-edit-grow"]').trigger('click')
    await flushAll()
    expect(el.scrollTop).toBe(1700)
  })

  it('pins thread from message bubble without opening legacy thread panel', async () => {
    const chatStore = useChatStore()
    const pinnedStore = usePinnedDialogsStore()

    chatStore.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chatStore.activeChannelId = 'channel-1'
    chatStore.messages = {
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

    const wrapper = mount(ChatArea, {
      global: {
        stubs: {
          MessageBubble: {
            props: ['message'],
            template: '<button data-testid="open-thread" @click="$emit(\'openThread\', message)">open thread</button>',
          },
          MessageInput: true,
        },
      },
    })

    await wrapper.get('[data-testid="open-thread"]').trigger('click')

    expect(pinnedStore.activeId).toBe('thread:channel-1:root-1')
    expect(pinnedStore.items.map(item => item.id)).toEqual(['thread:channel-1:root-1'])
    expect(chatStore.isThreadPanelOpen).toBe(false)
  })

  it('does not render legacy thread panel replies inside main chat area', async () => {
    const chatStore = useChatStore()

    chatStore.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chatStore.activeChannelId = 'channel-1'
    chatStore.messages = {
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
    chatStore.threadMessages = {
      'root-1': [
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
          createdAt: '2026-03-06T00:00:01Z',
          reactions: [],
          myReactions: [],
        },
      ],
    }
    chatStore.activeThreadConversationId = 'channel-1'
    chatStore.activeThreadRootId = 'root-1'

    const wrapper = mount(ChatArea, {
      global: {
        stubs: {
          MessageBubble: {
            props: ['message'],
            template: '<div class="bubble">{{ message.body }}|{{ message.threadSeq }}</div>',
          },
          MessageInput: true,
        },
      },
    })

    const bubbleText = wrapper.findAll('.bubble').map(item => item.text())

    expect(bubbleText).toEqual(['root|0'])
  })

  it('renders member avatars in the channel call invite dialog', async () => {
    const chatStore = useChatStore()
    const wsStore = useWsStore()
    wsStore.state = 'LIVE_SYNCED'
    wsStore.requestConversationMembers = vi.fn().mockResolvedValue({
      members: [
        { userId: 'user-2', displayName: 'Bob', email: 'bob@example.com', avatarUrl: '/api/public/avatars/a/bob.png' },
        { userId: 'user-3', displayName: '', email: 'eve@example.com', avatarUrl: '' },
      ],
    })

    chatStore.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfRole: 'member',
    }
    chatStore.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chatStore.activeChannelId = 'channel-1'

    const wrapper = mount(ChatArea, {
      global: {
        stubs: {
          MessageBubble: true,
          MessageInput: true,
          UserAvatar: {
            props: ['userId', 'displayName', 'avatarUrl'],
            template: '<div :data-testid="`invite-avatar-${userId}`" :data-display-name="displayName" :data-avatar-url="avatarUrl"></div>',
          },
        },
      },
    })

    const callButton = wrapper.findAll('button').find(btn => btn.attributes('aria-label') === 'Start call')
    expect(callButton).toBeDefined()
    await callButton!.trigger('click')
    await Promise.resolve()
    await nextTick()

    expect(wsStore.requestConversationMembers).toHaveBeenCalledWith('channel-1')
    expect(wrapper.find('[data-testid="invite-avatar-user-2"]').attributes('data-avatar-url')).toBe('/api/public/avatars/a/bob.png')
    expect(wrapper.find('[data-testid="invite-avatar-user-2"]').attributes('data-display-name')).toBe('Bob')
    expect(wrapper.find('[data-testid="invite-avatar-user-3"]').attributes('data-display-name')).toBe('eve@example.com')

    const searchInput = wrapper.get('[data-testid="channel-call-invite-search"]')
    await searchInput.setValue('bob')
    await nextTick()

    expect(wrapper.find('[data-testid="invite-avatar-user-2"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="invite-avatar-user-3"]').exists()).toBe(false)
  })

  it('confirms before starting a DM call when the peer is already in another call', async () => {
    const chatStore = useChatStore()
    const callStore = useCallStore()
    callStore.startOrJoinCall = vi.fn().mockResolvedValue(undefined)
    chatStore.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfRole: 'member',
    }
    chatStore.directMessages = [{
      id: 'dm-1',
      userId: 'user-2',
      displayName: 'Bob',
      presence: 'online',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chatStore.userCallPresenceByUserId = { 'user-2': 1 }
    chatStore.activeChannelId = 'dm-1'

    const wrapper = mount(ChatArea, {
      global: {
        stubs: {
          MessageBubble: true,
          MessageInput: true,
        },
      },
    })

    const callButton = wrapper.findAll('button').find(btn => btn.attributes('aria-label') === 'Start call')
    expect(callButton).toBeDefined()
    await callButton!.trigger('click')
    await flushAll()

    const dialog = document.body.querySelector('[data-testid="busy-call-confirm-dialog"]') as HTMLElement | null
    expect(dialog).not.toBeNull()
    expect(dialog?.textContent).toContain('Bob')
    expect(callStore.startOrJoinCall).not.toHaveBeenCalled()

    document.body.querySelector<HTMLButtonElement>('[data-testid="busy-call-confirm-cancel"]')?.click()
    await flushAll()

    expect(callStore.startOrJoinCall).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('confirms before starting a channel call with busy selected invitees', async () => {
    const chatStore = useChatStore()
    const wsStore = useWsStore()
    const callStore = useCallStore()
    wsStore.state = 'LIVE_SYNCED'
    wsStore.requestConversationMembers = vi.fn().mockResolvedValue({
      members: [
        { userId: 'user-2', displayName: 'Bob', email: 'bob@example.com', avatarUrl: '' },
        { userId: 'user-3', displayName: 'Eve', email: 'eve@example.com', avatarUrl: '' },
      ],
    })
    callStore.startOrJoinCall = vi.fn().mockResolvedValue(undefined)
    chatStore.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfRole: 'member',
    }
    chatStore.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chatStore.userCallPresenceByUserId = { 'user-2': 1 }
    chatStore.activeChannelId = 'channel-1'

    const wrapper = mount(ChatArea, {
      global: {
        stubs: {
          MessageBubble: true,
          MessageInput: true,
          UserAvatar: true,
        },
      },
    })

    const callButton = wrapper.findAll('button').find(btn => btn.attributes('aria-label') === 'Start call')
    expect(callButton).toBeDefined()
    await callButton!.trigger('click')
    await flushAll()

    await wrapper.get('[data-testid="channel-call-invite-candidate-user-2"]').trigger('click')
    const startButton = wrapper.findAll('button').find(btn => btn.text().includes('Start call'))
    expect(startButton).toBeDefined()
    await startButton!.trigger('click')
    await flushAll()

    const dialog = document.body.querySelector('[data-testid="busy-call-confirm-dialog"]') as HTMLElement | null
    expect(dialog).not.toBeNull()
    expect(dialog?.textContent).toContain('Bob')
    expect(callStore.startOrJoinCall).not.toHaveBeenCalled()

    document.body.querySelector<HTMLButtonElement>('[data-testid="busy-call-confirm-confirm"]')?.click()
    await flushAll()

    expect(callStore.startOrJoinCall).toHaveBeenCalledWith({
      conversationId: 'channel-1',
      kind: 'channel',
      visibility: 'public',
      inviteeUserIds: ['user-2'],
    })
    wrapper.unmount()
  })

  it('shows the active call member roster on hover and includes the current user', async () => {
    const authStore = useAuthStore()
    const chatStore = useChatStore()
    const wsStore = useWsStore()
    const callStore = useCallStore()
    wsStore.state = 'LIVE_SYNCED'

    chatStore.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfAvatarUrl: '/api/public/avatars/avatars/user-1/self.png',
      selfRole: 'member',
    }
    authStore.user = {
      id: 'user-1',
      displayName: 'Ada',
      email: 'ada@example.com',
      avatarUrl: '/api/public/avatars/avatars/user-1/self.png',
      role: 'member',
    }
    chatStore.registerUserIdentity('user-2', 'Bob', 'bob@example.com', '/api/public/avatars/avatars/user-2/bob.png')
    chatStore.registerUserIdentity('user-3', 'Eve', 'eve@example.com', '/api/public/avatars/avatars/user-3/eve.png')
    chatStore.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chatStore.activeChannelId = 'channel-1'
    chatStore.activeCalls = [
      { id: 'call-1', conversationId: 'channel-1', status: '1', participantCount: 3 },
    ]
    callStore.activeConversationId = 'channel-1'
    callStore.room = {
      localParticipant: { identity: 'user-1' },
      remoteParticipants: new Map([
        ['sid-user-2', { identity: 'user-2' }],
        ['sid-user-3', { identity: 'user-3' }],
      ]),
    } as never

    const wrapper = mount(ChatArea, {
      global: {
        stubs: {
          MessageBubble: true,
          MessageInput: true,
          UserAvatar: {
            props: ['userId', 'displayName', 'avatarUrl'],
            template: '<div :data-testid="`call-avatar-${userId}`" :data-display-name="displayName" :data-avatar-url="avatarUrl"></div>',
          },
        },
      },
    })

    const trigger = wrapper.get('[data-testid="active-call-members-trigger"]')
    await trigger.trigger('mouseenter')
    await nextTick()

    const popover = wrapper.get('[data-testid="call-members-popover"]')
    expect(popover.text()).toContain('Call members')
    expect(popover.text()).toContain('Ada')
    expect(popover.text()).toContain('Bob')
    expect(popover.text()).toContain('Eve')
    expect(popover.text()).toContain('You')
    expect(wrapper.get('[data-testid="call-avatar-user-1"]').attributes('data-avatar-url')).toBe('/api/public/avatars/avatars/user-1/self.png')
    expect(wrapper.get('[data-testid="call-avatar-user-2"]').attributes('data-display-name')).toBe('Bob')
    expect(wrapper.get('[data-testid="call-avatar-user-3"]').attributes('data-avatar-url')).toBe('/api/public/avatars/avatars/user-3/eve.png')

    callStore.room = {
      localParticipant: { identity: 'user-1' },
      remoteParticipants: new Map([
        ['sid-user-2', { identity: 'user-2' }],
        ['sid-user-4', { identity: 'user-4' }],
      ]),
    } as never
    chatStore.registerUserIdentity('user-4', 'Cara', 'cara@example.com', '/api/public/avatars/avatars/user-4/cara.png')
    callStore.mediaVersion += 1
    await nextTick()

    const updatedPopover = wrapper.get('[data-testid="call-members-popover"]')
    expect(updatedPopover.text()).toContain('Ada')
    expect(updatedPopover.text()).toContain('Bob')
    expect(updatedPopover.text()).toContain('Cara')
    expect(updatedPopover.text()).not.toContain('Eve')
  })

  it('loads active call members for calls the user has not joined', async () => {
    const authStore = useAuthStore()
    const chatStore = useChatStore()
    const wsStore = useWsStore()
    const callStore = useCallStore()
    wsStore.state = 'LIVE_SYNCED'

    authStore.user = {
      id: 'user-1',
      displayName: 'Ada',
      email: 'ada@example.com',
      avatarUrl: '/api/public/avatars/avatars/user-1/self.png',
      role: 'member',
    }
    chatStore.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfAvatarUrl: '/api/public/avatars/avatars/user-1/self.png',
      selfRole: 'member',
    }
    chatStore.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chatStore.activeChannelId = 'channel-1'
    chatStore.activeCalls = [
      { id: 'call-remote-1', conversationId: 'channel-1', status: '1', participantCount: 2 },
    ]
    callStore.activeConversationId = 'channel-2'
    callStore.room = {
      localParticipant: { identity: 'user-1' },
      remoteParticipants: new Map(),
    } as never
    wsStore.requestActiveCallMembers = vi.fn().mockResolvedValue({
      members: [
        { userId: 'user-2', displayName: 'Bob', email: 'bob@example.com', avatarUrl: '/api/public/avatars/avatars/user-2/bob.png' },
        { userId: 'user-3', displayName: '', email: 'eve@example.com', avatarUrl: '' },
      ],
    })

    const wrapper = mount(ChatArea, {
      global: {
        stubs: {
          MessageBubble: true,
          MessageInput: true,
          UserAvatar: {
            props: ['userId', 'displayName', 'avatarUrl'],
            template: '<div :data-testid="`call-avatar-${userId}`" :data-display-name="displayName" :data-avatar-url="avatarUrl"></div>',
          },
        },
      },
    })

    await wrapper.get('[data-testid="active-call-members-trigger"]').trigger('mouseenter')
    await Promise.resolve()
    await nextTick()

    expect(wsStore.requestActiveCallMembers).toHaveBeenCalledWith('channel-1')
    expect(wsStore.requestActiveCallMembers).toHaveBeenCalledTimes(1)
    const popover = wrapper.get('[data-testid="call-members-popover"]')
    expect(popover.text()).toContain('Bob')
    expect(popover.text()).toContain('eve@example.com')
    expect(wrapper.get('[data-testid="call-avatar-user-2"]').attributes('data-avatar-url')).toBe('/api/public/avatars/avatars/user-2/bob.png')
    expect(wrapper.get('[data-testid="call-avatar-user-3"]').attributes('data-display-name')).toBe('eve@example.com')
  })

  it('does nothing when clicking call active while already in the same call', async () => {
    const chatStore = useChatStore()
    const wsStore = useWsStore()
    const callStore = useCallStore()
    wsStore.state = 'LIVE_SYNCED'

    chatStore.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chatStore.activeChannelId = 'channel-1'
    chatStore.activeCalls = [
      { id: 'call-1', conversationId: 'channel-1', status: '1', participantCount: 2 },
    ]

    callStore.connected = true
    callStore.connecting = false
    callStore.activeConversationId = 'channel-1'
    callStore.startOrJoinCall = vi.fn()

    const wrapper = mount(ChatArea, {
      global: {
        stubs: {
          MessageBubble: true,
          MessageInput: true,
        },
      },
    })

    const callButton = wrapper.findAll('button').find(btn => btn.attributes('aria-label') === 'Ongoing call')
    expect(callButton).toBeDefined()
    await callButton!.trigger('click')

    expect(callStore.startOrJoinCall).not.toHaveBeenCalled()
  })

  it('rate-limits typing notifications and hides them after one second of inactivity', async () => {
    vi.useFakeTimers()

    const authStore = useAuthStore()
    const chatStore = useChatStore()
    const wsStore = useWsStore()

    authStore.user = {
      id: 'user-1',
      displayName: 'Ada',
      email: 'ada@example.com',
      avatarUrl: '',
      role: 'member',
    }
    chatStore.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfAvatarUrl: '',
      selfRole: 'member',
    }
    chatStore.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chatStore.activeChannelId = 'channel-1'
    wsStore.state = 'LIVE_SYNCED'
    wsStore.sendTyping = vi.fn()

    const wrapper = mount(ChatArea, {
      global: {
        stubs: {
          ConnectionBanner: true,
          MembersPanel: true,
          MessageBubble: true,
          ThreadPanel: true,
          UserAvatar: true,
          MessageInput: {
            template: `
              <div>
                <button data-testid="typing-on" @click="$emit('typing', true)">typing-on</button>
                <button data-testid="typing-off" @click="$emit('typing', false)">typing-off</button>
              </div>
            `,
          },
        },
      },
    })

    await wrapper.get('[data-testid="typing-on"]').trigger('click')
    await wrapper.get('[data-testid="typing-on"]').trigger('click')

    expect(wsStore.sendTyping).toHaveBeenCalledTimes(1)
    expect(wsStore.sendTyping).toHaveBeenLastCalledWith('channel-1', true)

    await vi.advanceTimersByTimeAsync(1000)

    expect(wsStore.sendTyping).toHaveBeenCalledTimes(2)
    expect(wsStore.sendTyping).toHaveBeenLastCalledWith('channel-1', false)

    await wrapper.get('[data-testid="typing-off"]').trigger('click')

    expect(wsStore.sendTyping).toHaveBeenCalledTimes(2)
  })

  it('renders day dividers between messages from different days', () => {
    const chatStore = useChatStore()
    chatStore.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chatStore.activeChannelId = 'channel-1'
    chatStore.messages = {
      'channel-1': [
        buildMessage({ id: 'm-1', channelSeq: 1n, createdAt: '2026-03-05T12:00:00Z' }),
        buildMessage({ id: 'm-2', channelSeq: 2n, createdAt: '2026-03-07T12:00:00Z' }),
      ],
    }

    const wrapper = mount(ChatArea, {
      global: {
        stubs: {
          MessageBubble: true,
          MessageInput: true,
        },
      },
    })

    expect(wrapper.findAll('[data-testid="day-divider"]')).toHaveLength(2)
    expect(wrapper.text()).toContain('March 5')
    expect(wrapper.text()).toContain('March 7')
  })

  it('places the unread divider at the read cursor despite own messages and reply sequence gaps', async () => {
    const chatStore = useChatStore()
    chatStore.directMessages = [{
      id: 'channel-1',
      userId: 'user-2',
      displayName: 'Bob',
      presence: 'offline',
      unread: 1,
      lastReadSeq: 4n,
      lastMessageSeq: 8n,
      notificationLevel: NotificationLevel.ALL,
    }]
    chatStore.activeChannelId = 'channel-1'
    chatStore.messages = {
      'channel-1': [
        buildMessage({ id: 'm-read', channelSeq: 4n }),
        buildMessage({ id: 'm-unread', channelSeq: 5n, senderId: 'user-2' }),
        buildMessage({ id: 'm-own', channelSeq: 8n, senderId: 'user-1' }),
      ],
    }

    const wrapper = mount(ChatArea, {
      global: { stubs: { MessageBubble: true, MessageInput: true } },
    })
    await flushAll()

    expect(wrapper.findAll('[data-testid="unread-divider"]')).toHaveLength(1)
    expect(wrapper.get('[data-message-id="m-unread"]').find('[data-testid="unread-divider"]').exists()).toBe(true)
    expect(wrapper.get('[data-message-id="m-own"]').find('[data-testid="unread-divider"]').exists()).toBe(false)
  })

  it('renders the unread divider at the legacy count boundary and drops it once read', async () => {
    const chatStore = useChatStore()
    chatStore.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 1,
      lastMessageSeq: 3n,
      notificationLevel: NotificationLevel.ALL,
    }]
    chatStore.activeChannelId = 'channel-1'
    chatStore.messages = {
      'channel-1': [
        buildMessage({ id: 'm-1', channelSeq: 1n }),
        buildMessage({ id: 'm-2', channelSeq: 2n }),
        buildMessage({ id: 'm-3', channelSeq: 3n }),
      ],
    }

    const wrapper = mount(ChatArea, {
      global: {
        stubs: {
          MessageBubble: true,
          MessageInput: true,
        },
      },
    })
    await flushAll()

    expect(wrapper.findAll('[data-testid="unread-divider"]')).toHaveLength(1)

    chatStore.channels[0].unread = 0
    chatStore.activeChannelId = ''
    await nextTick()
    chatStore.activeChannelId = 'channel-1'
    await flushAll()

    expect(wrapper.findAll('[data-testid="unread-divider"]')).toHaveLength(0)
  })
})
