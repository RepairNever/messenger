import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearManualPresencePreference,
  loadManualPresencePreference,
  saveManualPresencePreference,
} from '@/services/storage/manualPresenceStorage'

describe('manualPresenceStorage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('stores and loads manual presence preference', () => {
    saveManualPresencePreference('away')
    expect(loadManualPresencePreference()).toBe('away')
  })

  it('clears manual presence preference', () => {
    saveManualPresencePreference('online')
    clearManualPresencePreference()
    expect(loadManualPresencePreference()).toBeNull()
  })
})
