import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { NotificationLevel } from '@/shared/proto/packets_pb'
import { useChatStore } from '@/stores/chat'
import { pinnedDialogueId, usePinnedDialogsStore } from '@/stores/pinnedDialogs'

describe('pinnedDialogs store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('pins dm with user title and stable id', () => {
    const chat = useChatStore()
    const pinned = usePinnedDialogsStore()

    chat.directMessages = [{
      id: 'dm-1',
      userId: 'user-1',
      displayName: 'Alice Ford',
      avatarUrl: 'https://example.com/alice.png',
      presence: 'online',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]

    const id = pinned.ensureConversationPinned('dm-1')

    expect(id).toBe('dm:dm-1')
    expect(pinned.items).toEqual([{
      id: 'dm:dm-1',
      kind: 'dm',
      conversationId: 'dm-1',
      title: 'Alice Ford',
      avatarUrl: 'https://example.com/alice.png',
      userId: 'user-1',
    }])
    expect(pinned.activeId).toBe('dm:dm-1')
  })

  it('pins channel and thread without duplicates', () => {
    const chat = useChatStore()
    const pinned = usePinnedDialogsStore()

    chat.channels = [{
      id: 'channel-1',
      name: 'qa',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]

    pinned.ensureConversationPinned('channel-1')
    pinned.ensureConversationPinned('channel-1')
    pinned.ensureThreadPinned('channel-1', 'root-1')
    pinned.ensureThreadPinned('channel-1', 'root-1')

    expect(pinned.items.map(item => item.id)).toEqual([
      'channel:channel-1',
      'thread:channel-1:root-1',
    ])
    expect(pinned.items[0].title).toBe('qa')
    expect(pinned.items[1].title).toBe('qa')
  })

  it('unpins active item and selects previous neighbor', () => {
    const chat = useChatStore()
    const pinned = usePinnedDialogsStore()

    chat.directMessages = [{
      id: 'dm-1',
      userId: 'user-1',
      displayName: 'Alice',
      presence: 'online',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chat.channels = [{
      id: 'channel-1',
      name: 'qa',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]

    pinned.ensureConversationPinned('dm-1')
    pinned.ensureConversationPinned('channel-1')
    pinned.ensureThreadPinned('channel-1', 'root-1')

    pinned.unpin('thread:channel-1:root-1')

    expect(pinned.activeId).toBe('channel:channel-1')
  })

  it('unpins first active item and selects next surviving item', () => {
    const chat = useChatStore()
    const pinned = usePinnedDialogsStore()

    chat.directMessages = [{
      id: 'dm-1',
      userId: 'user-1',
      displayName: 'Alice',
      presence: 'online',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chat.channels = [{
      id: 'channel-1',
      name: 'qa',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]

    pinned.ensureConversationPinned('dm-1')
    pinned.ensureConversationPinned('channel-1')
    pinned.activate('dm:dm-1')
    pinned.unpin('dm:dm-1')

    expect(pinned.activeId).toBe('channel:channel-1')
  })

  it('clears active id when removing only pinned item', () => {
    const chat = useChatStore()
    const pinned = usePinnedDialogsStore()

    chat.channels = [{
      id: 'channel-1',
      name: 'qa',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]

    pinned.ensureConversationPinned('channel-1')
    pinned.unpin('channel:channel-1')

    expect(pinned.items).toEqual([])
    expect(pinned.activeId).toBeNull()
  })

  it('activate ignores unknown ids', () => {
    const pinned = usePinnedDialogsStore()
    pinned.activeId = 'missing'

    pinned.activate('still-missing')

    expect(pinned.activeId).toBe('missing')
  })

  it('returns null for unknown conversation ids', () => {
    const pinned = usePinnedDialogsStore()
    expect(pinned.ensureConversationPinned('missing')).toBeNull()
  })

  it('clearAll resets items and active id', () => {
    const chat = useChatStore()
    const pinned = usePinnedDialogsStore()

    chat.directMessages = [{
      id: 'dm-1',
      userId: 'user-1',
      displayName: 'Alice Ford',
      presence: 'online',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]

    pinned.ensureConversationPinned('dm-1')
    expect(pinned.activeId).toBe(pinnedDialogueId('dm', 'dm-1'))

    pinned.clearAll()

    expect(pinned.items).toEqual([])
    expect(pinned.activeId).toBeNull()
  })

  it('deactivate hides active panel without unpinning items', () => {
    const chat = useChatStore()
    const pinned = usePinnedDialogsStore()

    chat.directMessages = [{
      id: 'dm-1',
      userId: 'user-1',
      displayName: 'Alice Ford',
      presence: 'online',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]

    pinned.ensureConversationPinned('dm-1')
    pinned.deactivate()

    expect(pinned.items.map(item => item.id)).toEqual(['dm:dm-1'])
    expect(pinned.activeId).toBeNull()
  })
})
