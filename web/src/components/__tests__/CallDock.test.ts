import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { Track } from 'livekit-client'
import { NotificationLevel } from '@/shared/proto/packets_pb'
import CallDock from '@/components/CallDock.vue'
import { useAuthStore } from '@/stores/auth'
import { useChatStore } from '@/stores/chat'
import { useCallStore } from '@/stores/call'
import { useWsStore } from '@/stores/ws'
import { resolveScreenAnnotationStrokeColor } from '@/utils/color'

const chatApiMocks = vi.hoisted(() => ({
  listDmCandidates: vi.fn(),
  listMessageReactionUsers: vi.fn(),
  listSavedMessages: vi.fn(),
  saveMessage: vi.fn(),
  unsaveMessage: vi.fn(),
}))

vi.mock('@/services/http/chatApi', () => ({
  listDmCandidates: chatApiMocks.listDmCandidates,
  listMessageReactionUsers: chatApiMocks.listMessageReactionUsers,
  listSavedMessages: chatApiMocks.listSavedMessages,
  saveMessage: chatApiMocks.saveMessage,
  unsaveMessage: chatApiMocks.unsaveMessage,
}))

async function flushAll() {
  await Promise.resolve()
  await nextTick()
}

function dispatchPointerEvent(
  target: EventTarget,
  type: string,
  clientX: number,
  clientY: number,
  pointerId = 1,
) {
  const PointerEventCtor = window.PointerEvent ?? MouseEvent
  const event = new PointerEventCtor(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    isPrimary: true,
    button: 0,
  })
  if (!(event instanceof PointerEventCtor) || window.PointerEvent == null) {
    Object.defineProperty(event, 'pointerId', { value: pointerId })
    Object.defineProperty(event, 'isPrimary', { value: true })
  }
  target.dispatchEvent(event)
}

function setViewportSize(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: width,
  })
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: height,
  })
}

function mockElementRect(element: HTMLElement, rect: { width: number; height: number }) {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: rect.width,
      bottom: rect.height,
      width: rect.width,
      height: rect.height,
      toJSON: () => ({}),
    }),
  })
  Object.defineProperty(element, 'clientWidth', {
    configurable: true,
    value: rect.width,
  })
  Object.defineProperty(element, 'clientHeight', {
    configurable: true,
    value: rect.height,
  })
}

function createVideoTrack(sid: string) {
  return {
    sid,
    kind: 'video',
    attach: vi.fn((el?: HTMLMediaElement) => el ?? document.createElement('video')),
    detach: vi.fn(() => [] as HTMLMediaElement[]),
  }
}

function createLocalShareRoom() {
  const localScreenTrack = createVideoTrack('local-screen-track')
  const localScreenPublication = {
    trackSid: localScreenTrack.sid,
    source: Track.Source.ScreenShare,
    track: localScreenTrack,
    isMuted: false,
    isSubscribed: true,
    setSubscribed: vi.fn(),
  }
  return {
    trackSid: localScreenTrack.sid,
    room: {
      localParticipant: {
        sid: 'local-sid',
        identity: 'user-a',
        name: 'Ada',
        getTrackPublication: (source: Track.Source) => (
          source === Track.Source.ScreenShare ? localScreenPublication : undefined
        ),
        videoTrackPublications: new Map([['local-screen', localScreenPublication]]),
        audioTrackPublications: new Map(),
      },
      remoteParticipants: new Map(),
    },
  }
}

function createRemoteShareRoom(options?: {
  trackSid?: string
  participantSid?: string
  participantIdentity?: string
  participantName?: string
}) {
  const trackSid = options?.trackSid ?? 'remote-screen-track'
  const participantSid = options?.participantSid ?? 'remote-sid'
  const participantIdentity = options?.participantIdentity ?? 'user-b'
  const participantName = options?.participantName ?? 'Bob'
  const remoteScreenTrack = createVideoTrack(trackSid)
  const remoteScreenPublication = {
    trackSid: remoteScreenTrack.sid,
    source: Track.Source.ScreenShare,
    track: remoteScreenTrack,
    isMuted: false,
    isSubscribed: true,
    setSubscribed: vi.fn(),
  }
  return {
    trackSid: remoteScreenTrack.sid,
    remoteScreenPublication,
    room: {
      localParticipant: {
        sid: 'local-sid',
        identity: 'user-a',
        name: 'Ada',
        getTrackPublication: () => undefined,
        videoTrackPublications: new Map(),
        audioTrackPublications: new Map(),
      },
      remoteParticipants: new Map([
        [participantSid, {
          sid: participantSid,
          identity: participantIdentity,
          name: participantName,
          getTrackPublication: () => undefined,
          videoTrackPublications: new Map([['remote-screen', remoteScreenPublication]]),
          audioTrackPublications: new Map(),
        }],
      ]),
    },
  }
}

function seedCallUserState() {
  const authStore = useAuthStore()
  const chatStore = useChatStore()
  authStore.user = {
    id: 'user-a',
    email: 'ada@example.com',
    displayName: 'Ada',
    avatarUrl: '',
    role: 'member',
  }
  chatStore.workspace = {
    id: 'workspace-1',
    name: 'Acme',
    selfUserId: 'user-a',
    selfDisplayName: 'Ada',
    selfAvatarUrl: '',
    selfRole: 'member',
  }
}

type AnnotationPayload = {
  version: 1
  kind: 'segment'
  shareTrackSid: string
  senderIdentity: string
  strokeId: string
  seq: number
  from: { x: number; y: number }
  to: { x: number; y: number }
  sentAtMs: number
  receivedAtMs: number
}

function installAnnotationEmitter(callStore: ReturnType<typeof useCallStore>) {
  let listener: ((event: AnnotationPayload) => void) | undefined
  callStore.onScreenAnnotation = vi.fn((nextListener: (event: AnnotationPayload) => void) => {
    listener = nextListener
    return () => {
      listener = undefined
    }
  }) as unknown as typeof callStore.onScreenAnnotation
  return (event: AnnotationPayload) => {
    listener?.(event)
  }
}

describe('CallDock raised hands', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('toggles numbered hand indicators and renumbers the remaining participant', async () => {
    seedCallUserState()
    const chatStore = useChatStore()
    const callStore = useCallStore()
    callStore.connected = true
    callStore.activeConversationId = 'channel-1'
    callStore.activeCallId = 'call-1'
    callStore.room = {
      localParticipant: {
        sid: 'local-sid',
        identity: 'user-a',
        name: 'Ada',
        getTrackPublication: () => undefined,
        videoTrackPublications: new Map(),
        audioTrackPublications: new Map(),
      },
      remoteParticipants: new Map([['remote-sid', {
        sid: 'remote-sid',
        identity: 'user-b',
        name: 'Bob',
        getTrackPublication: () => undefined,
        videoTrackPublications: new Map(),
        audioTrackPublications: new Map(),
      }]]),
    } as never
    chatStore.activeCalls = [{
      id: 'call-1',
      conversationId: 'channel-1',
      status: '1',
      participantCount: 2,
      raisedHands: [
        { userId: 'user-a', position: 1 },
        { userId: 'user-b', position: 2 },
      ],
    }]

    const wrapper = mount(CallDock, {
      global: { stubs: { UserAvatar: true } },
    })
    await flushAll()

    expect(wrapper.get('[data-testid="calldock-local-hand-1"]').attributes('aria-label')).toBe('Raised hand position 1')
    expect(wrapper.get('[data-testid="calldock-remote-hand-remote-sid-2"]').text()).toContain('2')
    const control = wrapper.get('[data-testid="calldock-raise-hand"]')
    expect(control.attributes('title')).toBe('Lower hand')
    expect(control.attributes('aria-pressed')).toBe('true')

    const requestSpy = vi.spyOn(useWsStore(), 'requestSetCallHandRaised').mockResolvedValue({
      callId: 'call-1',
      conversationId: 'channel-1',
      raisedHands: [{ userId: 'user-b', position: 1 }],
    } as never)
    await control.trigger('click')
    await flushAll()

    expect(requestSpy).toHaveBeenLastCalledWith('call-1', false)
    expect(wrapper.find('[data-testid="calldock-local-hand-1"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="calldock-remote-hand-remote-sid-1"]').text()).toContain('1')
    expect(control.attributes('title')).toBe('Raise hand')
    expect(control.attributes('aria-pressed')).toBe('false')

    requestSpy.mockResolvedValue({
      callId: 'call-1',
      conversationId: 'channel-1',
      raisedHands: [{ userId: 'user-b', position: 1 }, { userId: 'user-a', position: 2 }],
    } as never)
    await control.trigger('click')
    await flushAll()

    expect(requestSpy).toHaveBeenLastCalledWith('call-1', true)
    expect(wrapper.get('[data-testid="calldock-local-hand-2"]').text()).toContain('2')
    expect(control.attributes('title')).toBe('Lower hand')
    expect(control.attributes('aria-pressed')).toBe('true')

    wrapper.unmount()
  })
})

describe('CallDock reactions', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('opens the reaction picker, sends the selected emoji, and renders reactions on the matching tiles', async () => {
    seedCallUserState()
    const callStore = useCallStore()
    callStore.connected = true
    callStore.activeConversationId = 'channel-1'
    callStore.room = {
      localParticipant: {
        sid: 'local-sid',
        identity: 'user-a',
        name: 'Ada',
        getTrackPublication: () => undefined,
        videoTrackPublications: new Map(),
        audioTrackPublications: new Map(),
      },
      remoteParticipants: new Map([['remote-sid', {
        sid: 'remote-sid',
        identity: 'user-b',
        name: 'Bob',
        getTrackPublication: () => undefined,
        videoTrackPublications: new Map(),
        audioTrackPublications: new Map(),
      }]]),
    } as never
    callStore.reactionsByParticipantId = {
      'user-a': {
        version: 1,
        kind: 'reaction',
        emoji: '👍',
        senderSessionId: 'local-session',
        sequence: 1,
        reactionId: 'local-reaction',
        sentAtMs: 1,
        expiresAtMs: 4_001,
      },
      'user-b': {
        version: 1,
        kind: 'reaction',
        emoji: '🎉',
        senderSessionId: 'remote-session',
        sequence: 1,
        reactionId: 'remote-reaction',
        sentAtMs: 1,
        expiresAtMs: 4_001,
      },
    }
    callStore.sendCallReaction = vi.fn().mockResolvedValue(undefined)

    const wrapper = mount(CallDock, {
      global: { stubs: { UserAvatar: true } },
    })
    await flushAll()

    expect(wrapper.get('[data-testid="calldock-local-reaction"]').attributes('aria-label')).toBe('Ada reacted 👍')
    expect(wrapper.get('[data-testid="calldock-remote-reaction-remote-sid"]').attributes('aria-label')).toBe('Bob reacted 🎉')

    const reactionsToggle = wrapper.get('[data-testid="calldock-reactions-toggle"]')
    await reactionsToggle.trigger('click')
    await flushAll()
    expect(reactionsToggle.attributes('aria-expanded')).toBe('true')
    expect(wrapper.find('[data-testid="calldock-reactions-picker"]').exists()).toBe(true)

    await wrapper.get('button[aria-label="Send laughing reaction"]').trigger('click')
    await flushAll()
    expect(callStore.sendCallReaction).toHaveBeenCalledWith('😂')
    expect(wrapper.find('[data-testid="calldock-reactions-picker"]').exists()).toBe(false)

    await wrapper.get('[data-testid="calldock-remote-tile-remote-sid"]').get('button[title="Pin to full view"]').trigger('click')
    await flushAll()
    expect(wrapper.get('[data-testid="calldock-pinned-reaction-remote-sid"]').attributes('aria-label')).toBe('Bob reacted 🎉')

    wrapper.unmount()
  })
})

describe('CallDock invite modal', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('loads candidates and sends invite request from the call window', async () => {
    const authStore = useAuthStore()
    const chatStore = useChatStore()
    const callStore = useCallStore()

    authStore.user = {
      id: 'user-1',
      email: 'ada@example.com',
      displayName: 'Ada',
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

    callStore.connected = true
    callStore.minimized = false
    callStore.activeConversationId = 'channel-1'
    callStore.inviteMembersToActiveCall = vi.fn().mockResolvedValue({
      invitedUserIds: ['user-2'],
      skippedUserIds: ['user-3'],
    })

    chatApiMocks.listDmCandidates.mockResolvedValue([
      { user_id: 'user-2', display_name: 'Bob', email: 'bob@example.com', avatar_url: '' },
      { user_id: 'user-3', display_name: 'Eve', email: 'eve@example.com', avatar_url: '' },
    ])

    const wrapper = mount(CallDock, {
      attachTo: document.body,
      global: {
        stubs: {
          UserAvatar: true,
        },
      },
    })

    await wrapper.get('[data-testid="calldock-invite-button"]').trigger('click')
    await flushAll()

    expect(chatApiMocks.listDmCandidates).toHaveBeenCalledTimes(1)
    const modal = document.body.querySelector('[data-testid="calldock-invite-modal"]') as HTMLElement | null
    expect(modal).not.toBeNull()
    const modalText = modal?.textContent ?? ''
    expect(modalText).toContain('Bob')
    expect(modalText).toContain('Eve')
    expect(modalText).not.toContain('ada@example.com')

    const searchInput = document.body.querySelector('[data-testid="calldock-invite-search"]') as HTMLInputElement | null
    expect(searchInput).not.toBeNull()
    searchInput!.value = 'bob'
    searchInput!.dispatchEvent(new Event('input'))
    await flushAll()

    expect(document.body.querySelector('[data-testid="calldock-invite-candidate-user-2"]')).not.toBeNull()
    expect(document.body.querySelector('[data-testid="calldock-invite-candidate-user-3"]')).toBeNull()

    const candidate2 = document.body.querySelector('[data-testid="calldock-invite-candidate-user-2"]') as HTMLElement | null
    expect(candidate2).not.toBeNull()
    await candidate2?.click()
    await flushAll()

    searchInput!.value = 'eve@'
    searchInput!.dispatchEvent(new Event('input'))
    await flushAll()

    expect(document.body.querySelector('[data-testid="calldock-invite-candidate-user-2"]')).toBeNull()
    const candidate3 = document.body.querySelector('[data-testid="calldock-invite-candidate-user-3"]') as HTMLElement | null
    expect(candidate3).not.toBeNull()
    await candidate3?.click()
    await flushAll()

    const sendInvitesButton = document.body.querySelector('[data-testid="calldock-send-invites"]') as HTMLElement | null
    expect(sendInvitesButton).not.toBeNull()
    await sendInvitesButton?.click()
    await flushAll()

    expect(callStore.inviteMembersToActiveCall).toHaveBeenCalledWith(['user-2', 'user-3'])
    expect(document.body.querySelector('[data-testid="calldock-invite-modal"]')).toBeNull()

    wrapper.unmount()
  })

  it('confirms before inviting a selected user who is already in another call', async () => {
    const authStore = useAuthStore()
    const chatStore = useChatStore()
    const callStore = useCallStore()

    authStore.user = {
      id: 'user-1',
      email: 'ada@example.com',
      displayName: 'Ada',
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
    chatStore.userCallPresenceByUserId = { 'user-2': 1 }

    callStore.connected = true
    callStore.minimized = false
    callStore.activeConversationId = 'channel-1'
    callStore.inviteMembersToActiveCall = vi.fn().mockResolvedValue({
      invitedUserIds: ['user-2'],
      skippedUserIds: [],
    })

    chatApiMocks.listDmCandidates.mockResolvedValue([
      { user_id: 'user-2', display_name: 'Bob', email: 'bob@example.com', avatar_url: '' },
    ])

    const wrapper = mount(CallDock, {
      attachTo: document.body,
      global: {
        stubs: {
          UserAvatar: true,
        },
      },
    })

    await wrapper.get('[data-testid="calldock-invite-button"]').trigger('click')
    await flushAll()

    const candidate = document.body.querySelector('[data-testid="calldock-invite-candidate-user-2"]') as HTMLElement | null
    expect(candidate).not.toBeNull()
    candidate?.click()
    await flushAll()

    const sendInvitesButton = document.body.querySelector('[data-testid="calldock-send-invites"]') as HTMLElement | null
    expect(sendInvitesButton).not.toBeNull()
    sendInvitesButton?.click()
    await flushAll()

    const dialog = document.body.querySelector('[data-testid="busy-call-confirm-dialog"]') as HTMLElement | null
    expect(dialog).not.toBeNull()
    expect(dialog?.textContent).toContain('Bob')
    expect(callStore.inviteMembersToActiveCall).not.toHaveBeenCalled()

    document.body.querySelector<HTMLButtonElement>('[data-testid="busy-call-confirm-confirm"]')?.click()
    await flushAll()

    expect(callStore.inviteMembersToActiveCall).toHaveBeenCalledWith(['user-2'])
    wrapper.unmount()
  })

  it('restores from maximized mode when Escape is pressed', async () => {
    const authStore = useAuthStore()
    const chatStore = useChatStore()
    const callStore = useCallStore()

    authStore.user = {
      id: 'user-1',
      email: 'ada@example.com',
      displayName: 'Ada',
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

    callStore.connected = true
    callStore.minimized = false

    const wrapper = mount(CallDock, {
      attachTo: document.body,
      global: {
        stubs: {
          UserAvatar: true,
        },
      },
    })

    await wrapper.get('button[title="Maximize"]').trigger('click')
    await flushAll()
    expect(wrapper.find('button[title="Restore"]').exists()).toBe(true)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushAll()
    expect(wrapper.find('button[title="Maximize"]').exists()).toBe(true)

    wrapper.unmount()
  })
})

describe('CallDock drag behavior', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    setViewportSize(900, 700)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  })

  it('drags the expanded dock by its header', async () => {
    const callStore = useCallStore()
    callStore.connected = true
    callStore.minimized = false

    const wrapper = mount(CallDock, {
      attachTo: document.body,
      global: {
        stubs: {
          UserAvatar: true,
        },
      },
    })
    await flushAll()

    const dock = wrapper.get('[data-testid="calldock-expanded-root"]').element as HTMLElement
    mockElementRect(dock, { width: 240, height: 220 })

    const handle = wrapper.get('[data-testid="calldock-expanded-drag-handle"]').element
    dispatchPointerEvent(handle, 'pointerdown', 680, 500, 1)
    dispatchPointerEvent(window, 'pointermove', 220, 180, 1)
    dispatchPointerEvent(window, 'pointerup', 220, 180, 1)
    await flushAll()

    expect(dock.style.left).toBe('200px')
    expect(dock.style.top).toBe('160px')

    wrapper.unmount()
  })

  it('defaults the expanded dock to the bottom-right corner', async () => {
    const callStore = useCallStore()
    callStore.connected = true
    callStore.minimized = false

    const wrapper = mount(CallDock, {
      attachTo: document.body,
      global: {
        stubs: {
          UserAvatar: true,
        },
      },
    })
    await flushAll()

    const dock = wrapper.get('[data-testid="calldock-expanded-root"]').element as HTMLElement

    expect(dock.style.right).toBe('0px')
    expect(dock.style.bottom).toBe('0px')
    expect(dock.style.left).toBe('')
    expect(dock.style.top).toBe('')

    wrapper.unmount()
  })

  it('keeps separate runtime positions for expanded and compacted view', async () => {
    const callStore = useCallStore()
    callStore.connected = true
    callStore.minimized = false

    const wrapper = mount(CallDock, {
      attachTo: document.body,
      global: {
        stubs: {
          UserAvatar: true,
        },
      },
    })
    await flushAll()

    const expandedDock = wrapper.get('[data-testid="calldock-expanded-root"]').element as HTMLElement
    mockElementRect(expandedDock, { width: 240, height: 220 })
    dispatchPointerEvent(wrapper.get('[data-testid="calldock-expanded-drag-handle"]').element, 'pointerdown', 680, 500, 1)
    dispatchPointerEvent(window, 'pointermove', 260, 220, 1)
    dispatchPointerEvent(window, 'pointerup', 260, 220, 1)
    await flushAll()

    expect(expandedDock.style.left).toBe('240px')
    expect(expandedDock.style.top).toBe('200px')

    await wrapper.get('button[title="Minimize"]').trigger('click')
    await flushAll()

    const minimizedDock = wrapper.get('[data-testid="calldock-minimized-root"]').element as HTMLElement
    mockElementRect(minimizedDock, { width: 160, height: 44 })
    dispatchPointerEvent(minimizedDock, 'pointerdown', 760, 670, 2)
    dispatchPointerEvent(window, 'pointermove', 120, 140, 2)
    dispatchPointerEvent(window, 'pointerup', 120, 140, 2)
    await flushAll()

    expect(minimizedDock.style.left).toBe('100px')
    expect(minimizedDock.style.top).toBe('126px')

    await wrapper.get('[data-testid="calldock-minimized-expand"]').trigger('click')
    await flushAll()

    const restoredExpandedDock = wrapper.get('[data-testid="calldock-expanded-root"]').element as HTMLElement
    expect(restoredExpandedDock.style.left).toBe('240px')
    expect(restoredExpandedDock.style.top).toBe('200px')

    wrapper.unmount()
  })

  it('clamps the dock inside the viewport while dragging and on resize', async () => {
    const callStore = useCallStore()
    callStore.connected = true
    callStore.minimized = false

    const wrapper = mount(CallDock, {
      attachTo: document.body,
      global: {
        stubs: {
          UserAvatar: true,
        },
      },
    })
    await flushAll()

    const dock = wrapper.get('[data-testid="calldock-expanded-root"]').element as HTMLElement
    mockElementRect(dock, { width: 240, height: 220 })

    const handle = wrapper.get('[data-testid="calldock-expanded-drag-handle"]').element
    dispatchPointerEvent(handle, 'pointerdown', 680, 500, 1)
    dispatchPointerEvent(window, 'pointermove', -200, -120, 1)
    dispatchPointerEvent(window, 'pointerup', -200, -120, 1)
    await flushAll()

    expect(dock.style.left).toBe('0px')
    expect(dock.style.top).toBe('0px')

    dispatchPointerEvent(handle, 'pointerdown', 10, 10, 2)
    dispatchPointerEvent(window, 'pointermove', 1200, 1200, 2)
    dispatchPointerEvent(window, 'pointerup', 1200, 1200, 2)
    await flushAll()

    expect(dock.style.left).toBe('660px')
    expect(dock.style.top).toBe('480px')

    setViewportSize(500, 360)
    window.dispatchEvent(new Event('resize'))
    await flushAll()

    expect(dock.style.left).toBe('260px')
    expect(dock.style.top).toBe('140px')

    wrapper.unmount()
  })

  it('preserves the expanded dock position after maximize and restore', async () => {
    const callStore = useCallStore()
    callStore.connected = true
    callStore.minimized = false

    const wrapper = mount(CallDock, {
      attachTo: document.body,
      global: {
        stubs: {
          UserAvatar: true,
        },
      },
    })
    await flushAll()

    const dock = wrapper.get('[data-testid="calldock-expanded-root"]').element as HTMLElement
    const normalRect = { width: 240, height: 220 }
    const maximizedRect = { width: 900, height: 700 }
    let currentRect = normalRect
    Object.defineProperty(dock, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: currentRect.width,
        bottom: currentRect.height,
        width: currentRect.width,
        height: currentRect.height,
        toJSON: () => ({}),
      }),
    })

    dispatchPointerEvent(wrapper.get('[data-testid="calldock-expanded-drag-handle"]').element, 'pointerdown', 680, 500, 1)
    dispatchPointerEvent(window, 'pointermove', 260, 220, 1)
    dispatchPointerEvent(window, 'pointerup', 260, 220, 1)
    await flushAll()

    expect(dock.style.left).toBe('240px')
    expect(dock.style.top).toBe('200px')

    currentRect = maximizedRect
    await wrapper.get('button[title="Maximize"]').trigger('click')
    await flushAll()

    const restorePromise = wrapper.get('button[title="Restore"]').trigger('click')
    currentRect = normalRect
    await restorePromise
    await flushAll()

    expect(dock.style.left).toBe('240px')
    expect(dock.style.top).toBe('200px')

    wrapper.unmount()
  })

  it('does not start a drag when compacted controls are clicked', async () => {
    const callStore = useCallStore()
    callStore.connected = true
    callStore.minimized = true

    const wrapper = mount(CallDock, {
      attachTo: document.body,
      global: {
        stubs: {
          UserAvatar: true,
        },
      },
    })
    await flushAll()

    const minimizedDock = wrapper.get('[data-testid="calldock-minimized-root"]').element as HTMLElement
    mockElementRect(minimizedDock, { width: 160, height: 44 })
    expect(minimizedDock.style.left).toBe('')

    const expandButton = wrapper.get('[data-testid="calldock-minimized-expand"]').element
    dispatchPointerEvent(expandButton, 'pointerdown', 760, 670, 1)
    dispatchPointerEvent(window, 'pointerup', 760, 670, 1)
    await flushAll()

    expect(minimizedDock.style.left).toBe('')
    await wrapper.get('[data-testid="calldock-minimized-expand"]').trigger('click')
    await flushAll()
    expect(callStore.minimized).toBe(false)

    wrapper.unmount()
  })
})

describe('CallDock remote share presentation', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('switches between full-stage and user-card remote share views for the local viewer', async () => {
    const callStore = useCallStore()
    const remoteShare = createRemoteShareRoom()
    seedCallUserState()

    callStore.connected = true
    callStore.minimized = false
    callStore.room = remoteShare.room as never
    callStore.mediaVersion = 1

    const wrapper = mount(CallDock, {
      attachTo: document.body,
      global: {
        stubs: {
          UserAvatar: true,
        },
      },
    })
    await flushAll()

    await wrapper.get('button[title="Maximize"]').trigger('click')
    await flushAll()
    expect(wrapper.find('button[title="Restore"]').exists()).toBe(true)

    const stage = wrapper.get('[data-testid="calldock-remote-share-stage"]').element as HTMLVideoElement
    expect(stage.style.display).not.toBe('none')
    expect(wrapper.find('[data-testid="calldock-remote-share-stage-toggle"]').exists()).toBe(true)

    await wrapper.get('[data-testid="calldock-remote-share-stage-toggle"]').trigger('click')
    await flushAll()

    expect(wrapper.find('button[title="Restore"]').exists()).toBe(true)
    expect(stage.style.display).toBe('none')
    expect(wrapper.find('[data-testid="calldock-remote-share-badge-remote-sid"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="calldock-remote-share-stage-toggle"]').exists()).toBe(false)

    await wrapper.get('[data-testid="calldock-remote-share-tile-toggle-remote-sid"]').trigger('click')
    await flushAll()

    expect(stage.style.display).not.toBe('none')
    expect(wrapper.find('[data-testid="calldock-remote-share-badge-remote-sid"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="calldock-remote-share-stage-toggle"]').exists()).toBe(true)

    wrapper.unmount()
  })

  it('renders a remote share after the track becomes available on a mediaVersion update', async () => {
    const callStore = useCallStore()
    const remoteShare = createRemoteShareRoom()
    seedCallUserState()

    remoteShare.remoteScreenPublication.track = null as never
    callStore.connected = true
    callStore.minimized = false
    callStore.room = remoteShare.room as never
    callStore.mediaVersion = 1

    const wrapper = mount(CallDock, {
      attachTo: document.body,
      global: {
        stubs: {
          UserAvatar: true,
        },
      },
    })
    await flushAll()

    const stage = wrapper.get('[data-testid="calldock-remote-share-stage"]').element as HTMLVideoElement
    expect(stage.style.display).toBe('none')

    remoteShare.remoteScreenPublication.track = createVideoTrack('remote-screen-track-live') as never
    remoteShare.trackSid = 'remote-screen-track-live'
    callStore.mediaVersion = 2
    await flushAll()
    await flushAll()

    expect(stage.style.display).not.toBe('none')

    wrapper.unmount()
  })

  it('stops and resumes remote screen share locally from the stage overlay', async () => {
    const callStore = useCallStore()
    const remoteShare = createRemoteShareRoom()
    seedCallUserState()

    callStore.connected = true
    callStore.minimized = false
    callStore.room = remoteShare.room as never
    callStore.mediaVersion = 1

    const wrapper = mount(CallDock, {
      attachTo: document.body,
      global: {
        stubs: {
          UserAvatar: true,
        },
      },
    })
    await flushAll()

    expect(wrapper.find('[data-testid="calldock-remote-share-stage-stop"]').exists()).toBe(true)

    await wrapper.get('[data-testid="calldock-remote-share-stage-stop"]').trigger('click')
    await flushAll()

    expect(callStore.remoteScreenShareReceiveEnabled).toBe(false)
    expect(remoteShare.remoteScreenPublication.setSubscribed).toHaveBeenCalledWith(false)
    expect(wrapper.find('[data-testid="calldock-remote-share-stage-paused"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="calldock-remote-share-stage-resume"]').exists()).toBe(true)

    remoteShare.remoteScreenPublication.isSubscribed = false
    await wrapper.get('[data-testid="calldock-remote-share-stage-resume"]').trigger('click')
    await flushAll()

    expect(callStore.remoteScreenShareReceiveEnabled).toBe(true)
    expect(remoteShare.remoteScreenPublication.setSubscribed).toHaveBeenLastCalledWith(true)
    expect(wrapper.find('[data-testid="calldock-remote-share-stage-paused"]').exists()).toBe(false)
    expect((wrapper.get('[data-testid="calldock-remote-share-stage"]').element as HTMLVideoElement).style.display).not.toBe('none')

    wrapper.unmount()
  })

  it('keeps the paused frame visible when switching between stage and tile modes while paused', async () => {
    const callStore = useCallStore()
    const remoteShare = createRemoteShareRoom()
    seedCallUserState()

    const originalGetContext = HTMLCanvasElement.prototype.getContext
    const originalToDataURL = HTMLCanvasElement.prototype.toDataURL
    const canvasContextStub = {
      drawImage: vi.fn(),
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      save: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      restore: vi.fn(),
      globalAlpha: 1,
      lineCap: 'round',
      lineJoin: 'round',
      strokeStyle: '',
      lineWidth: 1,
    } as unknown as CanvasRenderingContext2D
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: vi.fn(() => canvasContextStub) as unknown as typeof HTMLCanvasElement.prototype.getContext,
    })
    Object.defineProperty(HTMLCanvasElement.prototype, 'toDataURL', {
      configurable: true,
      value: vi.fn(() => 'data:image/jpeg;base64,frozen-frame') as typeof HTMLCanvasElement.prototype.toDataURL,
    })

    try {
      callStore.connected = true
      callStore.minimized = false
      callStore.room = remoteShare.room as never
      callStore.mediaVersion = 1

      const wrapper = mount(CallDock, {
        attachTo: document.body,
        global: {
          stubs: {
            UserAvatar: true,
          },
        },
      })
      await flushAll()

      const stageVideo = wrapper.get('[data-testid="calldock-remote-share-stage"]').element as HTMLVideoElement
      Object.defineProperty(stageVideo, 'videoWidth', {
        configurable: true,
        value: 1280,
      })
      Object.defineProperty(stageVideo, 'videoHeight', {
        configurable: true,
        value: 720,
      })

      await wrapper.get('[data-testid="calldock-remote-share-stage-stop"]').trigger('click')
      await flushAll()

      expect(wrapper.get('[data-testid="calldock-remote-share-stage-paused-image"]').attributes('src')).toContain('frozen-frame')

      await wrapper.get('[data-testid="calldock-remote-share-stage-toggle"]').trigger('click')
      await flushAll()

      expect(wrapper.get('[data-testid="calldock-remote-share-tile-paused-image-remote-sid"]').attributes('src')).toContain('frozen-frame')

      wrapper.unmount()
    } finally {
      Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
        configurable: true,
        value: originalGetContext,
      })
      Object.defineProperty(HTMLCanvasElement.prototype, 'toDataURL', {
        configurable: true,
        value: originalToDataURL,
      })
    }
  })

  it('resets the local presentation mode when the remote share track changes', async () => {
    const callStore = useCallStore()
    seedCallUserState()

    callStore.connected = true
    callStore.minimized = false
    callStore.room = createRemoteShareRoom({ trackSid: 'remote-screen-track-a' }).room as never
    callStore.mediaVersion = 1

    const wrapper = mount(CallDock, {
      attachTo: document.body,
      global: {
        stubs: {
          UserAvatar: true,
        },
      },
    })
    await flushAll()

    await wrapper.get('[data-testid="calldock-remote-share-stage-toggle"]').trigger('click')
    await flushAll()
    expect(wrapper.find('[data-testid="calldock-remote-share-badge-remote-sid"]').exists()).toBe(true)

    callStore.room = createRemoteShareRoom({ trackSid: 'remote-screen-track-b' }).room as never
    callStore.mediaVersion = 2
    await flushAll()
    await flushAll()

    const stage = wrapper.get('[data-testid="calldock-remote-share-stage"]').element as HTMLVideoElement
    expect(stage.style.display).not.toBe('none')
    expect(wrapper.find('[data-testid="calldock-remote-share-badge-remote-sid"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="calldock-remote-share-stage-toggle"]').exists()).toBe(true)

    wrapper.unmount()
  })

  it('uses the remote tile pin-style button to switch back to full-stage shared screen', async () => {
    const callStore = useCallStore()
    const remoteShare = createRemoteShareRoom()
    seedCallUserState()

    callStore.connected = true
    callStore.minimized = false
    callStore.room = remoteShare.room as never
    callStore.mediaVersion = 1

    const wrapper = mount(CallDock, {
      attachTo: document.body,
      global: {
        stubs: {
          UserAvatar: true,
        },
      },
    })
    await flushAll()

    await wrapper.get('[data-testid="calldock-remote-share-stage-toggle"]').trigger('click')
    await flushAll()

    await wrapper.get('[data-testid="calldock-remote-share-tile-toggle-remote-sid"]').trigger('click')
    await flushAll()

    expect((wrapper.get('[data-testid="calldock-remote-share-stage"]').element as HTMLVideoElement).style.display).not.toBe('none')
    expect(wrapper.find('[data-testid="calldock-remote-share-badge-remote-sid"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="calldock-remote-share-stage-toggle"]').exists()).toBe(true)

    wrapper.unmount()
  })

  it('supports pausing and resuming the remote share from tile mode with a fallback placeholder', async () => {
    const callStore = useCallStore()
    const remoteShare = createRemoteShareRoom()
    seedCallUserState()

    callStore.connected = true
    callStore.minimized = false
    callStore.room = remoteShare.room as never
    callStore.mediaVersion = 1

    const wrapper = mount(CallDock, {
      attachTo: document.body,
      global: {
        stubs: {
          UserAvatar: true,
        },
      },
    })
    await flushAll()

    await wrapper.get('[data-testid="calldock-remote-share-stage-toggle"]').trigger('click')
    await flushAll()

    await wrapper.get('[data-testid="calldock-remote-share-tile-stop-remote-sid"]').trigger('click')
    await flushAll()

    expect(callStore.remoteScreenShareReceiveEnabled).toBe(false)
    expect(wrapper.find('[data-testid="calldock-remote-share-tile-paused-remote-sid"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="calldock-remote-share-badge-remote-sid"]').text()).toContain('paused')

    remoteShare.remoteScreenPublication.isSubscribed = false
    await wrapper.get('[data-testid="calldock-remote-share-tile-resume-remote-sid"]').trigger('click')
    await flushAll()

    expect(callStore.remoteScreenShareReceiveEnabled).toBe(true)
    expect(remoteShare.remoteScreenPublication.setSubscribed).toHaveBeenLastCalledWith(true)
    expect(wrapper.find('[data-testid="calldock-remote-share-tile-paused-remote-sid"]').exists()).toBe(false)

    wrapper.unmount()
  })

  it('keeps a new remote share blocked later in the same call until resumed', async () => {
    const callStore = useCallStore()
    seedCallUserState()

    const firstShare = createRemoteShareRoom({ trackSid: 'remote-screen-track-a' })
    callStore.connected = true
    callStore.minimized = false
    callStore.room = firstShare.room as never
    callStore.mediaVersion = 1

    const wrapper = mount(CallDock, {
      attachTo: document.body,
      global: {
        stubs: {
          UserAvatar: true,
        },
      },
    })
    await flushAll()

    await wrapper.get('[data-testid="calldock-remote-share-stage-stop"]').trigger('click')
    await flushAll()
    expect(callStore.remoteScreenShareReceiveEnabled).toBe(false)

    callStore.room = createRemoteShareRoom({ trackSid: 'remote-screen-track-b' }).room as never
    callStore.mediaVersion = 2
    await flushAll()
    await flushAll()

    expect(wrapper.find('[data-testid="calldock-remote-share-stage-paused"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="calldock-remote-share-stage-resume"]').exists()).toBe(true)
    expect((wrapper.get('[data-testid="calldock-remote-share-stage"]').element as HTMLVideoElement).style.display).toBe('none')

    wrapper.unmount()
  })
})

describe('CallDock input device selector', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('shows input selector and switches active microphone device from the call window', async () => {
    const callStore = useCallStore()
    callStore.connected = true
    callStore.minimized = false
    callStore.switchInputDevice = vi.fn().mockResolvedValue(undefined)

    const originalMediaDevices = navigator.mediaDevices
    const addEventListener = vi.fn()
    const removeEventListener = vi.fn()
    const enumerateDevices = vi.fn().mockResolvedValue([
      { kind: 'audioinput', deviceId: 'mic-1', label: 'Built-in Mic' },
      { kind: 'audioinput', deviceId: 'mic-2', label: 'USB Mic' },
      { kind: 'audiooutput', deviceId: 'spk-1', label: 'Speakers' },
    ])
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        enumerateDevices,
        addEventListener,
        removeEventListener,
      },
    })

    let wrapper: ReturnType<typeof mount> | null = null
    try {
      wrapper = mount(CallDock, {
        attachTo: document.body,
        global: {
          stubs: {
            UserAvatar: true,
          },
        },
      })

      await flushAll()

      const toggle = wrapper.get('[data-testid="calldock-input-device-toggle"]')
      await toggle.trigger('click')
      await flushAll()
      expect(wrapper.find('[data-testid="calldock-input-device-menu"]').exists()).toBe(true)

      const option = wrapper.get('[data-testid="calldock-input-device-option-mic-2"]')
      await option.trigger('click')
      await flushAll()

      expect(callStore.switchInputDevice).toHaveBeenCalledWith('mic-2')
      expect(enumerateDevices).toHaveBeenCalled()
    } finally {
      wrapper?.unmount()
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: originalMediaDevices,
      })
    }
  })
})

describe('CallDock screen annotation overlay', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  function setAnnotationSession(
    callStore: ReturnType<typeof useCallStore>,
    session: {
      active?: boolean
      sharerIdentity: string
      sharerPlatform: 'tauri' | 'pwa'
      shareType: 'monitor' | 'window' | 'browser'
    },
  ) {
    callStore.annotationSessionState = {
      version: 1,
      kind: 'session',
      active: session.active ?? true,
      sharerIdentity: session.sharerIdentity,
      sharerPlatform: session.sharerPlatform,
      shareType: session.shareType,
      shareLabel: session.shareType === 'monitor' ? 'Display 1' : 'Shared Window',
      sentAtMs: Date.now(),
    }
  }

  function seedUserState() {
    const authStore = useAuthStore()
    const chatStore = useChatStore()
    authStore.user = {
      id: 'user-a',
      email: 'ada@example.com',
      displayName: 'Ada',
      avatarUrl: '',
      role: 'member',
    }
    chatStore.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-a',
      selfDisplayName: 'Ada',
      selfAvatarUrl: '',
      selfRole: 'member',
    }
  }

  it('shows pen toggle on browser runtime too', async () => {
    ;(window as Window & { __TAURI__?: unknown }).__TAURI__ = undefined
    const callStore = useCallStore()
    callStore.connected = true
    callStore.minimized = false

    const wrapper = mount(CallDock, {
      attachTo: document.body,
      global: {
        stubs: {
          UserAvatar: true,
        },
      },
    })
    await flushAll()
    expect(wrapper.find('[data-testid="calldock-annotation-toggle"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('disables pen for the active sharer', async () => {
    const callStore = useCallStore()
    const localShare = createLocalShareRoom()
    seedUserState()

    callStore.connected = true
    callStore.screenShareEnabled = true
    callStore.room = localShare.room as never
    callStore.mediaVersion = 1
    setAnnotationSession(callStore, {
      sharerIdentity: 'user-a',
      sharerPlatform: 'tauri',
      shareType: 'monitor',
    })

    const wrapper = mount(CallDock, {
      attachTo: document.body,
      global: {
        stubs: {
          UserAvatar: true,
        },
      },
    })
    await flushAll()

    const overlay = wrapper.get('[data-testid="calldock-annotation-overlay"]')
    expect(overlay.attributes('data-surface-kind')).toBe('local')
    const drawToggle = wrapper.get('[data-testid="calldock-annotation-toggle"]').element as HTMLButtonElement
    expect(drawToggle.disabled).toBe(true)
    wrapper.unmount()
  })

  it('disables pen for everyone when sharer is non-tauri', async () => {
    const callStore = useCallStore()
    const remoteShare = createRemoteShareRoom()
    seedUserState()

    callStore.connected = true
    callStore.screenShareEnabled = false
    callStore.room = remoteShare.room as never
    callStore.mediaVersion = 1
    setAnnotationSession(callStore, {
      sharerIdentity: 'user-b',
      sharerPlatform: 'pwa',
      shareType: 'monitor',
    })

    const wrapper = mount(CallDock, {
      attachTo: document.body,
      global: {
        stubs: {
          UserAvatar: true,
        },
      },
    })
    await flushAll()

    const overlay = wrapper.get('[data-testid="calldock-annotation-overlay"]')
    expect(overlay.attributes('data-surface-kind')).toBe('remote')
    const drawToggle = wrapper.get('[data-testid="calldock-annotation-toggle"]').element as HTMLButtonElement
    expect(drawToggle.disabled).toBe(true)
    expect(drawToggle.title).toContain('not on Tauri desktop')
    wrapper.unmount()
  })

  it('does not render incoming segments on viewer call canvas', async () => {
    const callStore = useCallStore()
    const remoteShare = createRemoteShareRoom()
    const emitAnnotation = installAnnotationEmitter(callStore)
    seedUserState()

    callStore.connected = true
    callStore.screenShareEnabled = false
    callStore.room = remoteShare.room as never
    callStore.mediaVersion = 1
    setAnnotationSession(callStore, {
      sharerIdentity: 'user-b',
      sharerPlatform: 'tauri',
      shareType: 'monitor',
    })

    const wrapper = mount(CallDock, {
      attachTo: document.body,
      global: {
        stubs: {
          UserAvatar: true,
        },
      },
    })
    await flushAll()

    const overlay = wrapper.get('[data-testid="calldock-annotation-overlay"]')
    expect(overlay.attributes('data-surface-kind')).toBe('remote')

    emitAnnotation({
      version: 1,
      kind: 'segment',
      shareTrackSid: remoteShare.trackSid,
      senderIdentity: 'user-b',
      strokeId: 'stroke-3',
      seq: 0,
      from: { x: 0.15, y: 0.15 },
      to: { x: 0.5, y: 0.5 },
      sentAtMs: Date.now(),
      receivedAtMs: Date.now(),
    })
    await flushAll()
    expect(overlay.attributes('data-active-segments')).toBe('0')

    wrapper.unmount()
  })

  it('renders incoming segments for sharer preview-fallback sessions', async () => {
    const callStore = useCallStore()
    const localShare = createLocalShareRoom()
    const emitAnnotation = installAnnotationEmitter(callStore)
    seedUserState()

    callStore.connected = true
    callStore.screenShareEnabled = true
    callStore.room = localShare.room as never
    callStore.mediaVersion = 1
    setAnnotationSession(callStore, {
      sharerIdentity: 'user-a',
      sharerPlatform: 'tauri',
      shareType: 'window',
    })

    const wrapper = mount(CallDock, {
      attachTo: document.body,
      global: {
        stubs: {
          UserAvatar: true,
        },
      },
    })
    await flushAll()

    const overlay = wrapper.get('[data-testid="calldock-annotation-overlay"]')
    emitAnnotation({
      version: 1,
      kind: 'segment',
      shareTrackSid: localShare.trackSid,
      senderIdentity: 'user-b',
      strokeId: 'stroke-4',
      seq: 0,
      from: { x: 0.05, y: 0.05 },
      to: { x: 0.25, y: 0.25 },
      sentAtMs: Date.now(),
      receivedAtMs: Date.now(),
    })
    await flushAll()
    expect(overlay.attributes('data-active-segments')).toBe('1')

    wrapper.unmount()
  })

  it('renders preview-fallback strokes with smoothed per-sender colors', async () => {
    const originalGetContext = HTMLCanvasElement.prototype.getContext
    const canvasContextStub = {
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      save: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      quadraticCurveTo: vi.fn(),
      stroke: vi.fn(),
      restore: vi.fn(),
      globalAlpha: 1,
      lineCap: 'round',
      lineJoin: 'round',
      strokeStyle: '',
      lineWidth: 1,
    } as unknown as CanvasRenderingContext2D
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: vi.fn(() => canvasContextStub) as unknown as typeof HTMLCanvasElement.prototype.getContext,
    })

    const callStore = useCallStore()
    const localShare = createLocalShareRoom()
    const emitAnnotation = installAnnotationEmitter(callStore)
    seedUserState()

    callStore.connected = true
    callStore.screenShareEnabled = true
    callStore.room = localShare.room as never
    callStore.mediaVersion = 1
    setAnnotationSession(callStore, {
      sharerIdentity: 'user-a',
      sharerPlatform: 'tauri',
      shareType: 'window',
    })

    const wrapper = mount(CallDock, {
      attachTo: document.body,
      global: {
        stubs: {
          UserAvatar: true,
        },
      },
    })

    try {
      await flushAll()
      const overlay = wrapper.get('[data-testid="calldock-annotation-overlay"]')
      const stage = overlay.element.parentElement as HTMLElement
      mockElementRect(stage, { width: 640, height: 360 })
      for (const video of wrapper.findAll('video')) {
        mockElementRect(video.element as HTMLVideoElement, { width: 640, height: 360 })
        Object.defineProperty(video.element, 'videoWidth', { configurable: true, value: 640 })
        Object.defineProperty(video.element, 'videoHeight', { configurable: true, value: 360 })
      }

      const baseSegment = {
        version: 1 as const,
        kind: 'segment' as const,
        shareTrackSid: localShare.trackSid,
        senderIdentity: 'user-b',
        strokeId: 'stroke-smooth',
        sentAtMs: Date.now(),
        receivedAtMs: Date.now(),
      }
      emitAnnotation({
        ...baseSegment,
        seq: 0,
        from: { x: 0.05, y: 0.05 },
        to: { x: 0.25, y: 0.25 },
      })
      emitAnnotation({
        ...baseSegment,
        seq: 1,
        from: { x: 0.25, y: 0.25 },
        to: { x: 0.45, y: 0.35 },
      })
      await flushAll()

      expect(overlay.attributes('data-active-segments')).toBe('2')
      expect(canvasContextStub.strokeStyle).toBe(resolveScreenAnnotationStrokeColor('user-b'))
      expect(canvasContextStub.quadraticCurveTo).toHaveBeenCalled()
    } finally {
      wrapper.unmount()
      Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
        configurable: true,
        value: originalGetContext,
      })
    }
  })

  it('expires preview-fallback segments after 20 seconds and reports fade window', async () => {
    vi.useFakeTimers()
    const callStore = useCallStore()
    const localShare = createLocalShareRoom()
    const emitAnnotation = installAnnotationEmitter(callStore)
    seedUserState()

    callStore.connected = true
    callStore.screenShareEnabled = true
    callStore.room = localShare.room as never
    callStore.mediaVersion = 1
    setAnnotationSession(callStore, {
      sharerIdentity: 'user-a',
      sharerPlatform: 'tauri',
      shareType: 'window',
    })

    const wrapper = mount(CallDock, {
      attachTo: document.body,
      global: {
        stubs: {
          UserAvatar: true,
        },
      },
    })
    await flushAll()

    const overlay = wrapper.get('[data-testid="calldock-annotation-overlay"]')
    emitAnnotation({
      version: 1,
      kind: 'segment',
      shareTrackSid: localShare.trackSid,
      senderIdentity: 'user-b',
      strokeId: 'stroke-5',
      seq: 0,
      from: { x: 0.05, y: 0.05 },
      to: { x: 0.25, y: 0.25 },
      sentAtMs: Date.now(),
      receivedAtMs: Date.now(),
    })
    await flushAll()
    expect(overlay.attributes('data-active-segments')).toBe('1')

    await vi.advanceTimersByTimeAsync(19_850)
    await flushAll()
    expect(overlay.attributes('data-fading-segments')).toBe('1')
    expect(overlay.attributes('data-active-segments')).toBe('1')

    await vi.advanceTimersByTimeAsync(400)
    await flushAll()
    expect(overlay.attributes('data-active-segments')).toBe('0')

    wrapper.unmount()
    vi.useRealTimers()
  })
})
