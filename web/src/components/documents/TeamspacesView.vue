<template>
  <div class="flex h-full flex-col overflow-hidden bg-chat-bg" data-testid="documents-teamspaces-view">
    <div class="flex items-center justify-between border-b border-chat-border px-6 py-4">
      <div>
        <h1 class="text-lg font-semibold text-white">Teamspaces</h1>
        <p class="mt-1 text-sm text-gray-400">Browse public teamspaces or manage the ones you own.</p>
      </div>
      <button
        type="button"
        class="rounded bg-accent px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
        data-testid="documents-create-teamspace"
        @click="openCreateModal"
      >
        Create teamspace
      </button>
    </div>

    <div class="flex-1 overflow-y-auto px-6 py-4">
      <div v-if="joinError" class="mb-3 text-sm text-red-400">{{ joinError }}</div>
      <div v-if="documentsStore.teamspacesLoading" class="text-sm text-gray-500">Loading teamspaces...</div>
      <div v-else-if="documentsStore.teamspacesError" class="text-sm text-red-400">{{ documentsStore.teamspacesError }}</div>
      <div v-else-if="documentsStore.teamspaces.length === 0" class="text-sm text-gray-500">No teamspaces yet.</div>
      <table v-else class="w-full border-separate border-spacing-0 overflow-hidden rounded-xl border border-chat-border bg-chat-header">
        <thead>
          <tr class="text-left text-xs uppercase tracking-wide text-gray-500">
            <th class="border-b border-chat-border px-4 py-3">Name</th>
            <th class="border-b border-chat-border px-4 py-3">Members</th>
            <th class="border-b border-chat-border px-4 py-3">Private</th>
            <th class="border-b border-chat-border px-4 py-3 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="teamspace in documentsStore.teamspaces"
            :key="teamspace.id"
            class="border-b border-chat-border/80 text-sm text-gray-200"
            :class="props.selectedTeamspaceId === teamspace.id ? 'bg-white/5' : ''"
          >
            <td class="px-4 py-3">
              <button
                type="button"
                class="text-left transition-colors hover:text-white"
                :data-testid="`teamspace-row-${teamspace.id}`"
                :disabled="!teamspace.is_member"
                @click="teamspace.is_member && $emit('openTeamspace', teamspace.id)"
              >
                {{ teamspace.name }}
              </button>
            </td>
            <td class="px-4 py-3">
              <div class="relative inline-flex items-center">
                <button
                  v-if="!teamspace.is_member"
                  type="button"
                  class="rounded border border-accent/50 px-2 py-1 text-xs font-medium text-accent transition-colors hover:border-accent hover:text-white"
                  :data-testid="`teamspace-join-${teamspace.id}`"
                  @click="joinTeamspace(teamspace.id)"
                >
                  Join
                </button>
                <div
                  v-else
                  class="relative"
                  @mouseenter="openMembersPopup(teamspace.id, $event)"
                  @mouseleave="closeMembersPopup(teamspace.id)"
                >
                  <span class="cursor-default text-sm text-gray-300">
                    {{ teamspace.member_count }} members
                  </span>
                </div>
              </div>
            </td>
            <td class="px-4 py-3">
              <input
                :checked="teamspace.is_private"
                type="checkbox"
                class="pointer-events-none h-4 w-4 rounded border-chat-border bg-chat-input"
                aria-label="Private teamspace"
              >
            </td>
            <td class="px-4 py-3 text-right">
              <div v-if="teamspace.can_manage" class="flex justify-end gap-2">
                <button
                  type="button"
                  class="rounded border border-chat-border px-2 py-1 text-xs text-gray-300 transition-colors hover:text-white"
                  @click="openEditModal(teamspace.id)"
                >
                  Edit
                </button>
                <button
                  type="button"
                  class="rounded border border-red-500/40 px-2 py-1 text-xs text-red-300 transition-colors hover:border-red-400 hover:text-red-200"
                  :data-testid="`teamspace-delete-${teamspace.id}`"
                  @click="openDeleteConfirm(teamspace.id)"
                >
                  Delete
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <Teleport to="body">
    <div
      v-if="membersPopup"
      data-testid="documents-teamspace-members-popup"
      class="pointer-events-none fixed z-[70] min-w-52 rounded-lg border border-chat-border bg-chat-header p-2 shadow-2xl"
      :style="{ top: `${membersPopup.top}px`, left: `${membersPopup.left}px` }"
    >
      <div
        v-for="member in popupMembers"
        :key="member.id"
        class="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-gray-200"
      >
        <UserAvatar
          :user-id="member.id"
          :display-name="member.display_name"
          :avatar-url="member.avatar_url"
          :custom-status="userCustomStatusFromDto(member.custom_status)"
          size="xs"
        />
        <span class="truncate">{{ member.display_name }}</span>
      </div>
    </div>
  </Teleport>

  <Teleport to="body">
    <div
      v-if="deleteConfirmOpen"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      @click.self="closeDeleteConfirm"
    >
      <div class="w-full max-w-sm rounded-xl border border-chat-border bg-chat-header p-5 shadow-2xl">
        <h3 class="text-base font-semibold text-white">Delete teamspace?</h3>
        <p class="mt-2 text-sm text-gray-300">
          This will hide "{{ deleteTeamspaceName }}" and archive all documents in it.
        </p>
        <p v-if="deleteError" class="mt-3 text-xs text-red-400">{{ deleteError }}</p>
        <div class="mt-4 flex justify-end gap-2">
          <button
            type="button"
            class="rounded border border-chat-border px-3 py-1.5 text-sm text-gray-300 transition-colors hover:text-white"
            :disabled="deleteSaving"
            @click="closeDeleteConfirm"
          >
            Cancel
          </button>
          <button
            type="button"
            class="rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50"
            :disabled="deleteSaving"
            data-testid="teamspace-delete-confirm"
            @click="confirmDeleteTeamspace"
          >
            {{ deleteSaving ? 'Deleting...' : 'Delete' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>

  <Teleport to="body">
    <div
      v-if="modalOpen"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      @click.self="closeModal"
    >
      <div class="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-chat-border bg-chat-header shadow-2xl">
        <div class="flex items-center justify-between border-b border-chat-border px-5 py-4">
          <h3 class="text-base font-semibold text-white">
            {{ editingTeamspaceId ? 'Edit teamspace' : 'Create teamspace' }}
          </h3>
          <button type="button" class="rounded p-1 text-gray-400 transition-colors hover:text-white" @click="closeModal">
            <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div class="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div>
            <label class="mb-1 block text-sm text-gray-400">Name</label>
            <input
              v-model="form.name"
              type="text"
              class="w-full rounded border border-chat-border bg-chat-input px-3 py-2 text-sm text-white outline-none focus:border-accent"
              placeholder="Engineering docs"
            >
          </div>

          <label class="flex items-center gap-2 text-sm text-gray-300">
            <input v-model="form.is_private" type="checkbox" class="h-4 w-4 rounded border-chat-border bg-chat-input">
            Private teamspace
          </label>

          <div>
            <div class="mb-2 text-sm text-gray-400">Members</div>
            <div v-if="!documentsStore.usersLoaded" class="text-xs text-gray-500">Loading users...</div>
            <div v-else class="max-h-64 space-y-2 overflow-y-auto rounded border border-chat-border bg-chat-input/50 p-2">
              <label
                v-for="user in documentsStore.users"
                :key="user.id"
                class="flex cursor-pointer items-center gap-3 rounded px-2 py-1.5 text-sm text-gray-200 hover:bg-white/5"
              >
                <input
                  :checked="selectedMemberIds.includes(user.id)"
                  type="checkbox"
                  class="h-4 w-4 rounded border-chat-border bg-chat-input"
                  @change="toggleMember(user.id)"
                >
                <UserAvatar
                  :user-id="user.id"
                  :display-name="user.display_name || user.email"
                  :avatar-url="user.avatar_url ?? ''"
                  :custom-status="userCustomStatusFromDto(user.custom_status)"
                  size="xs"
                />
                <span class="truncate">{{ user.display_name || user.email }}</span>
              </label>
            </div>
          </div>

          <p v-if="modalError" class="text-xs text-red-400">{{ modalError }}</p>
        </div>

        <div class="flex justify-end gap-2 border-t border-chat-border px-5 py-4">
          <button
            type="button"
            class="rounded border border-chat-border px-3 py-1.5 text-sm text-gray-300 transition-colors hover:text-white"
            :disabled="modalSaving"
            @click="closeModal"
          >
            Cancel
          </button>
          <button
            type="button"
            class="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
            :disabled="modalSaving || !form.name.trim()"
            @click="submitModal"
          >
            {{ modalSaving ? 'Saving...' : (editingTeamspaceId ? 'Save' : 'Create') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import UserAvatar from '@/components/UserAvatar.vue'
import { userCustomStatusFromDto } from '@/types/userStatus'
import { useDocumentsStore } from '@/stores/documents'
import type { TeamspaceMemberPreview } from '@/services/http/documentsApi'

const props = defineProps<{
  selectedTeamspaceId: string | null
}>()

const emit = defineEmits<{
  openTeamspace: [id: string]
  openTeamspaces: []
}>()

const documentsStore = useDocumentsStore()
const membersPopup = ref<{ teamspaceId: string; top: number; left: number } | null>(null)
const modalOpen = ref(false)
const modalSaving = ref(false)
const modalError = ref('')
const joinError = ref('')
const editingTeamspaceId = ref<string | null>(null)
const selectedMemberIds = ref<string[]>([])
const deleteConfirmOpen = ref(false)
const deleteSaving = ref(false)
const deleteError = ref('')
const deleteTeamspaceId = ref<string | null>(null)
const deleteTeamspaceName = ref('')
const form = reactive({
  name: '',
  is_private: false,
})

const popupMembers = computed<TeamspaceMemberPreview[]>(() => {
  if (!membersPopup.value) return []
  return documentsStore.teamspaces.find(item => item.id === membersPopup.value?.teamspaceId)?.members ?? []
})

onMounted(() => {
  void documentsStore.loadTeamspaces()
  void documentsStore.loadUsers()
})

function openCreateModal() {
  editingTeamspaceId.value = null
  form.name = ''
  form.is_private = false
  selectedMemberIds.value = []
  modalError.value = ''
  joinError.value = ''
  modalOpen.value = true
}

function openEditModal(teamspaceId: string) {
  const teamspace = documentsStore.teamspaces.find(item => item.id === teamspaceId)
  if (!teamspace) return
  editingTeamspaceId.value = teamspaceId
  form.name = teamspace.name
  form.is_private = teamspace.is_private
  selectedMemberIds.value = teamspace.members.map(member => member.id)
  modalError.value = ''
  joinError.value = ''
  modalOpen.value = true
}

function closeModal() {
  modalOpen.value = false
  modalSaving.value = false
  modalError.value = ''
}

function toggleMember(userId: string) {
  if (selectedMemberIds.value.includes(userId)) {
    selectedMemberIds.value = selectedMemberIds.value.filter(id => id !== userId)
    return
  }
  selectedMemberIds.value = [...selectedMemberIds.value, userId]
}

async function submitModal() {
  modalSaving.value = true
  modalError.value = ''
  try {
    const payload = {
      name: form.name.trim(),
      is_private: form.is_private,
      member_ids: selectedMemberIds.value,
    }
    const row = editingTeamspaceId.value
      ? await documentsStore.updateTeamspace(editingTeamspaceId.value, payload)
      : await documentsStore.createTeamspace(payload)
    closeModal()
    emit('openTeamspace', row.id)
  } catch (e) {
    modalError.value = e instanceof Error ? e.message : 'Failed to save teamspace'
  } finally {
    modalSaving.value = false
  }
}

async function joinTeamspace(teamspaceId: string) {
  try {
    joinError.value = ''
    const row = await documentsStore.joinTeamspace(teamspaceId)
    emit('openTeamspace', row.id)
  } catch (e) {
    joinError.value = e instanceof Error ? e.message : 'Failed to join teamspace'
  }
}

function openMembersPopup(teamspaceId: string, event: MouseEvent) {
  const target = event.currentTarget
  if (!(target instanceof HTMLElement)) return
  const rect = target.getBoundingClientRect()
  membersPopup.value = {
    teamspaceId,
    top: rect.bottom + 8,
    left: rect.left,
  }
}

function closeMembersPopup(teamspaceId: string) {
  if (membersPopup.value?.teamspaceId !== teamspaceId) return
  membersPopup.value = null
}

function openDeleteConfirm(teamspaceId: string) {
  const teamspace = documentsStore.teamspaces.find(item => item.id === teamspaceId)
  if (!teamspace) return
  deleteTeamspaceId.value = teamspaceId
  deleteTeamspaceName.value = teamspace.name
  deleteError.value = ''
  deleteConfirmOpen.value = true
}

function closeDeleteConfirm() {
  if (deleteSaving.value) return
  deleteConfirmOpen.value = false
  deleteError.value = ''
  deleteTeamspaceId.value = null
  deleteTeamspaceName.value = ''
}

async function confirmDeleteTeamspace() {
  if (!deleteTeamspaceId.value) return
  deleteSaving.value = true
  deleteError.value = ''
  const targetId = deleteTeamspaceId.value
  try {
    await documentsStore.deleteTeamspace(targetId)
  } catch (e) {
    deleteError.value = e instanceof Error ? e.message : 'Failed to delete teamspace'
  } finally {
    deleteSaving.value = false
  }

  if (deleteError.value) return

  closeDeleteConfirm()
  if (props.selectedTeamspaceId === targetId) {
    emit('openTeamspaces')
  }
}
</script>
