import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearClientInstanceId,
  getClientInstanceId,
  getOrCreateClientInstanceId,
} from '@/services/storage/clientInstanceStorage'

describe('clientInstanceStorage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('persists generated client instance id and reuses it', () => {
    const first = getOrCreateClientInstanceId()
    const second = getOrCreateClientInstanceId()

    expect(first).toBeTruthy()
    expect(second).toBe(first)
    expect(getClientInstanceId()).toBe(first)
  })

  it('clears persisted client instance id', () => {
    const first = getOrCreateClientInstanceId()
    expect(getClientInstanceId()).toBe(first)

    clearClientInstanceId()

    expect(getClientInstanceId()).toBeNull()
    const second = getOrCreateClientInstanceId()
    expect(second).not.toBe(first)
  })
})
