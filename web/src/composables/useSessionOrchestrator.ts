import { computed, ref } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useChatStore } from '@/stores/chat'
import { useWsStore, type WsErrorKind } from '@/stores/ws'
import { useOfflineQueue } from '@/composables/useOfflineQueue'
import { resolveWsUrl } from '@/services/runtime/backendEndpoint'

const RECONNECT_INTERVAL_MS = 5_000
const SESSION_RECOVERY_RETRY_MS = 5_000

// ---------------------------------------------------------------------------
// All state is module-level so every useSessionOrchestrator() call shares the
// same singleton instance — there is only ever one WS session.
// ---------------------------------------------------------------------------
const isReconnecting = ref(false)
const reconnectAttempt = ref(0)
const startupPhase = ref<'IDLE' | 'RESTORING_SESSION' | 'WAITING_FOR_SESSION' | 'CONNECTING_WS'>('IDLE')
const isStartupLoading = computed(() => startupPhase.value !== 'IDLE')
const startupMessage = computed(() => {
  switch (startupPhase.value) {
    case 'RESTORING_SESSION':
      return 'Restoring session...'
    case 'WAITING_FOR_SESSION':
      return 'Waiting for server to restore session...'
    case 'CONNECTING_WS':
      return 'Connecting to server...'
    default:
      return ''
  }
})

let refreshAttempted = false
let activeAttemptId = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectStopped = false
let reconnectRefreshAttempted = false
let sessionRecoveryTimer: ReturnType<typeof setTimeout> | null = null
let lifecycleRecoveryListenersAttached = false
let restoreSessionInFlight: Promise<RestoreSessionResult> | null = null
let lifecycleRecoveryCallback: (() => void) | null = null

export type RestoreSessionResult = 'restored' | 'degraded' | 'unauthenticated'

export function resetSessionOrchestratorStateForTests() {
  refreshAttempted = false
  activeAttemptId = 0
  reconnectStopped = false
  reconnectRefreshAttempted = false
  restoreSessionInFlight = null
  lifecycleRecoveryCallback = null
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (sessionRecoveryTimer) {
    clearTimeout(sessionRecoveryTimer)
    sessionRecoveryTimer = null
  }
  isReconnecting.value = false
  reconnectAttempt.value = 0
  startupPhase.value = 'IDLE'
}

/**
 * Coordinates the auth <-> WS lifecycle:
 *  login  → open WS → sendAuth
 *  WS auth fail → try refresh once → reconnect → sendAuth
 *  refresh fail  → hard logout
 *  transport drop → auto-reconnect every 5 s (production reconnect policy)
 */
export function useSessionOrchestrator() {
  const auth = useAuthStore()
  const ws = useWsStore()

  function clearSessionRecoveryTimer() {
    if (sessionRecoveryTimer) {
      clearTimeout(sessionRecoveryTimer)
      sessionRecoveryTimer = null
    }
  }

  async function recoverDegradedSession(): Promise<boolean> {
    clearSessionRecoveryTimer()
    if (reconnectStopped) return false
    if (!auth.loadPersistedRefreshToken()) return false
    const shouldShowStartupLoader = startupPhase.value !== 'IDLE'

    try {
      const newToken = await auth.refresh()
      if (shouldShowStartupLoader) {
        startupPhase.value = 'CONNECTING_WS'
      }
      const ok = await connectAndAuthenticate(newToken, {
        resetRecovery: false,
        preserveReconnectState: true,
      })
      if (ok) {
        startupPhase.value = 'IDLE'
      } else if (auth.authState === 'AUTH_DEGRADED') {
        startupPhase.value = shouldShowStartupLoader ? 'WAITING_FOR_SESSION' : 'IDLE'
        scheduleDegradedSessionRecovery()
      }
      return ok
    } catch {
      if (auth.authState === 'AUTH_DEGRADED') {
        startupPhase.value = shouldShowStartupLoader ? 'WAITING_FOR_SESSION' : 'IDLE'
        scheduleDegradedSessionRecovery()
      }
      return false
    }
  }

  function scheduleDegradedSessionRecovery(delayMs = SESSION_RECOVERY_RETRY_MS) {
    if (sessionRecoveryTimer || reconnectStopped) return
    sessionRecoveryTimer = setTimeout(() => {
      sessionRecoveryTimer = null
      void recoverDegradedSession()
    }, delayMs)
  }

  function attachLifecycleRecoveryListeners() {
    if (lifecycleRecoveryListenersAttached) return
    lifecycleRecoveryListenersAttached = true
    if (typeof window === 'undefined') return

    const recoverIfNeeded = () => {
      lifecycleRecoveryCallback?.()
    }

    window.addEventListener('focus', recoverIfNeeded)
    window.addEventListener('pageshow', recoverIfNeeded)
    window.addEventListener('online', recoverIfNeeded)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return
      recoverIfNeeded()
    })
  }

  lifecycleRecoveryCallback = () => {
    if (auth.authState !== 'AUTH_DEGRADED') return
    void recoverDegradedSession()
  }
  attachLifecycleRecoveryListeners()

  function _stopReconnect(permanent = false) {
    console.log('[orchestrator:_stopReconnect] isReconnecting→false, permanent=', permanent)
    if (permanent) reconnectStopped = true
    isReconnecting.value = false
    reconnectAttempt.value = 0
    reconnectRefreshAttempted = false
    clearSessionRecoveryTimer()
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  function _isWsPostAuthState() {
    const s = ws.state
    return (
      s === 'AUTH_COMPLETE' ||
      s === 'BOOTSTRAPPING' ||
      s === 'RECOVERING_GAP' ||
      s === 'STALE_REBOOTSTRAP' ||
      s === 'LIVE_SYNCED'
    )
  }

  function _stopReconnectIfWsAlreadyHealthy() {
    if (!_isWsPostAuthState()) return false
    // A successful auth flow may finish through a parallel attempt. If we are
    // already in any post-auth state, force-clear reconnect UI/timer state.
    _stopReconnect(false)
    return true
  }

  function _isAuthStageTransportDrop() {
    return (
      ws.state === 'DISCONNECTED' &&
      ws.serverHello?.case === 'serverHello' &&
      !ws.authResult &&
      ws.lastCloseCode === 1006 &&
      (ws.lastErrorKind === null || ws.lastErrorKind === 'TRANSPORT')
    )
  }

  async function _tryRefreshAfterAuthStageDrop() {
    if (reconnectStopped || reconnectRefreshAttempted) return false
    if (!_isAuthStageTransportDrop()) return false
    reconnectRefreshAttempted = true
    console.log('[orchestrator:authStageDrop] detected close=1006 after authRequest, trying refresh')
    try {
      const newToken = await auth.refresh()
      const ok = await connectAndAuthenticate(newToken, { resetRecovery: false, fromReconnect: true })
      console.log('[orchestrator:authStageDrop] refresh reconnect result=', ok)
      if (ok) {
        _stopReconnect(false)
        return true
      }
    } catch {
      // Keep regular reconnect loop running; this path is a best-effort recovery.
    }
    return false
  }

  function _scheduleReconnect() {
    console.log('[orchestrator:_scheduleReconnect] reconnectStopped=', reconnectStopped, 'timerActive=', !!reconnectTimer)
    if (reconnectStopped) return
    if (reconnectTimer) return
    if (_stopReconnectIfWsAlreadyHealthy()) return

    isReconnecting.value = true
    reconnectAttempt.value += 1
    console.log('[orchestrator:_scheduleReconnect] scheduled, attempt=', reconnectAttempt.value)

    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null
      if (reconnectStopped) return
      if (_stopReconnectIfWsAlreadyHealthy()) return

      const token = auth.accessToken
      if (!token) {
        try {
          const newToken = await auth.refresh()
          const ok = await connectAndAuthenticate(newToken, { resetRecovery: false, fromReconnect: true })
          if (ok) {
            _stopReconnect(false)
          } else if (auth.authState === 'AUTH_DEGRADED') {
            _stopReconnect(false)
            scheduleDegradedSessionRecovery()
          } else if (!reconnectStopped) {
            _scheduleReconnect()
          }
        } catch {
          if (auth.authState === 'AUTH_DEGRADED') {
            _stopReconnect(false)
            scheduleDegradedSessionRecovery()
          } else if (!reconnectStopped) {
            _scheduleReconnect()
          }
        }
        return
      }

      console.log('[orchestrator:_scheduleReconnect] timer fired, attempt=', reconnectAttempt.value)
      const ok = await connectAndAuthenticate(token, { resetRecovery: false, fromReconnect: true })
      console.log('[orchestrator:_scheduleReconnect] connectAndAuthenticate result=', ok, 'reconnectStopped=', reconnectStopped)
      if (ok) {
        _stopReconnect(false)  // success — not permanent, system stays ready for next drop
      } else if (await _tryRefreshAfterAuthStageDrop()) {
        return
      } else if (!reconnectStopped) {
        _scheduleReconnect()
      }
    }, RECONNECT_INTERVAL_MS)
  }

  function _attachAuthFailHandler() {
    ws.onAuthFail(async (kind: WsErrorKind) => {
      if (kind === 'FORBIDDEN') {
        _stopReconnect(true)
        await logout()
        return
      }

      // UNAUTHENTICATED — try refresh once
      if (!refreshAttempted) {
        refreshAttempted = true
        try {
          const newToken = await auth.refresh()
          const ok = await connectAndAuthenticate(newToken, { resetRecovery: false })
          if (!ok && auth.authState === 'AUTH_DEGRADED') {
            _stopReconnect(false)
            scheduleDegradedSessionRecovery()
          }
        } catch {
          if (auth.authState === 'AUTH_DEGRADED') {
            _stopReconnect(false)
            scheduleDegradedSessionRecovery()
          } else {
            _stopReconnect(true)
            await logout()
          }
        }
      } else {
        _stopReconnect(true)
        await logout()
      }
    })
  }

  function _attachTransportDropHandler() {
    ws.onTransportDrop(() => {
      console.log('[orchestrator:onTransportDrop] fired, reconnectStopped=', reconnectStopped, 'isReconnecting=', isReconnecting.value)
      // Capture messages before reconnect/bootstrap can clear their optimistic
      // overlays. The queue keeps the original client IDs for idempotent replay.
      useOfflineQueue().releaseAllInFlight()
      useChatStore().requeueInFlightPlaintextMessages()
      if (reconnectStopped) return
      if (_stopReconnectIfWsAlreadyHealthy()) return
      // If a reconnect loop is already running (timer scheduled or attempt in
      // flight), do not start a second one — the existing loop handles retries.
      if (isReconnecting.value || reconnectTimer) return
      reconnectRefreshAttempted = false
      reconnectAttempt.value = 0
      _scheduleReconnect()
    })
  }

  /**
   * Opens WS and relies on wsStore pending-auth token handshake:
   * serverHello -> auto AuthRequest.
   * The WS store fires onAuthFail if auth is rejected.
   */
  function connectAndAuthenticate(
    accessToken: string,
    options?: { resetRecovery?: boolean; fromReconnect?: boolean; preserveReconnectState?: boolean },
  ): Promise<boolean> {
    const attemptId = ++activeAttemptId
    const isForegroundAttempt = !(options?.fromReconnect ?? false)
    if (isForegroundAttempt) {
      startupPhase.value = 'CONNECTING_WS'
    }
    if (options?.resetRecovery ?? true) {
      refreshAttempted = false
    }
    _attachAuthFailHandler()

    console.log('[orchestrator:connectAndAuthenticate] attemptId=', attemptId, 'fromReconnect=', options?.fromReconnect)
    if (!options?.fromReconnect) {
      // Fresh connect — reset reconnect state and attach transport-drop handler
      _stopReconnect(false)
      if (!options?.preserveReconnectState) {
        reconnectStopped = false
      }
      reconnectRefreshAttempted = false
      _attachTransportDropHandler()
    }

    let resolved = false
    const MAX_WAIT_MS = 10_000
    const TICK_MS = 50
    let elapsed = 0

    ws.setPendingAuthToken(accessToken)
    // A reconnect is a new delivery epoch. Every unacknowledged normal message
    // remains durable and may be safely replayed with its original client ID.
    useOfflineQueue().releaseAllInFlight()
    ws.connect(resolveWsUrl())
    let timer: ReturnType<typeof setInterval> | null = null

    const finalize = (success: boolean) => {
      if (resolved) return
      resolved = true
      console.log('[orchestrator:finalize] success=', success, 'attemptId=', attemptId, 'activeAttemptId=', activeAttemptId, 'fromReconnect=', options?.fromReconnect)

      if (timer) {
        clearInterval(timer)
        timer = null
      }

      if (success) {
        auth.setSessionRole(ws.authResult?.userRole ?? null)
        clearSessionRecoveryTimer()
        _stopReconnect(false)
      } else if (_isWsPostAuthState()) {
        // Attempt lost a race with a newer successful auth flow.
        _stopReconnect(false)
      }
      if (isForegroundAttempt && attemptId === activeAttemptId) {
        startupPhase.value = 'IDLE'
      }
    }

    return new Promise((resolve) => {
      timer = setInterval(() => {
        if (attemptId !== activeAttemptId) {
          finalize(false)
          resolve(false)
          return
        }

        elapsed += TICK_MS

        // AUTH_COMPLETE is transient — startRealtimeFlow() immediately advances
        // the state to BOOTSTRAPPING/RECOVERING_GAP/LIVE_SYNCED. Treat any
        // post-auth state as success.
        const s = ws.state
        const succeeded =
          s === 'AUTH_COMPLETE' ||
          s === 'BOOTSTRAPPING' ||
          s === 'RECOVERING_GAP' ||
          s === 'STALE_REBOOTSTRAP' ||
          s === 'LIVE_SYNCED'
        if (succeeded) {
          finalize(true)
          resolve(true)
        } else if (s === 'DISCONNECTED' || elapsed >= MAX_WAIT_MS) {
          // 'CONNECTING' is the transient pre-open state — ws.connect() sets it
          // before the socket opens. Only 'DISCONNECTED' (set by onerror/onclose)
          // signals a genuine failure, so this check is now safe.
          // A foreground connection can also fail before onopen, or remain
          // stuck in the handshake until the foreground deadline. Enter the
          // existing reconnect loop here; if the close callback already did
          // so, _scheduleReconnect() deduplicates the pending retry.
          const shouldRecoverTransport = isForegroundAttempt
            && !reconnectStopped
            && (
              ws.lastErrorKind === 'TRANSPORT'
              || (ws.lastErrorKind === null && s === 'DISCONNECTED')
              || (ws.lastErrorKind === null && elapsed >= MAX_WAIT_MS)
            )
          finalize(false)
          if (shouldRecoverTransport) {
            _scheduleReconnect()
          }
          resolve(false)
        }
      }, TICK_MS)
    })
  }

  /**
   * Full login flow: HTTP login → connect WS → auth.
   */
  async function login(email: string, password: string) {
    refreshAttempted = false
    await auth.login(email, password)
    await connectAndAuthenticate(auth.accessToken!)
  }

  /**
   * Boot-time recovery: if a refresh token exists in storage,
   * try to restore the session without showing the login screen.
   *
   * Attempts to load cached data from IndexedDB first for instant start:
   * the user sees conversations and recent messages while the WS connection
   * is established in the background. The server bootstrap then overwrites
   * the cached state with authoritative data.
   *
   * Returns true if recovery succeeded.
   */
  async function tryRestoreSession(): Promise<RestoreSessionResult> {
    if (restoreSessionInFlight) {
      return await restoreSessionInFlight
    }

    const stored = auth.loadPersistedRefreshToken()
    if (!stored) return 'unauthenticated'
    restoreSessionInFlight = (async () => {
      startupPhase.value = 'RESTORING_SESSION'

      // Try to hydrate UI from IndexedDB cache for instant start.
      // The user sees cached data while the network request completes.
      const chatStore = useChatStore()
      await auth.hydrateUserFromCache()
      const cacheLoaded = await chatStore.loadCachedState()
      if (cacheLoaded) {
        // User has cached data — dismiss the loading overlay early so
        // the app shell renders immediately. The WS connect + bootstrap
        // will overwrite the cached state in the background.
        startupPhase.value = 'IDLE'
      }

      try {
        refreshAttempted = false
        const newToken = await auth.refresh()
        const restored = await connectAndAuthenticate(newToken)
        if (!restored && auth.authState === 'AUTH_DEGRADED') {
          startupPhase.value = cacheLoaded ? 'IDLE' : 'WAITING_FOR_SESSION'
          scheduleDegradedSessionRecovery()
          return 'degraded'
        }
        return restored ? 'restored' : 'unauthenticated'
      } catch {
        if (auth.authState === 'AUTH_DEGRADED') {
          startupPhase.value = cacheLoaded ? 'IDLE' : 'WAITING_FOR_SESSION'
          scheduleDegradedSessionRecovery()
          return 'degraded'
        }
        if (cacheLoaded) {
          // Cache was shown but auth failed — clear the cached UI.
          chatStore.setCachedBootstrap(false)
        }
        startupPhase.value = 'IDLE'
        return 'unauthenticated'
      }
    })()

    try {
      return await restoreSessionInFlight
    } finally {
      restoreSessionInFlight = null
    }
  }

  async function logout() {
    _stopReconnect(true)
    ws.disconnect('logout')
    ws.resetRuntimeState()

    const chatStore = useChatStore()
    chatStore.resetRuntimeState()

    const [{ useCallStore }, { useTasksStore }] = await Promise.all([
      import('@/stores/call'),
      import('@/stores/tasks'),
    ])

    await useCallStore().resetRuntimeState()
    useTasksStore().resetRuntimeState()
    useOfflineQueue().clear()

    await auth.logout()
  }

  function reconnectNow() {
    if (auth.authState === 'AUTH_DEGRADED') {
      void recoverDegradedSession()
      return
    }
    // Cancel pending timer and fire immediately
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    isReconnecting.value = true
    reconnectAttempt.value += 1

    const token = auth.accessToken
    if (!token) {
      _scheduleReconnect()
      return
    }
    connectAndAuthenticate(token, { resetRecovery: false, fromReconnect: true }).then(async (ok) => {
      if (ok) {
        _stopReconnect(false)
      } else if (await _tryRefreshAfterAuthStageDrop()) {
        return
      } else if (!reconnectStopped) {
        _scheduleReconnect()
      }
    })
  }

  return {
    login,
    logout,
    connectAndAuthenticate,
    tryRestoreSession,
    isReconnecting,
    reconnectAttempt,
    reconnectNow,
    isStartupLoading,
    startupMessage,
  }
}
