import type { SidebarDocumentNode } from '@/services/http/documentsApi'

export function normalizeDocumentNodes(nodes: SidebarDocumentNode[] | null | undefined): SidebarDocumentNode[] {
  return Array.isArray(nodes) ? nodes.filter((node): node is SidebarDocumentNode => !!node) : []
}
