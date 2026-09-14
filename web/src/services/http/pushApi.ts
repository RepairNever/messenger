import { createAuthenticatedClient } from './client'

const http = createAuthenticatedClient()

/**
 * Fetch the server's VAPID public key (base64url-encoded).
 * Returns null if push is not configured on the server.
 */
export async function getVapidPublicKey(): Promise<string | null> {
  try {
    const { data } = await http.get<{ publicKey: string }>('/api/push/vapid-key')
    return data.publicKey
  } catch {
    return null
  }
}

/**
 * Register a push subscription on the server.
 */
export async function subscribePush(subscription: PushSubscriptionJSON): Promise<void> {
  await http.post('/api/push/subscribe', {
    endpoint: subscription.endpoint,
    key_p256dh: subscription.keys?.p256dh ?? '',
    key_auth: subscription.keys?.auth ?? '',
    user_agent: navigator.userAgent,
  })
}

/**
 * Remove a push subscription from the server.
 */
export async function unsubscribePush(endpoint: string): Promise<void> {
  const encodedEndpoint = encodeURIComponent(endpoint)
  try {
    await http.delete(`/api/push/subscriptions/${encodedEndpoint}`)
  } catch {
    // Backward-compatible fallback for older servers.
    await http.delete('/api/push/subscribe', { data: { endpoint } })
  }
}
