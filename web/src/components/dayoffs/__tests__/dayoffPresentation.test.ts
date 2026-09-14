import { describe, expect, it } from 'vitest'
import { dayoffTypePresentation } from '@/components/dayoffs/dayoffPresentation'

describe('dayoff type presentation', () => {
  it('uses the agreed green for Vacation in the calendar and legend', () => {
    expect(dayoffTypePresentation('vacation').barStyle.backgroundColor).toBe('#298020')
    expect(dayoffTypePresentation('vacation').style.color).toBe('#298020')
  })
})
