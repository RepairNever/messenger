import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import ForwardMessageDialog from '@/components/ForwardMessageDialog.vue'
import { useChatStore, type Message } from '@/stores/chat'

const chatApiMocks = vi.hoisted(() => ({
  listForwardTargets: vi.fn(),
  forwardMessage: vi.fn(),
  listSavedMessages: vi.fn(),
  saveMessage: vi.fn(),
  unsaveMessage: vi.fn(),
  listConversationMessages: vi.fn(),
  listDmCandidates: vi.fn(),
  listUnreadFeed: vi.fn(),
  resolveUnreadFeedNotification: vi.fn(),
  getMessageContext: vi.fn(),
}))

vi.mock('@/services/http/chatApi', () => ({
  listForwardTargets: chatApiMocks.listForwardTargets,
  forwardMessage: chatApiMocks.forwardMessage,
  listSavedMessages: chatApiMocks.listSavedMessages,
  saveMessage: chatApiMocks.saveMessage,
  unsaveMessage: chatApiMocks.unsaveMessage,
  listConversationMessages: chatApiMocks.listConversationMessages,
  listDmCandidates: chatApiMocks.listDmCandidates,
  listUnreadFeed: chatApiMocks.listUnreadFeed,
  resolveUnreadFeedNotification: chatApiMocks.resolveUnreadFeedNotification,
  getMessageContext: chatApiMocks.getMessageContext,
}))

function buildMessage(): Message {
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
  }
}

async function flushAll() {
  await Promise.resolve()
  await nextTick()
}

describe('ForwardMessageDialog', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    chatApiMocks.listForwardTargets.mockReset()
    chatApiMocks.listForwardTargets.mockResolvedValue({
      conversations: [
        { conversation_id: 'channel-2', title: 'General', kind: 'channel', visibility: 'public' },
        { conversation_id: 'channel-4', title: 'Alice', kind: 'dm', visibility: 'dm' },
      ],
      threads: [
        {
          conversation_id: 'channel-3',
          conversation_title: 'Project',
          thread_root_message_id: 'root-1',
          root_sender_name: 'Alice',
          root_body: 'Thread root',
          reply_count: 2,
          last_reply_at: '2026-03-06T00:00:00Z',
        },
      ],
    })
    chatApiMocks.forwardMessage.mockReset()
    chatApiMocks.forwardMessage.mockResolvedValue(undefined)
  })

  it('loads conversation targets when opened and ignores thread targets', async () => {
    const wrapper = mount(ForwardMessageDialog, {
      props: { open: true, message: buildMessage() },
      attachTo: document.body,
    })
    await flushAll()

    expect(chatApiMocks.listForwardTargets).toHaveBeenCalled()
    expect(document.body.textContent).toContain('General')
    expect(document.body.textContent).toContain('Alice')
    expect(document.body.textContent).not.toContain('Project')
    wrapper.unmount()
  })

  it('renders channels before DMs', async () => {
    chatApiMocks.listForwardTargets.mockResolvedValue({
      conversations: [
        { conversation_id: 'dm-1', title: 'Alice', kind: 'dm', visibility: 'dm' },
        { conversation_id: 'channel-1', title: 'Zebra', kind: 'channel', visibility: 'public' },
      ],
      threads: [],
    })
    const wrapper = mount(ForwardMessageDialog, {
      props: { open: true, message: buildMessage() },
      attachTo: document.body,
    })
    await flushAll()

    const targetButtons = Array.from(document.body.querySelectorAll('button')).filter(button =>
      button.textContent?.includes('Alice') || button.textContent?.includes('Zebra'),
    )
    expect(targetButtons.map(button => button.textContent)).toEqual([
      expect.stringContaining('Zebra'),
      expect.stringContaining('Alice'),
    ])
    wrapper.unmount()
  })

  it('forwards to a selected conversation target', async () => {
    const chat = useChatStore()
    const wrapper = mount(ForwardMessageDialog, {
      props: { open: true, message: buildMessage() },
      attachTo: document.body,
    })
    await flushAll()

    const generalButton = Array.from(document.body.querySelectorAll('button')).find(button => button.textContent?.includes('General')) as HTMLButtonElement
    generalButton.click()
    await flushAll()
    const forwardButton = Array.from(document.body.querySelectorAll('button')).find(button => button.textContent === 'Forward') as HTMLButtonElement
    forwardButton.click()
    await flushAll()

    expect(chatApiMocks.forwardMessage).toHaveBeenCalledWith('message-1', 'channel-2', '')
    expect(chat.toast?.message).toBe('Message forwarded')
    wrapper.unmount()
  })

  it('clears the selected target when the search query changes', async () => {
    const wrapper = mount(ForwardMessageDialog, {
      props: { open: true, message: buildMessage() },
      attachTo: document.body,
    })
    await flushAll()

    const generalButton = Array.from(document.body.querySelectorAll('button')).find(button => button.textContent?.includes('General')) as HTMLButtonElement
    generalButton.click()
    await flushAll()
    const input = document.body.querySelector('input') as HTMLInputElement
    input.value = 'Missing'
    input.dispatchEvent(new Event('input'))
    await flushAll()

    const forwardButton = Array.from(document.body.querySelectorAll('button')).find(button => button.textContent === 'Forward') as HTMLButtonElement
    expect(forwardButton.disabled).toBe(true)
    expect(chatApiMocks.forwardMessage).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
