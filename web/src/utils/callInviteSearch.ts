export interface CallInviteSearchable {
  displayName: string
  email: string
}

export function normalizeCallInviteSearchQuery(value: string): string {
  return value.trim().toLowerCase()
}

export function matchesCallInviteSearch(item: CallInviteSearchable, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true
  return item.displayName.trim().toLowerCase().includes(normalizedQuery)
    || item.email.trim().toLowerCase().includes(normalizedQuery)
}
