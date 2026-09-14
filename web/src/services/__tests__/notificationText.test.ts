import { describe, expect, it } from 'vitest'

import { decodeNotificationText, normalizePushNotificationDisplayText } from '@/services/notificationText'

describe('decodeNotificationText', () => {
  it('returns empty text for missing values', () => {
    expect(decodeNotificationText(null)).toBe('')
    expect(decodeNotificationText(undefined)).toBe('')
    expect(decodeNotificationText('')).toBe('')
  })

  it('decodes JSON-style notification escapes into plain text', () => {
    expect(decodeNotificationText('Mention \\/ \\"Boss\\" \\u263A')).toBe('Mention / "Boss" \u263A')
    expect(decodeNotificationText('Line 1\\\\nLine 2\\/done\\\\folder')).toBe('Line 1\nLine 2/done\\folder')
  })

  it('decodes multiline and tab notification escapes', () => {
    expect(decodeNotificationText(String.raw`Line 1\nLine 2\tTabbed\rDone`)).toBe('Line 1\nLine 2\tTabbed\rDone')
  })

  it('decodes double-encoded notification escapes', () => {
    expect(decodeNotificationText(String.raw`Line 1\\nLine 2\\/done \\u263A`)).toBe('Line 1\nLine 2/done \u263A')
  })

  it('decodes generated Markdown escapes in notification text', () => {
    expect(decodeNotificationText(String.raw`d\_trades\_done\_amount = 2, current\_limit\_reached = TRUE\.`))
      .toBe('d_trades_done_amount = 2, current_limit_reached = TRUE.')
  })

  it('preserves unknown escape sequences', () => {
    expect(decodeNotificationText(String.raw`Keep \q and \z visible`)).toBe(String.raw`Keep \q and \z visible`)
    expect(decodeNotificationText(String.raw`Bad unicode \u12xz stays`)).toBe(String.raw`Bad unicode \u12xz stays`)
  })

  it('keeps literal backslashes as plain text', () => {
    expect(decodeNotificationText(String.raw`C:\\folder\\file \\\\server`)).toBe(String.raw`C:\folder\file \\server`)
  })

  it('normalizes service-worker push display text', () => {
    expect(normalizePushNotificationDisplayText({
      title: String.raw`Mention from \"Bob\"`,
      body: String.raw`Escaped\\nmessage \\/ done`,
    })).toEqual({
      title: 'Mention from "Bob"',
      body: 'Escaped\nmessage / done',
    })
  })
})
