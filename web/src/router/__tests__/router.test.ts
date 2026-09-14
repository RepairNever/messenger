import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import * as tokenStorage from '@/services/storage/tokenStorage'

const orchestratorMocks = vi.hoisted(() => ({
  tryRestoreSession: vi.fn<() => Promise<'restored' | 'degraded' | 'unauthenticated'>>(),
}))

vi.mock('@/composables/useSessionOrchestrator', () => ({
  useSessionOrchestrator: () => ({
    tryRestoreSession: orchestratorMocks.tryRestoreSession,
  }),
}))

describe('router auth guard', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    localStorage.clear()
    tokenStorage.clearRefreshToken()
    tokenStorage.clearAccessToken()
    orchestratorMocks.tryRestoreSession.mockReset()

    const { default: router } = await import('@/router')
    await router.push('/login')
  })

  it('redirects unauthenticated user from /tasks to login', async () => {
    const { default: router } = await import('@/router')
    await router.push('/tasks')
    expect(router.currentRoute.value.name).toBe('login')
  })

  it('redirects unauthenticated user from /tasks/:taskSlug to login', async () => {
    const { default: router } = await import('@/router')
    await router.push('/tasks/dev-123')
    expect(router.currentRoute.value.name).toBe('login')
  })

  it('redirects unauthenticated user from /tasks/kanban to login', async () => {
    const { default: router } = await import('@/router')
    await router.push('/tasks/kanban')
    expect(router.currentRoute.value.name).toBe('login')
  })

  it('redirects unauthenticated user from /documents routes to login', async () => {
    const { default: router } = await import('@/router')
    await router.push('/documents')
    expect(router.currentRoute.value.name).toBe('login')

    await router.push('/documents/teamspaces/teamspace-1')
    expect(router.currentRoute.value.name).toBe('login')

    await router.push('/documents/search?q=spec')
    expect(router.currentRoute.value.name).toBe('login')

    await router.push('/documents/document-1')
    expect(router.currentRoute.value.name).toBe('login')
  })

  it('redirects unauthenticated user from /dayoffs to login', async () => {
    const { default: router } = await import('@/router')
    await router.push('/dayoffs')
    expect(router.currentRoute.value.name).toBe('login')
  })

  it('allows authenticated user to open task and document routes', async () => {
    const { default: router } = await import('@/router')
    const auth = useAuthStore()
    auth.authState = 'AUTHENTICATED'

    await router.push('/tasks')
    expect(router.currentRoute.value.name).toBe('tasks-list')

    await router.push('/tasks/kanban')
    expect(router.currentRoute.value.name).toBe('tasks-kanban')

    await router.push('/tasks/dev-123')
    expect(router.currentRoute.value.name).toBe('tasks-card')
    expect(router.currentRoute.value.params.taskSlug).toBe('dev-123')

    await router.push('/documents')
    expect(router.currentRoute.value.name).toBe('documents-teamspaces')

    await router.push('/documents/teamspaces/teamspace-1')
    expect(router.currentRoute.value.name).toBe('documents-teamspace')
    expect(router.currentRoute.value.params.teamspaceId).toBe('teamspace-1')

    await router.push('/documents/search?q=spec')
    expect(router.currentRoute.value.name).toBe('documents-search')
    expect(router.currentRoute.value.query.q).toBe('spec')

    await router.push('/documents/document-1')
    expect(router.currentRoute.value.name).toBe('documents-card')
    expect(router.currentRoute.value.params.documentId).toBe('document-1')

    await router.push('/dayoffs')
    expect(router.currentRoute.value.name).toBe('dayoffs')
  })

  it('keeps main route when restore fails but auth store stays authenticated (server unavailable)', async () => {
    tokenStorage.setRefreshToken('refresh-token')
    tokenStorage.setAccessToken('access-token')
    orchestratorMocks.tryRestoreSession.mockImplementation(async () => {
      const auth = useAuthStore()
      auth.accessToken = 'access-token'
      auth.authState = 'AUTH_DEGRADED'
      auth.lastAuthError = 'Server is unavailable'
      return 'degraded'
    })

    const { default: router } = await import('@/router')
    await router.push('/')

    expect(router.currentRoute.value.name).toBe('main')
  })

  it('keeps protected route when restore degrades the session', async () => {
    tokenStorage.setRefreshToken('refresh-token')
    orchestratorMocks.tryRestoreSession.mockResolvedValue('degraded')

    const { default: router } = await import('@/router')
    await router.push('/tasks')

    expect(router.currentRoute.value.name).toBe('tasks-list')
  })
})
