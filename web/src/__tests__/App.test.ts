import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import App from '@/App.vue'
import { useAuthStore } from '@/stores/auth'
import { TOKEN_STORAGE_KEYS, setAccessToken, setRefreshToken } from '@/services/storage/tokenStorage'

vi.mock('@/composables/useSessionOrchestrator', () => ({
  useSessionOrchestrator: () => ({
    isStartupLoading: ref(false),
    startupMessage: ref(''),
  }),
}))

describe('App', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('clears session and redirects on cross-tab token removal', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/login', name: 'login', component: { template: '<div>login</div>' }, meta: { public: true } },
        { path: '/', name: 'main', component: { template: '<div>main</div>' }, meta: { requiresAuth: true } },
      ],
    })
    router.push('/')
    await router.isReady()

    setAccessToken('access-token')
    setRefreshToken('refresh-token')

    const authStore = useAuthStore()
    authStore.authState = 'AUTHENTICATED'
    const clearSessionSpy = vi.spyOn(authStore, 'clearSession')
    const replaceSpy = vi.spyOn(router, 'replace')

    mount(App, {
      global: {
        plugins: [router],
        stubs: {
          Teleport: true,
          PwaUpdateBanner: true,
        },
      },
    })

    await nextTick()

    localStorage.removeItem(TOKEN_STORAGE_KEYS.access)
    localStorage.removeItem(TOKEN_STORAGE_KEYS.refresh)
    window.dispatchEvent(new StorageEvent('storage', {
      key: TOKEN_STORAGE_KEYS.refresh,
      oldValue: 'refresh-token',
      newValue: null,
    }))

    await nextTick()

    expect(clearSessionSpy).toHaveBeenCalledTimes(1)
    expect(replaceSpy).toHaveBeenCalledWith({ name: 'login' })
  })
})
