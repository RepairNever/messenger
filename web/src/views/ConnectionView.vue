<template>
  <div class="min-h-screen bg-gray-50 p-6">
    <div class="max-w-2xl mx-auto space-y-4">
      <div class="flex items-center justify-between">
        <h1 class="text-xl font-semibold text-gray-800">Connection Debug</h1>
        <a-button danger size="small" :loading="authStore.authState === 'LOGGING_OUT'" @click="handleLogout">
          Logout
        </a-button>
      </div>

      <!-- Auth state -->
      <a-card title="Auth" size="small">
        <div class="space-y-2 text-sm">
          <div class="flex items-center gap-2">
            <span class="text-gray-500">State:</span>
            <a-tag :color="authStateColor">{{ authStore.authState }}</a-tag>
          </div>
          <template v-if="authStore.user">
            <div><span class="text-gray-500">User:</span> {{ authStore.user.displayName }} ({{ authStore.user.email }})</div>
            <div><span class="text-gray-500">Role:</span> {{ authStore.user.role }}</div>
            <div><span class="text-gray-500">ID:</span> <code class="text-xs">{{ authStore.user.id }}</code></div>
          </template>
          <a-alert v-if="authStore.lastAuthError" type="error" :message="authStore.lastAuthError" show-icon />
        </div>
        <div class="flex gap-2 mt-3">
          <a-button size="small" @click="handleRefresh" :loading="authStore.authState === 'REFRESHING'">
            Refresh token
          </a-button>
        </div>
      </a-card>

      <!-- WS state -->
      <a-card title="WebSocket" size="small">
        <div class="space-y-2 text-sm">
          <div class="flex items-center gap-2">
            <span class="text-gray-500">State:</span>
            <a-tag :color="wsStateColor">{{ wsStore.state }}</a-tag>
          </div>
          <template v-if="wsStore.authResult">
            <div><span class="text-gray-500">Session ID:</span> <code class="text-xs">{{ wsStore.authResult.sessionId }}</code></div>
            <div><span class="text-gray-500">User ID:</span> <code class="text-xs">{{ wsStore.authResult.userId }}</code></div>
            <div><span class="text-gray-500">Persisted Seq:</span> <code class="text-xs">{{ wsStore.authResult.persistedEventSeq.toString() }}</code></div>
          </template>
          <a-alert v-if="wsStore.lastError" type="warning" :message="`[${wsStore.lastErrorKind}] ${wsStore.lastError}`" show-icon />
        </div>
        <div class="flex gap-2 mt-3">
          <a-button
            type="primary"
            size="small"
            :disabled="wsStore.state !== 'DISCONNECTED' || !authStore.accessToken"
            @click="handleReconnect"
          >
            Reconnect
          </a-button>
          <a-button
            size="small"
            :disabled="wsStore.state !== 'HELLO_COMPLETE' || !authStore.accessToken"
            @click="handleSendAuth"
          >
            Send AuthRequest
          </a-button>
          <a-button size="small" danger :disabled="wsStore.state === 'DISCONNECTED'" @click="wsStore.disconnect()">
            Disconnect
          </a-button>
        </div>
      </a-card>

      <!-- ServerHello capabilities -->
      <a-card v-if="serverHelloValue" title="ServerHello" size="small">
        <a-descriptions :column="1" bordered size="small">
          <a-descriptions-item label="server">{{ serverHelloValue.server }}</a-descriptions-item>
          <a-descriptions-item label="protocol_version">{{ serverHelloValue.protocolVersion }}</a-descriptions-item>
          <a-descriptions-item label="accepted_capabilities">
            <div class="flex flex-wrap gap-1">
              <a-tag v-for="cap in serverHelloValue.acceptedCapabilities" :key="cap" color="blue">
                {{ capabilityLabel(cap) }}
              </a-tag>
            </div>
          </a-descriptions-item>
          <a-descriptions-item v-if="serverHelloValue.rateLimitPolicy" label="rate_limit_policy">
            <pre class="text-xs m-0">{{ JSON.stringify(rateLimitPolicy, null, 2) }}</pre>
          </a-descriptions-item>
        </a-descriptions>
      </a-card>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useWsStore } from '@/stores/ws'
import { useSessionOrchestrator } from '@/composables/useSessionOrchestrator'
import { FeatureCapability } from '@/shared/proto/packets_pb'

const router = useRouter()
const authStore = useAuthStore()
const wsStore = useWsStore()
const { logout, connectAndAuthenticate } = useSessionOrchestrator()

const authStateColor = computed(() => {
  switch (authStore.authState) {
    case 'AUTHENTICATED': return 'green'
    case 'AUTH_DEGRADED': return 'orange'
    case 'LOGGING_IN': case 'REFRESHING': return 'orange'
    case 'AUTH_ERROR': return 'red'
    default: return 'default'
  }
})

const wsStateColor = computed(() => {
  switch (wsStore.state) {
    case 'LIVE_SYNCED': return 'green'
    case 'AUTH_COMPLETE': case 'BOOTSTRAPPING': case 'RECOVERING_GAP': case 'STALE_REBOOTSTRAP': return 'purple'
    case 'WS_CONNECTED': case 'HELLO_SENT': case 'AUTH_SENT': return 'orange'
    case 'HELLO_COMPLETE': return 'blue'
    default: return 'default'
  }
})

const serverHelloValue = computed(() => {
  if (wsStore.serverHello?.case === 'serverHello') return wsStore.serverHello.value
  return null
})

const rateLimitPolicy = computed(() => {
  const p = serverHelloValue.value?.rateLimitPolicy
  if (!p) return null
  return {
    max_envelope_bytes: p.maxEnvelopeBytes,
    per_connection_rps: p.perConnectionRps,
    per_connection_burst: p.perConnectionBurst,
    per_user_rps: p.perUserRps,
    per_user_burst: p.perUserBurst,
    outbound_queue_max: p.outboundQueueMax,
    max_sync_batch: p.maxSyncBatch,
  }
})

function capabilityLabel(cap: number): string {
  return FeatureCapability[cap] ?? `CAP_${cap}`
}

async function handleLogout() {
  await logout()
  router.push({ name: 'login' })
}

async function handleRefresh() {
  try {
    const token = await authStore.refresh()
    if (wsStore.state === 'DISCONNECTED' || wsStore.state === 'CONNECTING') {
      connectAndAuthenticate(token)
    }
  } catch {
    if (authStore.authState !== 'AUTH_DEGRADED') {
      router.push({ name: 'login' })
    }
  }
}

function handleReconnect() {
  if (authStore.accessToken) {
    connectAndAuthenticate(authStore.accessToken)
  }
}

function handleSendAuth() {
  if (authStore.accessToken) {
    wsStore.sendAuth(authStore.accessToken)
  }
}
</script>
