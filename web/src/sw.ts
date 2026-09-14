/// <reference lib="webworker" />

import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching'
import { registerRoute, NavigationRoute } from 'workbox-routing'
import { NetworkFirst, StaleWhileRevalidate, CacheFirst } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'
import { CacheableResponsePlugin } from 'workbox-cacheable-response'
import {
  buildNotificationOpenUrl,
  toNotificationOpenMessage,
  type NotificationOpenIntent,
} from '@/services/notificationOpen'
import { normalizePushNotificationDisplayText } from '@/services/notificationText'

declare let self: ServiceWorkerGlobalScope

// ---------------------------------------------------------------------------
// Workbox precache + cleanup
// ---------------------------------------------------------------------------

cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)

// ---------------------------------------------------------------------------
// Navigation fallback — serve cached index.html for all navigations except
// API, WS, and infrastructure endpoints.
// ---------------------------------------------------------------------------

const navigationHandler = new NetworkFirst({ cacheName: 'navigations' })
registerRoute(
  new NavigationRoute(navigationHandler, {
    denylist: [/^\/api\//, /^\/ws/, /^\/health/, /^\/ready/],
  }),
)

// ---------------------------------------------------------------------------
// Runtime caching (migrated from vite.config.ts workbox.runtimeCaching)
// ---------------------------------------------------------------------------

// LiveKit WebRTC SDK — cache on first call join, serve stale while revalidating
registerRoute(
  ({ url }) => /\/assets\/vendor-livekit-.*\.js$/.test(url.pathname),
  new StaleWhileRevalidate({
    cacheName: 'vendor-livekit',
    plugins: [new ExpirationPlugin({ maxEntries: 2, maxAgeSeconds: 30 * 24 * 60 * 60 })],
  }),
)

// Emoji picker data + styles — cache on first emoji click
registerRoute(
  ({ url }) => /\/assets\/vendor-emoji-.*\.(js|css)$/.test(url.pathname),
  new StaleWhileRevalidate({
    cacheName: 'vendor-emoji',
    plugins: [new ExpirationPlugin({ maxEntries: 4, maxAgeSeconds: 30 * 24 * 60 * 60 })],
  }),
)

// RNNoise WASM files — large, never change per version, cache aggressively
registerRoute(
  ({ url }) => /\/rnnoise-.*\.js$/.test(url.pathname),
  new CacheFirst({
    cacheName: 'rnnoise-wasm',
    plugins: [new ExpirationPlugin({ maxEntries: 4, maxAgeSeconds: 90 * 24 * 60 * 60 })],
  }),
)

// Avatar images — public endpoint, immutable once uploaded, cache aggressively
registerRoute(
  ({ url }) => url.pathname.startsWith('/api/public/avatars/'),
  new CacheFirst({
    cacheName: 'avatars',
    plugins: [
      new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 7 * 24 * 60 * 60 }),
      new CacheableResponsePlugin({ statuses: [0, 200] }),
    ],
  }),
)

// ---------------------------------------------------------------------------
// Push notification handler
// ---------------------------------------------------------------------------

interface PushPayload {
  type: string
  title: string
  body: string
  conversationId?: string
  messageId?: string
  threadRootMessageId?: string
  tag?: string
  url: string
}

self.addEventListener('push', (event: PushEvent) => {
  if (!event.data) return

  let data: PushPayload
  try {
    data = event.data.json() as PushPayload
  } catch {
    // Malformed payload — ignore
    return
  }

  const display = normalizePushNotificationDisplayText(data)
  event.waitUntil(
    self.registration.showNotification(display.title, {
      body: display.body,
      // Explicitly allow default OS/browser notification sound.
      silent: false,
      icon: '/pwa-192x192.png',
      badge: '/badge-72x72.png',
      ...(data.tag ? { tag: data.tag } : {}),
      data: {
        url: data.url || '/',
        conversationId: data.conversationId,
        messageId: data.messageId,
        threadRootMessageId: data.threadRootMessageId,
        type: data.type,
      },
    }),
  )
})

// ---------------------------------------------------------------------------
// Notification click — focus existing window and hand off intent in-app,
// or open a fresh window with a one-shot notification intent query.
// ---------------------------------------------------------------------------

self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close()

  const targetUrl: string = event.notification.data?.url || '/'
  const conversationId = typeof event.notification.data?.conversationId === 'string'
    ? event.notification.data.conversationId.trim()
    : ''
  const messageId = typeof event.notification.data?.messageId === 'string'
    ? event.notification.data.messageId.trim()
    : ''
  const threadRootMessageId = typeof event.notification.data?.threadRootMessageId === 'string'
    ? event.notification.data.threadRootMessageId.trim()
    : ''
  const intent: NotificationOpenIntent | null = conversationId
    ? {
        conversationId,
        ...(messageId ? { messageId } : {}),
        ...(threadRootMessageId ? { threadRootMessageId } : {}),
        url: targetUrl,
      }
    : null

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (windowClients) => {
      // Prefer an existing window at our origin — focus it and let the
      // running app handle the notification intent without a full reload.
      for (const client of windowClients) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          await client.focus()
          if (intent) {
            client.postMessage(toNotificationOpenMessage(intent))
          }
          return
        }
      }
      // No existing window — open a new one.
      return self.clients.openWindow(
        intent
          ? buildNotificationOpenUrl(targetUrl, intent, self.location.origin)
          : targetUrl,
      )
    }),
  )
})

// ---------------------------------------------------------------------------
// Message handler for prompt-to-reload (vite-plugin-pwa registerType: 'prompt')
// ---------------------------------------------------------------------------

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
})
