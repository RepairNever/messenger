import { AxiosError } from 'axios'
import { createAuthenticatedClient } from './client'
import type { UserCustomStatusDto } from '@/types/userStatus'

const http = createAuthenticatedClient()

export class DocumentsApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message)
    this.name = 'DocumentsApiError'
  }
}

function handleError(e: unknown): never {
  if (e instanceof AxiosError && e.response) {
    const message: string = e.response.data?.error ?? e.response.statusText
    throw new DocumentsApiError(message, e.response.status)
  }
  throw new DocumentsApiError('Network error', 0)
}

async function apiCall<T>(request: Promise<{ data: T }>): Promise<T> {
  try {
    const { data } = await request
    return data
  } catch (e) { return handleError(e) }
}

async function apiCallNoContent(request: Promise<unknown>): Promise<void> {
  try {
    await request
  } catch (e) { return handleError(e) }
}

export interface TeamspaceMemberPreview {
  id: string
  display_name: string
  avatar_url: string
  custom_status?: UserCustomStatusDto | null
}

export interface Teamspace {
  id: string
  name: string
  owner_user_id: string
  is_private: boolean
  is_member: boolean
  is_owner: boolean
  can_manage: boolean
  member_count: number
  members: TeamspaceMemberPreview[]
  created_at: string
  updated_at: string
}

export interface SidebarDocumentNode {
  id: string
  teamspace_id: string
  parent_document_id: string | null
  title: string
  is_favorite: boolean
  favorited_at: string | null
  children: SidebarDocumentNode[]
}

export interface SidebarTeamspace {
  id: string
  name: string
  documents: SidebarDocumentNode[]
}

export interface DocumentItem {
  id: string
  teamspace_id: string
  teamspace_name: string
  parent_document_id: string | null
  parent_title: string | null
  title: string
  content_markdown: string | null
  created_by: string
  updated_by: string
  created_at: string
  updated_at: string
}

export interface DocumentSearchResult {
  id: string
  teamspace_id: string
  teamspace_name: string
  title: string
  snippet: string
}

export interface DocumentFavoriteResponse {
  document_id: string
  is_favorite: boolean
  favorited_at?: string | null
}

export interface DocumentHistoryEditor {
  id: string
  display_name: string
  avatar_url: string
  custom_status?: UserCustomStatusDto | null
}

export interface DocumentHistoryItem {
  title: string
  content_markdown: string | null
  edited_by: string
  created_at: string
  editor: DocumentHistoryEditor
}

export interface DocumentAttachment {
  id: string
  document_id: string
  file_name: string
  file_size: number
  mime_type: string
  uploaded_by: string
  created_at: string
}

export interface UpsertTeamspacePayload {
  name: string
  is_private: boolean
  member_ids: string[]
}

export interface CreateDocumentPayload {
  teamspace_id: string
  parent_document_id?: string | null
  title: string
  content_markdown?: string | null
}

export interface UpdateDocumentPayload {
  title?: string
  content_markdown?: string | null
}

export interface UpdateDocumentContentPayload {
  content_markdown: string | null
  force_snapshot?: boolean
}

export async function documentsListTeamspaces(): Promise<Teamspace[]> {
  return apiCall(http.get<Teamspace[]>('/api/documents/teamspaces'))
}

export async function documentsCreateTeamspace(payload: UpsertTeamspacePayload): Promise<Teamspace> {
  return apiCall(http.post<Teamspace>('/api/documents/teamspaces', payload))
}

export async function documentsUpdateTeamspace(id: string, payload: UpsertTeamspacePayload): Promise<Teamspace> {
  return apiCall(http.patch<Teamspace>(`/api/documents/teamspaces/${id}`, payload))
}

export async function documentsDeleteTeamspace(id: string): Promise<void> {
  return apiCallNoContent(http.delete(`/api/documents/teamspaces/${id}`))
}

export async function documentsJoinTeamspace(id: string): Promise<Teamspace> {
  return apiCall(http.post<Teamspace>(`/api/documents/teamspaces/${id}/join`))
}

export async function documentsListSidebar(): Promise<SidebarTeamspace[]> {
  return apiCall(http.get<SidebarTeamspace[]>('/api/documents/sidebar'))
}

export async function documentsSearchDocuments(query: string): Promise<DocumentSearchResult[]> {
  return apiCall(http.get<DocumentSearchResult[]>('/api/documents/search', {
    params: { q: query },
  }))
}

export async function documentsCreateDocument(payload: CreateDocumentPayload): Promise<DocumentItem> {
  return apiCall(http.post<DocumentItem>('/api/documents', payload))
}

export async function documentsGetDocument(id: string): Promise<DocumentItem> {
  return apiCall(http.get<DocumentItem>(`/api/documents/${id}`))
}

export async function documentsUpdateDocument(id: string, payload: UpdateDocumentPayload): Promise<DocumentItem> {
  return apiCall(http.patch<DocumentItem>(`/api/documents/${id}`, payload))
}

export async function documentsUpdateDocumentContent(id: string, payload: UpdateDocumentContentPayload): Promise<DocumentItem> {
  return apiCall(http.patch<DocumentItem>(`/api/documents/${id}/content`, payload))
}

export async function documentsDeleteDocument(id: string): Promise<void> {
  return apiCallNoContent(http.delete(`/api/documents/${id}`))
}

export async function documentsFavoriteDocument(id: string): Promise<DocumentFavoriteResponse> {
  return apiCall(http.post<DocumentFavoriteResponse>(`/api/documents/${id}/favorite`))
}

export async function documentsUnfavoriteDocument(id: string): Promise<DocumentFavoriteResponse> {
  return apiCall(http.delete<DocumentFavoriteResponse>(`/api/documents/${id}/favorite`))
}

export async function documentsListDocumentHistory(id: string): Promise<DocumentHistoryItem[]> {
  return apiCall(http.get<DocumentHistoryItem[]>(`/api/documents/${id}/history`))
}

export async function documentsListAttachments(id: string): Promise<DocumentAttachment[]> {
  return apiCall(http.get<DocumentAttachment[]>(`/api/documents/${id}/attachments`))
}

export async function documentsUploadAttachment(id: string, file: File): Promise<DocumentAttachment> {
  const form = new FormData()
  form.append('file', file, file.name)
  return apiCall(http.post<DocumentAttachment>(
    `/api/documents/${id}/attachments`,
    form,
    { headers: { 'Content-Type': 'multipart/form-data' } },
  ))
}

export async function documentsDeleteAttachment(id: string, attachmentId: string): Promise<void> {
  return apiCallNoContent(http.delete(`/api/documents/${id}/attachments/${attachmentId}`))
}

export async function documentsFetchAttachmentBlob(id: string, attachmentId: string): Promise<Blob> {
  return apiCall(http.get<Blob>(
    `/api/documents/${id}/attachments/${attachmentId}/download`,
    { responseType: 'blob' },
  ))
}
