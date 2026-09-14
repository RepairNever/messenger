import { describe, expect, it } from 'vitest'
import {
  SCREEN_ANNOTATION_FALLBACK_STROKE_COLOR,
  SCREEN_ANNOTATION_STROKE_COLORS,
  hexToRgbTriplet,
  resolveScreenAnnotationStrokeColor,
} from '@/utils/color'

describe('color utilities', () => {
  it('converts six-digit and shorthand hex colors to rgb triplets', () => {
    expect(hexToRgbTriplet('#2563EB')).toBe('37 99 235')
    expect(hexToRgbTriplet('#fff')).toBe('255 255 255')
  })

  it('returns a stable fallback for invalid colors', () => {
    expect(hexToRgbTriplet('nope')).toBe('0 0 0')
  })

  it('assigns stable screen annotation colors from participant identity', () => {
    expect(resolveScreenAnnotationStrokeColor('Ada Lovelace')).toBe(resolveScreenAnnotationStrokeColor('ada lovelace'))
    expect(SCREEN_ANNOTATION_STROKE_COLORS).toContain(resolveScreenAnnotationStrokeColor('grace@example.com'))
    const assigned = new Set(['ada', 'grace', 'linus', 'margaret'].map(resolveScreenAnnotationStrokeColor))
    expect(assigned.size).toBeGreaterThan(1)
  })

  it('falls back to a default screen annotation color for empty identity', () => {
    expect(resolveScreenAnnotationStrokeColor('')).toBe(SCREEN_ANNOTATION_FALLBACK_STROKE_COLOR)
    expect(resolveScreenAnnotationStrokeColor('   ')).toBe(SCREEN_ANNOTATION_FALLBACK_STROKE_COLOR)
  })
})
