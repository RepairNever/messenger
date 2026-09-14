import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearAllChatDrafts,
  clearChatDraft,
  getChatDraftScopeKey,
  loadChatDraft,
  saveChatDraft,
  type ChatDraftScope,
} from '@/services/storage/chatDraftStorage'

describe('chatDraftStorage', () => {
  const conversationScope: ChatDraftScope = {
    kind: 'conversation',
    conversationId: 'conversation-1',
  }
  const threadScope: ChatDraftScope = {
    kind: 'thread',
    conversationId: 'conversation-1',
    rootMessageId: 'root-1',
  }

  beforeEach(() => {
    localStorage.clear()
  })

  it('loads an empty draft when storage is missing', () => {
    expect(loadChatDraft(conversationScope)).toEqual({
      body: '',
      entities: [],
    })
  })

  it('recovers safely from malformed JSON', () => {
    localStorage.setItem('msgnr:chat:drafts:v1', '{bad json')

    expect(loadChatDraft(conversationScope)).toEqual({
      body: '',
      entities: [],
    })
  })

  it('saves and reloads a conversation draft with entities', () => {
    saveChatDraft(conversationScope, {
      body: 'Hello @Ada',
      entities: [{
        kind: 'user',
        targetId: 'user-1',
        label: '@Ada',
        href: '',
        start: 6,
        end: 10,
      }],
    })

    expect(loadChatDraft(conversationScope)).toEqual({
      body: 'Hello @Ada',
      entities: [{
        kind: 'user',
        targetId: 'user-1',
        label: '@Ada',
        href: '',
        start: 6,
        end: 10,
      }],
    })
  })

  it('saves thread drafts independently from conversation drafts', () => {
    saveChatDraft(conversationScope, {
      body: 'Main draft',
      entities: [],
    })
    saveChatDraft(threadScope, {
      body: 'Thread draft',
      entities: [],
    })

    expect(loadChatDraft(conversationScope).body).toBe('Main draft')
    expect(loadChatDraft(threadScope).body).toBe('Thread draft')
  })

  it('removes only the targeted entry when a draft becomes empty', () => {
    saveChatDraft(conversationScope, {
      body: 'Main draft',
      entities: [],
    })
    saveChatDraft(threadScope, {
      body: 'Thread draft',
      entities: [],
    })

    saveChatDraft(conversationScope, {
      body: '   ',
      entities: [],
    })

    expect(loadChatDraft(conversationScope)).toEqual({
      body: '',
      entities: [],
    })
    expect(loadChatDraft(threadScope).body).toBe('Thread draft')
  })

  it('clears a targeted draft explicitly', () => {
    saveChatDraft(conversationScope, {
      body: 'Main draft',
      entities: [],
    })

    clearChatDraft(conversationScope)

    expect(loadChatDraft(conversationScope)).toEqual({
      body: '',
      entities: [],
    })
  })

  it('clears all chat drafts', () => {
    saveChatDraft(conversationScope, {
      body: 'Main draft',
      entities: [],
    })
    saveChatDraft(threadScope, {
      body: 'Thread draft',
      entities: [],
    })

    clearAllChatDrafts()

    expect(localStorage.getItem('msgnr:chat:drafts:v1')).toBeNull()
  })

  it('uses deterministic scope keys for conversation and thread drafts', () => {
    expect(getChatDraftScopeKey(conversationScope)).toBe('conversation:conversation-1')
    expect(getChatDraftScopeKey(threadScope)).toBe('thread:conversation-1:root-1')
  })
})
