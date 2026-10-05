/*
 * Dev-only harness: renders the real CallDock.vue with real pinia stores,
 * network stubbed at the axios level. Served via `web/callpreview.html`.
 * Not wired into the app router or production build entry.
 */
import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import axios, { type InternalAxiosRequestConfig } from 'axios'
import '@/style.css'

const DM_CANDIDATES = [
  { user_id: 'u-bob', display_name: 'Bob', email: 'bob@example.com', avatar_url: '' },
  { user_id: 'u-eve', display_name: 'Eve', email: 'eve@example.com', avatar_url: '' },
  { user_id: 'u-mark', display_name: 'Mark Spencer', email: 'mark@example.com', avatar_url: '' },
]

axios.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
  const url = config.url ?? ''
  await new Promise(resolve => setTimeout(resolve, 120))
  if (url.includes('/api/dm-candidates')) {
    return { data: DM_CANDIDATES, status: 200, statusText: 'OK', headers: {}, config }
  }
  return { data: {}, status: 200, statusText: 'OK', headers: {}, config }
}

const { default: CallDock } = await import('@/components/CallDock.vue')
const { useCallStore } = await import('@/stores/call')
const { useAuthStore } = await import('@/stores/auth')
const { useChatStore } = await import('@/stores/chat')

const app = createApp({ render: () => h(CallDock) })
app.use(createPinia())
app.mount('#app')

const call = useCallStore()
const auth = useAuthStore()
const chat = useChatStore()

auth.$patch({
  user: {
    id: 'u-self',
    email: 'ada@example.com',
    displayName: 'Ada Laine',
    avatarUrl: '',
  },
} as never)

chat.$patch({
  workspace: {
    selfUserId: 'u-self',
    selfDisplayName: 'Ada Laine',
    selfAvatarUrl: '',
  },
} as never)

call.$patch({
  connected: true,
  activeConversationTitle: 'Design huddle',
  micEnabled: true,
  cameraEnabled: false,
  screenShareEnabled: false,
} as never)

// Expose a tiny console handle for interactive state pokes during review.
;(window as unknown as Record<string, unknown>).__call = call
