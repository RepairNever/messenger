/**
 * Bounds interactive auth and metadata calls without applying a short deadline
 * to potentially large attachment uploads or downloads.
 */
export const AUTH_REQUEST_TIMEOUT_MS = 20_000
export const CONVERSATION_HISTORY_REQUEST_TIMEOUT_MS = 20_000
