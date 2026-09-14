import { AxiosError } from 'axios'
import { createAuthenticatedClient } from './client'
import { AUTH_REQUEST_TIMEOUT_MS } from './timeouts'
import type { UserCustomStatusDto } from '@/types/userStatus'

const http = createAuthenticatedClient()

export interface UserDto {
  id: string
  email: string
  display_name: string
  avatar_url?: string
  role: string
  need_change_password?: boolean
  custom_status?: UserCustomStatusDto | null
}

export interface LoginResponse {
  access_token: string
  refresh_token: string
  expires_in_sec: number
  user: UserDto
}

export interface RefreshResponse {
  access_token: string
  refresh_token: string
  expires_in_sec: number
}

export interface UpdateProfileRequest {
  display_name?: string
  email?: string
}

export interface SetCustomStatusRequest {
  text: string
  emoji?: string
  expires_at: string
}

export class AuthApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message)
    this.name = 'AuthApiError'
  }
}

function handleError(e: unknown): never {
  if (e instanceof AxiosError && e.response) {
    const msg: string = e.response.data?.error ?? e.response.statusText
    throw new AuthApiError(msg, e.response.status)
  }
  throw new AuthApiError('Network error', 0)
}

export async function apiLogin(email: string, password: string): Promise<LoginResponse> {
  try {
    const { data } = await http.post<LoginResponse>(
      '/api/auth/login',
      { email, password },
      { timeout: AUTH_REQUEST_TIMEOUT_MS },
    )
    return data
  } catch (e) {
    handleError(e)
  }
}

export async function apiRefresh(refreshToken: string): Promise<RefreshResponse> {
  try {
    const { data } = await http.post<RefreshResponse>(
      '/api/auth/refresh',
      { refresh_token: refreshToken },
      { timeout: AUTH_REQUEST_TIMEOUT_MS },
    )
    return data
  } catch (e) {
    handleError(e)
  }
}

export async function apiLogout(refreshToken: string): Promise<void> {
  try {
    await http.post('/api/auth/logout', { refresh_token: refreshToken })
  } catch (e) {
    handleError(e)
  }
}

export async function apiGetProfile(): Promise<UserDto> {
  try {
    const { data } = await http.get<{ user: UserDto }>('/api/auth/profile')
    return data.user
  } catch (e) {
    handleError(e)
  }
}

export async function apiUpdateProfile(payload: UpdateProfileRequest): Promise<UserDto> {
  try {
    const { data } = await http.patch<{ user: UserDto }>('/api/auth/profile', payload)
    return data.user
  } catch (e) {
    handleError(e)
  }
}

export async function apiChangePassword(newPassword: string): Promise<void> {
  try {
    await http.post('/api/auth/change-password', { new_password: newPassword })
  } catch (e) {
    handleError(e)
  }
}

export async function apiUploadAvatar(file: File): Promise<UserDto> {
  try {
    const form = new FormData()
    form.append('avatar', file)
    const { data } = await http.post<{ user: UserDto }>('/api/auth/avatar', form)
    return data.user
  } catch (e) {
    handleError(e)
  }
}

export async function apiRemoveAvatar(): Promise<UserDto> {
  try {
    const { data } = await http.delete<{ user: UserDto }>('/api/auth/avatar')
    return data.user
  } catch (e) {
    handleError(e)
  }
}

export async function apiSetCustomStatus(payload: SetCustomStatusRequest): Promise<UserDto> {
  try {
    const { data } = await http.put<{ user: UserDto }>('/api/auth/custom-status', payload)
    return data.user
  } catch (e) {
    handleError(e)
  }
}

export async function apiClearCustomStatus(): Promise<UserDto> {
  try {
    const { data } = await http.delete<{ user: UserDto }>('/api/auth/custom-status')
    return data.user
  } catch (e) {
    handleError(e)
  }
}
