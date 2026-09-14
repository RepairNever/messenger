import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import './style.css'
import 'emoji-mart-vue-fast/css/emoji-mart.css'
import { initPlatform } from '@/platform'
import { hydrateTokenStorageFromSecureStore } from '@/services/storage/tokenStorage'
import { applyStoredColorTheme } from '@/composables/useColorTheme'

applyStoredColorTheme()

async function bootstrap() {
  try {
    const platform = await initPlatform()
    if (platform.type === 'tauri') {
      void platform.system.checkForUpdates?.()
    }
  } catch (error) {
    // Never block app startup on platform initialization.
    console.error('[bootstrap] Platform init failed:', error)
  }

  await hydrateTokenStorageFromSecureStore()

  const app = createApp(App)
  app.use(createPinia())
  app.use(router)
  app.mount('#app')
}

void bootstrap()
