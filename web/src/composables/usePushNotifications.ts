import { ref, computed, readonly } from 'vue'
import { getSwRegistration } from '@/composables/usePwaUpdate'
import { getVapidPublicKey, subscribePush, unsubscribePush } from '@/services/http/pushApi'
import { savePushEndpoint, loadPushEndpoint, clearPushEndpoint } from '@/services/storage/pushStorage'
import { isTauriRuntime } from '@/platform/runtime'

// ---------------------------------------------------------------------------
// Module-level state (singleton across components)
// ---------------------------------------------------------------------------

const permissionState = ref<NotificationPermission>(
  typeof Notification !== 'undefined' ? Notification.permission : 'default',
)
const isSubscribed = ref(!!loadPushEndpoint())
const isLoading = ref(false)
const error = ref<string | null>(null)

// ---------------------------------------------------------------------------
// Feature detection
// ---------------------------------------------------------------------------

/** True when the browser supports push notifications via a service worker. */
export const pushSupported =
  typeof window !== 'undefined' &&
  !isTauriRuntime() &&
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window

/** True when the user is on iOS Safari but NOT in standalone (installed) mode. */
export function isIosSafariNotInstalled(): boolean {
  if (typeof navigator === 'undefined') return false
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent)
  if (!isIos) return false
  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as any).standalone === true
  return !isStandalone
}

// ---------------------------------------------------------------------------
// Composable
// ---------------------------------------------------------------------------

/**
 * Composable for managing Web Push notification subscriptions.
 *
 * Usage:
 * ```ts
 * const { permissionState, isSubscribed, subscribe, unsubscribe } = usePushNotifications()
 * ```
 */
export function usePushNotifications() {
  async function waitForActiveRegistration(
    registration: ServiceWorkerRegistration | null | undefined,
  ): Promise<ServiceWorkerRegistration | null> {
    if (!registration) return null
    if (registration.active) return registration
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return registration
    }

    try {
      const ready = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
      ])
      return ready ?? registration
    } catch {
      return registration
    }
  }

  /**
   * Resolve an active service worker registration.
   * This is resilient to startup timing where `useRegisterSW` callback has not
   * fired yet but the browser already has/soon gets a registration.
   */
  async function resolveSwRegistration(): Promise<ServiceWorkerRegistration | null> {
    const cached = getSwRegistration()
    const activeCached = await waitForActiveRegistration(cached)
    if (activeCached) return activeCached
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null

    try {
      const current = await navigator.serviceWorker.getRegistration()
      const activeCurrent = await waitForActiveRegistration(current)
      if (activeCurrent) return activeCurrent
    } catch {
      // Ignore and continue with additional fallbacks.
    }

    try {
      const all = await navigator.serviceWorker.getRegistrations()
      if (all.length > 0) {
        const activeRegistration = await waitForActiveRegistration(all[0])
        if (activeRegistration) return activeRegistration
      }
    } catch {
      // Ignore and continue with additional fallbacks.
    }

    try {
      const ready = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
      ])
      return ready
    } catch {
      return null
    }
  }

  /** Request the browser notification permission (user-facing prompt). */
  async function requestPermission(): Promise<NotificationPermission> {
    if (!pushSupported) return 'denied'
    const result = await Notification.requestPermission()
    permissionState.value = result
    return result
  }

  /**
   * Subscribe to push notifications:
   * 1. Request permission if needed
   * 2. Fetch VAPID public key from backend
   * 3. Call pushManager.subscribe()
   * 4. POST subscription to backend
   */
  async function subscribe(): Promise<boolean> {
    if (!pushSupported) {
      error.value = 'Push notifications are not supported in this browser.'
      return false
    }

    isLoading.value = true
    error.value = null

    try {
      // Step 1: Get permission
      if (permissionState.value !== 'granted') {
        const result = await requestPermission()
        if (result !== 'granted') {
          error.value = 'Notification permission was denied.'
          return false
        }
      }

      // Step 2: Get SW registration
      const registration = await resolveSwRegistration()
      if (!registration) {
        if (typeof window !== 'undefined' && !window.isSecureContext) {
          error.value = 'Push notifications require HTTPS (or localhost).'
        } else if (import.meta.env.DEV) {
          error.value = 'Service worker unavailable in this dev session. Use a production build/preview or enable VitePWA dev SW.'
        } else {
          error.value = 'Service worker not available yet. Wait a moment and try again.'
        }
        return false
      }

      const existingSubscription = await registration.pushManager.getSubscription()
      if (existingSubscription) {
        const existingJson = existingSubscription.toJSON()
        await subscribePush(existingJson)
        savePushEndpoint(existingJson.endpoint ?? '')
        isSubscribed.value = true
        return true
      }

      // Step 3: Get VAPID key from server
      const vapidKey = await getVapidPublicKey()
      if (!vapidKey) {
        error.value = 'Push notifications are not configured on the server.'
        return false
      }

      // Step 4: Subscribe via Push API
      const applicationServerKey = urlBase64ToUint8Array(vapidKey)
      const pushSubscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey as unknown as BufferSource,
      })

      // Step 5: Send subscription to backend
      const json = pushSubscription.toJSON()
      await subscribePush(json)

      // Step 6: Persist locally
      savePushEndpoint(json.endpoint ?? '')
      isSubscribed.value = true
      return true
    } catch (err) {
      console.error('[Push] Subscribe failed:', err)
      error.value = err instanceof Error ? err.message : 'Failed to subscribe to push notifications.'
      return false
    } finally {
      isLoading.value = false
    }
  }

  /**
   * Unsubscribe from push notifications:
   * 1. Unsubscribe from Push API
   * 2. DELETE subscription on backend
   * 3. Clear local state
   */
  async function unsubscribe(): Promise<boolean> {
    isLoading.value = true
    error.value = null

    try {
      const registration = await resolveSwRegistration()
      if (registration) {
        const pushSubscription = await registration.pushManager.getSubscription()
        if (pushSubscription) {
          const endpoint = pushSubscription.endpoint
          await pushSubscription.unsubscribe()
          try {
            await unsubscribePush(endpoint)
          } catch {
            // Backend cleanup is best-effort; the subscription is already
            // unregistered in the browser.
          }
        }
      }

      clearPushEndpoint()
      isSubscribed.value = false
      return true
    } catch (err) {
      console.error('[Push] Unsubscribe failed:', err)
      error.value = err instanceof Error ? err.message : 'Failed to unsubscribe.'
      return false
    } finally {
      isLoading.value = false
    }
  }

  /**
   * Check if we have an existing valid push subscription. Syncs `isSubscribed`
   * state with the actual Push API state.
   */
  async function checkExistingSubscription(): Promise<void> {
    if (!pushSupported) return
    permissionState.value = Notification.permission
    const registration = await resolveSwRegistration()
    if (!registration) return

    try {
      const sub = await registration.pushManager.getSubscription()
      if (sub) {
        savePushEndpoint(sub.endpoint)
        isSubscribed.value = true
      } else {
        clearPushEndpoint()
        isSubscribed.value = false
      }
    } catch {
      // Subscription check failed — reset state
      clearPushEndpoint()
      isSubscribed.value = false
    }
  }

  return {
    /** Current browser notification permission: 'granted' | 'denied' | 'default' */
    permissionState: readonly(permissionState),
    /** Whether the user has an active push subscription */
    isSubscribed: readonly(isSubscribed),
    /** Whether a subscribe/unsubscribe operation is in progress */
    isLoading: readonly(isLoading),
    /** Human-readable error from the last failed operation */
    error: readonly(error),
    /** True if push notifications are not available at all */
    isUnsupported: computed(() => !pushSupported),
    /** True if on iOS Safari without home-screen install (needs install guide) */
    needsIosInstall: computed(() => isIosSafariNotInstalled()),

    requestPermission,
    subscribe,
    unsubscribe,
    checkExistingSubscription,
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Convert a base64url-encoded string to a Uint8Array (for applicationServerKey).
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)))
}
