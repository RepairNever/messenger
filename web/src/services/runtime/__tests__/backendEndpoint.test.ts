import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearBackendBaseUrl,
  getBackendBaseUrl,
  hasBackendBaseUrl,
  isValidBackendBaseUrl,
  normalizeBackendBaseUrl,
  resolveApiBaseUrl,
  resolveWsUrl,
  setBackendBaseUrl,
} from '@/services/runtime/backendEndpoint'

describe('backendEndpoint runtime config', () => {
  beforeEach(() => {
    clearBackendBaseUrl()
    delete (window as Window & { __TAURI__?: unknown }).__TAURI__
  })

  it('normalizes valid backend URLs', () => {
    expect(normalizeBackendBaseUrl('https://chat.example.com/')).toBe('https://chat.example.com')
    expect(normalizeBackendBaseUrl('http://localhost:8080///')).toBe('http://localhost:8080')
    expect(normalizeBackendBaseUrl('https://chat.example.com/msgnr/')).toBe('https://chat.example.com/msgnr')
    expect(normalizeBackendBaseUrl('ftp://host')).toBeNull()
    expect(normalizeBackendBaseUrl('not-a-url')).toBeNull()
    expect(normalizeBackendBaseUrl('https://chat.example.com?source=desktop')).toBeNull()
    expect(normalizeBackendBaseUrl('https://chat.example.com#fragment')).toBeNull()
    expect(normalizeBackendBaseUrl('https://user:pass@chat.example.com')).toBeNull()
  })

  it('stores and reads backend URL', () => {
    setBackendBaseUrl('https://chat.example.com/')
    expect(hasBackendBaseUrl()).toBe(true)
    expect(getBackendBaseUrl()).toBe('https://chat.example.com')
    expect(isValidBackendBaseUrl(getBackendBaseUrl())).toBe(true)
  })

  it('uses relative endpoints in browser runtime by default', () => {
    expect(resolveApiBaseUrl()).toBe('/')
    expect(resolveWsUrl()).toBe('/ws')
  })

  it('derives API and WS URLs from configured backend in tauri runtime', () => {
    ;(window as Window & { __TAURI__?: unknown }).__TAURI__ = {}
    setBackendBaseUrl('https://corp-chat.internal')

    expect(resolveApiBaseUrl()).toBe('https://corp-chat.internal')
    expect(resolveWsUrl()).toBe('wss://corp-chat.internal/ws')
  })

  it('preserves a configured deployment path when deriving the tauri WS URL', () => {
    ;(window as Window & { __TAURI__?: unknown }).__TAURI__ = {}
    setBackendBaseUrl('http://corp-chat.internal/msgnr/')

    expect(resolveApiBaseUrl()).toBe('http://corp-chat.internal/msgnr')
    expect(resolveWsUrl()).toBe('ws://corp-chat.internal/msgnr/ws')
  })
})
