import { useRegisterSW } from 'virtual:pwa-register/vue'

// Module-level reference to the ServiceWorkerRegistration, shared across
// consumers so usePushNotifications can access registration.pushManager.
let _swRegistration: ServiceWorkerRegistration | undefined
let _updateIntervalStarted = false

/**
 * Returns the active ServiceWorkerRegistration, if available.
 * Available after the SW has been registered (typically on app startup).
 */
export function getSwRegistration(): ServiceWorkerRegistration | undefined {
  return _swRegistration
}

/**
 * Composable wrapping service worker registration and update lifecycle.
 *
 * - `needRefresh`       — true when a new SW is installed and waiting to activate
 * - `offlineReady`      — true when the SW has precached the app shell
 * - `updateServiceWorker()` — skip waiting + reload the page with the new version
 * - `close()`           — dismiss the current prompt without updating
 */
export function usePwaUpdate() {
  const { needRefresh, offlineReady, updateServiceWorker } = useRegisterSW({
    onRegisteredSW(swUrl, registration) {
      _swRegistration = registration ?? undefined

      if (import.meta.env.DEV) {
        console.debug('[PWA] Service worker registered:', swUrl)
      }

      // Periodically check for updates (every 60 minutes)
      if (registration && !_updateIntervalStarted) {
        _updateIntervalStarted = true
        setInterval(() => {
          registration.update()
        }, 60 * 60 * 1000)
      }
    },
    onRegisterError(error) {
      console.error('[PWA] Service worker registration failed:', error)
    },
  })

  function close() {
    needRefresh.value = false
    offlineReady.value = false
  }

  return {
    needRefresh,
    offlineReady,
    updateServiceWorker,
    close,
  }
}
