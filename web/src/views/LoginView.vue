<template>
  <div class="min-h-screen bg-sidebar-bg flex items-center justify-center p-6">
    <div class="w-full max-w-sm">

      <!-- Logo / brand -->
      <div class="text-center mb-8">
        <div class="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-accent mb-4">
          <svg class="w-7 h-7 text-app-onAccent" fill="currentColor" viewBox="0 0 24 24">
            <path d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"/>
          </svg>
        </div>
        <h1 class="text-2xl font-bold text-app-text">Sign in to Msgnr</h1>
        <p class="text-sidebar-textMuted text-sm mt-1">Your team messaging platform</p>
      </div>

      <!-- Card -->
      <div class="bg-chat-input border border-chat-border rounded-xl p-7 shadow-2xl">
        <form @submit.prevent="handleSubmit" novalidate>
          <div v-if="isDesktopLogin" class="mb-4">
            <label class="block text-sm font-medium text-app-secondaryText mb-1.5">Backend URL</label>
            <input
              v-model="form.backendUrl"
              type="url"
              autocomplete="url"
              placeholder="https://chat.company.internal"
              required
              class="w-full bg-sidebar-bg border border-chat-border rounded-lg px-3 py-2.5 text-app-text placeholder-gray-600 text-sm outline-none focus:border-accent transition-colors"
              :class="errors.backendUrl ? 'border-red-500' : ''"
              @blur="validateBackendUrl"
            />
            <p class="text-app-muted text-xs mt-1">Desktop client connects to this Msgnr server.</p>
            <p v-if="errors.backendUrl" class="text-red-400 text-xs mt-1">{{ errors.backendUrl }}</p>
          </div>

          <div class="mb-4">
            <label class="block text-sm font-medium text-app-secondaryText mb-1.5">Login</label>
            <input
              v-model="form.email"
              type="text"
              autocomplete="username"
              placeholder="Login"
              class="w-full bg-sidebar-bg border border-chat-border rounded-lg px-3 py-2.5 text-app-text placeholder-gray-600 text-sm outline-none focus:border-accent transition-colors"
            />
          </div>

          <div class="mb-5">
            <label class="block text-sm font-medium text-app-secondaryText mb-1.5">Password</label>
            <div class="relative">
              <input
                v-model="form.password"
                :type="showPassword ? 'text' : 'password'"
                autocomplete="current-password"
                placeholder="••••••••"
                required
                class="w-full bg-sidebar-bg border border-chat-border rounded-lg px-3 py-2.5 text-app-text placeholder-gray-600 text-sm outline-none focus:border-accent transition-colors pr-10"
                :class="errors.password ? 'border-red-500' : ''"
                @blur="validatePassword"
              />
              <button
                type="button"
                class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors"
                @click="showPassword = !showPassword"
              >
                <svg v-if="showPassword" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                  <path d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"/>
                </svg>
                <svg v-else class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                  <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
                </svg>
              </button>
            </div>
            <p v-if="errors.password" class="text-red-400 text-xs mt-1">{{ errors.password }}</p>
          </div>

          <!-- Server error -->
          <div
            v-if="authStore.lastAuthError && authStore.authState === 'AUTH_ERROR'"
            class="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2.5 mb-4"
          >
            <svg class="w-4 h-4 text-red-400 shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
              <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/>
            </svg>
            <span class="text-red-400 text-sm">{{ authStore.lastAuthError }}</span>
          </div>

          <button
            type="submit"
            class="w-full py-2.5 rounded-lg bg-accent hover:bg-accent-hover text-app-onAccent font-semibold text-sm transition-colors flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
            :disabled="authStore.authState === 'LOGGING_IN'"
          >
            <svg v-if="authStore.authState === 'LOGGING_IN'" class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
            </svg>
            {{ authStore.authState === 'LOGGING_IN' ? 'Signing in…' : 'Sign in' }}
          </button>

        </form>
      </div>

    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useSessionOrchestrator } from '@/composables/useSessionOrchestrator'
import { isTauriRuntime } from '@/platform/runtime'
import {
  getBackendBaseUrl,
  normalizeBackendBaseUrl,
  setBackendBaseUrl,
} from '@/services/runtime/backendEndpoint'

const router = useRouter()
const authStore = useAuthStore()
const { login } = useSessionOrchestrator()
const isDesktopLogin = isTauriRuntime()

const form = reactive({
  backendUrl: isDesktopLogin ? getBackendBaseUrl() : '',
  email: '',
  password: '',
})
const showPassword = ref(false)
const errors = reactive({ backendUrl: '', password: '' })

function validateBackendUrl() {
  if (!isDesktopLogin) return true
  if (!form.backendUrl) {
    errors.backendUrl = 'Backend URL is required'
    return false
  }
  const normalized = normalizeBackendBaseUrl(form.backendUrl)
  if (!normalized) {
    errors.backendUrl = 'Enter a valid http(s) backend URL'
    return false
  }
  errors.backendUrl = ''
  form.backendUrl = normalized
  return true
}

function validatePassword() {
  if (!form.password) { errors.password = 'Password is required'; return false }
  errors.password = ''; return true
}

async function handleSubmit() {
  const b = validateBackendUrl()
  const p = validatePassword()
  if (!b || !p) return
  try {
    if (isDesktopLogin) {
      setBackendBaseUrl(form.backendUrl)
    }
    await login(form.email, form.password)
    router.push({ name: 'main' })
  } catch {
    // error surfaced via authStore.lastAuthError
  }
}
</script>
