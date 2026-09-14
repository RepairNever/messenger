<template>
  <div class="min-h-screen bg-gray-50 flex items-center justify-center p-6">
    <a-card class="w-full max-w-lg shadow-md" title="Msgnr – Phase 1 WS Hello">
      <div class="space-y-4">
        <!-- Server URL -->
        <a-form layout="vertical">
          <a-form-item label="WebSocket URL">
            <a-input v-model:value="wsUrl" placeholder="ws://localhost:8080/ws" />
          </a-form-item>
        </a-form>

        <!-- Connect / Disconnect -->
        <div class="flex gap-3">
          <a-button
            type="primary"
            :disabled="wsStore.state !== 'DISCONNECTED'"
            @click="wsStore.connect(wsUrl)"
          >
            Connect
          </a-button>
          <a-button
            danger
            :disabled="wsStore.state === 'DISCONNECTED'"
            @click="wsStore.disconnect()"
          >
            Disconnect
          </a-button>
        </div>

        <!-- Connection state badge -->
        <div class="flex items-center gap-2">
          <span class="text-sm font-medium text-gray-600">State:</span>
          <a-tag :color="stateColor">{{ wsStore.state }}</a-tag>
        </div>

        <!-- Error -->
        <a-alert
          v-if="wsStore.lastError"
          type="error"
          :message="wsStore.lastError"
          show-icon
          closable
          @close="wsStore.lastError = null"
        />

        <!-- ServerHello result -->
        <template v-if="wsStore.state === 'HELLO_COMPLETE' && serverHelloValue">
          <a-divider>ServerHello</a-divider>
          <a-descriptions :column="1" bordered size="small">
            <a-descriptions-item label="server">
              {{ serverHelloValue.server }}
            </a-descriptions-item>
            <a-descriptions-item label="protocol_version">
              {{ serverHelloValue.protocolVersion }}
            </a-descriptions-item>
            <a-descriptions-item label="accepted_capabilities">
              <div class="flex flex-wrap gap-1">
                <a-tag
                  v-for="cap in serverHelloValue.acceptedCapabilities"
                  :key="cap"
                  color="blue"
                >
                  {{ capabilityLabel(cap) }}
                </a-tag>
              </div>
            </a-descriptions-item>
            <a-descriptions-item
              v-if="serverHelloValue.rateLimitPolicy"
              label="rate_limit_policy"
            >
              <pre class="text-xs m-0">{{ JSON.stringify(rateLimitPolicy, null, 2) }}</pre>
            </a-descriptions-item>
          </a-descriptions>
        </template>
      </div>
    </a-card>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useWsStore } from '@/stores/ws'
import { FeatureCapability } from '@/shared/proto/packets_pb'

const wsStore = useWsStore()
const wsUrl = ref('ws://localhost:8080/ws')

const stateColor = computed(() => {
  switch (wsStore.state) {
    case 'WS_CONNECTED':
    case 'HELLO_SENT':
      return 'orange'
    case 'HELLO_COMPLETE':
      return 'green'
    case 'DISCONNECTED':
    default:
      return 'default'
  }
})

const serverHelloValue = computed(() => {
  if (wsStore.serverHello?.case === 'serverHello') {
    return wsStore.serverHello.value
  }
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

const CAPABILITY_LABELS: Record<number, string> = {
  [FeatureCapability.THREADS]: 'THREADS',
  [FeatureCapability.REACTIONS]: 'REACTIONS',
  [FeatureCapability.TYPING]: 'TYPING',
  [FeatureCapability.PRESENCE]: 'PRESENCE',
  [FeatureCapability.BOOTSTRAP_PAGINATION]: 'BOOTSTRAP_PAGINATION',
  [FeatureCapability.SYNC_SINCE]: 'SYNC_SINCE',
  [FeatureCapability.CALL_INVITES]: 'CALL_INVITES',
  [FeatureCapability.INVITE_ACTIONS]: 'INVITE_ACTIONS',
}

function capabilityLabel(cap: number): string {
  return CAPABILITY_LABELS[cap] ?? `CAP_${cap}`
}
</script>
