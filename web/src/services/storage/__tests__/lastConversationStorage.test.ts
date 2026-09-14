import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearAllLastOpenedConversations,
  clearLastOpenedConversation,
  loadLastOpenedConversation,
  saveLastOpenedConversation,
} from '@/services/storage/lastConversationStorage'
import { storage } from '@/services/storage/storageAdapter'

describe('lastConversationStorage', () => {
  beforeEach(() => {
    storage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('prefers a scoped conversation and falls back to the global value', () => {
    saveLastOpenedConversation('', '', 'global-conversation')
    saveLastOpenedConversation('workspace-1', 'user-1', 'scoped-conversation')

    expect(loadLastOpenedConversation('workspace-1', 'user-1')).toBe('scoped-conversation')
    expect(loadLastOpenedConversation('workspace-2', 'user-2')).toBe('scoped-conversation')
  })

  it('treats failed reads as an empty persisted selection', () => {
    vi.spyOn(storage, 'getItem').mockImplementation(() => {
      throw new Error('storage unavailable')
    })

    expect(loadLastOpenedConversation('workspace-1', 'user-1')).toBe('')
  })

  it('does not throw when writes or removals fail', () => {
    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new Error('storage unavailable')
    })

    expect(() => saveLastOpenedConversation('workspace-1', 'user-1', 'conversation-1')).not.toThrow()

    vi.restoreAllMocks()
    vi.spyOn(storage, 'removeItem').mockImplementation(() => {
      throw new Error('storage unavailable')
    })

    expect(() => clearLastOpenedConversation('workspace-1', 'user-1')).not.toThrow()
    expect(() => clearAllLastOpenedConversations()).not.toThrow()
  })
})
