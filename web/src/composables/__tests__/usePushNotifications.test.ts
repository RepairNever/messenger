import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetSwRegistration = vi.hoisted(() => vi.fn())
const mockGetVapidPublicKey = vi.hoisted(() => vi.fn())
const mockSubscribePush = vi.hoisted(() => vi.fn())
const mockUnsubscribePush = vi.hoisted(() => vi.fn())
const mockIsTauriRuntime = vi.hoisted(() => vi.fn(() => false))

vi.mock('@/composables/usePwaUpdate', () => ({
  getSwRegistration: mockGetSwRegistration,
}))

vi.mock('@/services/http/pushApi', () => ({
  getVapidPublicKey: mockGetVapidPublicKey,
  subscribePush: mockSubscribePush,
  unsubscribePush: mockUnsubscribePush,
}))

vi.mock('@/platform/runtime', () => ({
  isTauriRuntime: mockIsTauriRuntime,
}))

type MockPushSubscription = {
  endpoint: string
  toJSON: () => PushSubscriptionJSON
  unsubscribe: ReturnType<typeof vi.fn>
}

type MockRegistration = {
  active: Record<string, never> | null
  pushManager: {
    getSubscription: ReturnType<typeof vi.fn>
    subscribe: ReturnType<typeof vi.fn>
  }
}

function installBrowserPushGlobals(registration: MockRegistration) {
  class MockNotification {}
  Object.assign(MockNotification, {
    permission: 'granted' as NotificationPermission,
    requestPermission: vi.fn(async () => 'granted' as NotificationPermission),
  })

  Object.defineProperty(window, 'Notification', {
    configurable: true,
    value: MockNotification,
  })
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    value: MockNotification,
  })
  Object.defineProperty(window, 'PushManager', {
    configurable: true,
    value: class PushManager {},
  })
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      getRegistration: vi.fn(async () => registration),
      getRegistrations: vi.fn(async () => [registration]),
      ready: Promise.resolve(registration),
    },
  })
}

function installLocalStorage() {
  const bag: Record<string, string> = {}
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem(key: string) {
        return key in bag ? bag[key] : null
      },
      setItem(key: string, value: string) {
        bag[key] = String(value)
      },
      removeItem(key: string) {
        delete bag[key]
      },
      clear() {
        for (const key of Object.keys(bag)) {
          delete bag[key]
        }
      },
    },
  })
}

function createSubscription(endpoint = 'https://push.example/subscription'): MockPushSubscription {
  return {
    endpoint,
    toJSON: () => ({
      endpoint,
      keys: {
        p256dh: 'p256dh-key',
        auth: 'auth-key',
      },
    }),
    unsubscribe: vi.fn(async () => true),
  }
}

describe('usePushNotifications', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    installLocalStorage()
    localStorage.clear()
    mockIsTauriRuntime.mockReturnValue(false)
  })

  it('reuses an existing browser subscription instead of forcing a new subscribe call', async () => {
    const existingSubscription = createSubscription()
    const registration: MockRegistration = {
      active: {},
      pushManager: {
        getSubscription: vi.fn(async () => existingSubscription),
        subscribe: vi.fn(),
      },
    }
    installBrowserPushGlobals(registration)
    mockGetSwRegistration.mockReturnValue(registration)
    mockSubscribePush.mockResolvedValue(undefined)

    const { usePushNotifications } = await import('@/composables/usePushNotifications')
    const push = usePushNotifications()

    await expect(push.subscribe()).resolves.toBe(true)

    expect(registration.pushManager.subscribe).not.toHaveBeenCalled()
    expect(mockGetVapidPublicKey).not.toHaveBeenCalled()
    expect(mockSubscribePush).toHaveBeenCalledWith(existingSubscription.toJSON())
    expect(push.isSubscribed.value).toBe(true)
    expect(localStorage.getItem('msgnr:push-endpoint')).toBe(existingSubscription.endpoint)
  })

  it('passes the VAPID key to pushManager.subscribe as a Uint8Array', async () => {
    const newSubscription = createSubscription('https://push.example/new')
    const registration: MockRegistration = {
      active: {},
      pushManager: {
        getSubscription: vi.fn(async () => null),
        subscribe: vi.fn(async () => newSubscription),
      },
    }
    installBrowserPushGlobals(registration)
    mockGetSwRegistration.mockReturnValue(registration)
    mockGetVapidPublicKey.mockResolvedValue(
      'BMqkmhHIDVWIkFq3kDjTdVNyruT4Qt36K1kI5FwI5TtN7GysewTdoL6pWCX3KGWmaghgaavxwt4aWo51I67__dg',
    )
    mockSubscribePush.mockResolvedValue(undefined)

    const { usePushNotifications } = await import('@/composables/usePushNotifications')
    const push = usePushNotifications()

    await expect(push.subscribe()).resolves.toBe(true)

    expect(registration.pushManager.subscribe).toHaveBeenCalledTimes(1)
    const subscribeArgs = registration.pushManager.subscribe.mock.calls[0][0] as {
      applicationServerKey: unknown
      userVisibleOnly: boolean
    }
    expect(subscribeArgs.userVisibleOnly).toBe(true)
    expect(subscribeArgs.applicationServerKey).toBeInstanceOf(Uint8Array)
    expect(subscribeArgs.applicationServerKey).not.toBeInstanceOf(ArrayBuffer)
    expect(mockSubscribePush).toHaveBeenCalledWith(newSubscription.toJSON())
  })
})
