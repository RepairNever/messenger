export function hexToRgbTriplet(hex: string): string {
  const normalized = hex.trim().replace(/^#/, '')
  const value = normalized.length === 3
    ? normalized.split('').map((part) => part + part).join('')
    : normalized
  const intValue = Number.parseInt(value, 16)
  if (!Number.isFinite(intValue)) return '0 0 0'
  return [
    (intValue >> 16) & 255,
    (intValue >> 8) & 255,
    intValue & 255,
  ].join(' ')
}

export const SCREEN_ANNOTATION_STROKE_COLORS = [
  '#f59e0b',
  '#22c55e',
  '#38bdf8',
  '#a78bfa',
  '#f472b6',
  '#fb7185',
  '#2dd4bf',
  '#facc15',
] as const

export const SCREEN_ANNOTATION_FALLBACK_STROKE_COLOR = SCREEN_ANNOTATION_STROKE_COLORS[0]

export function resolveScreenAnnotationStrokeColor(identity: string): string {
  const normalized = identity.trim().toLowerCase()
  if (!normalized) return SCREEN_ANNOTATION_FALLBACK_STROKE_COLOR

  let hash = 2166136261
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  const colorIndex = Math.abs(hash >>> 0) % SCREEN_ANNOTATION_STROKE_COLORS.length
  return SCREEN_ANNOTATION_STROKE_COLORS[colorIndex] ?? SCREEN_ANNOTATION_FALLBACK_STROKE_COLOR
}
