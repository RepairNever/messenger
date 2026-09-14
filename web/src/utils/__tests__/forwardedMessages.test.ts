import { describe, expect, it } from 'vitest'
import { formatForwardedMessageLabel } from '@/utils/forwardedMessages'

describe('formatForwardedMessageLabel', () => {
  it('prefixes channel sources with #', () => {
    expect(formatForwardedMessageLabel({
      senderName: 'Alice',
      conversationKind: 'channel',
      conversationTitle: 'general',
    })).toBe('Forwarded from Alice in #general')
  })

  it('prefixes DM sources with @', () => {
    expect(formatForwardedMessageLabel({
      senderName: 'Alice',
      conversationKind: 'dm',
      conversationTitle: 'Bob',
    })).toBe('Forwarded from Alice in @Bob')
  })
})
