<template>
  <aside class="w-[360px] max-w-[42vw] border-l border-chat-border bg-chat-header flex flex-col">
    <!-- Header -->
    <header class="flex items-center justify-between px-4 py-3 border-b border-chat-border shrink-0">
      <div class="flex items-center gap-2">
        <svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/>
          <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>
        </svg>
        <span class="text-sm font-semibold text-white">Members</span>
        <span v-if="!loading && members.length > 0" class="text-xs text-gray-500">{{ members.length }}</span>
      </div>
      <div class="flex items-center gap-1">
        <!-- Add member button — only for public channels -->
        <button
          v-if="visibility === 'public' || visibility === 'private'"
          class="h-7 w-7 rounded flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
          title="Add member"
          @click="openInviteDialog"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
            <circle cx="8.5" cy="7" r="4"/>
            <line x1="20" y1="8" x2="20" y2="14"/>
            <line x1="23" y1="11" x2="17" y2="11"/>
          </svg>
        </button>
        <button
          class="h-7 w-7 rounded flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
          title="Close members"
          @click="$emit('close')"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>
    </header>

    <!-- Scrollable body -->
    <div class="flex-1 overflow-y-auto py-2">
      <!-- Loading -->
      <div v-if="loading" class="flex items-center justify-center py-10">
        <svg class="h-5 w-5 animate-spin text-gray-500" viewBox="0 0 24 24" fill="none">
          <circle class="opacity-25" cx="12" cy="12" r="9" stroke="currentColor" stroke-width="3"/>
          <path class="opacity-90" d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
        </svg>
      </div>

      <!-- Error -->
      <div v-else-if="error" class="px-4 py-6 text-xs text-red-400 text-center">
        {{ error }}
      </div>

      <!-- Empty -->
      <div v-else-if="members.length === 0" class="px-4 py-6 text-xs text-gray-500 text-center">
        No members found.
      </div>

      <!-- Member rows -->
      <ul v-else>
        <li
          v-for="member in members"
          :key="member.user_id"
          class="flex items-center gap-3 px-4 py-2 hover:bg-white/5 transition-colors"
        >
          <UserAvatar
            :user-id="member.user_id"
            :display-name="member.display_name || member.email"
            :avatar-url="member.avatar_url"
            :custom-status="userCustomStatusFromDto(member.custom_status)"
            size="md"
          />
          <!-- Name + email -->
          <div class="min-w-0 flex-1">
            <div class="text-sm text-white truncate leading-tight">
              {{ member.display_name || member.email }}
            </div>
            <div v-if="member.display_name" class="text-xs text-gray-500 truncate leading-tight">
              {{ member.email }}
            </div>
          </div>
          <button
            v-if="canRemoveMember(member)"
            class="h-7 w-7 shrink-0 rounded flex items-center justify-center text-gray-500 hover:text-red-300 hover:bg-red-500/10 transition-colors disabled:opacity-50 disabled:pointer-events-none"
            title="Remove member"
            data-testid="remove-member-button"
            :data-user-id="member.user_id"
            :disabled="removeSubmittingId === member.user_id"
            @click.stop="removeMember(member.user_id)"
          >
            <svg
              v-if="removeSubmittingId === member.user_id"
              class="h-4 w-4 animate-spin"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <circle class="opacity-25" cx="12" cy="12" r="9" stroke="currentColor" stroke-width="3"/>
              <path class="opacity-90" d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
            </svg>
            <svg
              v-else
              class="h-4 w-4"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
              <circle cx="8.5" cy="7" r="4"/>
              <line x1="18" y1="8" x2="23" y2="13"/>
              <line x1="23" y1="8" x2="18" y2="13"/>
            </svg>
          </button>
        </li>
      </ul>
      <div v-if="removeError" class="px-4 py-2 text-xs text-red-400">
        {{ removeError }}
      </div>
    </div>
  </aside>

  <!-- Invite modal -->
  <Teleport to="body">
    <div
      v-if="inviteOpen"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      @click.self="closeInviteDialog"
    >
      <div class="w-full max-w-sm overflow-hidden rounded-xl border border-chat-border bg-chat-header shadow-2xl flex flex-col max-h-[70vh]">
        <!-- Dialog header -->
        <div class="flex items-center justify-between px-5 py-4 border-b border-chat-border shrink-0">
          <h2 class="text-sm font-semibold text-white">Add member</h2>
          <button
            class="h-7 w-7 rounded flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
            @click="closeInviteDialog"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <!-- Search input -->
        <div class="px-4 py-3 border-b border-chat-border shrink-0">
          <input
            v-model="inviteSearch"
            type="text"
            placeholder="Search by name or email…"
            class="w-full bg-chat-input border border-chat-border rounded px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-accent"
            autofocus
          />
        </div>

        <!-- Candidates loading -->
        <div v-if="inviteLoading" class="flex items-center justify-center py-8">
          <svg class="h-5 w-5 animate-spin text-gray-500" viewBox="0 0 24 24" fill="none">
            <circle class="opacity-25" cx="12" cy="12" r="9" stroke="currentColor" stroke-width="3"/>
            <path class="opacity-90" d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
          </svg>
        </div>

        <!-- Empty candidates -->
        <div
          v-else-if="filteredCandidates.length === 0"
          class="px-4 py-6 text-xs text-gray-500 text-center"
        >
          {{ inviteSearch ? 'No users match your search.' : 'Everyone is already a member.' }}
        </div>

        <!-- Candidate list -->
        <ul v-else class="overflow-y-auto flex-1 py-1">
          <li
            v-for="candidate in filteredCandidates"
            :key="candidate.user_id"
            class="flex items-center gap-3 px-4 py-2 hover:bg-white/5 transition-colors cursor-pointer"
            :class="inviteSubmittingId === candidate.user_id ? 'opacity-50 pointer-events-none' : ''"
            @click="inviteUser(candidate.user_id)"
          >
            <UserAvatar
              :user-id="candidate.user_id"
              :display-name="candidate.display_name || candidate.email"
              :avatar-url="candidate.avatar_url"
              :custom-status="userCustomStatusFromDto(candidate.custom_status)"
              size="md"
            />
            <div class="min-w-0 flex-1">
              <div class="text-sm text-white truncate leading-tight">
                {{ candidate.display_name || candidate.email }}
              </div>
              <div v-if="candidate.display_name" class="text-xs text-gray-500 truncate leading-tight">
                {{ candidate.email }}
              </div>
            </div>
            <svg
              v-if="inviteSubmittingId === candidate.user_id"
              class="h-4 w-4 animate-spin text-gray-400 shrink-0"
              viewBox="0 0 24 24"
              fill="none"
            >
              <circle class="opacity-25" cx="12" cy="12" r="9" stroke="currentColor" stroke-width="3"/>
              <path class="opacity-90" d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
            </svg>
          </li>
        </ul>

        <!-- Error -->
        <div v-if="inviteError" class="px-4 py-2 border-t border-chat-border shrink-0">
          <p class="text-xs text-red-400">{{ inviteError }}</p>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useChatStore } from '@/stores/chat'
import { useAuthStore } from '@/stores/auth'
import UserAvatar from './UserAvatar.vue'
import {
  listConversationMembers,
  listDmCandidates,
  inviteToConversation,
  removeConversationMember,
  type ConversationMemberItem,
  type DmCandidateItem,
  ChatApiError,
} from '@/services/http/chatApi'
import { userCustomStatusFromDto } from '@/types/userStatus'

const props = defineProps<{ visibility?: string }>()
defineEmits<{ close: [] }>()

const chat = useChatStore()
const auth = useAuthStore()

// ── Members list ──────────────────────────────────────────────────────────────

const members = ref<ConversationMemberItem[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const removeError = ref<string | null>(null)
const removeSubmittingId = ref<string | null>(null)

const selfUserId = computed(() => auth.user?.id ?? '')
const canRemoveMembers = computed(() => {
  if (props.visibility === 'private') return true
  if (props.visibility !== 'public') return false
  const role = auth.user?.role
  return role === 'admin' || role === 'owner'
})

function canRemoveMember(member: ConversationMemberItem) {
  return canRemoveMembers.value && member.user_id !== selfUserId.value
}

async function fetchMembers(conversationId: string) {
  if (!conversationId) return
  loading.value = true
  error.value = null
  removeError.value = null
  try {
    members.value = await listConversationMembers(conversationId)
    for (const member of members.value) {
      chat.registerUserIdentity(member.user_id, member.display_name, member.email, member.avatar_url, userCustomStatusFromDto(member.custom_status))
    }
  } catch {
    error.value = 'Failed to load members.'
    members.value = []
  } finally {
    loading.value = false
  }
}

async function removeMember(userId: string) {
  const conversationId = chat.activeConversation?.id
  if (!conversationId || userId === selfUserId.value) return

  removeSubmittingId.value = userId
  removeError.value = null
  try {
    await removeConversationMember(conversationId, userId)
    await fetchMembers(conversationId)
  } catch (e) {
    removeError.value = e instanceof ChatApiError ? e.message : 'Failed to remove member.'
  } finally {
    removeSubmittingId.value = null
  }
}

onMounted(() => {
  const id = chat.activeConversation?.id
  if (id) fetchMembers(id)
})

watch(
  () => chat.activeConversation?.id,
  (id) => { if (id) fetchMembers(id) },
)

// ── Invite dialog ─────────────────────────────────────────────────────────────

const inviteOpen = ref(false)
const inviteCandidates = ref<DmCandidateItem[]>([])
const inviteSearch = ref('')
const inviteLoading = ref(false)
const inviteError = ref<string | null>(null)
const inviteSubmittingId = ref<string | null>(null)

const filteredCandidates = computed(() => {
  const q = inviteSearch.value.trim().toLowerCase()
  return inviteCandidates.value.filter(c => {
    if (!q) return true
    return c.display_name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q)
  })
})

async function openInviteDialog() {
  inviteOpen.value = true
  inviteSearch.value = ''
  inviteError.value = null
  inviteLoading.value = true
  try {
    const all = await listDmCandidates()
    for (const candidate of all) {
      chat.registerUserIdentity(candidate.user_id, candidate.display_name, candidate.email, candidate.avatar_url, userCustomStatusFromDto(candidate.custom_status))
    }
    // Filter out users already in the channel
    const memberIds = new Set(members.value.map(m => m.user_id))
    inviteCandidates.value = all.filter(c => !memberIds.has(c.user_id))
  } catch {
    inviteError.value = 'Failed to load users.'
    inviteCandidates.value = []
  } finally {
    inviteLoading.value = false
  }
}

function closeInviteDialog() {
  inviteOpen.value = false
  inviteError.value = null
}

async function inviteUser(userId: string) {
  const conversationId = chat.activeConversation?.id
  if (!conversationId) return

  inviteSubmittingId.value = userId
  inviteError.value = null
  try {
    await inviteToConversation(conversationId, userId)
    // Remove the invited user from the candidates list so they cannot be
    // added twice without reopening the dialog.
    inviteCandidates.value = inviteCandidates.value.filter(c => c.user_id !== userId)
    // Refresh the members panel in the background.
    await fetchMembers(conversationId)
  } catch (e) {
    inviteError.value = e instanceof ChatApiError ? e.message : 'Failed to add member.'
  } finally {
    inviteSubmittingId.value = null
  }
}
</script>
