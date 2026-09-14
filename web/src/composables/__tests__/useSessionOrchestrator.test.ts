import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type TransportDropHandler = (() => void) | null

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

const mockState = vi.hoisted(() => ({
  transportDropHandler: null as TransportDropHandler,
}))

const mockAuthStore = vi.hoisted(() => ({
  authState: 'ANON' as 'ANON' | 'AUTHENTICATED' | 'AUTH_DEGRADED',
  lastAuthError: null as string | null,
  accessToken: 'token-initial' as string | null,
  refresh: vi.fn<() => Promise<string>>(),
  login: vi.fn<() => Promise<void>>(),
  logout: vi.fn<() => Promise<void>>(),
  hydrateUserFromCache: vi.fn<() => Promise<void>>(),
  setSessionRole: vi.fn<(role: string | null) => void>(),
  loadPersistedRefreshToken: vi.fn<() => string | null>(),
}))

const mockChatStore = vi.hoisted(() => ({
  loadCachedState: vi.fn<() => Promise<boolean>>(),
  requeueInFlightPlaintextMessages: vi.fn<() => void>(),
  cachedBootstrap: false,
  setCachedBootstrap: vi.fn<(value: boolean) => void>(),
}))

const mockWsStore = vi.hoisted(() => ({
  state: 'DISCONNECTED' as
    | 'DISCONNECTED'
    | 'CONNECTING'
    | 'WS_CONNECTED'
    | 'HELLO_SENT'
    | 'HELLO_COMPLETE'
    | 'AUTH_SENT'
    | 'AUTH_COMPLETE'
    | 'BOOTSTRAPPING'
    | 'LIVE_SYNCED'
    | 'RECOVERING_GAP'
    | 'STALE_REBOOTSTRAP',
  serverHello: null as null | { case: 'serverHello'; value: Record<string, never> },
  authResult: null as null | { userRole: string },
  lastError: null as string | null,
  lastErrorKind: null as 'UNAUTHENTICATED' | 'FORBIDDEN' | 'BAD_REQUEST' | 'PROTOCOL' | 'TRANSPORT' | null,
  lastCloseCode: null as number | null,
  connect: vi.fn<(url: string) => void>(),
  disconnect: vi.fn<(reason: 'logout' | 'transport') => void>(),
  setPendingAuthToken: vi.fn<(token: string) => void>(),
  onAuthFail: vi.fn<(cb: (kind: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'BAD_REQUEST' | 'PROTOCOL' | 'TRANSPORT') => void) => void>(),
  onTransportDrop: vi.fn<(cb: () => void) => void>(),
}))

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => mockAuthStore,
}))

vi.mock('@/stores/chat', () => ({
  useChatStore: () => mockChatStore,
}))

vi.mock('@/stores/ws', () => ({
  useWsStore: () => mockWsStore,
}))

describe('useSessionOrchestrator', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    vi.clearAllMocks()

    mockState.transportDropHandler = null
    mockAuthStore.authState = 'ANON'
    mockAuthStore.lastAuthError = null
    mockAuthStore.accessToken = 'token-initial'
    mockAuthStore.refresh.mockResolvedValue('token-refreshed')
    mockAuthStore.login.mockResolvedValue()
    mockAuthStore.logout.mockResolvedValue()
    mockAuthStore.hydrateUserFromCache.mockResolvedValue()
    mockAuthStore.loadPersistedRefreshToken.mockReturnValue('refresh-token')
    mockChatStore.loadCachedState.mockResolvedValue(false)
    mockChatStore.requeueInFlightPlaintextMessages.mockReset()
    mockChatStore.cachedBootstrap = false
    mockChatStore.setCachedBootstrap.mockImplementation((value: boolean) => {
      mockChatStore.cachedBootstrap = value
    })

    mockWsStore.state = 'DISCONNECTED'
    mockWsStore.serverHello = null
    mockWsStore.authResult = null
    mockWsStore.lastError = null
    mockWsStore.lastErrorKind = null
    mockWsStore.lastCloseCode = null
    mockWsStore.onTransportDrop.mockImplementation((cb: () => void) => {
      mockState.transportDropHandler = cb
    })
    mockWsStore.onAuthFail.mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('refreshes once on auth-stage close 1006 and clears reconnect state on recovery', async () => {
    let connectCall = 0
    mockWsStore.connect.mockImplementation(() => {
      connectCall += 1
      mockWsStore.lastErrorKind = null
      mockWsStore.lastCloseCode = null
      mockWsStore.serverHello = null
      mockWsStore.authResult = null

      if (connectCall === 1) {
        // Initial foreground connect succeeds.
        mockWsStore.state = 'LIVE_SYNCED'
        mockWsStore.authResult = { userRole: 'member' }
        return
      }

      if (connectCall === 2) {
        // Reconnect attempt fails at auth stage: hello happened, auth never completed.
        mockWsStore.state = 'DISCONNECTED'
        mockWsStore.serverHello = { case: 'serverHello', value: {} }
        mockWsStore.lastCloseCode = 1006
        return
      }

      // Refresh retry succeeds.
      mockWsStore.state = 'LIVE_SYNCED'
      mockWsStore.authResult = { userRole: 'member' }
    })

    const { resetSessionOrchestratorStateForTests, useSessionOrchestrator } = await import('@/composables/useSessionOrchestrator')
    resetSessionOrchestratorStateForTests()
    const orchestrator = useSessionOrchestrator()

    const firstConnect = orchestrator.connectAndAuthenticate('token-initial')
    await vi.advanceTimersByTimeAsync(100)
    await expect(firstConnect).resolves.toBe(true)
    expect(mockState.transportDropHandler).not.toBeNull()

    // Simulate transport drop after the initial successful session.
    mockWsStore.state = 'DISCONNECTED'
    mockState.transportDropHandler?.()
    expect(orchestrator.isReconnecting.value).toBe(true)
    expect(mockChatStore.requeueInFlightPlaintextMessages).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(5_500)

    expect(mockAuthStore.refresh).toHaveBeenCalledTimes(1)
    expect(mockWsStore.connect).toHaveBeenCalledTimes(3)
    expect(orchestrator.isReconnecting.value).toBe(false)
    expect(orchestrator.reconnectAttempt.value).toBe(0)
  })

  it('schedules reconnect when the initial socket fails before opening', async () => {
    let connectCall = 0
    mockWsStore.connect.mockImplementation(() => {
      connectCall += 1
      if (connectCall === 1) {
        mockWsStore.state = 'DISCONNECTED'
        mockWsStore.lastErrorKind = 'TRANSPORT'
        return
      }
      mockWsStore.state = 'LIVE_SYNCED'
      mockWsStore.lastErrorKind = null
      mockWsStore.authResult = { userRole: 'member' }
    })

    const { resetSessionOrchestratorStateForTests, useSessionOrchestrator } = await import('@/composables/useSessionOrchestrator')
    resetSessionOrchestratorStateForTests()
    const orchestrator = useSessionOrchestrator()

    const firstConnect = orchestrator.connectAndAuthenticate('token-initial')
    await vi.advanceTimersByTimeAsync(100)

    await expect(firstConnect).resolves.toBe(false)
    expect(orchestrator.isReconnecting.value).toBe(true)
    expect(orchestrator.reconnectAttempt.value).toBe(1)

    await vi.advanceTimersByTimeAsync(5_100)

    expect(mockWsStore.connect).toHaveBeenCalledTimes(2)
    expect(orchestrator.isReconnecting.value).toBe(false)
  })

  it('schedules reconnect when the foreground connection deadline expires', async () => {
    let connectCall = 0
    mockWsStore.connect.mockImplementation(() => {
      connectCall += 1
      if (connectCall === 1) {
        mockWsStore.state = 'CONNECTING'
        return
      }
      mockWsStore.state = 'LIVE_SYNCED'
      mockWsStore.authResult = { userRole: 'member' }
    })

    const { resetSessionOrchestratorStateForTests, useSessionOrchestrator } = await import('@/composables/useSessionOrchestrator')
    resetSessionOrchestratorStateForTests()
    const orchestrator = useSessionOrchestrator()

    const firstConnect = orchestrator.connectAndAuthenticate('token-initial')
    await vi.advanceTimersByTimeAsync(10_000)

    await expect(firstConnect).resolves.toBe(false)
    expect(orchestrator.isReconnecting.value).toBe(true)
    expect(orchestrator.reconnectAttempt.value).toBe(1)

    await vi.advanceTimersByTimeAsync(5_100)

    expect(mockWsStore.connect).toHaveBeenCalledTimes(2)
    expect(orchestrator.isReconnecting.value).toBe(false)
  })

  it('does not treat an initial auth rejection as a transport reconnect', async () => {
    mockWsStore.connect.mockImplementation(() => {
      mockWsStore.state = 'DISCONNECTED'
      mockWsStore.lastErrorKind = 'UNAUTHENTICATED'
    })

    const { resetSessionOrchestratorStateForTests, useSessionOrchestrator } = await import('@/composables/useSessionOrchestrator')
    resetSessionOrchestratorStateForTests()
    const orchestrator = useSessionOrchestrator()

    const firstConnect = orchestrator.connectAndAuthenticate('token-initial')
    await vi.advanceTimersByTimeAsync(100)

    await expect(firstConnect).resolves.toBe(false)
    expect(orchestrator.isReconnecting.value).toBe(false)
    expect(mockAuthStore.refresh).not.toHaveBeenCalled()
  })

  it('returns degraded restore result and retries recovery on focus', async () => {
    let refreshCalls = 0
    mockAuthStore.refresh.mockImplementation(async () => {
      refreshCalls += 1
      if (refreshCalls === 1) {
        mockAuthStore.authState = 'AUTH_DEGRADED'
        mockAuthStore.lastAuthError = 'Server is unavailable'
        mockAuthStore.accessToken = null
        throw new Error('offline')
      }

      mockAuthStore.authState = 'AUTHENTICATED'
      mockAuthStore.lastAuthError = null
      mockAuthStore.accessToken = 'token-restored'
      return 'token-restored'
    })

    mockWsStore.connect.mockImplementation(() => {
      mockWsStore.state = 'LIVE_SYNCED'
      mockWsStore.authResult = { userRole: 'member' }
    })

    const { resetSessionOrchestratorStateForTests, useSessionOrchestrator } = await import('@/composables/useSessionOrchestrator')
    resetSessionOrchestratorStateForTests()
    const orchestrator = useSessionOrchestrator()

    await expect(orchestrator.tryRestoreSession()).resolves.toBe('degraded')
    expect(orchestrator.isStartupLoading.value).toBe(true)
    expect(orchestrator.startupMessage.value).toBe('Waiting for server to restore session...')

    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(250)
    await Promise.resolve()

    expect(mockAuthStore.refresh).toHaveBeenCalledTimes(2)
    expect(mockWsStore.connect).toHaveBeenCalledTimes(1)
    expect(mockAuthStore.authState).toBe('AUTHENTICATED')
    expect(mockAuthStore.lastAuthError).toBeNull()
  })

  it('deduplicates concurrent restore attempts', async () => {
    const restoreGate = createDeferred<string>()
    mockAuthStore.refresh.mockImplementation(async () => {
      return await restoreGate.promise
    })
    mockWsStore.connect.mockImplementation(() => {
      mockWsStore.state = 'LIVE_SYNCED'
      mockWsStore.authResult = { userRole: 'member' }
    })

    const { resetSessionOrchestratorStateForTests, useSessionOrchestrator } = await import('@/composables/useSessionOrchestrator')
    resetSessionOrchestratorStateForTests()
    const orchestrator = useSessionOrchestrator()

    const first = orchestrator.tryRestoreSession()
    const second = orchestrator.tryRestoreSession()
    await Promise.resolve()
    await Promise.resolve()

    expect(mockAuthStore.refresh).toHaveBeenCalledTimes(1)

    restoreGate.resolve('token-restored')
    await vi.advanceTimersByTimeAsync(100)

    await expect(first).resolves.toBe('restored')
    await expect(second).resolves.toBe('restored')
  })

  it('retries immediately when reconnectNow is clicked outside the timer loop', async () => {
    mockWsStore.connect.mockImplementation(() => {
      mockWsStore.state = 'LIVE_SYNCED'
      mockWsStore.authResult = { userRole: 'member' }
    })

    const { resetSessionOrchestratorStateForTests, useSessionOrchestrator } = await import('@/composables/useSessionOrchestrator')
    resetSessionOrchestratorStateForTests()
    const orchestrator = useSessionOrchestrator()

    orchestrator.reconnectNow()
    await vi.advanceTimersByTimeAsync(100)

    expect(mockWsStore.connect).toHaveBeenCalledTimes(1)
  })
})
