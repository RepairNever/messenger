<template>
  <div
    class="relative inline-flex shrink-0"
    :class="wrapperClass"
    :title="avatarTitle"
  >
    <img
      v-if="showImage"
      :src="avatarSrc"
      :alt="displayLabel"
      class="h-full w-full rounded-full object-cover"
      @error="onImageError"
    >
    <div
      v-else
      class="flex h-full w-full items-center justify-center rounded-full text-white font-semibold select-none"
      :style="{ backgroundColor: fallbackColor }"
    >
      {{ initial }}
    </div>

    <span
      v-if="presence"
      class="absolute right-0 bottom-0 block rounded-full border-2 border-chat-header"
      :class="presenceClass"
    />
    <span
      v-if="statusIndicator"
      class="pointer-events-none absolute left-[72%] top-1/2 z-10 inline-flex -translate-y-1/2 items-center justify-center leading-none drop-shadow"
      :class="statusIconClass"
      :title="customStatusTitle"
      :aria-label="customStatusTitle"
    >
      {{ statusIndicator }}
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { getActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'
import {
  getCachedAvatarObjectUrl,
  loadCachedAvatarUrl,
  resolveAvatarUrlForDisplay,
} from '@/services/avatar/avatarCache'
import {
  formatUserCustomStatusTitle,
  isUserCustomStatusActive,
  type UserCustomStatus,
} from '@/types/userStatus'

const props = withDefaults(defineProps<{
  userId: string
  displayName?: string
  avatarUrl?: string
  customStatus?: UserCustomStatus | null
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  presence?: 'online' | 'away' | 'offline'
}>(), {
  displayName: '',
  avatarUrl: '',
  customStatus: undefined,
  size: 'md',
  presence: undefined,
})

type AvatarSize = NonNullable<(typeof props)['size']>
type AvatarPresence = NonNullable<(typeof props)['presence']>

const errored = ref(false)
const avatarSrc = ref('')
const nowMs = ref(Date.now())
let expiryTimer: ReturnType<typeof setTimeout> | null = null
let avatarLoadToken = 0

watch(() => props.avatarUrl, (nextUrl) => {
  errored.value = false
  const token = ++avatarLoadToken
  const rawUrl = nextUrl ?? ''
  const displayUrl = resolveAvatarUrlForDisplay(rawUrl)
  avatarSrc.value = getCachedAvatarObjectUrl(rawUrl)

  if (!displayUrl) return

  void loadCachedAvatarUrl(rawUrl)
    .then((cachedUrl) => {
      if (token !== avatarLoadToken) return
      avatarSrc.value = cachedUrl || displayUrl
    })
    .catch(() => {
      if (token !== avatarLoadToken) return
      avatarSrc.value = displayUrl
    })
}, { immediate: true })

const displayLabel = computed(() => {
  const name = (props.displayName ?? '').trim()
  return name || 'Unknown user'
})

const chatStore = getActivePinia() ? useChatStore() : null

const resolvedCustomStatus = computed(() => {
  if (props.customStatus !== undefined) return props.customStatus
  return chatStore?.resolveUserCustomStatus(props.userId) ?? null
})

const activeCustomStatus = computed(() => {
  const status = resolvedCustomStatus.value
  return isUserCustomStatusActive(status, nowMs.value) ? status : null
})

const customStatusTitle = computed(() => {
  const status = activeCustomStatus.value
  return status ? formatUserCustomStatusTitle(status) : ''
})

const avatarTitle = computed(() => {
  const status = customStatusTitle.value
  return status ? `${displayLabel.value}: ${status}` : displayLabel.value
})

const showImage = computed(() => {
  const url = avatarSrc.value
  return url.length > 0 && !errored.value
})

const initial = computed(() => {
  const source = displayLabel.value
  return source.charAt(0).toUpperCase() || '?'
})

const avatarSizeClasses: Record<AvatarSize, string> = {
  xs: 'h-5 w-5 text-[10px]',
  sm: 'h-7 w-7 text-xs',
  md: 'h-8 w-8 text-sm',
  lg: 'h-10 w-10 text-base',
  xl: 'h-14 w-14 text-xl',
}

const statusIconTextClasses: Record<AvatarSize, string> = {
  xs: 'text-base',
  sm: 'text-xl',
  md: 'text-2xl',
  lg: 'text-3xl',
  xl: 'text-4xl',
}

const presenceStateClasses: Record<AvatarPresence, string> = {
  online: 'h-2.5 w-2.5 bg-green-400',
  away: 'h-2.5 w-2.5 bg-amber-400',
  offline: 'h-2.5 w-2.5 bg-gray-500',
}

const wrapperClass = computed(() => avatarSizeClasses[props.size])

const presenceClass = computed(() => {
  if (!props.presence) return ''
  return presenceStateClasses[props.presence]
})

const statusIconClass = computed(() => statusIconTextClasses[props.size])

const statusIndicator = computed(() => activeCustomStatus.value?.emoji?.trim() ?? '')

const palette = [
  '#E8912D', '#D9B51C', '#3AA3A0', '#EC4899',
  '#8B5CF6', '#06B6D4', '#10B981', '#F59E0B',
]

const fallbackColor = computed(() => {
  const key = (props.userId || displayLabel.value).trim()
  let hash = 0
  for (let i = 0; i < key.length; i++) {
    hash = (Math.imul(31, hash) + key.charCodeAt(i)) | 0
  }
  return palette[Math.abs(hash) % palette.length]
})

function onImageError() {
  errored.value = true
}

function clearExpiryTimer() {
  if (!expiryTimer) return
  clearTimeout(expiryTimer)
  expiryTimer = null
}

function scheduleExpiryTimer() {
  clearExpiryTimer()
  const status = activeCustomStatus.value
  if (!status) return
  const expiresMs = Date.parse(status.expiresAt)
  if (!Number.isFinite(expiresMs)) return
  const delay = Math.max(0, Math.min(expiresMs - Date.now() + 250, 2_147_483_647))
  expiryTimer = setTimeout(() => {
    nowMs.value = Date.now()
    scheduleExpiryTimer()
  }, delay)
}

watch(() => activeCustomStatus.value?.expiresAt ?? '', scheduleExpiryTimer, { immediate: true })

onBeforeUnmount(clearExpiryTimer)
</script>
