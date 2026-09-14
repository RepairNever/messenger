import type { UserCustomStatus as ProtoUserCustomStatus } from '@/shared/proto/packets_pb'

export interface UserCustomStatusDto {
  text: string
  emoji: string
  expires_at: string
}

export interface UserCustomStatus {
  text: string
  emoji: string
  expiresAt: string
}

export function userCustomStatusFromDto(
  dto: UserCustomStatusDto | null | undefined,
): UserCustomStatus | null {
  if (!dto) return null
  const text = String(dto.text ?? '').trim()
  const expiresAt = String(dto.expires_at ?? '').trim()
  if (!text || !expiresAt) return null
  const expiresMs = Date.parse(expiresAt)
  if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) return null
  return {
    text,
    emoji: String(dto.emoji ?? '').trim(),
    expiresAt: new Date(expiresMs).toISOString(),
  }
}

export function userCustomStatusFromProto(
  proto: ProtoUserCustomStatus | null | undefined,
): UserCustomStatus | null {
  if (!proto?.expiresAt) return null
  const text = String(proto.text ?? '').trim()
  if (!text) return null
  const seconds = Number(proto.expiresAt.seconds ?? 0n)
  const nanos = Number(proto.expiresAt.nanos ?? 0)
  const expiresMs = seconds * 1000 + Math.floor(nanos / 1_000_000)
  if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) return null
  return {
    text,
    emoji: String(proto.emoji ?? '').trim(),
    expiresAt: new Date(expiresMs).toISOString(),
  }
}

export function isUserCustomStatusActive(
  status: UserCustomStatus | null | undefined,
  nowMs = Date.now(),
): status is UserCustomStatus {
  if (!status) return false
  if (!status.text.trim()) return false
  const expiresMs = Date.parse(status.expiresAt)
  return Number.isFinite(expiresMs) && expiresMs > nowMs
}

export function formatUserCustomStatusExpiry(status: UserCustomStatus): string {
  const expiresAt = new Date(status.expiresAt)
  if (!Number.isFinite(expiresAt.getTime())) return ''
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(expiresAt)
}

export function formatUserCustomStatusTitle(status: UserCustomStatus): string {
  const expiry = formatUserCustomStatusExpiry(status)
  return expiry ? `${status.text} until ${expiry}` : status.text
}

export function userCustomStatusFromStored(raw: unknown): UserCustomStatus | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  return userCustomStatusFromDto({
    text: String(obj.text ?? ''),
    emoji: String(obj.emoji ?? ''),
    expires_at: String(obj.expiresAt ?? ''),
  })
}
