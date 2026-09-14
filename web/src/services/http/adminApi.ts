import { AxiosError } from 'axios'
import { createAuthenticatedClient } from './client'

const http = createAuthenticatedClient()

export class AdminApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message)
    this.name = 'AdminApiError'
  }
}

function handleError(e: unknown): never {
  if (e instanceof AxiosError && e.response) {
    const msg: string = e.response.data?.error ?? e.response.statusText
    throw new AdminApiError(msg, e.response.status)
  }
  throw new AdminApiError('Network error', 0)
}

// ---- Types ----

export interface AdminUser {
  id: string
  email: string
  display_name: string
  avatar_url?: string
  role: 'owner' | 'admin' | 'member' | 'bot'
  status: 'active' | 'blocked'
  need_change_password: boolean
  created_at: string
}

export interface AdminChannel {
  id: string
  kind: 'dm' | 'channel'
  name: string | null
  visibility: 'dm' | 'public' | 'private'
  is_archived: boolean
  created_at: string
}

export interface AdminLog {
  time: string
  level: string
  msg: string
  [key: string]: unknown
}

export interface CreateUserPayload {
  email: string
  password: string
  display_name?: string
  role?: 'admin' | 'member' | 'bot'
  need_change_password?: boolean
}

export interface UpdateUserPayload {
  display_name: string
  email: string
  role: 'admin' | 'member' | 'bot'
  password?: string
  integration_token?: string
}

export interface CreateChannelPayload {
  name: string
  kind?: 'channel'
  visibility?: 'public' | 'private'
  add_all_users?: boolean
  member_ids?: string[]
}

export interface RenameChannelPayload {
  name: string
}

// ---- Users ----

export async function adminListUsers(): Promise<AdminUser[]> {
  try {
    const { data } = await http.get<AdminUser[]>('/api/admin/users')
    return data
  } catch (e) { handleError(e) }
}

export async function adminCreateUser(payload: CreateUserPayload): Promise<AdminUser> {
  try {
    const { data } = await http.post<AdminUser>('/api/admin/users', payload)
    return data
  } catch (e) { handleError(e) }
}

export async function adminUpdateUser(id: string, payload: UpdateUserPayload): Promise<AdminUser> {
  try {
    const { data } = await http.patch<AdminUser>(`/api/admin/users/${id}`, payload)
    return data
  } catch (e) { handleError(e) }
}

export async function adminBlockUser(id: string): Promise<void> {
  try {
    await http.post(`/api/admin/users/${id}/block`)
  } catch (e) { handleError(e) }
}

export async function adminUnblockUser(id: string): Promise<void> {
  try {
    await http.post(`/api/admin/users/${id}/unblock`)
  } catch (e) { handleError(e) }
}

export async function adminSetNeedChangePassword(id: string, value: boolean): Promise<AdminUser> {
  try {
    const { data } = await http.post<AdminUser>(`/api/admin/users/${id}/set-need-change-password`, { need_change_password: value })
    return data
  } catch (e) { handleError(e) }
}

// ---- Channels ----

export async function adminListChannels(): Promise<AdminChannel[]> {
  try {
    const { data } = await http.get<AdminChannel[]>('/api/admin/channels')
    return data
  } catch (e) { handleError(e) }
}

export async function adminCreateChannel(payload: CreateChannelPayload): Promise<AdminChannel> {
  try {
    const { data } = await http.post<AdminChannel>('/api/admin/channels', payload)
    return data
  } catch (e) { handleError(e) }
}

export async function adminRenameChannel(channelId: string, payload: RenameChannelPayload): Promise<AdminChannel> {
  try {
    const { data } = await http.patch<AdminChannel>(`/api/admin/channels/${channelId}`, payload)
    return data
  } catch (e) { handleError(e) }
}

export async function adminDeleteChannel(id: string): Promise<void> {
  try {
    await http.delete(`/api/admin/channels/${id}`)
  } catch (e) { handleError(e) }
}

// ---- Logs ----

export async function adminGetLogs(lines?: number): Promise<AdminLog[]> {
  try {
    const { data } = await http.get<AdminLog[]>('/api/admin/logs', {
      params: lines ? { lines } : undefined,
    })
    return data
  } catch (e) { handleError(e) }
}
