import { storage } from '@/services/storage/storageAdapter'

const DOCUMENTS_TEAMSPACE_COLLAPSED_KEY = 'msgnr:documents:teamspace-collapsed:v1'

export function loadCollapsedDocumentsTeamspaceIds(): string[] {
  const raw = storage.getItem(DOCUMENTS_TEAMSPACE_COLLAPSED_KEY)
  if (!raw) return []
  try {
    const decoded = JSON.parse(raw)
    if (!Array.isArray(decoded)) return []
    return decoded.filter((value): value is string => typeof value === 'string' && value.trim() !== '')
  } catch {
    return []
  }
}

export function saveCollapsedDocumentsTeamspaceIds(teamspaceIds: string[]) {
  const unique = Array.from(new Set(teamspaceIds.filter(id => id.trim() !== '')))
  storage.setItem(DOCUMENTS_TEAMSPACE_COLLAPSED_KEY, JSON.stringify(unique))
}

export function clearCollapsedDocumentsTeamspaceIds() {
  storage.removeItem(DOCUMENTS_TEAMSPACE_COLLAPSED_KEY)
}
