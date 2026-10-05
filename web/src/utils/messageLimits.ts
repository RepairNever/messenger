// Mirrors chat.MaxMessageBodyRunes in internal/chat/service.go. The backend is
// the source of truth and rejects over-limit bodies; these values keep the
// composer from offering a send that is guaranteed to fail.
export const MAX_MESSAGE_BODY_RUNES = 32000

export function messageBodyRuneCount(value: string): number {
  return [...value].length
}

export function isMessageBodyWithinLimit(value: string): boolean {
  return messageBodyRuneCount(value) <= MAX_MESSAGE_BODY_RUNES
}
