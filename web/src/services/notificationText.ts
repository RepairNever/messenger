const SIMPLE_NOTIFICATION_ESCAPES: Record<string, string> = {
  '"': '"',
  '\'': '\'',
  '/': '/',
  '\\': '\\',
  n: '\n',
  r: '\r',
  t: '\t',
}

// These were emitted by the task Markdown serializer before ordinary text
// escaping was removed. Decode them for display in notifications.
const MARKDOWN_NOTIFICATION_ESCAPES = new Set('`*_{}[]()#+-.!>|')

interface DecodedEscape {
  value: string
  length: number
}

function decodeEscapeAt(input: string, slashIndex: number, slashCount: 1 | 2): DecodedEscape | null {
  const tokenIndex = slashIndex + slashCount
  const token = input[tokenIndex]
  if (!token) return null

  if (token === 'u') {
    const hex = input.slice(tokenIndex + 1, tokenIndex + 5)
    if (/^[0-9a-fA-F]{4}$/.test(hex)) {
      return {
        value: String.fromCharCode(parseInt(hex, 16)),
        length: slashCount + 5,
      }
    }
    return null
  }

  const value = SIMPLE_NOTIFICATION_ESCAPES[token]
  if (value !== undefined) {
    return {
      value,
      length: slashCount + 1,
    }
  }

  if (MARKDOWN_NOTIFICATION_ESCAPES.has(token)) {
    return {
      value: token,
      length: slashCount + 1,
    }
  }

  return null
}

export function decodeNotificationText(input: string | undefined | null): string {
  if (!input) return ''

  let out = ''
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]
    if (char !== '\\') {
      out += char
      continue
    }

    if (input[i + 1] === '\\') {
      const decoded = decodeEscapeAt(input, i, 2)
      if (decoded) {
        out += decoded.value
        i += decoded.length - 1
        continue
      }
      out += '\\'
      i += 1
      continue
    }

    const decoded = decodeEscapeAt(input, i, 1)
    if (decoded) {
      out += decoded.value
      i += decoded.length - 1
      continue
    }

    out += char
  }

  return out
}

export interface PushNotificationDisplayPayload {
  title: string
  body: string
}

export function normalizePushNotificationDisplayText(
  input: { title?: string | null; body?: string | null },
): PushNotificationDisplayPayload {
  return {
    title: decodeNotificationText(input.title),
    body: decodeNotificationText(input.body),
  }
}
