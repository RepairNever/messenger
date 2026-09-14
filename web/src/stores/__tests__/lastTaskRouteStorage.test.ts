import { beforeEach, describe, expect, it } from 'vitest'
import {
  loadLastOpenedTaskPublicId,
  saveLastOpenedTaskPublicId,
  clearLastOpenedTaskPublicId,
} from '@/services/storage/lastTaskRouteStorage'

describe('lastTaskRouteStorage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('stores and loads last opened task public id', () => {
    saveLastOpenedTaskPublicId('dev-123')
    expect(loadLastOpenedTaskPublicId()).toBe('DEV-123')
  })

  it('clears last opened task public id', () => {
    saveLastOpenedTaskPublicId('DEV-123')
    clearLastOpenedTaskPublicId()
    expect(loadLastOpenedTaskPublicId()).toBe('')
  })

  it('ignores legacy UUID values', () => {
    localStorage.setItem('msgnr:last-task-id:global:v1', '92f41023-40a9-42f7-a124-38d426e061ba')
    expect(loadLastOpenedTaskPublicId()).toBe('')
    expect(localStorage.getItem('msgnr:last-task-id:global:v1')).toBeNull()
  })

  it('migrates legacy public ids to the new key', () => {
    localStorage.setItem('msgnr:last-task-id:global:v1', 'dev-123')
    expect(loadLastOpenedTaskPublicId()).toBe('DEV-123')
    expect(localStorage.getItem('msgnr:last-task-id:global:v1')).toBeNull()
    expect(localStorage.getItem('msgnr:last-task-public-id:global:v2')).toBe('DEV-123')
  })
})
