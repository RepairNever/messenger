import { storage } from '@/services/storage/storageAdapter'

const DOCUMENTS_NODE_COLLAPSED_KEY = 'msgnr:documents:node-collapsed:v1'

export function loadCollapsedDocumentsNodeIds(): string[] {
  const raw = storage.getItem(DOCUMENTS_NODE_COLLAPSED_KEY)
  if (!raw) return []
  try {
    const decoded = JSON.parse(raw)
    if (!Array.isArray(decoded)) return []
    return decoded.filter((value): value is string => typeof value === 'string' && value.trim() !== '')
  } catch {
    return []
  }
}

export function saveCollapsedDocumentsNodeIds(documentIds: string[]) {
  const unique = Array.from(new Set(documentIds.filter(id => id.trim() !== '')))
  storage.setItem(DOCUMENTS_NODE_COLLAPSED_KEY, JSON.stringify(unique))
}

export function clearCollapsedDocumentsNodeIds() {
  storage.removeItem(DOCUMENTS_NODE_COLLAPSED_KEY)
}
