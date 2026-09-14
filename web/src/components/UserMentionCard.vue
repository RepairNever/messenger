<template>
  <div
    class="fixed z-[10030] w-64 rounded-xl border border-chat-border bg-chat-header p-3 shadow-2xl"
    :style="{ top: `${top}px`, left: `${left}px` }"
    @click.stop
  >
    <div class="flex items-center gap-3">
      <UserAvatar
        :user-id="userId"
        :display-name="displayName"
        :avatar-url="avatarUrl"
        :custom-status="customStatus"
        size="md"
      />
      <div class="min-w-0">
        <div class="truncate text-sm font-semibold text-white">
          {{ displayName }}
        </div>
        <div class="truncate text-xs text-gray-400">
          {{ email || 'No email available' }}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import UserAvatar from '@/components/UserAvatar.vue'
import type { UserCustomStatus } from '@/types/userStatus'

defineProps<{
  userId: string
  displayName: string
  email: string
  avatarUrl: string
  customStatus?: UserCustomStatus | null
  top: number
  left: number
}>()
</script>
