import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { create } from '@bufbuild/protobuf'
import { nextTick, watch } from 'vue'
import { useChatStore, type Message } from '@/stores/chat'
import { useWsStore } from '@/stores/ws'
import { useAuthStore } from '@/stores/auth'
import {
  loadLastOpenedConversation,
  saveLastOpenedConversation,
} from '@/services/storage/lastConversationStorage'
import { storage } from '@/services/storage/storageAdapter'
import { ensureLocalStorageMock } from '@/__tests__/testUtils'
import {
  BootstrapResponseSchema,
  SyncSinceResponseSchema,
  UserSummarySchema,
  ConversationSummarySchema,
  UnreadCounterSchema,
  UserCallPresenceSummarySchema,
  CallStateChangedEventSchema,
  UserCallPresenceChangedEventSchema,
  CallStatus,
  MessageEventSchema,
  MessageAttachmentSchema,
  SendMessageAckSchema,
  SubscribeThreadResponseSchema,
  NotificationAddedEventSchema,
  NotificationSummarySchema,
  ReadCounterUpdatedEventSchema,
  MessageUpdatedEventSchema,
  MessageDeletedEventSchema,
  DmHistoryClearedEventSchema,
  SecretHistoryInvalidatedEventSchema,
  MessageAlertEventSchema,
  ThreadSummaryUpdatedEventSchema,
  TaskStatusChangedEventSchema,
  ServerEventSchema,
  PresenceEventSchema,
  PresenceStatus,
  EventType,
  NotificationType,
  NotificationLevel,
  ConversationEncryptionMode,
  MessageContentMode,
  ReactionAggregateSchema,
} from '@/shared/proto/packets_pb'

const chatApiMocks = vi.hoisted(() => ({
  listConversationMessages: vi.fn(),
  listDmCandidates: vi.fn(),
  listMessageReactionUsers: vi.fn(),
  listUnreadFeed: vi.fn(),
  listSavedMessages: vi.fn(),
  forwardMessage: vi.fn(),
  clearDMConversationHistory: vi.fn(),
  saveMessage: vi.fn(),
  unsaveMessage: vi.fn(),
  getMessageContext: vi.fn(),
  resolveUnreadFeedNotification: vi.fn(),
}))

const avatarCacheMocks = vi.hoisted(() => ({
  invalidateUserAvatar: vi.fn(),
}))

const e2eeMocks = vi.hoisted(() => ({
  decryptDMMessage: vi.fn(),
}))

const offlineQueueMocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  claimInFlight: vi.fn(),
  releaseInFlight: vi.fn(),
  releaseAllInFlight: vi.fn(),
  remove: vi.fn(),
  clear: vi.fn(),
  flush: vi.fn(),
  loadPersisted: vi.fn(),
  queue: { value: [] as unknown[] },
}))

vi.mock('@/services/http/chatApi', () => ({
  listConversationMessages: chatApiMocks.listConversationMessages,
  listDmCandidates: chatApiMocks.listDmCandidates,
  listMessageReactionUsers: chatApiMocks.listMessageReactionUsers,
  listUnreadFeed: chatApiMocks.listUnreadFeed,
  listSavedMessages: chatApiMocks.listSavedMessages,
  forwardMessage: chatApiMocks.forwardMessage,
  clearDMConversationHistory: chatApiMocks.clearDMConversationHistory,
  saveMessage: chatApiMocks.saveMessage,
  unsaveMessage: chatApiMocks.unsaveMessage,
  getMessageContext: chatApiMocks.getMessageContext,
  resolveUnreadFeedNotification: chatApiMocks.resolveUnreadFeedNotification,
}))

vi.mock('@/services/avatar/avatarCache', () => ({
  invalidateUserAvatar: avatarCacheMocks.invalidateUserAvatar,
}))

vi.mock('@/services/e2ee/dmE2ee', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/e2ee/dmE2ee')>()
  return {
    ...actual,
    decryptDMMessage: e2eeMocks.decryptDMMessage,
  }
})

vi.mock('@/composables/useOfflineQueue', () => ({
  useOfflineQueue: () => offlineQueueMocks,
}))

function buildMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'message-1',
    channelId: 'channel-1',
    senderId: 'user-2',
    senderName: 'Bob',
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

function buildSequencedMessageEvent(eventSeq: bigint, messageId = `message-${eventSeq}`) {
  return create(ServerEventSchema, {
    eventSeq,
    eventId: `event-${eventSeq}`,
    eventType: EventType.MESSAGE_CREATED,
    conversationId: 'channel-1',
    payload: {
      case: 'messageCreated',
      value: create(MessageEventSchema, {
        conversationId: 'channel-1',
        messageId,
        senderId: 'user-2',
        body: `message ${eventSeq}`,
        channelSeq: eventSeq,
        threadRootMessageId: '',
        threadSeq: 0n,
        mentionedUserIds: [],
        mentionEveryone: false,
      }),
    },
  })
}

function buildUnreadThreadItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'thread:reply-1',
    kind: 'thread',
    conversationId: 'channel-1',
    conversationKind: 'channel',
    conversationVisibility: 'public',
    conversationTitle: 'general',
    messageId: 'reply-1',
    threadRootMessageId: 'root-1',
    senderName: 'Bob',
    body: 'reply 1',
    createdAt: '2026-03-06T00:01:00Z',
    ...overrides,
  }
}

describe('chatStore phase 6 flows', () => {
  beforeEach(() => {
    ensureLocalStorageMock()
    setActivePinia(createPinia())
    localStorage.clear()
    storage.clear()
    chatApiMocks.listConversationMessages.mockReset()
    chatApiMocks.listDmCandidates.mockReset()
    chatApiMocks.listUnreadFeed.mockReset()
    chatApiMocks.listSavedMessages.mockReset()
    chatApiMocks.forwardMessage.mockReset()
    chatApiMocks.clearDMConversationHistory.mockReset()
    chatApiMocks.saveMessage.mockReset()
    chatApiMocks.unsaveMessage.mockReset()
    chatApiMocks.getMessageContext.mockReset()
    chatApiMocks.resolveUnreadFeedNotification.mockReset()
    avatarCacheMocks.invalidateUserAvatar.mockReset()
    e2eeMocks.decryptDMMessage.mockReset()
    offlineQueueMocks.enqueue.mockReset()
    offlineQueueMocks.claimInFlight.mockReset()
    offlineQueueMocks.releaseInFlight.mockReset()
    offlineQueueMocks.releaseAllInFlight.mockReset()
    offlineQueueMocks.remove.mockReset()
    offlineQueueMocks.clear.mockReset()
    offlineQueueMocks.flush.mockReset()
    offlineQueueMocks.loadPersisted.mockReset()
    offlineQueueMocks.enqueue.mockResolvedValue(true)
    offlineQueueMocks.claimInFlight.mockReturnValue(true)
    offlineQueueMocks.loadPersisted.mockResolvedValue([])
    offlineQueueMocks.queue.value = []
    chatApiMocks.listDmCandidates.mockResolvedValue([])
    chatApiMocks.listUnreadFeed.mockResolvedValue({ total_count: 0, items: [] })
    chatApiMocks.listSavedMessages.mockResolvedValue({ total_count: 0, items: [] })
    chatApiMocks.forwardMessage.mockResolvedValue(undefined)
    chatApiMocks.clearDMConversationHistory.mockResolvedValue(undefined)
    chatApiMocks.saveMessage.mockResolvedValue(undefined)
    chatApiMocks.unsaveMessage.mockResolvedValue(undefined)
    chatApiMocks.getMessageContext.mockResolvedValue({ messages: [], has_more: false, page_size: 0 })
    chatApiMocks.resolveUnreadFeedNotification.mockResolvedValue(undefined)
    e2eeMocks.decryptDMMessage.mockResolvedValue(null)
  })

  it('applies a bootstrap response into sidebar state and watermark', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.setLiveSynced = vi.fn()
    ws.sendAck = vi.fn()

    chat.handleBootstrapResponse(create(BootstrapResponseSchema, {
      snapshotSeq: 8n,
      userRole: 2,
      workspace: {
        workspaceId: 'workspace-1',
        workspaceName: 'Acme',
        selfUser: create(UserSummarySchema, { userId: 'user-1', displayName: 'Ada', avatarUrl: '' }),
        selfRole: 3,
      },
      conversations: [create(ConversationSummarySchema, {
        conversationId: 'channel-1',
        conversationType: 2,
        title: 'general',
        topic: '',
        isArchived: false,
        notificationLevel: NotificationLevel.ALL,
        lastMessageSeq: 0n,
        lastMessagePreview: '',
        memberCount: 1,
        presence: 3,
      })],
      unread: [create(UnreadCounterSchema, {
        conversationId: 'channel-1',
        unreadMessages: 4,
        unreadMentions: 0,
        hasUnreadThreadReplies: false,
        lastReadSeq: 0n,
      })],
      activeCalls: [],
      pendingInvites: [],
      notifications: [],
      hasMore: false,
      nextPageToken: '',
      bootstrapSessionId: 'session-1',
      pageIndex: 0,
      pageSizeEffective: 1,
      estimatedTotalConversations: 1,
      presence: [],
    }))

    expect(chat.bootstrapped).toBe(true)
    expect(chat.workspace?.name).toBe('Acme')
    expect(chat.workspace?.selfDisplayName).toBe('Ada')
    expect(chat.workspace?.selfRole).toBe('admin')
    expect(chat.channels).toHaveLength(1)
    expect(chat.channels[0].id).toBe('channel-1')
    expect(chat.channels[0].unread).toBe(4)
    expect(chat.lastAppliedEventSeq).toBe(8n)
    expect(ws.setLiveSynced).toHaveBeenCalled()
  })

  it('hydrates durable root and thread sends even without a conversation cache', async () => {
    const chat = useChatStore()
    offlineQueueMocks.loadPersisted.mockResolvedValue([
      {
        conversationId: 'channel-not-cached',
        body: 'queued root',
        clientMsgId: 'queued-root',
        attachmentIds: ['attachment-root'],
        attachments: [{ id: 'attachment-root', fileName: 'root.txt', fileSize: 9, mimeType: 'text/plain' }],
      },
      {
        conversationId: 'channel-not-cached',
        body: 'queued reply',
        clientMsgId: 'queued-thread',
        threadRootMessageId: 'root-not-cached',
        attachmentIds: ['attachment-thread'],
        attachments: [{ id: 'attachment-thread', fileName: 'reply.txt', fileSize: 7, mimeType: 'text/plain' }],
      },
    ])

    await expect(chat.loadCachedState()).resolves.toBe(true)

    expect(chat.messages['channel-not-cached']).toEqual([expect.objectContaining({
      clientMsgId: 'queued-root',
      sendStatus: 'queued',
      attachments: [{ id: 'attachment-root', fileName: 'root.txt', fileSize: 9, mimeType: 'text/plain' }],
    })])
    expect(chat.threadMessages['root-not-cached']).toEqual([expect.objectContaining({
      clientMsgId: 'queued-thread',
      sendStatus: 'queued',
      threadRootMessageId: 'root-not-cached',
      attachments: [{ id: 'attachment-thread', fileName: 'reply.txt', fileSize: 7, mimeType: 'text/plain' }],
    })])
  })

  it('flushes durable sends when handlers register after realtime is already live', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.state = 'LIVE_SYNCED'

    chat.registerWsHandlers()

    expect(offlineQueueMocks.flush).toHaveBeenCalledWith(ws, expect.any(Function))
  })

  it('preserves and resubscribes the visible pinned thread across bootstrap', async () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.sendSubscribeThread = vi.fn().mockReturnValue(true)
    ws.setLiveSynced = vi.fn(() => {
      ws.state = 'LIVE_SYNCED'
    })
    ws.sendAck = vi.fn()
    chatApiMocks.listConversationMessages.mockResolvedValue({ messages: [], has_more: false, page_size: 0 })
    chat.messages = {
      'channel-1': [buildMessage({ id: 'root-1', channelId: 'channel-1', threadSeq: 0n })],
    }
    chat.activeThreadConversationId = 'channel-1'
    chat.activeThreadRootId = 'root-1'

    chat.handleBootstrapResponse(create(BootstrapResponseSchema, {
      snapshotSeq: 8n,
      userRole: 2,
      workspace: {
        workspaceId: 'workspace-1',
        workspaceName: 'Acme',
        selfUser: create(UserSummarySchema, { userId: 'user-1', displayName: 'Ada', avatarUrl: '' }),
        selfRole: 3,
      },
      conversations: [create(ConversationSummarySchema, {
        conversationId: 'channel-1',
        conversationType: 2,
        title: 'general',
        notificationLevel: NotificationLevel.ALL,
      })],
      unread: [],
      activeCalls: [],
      pendingInvites: [],
      notifications: [],
      hasMore: false,
      bootstrapSessionId: 'session-thread-recovery',
      pageIndex: 0,
      pageSizeEffective: 1,
      estimatedTotalConversations: 1,
      presence: [],
    }))
    await Promise.resolve()
    await Promise.resolve()

    expect(chat.activeThreadConversationId).toBe('channel-1')
    expect(chat.activeThreadRootId).toBe('root-1')
    expect(chat.getThreadRoot('channel-1', 'root-1')?.id).toBe('root-1')
    expect(ws.sendSubscribeThread).toHaveBeenCalledWith('channel-1', 'root-1', 0n)
  })

  it('preserves in-flight delivery state during a healthy bootstrap without replaying it', () => {
    vi.useFakeTimers()
    try {
      const chat = useChatStore()
      const ws = useWsStore()
      ws.setLiveSynced = vi.fn()
      ws.sendAck = vi.fn()
      chat.messages = {
        'channel-1': [
          buildMessage({
            id: 'client-main',
            channelId: 'channel-1',
            clientMsgId: 'client-main',
            sendStatus: 'sending',
          }),
          buildMessage({
            id: 'client-encrypted',
            channelId: 'channel-1',
            clientMsgId: 'client-encrypted',
            contentMode: 'dm_pairwise_signal_v1',
            sendStatus: 'sending',
          }),
        ],
      }
      chat.threadMessages = {
        'root-1': [buildMessage({
          id: 'client-thread',
          channelId: 'channel-1',
          clientMsgId: 'client-thread',
          threadRootMessageId: 'root-1',
          sendStatus: 'sending',
        })],
      }

      chat.handleBootstrapResponse(create(BootstrapResponseSchema, {
        snapshotSeq: 8n,
        userRole: 2,
        workspace: {
          workspaceId: 'workspace-1',
          workspaceName: 'Acme',
          selfUser: create(UserSummarySchema, { userId: 'user-1', displayName: 'Ada', avatarUrl: '' }),
          selfRole: 3,
        },
        conversations: [create(ConversationSummarySchema, {
          conversationId: 'channel-1',
          conversationType: 2,
          title: 'general',
          notificationLevel: NotificationLevel.ALL,
        })],
        unread: [],
        activeCalls: [],
        pendingInvites: [],
        notifications: [],
        hasMore: false,
        bootstrapSessionId: 'session-healthy-bootstrap',
        pageIndex: 0,
        pageSizeEffective: 1,
        estimatedTotalConversations: 1,
        presence: [],
      }))

      expect(chat.messages['channel-1'].find(message => message.clientMsgId === 'client-main')?.sendStatus).toBe('sending')
      expect(chat.messages['channel-1'].find(message => message.clientMsgId === 'client-encrypted')?.sendStatus).toBe('sending')
      expect(chat.threadMessages['root-1'][0].sendStatus).toBe('sending')
      expect(offlineQueueMocks.enqueue).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('hydrates workspace user call presence from bootstrap page 0', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.setLiveSynced = vi.fn()
    ws.sendAck = vi.fn()

    chat.handleBootstrapResponse(create(BootstrapResponseSchema, {
      snapshotSeq: 9n,
      userRole: 2,
      workspace: {
        workspaceId: 'workspace-1',
        workspaceName: 'Acme',
        selfUser: create(UserSummarySchema, { userId: 'user-1', displayName: 'Ada', avatarUrl: '' }),
        selfRole: 3,
      },
      conversations: [],
      unread: [],
      activeCalls: [],
      userCallPresence: [
        create(UserCallPresenceSummarySchema, { userId: 'user-2', activeCallCount: 2 }),
      ],
      pendingInvites: [],
      notifications: [],
      hasMore: false,
      nextPageToken: '',
      bootstrapSessionId: 'session-user-call-presence',
      pageIndex: 0,
      pageSizeEffective: 0,
      estimatedTotalConversations: 0,
      presence: [],
    }))

    expect(chat.userCallPresenceByUserId).toEqual({ 'user-2': 2 })
  })

  it('does not fall back to stale workspace custom status after an explicit clear', () => {
    const chat = useChatStore()
    chat.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfAvatarUrl: '',
      selfCustomStatus: {
        text: 'In a meeting',
        emoji: 'M',
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
      selfRole: 'member',
    }

    expect(chat.resolveUserCustomStatus('user-1')?.text).toBe('In a meeting')

    chat.registerUserIdentity('user-1', 'Ada', undefined, '', null)

    expect(chat.resolveUserCustomStatus('user-1')).toBeNull()
    expect(chat.workspace?.selfCustomStatus).toBeNull()
  })

  it('updates existing sender avatars and invalidates the previous cached avatar on identity update', () => {
    const chat = useChatStore()
    chat.userAvatars = {
      'user-2': '/api/public/avatars/avatars/user-2/old.png',
    }
    chat.directMessages = [{
      id: 'dm-1',
      userId: 'user-2',
      displayName: 'Bob',
      avatarUrl: '/api/public/avatars/avatars/user-2/old.png',
      presence: 'offline',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chat.messages = {
      'channel-1': [
        buildMessage({
          id: 'message-1',
          senderId: 'user-2',
          senderAvatarUrl: '/api/public/avatars/avatars/user-2/old.png',
        }),
      ],
    }
    chat.threadMessages = {
      'root-1': [
        buildMessage({
          id: 'reply-1',
          senderId: 'user-2',
          threadRootMessageId: 'root-1',
          senderAvatarUrl: '/api/public/avatars/avatars/user-2/old.png',
        }),
      ],
    }

    chat.registerUserIdentity('user-2', 'Bob', undefined, '/api/public/avatars/avatars/user-2/new.png')

    expect(chat.messages['channel-1'][0].senderAvatarUrl).toBe('/api/public/avatars/avatars/user-2/new.png')
    expect(chat.threadMessages['root-1'][0].senderAvatarUrl).toBe('/api/public/avatars/avatars/user-2/new.png')
    expect(chat.directMessages[0].avatarUrl).toBe('/api/public/avatars/avatars/user-2/new.png')
    expect(avatarCacheMocks.invalidateUserAvatar).toHaveBeenCalledWith(
      '/api/public/avatars/avatars/user-2/old.png',
      '/api/public/avatars/avatars/user-2/new.png',
    )
  })

  it('clears existing sender avatars and invalidates the cached avatar when avatar is removed', () => {
    const chat = useChatStore()
    chat.userAvatars = {
      'user-2': '/api/public/avatars/avatars/user-2/old.png',
    }
    chat.messages = {
      'channel-1': [
        buildMessage({
          id: 'message-1',
          senderId: 'user-2',
          senderAvatarUrl: '/api/public/avatars/avatars/user-2/old.png',
        }),
      ],
    }
    chat.threadMessages = {
      'root-1': [
        buildMessage({
          id: 'reply-1',
          senderId: 'user-2',
          threadRootMessageId: 'root-1',
          senderAvatarUrl: '/api/public/avatars/avatars/user-2/old.png',
        }),
      ],
    }

    chat.registerUserIdentity('user-2', 'Bob', undefined, '')

    expect(chat.resolveAvatarUrl('user-2')).toBe('')
    expect(chat.messages['channel-1'][0].senderAvatarUrl).toBe('')
    expect(chat.threadMessages['root-1'][0].senderAvatarUrl).toBe('')
    expect(avatarCacheMocks.invalidateUserAvatar).toHaveBeenCalledWith('/api/public/avatars/avatars/user-2/old.png', '')
  })

  it('restores last opened conversation from local storage on bootstrap when still accessible', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.setLiveSynced = vi.fn()
    ws.sendAck = vi.fn()

    saveLastOpenedConversation('workspace-1', 'user-1', 'dm-1')

    chat.handleBootstrapResponse(create(BootstrapResponseSchema, {
      snapshotSeq: 10n,
      userRole: 2,
      workspace: {
        workspaceId: 'workspace-1',
        workspaceName: 'Acme',
        selfUser: create(UserSummarySchema, { userId: 'user-1', displayName: 'Ada', avatarUrl: '' }),
        selfRole: 3,
      },
      conversations: [
        create(ConversationSummarySchema, {
          conversationId: 'channel-1',
          conversationType: 2,
          title: 'general',
          topic: '',
          isArchived: false,
          notificationLevel: NotificationLevel.ALL,
          lastMessageSeq: 0n,
          lastMessagePreview: '',
          memberCount: 1,
          presence: 3,
        }),
        create(ConversationSummarySchema, {
          conversationId: 'dm-1',
          conversationType: 1,
          title: 'Bob',
          topic: 'user-2',
          isArchived: false,
          notificationLevel: NotificationLevel.ALL,
          lastMessageSeq: 0n,
          lastMessagePreview: '',
          memberCount: 2,
          presence: 3,
        }),
      ],
      unread: [],
      activeCalls: [],
      pendingInvites: [],
      notifications: [],
      hasMore: false,
      nextPageToken: '',
      bootstrapSessionId: 'session-restore',
      pageIndex: 0,
      pageSizeEffective: 2,
      estimatedTotalConversations: 2,
      presence: [],
    }))

    expect(chat.activeChannelId).toBe('dm-1')
  })

  it('falls back to first public channel when persisted conversation is inaccessible', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.setLiveSynced = vi.fn()
    ws.sendAck = vi.fn()

    saveLastOpenedConversation('workspace-1', 'user-1', 'missing-conversation')

    chat.handleBootstrapResponse(create(BootstrapResponseSchema, {
      snapshotSeq: 10n,
      userRole: 2,
      workspace: {
        workspaceId: 'workspace-1',
        workspaceName: 'Acme',
        selfUser: create(UserSummarySchema, { userId: 'user-1', displayName: 'Ada', avatarUrl: '' }),
        selfRole: 3,
      },
      conversations: [
        create(ConversationSummarySchema, {
          conversationId: 'channel-private-1',
          conversationType: 3,
          title: 'private-team',
          topic: '',
          isArchived: false,
          notificationLevel: NotificationLevel.ALL,
          lastMessageSeq: 0n,
          lastMessagePreview: '',
          memberCount: 1,
          presence: 3,
        }),
        create(ConversationSummarySchema, {
          conversationId: 'channel-public-1',
          conversationType: 2,
          title: 'general',
          topic: '',
          isArchived: false,
          notificationLevel: NotificationLevel.ALL,
          lastMessageSeq: 0n,
          lastMessagePreview: '',
          memberCount: 1,
          presence: 3,
        }),
      ],
      unread: [],
      activeCalls: [],
      pendingInvites: [],
      notifications: [],
      hasMore: false,
      nextPageToken: '',
      bootstrapSessionId: 'session-fallback-public',
      pageIndex: 0,
      pageSizeEffective: 2,
      estimatedTotalConversations: 2,
      presence: [],
    }))

    expect(chat.activeChannelId).toBe('channel-public-1')
  })

  it('keeps no selection when persisted conversation is inaccessible and no public channel exists', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.setLiveSynced = vi.fn()
    ws.sendAck = vi.fn()

    saveLastOpenedConversation('workspace-1', 'user-1', 'missing-conversation')

    chat.handleBootstrapResponse(create(BootstrapResponseSchema, {
      snapshotSeq: 10n,
      userRole: 2,
      workspace: {
        workspaceId: 'workspace-1',
        workspaceName: 'Acme',
        selfUser: create(UserSummarySchema, { userId: 'user-1', displayName: 'Ada', avatarUrl: '' }),
        selfRole: 3,
      },
      conversations: [
        create(ConversationSummarySchema, {
          conversationId: 'channel-private-1',
          conversationType: 3,
          title: 'private-team',
          topic: '',
          isArchived: false,
          notificationLevel: NotificationLevel.ALL,
          lastMessageSeq: 0n,
          lastMessagePreview: '',
          memberCount: 1,
          presence: 3,
        }),
        create(ConversationSummarySchema, {
          conversationId: 'dm-1',
          conversationType: 1,
          title: 'Bob',
          topic: 'user-2',
          isArchived: false,
          notificationLevel: NotificationLevel.ALL,
          lastMessageSeq: 0n,
          lastMessagePreview: '',
          memberCount: 2,
          presence: 3,
        }),
      ],
      unread: [],
      activeCalls: [],
      pendingInvites: [],
      notifications: [],
      hasMore: false,
      nextPageToken: '',
      bootstrapSessionId: 'session-fallback-empty',
      pageIndex: 0,
      pageSizeEffective: 2,
      estimatedTotalConversations: 2,
      presence: [],
    }))

    expect(chat.activeChannelId).toBe('')
  })

  it('stores selected conversation in local storage after user selection', () => {
    const chat = useChatStore()
    chat.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfRole: 'member',
    }
    chat.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      lastMessageSeq: 1n,
      notificationLevel: NotificationLevel.ALL,
    }]

    chat.selectChannel('channel-1')

    expect(loadLastOpenedConversation('workspace-1', 'user-1')).toBe('channel-1')
    expect(chat.conversationComposerFocusToken).toBe(1)
  })

  it('accepts authorized live events even when global seq values skip filtered events', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.sendSyncSince = vi.fn()
    ws.setRecoveringGap = vi.fn()

    chat.bootstrapped = true
    chat.lastAppliedEventSeq = 5n

    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 7n,
      eventId: 'evt-7',
      eventType: 4,
      conversationId: 'channel-1',
      payload: {
        case: 'messageCreated',
        value: create(MessageEventSchema, {
          conversationId: 'channel-1',
          messageId: 'message-7',
          senderId: 'user-1',
          body: 'hello',
          channelSeq: 7n,
          threadRootMessageId: '',
          threadSeq: 0n,
          mentionedUserIds: [],
          mentionEveryone: false,
        }),
      },
    }))

    expect(ws.setRecoveringGap).not.toHaveBeenCalled()
    expect(ws.sendSyncSince).not.toHaveBeenCalled()
    expect(chat.lastAppliedEventSeq).toBe(7n)
    expect(chat.messages['channel-1']).toHaveLength(1)
  })

  it('maps thumbnail metadata from message_created events', () => {
    const chat = useChatStore()
    chat.bootstrapped = true

    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 1n,
      eventId: 'evt-thumbnail-1',
      eventType: EventType.MESSAGE_CREATED,
      conversationId: 'channel-1',
      payload: {
        case: 'messageCreated',
        value: create(MessageEventSchema, {
          conversationId: 'channel-1',
          messageId: 'message-thumbnail-1',
          senderId: 'user-2',
          body: 'photo',
          channelSeq: 1n,
          attachments: [create(MessageAttachmentSchema, {
            attachmentId: 'attachment-thumbnail',
            fileName: 'photo.png',
            fileSize: 1024n,
            mimeType: 'image/png',
            thumbnailMimeType: 'image/jpeg',
            thumbnailFileSize: 128n,
            thumbnailVersion: 1,
          })],
        }),
      },
    }))

    expect(chat.messages['channel-1'][0].attachments).toEqual([{
      id: 'attachment-thumbnail',
      fileName: 'photo.png',
      fileSize: 1024,
      mimeType: 'image/png',
      thumbnailMimeType: 'image/jpeg',
      thumbnailFileSize: 128,
      thumbnailVersion: 1,
    }])
  })

  it('maps forwarded metadata from message_created events', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.sendSyncSince = vi.fn()
    ws.setRecoveringGap = vi.fn()

    chat.bootstrapped = true
    chat.lastAppliedEventSeq = 5n

    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 6n,
      eventId: 'evt-6',
      eventType: EventType.MESSAGE_CREATED,
      conversationId: 'channel-1',
      payload: {
        case: 'messageCreated',
        value: create(MessageEventSchema, {
          conversationId: 'channel-1',
          messageId: 'message-6',
          senderId: 'user-1',
          body: 'forwarded body',
          channelSeq: 6n,
          mentionedUserIds: [],
          mentionEveryone: false,
          forwardedFromMessageId: 'source-1',
          forwardedFromSenderId: 'user-9',
          forwardedFromSenderName: 'Original Sender',
          forwardedFromConversationKind: 'channel',
          forwardedFromConversationTitle: 'general',
          forwardedFromThreadTitle: 'Launch thread',
        }),
      },
    }))

    expect(chat.messages['channel-1'][0].forwardedFrom).toEqual({
      messageId: 'source-1',
      senderId: 'user-9',
      senderName: 'Original Sender',
      conversationKind: 'channel',
      conversationTitle: 'general',
      threadTitle: 'Launch thread',
    })
  })

  it('continues sync pagination when auth-filtered replay returns fewer than the page size', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.sendSyncSince = vi.fn()
    ws.setLiveSynced = vi.fn()

    chat.bootstrapped = true
    chat.lastAppliedEventSeq = 10n

    chat.handleSyncSinceResponse(create(SyncSinceResponseSchema, {
      events: [
        create(ServerEventSchema, {
          eventSeq: 12n,
          eventId: 'evt-12',
          eventType: EventType.MESSAGE_CREATED,
          conversationId: 'channel-1',
          payload: {
            case: 'messageCreated',
            value: create(MessageEventSchema, {
              conversationId: 'channel-1',
              messageId: 'message-12',
              senderId: 'user-2',
              body: 'visible after filtered event',
              channelSeq: 12n,
              threadRootMessageId: '',
              threadSeq: 0n,
              mentionedUserIds: [],
              mentionEveryone: false,
            }),
          },
        }),
      ],
      syncCursor: 40n,
      needFullBootstrap: false,
    }))

    expect(chat.lastAppliedEventSeq).toBe(40n)
    expect(ws.sendSyncSince).toHaveBeenCalledWith(40n, 200)
    expect(ws.setLiveSynced).not.toHaveBeenCalled()
  })

  it('yields between bounded sync replay chunks without reordering events', async () => {
    vi.useFakeTimers()
    try {
      const chat = useChatStore()
      const ws = useWsStore()
      ws.sendSyncSince = vi.fn()
      chat.bootstrapped = true

      const events = Array.from({ length: 26 }, (_, index) => {
        const sequence = BigInt(index + 1)
        return create(ServerEventSchema, {
          eventSeq: sequence,
          eventId: `evt-sync-${sequence}`,
          eventType: EventType.MESSAGE_CREATED,
          conversationId: 'channel-1',
          payload: {
            case: 'messageCreated',
            value: create(MessageEventSchema, {
              conversationId: 'channel-1',
              messageId: `message-sync-${sequence}`,
              senderId: 'user-2',
              body: `sync ${sequence}`,
              channelSeq: sequence,
              threadRootMessageId: '',
              threadSeq: 0n,
              mentionedUserIds: [],
              mentionEveryone: false,
            }),
          },
        })
      })

      chat.handleSyncSinceResponse(create(SyncSinceResponseSchema, {
        events,
        syncCursor: 26n,
        needFullBootstrap: false,
      }))

      expect(chat.lastAppliedEventSeq).toBe(25n)
      expect(chat.messages['channel-1']).toHaveLength(25)

      await vi.advanceTimersByTimeAsync(0)

      expect(chat.lastAppliedEventSeq).toBe(26n)
      expect(chat.messages['channel-1'].map(message => message.id)).toEqual(
        Array.from({ length: 26 }, (_, index) => `message-sync-${index + 1}`),
      )
      expect(ws.sendSyncSince).toHaveBeenCalledWith(26n, 200)
    } finally {
      vi.useRealTimers()
    }
  })

  it('persists the replay cursor before sending its matching ACK', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.sendAck = vi.fn(() => {
      expect(storage.getItem('msgnr:last-applied-event-seq')).toBe('20')
      return true
    })
    chat.bootstrapped = true

    const events = Array.from({ length: 20 }, (_, index) => {
      const sequence = BigInt(index + 1)
      return create(ServerEventSchema, {
        eventSeq: sequence,
        eventId: `evt-ack-${sequence}`,
        eventType: EventType.MESSAGE_CREATED,
        conversationId: 'channel-1',
        payload: {
          case: 'messageCreated',
          value: create(MessageEventSchema, {
            conversationId: 'channel-1',
            messageId: `message-ack-${sequence}`,
            senderId: 'user-2',
            body: `ack ${sequence}`,
            channelSeq: sequence,
          }),
        },
      })
    })

    chat.handleSyncSinceResponse(create(SyncSinceResponseSchema, {
      events,
      syncCursor: 20n,
      needFullBootstrap: false,
    }))

    expect(ws.sendAck).toHaveBeenCalledWith(20n)
  })

  it('retries an ACK that was not sent without treating it as in flight', async () => {
    vi.useFakeTimers()
    try {
      const chat = useChatStore()
      const ws = useWsStore()
      ws.sendAck = vi.fn()
        .mockReturnValueOnce(false)
        .mockImplementationOnce(() => {
          throw new Error('socket closed while sending ACK')
        })
        .mockReturnValue(true)
      chat.bootstrapped = true

      chat.handleSyncSinceResponse(create(SyncSinceResponseSchema, {
        events: Array.from({ length: 20 }, (_, index) => buildSequencedMessageEvent(BigInt(index + 1))),
        syncCursor: 20n,
        needFullBootstrap: false,
      }))

      expect(ws.sendAck).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(2000)
      expect(ws.sendAck).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(2000)
      expect(ws.sendAck).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a delayed ACK when bootstrap restarts', () => {
    vi.useFakeTimers()
    try {
      const chat = useChatStore()
      const ws = useWsStore()
      ws.sendAck = vi.fn().mockReturnValue(true)
      ws.sendBootstrap = vi.fn()
      chat.bootstrapped = true

      chat.handleServerEvent(buildSequencedMessageEvent(1n))
      chat.startBootstrap()

      vi.advanceTimersByTime(2000)
      expect(ws.sendAck).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('recovers from a replay apply failure without ACKing its cursor or poisoning later replay', async () => {
    vi.useFakeTimers()
    try {
      const chat = useChatStore()
      const ws = useWsStore()
      ws.sendAck = vi.fn().mockReturnValue(true)
      ws.sendBootstrap = vi.fn()
      ws.setStaleRebootstrap = vi.fn()
      chat.bootstrapped = true

      // Queue a delayed ACK for the last known-good cursor, then make the
      // next replay event fail while mutating its destination collection.
      chat.handleServerEvent(buildSequencedMessageEvent(1n))
      chat.messages = {
        'channel-1': Object.freeze([]) as unknown as Message[],
      }
      chat.handleSyncSinceResponse(create(SyncSinceResponseSchema, {
        events: [buildSequencedMessageEvent(2n)],
        syncCursor: 2n,
        needFullBootstrap: false,
      }))

      await Promise.resolve()
      await Promise.resolve()

      expect(chat.lastAppliedEventSeq).toBe(1n)
      expect(ws.setStaleRebootstrap).toHaveBeenCalledTimes(1)
      expect(ws.sendBootstrap).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(2000)
      expect(ws.sendAck).not.toHaveBeenCalled()

      chat.messages = {}
      chat.handleSyncSinceResponse(create(SyncSinceResponseSchema, {
        events: [buildSequencedMessageEvent(2n)],
        syncCursor: 2n,
        needFullBootstrap: false,
      }))
      await Promise.resolve()
      await Promise.resolve()

      expect(chat.lastAppliedEventSeq).toBe(2n)
      expect(chat.messages['channel-1'].map(message => message.id)).toEqual(['message-2'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses bootstrap instead of syncSince when reconnecting with a cached snapshot and cursor', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.sendBootstrap = vi.fn()
    ws.sendSyncSince = vi.fn()

    chat.bootstrapped = true
    chat.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfRole: 'member',
    }
    chat.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 9,
      hasUnreadThreadReplies: true,
      lastMessageSeq: 30n,
      notificationLevel: NotificationLevel.ALL,
    }]
    chat.lastAppliedEventSeq = 30n
    ws.authResult = {
      userId: 'user-1',
      sessionId: 'session-1',
      persistedEventSeq: 30n,
      userRole: 'member',
    }

    chat.startRealtimeFlow()

    expect(ws.sendBootstrap).toHaveBeenCalledTimes(1)
    expect(ws.sendSyncSince).not.toHaveBeenCalled()
  })

  it('marks reconnect bootstrap as stale when the server cursor is ahead of the local snapshot', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.sendBootstrap = vi.fn()
    ws.sendSyncSince = vi.fn()
    ws.setStaleRebootstrap = vi.fn()

    chat.bootstrapped = true
    chat.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfRole: 'member',
    }
    chat.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 2,
      hasUnreadThreadReplies: false,
      lastMessageSeq: 10n,
      notificationLevel: NotificationLevel.ALL,
    }]
    chat.lastAppliedEventSeq = 10n
    ws.authResult = {
      userId: 'user-1',
      sessionId: 'session-1',
      persistedEventSeq: 12n,
      userRole: 'member',
    }

    chat.startRealtimeFlow()

    expect(ws.setStaleRebootstrap).toHaveBeenCalledTimes(1)
    expect(ws.sendBootstrap).toHaveBeenCalledTimes(1)
    expect(ws.sendSyncSince).not.toHaveBeenCalled()
  })

  it('sends UpdateReadCursor when selecting a conversation with unread messages', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.sendUpdateReadCursor = vi.fn()

    chat.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 3,
      lastMessageSeq: 12n,
      notificationLevel: NotificationLevel.ALL,
    }]

    chat.selectChannel('channel-1')

    expect(ws.sendUpdateReadCursor).toHaveBeenCalledWith('channel-1', 12n)
    expect(chat.channels[0].unread).toBe(0)
  })

  it('defers read mark for opened conversation while tab is hidden and flushes on focus', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.sendUpdateReadCursor = vi.fn()
    chat.setClientActive(false)

    chat.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 3,
      lastMessageSeq: 12n,
      notificationLevel: NotificationLevel.ALL,
    }]

    chat.selectChannel('channel-1')

    expect(ws.sendUpdateReadCursor).not.toHaveBeenCalled()
    expect(chat.channels[0].unread).toBe(3)

    chat.setClientActive(true)
    chat.onClientFocus()

    expect(ws.sendUpdateReadCursor).toHaveBeenCalledWith('channel-1', 12n)
    expect(chat.channels[0].unread).toBe(0)
  })

  it('updates live presence for direct messages', () => {
    const chat = useChatStore()

    chat.directMessages = [{
      id: 'dm-1',
      userId: 'user-2',
      displayName: 'Bob',
      presence: 'offline',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]

    chat.handlePresenceEvent(create(PresenceEventSchema, {
      userId: 'user-2',
      effectivePresence: PresenceStatus.ONLINE,
    }))

    expect(chat.presenceByUserId['user-2']?.effectivePresence).toBe(PresenceStatus.ONLINE)
    expect(chat.directMessages[0].presence).toBe('online')
  })

  it('replaces stale unread counters and presence only after reconnect bootstrap completes', async () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.setLiveSynced = vi.fn()
    ws.sendAck = vi.fn()
    ws.sendBootstrap = vi.fn()

    saveLastOpenedConversation('workspace-1', 'user-1', 'dm-1')
    chat.activeChannelId = 'dm-1'
    chat.bootstrapped = true
    chat.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfRole: 'member',
    }
    chat.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 9,
      hasUnreadThreadReplies: true,
      lastMessageSeq: 30n,
      notificationLevel: NotificationLevel.ALL,
    }]
    chat.directMessages = [{
      id: 'dm-1',
      userId: 'user-2',
      displayName: 'Bob',
      avatarUrl: '',
      presence: 'offline',
      unread: 5,
      hasUnreadThreadReplies: false,
      lastMessageSeq: 20n,
      notificationLevel: NotificationLevel.ALL,
    }]
    chat.messages = {
      'dm-1': [
        buildMessage({
          id: 'cached-message-1',
          channelId: 'dm-1',
          body: 'cached shell',
          channelSeq: 20n,
        }),
      ],
    }
    chatApiMocks.listConversationMessages.mockResolvedValue({
      messages: [
        {
          id: 'message-21',
          conversation_id: 'dm-1',
          sender_id: 'user-2',
          sender_name: 'Bob',
          body: 'authoritative history',
          channel_seq: '21',
          thread_seq: '0',
          thread_root_message_id: '',
          mention_everyone: false,
          created_at: '2026-03-06T00:00:00Z',
        },
      ],
      has_more: false,
      page_size: 50,
      next_before_channel_seq: '',
    })

    chat.handleBootstrapResponse(create(BootstrapResponseSchema, {
      snapshotSeq: 40n,
      userRole: 2,
      workspace: {
        workspaceId: 'workspace-1',
        workspaceName: 'Acme',
        selfUser: create(UserSummarySchema, { userId: 'user-1', displayName: 'Ada', avatarUrl: '' }),
        selfRole: 3,
      },
      conversations: [create(ConversationSummarySchema, {
        conversationId: 'channel-1',
        conversationType: 2,
        title: 'general',
        topic: '',
        isArchived: false,
        notificationLevel: NotificationLevel.ALL,
        lastMessageSeq: 30n,
        lastMessagePreview: 'channel preview',
        memberCount: 2,
        presence: PresenceStatus.OFFLINE,
      })],
      unread: [create(UnreadCounterSchema, {
        conversationId: 'channel-1',
        unreadMessages: 1,
        unreadMentions: 0,
        hasUnreadThreadReplies: false,
        lastReadSeq: 29n,
      })],
      activeCalls: [],
      pendingInvites: [],
      notifications: [],
      hasMore: true,
      nextPageToken: 'page-2',
      bootstrapSessionId: 'session-reconnect',
      pageIndex: 0,
      pageSizeEffective: 1,
      estimatedTotalConversations: 2,
      presence: [create(PresenceEventSchema, {
        userId: 'user-2',
        effectivePresence: PresenceStatus.ONLINE,
      })],
    }))

    expect(chat.channels[0].unread).toBe(9)
    expect(chat.directMessages[0].presence).toBe('offline')
    expect(chat.messages['dm-1'][0].body).toBe('cached shell')
    expect(chat.activeChannelId).toBe('dm-1')

    chat.handleBootstrapResponse(create(BootstrapResponseSchema, {
      snapshotSeq: 40n,
      conversations: [create(ConversationSummarySchema, {
        conversationId: 'dm-1',
        conversationType: 1,
        title: 'Bob',
        topic: 'user-2',
        isArchived: false,
        notificationLevel: NotificationLevel.ALL,
        lastMessageSeq: 21n,
        lastMessagePreview: 'authoritative history',
        memberCount: 2,
        presence: PresenceStatus.OFFLINE,
      })],
      unread: [create(UnreadCounterSchema, {
        conversationId: 'dm-1',
        unreadMessages: 0,
        unreadMentions: 0,
        hasUnreadThreadReplies: false,
        lastReadSeq: 21n,
      })],
      activeCalls: [],
      pendingInvites: [],
      notifications: [],
      hasMore: false,
      nextPageToken: '',
      bootstrapSessionId: 'session-reconnect',
      pageIndex: 1,
      pageSizeEffective: 1,
      estimatedTotalConversations: 2,
      presence: [],
    }))
    await Promise.resolve()

    expect(chat.channels[0].unread).toBe(1)
    expect(chat.channels[0].hasUnreadThreadReplies).toBe(false)
    expect(chat.directMessages[0].unread).toBe(0)
    expect(chat.directMessages[0].presence).toBe('online')
    expect(chat.activeChannelId).toBe('dm-1')
    expect(chatApiMocks.listConversationMessages).toHaveBeenCalledWith('dm-1', undefined)
    expect(chat.messages['dm-1'].some(message => message.body === 'authoritative history')).toBe(true)
  })

  it('keeps newer realtime presence when reconnect bootstrap finishes with an older snapshot', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.setLiveSynced = vi.fn()
    ws.sendAck = vi.fn()

    chat.handleBootstrapResponse(create(BootstrapResponseSchema, {
      snapshotSeq: 50n,
      userRole: 2,
      workspace: {
        workspaceId: 'workspace-1',
        workspaceName: 'Acme',
        selfUser: create(UserSummarySchema, { userId: 'user-1', displayName: 'Ada', avatarUrl: '' }),
        selfRole: 3,
      },
      conversations: [create(ConversationSummarySchema, {
        conversationId: 'channel-1',
        conversationType: 2,
        title: 'general',
        topic: '',
        isArchived: false,
        notificationLevel: NotificationLevel.ALL,
        lastMessageSeq: 10n,
        lastMessagePreview: '',
        memberCount: 2,
        presence: PresenceStatus.OFFLINE,
      })],
      unread: [],
      activeCalls: [],
      pendingInvites: [],
      notifications: [],
      hasMore: true,
      nextPageToken: 'page-2',
      bootstrapSessionId: 'session-reconnect',
      pageIndex: 0,
      pageSizeEffective: 1,
      estimatedTotalConversations: 2,
      presence: [create(PresenceEventSchema, {
        userId: 'user-2',
        effectivePresence: PresenceStatus.OFFLINE,
        lastActiveAt: { seconds: 100n, nanos: 0 },
      })],
    }))

    chat.handlePresenceEvent(create(PresenceEventSchema, {
      userId: 'user-2',
      effectivePresence: PresenceStatus.ONLINE,
      lastActiveAt: { seconds: 200n, nanos: 0 },
    }))

    chat.handleBootstrapResponse(create(BootstrapResponseSchema, {
      snapshotSeq: 50n,
      conversations: [create(ConversationSummarySchema, {
        conversationId: 'dm-1',
        conversationType: 1,
        title: 'Bob',
        topic: 'user-2',
        isArchived: false,
        notificationLevel: NotificationLevel.ALL,
        lastMessageSeq: 11n,
        lastMessagePreview: '',
        memberCount: 2,
        presence: PresenceStatus.OFFLINE,
      })],
      unread: [],
      activeCalls: [],
      pendingInvites: [],
      notifications: [],
      hasMore: false,
      nextPageToken: '',
      bootstrapSessionId: 'session-reconnect',
      pageIndex: 1,
      pageSizeEffective: 1,
      estimatedTotalConversations: 2,
      presence: [],
    }))

    expect(chat.presenceByUserId['user-2']?.effectivePresence).toBe(PresenceStatus.ONLINE)
    expect(chat.directMessages[0].presence).toBe('online')
  })

  it('hydrates DM peer user id from bootstrap and applies later presence updates', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.setLiveSynced = vi.fn()
    ws.sendAck = vi.fn()

    chat.handleBootstrapResponse(create(BootstrapResponseSchema, {
      snapshotSeq: 11n,
      userRole: 2,
      workspace: {
        workspaceId: 'workspace-1',
        workspaceName: 'Acme',
        selfUser: create(UserSummarySchema, { userId: 'self-user', displayName: 'Self', avatarUrl: '' }),
        selfRole: 3,
      },
      conversations: [create(ConversationSummarySchema, {
        conversationId: 'dm-conversation-1',
        conversationType: 1,
        title: 'Bob',
        topic: 'peer-user-1',
        isArchived: false,
        notificationLevel: NotificationLevel.ALL,
        lastMessageSeq: 0n,
        lastMessagePreview: '',
        memberCount: 2,
        presence: 3,
      })],
      unread: [],
      activeCalls: [],
      pendingInvites: [],
      notifications: [],
      hasMore: false,
      nextPageToken: '',
      bootstrapSessionId: 'session-dm',
      pageIndex: 0,
      pageSizeEffective: 1,
      estimatedTotalConversations: 1,
      presence: [],
    }))

    expect(chat.directMessages).toHaveLength(1)
    expect(chat.directMessages[0].userId).toBe('peer-user-1')
    expect(chat.directMessages[0].presence).toBe('offline')

    chat.handlePresenceEvent(create(PresenceEventSchema, {
      userId: 'peer-user-1',
      effectivePresence: PresenceStatus.ONLINE,
    }))

    expect(chat.directMessages[0].presence).toBe('online')
  })

  it('preserves encrypted DM mode from bootstrap after page refresh', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.setLiveSynced = vi.fn()
    ws.sendAck = vi.fn()

    chat.handleBootstrapResponse(create(BootstrapResponseSchema, {
      snapshotSeq: 12n,
      userRole: 2,
      workspace: {
        workspaceId: 'workspace-1',
        workspaceName: 'Acme',
        selfUser: create(UserSummarySchema, { userId: 'self-user', displayName: 'Self', avatarUrl: '' }),
        selfRole: 3,
      },
      conversations: [create(ConversationSummarySchema, {
        conversationId: 'dm-e2ee-conversation-1',
        conversationType: 1,
        title: 'Bob',
        topic: 'peer-user-1',
        isArchived: false,
        notificationLevel: NotificationLevel.ALL,
        lastMessageSeq: 0n,
        lastMessagePreview: '',
        memberCount: 2,
        presence: 3,
        encryptionMode: ConversationEncryptionMode.DM_PAIRWISE_SIGNAL_V1,
      })],
      unread: [],
      activeCalls: [],
      pendingInvites: [],
      notifications: [],
      hasMore: false,
      nextPageToken: '',
      bootstrapSessionId: 'session-dm-e2ee',
      pageIndex: 0,
      pageSizeEffective: 1,
      estimatedTotalConversations: 1,
      presence: [],
    }))

    expect(chat.directMessages).toHaveLength(1)
    expect(chat.directMessages[0].encryptionMode).toBe('dm_pairwise_signal_v1')
  })

  it('hydrates DM avatar from user directory after bootstrap refresh', async () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.setLiveSynced = vi.fn()
    ws.sendAck = vi.fn()
    chatApiMocks.listDmCandidates.mockResolvedValue([
      {
        user_id: 'peer-user-1',
        display_name: 'Bob',
        email: 'bob@example.com',
        avatar_url: '/api/public/avatars/avatars/peer-user-1/avatar.png',
      },
    ])

    chat.handleBootstrapResponse(create(BootstrapResponseSchema, {
      snapshotSeq: 12n,
      userRole: 2,
      workspace: {
        workspaceId: 'workspace-1',
        workspaceName: 'Acme',
        selfUser: create(UserSummarySchema, { userId: 'self-user', displayName: 'Self', avatarUrl: '' }),
        selfRole: 3,
      },
      conversations: [create(ConversationSummarySchema, {
        conversationId: 'dm-conversation-1',
        conversationType: 1,
        title: 'Bob',
        topic: 'peer-user-1',
        isArchived: false,
        notificationLevel: NotificationLevel.ALL,
        lastMessageSeq: 0n,
        lastMessagePreview: '',
        memberCount: 2,
        presence: 1,
      })],
      unread: [],
      activeCalls: [],
      pendingInvites: [],
      notifications: [],
      hasMore: false,
      nextPageToken: '',
      bootstrapSessionId: 'session-dm-avatar',
      pageIndex: 0,
      pageSizeEffective: 1,
      estimatedTotalConversations: 1,
      presence: [],
    }))

    await vi.waitFor(() => {
      expect(chatApiMocks.listDmCandidates).toHaveBeenCalledTimes(1)
      expect(chat.directMessages[0].avatarUrl).toBe('/api/public/avatars/avatars/peer-user-1/avatar.png')
    })
  })

  it('applies optimistic reaction and rolls back when ack fails', () => {
    const chat = useChatStore()

    chat.messages = {
      'channel-1': [{
        id: 'message-1',
        channelId: 'channel-1',
        senderId: 'user-2',
        senderName: 'Bob',
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

    chat.queueReactionOp('op-1', 'channel-1', 'message-1', ':+1:', 'add')
    expect(chat.messages['channel-1'][0].reactions).toEqual([{ emoji: ':+1:', count: 1 }])
    expect(chat.messages['channel-1'][0].myReactions).toEqual([':+1:'])

    chat.handleReactionAck({
      ok: false,
      messageId: 'message-1',
      emoji: ':+1:',
      clientOpId: 'op-1',
      applied: false,
    } as any)

    expect(chat.messages['channel-1'][0].reactions).toEqual([])
    expect(chat.messages['channel-1'][0].myReactions).toEqual([])
    expect(chat.toast?.message).toBe('Reaction failed. Try again.')
  })

  it('rolls back optimistic reaction when ack is ok but not applied', () => {
    const chat = useChatStore()

    chat.messages = {
      'channel-1': [{
        id: 'message-1',
        channelId: 'channel-1',
        senderId: 'user-2',
        senderName: 'Bob',
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

    chat.queueReactionOp('op-2', 'channel-1', 'message-1', ':+1:', 'add')
    expect(chat.messages['channel-1'][0].reactions).toEqual([{ emoji: ':+1:', count: 1 }])
    expect(chat.messages['channel-1'][0].myReactions).toEqual([':+1:'])

    chat.handleReactionAck({
      ok: true,
      messageId: 'message-1',
      emoji: ':+1:',
      clientOpId: 'op-2',
      applied: false,
    } as any)

    expect(chat.messages['channel-1'][0].reactions).toEqual([])
    expect(chat.messages['channel-1'][0].myReactions).toEqual([])
  })

  it('advances read cursor when a new message arrives in the active conversation', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.sendUpdateReadCursor = vi.fn()
    chat.setClientActive(true)

    chat.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfRole: 'member',
    }
    chat.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      lastMessageSeq: 1n,
      notificationLevel: NotificationLevel.ALL,
    }]
    chat.activeChannelId = 'channel-1'
    chat.bootstrapped = true

    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 1n,
      eventId: 'evt-1',
      eventType: 4,
      conversationId: 'channel-1',
      payload: {
        case: 'messageCreated',
        value: create(MessageEventSchema, {
          conversationId: 'channel-1',
          messageId: 'message-1',
          senderId: 'user-2',
          body: 'hello',
          channelSeq: 2n,
        }),
      },
    }))

    expect(ws.sendUpdateReadCursor).toHaveBeenCalledWith('channel-1', 2n)
  })

  it('resolves unknown WS sender name using email fallback from user directory', async () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.sendUpdateReadCursor = vi.fn()
    chat.setClientActive(true)
    chatApiMocks.listDmCandidates.mockResolvedValue([
      {
        user_id: 'user-2',
        display_name: '',
        email: 'user2@example.com',
        avatar_url: '',
      },
    ])

    chat.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfRole: 'member',
    }
    chat.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      lastMessageSeq: 1n,
      notificationLevel: NotificationLevel.ALL,
    }]
    chat.activeChannelId = 'channel-1'
    chat.bootstrapped = true

    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 1n,
      eventId: 'evt-unknown-sender',
      eventType: 4,
      conversationId: 'channel-1',
      payload: {
        case: 'messageCreated',
        value: create(MessageEventSchema, {
          conversationId: 'channel-1',
          messageId: 'message-1',
          senderId: 'user-2',
          body: 'hello',
          channelSeq: 2n,
        }),
      },
    }))

    await vi.waitFor(() => {
      expect(chatApiMocks.listDmCandidates).toHaveBeenCalledTimes(1)
      expect(chat.resolveDisplayName('user-2')).toBe('user2@example.com')
      expect(chat.messages['channel-1'][0].senderName).toBe('user2@example.com')
    })
  })

  it('triggers bootstrap refresh when notification references an unknown conversation', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.sendBootstrap = vi.fn()
    ws.sendAck = vi.fn()
    ws.state = 'LIVE_SYNCED'
    chat.bootstrapped = true

    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 1n,
      eventId: 'evt-notif-1',
      eventType: EventType.NOTIFICATION_ADDED,
      conversationId: 'private-1',
      payload: {
        case: 'notificationAdded',
        value: create(NotificationAddedEventSchema, {
          userId: 'user-1',
          notification: create(NotificationSummarySchema, {
            notificationId: 'notification-1',
            type: 5,
            title: 'Added to #secret',
            body: 'You were added to a private channel.',
            conversationId: 'private-1',
            isRead: false,
          }),
        }),
      },
    }))

    expect(ws.sendBootstrap).toHaveBeenCalledTimes(1)
  })

  it('uses notification title as sender fallback for inactive durable notifications', () => {
    const chat = useChatStore()
    chat.setClientActive(false)
    chat.bootstrapped = true

    const onIncoming = vi.fn()
    const off = chat.onIncomingMessageNotification(onIncoming)

    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 1n,
      eventId: 'evt-notif-sender-fallback-1',
      eventType: EventType.NOTIFICATION_ADDED,
      conversationId: 'channel-1',
      payload: {
        case: 'notificationAdded',
        value: create(NotificationAddedEventSchema, {
          userId: 'user-1',
          notification: create(NotificationSummarySchema, {
            notificationId: 'notification-sender-fallback-1',
            type: 5,
            title: 'Mention',
            body: 'You were mentioned',
            conversationId: 'channel-1',
            isRead: false,
          }),
        }),
      },
    }))

    expect(onIncoming).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'notification',
      senderName: 'Mention',
    }))

    off()
  })

  it('decodes escaped text for durable notifications', () => {
    const chat = useChatStore()
    chat.setClientActive(false)
    chat.bootstrapped = true

    const onIncoming = vi.fn()
    const off = chat.onIncomingMessageNotification(onIncoming)

    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 1n,
      eventId: 'evt-notif-decode-1',
      eventType: EventType.NOTIFICATION_ADDED,
      conversationId: 'channel-1',
      payload: {
        case: 'notificationAdded',
        value: create(NotificationAddedEventSchema, {
          userId: 'user-1',
          notification: create(NotificationSummarySchema, {
            notificationId: 'notification-decode-1',
            type: NotificationType.MENTION,
            title: 'Mention \\/ \\"Boss\\" \\u263A',
            body: 'Line 1\\\\nLine 2\\/done\\\\folder',
            conversationId: 'channel-1',
            isRead: false,
          }),
        }),
      },
    }))

    expect(chat.notifications[0]).toMatchObject({
      title: 'Mention / "Boss" ☺',
      body: 'Line 1\nLine 2/done\\folder',
    })
    expect(onIncoming).toHaveBeenCalledWith({
      reason: 'mention',
      conversationId: 'channel-1',
      senderId: '',
      senderName: 'Mention / "Boss" ☺',
      body: 'Line 1\nLine 2/done\\folder',
      attachmentCount: 0,
    })

    off()
  })

  it('tracks active calls from call_state_changed ACTIVE and ENDED events', () => {
    const chat = useChatStore()
    chat.bootstrapped = true
    chat.lastAppliedEventSeq = 0n

    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 1n,
      eventId: 'evt-call-active-1',
      eventType: EventType.CALL_STATE_CHANGED,
      conversationId: 'channel-1',
      payload: {
        case: 'callStateChanged',
        value: create(CallStateChangedEventSchema, {
          callId: 'call-1',
          conversationId: 'channel-1',
          status: CallStatus.ACTIVE,
        }),
      },
    }))

    expect(chat.activeCalls).toHaveLength(1)
    expect(chat.activeCalls[0].id).toBe('call-1')
    expect(chat.activeCalls[0].conversationId).toBe('channel-1')

    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 2n,
      eventId: 'evt-call-ended-1',
      eventType: EventType.CALL_STATE_CHANGED,
      conversationId: 'channel-1',
      payload: {
        case: 'callStateChanged',
        value: create(CallStateChangedEventSchema, {
          callId: 'call-1',
          conversationId: 'channel-1',
          status: CallStatus.ENDED,
        }),
      },
    }))

    expect(chat.activeCalls).toEqual([])
  })

  it('tracks workspace user call presence from user_call_presence_changed events', () => {
    const chat = useChatStore()
    chat.bootstrapped = true
    chat.lastAppliedEventSeq = 0n

    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 1n,
      eventId: 'evt-user-call-presence-1',
      eventType: EventType.USER_CALL_PRESENCE_CHANGED,
      payload: {
        case: 'userCallPresenceChanged',
        value: create(UserCallPresenceChangedEventSchema, {
          userId: 'user-2',
          activeCallCount: 2,
        }),
      },
    }))

    expect(chat.userCallPresenceByUserId).toEqual({ 'user-2': 2 })

    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 2n,
      eventId: 'evt-user-call-presence-2',
      eventType: EventType.USER_CALL_PRESENCE_CHANGED,
      payload: {
        case: 'userCallPresenceChanged',
        value: create(UserCallPresenceChangedEventSchema, {
          userId: 'user-2',
          activeCallCount: 0,
        }),
      },
    }))

    expect(chat.userCallPresenceByUserId).toEqual({})
  })

  it('defers active-conversation read mark when tab is hidden and leaves unread state to server counters', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.sendUpdateReadCursor = vi.fn()
    chat.setClientActive(false)

    chat.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfRole: 'member',
    }
    chat.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      lastMessageSeq: 1n,
      notificationLevel: NotificationLevel.ALL,
    }]
    chat.activeChannelId = 'channel-1'
    chat.bootstrapped = true

    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 1n,
      eventId: 'evt-hidden-1',
      eventType: 4,
      conversationId: 'channel-1',
      payload: {
        case: 'messageCreated',
        value: create(MessageEventSchema, {
          conversationId: 'channel-1',
          messageId: 'message-hidden-1',
          senderId: 'user-2',
          body: 'hidden hello',
          channelSeq: 2n,
        }),
      },
    }))

    expect(ws.sendUpdateReadCursor).not.toHaveBeenCalled()
    expect(chat.channels[0].unread).toBe(0)

    chat.setClientActive(true)
    chat.onClientFocus()

    expect(ws.sendUpdateReadCursor).toHaveBeenCalledWith('channel-1', 2n)
    expect(chat.channels[0].unread).toBe(0)
  })

  it('defers active-conversation read mark when window is blurred and leaves unread state to server counters', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.sendUpdateReadCursor = vi.fn()
    chat.setClientActive(false)

    chat.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfRole: 'member',
    }
    chat.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      lastMessageSeq: 1n,
      notificationLevel: NotificationLevel.ALL,
    }]
    chat.activeChannelId = 'channel-1'
    chat.bootstrapped = true

    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 1n,
      eventId: 'evt-blur-1',
      eventType: 4,
      conversationId: 'channel-1',
      payload: {
        case: 'messageCreated',
        value: create(MessageEventSchema, {
          conversationId: 'channel-1',
          messageId: 'message-blur-1',
          senderId: 'user-2',
          body: 'blur hello',
          channelSeq: 2n,
        }),
      },
    }))

    expect(ws.sendUpdateReadCursor).not.toHaveBeenCalled()
    expect(chat.channels[0].unread).toBe(0)

    chat.setClientActive(true)
    chat.onClientFocus()

    expect(ws.sendUpdateReadCursor).toHaveBeenCalledWith('channel-1', 2n)
    expect(chat.channels[0].unread).toBe(0)
  })

  it('emits inactive incoming-message notifications from backend-routed message_alert events', () => {
    const chat = useChatStore()
    chat.setClientActive(false)
    chat.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfRole: 'member',
    }
    chat.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      lastMessageSeq: 1n,
      notificationLevel: NotificationLevel.ALL,
    }]
    chat.bootstrapped = true

    const onIncoming = vi.fn()
    const off = chat.onIncomingMessageNotification(onIncoming)

    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 1n,
      eventId: 'evt-msg-sound-1',
      eventType: EventType.MESSAGE_ALERT,
      conversationId: 'channel-1',
      payload: {
        case: 'messageAlert',
        value: create(MessageAlertEventSchema, {
          conversationId: 'channel-1',
          messageId: 'message-sound-1',
          senderId: 'user-2',
          senderName: 'user-2',
          body: 'hello',
          threadRootMessageId: '',
          attachmentCount: 0,
        }),
      },
    }))

    expect(onIncoming).toHaveBeenCalledWith({
      reason: 'message_alert',
      conversationId: 'channel-1',
      messageId: 'message-sound-1',
      threadRootMessageId: undefined,
      senderId: 'user-2',
      senderName: 'user-2',
      body: 'hello',
      attachmentCount: 0,
    })
    off()
  })

  it('suppresses backend-routed message_alert events for the active visible conversation', () => {
    const chat = useChatStore()
    chat.setClientActive(true)
    chat.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfRole: 'member',
    }
    chat.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      lastMessageSeq: 1n,
      notificationLevel: NotificationLevel.ALL,
    }]
    chat.activeChannelId = 'channel-1'
    chat.chatViewMode = 'conversation'
    chat.bootstrapped = true

    const onIncoming = vi.fn()
    const off = chat.onIncomingMessageNotification(onIncoming)

    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 1n,
      eventId: 'evt-msg-visible-1',
      eventType: EventType.MESSAGE_ALERT,
      conversationId: 'channel-1',
      payload: {
        case: 'messageAlert',
        value: create(MessageAlertEventSchema, {
          conversationId: 'channel-1',
          messageId: 'message-visible-1',
          senderId: 'user-2',
          senderName: 'Bob',
          body: 'visible hello',
          threadRootMessageId: '',
          attachmentCount: 0,
        }),
      },
    }))

    expect(onIncoming).not.toHaveBeenCalled()
    off()
  })

  it('emits backend-routed message_alert events for hidden targets while the client is active', () => {
    const chat = useChatStore()
    chat.setClientActive(true)
    chat.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfRole: 'member',
    }
    chat.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      lastMessageSeq: 1n,
      notificationLevel: NotificationLevel.ALL,
    }, {
      id: 'channel-2',
      name: 'random',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      lastMessageSeq: 1n,
      notificationLevel: NotificationLevel.ALL,
    }]
    chat.activeChannelId = 'channel-2'
    chat.chatViewMode = 'conversation'
    chat.bootstrapped = true

    const onIncoming = vi.fn()
    const off = chat.onIncomingMessageNotification(onIncoming)

    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 1n,
      eventId: 'evt-msg-hidden-active-1',
      eventType: EventType.MESSAGE_ALERT,
      conversationId: 'channel-1',
      payload: {
        case: 'messageAlert',
        value: create(MessageAlertEventSchema, {
          conversationId: 'channel-1',
          messageId: 'message-hidden-active-1',
          senderId: 'user-2',
          senderName: 'Bob',
          body: 'hidden hello',
          threadRootMessageId: '',
          attachmentCount: 0,
        }),
      },
    }))

    expect(onIncoming).toHaveBeenCalledWith({
      reason: 'message_alert',
      conversationId: 'channel-1',
      messageId: 'message-hidden-active-1',
      threadRootMessageId: undefined,
      senderId: 'user-2',
      senderName: 'Bob',
      body: 'hidden hello',
      attachmentCount: 0,
    })
    off()
  })

  it('decodes escaped text for backend-routed message_alert notifications', () => {
    const chat = useChatStore()
    chat.setClientActive(false)
    chat.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfRole: 'member',
    }
    chat.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      lastMessageSeq: 1n,
      notificationLevel: NotificationLevel.ALL,
    }]
    chat.bootstrapped = true

    const onIncoming = vi.fn()
    const off = chat.onIncomingMessageNotification(onIncoming)

    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 1n,
      eventId: 'evt-msg-alert-decode-1',
      eventType: EventType.MESSAGE_ALERT,
      conversationId: 'channel-1',
      payload: {
        case: 'messageAlert',
        value: create(MessageAlertEventSchema, {
          conversationId: 'channel-1',
          messageId: 'message-alert-decode-1',
          senderId: 'user-2',
          senderName: 'Bob\\/"Builder\\"',
          body: 'Status\\nDone \\/ \\u2705',
          threadRootMessageId: '',
          attachmentCount: 0,
        }),
      },
    }))

    expect(onIncoming).toHaveBeenCalledWith({
      reason: 'message_alert',
      conversationId: 'channel-1',
      messageId: 'message-alert-decode-1',
      threadRootMessageId: undefined,
      senderId: 'user-2',
      senderName: 'Bob/"Builder"',
      body: 'Status\nDone / ✅',
      attachmentCount: 0,
    })

    off()
  })

  it('emits backend-routed message_alert events for inactive direct messages', () => {
    const chat = useChatStore()
    chat.setClientActive(false)
    chat.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfRole: 'member',
    }
    chat.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      lastMessageSeq: 1n,
      notificationLevel: NotificationLevel.MENTIONS_ONLY,
    }]
    chat.directMessages = [{
      id: 'dm-1',
      userId: 'user-2',
      displayName: 'Bob',
      unread: 0,
      presence: 'online',
      lastMessageSeq: 1n,
      notificationLevel: NotificationLevel.MENTIONS_ONLY,
    }]
    chat.bootstrapped = true

    const onIncoming = vi.fn()
    const off = chat.onIncomingMessageNotification(onIncoming)

    // Generic message alerts are backend-routed and already recipient-filtered.
    // The store should emit when it receives a direct message_alert event.
    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 0n,
      eventId: 'evt-msg-sound-mentions-only-1',
      eventType: EventType.MESSAGE_ALERT,
      conversationId: 'dm-1',
      payload: {
        case: 'messageAlert',
        value: create(MessageAlertEventSchema, {
          conversationId: 'dm-1',
          messageId: 'message-sound-mentions-only-2',
          senderId: 'user-2',
          senderName: 'Bob',
          body: 'dm ping',
          threadRootMessageId: '',
          attachmentCount: 0,
        }),
      },
    }))

    expect(onIncoming).toHaveBeenCalledTimes(1)
    expect(onIncoming).toHaveBeenCalledWith({
      reason: 'message_alert',
      conversationId: 'dm-1',
      messageId: 'message-sound-mentions-only-2',
      threadRootMessageId: undefined,
      senderId: 'user-2',
      senderName: 'Bob',
      body: 'dm ping',
      attachmentCount: 0,
    })
    off()
  })

  it('emits mention notifications for hidden targets while the client is active', () => {
    const chat = useChatStore()
    chat.setClientActive(true)
    chat.activeChannelId = 'channel-2'
    chat.chatViewMode = 'conversation'
    chat.bootstrapped = true

    const onIncoming = vi.fn()
    const off = chat.onIncomingMessageNotification(onIncoming)

    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 1n,
      eventId: 'evt-mention-active-1',
      eventType: EventType.NOTIFICATION_ADDED,
      conversationId: 'channel-1',
      payload: {
        case: 'notificationAdded',
        value: create(NotificationAddedEventSchema, {
          userId: 'user-1',
          notification: create(NotificationSummarySchema, {
            notificationId: 'mention-active-1',
            type: 1,
            title: 'Mention',
            body: 'You were mentioned',
            conversationId: 'channel-1',
            messageId: 'message-hidden-mention-1',
            isRead: false,
          }),
        }),
      },
    }))

    expect(onIncoming).toHaveBeenCalledWith({
      reason: 'mention',
      conversationId: 'channel-1',
      messageId: 'message-hidden-mention-1',
      threadRootMessageId: undefined,
      senderId: '',
      senderName: 'Mention',
      body: 'You were mentioned',
      attachmentCount: 0,
    })

    off()
  })

  it('marks visible mention notifications read without emitting incoming hooks', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.sendUpdateReadCursor = vi.fn()
    chat.setClientActive(true)
    chat.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 1,
      lastMessageSeq: 2n,
      notificationLevel: NotificationLevel.ALL,
    }]
    chat.messages = {
      'channel-1': [buildMessage({ id: 'message-visible-mention-1', channelId: 'channel-1', channelSeq: 2n })],
    }
    chat.activeChannelId = 'channel-1'
    chat.chatViewMode = 'conversation'
    chat.bootstrapped = true

    const onIncoming = vi.fn()
    const off = chat.onIncomingMessageNotification(onIncoming)

    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 1n,
      eventId: 'evt-mention-visible-1',
      eventType: EventType.NOTIFICATION_ADDED,
      conversationId: 'channel-1',
      payload: {
        case: 'notificationAdded',
        value: create(NotificationAddedEventSchema, {
          userId: 'user-1',
          notification: create(NotificationSummarySchema, {
            notificationId: 'mention-visible-1',
            type: NotificationType.MENTION,
            title: 'Mention',
            body: 'You were mentioned',
            conversationId: 'channel-1',
            messageId: 'message-visible-mention-1',
            isRead: false,
          }),
        }),
      },
    }))

    expect(onIncoming).not.toHaveBeenCalled()
    expect(chat.notifications).toEqual([])
    expect(chat.channels[0].unread).toBe(0)
    expect(ws.sendUpdateReadCursor).toHaveBeenCalledWith('channel-1', 2n)
    expect(chatApiMocks.resolveUnreadFeedNotification).toHaveBeenCalledWith('mention-visible-1')
    off()
  })

  it('resolves notification_added before message_created only for the visible root target', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.sendUpdateReadCursor = vi.fn()
    chat.setClientActive(true)
    chat.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 1,
      lastMessageSeq: 1n,
      notificationLevel: NotificationLevel.ALL,
    }]
    chat.activeChannelId = 'channel-1'
    chat.chatViewMode = 'conversation'
    chat.bootstrapped = true

    const onIncoming = vi.fn()
    const off = chat.onIncomingMessageNotification(onIncoming)

    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 1n,
      eventId: 'evt-mention-before-message-1',
      eventType: EventType.NOTIFICATION_ADDED,
      conversationId: 'channel-1',
      payload: {
        case: 'notificationAdded',
        value: create(NotificationAddedEventSchema, {
          userId: 'user-1',
          notification: create(NotificationSummarySchema, {
            notificationId: 'mention-before-message-1',
            type: NotificationType.MENTION,
            title: 'Mention',
            body: 'You were mentioned',
            conversationId: 'channel-1',
            messageId: 'message-before-notification-1',
            isRead: false,
          }),
        }),
      },
    }))

    expect(onIncoming).not.toHaveBeenCalled()
    expect(ws.sendUpdateReadCursor).not.toHaveBeenCalled()
    expect(chat.notifications).toEqual([])
    expect(chatApiMocks.resolveUnreadFeedNotification).toHaveBeenCalledWith('mention-before-message-1')

    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 2n,
      eventId: 'evt-message-after-notification-1',
      eventType: EventType.MESSAGE_CREATED,
      conversationId: 'channel-1',
      payload: {
        case: 'messageCreated',
        value: create(MessageEventSchema, {
          conversationId: 'channel-1',
          messageId: 'message-before-notification-1',
          senderId: 'user-2',
          body: 'now visible',
          channelSeq: 2n,
        }),
      },
    }))

    expect(onIncoming).not.toHaveBeenCalled()
    expect(ws.sendUpdateReadCursor).toHaveBeenCalledWith('channel-1', 2n)
    off()
  })

  it('emits thread reply notifications for inactive pinned threads while the client is active', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.state = 'LIVE_SYNCED'
    ws.sendSubscribeThread = vi.fn()
    chat.setClientActive(true)
    chat.messages = {
      'channel-1': [
        buildMessage({ id: 'root-1', channelId: 'channel-1', channelSeq: 10n }),
        buildMessage({ id: 'root-2', channelId: 'channel-1', channelSeq: 20n }),
      ],
    }
    chat.activateThreadWorkspace('channel-1', 'root-1')
    vi.mocked(ws.sendSubscribeThread).mockClear()
    chat.bootstrapped = true

    const onIncoming = vi.fn()
    const off = chat.onIncomingMessageNotification(onIncoming)

    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 1n,
      eventId: 'evt-thread-reply-active-1',
      eventType: EventType.NOTIFICATION_ADDED,
      conversationId: 'channel-1',
      payload: {
        case: 'notificationAdded',
        value: create(NotificationAddedEventSchema, {
          userId: 'user-1',
          notification: create(NotificationSummarySchema, {
            notificationId: 'thread-reply-active-1',
            type: NotificationType.THREAD_REPLY,
            title: 'Thread reply',
            body: 'Someone replied in a thread',
            conversationId: 'channel-1',
            messageId: 'reply-inactive-thread-1',
            threadRootMessageId: 'root-2',
            isRead: false,
          }),
        }),
      },
    }))

    expect(onIncoming).toHaveBeenCalledWith({
      reason: 'notification',
      conversationId: 'channel-1',
      messageId: 'reply-inactive-thread-1',
      threadRootMessageId: 'root-2',
      senderId: '',
      senderName: 'Thread reply',
      body: 'Someone replied in a thread',
      attachmentCount: 0,
    })
    expect(chat.notifications.map(item => item.id)).toEqual(['thread-reply-active-1'])
    expect(ws.sendSubscribeThread).not.toHaveBeenCalledWith('channel-1', 'root-2', expect.anything())

    off()
  })

  it('marks visible thread notifications read without emitting incoming hooks', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.state = 'LIVE_SYNCED'
    ws.sendSubscribeThread = vi.fn()
    chat.setClientActive(true)
    chat.messages = {
      'channel-1': [buildMessage({ id: 'root-1', channelId: 'channel-1', channelSeq: 10n })],
    }
    chat.activateThreadWorkspace('channel-1', 'root-1')
    vi.mocked(ws.sendSubscribeThread).mockClear()
    chat.bootstrapped = true

    const onIncoming = vi.fn()
    const off = chat.onIncomingMessageNotification(onIncoming)

    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 1n,
      eventId: 'evt-thread-reply-visible-1',
      eventType: EventType.NOTIFICATION_ADDED,
      conversationId: 'channel-1',
      payload: {
        case: 'notificationAdded',
        value: create(NotificationAddedEventSchema, {
          userId: 'user-1',
          notification: create(NotificationSummarySchema, {
            notificationId: 'thread-reply-visible-1',
            type: NotificationType.THREAD_REPLY,
            title: 'Thread reply',
            body: 'Someone replied in a thread',
            conversationId: 'channel-1',
            messageId: 'reply-visible-thread-1',
            threadRootMessageId: 'root-1',
            isRead: false,
          }),
        }),
      },
    }))

    expect(onIncoming).not.toHaveBeenCalled()
    expect(chat.notifications).toEqual([])
    expect(chatApiMocks.resolveUnreadFeedNotification).toHaveBeenCalledWith('thread-reply-visible-1')
    expect(ws.sendSubscribeThread).toHaveBeenCalledWith('channel-1', 'root-1', 0n)

    off()
  })

  it('routes direct task status changed events to subscribers', () => {
    const chat = useChatStore()
    const onTaskStatusChanged = vi.fn()
    const off = chat.onTaskStatusChanged(onTaskStatusChanged)

    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 0n,
      eventType: EventType.TASK_STATUS_CHANGED,
      payload: {
        case: 'taskStatusChanged',
        value: create(TaskStatusChangedEventSchema, {
          taskId: 'task-1',
          publicId: 'BUG-1',
          fromStatusId: 'st-1',
          toStatusId: 'st-2',
          updatedBy: 'user-2',
          updatedAt: { seconds: 1700000000n, nanos: 0 },
        }),
      },
    }))

    expect(onTaskStatusChanged).toHaveBeenCalledWith({
      taskId: 'task-1',
      publicId: 'BUG-1',
      fromStatusId: 'st-1',
      toStatusId: 'st-2',
      updatedBy: 'user-2',
      updatedAt: new Date(1700000000 * 1000).toISOString(),
    })
    off()
  })

  it('stops task status changed notifications after unsubscribe', () => {
    const chat = useChatStore()
    const onTaskStatusChanged = vi.fn()
    const off = chat.onTaskStatusChanged(onTaskStatusChanged)
    off()

    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 0n,
      eventType: EventType.TASK_STATUS_CHANGED,
      payload: {
        case: 'taskStatusChanged',
        value: create(TaskStatusChangedEventSchema, {
          taskId: 'task-1',
          publicId: 'BUG-1',
          fromStatusId: 'st-1',
          toStatusId: 'st-2',
          updatedBy: 'user-2',
          updatedAt: { seconds: 1700000000n, nanos: 0 },
        }),
      },
    }))

    expect(onTaskStatusChanged).not.toHaveBeenCalled()
  })

  it('decodes escaped text in unread feed items', async () => {
    const chat = useChatStore()
    chat.bootstrapped = true
    chatApiMocks.listUnreadFeed.mockResolvedValue({
      total_count: 3,
      items: [
        {
          id: 'mention:notif-1',
          kind: 'mention',
          notification_id: 'notif-1',
          conversation_id: 'channel-1',
          conversation_kind: 'channel',
          conversation_visibility: 'public',
          conversation_title: 'team\\/ops',
          message_id: 'message-1',
          thread_root_message_id: '',
          sender_id: 'user-2',
          sender_name: 'Bob\\u0020Builder',
          body: 'Mention\\nbody \\/ done',
          created_at: '2026-03-06T00:00:00Z',
        },
        {
          id: 'thread:notif-2',
          kind: 'thread',
          notification_id: 'notif-2',
          conversation_id: 'channel-2',
          conversation_kind: 'channel',
          conversation_visibility: 'private',
          conversation_title: 'private\\u0020team',
          message_id: 'message-2',
          thread_root_message_id: 'root-2',
          sender_id: 'user-3',
          sender_name: 'Thread\\tSender',
          body: String.raw`Thread\\nreply \"quoted\"`,
          created_at: '2026-03-06T00:01:00Z',
        },
        {
          id: 'message:message-3',
          kind: 'message',
          conversation_id: 'dm-1',
          conversation_kind: 'dm',
          conversation_visibility: 'dm',
          conversation_title: 'Direct\\u0020Peer',
          message_id: 'message-3',
          sender_id: 'user-4',
          sender_name: String.raw`Path\\User`,
          body: String.raw`Root\\/message keeps \q`,
          created_at: '2026-03-06T00:02:00Z',
        },
      ],
    })

    await chat.refreshUnreadFeed()

    expect(chat.unreadFeedItems).toEqual([
      {
        id: 'mention:notif-1',
        kind: 'mention',
        notificationId: 'notif-1',
        conversationId: 'channel-1',
        conversationKind: 'channel',
        conversationVisibility: 'public',
        conversationTitle: 'team/ops',
        messageId: 'message-1',
        threadRootMessageId: undefined,
        senderId: 'user-2',
        senderName: 'Bob Builder',
        body: 'Mention\nbody / done',
        createdAt: '2026-03-06T00:00:00Z',
      },
      {
        id: 'thread:notif-2',
        kind: 'thread',
        notificationId: 'notif-2',
        conversationId: 'channel-2',
        conversationKind: 'channel',
        conversationVisibility: 'private',
        conversationTitle: 'private team',
        messageId: 'message-2',
        threadRootMessageId: 'root-2',
        senderId: 'user-3',
        senderName: 'Thread\tSender',
        body: 'Thread\nreply "quoted"',
        createdAt: '2026-03-06T00:01:00Z',
      },
      {
        id: 'message:message-3',
        kind: 'message',
        notificationId: undefined,
        conversationId: 'dm-1',
        conversationKind: 'dm',
        conversationVisibility: 'dm',
        conversationTitle: 'Direct Peer',
        messageId: 'message-3',
        threadRootMessageId: undefined,
        senderId: 'user-4',
        senderName: String.raw`Path\User`,
        body: String.raw`Root/message keeps \q`,
        createdAt: '2026-03-06T00:02:00Z',
      },
    ])
  })

  it('marks active direct message as read for self-authored messages', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.sendUpdateReadCursor = vi.fn()
    chat.setClientActive(true)

    chat.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfRole: 'member',
    }
    chat.directMessages = [{
      id: 'dm-1',
      userId: 'user-2',
      displayName: 'Bob',
      unread: 0,
      presence: 'online',
      lastMessageSeq: 1n,
      notificationLevel: NotificationLevel.ALL,
    }]
    chat.activeChannelId = 'dm-1'
    chat.bootstrapped = true

    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 1n,
      eventId: 'evt-self-dm-1',
      eventType: EventType.MESSAGE_CREATED,
      conversationId: 'dm-1',
      payload: {
        case: 'messageCreated',
        value: create(MessageEventSchema, {
          conversationId: 'dm-1',
          messageId: 'message-self-dm-1',
          senderId: 'user-1',
          body: 'my own message',
          channelSeq: 2n,
        }),
      },
    }))

    expect(ws.sendUpdateReadCursor).toHaveBeenCalledWith('dm-1', 2n)
    expect(chat.directMessages[0].unread).toBe(0)
  })

  it('applies direct unsequenced read-counter updates immediately', () => {
    const chat = useChatStore()

    chat.bootstrapped = true
    chat.lastAppliedEventSeq = 5n
    chat.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 4,
      hasUnreadThreadReplies: true,
      lastMessageSeq: 5n,
      notificationLevel: NotificationLevel.ALL,
    }]

    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 0n,
      eventType: EventType.READ_COUNTER_UPDATED,
      conversationId: 'channel-1',
      payload: {
        case: 'readCounterUpdated',
        value: create(ReadCounterUpdatedEventSchema, {
          userId: 'user-1',
          counter: create(UnreadCounterSchema, {
            conversationId: 'channel-1',
            unreadMessages: 0,
            unreadMentions: 0,
            hasUnreadThreadReplies: false,
            lastReadSeq: 5n,
          }),
        }),
      },
    }))

    expect(chat.channels[0].unread).toBe(0)
    expect(chat.channels[0].hasUnreadThreadReplies).toBe(false)
    expect(chat.lastAppliedEventSeq).toBe(5n)
  })

  it('uses replyCount as thread reply total and currentThreadSeq as cursor on subscribe replay', () => {
    const chat = useChatStore()
    chat.threadSummaries = {
      'root-1': {
        replyCount: 8,
        lastThreadSeq: 8n,
      },
    }

    chat.handleSubscribeThreadResponse(create(SubscribeThreadResponseSchema, {
      conversationId: 'channel-1',
      threadRootMessageId: 'root-1',
      currentThreadSeq: 10n,
      replyCount: 10,
      replay: [
        create(MessageEventSchema, {
          conversationId: 'channel-1',
          messageId: 'reply-9',
          senderId: 'user-2',
          body: 'reply 9',
          channelSeq: 20n,
          threadRootMessageId: 'root-1',
          threadSeq: 9n,
        }),
        create(MessageEventSchema, {
          conversationId: 'channel-1',
          messageId: 'reply-10',
          senderId: 'user-2',
          body: 'reply 10',
          channelSeq: 21n,
          threadRootMessageId: 'root-1',
          threadSeq: 10n,
        }),
      ],
    }))

    expect(chat.threadSummaries['root-1'].replyCount).toBe(10)
    expect(chat.threadSummaries['root-1'].lastThreadSeq).toBe(10n)
    expect(chat.threadMessages['root-1'].every(message => message.serverConfirmed === true)).toBe(true)
  })

  it('retries a dropped active-thread subscription when realtime sync becomes live', async () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.sendSubscribeThread = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValue(true)
    ws.setLiveSynced = vi.fn(() => {
      ws.state = 'LIVE_SYNCED'
    })
    chatApiMocks.listConversationMessages.mockResolvedValue({ messages: [], has_more: false, page_size: 0 })
    chat.messages = {
      'channel-1': [buildMessage({ id: 'root-1', channelId: 'channel-1', threadSeq: 0n })],
    }
    chat.threadSummaries = {
      'root-1': { replyCount: 7, lastThreadSeq: 7n },
    }

    chat.openThread(chat.messages['channel-1'][0])

    expect(ws.sendSubscribeThread).toHaveBeenCalledTimes(1)
    expect(chat.threadReplayStatus('root-1')).toBe('loading')

    chat.handleSyncSinceResponse(create(SyncSinceResponseSchema, {
      syncCursor: 0n,
      needFullBootstrap: false,
      events: [],
    }))

    await vi.waitFor(() => {
      expect(ws.sendSubscribeThread).toHaveBeenCalledTimes(2)
    })
    expect(ws.sendSubscribeThread).toHaveBeenLastCalledWith('channel-1', 'root-1', 0n)
  })

  it('retries one incomplete thread replay from zero and then exposes an error', () => {
    vi.useFakeTimers()
    try {
      const chat = useChatStore()
      const ws = useWsStore()
      ws.state = 'LIVE_SYNCED'
      ws.sendSubscribeThread = vi.fn().mockReturnValue(true)
      chat.messages = {
        'channel-1': [buildMessage({ id: 'root-1', channelId: 'channel-1', threadSeq: 0n })],
      }
      chat.threadSummaries = {
        'root-1': { replyCount: 7, lastThreadSeq: 7n },
      }
      chat.openThread(chat.messages['channel-1'][0])
      vi.mocked(ws.sendSubscribeThread).mockClear()

      const incompleteResponse = create(SubscribeThreadResponseSchema, {
        conversationId: 'channel-1',
        threadRootMessageId: 'root-1',
        currentThreadSeq: 7n,
        replyCount: 7,
        replay: [],
      })
      chat.handleSubscribeThreadResponse(incompleteResponse)

      expect(chat.threadReplayStatus('root-1')).toBe('loading')
      vi.advanceTimersByTime(200)
      expect(ws.sendSubscribeThread).toHaveBeenCalledTimes(1)
      expect(ws.sendSubscribeThread).toHaveBeenCalledWith('channel-1', 'root-1', 0n)

      vi.mocked(ws.sendSubscribeThread).mockClear()
      chat.handleSubscribeThreadResponse(incompleteResponse)
      vi.advanceTimersByTime(200)

      expect(ws.sendSubscribeThread).not.toHaveBeenCalled()
      expect(chat.threadReplayStatus('root-1')).toBe('error')
    } finally {
      vi.useRealTimers()
    }
  })

  it('invalidates a live transport when a focused pinned-thread replay receives no response', () => {
    vi.useFakeTimers()
    try {
      const chat = useChatStore()
      const ws = useWsStore()
      ws.state = 'LIVE_SYNCED'
      ws.sendSubscribeThread = vi.fn().mockReturnValue(true)
      ws.invalidateTransport = vi.fn().mockReturnValue(true)
      chat.setClientActive(false)
      chat.messages = {
        'channel-1': [buildMessage({ id: 'root-1', channelId: 'channel-1', threadSeq: 0n })],
      }
      chat.threadSummaries = {
        'root-1': { replyCount: 7, lastThreadSeq: 7n },
      }

      chat.activateThreadWorkspace('channel-1', 'root-1')
      vi.mocked(ws.sendSubscribeThread).mockClear()

      chat.setClientActive(true)
      chat.onClientFocus()

      expect(ws.sendSubscribeThread).toHaveBeenCalledWith('channel-1', 'root-1', 0n)
      expect(chat.threadReplayStatus('root-1')).toBe('loading')

      vi.advanceTimersByTime(15_000)

      expect(ws.invalidateTransport).toHaveBeenCalledTimes(1)
      expect(ws.invalidateTransport).toHaveBeenCalledWith('Thread replay did not receive a response')
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels the pinned-thread replay watchdog when a response arrives', () => {
    vi.useFakeTimers()
    try {
      const chat = useChatStore()
      const ws = useWsStore()
      ws.state = 'LIVE_SYNCED'
      ws.sendSubscribeThread = vi.fn().mockReturnValue(true)
      ws.invalidateTransport = vi.fn().mockReturnValue(true)
      chat.messages = {
        'channel-1': [buildMessage({ id: 'root-1', channelId: 'channel-1', threadSeq: 0n })],
      }
      chat.threadSummaries = {
        'root-1': { replyCount: 1, lastThreadSeq: 1n },
      }

      chat.activateThreadWorkspace('channel-1', 'root-1')
      chat.handleSubscribeThreadResponse(create(SubscribeThreadResponseSchema, {
        conversationId: 'channel-1',
        threadRootMessageId: 'root-1',
        currentThreadSeq: 1n,
        replyCount: 1,
        replay: [create(MessageEventSchema, {
          conversationId: 'channel-1',
          messageId: 'reply-1',
          senderId: 'user-2',
          body: 'reply',
          channelSeq: 11n,
          threadRootMessageId: 'root-1',
          threadSeq: 1n,
        })],
      }))

      vi.advanceTimersByTime(15_000)

      expect(ws.invalidateTransport).not.toHaveBeenCalled()
      expect(chat.threadReplayStatus('root-1')).toBe('idle')
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels the pinned-thread replay watchdog when the thread closes', () => {
    vi.useFakeTimers()
    try {
      const chat = useChatStore()
      const ws = useWsStore()
      ws.state = 'LIVE_SYNCED'
      ws.sendSubscribeThread = vi.fn().mockReturnValue(true)
      ws.invalidateTransport = vi.fn().mockReturnValue(true)
      chat.messages = {
        'channel-1': [buildMessage({ id: 'root-1', channelId: 'channel-1', threadSeq: 0n })],
      }
      chat.threadSummaries = {
        'root-1': { replyCount: 7, lastThreadSeq: 7n },
      }

      chat.activateThreadWorkspace('channel-1', 'root-1')
      chat.closeThread()
      vi.advanceTimersByTime(15_000)

      expect(ws.invalidateTransport).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps replay responses isolated while switching between pinned threads', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.sendSubscribeThread = vi.fn().mockReturnValue(true)
    chat.messages = {
      'channel-1': [
        buildMessage({ id: 'root-1', channelId: 'channel-1', threadSeq: 0n }),
        buildMessage({ id: 'root-2', channelId: 'channel-1', threadSeq: 0n }),
      ],
    }

    chat.activateThreadWorkspace('channel-1', 'root-1')
    chat.activateThreadWorkspace('channel-1', 'root-2')
    chat.handleSubscribeThreadResponse(create(SubscribeThreadResponseSchema, {
      conversationId: 'channel-1',
      threadRootMessageId: 'root-2',
      currentThreadSeq: 1n,
      replyCount: 1,
      replay: [create(MessageEventSchema, {
        conversationId: 'channel-1',
        messageId: 'reply-2',
        senderId: 'user-2',
        body: 'reply 2',
        threadRootMessageId: 'root-2',
        threadSeq: 1n,
      })],
    }))
    chat.handleSubscribeThreadResponse(create(SubscribeThreadResponseSchema, {
      conversationId: 'channel-1',
      threadRootMessageId: 'root-1',
      currentThreadSeq: 1n,
      replyCount: 1,
      replay: [create(MessageEventSchema, {
        conversationId: 'channel-1',
        messageId: 'reply-1',
        senderId: 'user-2',
        body: 'reply 1',
        threadRootMessageId: 'root-1',
        threadSeq: 1n,
      })],
    }))

    expect(chat.activeThreadRootId).toBe('root-2')
    expect(chat.threadMessages['root-1'].map(message => message.id)).toEqual(['reply-1'])
    expect(chat.threadMessages['root-2'].map(message => message.id)).toEqual(['reply-2'])
  })

  it('includes the current self avatar on optimistic thread replies immediately', async () => {
    const chat = useChatStore()
    const ws = useWsStore()
    const auth = useAuthStore()
    ws.state = 'LIVE_SYNCED'
    ws.sendSubscribeThread = vi.fn()
    ws.sendMessage = vi.fn(() => false)
    auth.user = {
      id: 'user-1',
      email: 'ada@example.com',
      displayName: 'Ada',
      avatarUrl: '/api/public/avatars/avatars/user-1/self.png',
      role: 'member',
      customStatus: null,
    }
    chat.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada Workspace',
      selfAvatarUrl: '/api/public/avatars/avatars/user-1/stale-workspace.png',
      selfRole: 'member',
    }
    chat.openThread(buildMessage({
      id: 'root-1',
      channelId: 'channel-1',
      senderId: 'user-2',
      threadSeq: 0n,
    }))

    chat.sendThreadReply('reply body')
    await Promise.resolve()
    await Promise.resolve()

    expect(chat.threadMessages['root-1'][0].senderAvatarUrl).toBe('/api/public/avatars/avatars/user-1/self.png')
    expect(chat.threadMessages['root-1'][0].sendStatus).toBe('queued')
  })

  it('hydrates thread replay reactions and myReactions', () => {
    const chat = useChatStore()

    chat.handleSubscribeThreadResponse(create(SubscribeThreadResponseSchema, {
      conversationId: 'channel-1',
      threadRootMessageId: 'root-1',
      currentThreadSeq: 1n,
      replyCount: 1,
      replay: [
        create(MessageEventSchema, {
          conversationId: 'channel-1',
          messageId: 'reply-1',
          senderId: 'user-2',
          body: 'reply 1',
          channelSeq: 20n,
          threadRootMessageId: 'root-1',
          threadSeq: 1n,
          reactions: [
            create(ReactionAggregateSchema, { emoji: ':+1:', count: 2 }),
            create(ReactionAggregateSchema, { emoji: '🔥', count: 1 }),
          ],
          myReactions: [':+1:'],
        }),
      ],
    }))

    expect(chat.threadMessages['root-1'][0].reactions).toEqual([
      { emoji: ':+1:', count: 2 },
      { emoji: '🔥', count: 1 },
    ])
    expect(chat.threadMessages['root-1'][0].myReactions).toEqual([':+1:'])
  })

  it('subscribes from zero when only summary exists but thread replay cache is empty', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.sendSubscribeThread = vi.fn()

    chat.threadSummaries = {
      'root-1': {
        replyCount: 3,
        lastThreadSeq: 3n,
      },
    }

    chat.openThread({
      id: 'root-1',
      channelId: 'channel-1',
      senderId: 'user-2',
      senderName: 'Bob',
      body: 'root',
      channelSeq: 10n,
      threadSeq: 0n,
      mentionedUserIds: [],
      mentionEveryone: false,
      createdAt: '2026-03-06T00:00:00Z',
      reactions: [],
      myReactions: [],
    })

    expect(ws.sendSubscribeThread).toHaveBeenCalledWith('channel-1', 'root-1', 0n)
    expect(chat.threadComposerFocusToken).toBe(1)
  })

  it('subscribes from zero when confirmed thread cache is smaller than the summary reply count', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.sendSubscribeThread = vi.fn()

    chat.threadMessages = {
      'root-1': [
        buildMessage({
          id: 'reply-8',
          channelId: 'channel-1',
          threadSeq: 8n,
          threadRootMessageId: 'root-1',
          serverConfirmed: true,
        }),
      ],
    }
    chat.threadSummaries = {
      'root-1': {
        replyCount: 8,
        lastThreadSeq: 8n,
      },
    }

    chat.openThread(buildMessage({
      id: 'root-1',
      channelId: 'channel-1',
      threadSeq: 0n,
    }))

    expect(ws.sendSubscribeThread).toHaveBeenCalledWith('channel-1', 'root-1', 0n)
  })

  it('clears stale focused thread message when opening a different thread', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.sendSubscribeThread = vi.fn()

    chat.activeThreadConversationId = 'channel-1'
    chat.activeThreadRootId = 'root-1'
    chat.focusedThreadMessageId = 'reply-1'

    chat.openThread(buildMessage({
      id: 'root-2',
      channelId: 'channel-1',
      threadSeq: 0n,
    }))

    expect(chat.focusedThreadMessageId).toBe('')
    expect(chat.activeThreadRootId).toBe('root-2')
    expect(ws.sendSubscribeThread).toHaveBeenCalledWith('channel-1', 'root-2', 0n)
  })

  it('clears unread feed entries for the whole thread when opening a thread', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.sendUpdateReadCursor = vi.fn()
    ws.sendSubscribeThread = vi.fn()

    chat.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 4,
      notificationLevel: NotificationLevel.ALL,
    }]
    chat.messages = {
      'channel-1': [
        buildMessage({
          id: 'root-1',
          channelId: 'channel-1',
          senderId: 'user-2',
          channelSeq: 10n,
          threadSeq: 0n,
        }),
      ],
    }
    chat.unreadFeedItems = [
      {
        id: 'thread:reply-1',
        kind: 'thread',
        conversationId: 'channel-1',
        conversationKind: 'channel',
        conversationVisibility: 'public',
        conversationTitle: 'general',
        messageId: 'reply-1',
        threadRootMessageId: 'root-1',
        senderName: 'Bob',
        body: 'reply 1',
        createdAt: '2026-03-06T00:01:00Z',
      },
      {
        id: 'thread:reply-2',
        kind: 'thread',
        conversationId: 'channel-1',
        conversationKind: 'channel',
        conversationVisibility: 'public',
        conversationTitle: 'general',
        messageId: 'reply-2',
        threadRootMessageId: 'root-1',
        senderName: 'Bob',
        body: 'reply 2',
        createdAt: '2026-03-06T00:02:00Z',
      },
      {
        id: 'message:root-1',
        kind: 'message',
        conversationId: 'channel-1',
        conversationKind: 'channel',
        conversationVisibility: 'public',
        conversationTitle: 'general',
        messageId: 'root-1',
        senderName: 'Bob',
        body: 'root',
        createdAt: '2026-03-06T00:00:00Z',
      },
      {
        id: 'thread:reply-3',
        kind: 'thread',
        conversationId: 'channel-1',
        conversationKind: 'channel',
        conversationVisibility: 'public',
        conversationTitle: 'general',
        messageId: 'reply-3',
        threadRootMessageId: 'root-2',
        senderName: 'Eve',
        body: 'other thread',
        createdAt: '2026-03-06T00:03:00Z',
      },
    ] as any
    chat.unreadFeedTotalCount = 4

    chat.openThread(chat.messages['channel-1'][0])

    expect(chat.unreadFeedItems.map(item => item.id)).toEqual(['thread:reply-3'])
    expect(chat.unreadFeedTotalCount).toBe(1)
    expect(chat.channels[0].unread).toBe(0)
    expect(ws.sendUpdateReadCursor).toHaveBeenCalledWith('channel-1', 10n)
    expect(ws.sendSubscribeThread).toHaveBeenCalledWith('channel-1', 'root-1', 0n)
  })

  it('marks live replies read when they arrive in the active visible thread', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.state = 'LIVE_SYNCED'
    ws.sendSubscribeThread = vi.fn()
    ws.sendUpdateReadCursor = vi.fn()
    chat.bootstrapped = true
    chat.setClientActive(true)
    chat.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 1,
      notificationLevel: NotificationLevel.ALL,
    }]
    chat.messages = {
      'channel-1': [buildMessage({ id: 'root-1', channelId: 'channel-1', channelSeq: 10n })],
    }
    chat.activateThreadWorkspace('channel-1', 'root-1')
    vi.mocked(ws.sendSubscribeThread).mockClear()
    vi.mocked(ws.sendUpdateReadCursor).mockClear()
    chat.unreadFeedItems = [buildUnreadThreadItem({ notificationId: 'notif-1' })] as any
    chat.notifications = [{
      id: 'notif-1',
      type: 'thread_reply',
      title: 'Reply',
      body: 'reply 1',
      conversationId: 'channel-1',
      isRead: false,
      createdAt: '2026-03-06T00:01:00Z',
    }]
    chat.unreadFeedTotalCount = 1

    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 1n,
      eventId: 'evt-active-thread-reply-1',
      eventType: EventType.MESSAGE_CREATED,
      conversationId: 'channel-1',
      payload: {
        case: 'messageCreated',
        value: create(MessageEventSchema, {
          conversationId: 'channel-1',
          messageId: 'reply-1',
          senderId: 'user-2',
          body: 'reply 1',
          channelSeq: 11n,
          threadRootMessageId: 'root-1',
          threadSeq: 1n,
        }),
      },
    }))

    expect(chat.unreadFeedItems).toEqual([])
    expect(chat.unreadFeedTotalCount).toBe(0)
    expect(chat.notifications).toEqual([])
    expect(chatApiMocks.resolveUnreadFeedNotification).toHaveBeenCalledWith('notif-1')
    expect(ws.sendSubscribeThread).toHaveBeenCalledWith('channel-1', 'root-1', 1n)
  })

  it('keeps live replies unread when they arrive in an inactive pinned thread', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.state = 'LIVE_SYNCED'
    ws.sendSubscribeThread = vi.fn()
    chat.bootstrapped = true
    chat.setClientActive(true)
    chat.messages = {
      'channel-1': [
        buildMessage({ id: 'root-1', channelId: 'channel-1', channelSeq: 10n }),
        buildMessage({ id: 'root-2', channelId: 'channel-1', channelSeq: 20n }),
      ],
    }
    chat.activateThreadWorkspace('channel-1', 'root-1')
    vi.mocked(ws.sendSubscribeThread).mockClear()
    chat.unreadFeedItems = [buildUnreadThreadItem({
      id: 'thread:reply-2',
      messageId: 'reply-2',
      threadRootMessageId: 'root-2',
    })] as any
    chat.unreadFeedTotalCount = 1

    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 1n,
      eventId: 'evt-inactive-thread-reply-1',
      eventType: EventType.MESSAGE_CREATED,
      conversationId: 'channel-1',
      payload: {
        case: 'messageCreated',
        value: create(MessageEventSchema, {
          conversationId: 'channel-1',
          messageId: 'reply-2',
          senderId: 'user-2',
          body: 'reply 2',
          channelSeq: 21n,
          threadRootMessageId: 'root-2',
          threadSeq: 1n,
        }),
      },
    }))

    expect(chat.unreadFeedItems.map(item => item.id)).toEqual(['thread:reply-2'])
    expect(chat.unreadFeedTotalCount).toBe(1)
    expect(ws.sendSubscribeThread).not.toHaveBeenCalledWith('channel-1', 'root-2', expect.anything())
  })

  it('marks the active visible thread read when the browser regains focus', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.state = 'LIVE_SYNCED'
    ws.sendSubscribeThread = vi.fn()
    chat.bootstrapped = true
    chat.setClientActive(false)
    chat.messages = {
      'channel-1': [buildMessage({ id: 'root-1', channelId: 'channel-1', channelSeq: 10n })],
    }
    chat.activateThreadWorkspace('channel-1', 'root-1')
    vi.mocked(ws.sendSubscribeThread).mockClear()
    chat.unreadFeedItems = [buildUnreadThreadItem({ notificationId: 'notif-1' })] as any
    chat.unreadFeedTotalCount = 1

    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 1n,
      eventId: 'evt-inactive-client-thread-reply-1',
      eventType: EventType.MESSAGE_CREATED,
      conversationId: 'channel-1',
      payload: {
        case: 'messageCreated',
        value: create(MessageEventSchema, {
          conversationId: 'channel-1',
          messageId: 'reply-1',
          senderId: 'user-2',
          body: 'reply 1',
          channelSeq: 11n,
          threadRootMessageId: 'root-1',
          threadSeq: 1n,
        }),
      },
    }))

    expect(chat.unreadFeedItems.map(item => item.id)).toEqual(['thread:reply-1'])
    expect(ws.sendSubscribeThread).not.toHaveBeenCalled()

    chat.setClientActive(true)
    chat.onClientFocus()

    expect(chat.unreadFeedItems).toEqual([])
    expect(chat.unreadFeedTotalCount).toBe(0)
    expect(chatApiMocks.resolveUnreadFeedNotification).toHaveBeenCalledWith('notif-1')
    expect(ws.sendSubscribeThread).toHaveBeenCalledWith('channel-1', 'root-1', 1n)
  })

  it('scrubs active visible thread items after refreshing the unread feed', async () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.state = 'LIVE_SYNCED'
    ws.sendSubscribeThread = vi.fn()
    chat.bootstrapped = true
    chat.setClientActive(true)
    chat.messages = {
      'channel-1': [buildMessage({ id: 'root-1', channelId: 'channel-1', channelSeq: 10n })],
    }
    chat.activateThreadWorkspace('channel-1', 'root-1')
    vi.mocked(ws.sendSubscribeThread).mockClear()
    chatApiMocks.listUnreadFeed.mockResolvedValue({
      total_count: 2,
      items: [
        {
          id: 'thread:reply-1',
          kind: 'thread',
          notification_id: 'notif-1',
          conversation_id: 'channel-1',
          conversation_kind: 'channel',
          conversation_visibility: 'public',
          conversation_title: 'general',
          message_id: 'reply-1',
          thread_root_message_id: 'root-1',
          sender_id: 'user-2',
          sender_name: 'Bob',
          body: 'reply 1',
          created_at: '2026-03-06T00:01:00Z',
        },
        {
          id: 'thread:reply-2',
          kind: 'thread',
          notification_id: 'notif-2',
          conversation_id: 'channel-1',
          conversation_kind: 'channel',
          conversation_visibility: 'public',
          conversation_title: 'general',
          message_id: 'reply-2',
          thread_root_message_id: 'root-2',
          sender_id: 'user-3',
          sender_name: 'Eve',
          body: 'reply 2',
          created_at: '2026-03-06T00:02:00Z',
        },
      ],
    })

    await chat.refreshUnreadFeed()

    expect(chat.unreadFeedItems.map(item => item.id)).toEqual(['thread:reply-2'])
    expect(chat.unreadFeedTotalCount).toBe(1)
    expect(chatApiMocks.resolveUnreadFeedNotification).toHaveBeenCalledWith('notif-1')
    expect(ws.sendSubscribeThread).toHaveBeenCalledWith('channel-1', 'root-1', 0n)
  })

  it('keeps active visible thread items after refreshing unread feed while the browser is inactive', async () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.state = 'LIVE_SYNCED'
    ws.sendSubscribeThread = vi.fn()
    chat.bootstrapped = true
    chat.setClientActive(false)
    chat.messages = {
      'channel-1': [buildMessage({ id: 'root-1', channelId: 'channel-1', channelSeq: 10n })],
    }
    chat.activateThreadWorkspace('channel-1', 'root-1')
    vi.mocked(ws.sendSubscribeThread).mockClear()
    chatApiMocks.listUnreadFeed.mockResolvedValue({
      total_count: 1,
      items: [{
        id: 'thread:reply-1',
        kind: 'thread',
        notification_id: 'notif-1',
        conversation_id: 'channel-1',
        conversation_kind: 'channel',
        conversation_visibility: 'public',
        conversation_title: 'general',
        message_id: 'reply-1',
        thread_root_message_id: 'root-1',
        sender_id: 'user-2',
        sender_name: 'Bob',
        body: 'reply 1',
        created_at: '2026-03-06T00:01:00Z',
      }],
    })

    await chat.refreshUnreadFeed()

    expect(chat.unreadFeedItems.map(item => item.id)).toEqual(['thread:reply-1'])
    expect(chat.unreadFeedTotalCount).toBe(1)
    expect(chatApiMocks.resolveUnreadFeedNotification).not.toHaveBeenCalled()
    expect(ws.sendSubscribeThread).not.toHaveBeenCalled()
  })

  it('resolves every unread notification for a thread when marking one thread item read', async () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.sendUpdateReadCursor = vi.fn()

    chat.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 2,
      notificationLevel: NotificationLevel.ALL,
    }]
    chat.messages = {
      'channel-1': [
        buildMessage({
          id: 'root-1',
          channelId: 'channel-1',
          senderId: 'user-2',
          channelSeq: 10n,
          threadSeq: 0n,
        }),
        buildMessage({
          id: 'reply-1',
          channelId: 'channel-1',
          senderId: 'user-3',
          channelSeq: 11n,
          threadSeq: 1n,
          threadRootMessageId: 'root-1',
        }),
      ],
    }
    chat.unreadFeedItems = [
      {
        id: 'thread:notif-1',
        kind: 'thread',
        notificationId: 'notif-1',
        conversationId: 'channel-1',
        conversationKind: 'channel',
        conversationVisibility: 'public',
        conversationTitle: 'general',
        messageId: 'reply-1',
        threadRootMessageId: 'root-1',
        senderName: 'Bob',
        body: 'reply 1',
        createdAt: '2026-03-06T00:01:00Z',
      },
      {
        id: 'thread:notif-2',
        kind: 'thread',
        notificationId: 'notif-2',
        conversationId: 'channel-1',
        conversationKind: 'channel',
        conversationVisibility: 'public',
        conversationTitle: 'general',
        messageId: 'reply-2',
        threadRootMessageId: 'root-1',
        senderName: 'Bob',
        body: 'reply 2',
        createdAt: '2026-03-06T00:02:00Z',
      },
      {
        id: 'message:root-1',
        kind: 'message',
        conversationId: 'channel-1',
        conversationKind: 'channel',
        conversationVisibility: 'public',
        conversationTitle: 'general',
        messageId: 'root-1',
        senderName: 'Bob',
        body: 'root',
        createdAt: '2026-03-06T00:00:00Z',
      },
      {
        id: 'thread:notif-3',
        kind: 'thread',
        notificationId: 'notif-3',
        conversationId: 'channel-1',
        conversationKind: 'channel',
        conversationVisibility: 'public',
        conversationTitle: 'general',
        messageId: 'reply-3',
        threadRootMessageId: 'root-2',
        senderName: 'Eve',
        body: 'other thread',
        createdAt: '2026-03-06T00:03:00Z',
      },
    ] as any
    chat.notifications = [
      {
        id: 'notif-1',
        type: 'thread_reply',
        title: 'Reply',
        body: 'reply 1',
        conversationId: 'channel-1',
        isRead: false,
        createdAt: '2026-03-06T00:01:00Z',
      },
      {
        id: 'notif-2',
        type: 'thread_reply',
        title: 'Reply',
        body: 'reply 2',
        conversationId: 'channel-1',
        isRead: false,
        createdAt: '2026-03-06T00:02:00Z',
      },
      {
        id: 'notif-3',
        type: 'thread_reply',
        title: 'Reply',
        body: 'other thread',
        conversationId: 'channel-1',
        isRead: false,
        createdAt: '2026-03-06T00:03:00Z',
      },
    ] as any
    chat.unreadFeedTotalCount = 4

    await chat.markUnreadFeedItemRead(chat.unreadFeedItems[0])

    expect(chatApiMocks.resolveUnreadFeedNotification).toHaveBeenCalledTimes(2)
    expect(chatApiMocks.resolveUnreadFeedNotification).toHaveBeenCalledWith('notif-1')
    expect(chatApiMocks.resolveUnreadFeedNotification).toHaveBeenCalledWith('notif-2')
    expect(chat.unreadFeedItems.map(item => item.id)).toEqual(['thread:notif-3'])
    expect(chat.unreadFeedTotalCount).toBe(1)
    expect(chat.notifications.map(notification => notification.id)).toEqual(['notif-3'])
    expect(chat.channels[0].unread).toBe(0)
    expect(ws.sendUpdateReadCursor).toHaveBeenCalledWith('channel-1', 10n)
  })

  it('keeps acked optimistic thread replies visible without advancing reopen replay cursor', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.sendSubscribeThread = vi.fn()

    chat.threadMessages = {
      'root-1': [
        buildMessage({
          id: 'client-1',
          channelId: 'channel-1',
          threadSeq: 4n,
          threadRootMessageId: 'root-1',
          clientMsgId: 'client-1',
          sendStatus: 'sending',
          serverConfirmed: false,
        }),
      ],
    }

    chat.handleSendMessageAck(create(SendMessageAckSchema, {
      conversationId: 'channel-1',
      messageId: 'reply-4-server',
      channelSeq: 40n,
      clientMsgId: 'client-1',
    }))

    chat.openThread(buildMessage({
      id: 'root-1',
      channelId: 'channel-1',
      threadSeq: 0n,
    }))

    expect(chat.threadMessages['root-1'][0].id).toBe('reply-4-server')
    expect(chat.threadMessages['root-1'][0].serverConfirmed).toBe(false)
    expect(offlineQueueMocks.remove).toHaveBeenCalledWith('client-1')
    expect(ws.sendSubscribeThread).toHaveBeenCalledWith('channel-1', 'root-1', 0n)
  })

  it('queues every in-flight plaintext send and invalidates the stale transport after an ACK timeout', () => {
    vi.useFakeTimers()
    try {
      const chat = useChatStore()
      const ws = useWsStore()
      ws.state = 'LIVE_SYNCED'
      ws.invalidateTransport = vi.fn().mockReturnValue(true)
      chat.messages = {
        'channel-1': [
          buildMessage({
            id: 'client-main',
            channelId: 'channel-1',
            clientMsgId: 'client-main',
            sendStatus: 'sending',
            attachments: [{ id: 'attachment-1', fileName: 'notes.txt', fileSize: 12, mimeType: 'text/plain' }],
            entities: [{ kind: 'user', targetId: 'user-3', label: '@Eve', href: '', start: 0, end: 4 }],
          }),
          buildMessage({
            id: 'client-encrypted',
            channelId: 'channel-1',
            clientMsgId: 'client-encrypted',
            sendStatus: 'sending',
            contentMode: 'dm_pairwise_signal_v1',
          }),
        ],
      }
      chat.threadMessages = {
        'root-1': [buildMessage({
          id: 'client-thread',
          channelId: 'channel-1',
          clientMsgId: 'client-thread',
          sendStatus: 'sending',
          threadRootMessageId: 'root-1',
          attachments: [{ id: 'attachment-2', fileName: 'reply.txt', fileSize: 7, mimeType: 'text/plain' }],
        })],
      }

      chat.startSendTimeout('channel-1', 'client-main', false)
      vi.advanceTimersByTime(15_000)

      expect(chat.messages['channel-1'][0].sendStatus).toBe('queued')
      expect(chat.threadMessages['root-1'][0].sendStatus).toBe('queued')
      expect(chat.messages['channel-1'][1].sendStatus).toBe('failed')
      expect(offlineQueueMocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({
        clientMsgId: 'client-main',
        attachmentIds: ['attachment-1'],
        entities: [{ kind: 'user', targetId: 'user-3', label: '@Eve', href: '', start: 0, end: 4 }],
      }))
      expect(offlineQueueMocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({
        clientMsgId: 'client-thread',
        threadRootMessageId: 'root-1',
        attachmentIds: ['attachment-2'],
      }))
      expect(offlineQueueMocks.enqueue).not.toHaveBeenCalledWith(expect.objectContaining({ clientMsgId: 'client-encrypted' }))
      expect(ws.invalidateTransport).toHaveBeenCalledWith('Message delivery did not receive an acknowledgement')
    } finally {
      vi.useRealTimers()
    }
  })

  it('queues a normal send when the socket closes between the live-state check and write', async () => {
    const chat = useChatStore()
    const ws = useWsStore()
    const auth = useAuthStore()
    auth.user = {
      id: 'user-1',
      email: 'ada@example.com',
      displayName: 'Ada',
      avatarUrl: '',
      role: 'member',
      customStatus: null,
    }
    ws.state = 'LIVE_SYNCED'
    ws.sendMessage = vi.fn(() => false)
    ws.invalidateTransport = vi.fn().mockReturnValue(true)

    chat.sendMessageToConversation('channel-1', 'send after reconnect')
    await Promise.resolve()
    await Promise.resolve()

    const message = chat.messages['channel-1'][0]
    expect(message.sendStatus).toBe('queued')
    expect(offlineQueueMocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'channel-1',
      body: 'send after reconnect',
      clientMsgId: message.clientMsgId,
    }))
    expect(ws.invalidateTransport).toHaveBeenCalledWith('Message could not be sent')
  })

  it('keeps one conversation bubble when an ACK follows an already-applied server event', () => {
    const chat = useChatStore()
    chat.messages = {
      'channel-1': [
        buildMessage({ id: 'client-1', channelId: 'channel-1', clientMsgId: 'client-1', sendStatus: 'sending' }),
        buildMessage({ id: 'server-1', channelId: 'channel-1' }),
      ],
    }

    chat.reconcileMessage('channel-1', 'client-1', create(SendMessageAckSchema, {
      conversationId: 'channel-1',
      messageId: 'server-1',
      channelSeq: 2n,
      clientMsgId: 'client-1',
    }))

    expect(chat.messages['channel-1']).toHaveLength(1)
    expect(chat.messages['channel-1'][0].id).toBe('server-1')
  })

  it('keeps optimistic thumbnail metadata when an ACK precedes message_created', () => {
    const chat = useChatStore()
    chat.bootstrapped = true
    chat.messages = {
      'channel-1': [buildMessage({
        id: 'client-thumbnail-1',
        channelId: 'channel-1',
        clientMsgId: 'client-thumbnail-1',
        sendStatus: 'sending',
        attachments: [{
          id: 'attachment-thumbnail-1',
          fileName: 'photo.jpg',
          fileSize: 1024,
          mimeType: 'image/jpeg',
          thumbnailMimeType: 'image/jpeg',
          thumbnailFileSize: 128,
          thumbnailVersion: 1,
        }],
      })],
    }

    chat.handleSendMessageAck(create(SendMessageAckSchema, {
      conversationId: 'channel-1',
      messageId: 'server-thumbnail-1',
      channelSeq: 2n,
      clientMsgId: 'client-thumbnail-1',
    }))
    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 1n,
      eventId: 'evt-server-thumbnail-1',
      eventType: EventType.MESSAGE_CREATED,
      conversationId: 'channel-1',
      payload: {
        case: 'messageCreated',
        value: create(MessageEventSchema, {
          conversationId: 'channel-1',
          messageId: 'server-thumbnail-1',
          senderId: 'user-1',
          body: '',
          channelSeq: 2n,
          attachments: [create(MessageAttachmentSchema, {
            attachmentId: 'attachment-thumbnail-1',
            fileName: 'photo.jpg',
            fileSize: 1024n,
            mimeType: 'image/jpeg',
            thumbnailMimeType: 'image/jpeg',
            thumbnailFileSize: 128n,
            thumbnailVersion: 1,
          })],
        }),
      },
    }))

    expect(chat.messages['channel-1']).toHaveLength(1)
    expect(chat.messages['channel-1'][0].attachments).toEqual([{
      id: 'attachment-thumbnail-1',
      fileName: 'photo.jpg',
      fileSize: 1024,
      mimeType: 'image/jpeg',
      thumbnailMimeType: 'image/jpeg',
      thumbnailFileSize: 128,
      thumbnailVersion: 1,
    }])
  })

  it('re-subscribes the active thread when summary advances beyond confirmed replies', () => {
    vi.useFakeTimers()
    try {
      const chat = useChatStore()
      const ws = useWsStore()
      ws.state = 'LIVE_SYNCED'
      ws.sendSubscribeThread = vi.fn()
      chat.bootstrapped = true
      chat.messages = {
        'channel-1': [buildMessage({ id: 'root-1', channelId: 'channel-1', threadSeq: 0n })],
      }
      chat.threadMessages = {
        'root-1': [
          buildMessage({
            id: 'reply-1',
            channelId: 'channel-1',
            threadSeq: 1n,
            threadRootMessageId: 'root-1',
            serverConfirmed: true,
          }),
        ],
      }
      chat.threadSummaries = {
        'root-1': {
          replyCount: 1,
          lastThreadSeq: 1n,
        },
      }

      chat.openThread(chat.messages['channel-1'][0])
      vi.mocked(ws.sendSubscribeThread).mockClear()

      chat.handleServerEvent(create(ServerEventSchema, {
        eventSeq: 1n,
        eventId: 'evt-thread-summary-gap',
        eventType: EventType.THREAD_SUMMARY_UPDATED,
        conversationId: 'channel-1',
        payload: {
          case: 'threadSummaryUpdated',
          value: create(ThreadSummaryUpdatedEventSchema, {
            conversationId: 'channel-1',
            threadRootMessageId: 'root-1',
            replyCount: 2,
            lastThreadSeq: 2n,
          }),
        },
      }))

      vi.advanceTimersByTime(200)

      expect(ws.sendSubscribeThread).toHaveBeenCalledWith('channel-1', 'root-1', 0n)
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-subscribes the active thread when direct unread-thread state says replies are missing', () => {
    vi.useFakeTimers()
    try {
      const chat = useChatStore()
      const ws = useWsStore()
      ws.state = 'LIVE_SYNCED'
      ws.sendSubscribeThread = vi.fn()
      chat.bootstrapped = true
      chat.messages = {
        'channel-1': [buildMessage({ id: 'root-1', channelId: 'channel-1', threadSeq: 0n })],
      }
      chat.threadMessages = {
        'root-1': [
          buildMessage({
            id: 'reply-1',
            channelId: 'channel-1',
            threadSeq: 1n,
            threadRootMessageId: 'root-1',
            serverConfirmed: true,
          }),
        ],
      }
      chat.threadSummaries = {
        'root-1': {
          replyCount: 2,
          lastThreadSeq: 2n,
        },
      }

      chat.openThread(chat.messages['channel-1'][0])
      vi.mocked(ws.sendSubscribeThread).mockClear()

      chat.handleServerEvent(create(ServerEventSchema, {
        eventSeq: 0n,
        eventType: EventType.READ_COUNTER_UPDATED,
        conversationId: 'channel-1',
        payload: {
          case: 'readCounterUpdated',
          value: create(ReadCounterUpdatedEventSchema, {
            userId: 'user-1',
            counter: create(UnreadCounterSchema, {
              conversationId: 'channel-1',
              unreadMessages: 0,
              unreadMentions: 0,
              hasUnreadThreadReplies: true,
              lastReadSeq: 0n,
            }),
          }),
        },
      }))

      vi.advanceTimersByTime(200)

      expect(ws.sendSubscribeThread).toHaveBeenCalledWith('channel-1', 'root-1', 0n)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not re-subscribe the active thread on unread-thread updates when the confirmed cursor is current', () => {
    vi.useFakeTimers()
    try {
      const chat = useChatStore()
      const ws = useWsStore()
      ws.state = 'LIVE_SYNCED'
      ws.sendSubscribeThread = vi.fn()
      chat.bootstrapped = true
      chat.messages = {
        'channel-1': [buildMessage({ id: 'root-1', channelId: 'channel-1', threadSeq: 0n })],
      }
      chat.threadMessages = {
        'root-1': [
          buildMessage({
            id: 'reply-1',
            channelId: 'channel-1',
            threadSeq: 1n,
            threadRootMessageId: 'root-1',
            serverConfirmed: true,
          }),
        ],
      }
      chat.threadSummaries = {
        'root-1': {
          replyCount: 1,
          lastThreadSeq: 1n,
        },
      }

      chat.openThread(chat.messages['channel-1'][0])
      vi.mocked(ws.sendSubscribeThread).mockClear()

      chat.handleServerEvent(create(ServerEventSchema, {
        eventSeq: 0n,
        eventType: EventType.READ_COUNTER_UPDATED,
        conversationId: 'channel-1',
        payload: {
          case: 'readCounterUpdated',
          value: create(ReadCounterUpdatedEventSchema, {
            userId: 'user-1',
            counter: create(UnreadCounterSchema, {
              conversationId: 'channel-1',
              unreadMessages: 0,
              unreadMentions: 0,
              hasUnreadThreadReplies: true,
              lastReadSeq: 0n,
            }),
          }),
        },
      }))

      vi.advanceTimersByTime(200)

      expect(ws.sendSubscribeThread).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-subscribes the active thread from zero when summary count exceeds confirmed cached replies', () => {
    vi.useFakeTimers()
    try {
      const chat = useChatStore()
      const ws = useWsStore()
      ws.state = 'LIVE_SYNCED'
      ws.sendSubscribeThread = vi.fn()
      chat.bootstrapped = true
      chat.messages = {
        'channel-1': [buildMessage({ id: 'root-1', channelId: 'channel-1', threadSeq: 0n })],
      }
      chat.threadMessages = {
        'root-1': [
          buildMessage({
            id: 'reply-8',
            channelId: 'channel-1',
            threadSeq: 8n,
            threadRootMessageId: 'root-1',
            serverConfirmed: true,
          }),
        ],
      }
      chat.threadSummaries = {
        'root-1': {
          replyCount: 8,
          lastThreadSeq: 8n,
        },
      }

      chat.openThread(chat.messages['channel-1'][0])
      vi.mocked(ws.sendSubscribeThread).mockClear()

      chat.handleServerEvent(create(ServerEventSchema, {
        eventSeq: 0n,
        eventType: EventType.READ_COUNTER_UPDATED,
        conversationId: 'channel-1',
        payload: {
          case: 'readCounterUpdated',
          value: create(ReadCounterUpdatedEventSchema, {
            userId: 'user-1',
            counter: create(UnreadCounterSchema, {
              conversationId: 'channel-1',
              unreadMessages: 0,
              unreadMentions: 0,
              hasUnreadThreadReplies: true,
              lastReadSeq: 0n,
            }),
          }),
        },
      }))

      vi.advanceTimersByTime(200)

      expect(ws.sendSubscribeThread).toHaveBeenCalledWith('channel-1', 'root-1', 0n)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps thread summary lastThreadSeq monotonic when older summary events arrive late', () => {
    const chat = useChatStore()
    chat.threadSummaries = {
      'root-1': {
        replyCount: 4,
        lastThreadSeq: 4n,
      },
    }

    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 1n,
      eventId: 'evt-thread-summary-old',
      eventType: EventType.THREAD_SUMMARY_UPDATED,
      conversationId: 'channel-1',
      payload: {
        case: 'threadSummaryUpdated',
        value: create(ThreadSummaryUpdatedEventSchema, {
          conversationId: 'channel-1',
          threadRootMessageId: 'root-1',
          replyCount: 2,
          lastThreadSeq: 2n,
        }),
      },
    }))

    expect(chat.threadSummaries['root-1'].lastThreadSeq).toBe(4n)
  })

  it('restores persisted thread summaries after bootstrap refresh', () => {
    storage.setItem('msgnr:thread-summaries:v1', JSON.stringify({
      'user-1': {
        'root-1': {
          replyCount: 4,
          lastThreadSeq: '4',
          lastReplyAt: '2026-03-06T00:04:00Z',
          lastReplyUserId: 'user-2',
        },
      },
    }))

    const chat = useChatStore()
    const ws = useWsStore()
    ws.setLiveSynced = vi.fn()
    ws.sendAck = vi.fn()

    chat.handleBootstrapResponse(create(BootstrapResponseSchema, {
      snapshotSeq: 12n,
      userRole: 2,
      workspace: {
        workspaceId: 'workspace-1',
        workspaceName: 'Acme',
        selfUser: create(UserSummarySchema, { userId: 'user-1', displayName: 'Ada', avatarUrl: '' }),
        selfRole: 3,
      },
      conversations: [create(ConversationSummarySchema, {
        conversationId: 'channel-1',
        conversationType: 2,
        title: 'general',
        topic: '',
        isArchived: false,
        notificationLevel: NotificationLevel.ALL,
        lastMessageSeq: 0n,
        lastMessagePreview: '',
        memberCount: 1,
        presence: 3,
      })],
      unread: [],
      activeCalls: [],
      pendingInvites: [],
      notifications: [],
      hasMore: false,
      nextPageToken: '',
      bootstrapSessionId: 'session-restore-thread',
      pageIndex: 0,
      pageSizeEffective: 1,
      estimatedTotalConversations: 1,
      presence: [],
    }))

    expect(chat.threadSummaries['root-1']).toEqual({
      replyCount: 4,
      lastThreadSeq: 4n,
      lastReplyAt: '2026-03-06T00:04:00Z',
      lastReplyUserId: 'user-2',
    })
  })

  it('tracks thread summary from thread replies but leaves unread-thread state to read-counter events', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.state = 'LIVE_SYNCED'

    chat.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfRole: 'member',
    }
    chat.bootstrapped = true
    chat.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      hasUnreadThreadReplies: false,
      notificationLevel: NotificationLevel.ALL,
    }]

    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 1n,
      eventId: 'evt-thread-1',
      eventType: EventType.MESSAGE_CREATED,
      conversationId: 'channel-1',
      payload: {
        case: 'messageCreated',
        value: create(MessageEventSchema, {
          conversationId: 'channel-1',
          messageId: 'reply-1',
          senderId: 'user-2',
          body: 'thread reply',
          channelSeq: 2n,
          threadRootMessageId: 'root-1',
          threadSeq: 1n,
        }),
      },
    }))

    expect(chat.channels[0].hasUnreadThreadReplies).toBe(false)
    expect(chat.threadSummaries['root-1'].replyCount).toBe(1)
    expect(chat.threadSummaries['root-1'].lastThreadSeq).toBe(1n)
  })

  it('applies message_updated and message_deleted idempotently in conversation/thread caches', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.state = 'LIVE_SYNCED'
    chat.bootstrapped = true

    chat.messages = {
      'channel-1': [
        buildMessage({ id: 'message-1', body: 'root body', channelSeq: 10n }),
      ],
    }
    chat.threadMessages = {
      'root-1': [
        buildMessage({
          id: 'reply-1',
          body: 'before edit',
          channelSeq: 11n,
          threadSeq: 1n,
          threadRootMessageId: 'root-1',
        }),
      ],
    }

    const updatedEvent = create(ServerEventSchema, {
      eventSeq: 1n,
      eventId: 'evt-message-updated-1',
      eventType: EventType.MESSAGE_UPDATED,
      conversationId: 'channel-1',
      payload: {
        case: 'messageUpdated',
        value: create(MessageUpdatedEventSchema, {
          conversationId: 'channel-1',
          messageId: 'reply-1',
          body: 'after edit',
          mentionedUserIds: ['user-9'],
          mentionEveryone: true,
        }),
      },
    })

    chat.handleServerEvent(updatedEvent)
    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 2n,
      eventId: 'evt-message-updated-2',
      eventType: EventType.MESSAGE_UPDATED,
      conversationId: 'channel-1',
      payload: {
        case: 'messageUpdated',
        value: create(MessageUpdatedEventSchema, {
          conversationId: 'channel-1',
          messageId: 'reply-1',
          body: 'after edit',
          mentionedUserIds: ['user-9'],
          mentionEveryone: true,
        }),
      },
    }))

    expect(chat.threadMessages['root-1'][0].body).toBe('after edit')
    expect(chat.threadMessages['root-1'][0].mentionedUserIds).toEqual(['user-9'])
    expect(chat.threadMessages['root-1'][0].mentionEveryone).toBe(true)

    const deletedEvent = create(ServerEventSchema, {
      eventSeq: 3n,
      eventId: 'evt-message-deleted-1',
      eventType: EventType.MESSAGE_DELETED,
      conversationId: 'channel-1',
      payload: {
        case: 'messageDeleted',
        value: create(MessageDeletedEventSchema, {
          conversationId: 'channel-1',
          messageId: 'reply-1',
          threadRootMessageId: 'root-1',
        }),
      },
    })

    chat.handleServerEvent(deletedEvent)
    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 4n,
      eventId: 'evt-message-deleted-2',
      eventType: EventType.MESSAGE_DELETED,
      conversationId: 'channel-1',
      payload: {
        case: 'messageDeleted',
        value: create(MessageDeletedEventSchema, {
          conversationId: 'channel-1',
          messageId: 'reply-1',
          threadRootMessageId: 'root-1',
        }),
      },
    }))

    expect(chat.threadMessages['root-1']).toHaveLength(0)
    expect(chat.messages['channel-1']).toHaveLength(1)
  })

  it('closes active thread and clears thread cache when root message is deleted', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.state = 'LIVE_SYNCED'
    chat.bootstrapped = true

    chat.messages = {
      'channel-1': [buildMessage({ id: 'root-1', channelSeq: 10n })],
    }
    chat.threadMessages = {
      'root-1': [
        buildMessage({
          id: 'reply-1',
          channelSeq: 11n,
          threadSeq: 1n,
          threadRootMessageId: 'root-1',
        }),
      ],
    }
    chat.threadSummaries = {
      'root-1': {
        replyCount: 1,
        lastThreadSeq: 3n,
      },
    }
    chat.activeThreadConversationId = 'channel-1'
    chat.activeThreadRootId = 'root-1'

    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 1n,
      eventId: 'evt-root-deleted',
      eventType: EventType.MESSAGE_DELETED,
      conversationId: 'channel-1',
      payload: {
        case: 'messageDeleted',
        value: create(MessageDeletedEventSchema, {
          conversationId: 'channel-1',
          messageId: 'root-1',
        }),
      },
    }))

    expect(chat.messages['channel-1']).toHaveLength(0)
    expect(chat.threadMessages['root-1']).toBeUndefined()
    expect(chat.threadSummaries['root-1']).toBeUndefined()
    expect(chat.isThreadPanelOpen).toBe(false)
    expect(chat.activeThreadRootId).toBe('')
  })

  it('keeps a DM visible while clearing history caches on dm_history_cleared', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.state = 'LIVE_SYNCED'
    chat.bootstrapped = true

    chat.directMessages = [{
      id: 'dm-1',
      userId: 'user-2',
      displayName: 'Bob',
      avatarUrl: '',
      presence: 'online',
      unread: 3,
      hasUnreadThreadReplies: true,
      notificationLevel: NotificationLevel.ALL,
    }]
    chat.messages = {
      'dm-1': [buildMessage({ id: 'root-1', channelId: 'dm-1', channelSeq: 10n })],
    }
    chat.threadMessages = {
      'root-1': [buildMessage({ id: 'reply-1', channelId: 'dm-1', threadRootMessageId: 'root-1', threadSeq: 1n })],
    }
    chat.threadSummaries = {
      'root-1': {
        replyCount: 1,
        lastThreadSeq: 1n,
      },
    }
    chat.unreadFeedItems = [buildUnreadThreadItem({ conversationId: 'dm-1', conversationKind: 'dm' }) as any]
    chat.unreadFeedTotalCount = 1
    chat.savedMessageItems = [{
      id: 'saved:root-1',
      conversationId: 'dm-1',
      conversationKind: 'dm',
      conversationVisibility: 'dm',
      conversationTitle: 'Bob',
      messageId: 'root-1',
      senderId: 'user-2',
      senderName: 'Bob',
      body: 'saved',
      createdAt: '2026-03-06T00:00:00Z',
      savedAt: '2026-03-06T00:01:00Z',
    }]
    chat.savedMessageTotalCount = 1
    chat.savedMessagesLoaded = true
    chat.activeThreadConversationId = 'dm-1'
    chat.activeThreadRootId = 'root-1'

    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 1n,
      eventId: 'evt-dm-clear-1',
      eventType: EventType.DM_HISTORY_CLEARED,
      conversationId: 'dm-1',
      payload: {
        case: 'dmHistoryCleared',
        value: create(DmHistoryClearedEventSchema, {
          conversationId: 'dm-1',
          clearedByUserId: 'user-1',
          deletedMessagesCount: 2,
        }),
      },
    }))

    expect(chat.directMessages).toHaveLength(1)
    expect(chat.directMessages[0].unread).toBe(0)
    expect(chat.directMessages[0].hasUnreadThreadReplies).toBe(false)
    expect(chat.messages['dm-1']).toEqual([])
    expect(chat.threadMessages['root-1']).toBeUndefined()
    expect(chat.threadSummaries['root-1']).toBeUndefined()
    expect(chat.unreadFeedItems).toEqual([])
    expect(chat.unreadFeedTotalCount).toBe(0)
    expect(chat.savedMessageItems).toEqual([])
    expect(chat.savedMessageTotalCount).toBe(0)
    expect(chat.isThreadPanelOpen).toBe(false)
  })

  it('does not let stale history responses repopulate a cleared DM', async () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.state = 'LIVE_SYNCED'
    chat.bootstrapped = true
    chat.directMessages = [{
      id: 'dm-1',
      userId: 'user-2',
      displayName: 'Bob',
      avatarUrl: '',
      presence: 'online',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]

    let resolveHistory!: (page: {
      messages: Array<{
        id: string
        conversation_id: string
        sender_id: string
        sender_name: string
        body: string
        channel_seq: string
        thread_seq: string
        thread_root_message_id: string
        mention_everyone: boolean
        created_at: string
        entities: []
      }>
      has_more: boolean
      page_size: number
    }) => void
    chatApiMocks.listConversationMessages.mockReturnValueOnce(new Promise(resolve => {
      resolveHistory = resolve
    }))

    const pendingLoad = chat.ensureConversationHistory('dm-1')
    await Promise.resolve()

    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 1n,
      eventId: 'evt-dm-clear-stale',
      eventType: EventType.DM_HISTORY_CLEARED,
      conversationId: 'dm-1',
      payload: {
        case: 'dmHistoryCleared',
        value: create(DmHistoryClearedEventSchema, {
          conversationId: 'dm-1',
          clearedByUserId: 'user-1',
          deletedMessagesCount: 1,
        }),
      },
    }))

    resolveHistory({
      messages: [{
        id: 'old-message',
        conversation_id: 'dm-1',
        sender_id: 'user-2',
        sender_name: 'Bob',
        body: 'old history',
        channel_seq: '1',
        thread_seq: '0',
        thread_root_message_id: '',
        mention_everyone: false,
        created_at: '2026-03-06T00:00:00Z',
        entities: [],
      }],
      has_more: false,
      page_size: 1,
    })
    await pendingLoad

    expect(chat.messages['dm-1']).toEqual([])
    expect(chat.conversationHasMoreHistory('dm-1')).toBe(false)
  })

  it('reloads secret history after invalidation and ignores earlier history and context responses', async () => {
    const chat = useChatStore()
    const ws = useWsStore()
    chat.bootstrapped = true
    ws.state = 'LIVE_SYNCED'
    chat.directMessages = [{ id: 'dm-1', userId: 'user-2', displayName: 'Bob', avatarUrl: '', presence: 'online', unread: 3, encryptionMode: 'dm_pairwise_signal_v1', notificationLevel: NotificationLevel.ALL }]
    const oldPage = {
      messages: [{ id: 'deleted', conversation_id: 'dm-1', sender_id: 'user-2', sender_name: 'Bob', body: 'old content', channel_seq: '1', thread_seq: '0', thread_root_message_id: '', mention_everyone: false, created_at: '2026-09-12T00:00:00Z', entities: [] }],
      has_more: false, page_size: 1,
    }
    let resolveHistory!: (page: typeof oldPage) => void
    let resolveContext!: (page: typeof oldPage) => void
    chatApiMocks.listConversationMessages.mockReturnValueOnce(new Promise(resolve => { resolveHistory = resolve }))
    chatApiMocks.getMessageContext.mockReturnValueOnce(new Promise(resolve => { resolveContext = resolve }))
    const oldHistory = chat.ensureConversationHistory('dm-1')
    const oldContext = chat.loadMessageContext('dm-1', 'deleted')
    chat.activeChannelId = 'dm-1'
    chat.messages['dm-1'] = [buildMessage({ id: 'deleted', channelId: 'dm-1', contentMode: 'dm_pairwise_signal_v1' })]
    chat.messages['other'] = [buildMessage({ id: 'keep', channelId: 'other' })]
    chatApiMocks.listConversationMessages.mockResolvedValue({ messages: [], has_more: false, page_size: 0 })
    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 1n, eventId: 'refresh', eventType: EventType.SECRET_HISTORY_INVALIDATED, conversationId: 'dm-1',
      payload: { case: 'secretHistoryInvalidated', value: create(SecretHistoryInvalidatedEventSchema, { conversationId: 'dm-1' }) },
    }))
    resolveHistory(oldPage)
    resolveContext(oldPage)
    await Promise.all([oldHistory, oldContext])
    expect(chat.messages['dm-1']).toEqual([])
    expect(chat.messages['other'][0].id).toBe('keep')
    expect(chat.directMessages[0].unread).toBe(3)
    expect(chatApiMocks.listConversationMessages).toHaveBeenCalledTimes(2)
    expect(chat.lastAppliedEventSeq).toBe(1n)
  })

  it('does not restore a secret message when decryption finishes after purge', async () => {
    const chat = useChatStore()
    chat.bootstrapped = true
    useWsStore().state = 'LIVE_SYNCED'
    let finishDecrypt!: (body: string) => void
    e2eeMocks.decryptDMMessage.mockReturnValue(new Promise(resolve => { finishDecrypt = resolve }))
    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 1n, eventId: 'secret', eventType: EventType.MESSAGE_CREATED, conversationId: 'dm-1',
      payload: { case: 'messageCreated', value: create(MessageEventSchema, {
        conversationId: 'dm-1', messageId: 'deleted', senderId: 'user-2', channelSeq: 1n,
        contentMode: MessageContentMode.DM_PAIRWISE_SIGNAL_V1,
      }) },
    }))
    expect(chat.messages['dm-1']).toHaveLength(1)
    chat.invalidateSecretHistory('dm-1')
    finishDecrypt('deleted plaintext')
    await Promise.resolve()
    expect(chat.messages['dm-1']).toEqual([])
  })

  it('discards stale saved and unread results after a secret purge', async () => {
    const chat = useChatStore()
    chat.bootstrapped = true
    let finishSaved!: (value: unknown) => void
    let finishUnread!: (value: unknown) => void
    chatApiMocks.listSavedMessages.mockReturnValue(new Promise(resolve => { finishSaved = resolve }))
    chatApiMocks.listUnreadFeed.mockReturnValue(new Promise(resolve => { finishUnread = resolve }))
    const saved = chat.refreshSavedMessages()
    const unread = chat.refreshUnreadFeed()
    chat.invalidateSecretHistory('dm-1')
    // Deliberately incomplete stale rows must be discarded before conversion.
    finishSaved({ items: [{ message_id: 'deleted' }], total_count: 1 })
    finishUnread({ items: [{ message_id: 'deleted' }], total_count: 1 })
    await Promise.all([saved, unread])
    expect(chat.savedMessageItems).toEqual([])
    expect(chat.unreadFeedItems).toEqual([])
  })

  it('drops secret cached messages when reconnect falls back to bootstrap', () => {
    const chat = useChatStore()
    chat.directMessages = [{ id: 'dm-1', userId: 'peer', displayName: 'Bob', avatarUrl: '', presence: 'online', unread: 0, encryptionMode: 'dm_pairwise_signal_v1', notificationLevel: NotificationLevel.ALL }]
    chat.activeChannelId = 'dm-1'
    chat.messages['dm-1'] = [buildMessage({ id: 'deleted-offline', channelId: 'dm-1', contentMode: 'dm_pairwise_signal_v1', body: 'old plaintext' })]
    chatApiMocks.listConversationMessages.mockReturnValue(new Promise(() => {}))
    chat.handleBootstrapResponse(create(BootstrapResponseSchema, {
      snapshotSeq: 30n, bootstrapSessionId: 'reconnect',
      conversations: [create(ConversationSummarySchema, { conversationId: 'dm-1', conversationType: 1, topic: 'peer', title: 'Bob', encryptionMode: ConversationEncryptionMode.DM_PAIRWISE_SIGNAL_V1 })],
    }))
    expect(chat.messages['dm-1'] ?? []).toEqual([])
    expect(chat.lastAppliedEventSeq).toBe(30n)
  })

  it('reloads the active encrypted DM with a recovered local device and ignores the temporary-device request', async () => {
    const chat = useChatStore()
    chat.directMessages = [{
      id: 'dm-1',
      userId: 'user-2',
      displayName: 'Bob',
      avatarUrl: '',
      presence: 'online',
      encryptionMode: 'dm_pairwise_signal_v1',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chat.activeChannelId = 'dm-1'
    chat.messages = {
      'dm-1': [buildMessage({
        id: 'temporary-placeholder',
        channelId: 'dm-1',
        body: 'Decrypting encrypted message...',
        contentMode: 'dm_pairwise_signal_v1',
      })],
    }
    localStorage.setItem('msgnr:e2ee:dm-device:v1', JSON.stringify({
      deviceId: 'temporary-device',
      publicKeyJwk: {},
      privateKeyJwk: {},
    }))

    type EncryptedHistoryPage = {
      messages: Array<Record<string, unknown>>
      has_more: boolean
      page_size: number
      next_before_channel_seq: string
    }
    let resolveTemporaryHistory!: (page: EncryptedHistoryPage) => void
    chatApiMocks.listConversationMessages
      .mockReturnValueOnce(new Promise<EncryptedHistoryPage>(resolve => {
        resolveTemporaryHistory = resolve
      }))
      .mockResolvedValueOnce({
        messages: [],
        has_more: false,
        page_size: 50,
        next_before_channel_seq: '',
      })

    const temporaryLoad = chat.ensureConversationHistory('dm-1')
    await Promise.resolve()
    expect(chatApiMocks.listConversationMessages).toHaveBeenLastCalledWith('dm-1', undefined, 'temporary-device')

    localStorage.setItem('msgnr:e2ee:dm-device:v1', JSON.stringify({
      deviceId: 'recovered-device',
      publicKeyJwk: {},
      privateKeyJwk: {},
    }))
    await chat.reloadActiveEncryptedDMHistory()

    expect(chat.messages['dm-1']).toEqual([])
    expect(chatApiMocks.listConversationMessages).toHaveBeenLastCalledWith('dm-1', undefined, 'recovered-device')

    resolveTemporaryHistory({
      messages: [{
        id: 'temporary-message',
        conversation_id: 'dm-1',
        sender_id: 'user-2',
        sender_name: 'Bob',
        body: 'old temporary ciphertext',
        channel_seq: '1',
        thread_seq: '0',
        thread_root_message_id: '',
        mention_everyone: false,
        created_at: '2026-08-27T00:00:00Z',
        entities: [],
      }],
      has_more: false,
      page_size: 1,
      next_before_channel_seq: '',
    })
    await temporaryLoad

    expect(chat.messages['dm-1']).toEqual([])
  })

  it('reactively applies decrypted encrypted-DM history without reopening the conversation', async () => {
    const chat = useChatStore()
    const observedBodies: string[] = []
    const stopWatchingBody = watch(
      () => chat.messages['dm-1']?.[0]?.body,
      body => {
        if (body) observedBodies.push(body)
      },
    )
    e2eeMocks.decryptDMMessage.mockResolvedValue('decrypted history message')
    chatApiMocks.listConversationMessages.mockResolvedValue({
      messages: [{
        id: 'encrypted-history-message',
        conversation_id: 'dm-1',
        sender_id: 'user-2',
        sender_name: 'Bob',
        body: 'opaque ciphertext',
        channel_seq: '1',
        thread_seq: '0',
        thread_root_message_id: '',
        mention_everyone: false,
        created_at: '2026-08-31T00:00:00Z',
        entities: [],
        content_mode: 'dm_pairwise_signal_v1',
        encrypted_dm_payloads: [],
      }],
      has_more: false,
      page_size: 1,
    })

    await chat.ensureConversationHistory('dm-1')
    await nextTick()

    expect(chat.messages['dm-1'][0].body).toBe('decrypted history message')
    expect(observedBodies).toContain('decrypted history message')
    stopWatchingBody()
  })

  it('reactively applies a decrypted live encrypted-DM message without reopening the conversation', async () => {
    const chat = useChatStore()
    const ws = useWsStore()
    const observedBodies: string[] = []
    chat.bootstrapped = true
    ws.state = 'LIVE_SYNCED'
    e2eeMocks.decryptDMMessage.mockResolvedValue('decrypted live message')
    const stopWatchingBody = watch(
      () => chat.messages['dm-1']?.[0]?.body,
      body => {
        if (body) observedBodies.push(body)
      },
    )

    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 1n,
      eventId: 'encrypted-live-message',
      eventType: EventType.MESSAGE_CREATED,
      conversationId: 'dm-1',
      payload: {
        case: 'messageCreated',
        value: create(MessageEventSchema, {
          conversationId: 'dm-1',
          messageId: 'encrypted-live-message',
          senderId: 'user-2',
          body: 'opaque ciphertext',
          channelSeq: 1n,
          threadRootMessageId: '',
          threadSeq: 0n,
          mentionedUserIds: [],
          mentionEveryone: false,
          contentMode: MessageContentMode.DM_PAIRWISE_SIGNAL_V1,
        }),
      },
    }))
    await Promise.resolve()
    await nextTick()

    expect(chat.messages['dm-1'][0].body).toBe('decrypted live message')
    expect(observedBodies).toContain('decrypted live message')
    stopWatchingBody()
  })

  it('does not apply an old-session history response after reset opens the same conversation', async () => {
    const chat = useChatStore()
    let resolveOldHistory!: (page: {
      messages: Array<{
        id: string
        conversation_id: string
        sender_id: string
        sender_name: string
        body: string
        channel_seq: string
        thread_seq: string
        thread_root_message_id: string
        mention_everyone: boolean
        created_at: string
        entities: []
      }>
      has_more: boolean
      page_size: number
    }) => void
    let resolveNewHistory!: typeof resolveOldHistory

    chatApiMocks.listConversationMessages
      .mockReturnValueOnce(new Promise(resolve => {
        resolveOldHistory = resolve
      }))
      .mockReturnValueOnce(new Promise(resolve => {
        resolveNewHistory = resolve
      }))

    const oldLoad = chat.ensureConversationHistory('channel-1')
    await Promise.resolve()
    chat.resetRuntimeState()
    const newLoad = chat.ensureConversationHistory('channel-1')
    await Promise.resolve()

    resolveOldHistory({
      messages: [{
        id: 'old-message',
        conversation_id: 'channel-1',
        sender_id: 'user-old',
        sender_name: 'Old user',
        body: 'old account history',
        channel_seq: '1',
        thread_seq: '0',
        thread_root_message_id: '',
        mention_everyone: false,
        created_at: '2026-03-06T00:00:00Z',
        entities: [],
      }],
      has_more: false,
      page_size: 1,
    })
    await oldLoad

    expect(chat.messages['channel-1']).toBeUndefined()

    resolveNewHistory({
      messages: [{
        id: 'new-message',
        conversation_id: 'channel-1',
        sender_id: 'user-new',
        sender_name: 'New user',
        body: 'new account history',
        channel_seq: '1',
        thread_seq: '0',
        thread_root_message_id: '',
        mention_everyone: false,
        created_at: '2026-03-06T00:00:00Z',
        entities: [],
      }],
      has_more: false,
      page_size: 1,
    })
    await newLoad

    expect(chat.messages['channel-1'].map(message => message.body)).toEqual(['new account history'])
  })

  it('uses thread_summary_updated.lastThreadSeq as cursor and allows reply_count decreases', () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.state = 'LIVE_SYNCED'
    chat.bootstrapped = true
    chat.threadSummaries = {
      'root-1': {
        replyCount: 5,
        lastThreadSeq: 9n,
      },
    }

    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 1n,
      eventId: 'evt-thread-summary-updated',
      eventType: EventType.THREAD_SUMMARY_UPDATED,
      conversationId: 'channel-1',
      payload: {
        case: 'threadSummaryUpdated',
        value: create(ThreadSummaryUpdatedEventSchema, {
          conversationId: 'channel-1',
          threadRootMessageId: 'root-1',
          replyCount: 4,
          lastThreadSeq: 9n,
        }),
      },
    }))

    expect(chat.threadSummaries['root-1'].replyCount).toBe(4)
    expect(chat.threadSummaries['root-1'].lastThreadSeq).toBe(9n)
  })

  it('loads conversation history when selecting a conversation with no cached messages', async () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.sendUpdateReadCursor = vi.fn()
    chatApiMocks.listConversationMessages.mockResolvedValue({
      messages: [
        {
          id: 'message-1',
          conversation_id: 'channel-1',
          sender_id: 'user-2',
          sender_name: 'Bob',
          body: 'history',
          channel_seq: '12',
          thread_seq: '0',
          thread_root_message_id: '',
          thread_reply_count: 2,
          mention_everyone: false,
          created_at: '2026-03-06T00:00:00Z',
          reactions: [{ emoji: ':+1:', count: 2 }],
          my_reactions: [':+1:'],
          attachments: [{
            id: 'attachment-thumbnail',
            file_name: 'photo.png',
            file_size: 1024,
            mime_type: 'image/png',
            thumbnail_mime_type: 'image/jpeg',
            thumbnail_file_size: 128,
            thumbnail_version: 1,
          }],
        },
      ],
      has_more: false,
      page_size: 50,
      next_before_channel_seq: '',
    })

    chat.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 3,
      lastMessageSeq: 12n,
      notificationLevel: NotificationLevel.ALL,
    }]

    chat.selectChannel('channel-1')
    await Promise.resolve()

    expect(chatApiMocks.listConversationMessages).toHaveBeenCalledWith('channel-1', undefined)
    expect(chat.messages['channel-1']).toHaveLength(1)
    expect(chat.messages['channel-1'][0].body).toBe('history')
    expect(chat.messages['channel-1'][0].reactions).toEqual([{ emoji: ':+1:', count: 2 }])
    expect(chat.messages['channel-1'][0].myReactions).toEqual([':+1:'])
    expect(chat.messages['channel-1'][0].attachments).toEqual([{
      id: 'attachment-thumbnail',
      fileName: 'photo.png',
      fileSize: 1024,
      mimeType: 'image/png',
      thumbnailMimeType: 'image/jpeg',
      thumbnailFileSize: 128,
      thumbnailVersion: 1,
    }])
    expect(chat.resolveDisplayName('user-2')).toBe('Bob')
    expect(chat.threadSummaries['message-1'].replyCount).toBe(2)
    expect(chat.threadSummaries['message-1'].lastThreadSeq).toBe(2n)
  })

  it('preserves existing reactions when authoritative history omits them for the same message id', async () => {
    const chat = useChatStore()

    chat.messages = {
      'channel-1': [
        buildMessage({
          id: 'message-1',
          channelId: 'channel-1',
          channelSeq: 12n,
          reactions: [{ emoji: ':+1:', count: 2 }],
          myReactions: [':+1:'],
        }),
      ],
    }
    chatApiMocks.listConversationMessages.mockResolvedValue({
      messages: [
        {
          id: 'message-1',
          conversation_id: 'channel-1',
          sender_id: 'user-2',
          sender_name: 'Bob',
          body: 'history',
          channel_seq: '12',
          thread_seq: '0',
          thread_root_message_id: '',
          mention_everyone: false,
          created_at: '2026-03-06T00:00:00Z',
        },
      ],
      has_more: false,
      page_size: 50,
      next_before_channel_seq: '',
    })

    await chat.ensureConversationHistory('channel-1')

    expect(chat.messages['channel-1'][0].reactions).toEqual([{ emoji: ':+1:', count: 2 }])
    expect(chat.messages['channel-1'][0].myReactions).toEqual([':+1:'])
  })

  it('clears initial conversation loading flag after history request resolves', async () => {
    const chat = useChatStore()
    chat.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
      lastMessageSeq: 1n,
    }]

    let resolvePage!: (value: {
      messages: Array<{
        id: string
        conversation_id: string
        sender_id: string
        sender_name: string
        body: string
        channel_seq: string
        thread_seq: string
        thread_root_message_id: string
        mention_everyone: boolean
        created_at: string
      }>
      has_more: boolean
      page_size: number
      next_before_channel_seq: string
    }) => void

    const pagePromise = new Promise<{
      messages: Array<{
        id: string
        conversation_id: string
        sender_id: string
        sender_name: string
        body: string
        channel_seq: string
        thread_seq: string
        thread_root_message_id: string
        mention_everyone: boolean
        created_at: string
      }>
      has_more: boolean
      page_size: number
      next_before_channel_seq: string
    }>((resolve) => {
      resolvePage = resolve
    })

    chatApiMocks.listConversationMessages.mockImplementation(() => pagePromise)

    const pending = chat.ensureConversationHistory('channel-1')
    expect(chat.isConversationInitialLoading('channel-1')).toBe(true)

    resolvePage({
      messages: [{
        id: 'message-1',
        conversation_id: 'channel-1',
        sender_id: 'user-2',
        sender_name: 'Bob',
        body: 'history',
        channel_seq: '1',
        thread_seq: '0',
        thread_root_message_id: '',
        mention_everyone: false,
        created_at: '2026-03-06T00:00:00Z',
      }],
      has_more: false,
      page_size: 50,
      next_before_channel_seq: '',
    })

    await pending
    expect(chat.isConversationInitialLoading('channel-1')).toBe(false)
  })

  it('loads active conversation history after bootstrap restore', async () => {
    const chat = useChatStore()
    const ws = useWsStore()
    ws.setLiveSynced = vi.fn()
    ws.sendAck = vi.fn()
    chat.activeChannelId = 'channel-1'
    chatApiMocks.listConversationMessages.mockResolvedValue({
      messages: [
        {
          id: 'message-1',
          conversation_id: 'channel-1',
          sender_id: 'user-2',
          sender_name: 'Bob',
          body: 'restored history',
          channel_seq: '2',
          thread_seq: '0',
          thread_root_message_id: '',
          mention_everyone: false,
          created_at: '2026-03-06T00:00:00Z',
        },
      ],
      has_more: false,
      page_size: 50,
      next_before_channel_seq: '',
    })

    chat.handleBootstrapResponse(create(BootstrapResponseSchema, {
      snapshotSeq: 8n,
      userRole: 2,
      workspace: {
        workspaceId: 'workspace-1',
        workspaceName: 'Acme',
        selfUser: create(UserSummarySchema, { userId: 'user-1', displayName: 'Ada', avatarUrl: '' }),
        selfRole: 3,
      },
      conversations: [create(ConversationSummarySchema, {
        conversationId: 'channel-1',
        conversationType: 2,
        title: 'general',
        topic: '',
        isArchived: false,
        notificationLevel: NotificationLevel.ALL,
        lastMessageSeq: 2n,
        lastMessagePreview: 'restored history',
        memberCount: 2,
        presence: 3,
      })],
      unread: [],
      activeCalls: [],
      pendingInvites: [],
      notifications: [],
      hasMore: false,
      nextPageToken: '',
      bootstrapSessionId: 'session-1',
      pageIndex: 0,
      pageSizeEffective: 1,
      estimatedTotalConversations: 1,
      presence: [],
    }))
    await Promise.resolve()

    expect(chatApiMocks.listConversationMessages).toHaveBeenCalledWith('channel-1', undefined)
    expect(chat.messages['channel-1'][0].body).toBe('restored history')
  })

  it('loads older history with before cursor and deduplicates by message id', async () => {
    const chat = useChatStore()

    chatApiMocks.listConversationMessages
      .mockResolvedValueOnce({
        messages: [
          {
            id: 'message-2',
            conversation_id: 'channel-1',
            sender_id: 'user-2',
            sender_name: 'Bob',
            body: 'newer',
            channel_seq: '2',
            thread_seq: '0',
            thread_root_message_id: '',
            mention_everyone: false,
            created_at: '2026-03-06T00:00:01Z',
          },
          {
            id: 'message-3',
            conversation_id: 'channel-1',
            sender_id: 'user-2',
            sender_name: 'Bob',
            body: 'latest',
            channel_seq: '3',
            thread_seq: '0',
            thread_root_message_id: '',
            mention_everyone: false,
            created_at: '2026-03-06T00:00:02Z',
          },
        ],
        has_more: true,
        page_size: 2,
        next_before_channel_seq: '2',
      })
      .mockResolvedValueOnce({
        messages: [
          {
            id: 'message-1',
            conversation_id: 'channel-1',
            sender_id: 'user-2',
            sender_name: 'Bob',
            body: 'older',
            channel_seq: '1',
            thread_seq: '0',
            thread_root_message_id: '',
            mention_everyone: false,
            created_at: '2026-03-06T00:00:00Z',
          },
          {
            id: 'message-2',
            conversation_id: 'channel-1',
            sender_id: 'user-2',
            sender_name: 'Bob',
            body: 'newer duplicate',
            channel_seq: '2',
            thread_seq: '0',
            thread_root_message_id: '',
            mention_everyone: false,
            created_at: '2026-03-06T00:00:01Z',
          },
        ],
        has_more: false,
        page_size: 2,
        next_before_channel_seq: '',
      })

    chat.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      lastMessageSeq: 3n,
      notificationLevel: NotificationLevel.ALL,
    }]

    await chat.ensureConversationHistory('channel-1')
    const loaded = await chat.loadOlderConversationHistory('channel-1')

    expect(loaded).toBe(2)
    expect(chatApiMocks.listConversationMessages).toHaveBeenNthCalledWith(1, 'channel-1', undefined)
    expect(chatApiMocks.listConversationMessages).toHaveBeenNthCalledWith(2, 'channel-1', 2n)
    expect(chat.messages['channel-1'].map(item => item.id)).toEqual(['message-1', 'message-2', 'message-3'])
    expect(chat.messages['channel-1'][1].body).toBe('newer duplicate')
    expect(chat.conversationHasMoreHistory('channel-1')).toBe(false)
  })
})

describe('chatStore.onTaskStatusChanged', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('dispatches task_status_changed payload to registered handler via handleServerEvent', () => {
    const chat = useChatStore()
    const received: any[] = []
    chat.onTaskStatusChanged((evt) => received.push(evt))

    const updatedAt = { seconds: 1742299200n, nanos: 0 }
    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 0n,
      eventType: EventType.TASK_STATUS_CHANGED,
      payload: {
        case: 'taskStatusChanged',
        value: create(TaskStatusChangedEventSchema, {
          taskId: 'task-abc',
          publicId: 'BUG-42',
          fromStatusId: 'st-1',
          toStatusId: 'st-2',
          updatedBy: 'user-1',
          updatedAt,
        }),
      },
    }))

    expect(received).toHaveLength(1)
    expect(received[0].taskId).toBe('task-abc')
    expect(received[0].publicId).toBe('BUG-42')
    expect(received[0].fromStatusId).toBe('st-1')
    expect(received[0].toStatusId).toBe('st-2')
    expect(received[0].updatedBy).toBe('user-1')
    expect(received[0].updatedAt).toBe(new Date(1742299200 * 1000).toISOString())
  })

  it('stops dispatching after unsubscribe', () => {
    const chat = useChatStore()
    const received: any[] = []
    const unsub = chat.onTaskStatusChanged((evt) => received.push(evt))

    unsub()

    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 0n,
      eventType: EventType.TASK_STATUS_CHANGED,
      payload: {
        case: 'taskStatusChanged',
        value: create(TaskStatusChangedEventSchema, {
          taskId: 'task-xyz',
          publicId: 'BUG-99',
          fromStatusId: 'st-1',
          toStatusId: 'st-3',
          updatedBy: 'user-2',
        }),
      },
    }))

    expect(received).toHaveLength(0)
  })

  it('isolates handler failures so other handlers still receive the event', () => {
    const chat = useChatStore()
    const received: any[] = []
    chat.onTaskStatusChanged(() => { throw new Error('boom') })
    chat.onTaskStatusChanged((evt) => received.push(evt))

    chat.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 0n,
      eventType: EventType.TASK_STATUS_CHANGED,
      payload: {
        case: 'taskStatusChanged',
        value: create(TaskStatusChangedEventSchema, {
          taskId: 'task-1',
          publicId: 'BUG-1',
          fromStatusId: 'st-1',
          toStatusId: 'st-2',
          updatedBy: 'user-1',
        }),
      },
    }))

    expect(received).toHaveLength(1)
    expect(received[0].taskId).toBe('task-1')
  })

  it('rolls back saved state and shows a toast when save fails', async () => {
    const chat = useChatStore()
    chat.messages = {
      'channel-1': [buildMessage({ id: 'message-1', isSaved: false })],
    }
    chat.threadMessages = {
      'root-1': [buildMessage({ id: 'message-1', threadRootMessageId: 'root-1', isSaved: false })],
    }
    chatApiMocks.saveMessage.mockRejectedValueOnce(new Error('save failed'))

    await chat.toggleMessageSaved(chat.messages['channel-1'][0])

    expect(chat.messages['channel-1'][0].isSaved).toBe(false)
    expect(chat.threadMessages['root-1'][0].isSaved).toBe(false)
    expect(chat.toast?.message).toBe('save failed')
  })

  it('rolls back unsave failure, refreshes saved feed, and avoids unrelated message-list churn', async () => {
    const chat = useChatStore()
    const target = buildMessage({ id: 'message-1', isSaved: true })
    const other = buildMessage({ id: 'message-2', channelId: 'channel-2', isSaved: false })
    chat.messages = {
      'channel-1': [target],
      'channel-2': [other],
    }
    chat.threadMessages = {
      'root-1': [buildMessage({ id: 'message-1', threadRootMessageId: 'root-1', isSaved: true })],
    }
    chat.bootstrapped = true
    chat.savedMessagesLoaded = true as any
    chat.savedMessageItems = [{
      id: 'saved:message-1',
      conversationId: 'channel-1',
      conversationKind: 'channel',
      conversationVisibility: 'public',
      conversationTitle: 'general',
      messageId: 'message-1',
      senderId: 'user-2',
      senderName: 'Bob',
      body: 'hello',
      createdAt: '2026-03-06T00:00:00Z',
      savedAt: '2026-03-06T00:01:00Z',
    }] as any
    const unrelatedList = chat.messages['channel-2']
    chatApiMocks.unsaveMessage.mockRejectedValueOnce(new Error('unsave failed'))

    await chat.toggleMessageSaved(chat.messages['channel-1'][0])

    expect(chat.messages['channel-1'][0].isSaved).toBe(true)
    expect(chat.threadMessages['root-1'][0].isSaved).toBe(true)
    expect(chat.messages['channel-2']).toBe(unrelatedList)
    expect(chatApiMocks.listSavedMessages).toHaveBeenCalledTimes(1)
    expect(chat.toast?.message).toBe('unsave failed')
  })

  it('maps saved message bodies without notification escape decoding', async () => {
    const chat = useChatStore()
    chat.bootstrapped = true
    chatApiMocks.listSavedMessages.mockResolvedValueOnce({
      total_count: 1,
      items: [{
        id: 'saved:message-1',
        conversation_id: 'channel-1',
        conversation_kind: 'channel',
        conversation_visibility: 'public',
        conversation_title: 'general',
        message_id: 'message-1',
        sender_id: 'user-2',
        sender_name: 'Bob',
        body: String.raw`literal\nslash \\u0041`,
        created_at: '2026-03-06T00:00:00Z',
        saved_at: '2026-03-06T00:01:00Z',
      }],
    })

    await chat.refreshSavedMessages()

    expect(chat.savedMessageItems[0].body).toBe(String.raw`literal\nslash \\u0041`)
  })

  it('maps forwarded metadata from saved messages', async () => {
    const chat = useChatStore()
    chat.bootstrapped = true
    chatApiMocks.listSavedMessages.mockResolvedValueOnce({
      total_count: 1,
      items: [{
        id: 'saved:message-1',
        conversation_id: 'channel-1',
        conversation_kind: 'channel',
        conversation_visibility: 'public',
        conversation_title: 'general',
        message_id: 'message-1',
        sender_id: 'user-2',
        sender_name: 'Bob',
        body: 'forwarded body',
        forwarded_from: {
          message_id: 'source-1',
          sender_id: 'user-9',
          sender_name: 'Original Sender',
          conversation_kind: 'channel',
          conversation_title: 'general',
          thread_title: 'Launch thread',
        },
        created_at: '2026-03-06T00:00:00Z',
        saved_at: '2026-03-06T00:01:00Z',
      }],
    })

    await chat.refreshSavedMessages()

    expect(chat.savedMessageItems[0].forwardedFrom).toEqual({
      messageId: 'source-1',
      senderId: 'user-9',
      senderName: 'Original Sender',
      conversationKind: 'channel',
      conversationTitle: 'general',
      threadTitle: 'Launch thread',
    })
  })
})
