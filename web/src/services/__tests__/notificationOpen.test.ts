import { describe, expect, it } from 'vitest'
import {
  buildNotificationOpenUrl,
  notificationOpenIntentFromMessage,
  notificationOpenIntentFromQuery,
  stripNotificationOpenQuery,
  toNotificationOpenMessage,
} from '@/services/notificationOpen'

describe('notificationOpen helpers', () => {
  it('builds a cold-start URL with one-shot notification query params', () => {
    const url = buildNotificationOpenUrl('/', {
      conversationId: 'dm-1',
      messageId: 'msg-1',
    }, 'https://app.example.com')

    expect(url).toBe('https://app.example.com/?notificationOpen=1&conversationId=dm-1&messageId=msg-1')
  })

  it('carries thread root IDs through cold-start URLs', () => {
    const url = buildNotificationOpenUrl('/', {
      conversationId: 'dm-1',
      messageId: 'reply-1',
      threadRootMessageId: 'root-1',
    }, 'https://app.example.com')

    expect(url).toBe('https://app.example.com/?notificationOpen=1&conversationId=dm-1&messageId=reply-1&threadRootMessageId=root-1')
  })

  it('parses a notification-open message payload', () => {
    const parsed = notificationOpenIntentFromMessage(toNotificationOpenMessage({
      conversationId: 'dm-1',
      messageId: 'msg-1',
      url: '/',
    }))

    expect(parsed).toEqual({
      conversationId: 'dm-1',
      messageId: 'msg-1',
      url: '/',
    })
  })

  it('parses a notification-open thread payload', () => {
    const parsed = notificationOpenIntentFromMessage(toNotificationOpenMessage({
      conversationId: 'dm-1',
      messageId: 'reply-1',
      threadRootMessageId: 'root-1',
      url: '/',
    }))

    expect(parsed).toEqual({
      conversationId: 'dm-1',
      messageId: 'reply-1',
      threadRootMessageId: 'root-1',
      url: '/',
    })
  })

  it('parses the startup query params and strips them after consume', () => {
    const query = {
      notificationOpen: '1',
      conversationId: 'dm-1',
      messageId: 'msg-1',
      threadRootMessageId: 'root-1',
      keep: 'value',
    }

    expect(notificationOpenIntentFromQuery(query)).toEqual({
      conversationId: 'dm-1',
      messageId: 'msg-1',
      threadRootMessageId: 'root-1',
    })
    expect(stripNotificationOpenQuery(query)).toEqual({ keep: 'value' })
  })
})
