import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import MessageBubble from '@/components/MessageBubble.vue'
import RichTextComposer from '@/components/RichTextComposer.vue'
import { useAuthStore } from '@/stores/auth'
import { useChatStore, type Message } from '@/stores/chat'
import { useWsStore } from '@/stores/ws'

const chatApiMocks = vi.hoisted(() => ({
  createOrOpenDm: vi.fn(),
  fetchMessageAttachmentBlob: vi.fn(),
  fetchMessageAttachmentThumbnailBlob: vi.fn(),
  listMessageReactionUsers: vi.fn(),
  editMessage: vi.fn(),
  deleteMessage: vi.fn(),
  listSavedMessages: vi.fn(),
  listForwardTargets: vi.fn(),
  forwardMessage: vi.fn(),
  saveMessage: vi.fn(),
  unsaveMessage: vi.fn(),
}))

vi.mock('@/services/http/chatApi', () => ({
  createOrOpenDm: chatApiMocks.createOrOpenDm,
  fetchMessageAttachmentBlob: chatApiMocks.fetchMessageAttachmentBlob,
  fetchMessageAttachmentThumbnailBlob: chatApiMocks.fetchMessageAttachmentThumbnailBlob,
  listMessageReactionUsers: chatApiMocks.listMessageReactionUsers,
  editMessage: chatApiMocks.editMessage,
  deleteMessage: chatApiMocks.deleteMessage,
  listSavedMessages: chatApiMocks.listSavedMessages,
  listForwardTargets: chatApiMocks.listForwardTargets,
  forwardMessage: chatApiMocks.forwardMessage,
  saveMessage: chatApiMocks.saveMessage,
  unsaveMessage: chatApiMocks.unsaveMessage,
}))

async function flushAll() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

type ObserverCallback = (entries: IntersectionObserverEntry[], observer: IntersectionObserver) => void

class IntersectionObserverMock {
  static instances: IntersectionObserverMock[] = []

  readonly observed = new Set<Element>()

  constructor(private readonly callback: ObserverCallback) {
    IntersectionObserverMock.instances.push(this)
  }

  observe = (element: Element) => {
    this.observed.add(element)
  }

  unobserve = (element: Element) => {
    this.observed.delete(element)
  }

  disconnect = () => {
    this.observed.clear()
  }

  trigger(element: Element) {
    this.callback([{ target: element, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  }
}

function latestImagePreviewObserver(): IntersectionObserverMock {
  const observer = IntersectionObserverMock.instances[IntersectionObserverMock.instances.length - 1]
  if (!observer) throw new Error('image preview observer was not created')
  return observer
}

async function waitForEditComposer(wrapper: ReturnType<typeof mount>) {
  for (let index = 0; index < 10; index += 1) {
    await flushAll()
    if (wrapper.find('[data-testid="message-edit-textarea"] .ProseMirror').exists()) return
  }
  throw new Error('edit composer did not mount')
}

function editComposer(wrapper: ReturnType<typeof mount>) {
  return wrapper.getComponent(RichTextComposer)
}

function editEditor(wrapper: ReturnType<typeof mount>) {
  return (editComposer(wrapper).vm as unknown as { getEditor: () => any }).getEditor()
}

function editProse(wrapper: ReturnType<typeof mount>) {
  return wrapper.get('[data-testid="message-edit-textarea"] .ProseMirror')
}

async function insertEditText(wrapper: ReturnType<typeof mount>, value: string) {
  ;(editComposer(wrapper).vm as unknown as { setValue: (text: string) => void }).setValue(value)
  await flushAll()
}

async function appendEditText(wrapper: ReturnType<typeof mount>, value: string) {
  ;(editComposer(wrapper).vm as unknown as { insertText: (text: string) => void }).insertText(value)
  await flushAll()
}

async function typeEditText(wrapper: ReturnType<typeof mount>, value: string) {
  const editor = editEditor(wrapper)
  const view = editor.view

  for (const char of value) {
    const from = view.state.selection.from
    const to = view.state.selection.to
    let handled = false
    view.someProp('handleTextInput', (handler: (view: any, from: number, to: number, text: string) => boolean) => {
      handled = handler(view, from, to, char)
      return handled
    })
    if (!handled) {
      view.dispatch(view.state.tr.insertText(char, from, to))
    }
  }

  await flushAll()
}

async function insertEditHardBreak(wrapper: ReturnType<typeof mount>) {
  await editProse(wrapper).trigger('keydown', { key: 'Enter', shiftKey: true })
  await flushAll()
}

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
    reactions: [{ emoji: ':+1:', count: 1 }],
    myReactions: [],
    ...overrides,
  }
}

describe('MessageBubble reactions', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    IntersectionObserverMock.instances = []
    vi.stubGlobal('IntersectionObserver', IntersectionObserverMock)
    chatApiMocks.createOrOpenDm.mockReset()
    chatApiMocks.createOrOpenDm.mockResolvedValue({
      conversation_id: 'dm-1',
      user_id: 'user-3',
      display_name: 'Alice Example',
      email: 'alice@example.com',
      avatar_url: 'https://example.com/alice.png',
      kind: 'dm',
      visibility: 'dm',
    })
    chatApiMocks.fetchMessageAttachmentBlob.mockReset()
    chatApiMocks.fetchMessageAttachmentBlob.mockResolvedValue(new Blob(['img'], { type: 'image/png' }))
    chatApiMocks.fetchMessageAttachmentThumbnailBlob.mockReset()
    chatApiMocks.fetchMessageAttachmentThumbnailBlob.mockResolvedValue(new Blob(['thumbnail'], { type: 'image/jpeg' }))
    chatApiMocks.listMessageReactionUsers.mockReset()
    chatApiMocks.listMessageReactionUsers.mockResolvedValue([])
    chatApiMocks.editMessage.mockReset()
    chatApiMocks.editMessage.mockResolvedValue({
      message_id: 'message-1',
      edited_at: '2026-03-06T00:10:00Z',
    })
    chatApiMocks.deleteMessage.mockReset()
    chatApiMocks.deleteMessage.mockResolvedValue(undefined)
    chatApiMocks.listSavedMessages.mockReset()
    chatApiMocks.listSavedMessages.mockResolvedValue({ total_count: 0, items: [] })
    chatApiMocks.listForwardTargets.mockReset()
    chatApiMocks.listForwardTargets.mockResolvedValue({ conversations: [], threads: [] })
    chatApiMocks.forwardMessage.mockReset()
    chatApiMocks.forwardMessage.mockResolvedValue(undefined)
    chatApiMocks.saveMessage.mockReset()
    chatApiMocks.saveMessage.mockResolvedValue(undefined)
    chatApiMocks.unsaveMessage.mockReset()
    chatApiMocks.unsaveMessage.mockResolvedValue(undefined)
    let objectUrlIndex = 0
    globalThis.URL.createObjectURL = vi.fn(() => `blob:attachment-preview-${++objectUrlIndex}`)
    globalThis.URL.revokeObjectURL = vi.fn()
    window.open = vi.fn(() => ({
      opener: null,
      focus: vi.fn(),
      close: vi.fn(),
    } as unknown as Window))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('clicking own reaction sends remove', async () => {
    const auth = useAuthStore()
    const chat = useChatStore()
    const ws = useWsStore()

    auth.user = { id: 'user-1', email: 'u1@example.com', displayName: 'U1', role: 'member' }
    const msg = buildMessage({ myReactions: [':+1:'] })
    chat.messages = { 'channel-1': [msg] }
    ws.sendRemoveReaction = vi.fn()
    ws.sendAddReaction = vi.fn()
    chat.queueReactionOp = vi.fn()

    const wrapper = mount(MessageBubble, {
      props: { message: msg, showHeader: true },
    })

    await wrapper.findAll('button').find(button => button.text().includes(':+1:'))?.trigger('click')

    expect(ws.sendRemoveReaction).toHaveBeenCalledWith('channel-1', 'message-1', ':+1:', expect.any(String))
    expect(chat.queueReactionOp).toHaveBeenCalledWith(expect.any(String), 'channel-1', 'message-1', ':+1:', 'remove')
    expect(ws.sendAddReaction).not.toHaveBeenCalled()
  })

  it('clicking others reaction sends add', async () => {
    const auth = useAuthStore()
    const chat = useChatStore()
    const ws = useWsStore()

    auth.user = { id: 'user-1', email: 'u1@example.com', displayName: 'U1', role: 'member' }
    const msg = buildMessage({ myReactions: [] })
    chat.messages = { 'channel-1': [msg] }
    ws.sendRemoveReaction = vi.fn()
    ws.sendAddReaction = vi.fn()
    chat.queueReactionOp = vi.fn()

    const wrapper = mount(MessageBubble, {
      props: { message: msg, showHeader: true },
    })

    await wrapper.findAll('button').find(button => button.text().includes(':+1:'))?.trigger('click')

    expect(ws.sendAddReaction).toHaveBeenCalledWith('channel-1', 'message-1', ':+1:', expect.any(String))
    expect(chat.queueReactionOp).toHaveBeenCalledWith(expect.any(String), 'channel-1', 'message-1', ':+1:', 'add')
    expect(ws.sendRemoveReaction).not.toHaveBeenCalled()
  })

  it('uses workspace self identity fallback when auth user is not hydrated', async () => {
    const auth = useAuthStore()
    const chat = useChatStore()
    const ws = useWsStore()

    auth.user = null
    chat.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'U1',
      selfRole: 'member',
    }
    const msg = buildMessage({ myReactions: [] })
    chat.messages = { 'channel-1': [msg] }
    ws.sendRemoveReaction = vi.fn()
    ws.sendAddReaction = vi.fn()
    chat.queueReactionOp = vi.fn()

    const wrapper = mount(MessageBubble, {
      props: { message: msg, showHeader: true },
    })

    await wrapper.findAll('button').find(button => button.text().includes(':+1:'))?.trigger('click')

    expect(ws.sendAddReaction).toHaveBeenCalledWith('channel-1', 'message-1', ':+1:', expect.any(String))
    expect(chat.queueReactionOp).toHaveBeenCalledWith(expect.any(String), 'channel-1', 'message-1', ':+1:', 'add')
  })

  it('shows New thread button for a root message and emits openThread on click', async () => {
    const msg = buildMessage({ reactions: [], myReactions: [] })
    const wrapper = mount(MessageBubble, {
      props: { message: msg, showHeader: true, threadReplyCount: 0 },
    })

    const button = wrapper.get('[data-testid="new-thread-button"]')
    expect(button).toBeTruthy()

    await button.trigger('click')
    const emitted = wrapper.emitted('openThread')
    expect(emitted).toBeTruthy()
    expect(emitted?.[0]?.[0]).toEqual(msg)
  })

  it('shows View thread when replies already exist', () => {
    const msg = buildMessage({ reactions: [], myReactions: [] })
    const wrapper = mount(MessageBubble, {
      props: { message: msg, showHeader: true, threadReplyCount: 3 },
    })

    const button = wrapper.get('[data-testid="thread-action-button"]')
    expect(button.text()).toContain('3 replies')
  })

  it('shows save action for any confirmed message and toggles saved state', async () => {
    const chat = useChatStore()
    const msg = buildMessage({ senderId: 'other-user', reactions: [], myReactions: [], isSaved: false })
    chat.messages = { 'channel-1': [msg] }
    chat.bootstrapped = true

    const wrapper = mount(MessageBubble, {
      props: { message: msg, showHeader: true },
    })

    await wrapper.get('[data-testid="save-message-button"]').trigger('click')
    await flushAll()

    expect(chatApiMocks.saveMessage).toHaveBeenCalledWith('message-1')
    expect(chat.messages['channel-1'][0].isSaved).toBe(true)
  })

  it('hides save action for queued messages', () => {
    const msg = buildMessage({ reactions: [], myReactions: [], sendStatus: 'queued' })
    const wrapper = mount(MessageBubble, {
      props: { message: msg, showHeader: true },
    })

    expect(wrapper.find('[data-testid="save-message-button"]').exists()).toBe(false)
  })

  it('hides thread action for thread replies but keeps it for self-root encoded messages', () => {
    const reply = buildMessage({ id: 'reply-1', threadRootMessageId: 'root-1', reactions: [], myReactions: [] })
    const replyWrapper = mount(MessageBubble, {
      props: { message: reply, showHeader: true },
    })
    expect(replyWrapper.find('[data-testid="thread-action-button"]').exists()).toBe(false)
    expect(replyWrapper.find('[data-testid="new-thread-button"]').exists()).toBe(false)
    expect(replyWrapper.find('[data-testid="first-reaction-button"]').exists()).toBe(false)

    const selfRoot = buildMessage({ id: 'root-2', threadRootMessageId: 'root-2', reactions: [], myReactions: [] })
    const selfRootWrapper = mount(MessageBubble, {
      props: { message: selfRoot, showHeader: true },
    })
    expect(selfRootWrapper.find('[data-testid="new-thread-button"]').exists()).toBe(true)
  })

  it('shows first-reaction hover button for thread replies when explicitly enabled', () => {
    const reply = buildMessage({ id: 'reply-1', threadRootMessageId: 'root-1', reactions: [], myReactions: [] })
    const wrapper = mount(MessageBubble, {
      props: {
        message: reply,
        showHeader: true,
        showThreadAction: false,
        showFirstReactionAction: true,
      },
    })

    expect(wrapper.find('[data-testid="first-reaction-button"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="thread-action-button"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="new-thread-button"]').exists()).toBe(false)
  })

  it('keeps first-reaction hover button hidden when explicitly disabled', () => {
    const msg = buildMessage({ reactions: [], myReactions: [] })
    const wrapper = mount(MessageBubble, {
      props: {
        message: msg,
        showHeader: true,
        showFirstReactionAction: false,
      },
    })

    expect(wrapper.find('[data-testid="first-reaction-button"]').exists()).toBe(false)
  })

  it('keeps first-reaction hover button visible for main chat messages by default', () => {
    const msg = buildMessage({ reactions: [], myReactions: [] })
    const wrapper = mount(MessageBubble, {
      props: {
        message: msg,
        showHeader: true,
      },
    })

    expect(wrapper.find('[data-testid="first-reaction-button"]').exists()).toBe(true)
  })

  it('keeps existing reactions add button when reactions already exist', () => {
    const msg = buildMessage()
    const wrapper = mount(MessageBubble, {
      props: {
        message: msg,
        showHeader: true,
        showFirstReactionAction: false,
      },
    })

    const addReactionButtons = wrapper.findAll('button[title="Add reaction"]')
    expect(addReactionButtons).toHaveLength(1)
    expect(addReactionButtons[0].text()).toContain('+')
  })

  it('shows message header timestamp with date and time', () => {
    const createdAt = '2026-03-06T13:05:00Z'
    const msg = buildMessage({ reactions: [], myReactions: [], createdAt })
    const wrapper = mount(MessageBubble, {
      props: { message: msg, showHeader: true },
    })

    const expected = new Date(createdAt).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
    expect(wrapper.text()).toContain(expected)
  })

  it('shows edit/delete menu items only for own confirmed messages', async () => {
    const auth = useAuthStore()
    auth.user = { id: 'user-1', email: 'u1@example.com', displayName: 'U1', role: 'member' }

    const ownConfirmed = buildMessage({ senderId: 'user-1', reactions: [], myReactions: [] })
    const ownWrapper = mount(MessageBubble, {
      props: { message: ownConfirmed, showHeader: true },
      attachTo: document.body,
    })
    await ownWrapper.get('button[title="More actions"]').trigger('click')
    await flushAll()
    expect(document.body.querySelector('[data-testid="message-menu-edit"]')).toBeTruthy()
    expect(document.body.querySelector('[data-testid="message-menu-delete"]')).toBeTruthy()
    ownWrapper.unmount()

    const otherMessage = buildMessage({ senderId: 'user-2', reactions: [], myReactions: [] })
    const otherWrapper = mount(MessageBubble, {
      props: { message: otherMessage, showHeader: true },
      attachTo: document.body,
    })
    await otherWrapper.get('button[title="More actions"]').trigger('click')
    await flushAll()
    expect(document.body.querySelector('[data-testid="message-menu-edit"]')).toBeNull()
    expect(document.body.querySelector('[data-testid="message-menu-delete"]')).toBeNull()
    otherWrapper.unmount()

    const ownUnconfirmed = buildMessage({
      senderId: 'user-1',
      sendStatus: 'sending',
      reactions: [],
      myReactions: [],
    })
    const pendingWrapper = mount(MessageBubble, {
      props: { message: ownUnconfirmed, showHeader: true },
      attachTo: document.body,
    })
    await pendingWrapper.get('button[title="More actions"]').trigger('click')
    await flushAll()
    expect(document.body.querySelector('[data-testid="message-menu-edit"]')).toBeNull()
    expect(document.body.querySelector('[data-testid="message-menu-delete"]')).toBeNull()
    pendingWrapper.unmount()
  })

  it('shows forward action for confirmed messages and hides it for pending messages', async () => {
    const confirmed = buildMessage({ reactions: [], myReactions: [] })
    const confirmedWrapper = mount(MessageBubble, {
      props: { message: confirmed, showHeader: true },
      attachTo: document.body,
    })
    await confirmedWrapper.get('button[title="More actions"]').trigger('click')
    await flushAll()
    expect(document.body.querySelector('[data-testid="message-menu-forward"]')).toBeTruthy()
    confirmedWrapper.unmount()

    const pending = buildMessage({ reactions: [], myReactions: [], sendStatus: 'sending' })
    const pendingWrapper = mount(MessageBubble, {
      props: { message: pending, showHeader: true },
      attachTo: document.body,
    })
    await pendingWrapper.get('button[title="More actions"]').trigger('click')
    await flushAll()
    expect(document.body.querySelector('[data-testid="message-menu-forward"]')).toBeNull()
    pendingWrapper.unmount()
  })

  it('renders forwarded attribution above the message body', () => {
    const msg = buildMessage({
      reactions: [],
      myReactions: [],
      forwardedFrom: {
        messageId: 'source-1',
        senderId: 'user-9',
        senderName: 'Original Sender',
        conversationKind: 'channel',
        conversationTitle: 'general',
        threadTitle: 'Launch thread',
      },
    })
    const wrapper = mount(MessageBubble, {
      props: { message: msg, showHeader: true },
    })

    expect(wrapper.get('[data-testid="message-forwarded-banner"]').text()).toContain('Forwarded from Original Sender in thread "Launch thread" (#general)')
    expect(wrapper.text()).toContain('hello')
  })

  it('opens inline edit when editRequestToken changes for an own confirmed message', async () => {
    const auth = useAuthStore()
    auth.user = { id: 'user-1', email: 'u1@example.com', displayName: 'U1', role: 'member' }

    const msg = buildMessage({
      senderId: 'user-1',
      reactions: [],
      myReactions: [],
      body: 'before edit',
    })
    const wrapper = mount(MessageBubble, {
      props: { message: msg, showHeader: true, editRequestToken: 0 },
      attachTo: document.body,
    })

    await wrapper.setProps({ editRequestToken: 1 })
    await waitForEditComposer(wrapper)

    expect(wrapper.find('[data-testid="message-edit-textarea"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('opens inline edit when a virtualized row mounts with an active edit token', async () => {
    const auth = useAuthStore()
    auth.user = { id: 'user-1', email: 'u1@example.com', displayName: 'U1', role: 'member' }

    const wrapper = mount(MessageBubble, {
      props: {
        message: buildMessage({ senderId: 'user-1', reactions: [], myReactions: [], body: 'before edit' }),
        showHeader: true,
        editRequestToken: 1,
      },
      attachTo: document.body,
    })

    await waitForEditComposer(wrapper)
    expect(wrapper.find('[data-testid="message-edit-textarea"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('ignores editRequestToken for messages that cannot be edited', async () => {
    const auth = useAuthStore()
    auth.user = { id: 'user-1', email: 'u1@example.com', displayName: 'U1', role: 'member' }

    const otherMessage = mount(MessageBubble, {
      props: {
        message: buildMessage({ senderId: 'user-2', reactions: [], myReactions: [] }),
        showHeader: true,
        editRequestToken: 0,
      },
      attachTo: document.body,
    })
    await otherMessage.setProps({ editRequestToken: 1 })
    await flushAll()
    expect(otherMessage.find('[data-testid="message-edit-textarea"]').exists()).toBe(false)
    otherMessage.unmount()

    const unconfirmedMessage = mount(MessageBubble, {
      props: {
        message: buildMessage({ senderId: 'user-1', sendStatus: 'sending', reactions: [], myReactions: [] }),
        showHeader: true,
        editRequestToken: 0,
      },
      attachTo: document.body,
    })
    await unconfirmedMessage.setProps({ editRequestToken: 1 })
    await flushAll()
    expect(unconfirmedMessage.find('[data-testid="message-edit-textarea"]').exists()).toBe(false)
    unconfirmedMessage.unmount()
  })

  it('edits inline and renders edited marker', async () => {
    const auth = useAuthStore()
    const chat = useChatStore()
    auth.user = { id: 'user-1', email: 'u1@example.com', displayName: 'U1', role: 'member' }

    const msg = buildMessage({
      senderId: 'user-1',
      reactions: [],
      myReactions: [],
      body: 'before edit',
    })
    chat.messages = { 'channel-1': [msg] }
    const wrapper = mount(MessageBubble, {
      props: { message: msg, showHeader: true },
      attachTo: document.body,
    })

    await wrapper.get('button[title="More actions"]').trigger('click')
    await flushAll()
    const editMenu = document.body.querySelector('[data-testid="message-menu-edit"]') as HTMLButtonElement
    expect(editMenu).toBeTruthy()
    editMenu.click()
    await waitForEditComposer(wrapper)

    const editor = editProse(wrapper)
    expect(wrapper.find('[data-testid="message-edit-save"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="message-edit-cancel"]').exists()).toBe(false)
    await insertEditText(wrapper, 'edited body')
    await editor.trigger('keydown', { key: 'Enter' })
    await flushAll()

    expect(chatApiMocks.editMessage).toHaveBeenCalledWith('message-1', 'edited body', [])
    expect(chat.messages['channel-1'][0].body).toBe('edited body')
    expect(chat.messages['channel-1'][0].editedAt).toBe('2026-03-06T00:10:00.000Z')
    expect(wrapper.find('[data-testid="message-edited-marker"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('does not save an inline edit while a task URL paste is resolving', async () => {
    const auth = useAuthStore()
    const chat = useChatStore()
    auth.user = { id: 'user-1', email: 'u1@example.com', displayName: 'U1', role: 'member' }

    const msg = buildMessage({
      senderId: 'user-1',
      reactions: [],
      myReactions: [],
      body: 'before edit',
    })
    chat.messages = { 'channel-1': [msg] }
    const wrapper = mount(MessageBubble, {
      props: { message: msg, showHeader: true },
      attachTo: document.body,
    })

    await wrapper.get('button[title="More actions"]').trigger('click')
    await flushAll()
    ;(document.body.querySelector('[data-testid="message-menu-edit"]') as HTMLButtonElement).click()
    await waitForEditComposer(wrapper)

    ;(editComposer(wrapper).vm as unknown as { $emit: (event: string, value: boolean) => void })
      .$emit('pending-task-url-paste-change', true)
    await flushAll()
    await editProse(wrapper).trigger('keydown', { key: 'Enter' })
    await flushAll()

    expect(chatApiMocks.editMessage).not.toHaveBeenCalled()

    ;(editComposer(wrapper).vm as unknown as { $emit: (event: string, value: boolean) => void })
      .$emit('pending-task-url-paste-change', false)
    await flushAll()
    await editProse(wrapper).trigger('keydown', { key: 'Enter' })
    await flushAll()

    expect(chatApiMocks.editMessage).toHaveBeenCalledWith('message-1', 'before edit', [])
    wrapper.unmount()
  })

  it('sizes inline edit composer to its content on open', async () => {
    const auth = useAuthStore()
    auth.user = { id: 'user-1', email: 'u1@example.com', displayName: 'U1', role: 'member' }

    const msg = buildMessage({
      senderId: 'user-1',
      reactions: [],
      myReactions: [],
      body: 'line 1\nline 2\nline 3\nline 4\nline 5',
    })
    const wrapper = mount(MessageBubble, {
      props: { message: msg, showHeader: true },
      attachTo: document.body,
    })

    await wrapper.get('button[title="More actions"]').trigger('click')
    await flushAll()
    const editMenu = document.body.querySelector('[data-testid="message-menu-edit"]') as HTMLButtonElement
    editMenu.click()
    await waitForEditComposer(wrapper)

    const editor = editProse(wrapper).element as HTMLDivElement
    Object.defineProperty(editor, 'scrollHeight', {
      configurable: true,
      get: () => 240,
    })

    await insertEditText(wrapper, '\nextra')
    await flushAll()

    expect(editor.style.maxHeight).toBe('')
    expect(editor.style.height).toBe('240px')
    expect(editor.style.overflowY).toBe('hidden')
    wrapper.unmount()
  })

  it('keeps inline edit composer synced with content growth', async () => {
    const auth = useAuthStore()
    auth.user = { id: 'user-1', email: 'u1@example.com', displayName: 'U1', role: 'member' }

    const msg = buildMessage({
      senderId: 'user-1',
      reactions: [],
      myReactions: [],
      body: 'start',
    })
    const wrapper = mount(MessageBubble, {
      props: { message: msg, showHeader: true },
      attachTo: document.body,
    })

    await wrapper.get('button[title="More actions"]').trigger('click')
    await flushAll()
    const editMenu = document.body.querySelector('[data-testid="message-menu-edit"]') as HTMLButtonElement
    editMenu.click()
    await waitForEditComposer(wrapper)

    const editor = editProse(wrapper).element as HTMLDivElement
    let scrollHeight = 96
    Object.defineProperty(editor, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    })

    await insertEditText(wrapper, 'line 1')
    expect(editor.style.height).toBe('96px')

    scrollHeight = 232
    await insertEditText(wrapper, '\nline 2\nline 3\nline 4')
    expect(editor.style.height).toBe('232px')
    expect(editor.style.overflowY).toBe('hidden')
    wrapper.unmount()
  })

  it('uses Shift+Enter for newline and Enter for submit while editing', async () => {
    const auth = useAuthStore()
    auth.user = { id: 'user-1', email: 'u1@example.com', displayName: 'U1', role: 'member' }

    const msg = buildMessage({
      senderId: 'user-1',
      reactions: [],
      myReactions: [],
      body: 'start',
    })
    const wrapper = mount(MessageBubble, {
      props: { message: msg, showHeader: true },
      attachTo: document.body,
    })

    await wrapper.get('button[title="More actions"]').trigger('click')
    await flushAll()
    const editMenu = document.body.querySelector('[data-testid="message-menu-edit"]') as HTMLButtonElement
    editMenu.click()
    await waitForEditComposer(wrapper)

    const editor = editProse(wrapper)
    await insertEditText(wrapper, 'line 1')
    await editor.trigger('keydown', { key: 'Enter', shiftKey: true })
    await flushAll()
    expect(chatApiMocks.editMessage).not.toHaveBeenCalled()

    await appendEditText(wrapper, 'line 2')
    await editor.trigger('keydown', { key: 'Enter' })
    await flushAll()

    expect(chatApiMocks.editMessage).toHaveBeenCalledWith('message-1', 'line 1\nline 2', [])
    wrapper.unmount()
  })

  it('supports visual-line list shortcuts while editing inline', async () => {
    const auth = useAuthStore()
    auth.user = { id: 'user-1', email: 'u1@example.com', displayName: 'U1', role: 'member' }

    const msg = buildMessage({
      senderId: 'user-1',
      reactions: [],
      myReactions: [],
      body: 'alpha',
    })
    const wrapper = mount(MessageBubble, {
      props: { message: msg, showHeader: true },
      attachTo: document.body,
    })

    await wrapper.get('button[title="More actions"]').trigger('click')
    await flushAll()
    const editMenu = document.body.querySelector('[data-testid="message-menu-edit"]') as HTMLButtonElement
    editMenu.click()
    await waitForEditComposer(wrapper)

    await insertEditText(wrapper, 'alpha')
    await insertEditHardBreak(wrapper)
    await typeEditText(wrapper, '1. ')

    const content = editEditor(wrapper).getJSON().content ?? []
    expect(content[0]?.type).toBe('paragraph')
    expect(content[1]?.type).toBe('orderedList')
    wrapper.unmount()
  })

  it('deletes message via API and applies local removal on success', async () => {
    const auth = useAuthStore()
    const chat = useChatStore()
    auth.user = { id: 'user-1', email: 'u1@example.com', displayName: 'U1', role: 'member' }
    const applyLocalDeleteSpy = vi.spyOn(chat, 'applyLocalMessageDeleted')

    const msg = buildMessage({
      senderId: 'user-1',
      reactions: [],
      myReactions: [],
    })
    const wrapper = mount(MessageBubble, {
      props: { message: msg, showHeader: true },
      attachTo: document.body,
    })

    await wrapper.get('button[title="More actions"]').trigger('click')
    await flushAll()
    const deleteMenu = document.body.querySelector('[data-testid="message-menu-delete"]') as HTMLButtonElement
    expect(deleteMenu).toBeTruthy()
    deleteMenu.click()
    await flushAll()

    expect(chatApiMocks.deleteMessage).toHaveBeenCalledWith('message-1')
    expect(applyLocalDeleteSpy).toHaveBeenCalledWith('channel-1', 'message-1', undefined)
    wrapper.unmount()
  })

  it('lets a secret-chat participant delete a peer message without allowing edits', async () => {
    useAuthStore().user = { id: 'user-1', email: 'u1@example.com', displayName: 'U1', role: 'member' }
    const chat = useChatStore()
    const invalidate = vi.spyOn(chat, 'invalidateSecretHistory')
    const wrapper = mount(MessageBubble, {
      props: { message: buildMessage({ senderId: 'user-2', contentMode: 'dm_pairwise_signal_v1' }), showHeader: true },
      attachTo: document.body,
    })
    await wrapper.get('button[title="More actions"]').trigger('click')
    await flushAll()
    expect(document.body.querySelector('[data-testid="message-menu-edit"]')).toBeNull()
    const button = document.body.querySelector('[data-testid="message-menu-delete"]') as HTMLButtonElement
    expect(button).toBeTruthy()
    button.click()
    await flushAll()
    expect(chatApiMocks.deleteMessage).toHaveBeenCalledWith('message-1')
    expect(invalidate).toHaveBeenCalledWith('channel-1')
    wrapper.unmount()
  })

  it('keeps peer plaintext messages protected from deletion', async () => {
    useAuthStore().user = { id: 'user-1', email: 'u1@example.com', displayName: 'U1', role: 'member' }
    const wrapper = mount(MessageBubble, {
      props: { message: buildMessage({ senderId: 'user-2' }), showHeader: true }, attachTo: document.body,
    })
    await wrapper.get('button[title="More actions"]').trigger('click')
    await flushAll()
    expect(document.body.querySelector('[data-testid="message-menu-delete"]')).toBeNull()
    wrapper.unmount()
  })

  it('cancels inline edit when Escape is pressed', async () => {
    const auth = useAuthStore()
    auth.user = { id: 'user-1', email: 'u1@example.com', displayName: 'U1', role: 'member' }

    const msg = buildMessage({
      senderId: 'user-1',
      reactions: [],
      myReactions: [],
      body: 'before',
    })
    const wrapper = mount(MessageBubble, {
      props: { message: msg, showHeader: true },
      attachTo: document.body,
    })

    await wrapper.get('button[title="More actions"]').trigger('click')
    await flushAll()
    const editMenu = document.body.querySelector('[data-testid="message-menu-edit"]') as HTMLButtonElement
    editMenu.click()
    await waitForEditComposer(wrapper)
    expect(wrapper.find('[data-testid="message-edit-textarea"]').exists()).toBe(true)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushAll()

    expect(wrapper.find('[data-testid="message-edit-textarea"]').exists()).toBe(false)
    expect(msg.body).toBe('before')
    wrapper.unmount()
  })

  it('opens markdown links from the rendered message body', async () => {
    const msg = buildMessage({
      reactions: [],
      myReactions: [],
      body: '[OpenAI](https://openai.com)',
    })

    const wrapper = mount(MessageBubble, {
      props: { message: msg, showHeader: true },
      attachTo: document.body,
    })

    await flushAll()

    const link = wrapper.get('.markdown-body a')
    link.element.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
    }))
    await flushAll()

    expect(window.open).toHaveBeenCalledWith('https://openai.com/', '_blank')

    wrapper.unmount()
  })

  it('renders fenced code blocks with syntax highlighting', async () => {
    const msg = buildMessage({
      reactions: [],
      myReactions: [],
      body: '```typescript\nconst answer: number = 42\n```',
    })

    const wrapper = mount(MessageBubble, {
      props: { message: msg, showHeader: true },
      attachTo: document.body,
    })

    await flushAll()

    const code = wrapper.get('.markdown-body pre code')
    expect(code.classes()).toContain('hljs')
    expect(code.classes()).toContain('language-typescript')
    expect(wrapper.html()).toContain('<span class="hljs-keyword">const</span>')

    wrapper.unmount()
  })

  it('opens a direct message when clicking a user mention in the rendered message body', async () => {
    const chat = useChatStore()
    const openDirectMessageSpy = vi.spyOn(chat, 'openDirectMessage').mockImplementation(() => {})
    const msg = buildMessage({
      reactions: [],
      myReactions: [],
      body: '@Alice Example hi',
      entities: [{
        kind: 'user',
        targetId: 'user-3',
        label: '@Alice Example',
        href: '',
        start: 0,
        end: 14,
      }],
    })

    const wrapper = mount(MessageBubble, {
      props: { message: msg, showHeader: true },
      attachTo: document.body,
    })

    await flushAll()

    await wrapper.get('[data-message-entity-kind="user"]').trigger('click')
    await flushAll()

    expect(chatApiMocks.createOrOpenDm).toHaveBeenCalledWith('user-3')
    expect(openDirectMessageSpy).toHaveBeenCalledWith(expect.objectContaining({
      id: 'dm-1',
      userId: 'user-3',
      displayName: 'Alice Example',
    }))

    wrapper.unmount()
  })

  it('renders compact image thumbnail and restrained lightbox contract, and closes on Escape', async () => {
    const msg = buildMessage({
      reactions: [],
      myReactions: [],
      attachments: [{
        id: 'att-1',
        fileName: 'photo.png',
        fileSize: 3,
        mimeType: 'image/png',
      }],
    })

    const wrapper = mount(MessageBubble, {
      props: { message: msg, showHeader: true },
      attachTo: document.body,
    })

    latestImagePreviewObserver().trigger(wrapper.get('[data-message-image-attachment-id="att-1"]').element)
    await flushAll()

    const thumbnailButton = wrapper.get('[data-testid="message-image-thumbnail"]')
    expect(thumbnailButton.classes()).toContain('max-h-[min(38vh,220px)]')
    expect(thumbnailButton.classes()).toContain('max-w-[min(72vw,280px)]')
    expect(thumbnailButton.classes()).toContain('sm:max-w-[min(42vw,360px)]')
    expect(thumbnailButton.classes()).toContain('cursor-pointer')

    const thumbnailImage = wrapper.get('[data-testid="message-image-thumbnail-img"]')
    expect(thumbnailImage.classes()).toContain('max-h-[min(38vh,220px)]')
    expect(thumbnailImage.classes()).toContain('object-contain')
    expect(thumbnailImage.classes()).not.toContain('object-cover')

    await thumbnailButton.trigger('click')
    await flushAll()

    const lightbox = document.body.querySelector('[data-testid="message-image-lightbox"]')
    expect(lightbox).toBeTruthy()
    const lightboxImage = document.body.querySelector('[data-testid="message-image-lightbox-img"]')
    expect(lightboxImage).toBeTruthy()
    expect(lightboxImage?.classList.contains('max-h-[calc(100vh-5rem)]')).toBe(true)
    expect(lightboxImage?.classList.contains('sm:max-h-[calc(100vh-6rem)]')).toBe(true)
    expect(lightboxImage?.classList.contains('max-w-[calc(100vw-5rem)]')).toBe(true)
    expect(lightboxImage?.classList.contains('sm:max-w-[calc(100vw-6rem)]')).toBe(true)
    expect(lightboxImage?.classList.contains('max-h-[85vh]')).toBe(false)
    expect(lightboxImage?.classList.contains('max-w-[90vw]')).toBe(false)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushAll()

    expect(document.body.querySelector('[data-testid="message-image-lightbox"]')).toBeNull()

    wrapper.unmount()
  })

  it('waits for visibility, fetches the thumbnail, then upgrades an image lightbox with the original', async () => {
    let resolveOriginal: (blob: Blob) => void = () => {}
    chatApiMocks.fetchMessageAttachmentBlob.mockImplementationOnce(() => new Promise<Blob>(resolve => {
      resolveOriginal = resolve
    }))
    const msg = buildMessage({
      reactions: [],
      myReactions: [],
      attachments: [{
        id: 'att-thumbnail',
        fileName: 'photo.png',
        fileSize: 1024,
        mimeType: 'image/png',
        thumbnailMimeType: 'image/jpeg',
        thumbnailFileSize: 128,
        thumbnailVersion: 1,
      }],
    })

    const wrapper = mount(MessageBubble, {
      props: { message: msg, showHeader: true },
      attachTo: document.body,
    })

    expect(chatApiMocks.fetchMessageAttachmentThumbnailBlob).not.toHaveBeenCalled()
    expect(chatApiMocks.fetchMessageAttachmentBlob).not.toHaveBeenCalled()

    latestImagePreviewObserver().trigger(wrapper.get('[data-message-image-attachment-id="att-thumbnail"]').element)
    await flushAll()

    expect(chatApiMocks.fetchMessageAttachmentThumbnailBlob).toHaveBeenCalledWith('message-1', 'att-thumbnail', 1)
    expect(chatApiMocks.fetchMessageAttachmentBlob).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="message-image-thumbnail-img"]').attributes('src')).toBe('blob:attachment-preview-1')

    await wrapper.get('[data-testid="message-image-thumbnail"]').trigger('click')
    await flushAll()

    expect(chatApiMocks.fetchMessageAttachmentBlob).toHaveBeenCalledWith('message-1', 'att-thumbnail')
    const initialLightboxImage = document.body.querySelector('[data-testid="message-image-lightbox-img"]') as HTMLImageElement
    expect(initialLightboxImage.src).toContain('blob:attachment-preview-1')

    resolveOriginal(new Blob(['full-size'], { type: 'image/png' }))
    await flushAll()

    const upgradedLightboxImage = document.body.querySelector('[data-testid="message-image-lightbox-img"]') as HTMLImageElement
    expect(upgradedLightboxImage.src).toContain('blob:attachment-preview-2')

    wrapper.unmount()
  })

  it('lazily fetches a legacy image original only after it becomes visible', async () => {
    const msg = buildMessage({
      reactions: [],
      myReactions: [],
      attachments: [{
        id: 'att-legacy',
        fileName: 'legacy.png',
        fileSize: 1024,
        mimeType: 'image/png',
      }],
    })

    const wrapper = mount(MessageBubble, {
      props: { message: msg, showHeader: true },
      attachTo: document.body,
    })

    expect(chatApiMocks.fetchMessageAttachmentThumbnailBlob).not.toHaveBeenCalled()
    expect(chatApiMocks.fetchMessageAttachmentBlob).not.toHaveBeenCalled()

    latestImagePreviewObserver().trigger(wrapper.get('[data-message-image-attachment-id="att-legacy"]').element)
    await flushAll()

    expect(chatApiMocks.fetchMessageAttachmentThumbnailBlob).not.toHaveBeenCalled()
    expect(chatApiMocks.fetchMessageAttachmentBlob).toHaveBeenCalledWith('message-1', 'att-legacy')
    expect(wrapper.get('[data-testid="message-image-thumbnail-img"]').attributes('src')).toBe('blob:attachment-preview-1')

    wrapper.unmount()
  })

  it('falls back to the original when a visible thumbnail request fails', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    chatApiMocks.fetchMessageAttachmentThumbnailBlob.mockRejectedValueOnce(new Error('thumbnail missing'))
    const msg = buildMessage({
      reactions: [],
      myReactions: [],
      attachments: [{
        id: 'att-thumbnail-fallback',
        fileName: 'photo.png',
        fileSize: 1024,
        mimeType: 'image/png',
        thumbnailMimeType: 'image/jpeg',
        thumbnailFileSize: 128,
        thumbnailVersion: 1,
      }],
    })

    const wrapper = mount(MessageBubble, {
      props: { message: msg, showHeader: true },
      attachTo: document.body,
    })

    latestImagePreviewObserver().trigger(wrapper.get('[data-message-image-attachment-id="att-thumbnail-fallback"]').element)
    await flushAll()

    expect(chatApiMocks.fetchMessageAttachmentThumbnailBlob).toHaveBeenCalledWith('message-1', 'att-thumbnail-fallback', 1)
    expect(chatApiMocks.fetchMessageAttachmentBlob).toHaveBeenCalledWith('message-1', 'att-thumbnail-fallback')
    expect(wrapper.get('[data-testid="message-image-thumbnail-img"]').attributes('src')).toBe('blob:attachment-preview-1')

    wrapper.unmount()
    debug.mockRestore()
  })

  it('cancels a queued preview when its image attachment is removed', async () => {
    const pendingThumbnails = new Map<string, { promise: Promise<Blob>; resolve: (blob: Blob) => void }>()
    chatApiMocks.fetchMessageAttachmentThumbnailBlob.mockImplementation((_messageId, attachmentId) => {
      let resolve: (blob: Blob) => void = () => {}
      const promise = new Promise<Blob>(nextResolve => {
        resolve = nextResolve
      })
      const pending = { promise, resolve }
      pendingThumbnails.set(attachmentId, pending)
      return promise
    })
    const attachments = Array.from({ length: 5 }, (_, index) => ({
      id: `att-queued-${index + 1}`,
      fileName: `photo-${index + 1}.png`,
      fileSize: 1024,
      mimeType: 'image/png',
      thumbnailMimeType: 'image/jpeg',
      thumbnailFileSize: 128,
      thumbnailVersion: 1,
    }))
    const msg = buildMessage({ reactions: [], myReactions: [], attachments })
    const wrapper = mount(MessageBubble, {
      props: { message: msg, showHeader: true },
      attachTo: document.body,
    })

    const observer = latestImagePreviewObserver()
    for (const target of wrapper.findAll('[data-message-image-attachment-id]')) {
      observer.trigger(target.element)
    }
    expect(chatApiMocks.fetchMessageAttachmentThumbnailBlob).toHaveBeenCalledTimes(4)

    await wrapper.setProps({
      message: buildMessage({
        reactions: [],
        myReactions: [],
        attachments: attachments.slice(0, 4),
      }),
    })
    await flushAll()

    for (const pending of pendingThumbnails.values()) {
      pending.resolve(new Blob(['thumbnail'], { type: 'image/jpeg' }))
    }
    await flushAll()

    expect(chatApiMocks.fetchMessageAttachmentThumbnailBlob).not.toHaveBeenCalledWith('message-1', 'att-queued-5', 1)

    wrapper.unmount()
  })

  it('renders compact video thumbnail and viewport-bound video preview controls', async () => {
    const msg = buildMessage({
      reactions: [],
      myReactions: [],
      attachments: [{
        id: 'vid-1',
        fileName: 'clip.mp4',
        fileSize: 12,
        mimeType: 'video/mp4',
      }],
    })

    const wrapper = mount(MessageBubble, {
      props: { message: msg, showHeader: true },
      attachTo: document.body,
    })

    expect(chatApiMocks.fetchMessageAttachmentBlob).not.toHaveBeenCalled()
    const observer = latestImagePreviewObserver()
    observer.trigger(wrapper.get('[data-message-media-attachment-id="vid-1"]').element)
    await flushAll()

    const thumbnailButton = wrapper.get('[data-testid="message-video-thumbnail"]')
    expect(thumbnailButton.classes()).toContain('max-h-[min(42vh,260px)]')
    expect(thumbnailButton.classes()).toContain('max-w-[min(76vw,420px)]')
    expect(thumbnailButton.classes()).toContain('sm:max-w-[min(46vw,520px)]')
    expect(thumbnailButton.classes()).toContain('cursor-pointer')

    const thumbnailVideo = wrapper.get('[data-testid="message-video-thumbnail-video"]')
    expect(thumbnailVideo.classes()).toContain('max-h-[min(42vh,260px)]')
    expect(thumbnailVideo.classes()).toContain('object-contain')
    expect(thumbnailVideo.attributes('controls')).toBeUndefined()

    const playOverlay = wrapper.get('[data-testid="message-video-play-overlay"]')
    expect(playOverlay.attributes('aria-hidden')).toBe('true')
    expect(playOverlay.classes()).toContain('pointer-events-none')

    await thumbnailButton.trigger('click')
    await flushAll()

    const lightbox = document.body.querySelector('[data-testid="message-video-lightbox"]')
    expect(lightbox).toBeTruthy()
    const lightboxVideo = document.body.querySelector('[data-testid="message-video-lightbox-video"]') as HTMLVideoElement | null
    expect(lightboxVideo).toBeTruthy()
    expect(lightboxVideo?.classList.contains('max-h-[calc(100vh-5rem)]')).toBe(true)
    expect(lightboxVideo?.classList.contains('sm:max-h-[calc(100vh-6rem)]')).toBe(true)
    expect(lightboxVideo?.classList.contains('max-w-[calc(100vw-5rem)]')).toBe(true)
    expect(lightboxVideo?.classList.contains('sm:max-w-[calc(100vw-6rem)]')).toBe(true)
    expect(lightboxVideo?.classList.contains('object-contain')).toBe(true)
    expect(lightboxVideo?.hasAttribute('controls')).toBe(true)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushAll()
    expect(document.body.querySelector('[data-testid="message-video-lightbox"]')).toBeNull()

    await thumbnailButton.trigger('click')
    await flushAll()
    const closeButton = document.body.querySelector('[data-testid="message-video-lightbox-close"]') as HTMLButtonElement
    expect(closeButton).toBeTruthy()
    closeButton.click()
    await flushAll()
    expect(document.body.querySelector('[data-testid="message-video-lightbox"]')).toBeNull()

    await thumbnailButton.trigger('click')
    await flushAll()
    const reopenedLightbox = document.body.querySelector('[data-testid="message-video-lightbox"]') as HTMLDivElement
    expect(reopenedLightbox).toBeTruthy()
    reopenedLightbox.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushAll()
    expect(document.body.querySelector('[data-testid="message-video-lightbox"]')).toBeNull()

    wrapper.unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:attachment-preview-1')
  })

  it('closes image preview on close button and backdrop click', async () => {
    const msg = buildMessage({
      reactions: [],
      myReactions: [],
      attachments: [{
        id: 'att-1',
        fileName: 'photo.png',
        fileSize: 3,
        mimeType: 'image/png',
      }],
    })

    const wrapper = mount(MessageBubble, {
      props: { message: msg, showHeader: true },
      attachTo: document.body,
    })

    latestImagePreviewObserver().trigger(wrapper.get('[data-message-image-attachment-id="att-1"]').element)
    await flushAll()

    await wrapper.get('[data-testid="message-image-thumbnail"]').trigger('click')
    await flushAll()

    const closeButton = document.body.querySelector('[data-testid="message-image-lightbox-close"]') as HTMLButtonElement
    expect(closeButton).toBeTruthy()
    closeButton.click()
    await flushAll()
    expect(document.body.querySelector('[data-testid="message-image-lightbox"]')).toBeNull()

    await wrapper.get('[data-testid="message-image-thumbnail"]').trigger('click')
    await flushAll()

    const lightbox = document.body.querySelector('[data-testid="message-image-lightbox"]') as HTMLDivElement
    expect(lightbox).toBeTruthy()
    lightbox.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushAll()
    expect(document.body.querySelector('[data-testid="message-image-lightbox"]')).toBeNull()

    wrapper.unmount()
  })

  it('shows reaction users popup on hover and keeps it open when moving pointer into popup', async () => {
    vi.useFakeTimers()
    chatApiMocks.listMessageReactionUsers.mockResolvedValue([
      { user_id: 'user-1', display_name: 'Alice', avatar_url: '/api/public/avatars/alice.png' },
      { user_id: 'user-2', display_name: 'Bob', avatar_url: '' },
    ])

    const msg = buildMessage()
    const wrapper = mount(MessageBubble, {
      props: { message: msg, showHeader: true },
      attachTo: document.body,
    })

    const reactionButton = wrapper.findAll('button').find(button => button.text().includes(':+1:'))
    expect(reactionButton).toBeTruthy()
    await reactionButton!.trigger('mouseenter')
    await flushAll()

    expect(chatApiMocks.listMessageReactionUsers).toHaveBeenCalledWith('channel-1', 'message-1', ':+1:')
    expect(document.body.querySelector('[data-testid="reaction-users-popup"]')).toBeTruthy()
    expect(document.body.textContent).toContain('Alice')

    await reactionButton!.trigger('mouseleave')
    const popup = document.body.querySelector('[data-testid="reaction-users-popup"]')
    expect(popup).toBeTruthy()
    popup!.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
    vi.advanceTimersByTime(200)
    await flushAll()
    expect(document.body.querySelector('[data-testid="reaction-users-popup"]')).toBeTruthy()

    popup!.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }))
    vi.advanceTimersByTime(200)
    await flushAll()
    expect(document.body.querySelector('[data-testid="reaction-users-popup"]')).toBeNull()

    wrapper.unmount()
  })

  it('reuses cached reaction users and invalidates cache when count changes', async () => {
    vi.useFakeTimers()
    chatApiMocks.listMessageReactionUsers.mockResolvedValue([
      { user_id: 'user-1', display_name: 'Alice', avatar_url: '' },
    ])

    const msg = buildMessage()
    const wrapper = mount(MessageBubble, {
      props: { message: msg, showHeader: true },
      attachTo: document.body,
    })

    let reactionButton = wrapper.findAll('button').find(button => button.text().includes(':+1:'))
    expect(reactionButton).toBeTruthy()

    await reactionButton!.trigger('mouseenter')
    await flushAll()
    expect(chatApiMocks.listMessageReactionUsers).toHaveBeenCalledTimes(1)

    await reactionButton!.trigger('mouseleave')
    vi.advanceTimersByTime(200)
    await flushAll()

    reactionButton = wrapper.findAll('button').find(button => button.text().includes(':+1:'))
    await reactionButton!.trigger('mouseenter')
    await flushAll()
    expect(chatApiMocks.listMessageReactionUsers).toHaveBeenCalledTimes(1)

    await wrapper.setProps({
      message: {
        ...msg,
        reactions: [{ emoji: ':+1:', count: 2 }],
      },
    })
    await flushAll()
    await reactionButton!.trigger('mouseleave')
    vi.advanceTimersByTime(200)
    await flushAll()

    reactionButton = wrapper.findAll('button').find(button => button.text().includes(':+1:'))
    await reactionButton!.trigger('mouseenter')
    await flushAll()
    expect(chatApiMocks.listMessageReactionUsers).toHaveBeenCalledTimes(2)

    wrapper.unmount()
  })

  it('renders loading and error states for reaction users popup', async () => {
    vi.useFakeTimers()
    let resolveUsers!: (value: Array<{ user_id: string; display_name: string; avatar_url: string }>) => void
    chatApiMocks.listMessageReactionUsers.mockImplementationOnce(() => new Promise(resolve => {
      resolveUsers = resolve
    }))

    const msg = buildMessage()
    const wrapper = mount(MessageBubble, {
      props: { message: msg, showHeader: true },
      attachTo: document.body,
    })

    const reactionButton = wrapper.findAll('button').find(button => button.text().includes(':+1:'))
    expect(reactionButton).toBeTruthy()
    await reactionButton!.trigger('mouseenter')
    await nextTick()

    expect(document.body.querySelector('[data-testid="reaction-users-loading"]')).toBeTruthy()

    resolveUsers([{ user_id: 'user-1', display_name: 'Alice', avatar_url: '' }])
    await flushAll()
    expect(document.body.textContent).toContain('Alice')

    await reactionButton!.trigger('mouseleave')
    vi.advanceTimersByTime(200)
    await flushAll()

    chatApiMocks.listMessageReactionUsers.mockRejectedValueOnce(new Error('boom'))
    await wrapper.setProps({
      message: {
        ...msg,
        reactions: [{ emoji: ':+1:', count: 2 }],
      },
    })
    await flushAll()

    await reactionButton!.trigger('mouseenter')
    await flushAll()
    const errorNode = document.body.querySelector('[data-testid="reaction-users-error"]')
    expect(errorNode).toBeTruthy()
    expect(errorNode?.textContent).toContain('Failed to load reactions')

    wrapper.unmount()
  })
})
