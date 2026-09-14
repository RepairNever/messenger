<template>
  <div class="flex h-screen overflow-hidden">
    <!-- Sidebar -->
    <ResizableSidebar
      storage-key="msgnr:sidebar-width:chat:v1"
      :default-width="240"
      :min-width="220"
      :max-width="420"
    >
      <AppSidebar />
    </ResizableSidebar>

    <!-- Admin panel -->
    <div class="flex-1 min-w-0 flex flex-col bg-chat-bg">

      <!-- Header -->
      <header class="flex items-center gap-3 px-6 py-4 border-b border-chat-border shrink-0">
        <svg class="w-5 h-5 text-accent" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18"/>
        </svg>
        <h1 class="text-lg font-bold text-white">Admin Panel</h1>
      </header>

      <!-- Tab nav -->
      <div class="flex gap-0 border-b border-chat-border px-6 shrink-0">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          class="px-4 py-3 text-sm font-medium transition-colors border-b-2 -mb-px"
          :class="activeTab === tab.id
            ? 'text-white border-accent'
            : 'text-gray-400 border-transparent hover:text-gray-200'"
          @click="activeTab = tab.id"
        >
          {{ tab.label }}
        </button>
      </div>

      <!-- Content -->
      <div class="flex-1 overflow-y-auto p-6">

        <!-- Users tab -->
        <div v-if="activeTab === 'users'">
          <div class="flex items-center justify-between mb-4">
            <h2 class="text-base font-semibold text-white">Users</h2>
            <button
              class="flex items-center gap-1.5 px-3 py-1.5 bg-accent hover:bg-accent-hover text-white text-sm rounded transition-colors"
              @click="createUserOpen = true"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path d="M12 5v14M5 12h14"/>
              </svg>
              Create User
            </button>
          </div>

          <div v-if="usersError" class="text-red-400 text-sm mb-3">{{ usersError }}</div>

          <div class="bg-chat-input border border-chat-border rounded-lg overflow-hidden">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-chat-border text-gray-400 text-xs uppercase tracking-wide">
                  <th class="text-left px-4 py-3">Name</th>
                  <th class="text-left px-4 py-3">Email</th>
                  <th class="text-left px-4 py-3">Role</th>
                  <th class="text-left px-4 py-3">Status</th>
                  <th class="text-left px-4 py-3">Must change pwd</th>
                  <th class="px-4 py-3"/>
                </tr>
              </thead>
              <tbody>
                <tr v-if="usersLoading">
                  <td colspan="6" class="px-4 py-6 text-center text-gray-500">Loading...</td>
                </tr>
                <tr v-else-if="users.length === 0">
                  <td colspan="6" class="px-4 py-6 text-center text-gray-500">No users found</td>
                </tr>
                <tr
                  v-for="u in users"
                  :key="u.id"
                  class="border-t border-chat-border hover:bg-white/5 transition-colors cursor-pointer"
                  @click="openEditUser(u)"
                >
                  <td class="px-4 py-3 text-white font-medium">
                    <div class="flex items-center gap-2 min-w-0">
                      <UserAvatar
                        :user-id="u.id"
                        :display-name="u.display_name || u.email"
                        :avatar-url="u.avatar_url"
                        size="sm"
                      />
                      <span class="truncate">{{ u.display_name || '—' }}</span>
                    </div>
                  </td>
                  <td class="px-4 py-3 text-gray-300">{{ u.email }}</td>
                  <td class="px-4 py-3">
                    <span
                      class="px-2 py-0.5 rounded text-xs font-medium"
                      :class="{
                        'bg-yellow-500/20 text-yellow-300': u.role === 'owner',
                        'bg-blue-500/20 text-blue-300':    u.role === 'admin',
                        'bg-gray-500/20 text-gray-300':    u.role === 'member',
                        'bg-emerald-500/20 text-emerald-300': u.role === 'bot',
                      }"
                    >{{ u.role }}</span>
                  </td>
                  <td class="px-4 py-3">
                    <span
                      class="flex items-center gap-1.5 text-xs"
                      :class="u.status === 'active' ? 'text-green-400' : 'text-red-400'"
                    >
                      <span class="w-1.5 h-1.5 rounded-full inline-block" :class="u.status === 'active' ? 'bg-green-400' : 'bg-red-400'"/>
                      {{ u.status }}
                    </span>
                  </td>
                  <td class="px-4 py-3" @click.stop>
                    <button
                      class="relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none"
                      :class="u.need_change_password ? 'bg-amber-500' : 'bg-white/20'"
                      :disabled="actionLoading === u.id"
                      :title="u.need_change_password ? 'Password change required — click to clear' : 'Click to require password change'"
                      @click="toggleNeedChangePassword(u)"
                    >
                      <span
                        class="pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition duration-200"
                        :class="u.need_change_password ? 'translate-x-4' : 'translate-x-0'"
                      />
                    </button>
                  </td>
                  <td class="px-4 py-3 text-right" @click.stop>
                    <button
                      v-if="u.status === 'active'"
                      class="text-xs text-red-400 hover:text-red-300 transition-colors px-2 py-1 rounded hover:bg-red-400/10"
                      :disabled="actionLoading === u.id"
                      @click="blockUser(u.id)"
                    >Block</button>
                    <button
                      v-else
                      class="text-xs text-green-400 hover:text-green-300 transition-colors px-2 py-1 rounded hover:bg-green-400/10"
                      :disabled="actionLoading === u.id"
                      @click="unblockUser(u.id)"
                    >Unblock</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- Channels tab -->
        <div v-if="activeTab === 'channels'">
          <div class="flex items-center justify-between mb-4">
            <h2 class="text-base font-semibold text-white">Channels</h2>
            <button
              class="flex items-center gap-1.5 px-3 py-1.5 bg-accent hover:bg-accent-hover text-white text-sm rounded transition-colors"
              @click="createChannelOpen = true"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path d="M12 5v14M5 12h14"/>
              </svg>
              Create Channel
            </button>
          </div>

          <div v-if="channelsError" class="text-red-400 text-sm mb-3">{{ channelsError }}</div>

          <div class="bg-chat-input border border-chat-border rounded-lg overflow-hidden">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-chat-border text-gray-400 text-xs uppercase tracking-wide">
                  <th class="text-left px-4 py-3">Name</th>
                  <th class="text-left px-4 py-3">Kind</th>
                  <th class="text-left px-4 py-3">Visibility</th>
                  <th class="text-left px-4 py-3">Archived</th>
                  <th class="px-4 py-3"/>
                </tr>
              </thead>
              <tbody>
                <tr v-if="channelsLoading">
                  <td colspan="5" class="px-4 py-6 text-center text-gray-500">Loading...</td>
                </tr>
                <tr v-else-if="channels.length === 0">
                  <td colspan="5" class="px-4 py-6 text-center text-gray-500">No channels found</td>
                </tr>
                <tr
                  v-for="ch in channels"
                  :key="ch.id"
                  class="border-t border-chat-border hover:bg-white/5 transition-colors cursor-pointer"
                  :data-testid="`channel-row-${ch.id}`"
                  @click="openRenameChannel(ch)"
                >
                  <td class="px-4 py-3 text-white font-medium">
                    <span class="text-gray-400">#</span> {{ ch.name ?? '—' }}
                  </td>
                  <td class="px-4 py-3 text-gray-300">{{ ch.kind }}</td>
                  <td class="px-4 py-3 text-gray-300">{{ ch.visibility }}</td>
                  <td class="px-4 py-3">
                    <span :class="ch.is_archived ? 'text-yellow-400' : 'text-gray-500'">
                      {{ ch.is_archived ? 'Yes' : 'No' }}
                    </span>
                  </td>
                  <td class="px-4 py-3 text-right">
                    <button
                      class="text-xs text-red-400 hover:text-red-300 transition-colors px-2 py-1 rounded hover:bg-red-400/10"
                      :disabled="actionLoading === ch.id"
                      @click.stop="deleteChannel(ch.id)"
                    >Delete</button>
                    <button
                      class="ml-2 text-xs text-yellow-300 hover:text-yellow-200 transition-colors px-2 py-1 rounded hover:bg-yellow-400/10"
                      :disabled="actionLoading === ch.id"
                      @click.stop="openRenameChannel(ch)"
                    >Rename</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- Templates tab -->
        <TemplatesTab v-if="activeTab === 'templates'" />

        <!-- Statuses tab -->
        <StatusesTab v-if="activeTab === 'statuses'" />

        <!-- Dictionaries tab -->
        <DictionariesTab v-if="activeTab === 'dictionaries'" />

        <!-- Logs tab -->
        <div v-if="activeTab === 'logs'">
          <div class="flex items-center justify-between mb-4">
            <h2 class="text-base font-semibold text-white">Server Logs</h2>
            <button
              class="flex items-center gap-1.5 px-3 py-1.5 bg-white/10 hover:bg-white/20 text-gray-200 text-sm rounded transition-colors"
              @click="loadLogs"
            >
              <svg class="w-4 h-4" :class="logsLoading ? 'animate-spin' : ''" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
              </svg>
              Refresh
            </button>
          </div>

          <div v-if="logsError" class="text-red-400 text-sm mb-3">{{ logsError }}</div>

          <div class="bg-black/40 border border-chat-border rounded-lg overflow-hidden font-mono text-xs">
            <div v-if="logsLoading" class="px-4 py-6 text-center text-gray-500">Loading...</div>
            <div v-else-if="logs.length === 0" class="px-4 py-6 text-center text-gray-500">No logs available</div>
            <div v-else class="overflow-x-auto">
              <div
                v-for="(log, idx) in logs"
                :key="idx"
                class="flex items-start gap-3 px-4 py-1.5 border-b border-white/5 hover:bg-white/5"
              >
                <span class="text-gray-500 shrink-0 w-32">{{ log.time ? formatLogTime(log.time) : '' }}</span>
                <span
                  class="shrink-0 w-12 font-semibold"
                  :class="{
                    'text-red-400':    log.level === 'error' || log.level === 'ERROR',
                    'text-yellow-400': log.level === 'warn'  || log.level === 'WARN',
                    'text-blue-400':   log.level === 'info'  || log.level === 'INFO',
                    'text-gray-400':   log.level === 'debug' || log.level === 'DEBUG',
                  }"
                >{{ (log.level ?? '').toUpperCase().slice(0,4) }}</span>
                <span class="text-gray-300 break-all">{{ log.msg ?? JSON.stringify(log) }}</span>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>

    <!-- Create User dialog -->
    <Teleport to="body">
      <div v-if="createUserOpen" class="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" @click.self="createUserOpen = false">
        <div class="bg-[#222529] border border-chat-border rounded-xl shadow-2xl w-full max-w-sm p-6">
          <h3 class="text-lg font-bold text-white mb-4">Create User</h3>
          <div class="space-y-3">
            <div>
              <label class="block text-sm text-gray-400 mb-1">Email</label>
              <input
                v-model="newUser.email"
                type="email"
                class="w-full bg-chat-input border border-chat-border rounded px-3 py-2 text-white text-sm outline-none focus:border-accent"
                placeholder="user@example.com"
              />
            </div>
            <div>
              <label class="block text-sm text-gray-400 mb-1">Password</label>
              <input
                v-model="newUser.password"
                type="password"
                class="w-full bg-chat-input border border-chat-border rounded px-3 py-2 text-white text-sm outline-none focus:border-accent"
                placeholder="••••••••"
              />
            </div>
            <div>
              <label class="block text-sm text-gray-400 mb-1">Display Name</label>
              <input
                v-model="newUser.display_name"
                type="text"
                class="w-full bg-chat-input border border-chat-border rounded px-3 py-2 text-white text-sm outline-none focus:border-accent"
                placeholder="John Doe"
              />
            </div>
            <div>
              <label class="block text-sm text-gray-400 mb-1">Role</label>
              <select
                v-model="newUser.role"
                class="w-full bg-chat-input border border-chat-border rounded px-3 py-2 text-white text-sm outline-none focus:border-accent"
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
                <option value="bot">Bot</option>
              </select>
            </div>
            <label class="flex items-start gap-3 rounded border border-chat-border bg-chat-input px-3 py-2 text-sm text-gray-200 cursor-pointer">
              <input
                v-model="newUser.need_change_password"
                type="checkbox"
                class="mt-0.5 h-4 w-4 rounded border-chat-border bg-transparent text-accent focus:ring-accent"
              />
              <span>Require password change upon login</span>
            </label>
          </div>
          <div v-if="createUserError" class="text-red-400 text-sm mt-3">{{ createUserError }}</div>
          <div class="flex gap-3 mt-5">
            <button
              class="flex-1 py-2 rounded bg-white/10 hover:bg-white/20 text-gray-200 text-sm transition-colors"
              @click="createUserOpen = false"
            >Cancel</button>
            <button
              class="flex-1 py-2 rounded bg-accent hover:bg-accent-hover text-white text-sm font-medium transition-colors"
              :disabled="createUserLoading"
              @click="submitCreateUser"
            >{{ createUserLoading ? 'Creating...' : 'Create' }}</button>
          </div>
        </div>
      </div>

      <!-- Edit User dialog -->
      <div v-if="editUserOpen" class="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" @click.self="editUserOpen = false">
        <div class="bg-[#222529] border border-chat-border rounded-xl shadow-2xl w-full max-w-sm p-6">
          <h3 class="text-lg font-bold text-white mb-4">Edit User</h3>
          <div class="space-y-3">
            <div>
              <label class="block text-sm text-gray-400 mb-1">Display Name</label>
              <input
                v-model="editUserForm.display_name"
                type="text"
                class="w-full bg-chat-input border border-chat-border rounded px-3 py-2 text-white text-sm outline-none focus:border-accent"
                placeholder="John Doe"
              />
            </div>
            <div>
              <label class="block text-sm text-gray-400 mb-1">Email</label>
              <input
                v-model="editUserForm.email"
                type="email"
                class="w-full bg-chat-input border border-chat-border rounded px-3 py-2 text-white text-sm outline-none focus:border-accent"
                placeholder="user@example.com"
              />
            </div>
            <div>
              <label class="block text-sm text-gray-400 mb-1">Role</label>
              <select
                v-model="editUserForm.role"
                class="w-full bg-chat-input border border-chat-border rounded px-3 py-2 text-white text-sm outline-none focus:border-accent"
                :disabled="editingUser?.role === 'owner'"
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
                <option value="bot">Bot</option>
              </select>
              <p v-if="editingUser?.role === 'owner'" class="text-xs text-gray-500 mt-1">Owner role cannot be changed.</p>
            </div>
            <div v-if="editUserForm.role === 'bot'">
              <label class="block text-sm text-gray-400 mb-1">Integration Token</label>
              <input
                v-model="editUserForm.integration_token"
                type="text"
                class="w-full bg-chat-input border border-chat-border rounded px-3 py-2 text-white text-sm outline-none focus:border-accent"
                placeholder="Set new static bearer token"
                autocomplete="off"
              />
              <p class="text-xs text-gray-500 mt-1">Leave blank to keep the current token. Saving a new token replaces the active one.</p>
            </div>
            <div v-else>
              <label class="block text-sm text-gray-400 mb-1">New Password</label>
              <input
                v-model="editUserForm.password"
                type="password"
                class="w-full bg-chat-input border border-chat-border rounded px-3 py-2 text-white text-sm outline-none focus:border-accent"
                placeholder="Leave blank to keep current"
              />
            </div>
          </div>
          <div v-if="editUserError" class="text-red-400 text-sm mt-3">{{ editUserError }}</div>
          <div class="flex gap-3 mt-5">
            <button
              class="flex-1 py-2 rounded bg-white/10 hover:bg-white/20 text-gray-200 text-sm transition-colors"
              :disabled="editUserLoading"
              @click="editUserOpen = false"
            >Cancel</button>
            <button
              class="flex-1 py-2 rounded bg-accent hover:bg-accent-hover text-white text-sm font-medium transition-colors disabled:opacity-50"
              :disabled="editUserLoading"
              @click="submitEditUser"
            >{{ editUserLoading ? 'Saving...' : 'Save' }}</button>
          </div>
        </div>
      </div>

      <!-- Create Channel dialog -->
      <div v-if="createChannelOpen" class="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" @click.self="createChannelOpen = false">
        <div class="bg-[#222529] border border-chat-border rounded-xl shadow-2xl w-full max-w-md p-6">
          <h3 class="text-lg font-bold text-white mb-4">Create Channel</h3>
          <div class="space-y-3">
            <div>
              <label class="block text-sm text-gray-400 mb-1">Name</label>
              <input
                v-model="newChannel.name"
                type="text"
                class="w-full bg-chat-input border border-chat-border rounded px-3 py-2 text-white text-sm outline-none focus:border-accent"
                placeholder="channel-name"
              />
            </div>
            <div>
              <label class="block text-sm text-gray-400 mb-1">Visibility</label>
              <select
                v-model="newChannel.visibility"
                class="w-full bg-chat-input border border-chat-border rounded px-3 py-2 text-white text-sm outline-none focus:border-accent"
              >
                <option value="public">Public</option>
                <option value="private">Private</option>
              </select>
            </div>
            <label v-if="newChannel.visibility === 'public'" class="flex items-start gap-3 rounded border border-chat-border bg-chat-input px-3 py-2 text-sm text-gray-200">
              <input
                v-model="newChannel.add_all_users"
                type="checkbox"
                class="mt-0.5 h-4 w-4 rounded border-chat-border bg-transparent text-accent focus:ring-accent"
              />
              <span>
                Add all users to this channel
              </span>
            </label>
            <div v-if="newChannel.visibility === 'private'" class="rounded border border-chat-border bg-chat-input p-3">
              <div class="text-sm text-gray-300 mb-2">Select members</div>
              <div class="max-h-44 overflow-y-auto space-y-1">
                <label
                  v-for="candidate in privateMemberCandidates"
                  :key="candidate.id"
                  class="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-gray-200 hover:bg-white/5"
                >
                  <input
                    :checked="selectedPrivateMemberIds.includes(candidate.id)"
                    type="checkbox"
                    class="h-4 w-4 rounded border-chat-border bg-transparent text-accent focus:ring-accent"
                    :data-testid="`private-member-checkbox-${candidate.id}`"
                    @change="togglePrivateMemberSelection(candidate.id)"
                  />
                  <UserAvatar
                    :user-id="candidate.id"
                    :display-name="candidate.display_name || candidate.email"
                    :avatar-url="candidate.avatar_url"
                    size="xs"
                  />
                  <span class="truncate">{{ candidate.display_name || candidate.email }}</span>
                </label>
                <div v-if="privateMemberCandidates.length === 0" class="px-2 py-1 text-xs text-gray-500">
                  No active users available
                </div>
              </div>
              <div class="mt-2 text-xs text-gray-500">
                Private channel requires at least one selected member.
              </div>
            </div>
          </div>
          <div v-if="createChannelError" class="text-red-400 text-sm mt-3">{{ createChannelError }}</div>
          <div class="flex gap-3 mt-5">
            <button
              class="flex-1 py-2 rounded bg-white/10 hover:bg-white/20 text-gray-200 text-sm transition-colors"
              @click="createChannelOpen = false"
            >Cancel</button>
            <button
              class="flex-1 py-2 rounded bg-accent hover:bg-accent-hover text-white text-sm font-medium transition-colors"
              :disabled="createChannelLoading || !canSubmitCreateChannel"
              @click="submitCreateChannel"
            >{{ createChannelLoading ? 'Creating...' : 'Create' }}</button>
          </div>
        </div>
      </div>

      <!-- Rename Channel dialog -->
      <div v-if="renameChannelOpen" class="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" @click.self="renameChannelOpen = false">
        <div class="bg-[#222529] border border-chat-border rounded-xl shadow-2xl w-full max-w-sm p-6">
          <h3 class="text-lg font-bold text-white mb-4">Rename Channel</h3>
          <div class="space-y-3">
            <label class="block text-sm text-gray-400 mb-1">Name</label>
            <input
              v-model="renameChannelName"
              type="text"
              class="w-full bg-chat-input border border-chat-border rounded px-3 py-2 text-white text-sm outline-none focus:border-accent"
              placeholder="#channel-name"
            />
          </div>
          <div v-if="renameChannelError" class="text-red-400 text-sm mt-3">{{ renameChannelError }}</div>
          <div class="flex gap-3 mt-5">
            <button
              class="flex-1 py-2 rounded bg-white/10 hover:bg-white/20 text-gray-200 text-sm transition-colors"
              @click="renameChannelOpen = false"
            >Cancel</button>
            <button
              class="flex-1 py-2 rounded bg-accent hover:bg-accent-hover text-white text-sm font-medium transition-colors"
              :disabled="renameChannelLoading || !canSubmitRenameChannel"
              @click="submitRenameChannel"
            >{{ renameChannelLoading ? 'Saving...' : 'Save' }}</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import ResizableSidebar from '@/components/ResizableSidebar.vue'
import AppSidebar from '@/components/AppSidebar.vue'
import TemplatesTab from '@/components/admin/TemplatesTab.vue'
import StatusesTab from '@/components/admin/StatusesTab.vue'
import DictionariesTab from '@/components/admin/DictionariesTab.vue'
import UserAvatar from '@/components/UserAvatar.vue'
import { useWsStore } from '@/stores/ws'
import { useChatStore } from '@/stores/chat'
import { useAuthStore } from '@/stores/auth'
import {
  adminListUsers, adminCreateUser, adminUpdateUser, adminBlockUser, adminUnblockUser,
  adminSetNeedChangePassword,
  adminListChannels, adminCreateChannel, adminDeleteChannel,
  adminRenameChannel,
  adminGetLogs,
  type AdminUser, type AdminChannel, type AdminLog,
} from '@/services/http/adminApi'

type AdminTab = 'users' | 'channels' | 'templates' | 'statuses' | 'dictionaries' | 'logs'
const tabs: { id: AdminTab; label: string }[] = [
  { id: 'users',        label: 'Users' },
  { id: 'channels',     label: 'Channels' },
  { id: 'templates',    label: 'Templates' },
  { id: 'statuses',     label: 'Statuses' },
  { id: 'dictionaries', label: 'Dictionaries' },
  { id: 'logs',         label: 'Logs' },
]
const activeTab = ref<AdminTab>('users')
const wsStore = useWsStore()
const chatStore = useChatStore()
const authStore = useAuthStore()

chatStore.registerWsHandlers()

watch(() => authStore.user, (u) => {
  if (u) chatStore.registerUserIdentity(u.id, u.displayName ?? u.email, u.email, u.avatarUrl)
}, { immediate: true })

watch(() => wsStore.state, (state) => {
  if (state === 'AUTH_COMPLETE') {
    chatStore.startRealtimeFlow()
  }
})

// ---- Users ----
const users       = ref<AdminUser[]>([])
const usersLoading = ref(false)
const usersError  = ref<string | null>(null)
const actionLoading = ref<string | null>(null)

const createUserOpen    = ref(false)
const createUserLoading = ref(false)
const createUserError   = ref<string | null>(null)
const newUser = ref({ email: '', password: '', display_name: '', role: 'member' as 'member' | 'admin' | 'bot', need_change_password: true })

async function loadUsers() {
  usersLoading.value = true
  usersError.value = null
  try {
    users.value = await adminListUsers()
  } catch (e: unknown) {
    usersError.value = e instanceof Error ? e.message : 'Failed to load users'
  } finally {
    usersLoading.value = false
  }
}

async function blockUser(id: string) {
  actionLoading.value = id
  try {
    await adminBlockUser(id)
    await loadUsers()
  } catch { /* ignore */ } finally {
    actionLoading.value = null
  }
}

async function unblockUser(id: string) {
  actionLoading.value = id
  try {
    await adminUnblockUser(id)
    await loadUsers()
  } catch { /* ignore */ } finally {
    actionLoading.value = null
  }
}

async function toggleNeedChangePassword(u: AdminUser) {
  actionLoading.value = u.id
  try {
    const updated = await adminSetNeedChangePassword(u.id, !u.need_change_password)
    const idx = users.value.findIndex(x => x.id === u.id)
    if (idx !== -1) users.value[idx] = updated
  } catch { /* ignore */ } finally {
    actionLoading.value = null
  }
}

// ---- Edit User dialog ----
const editUserOpen    = ref(false)
const editUserLoading = ref(false)
const editUserError   = ref<string | null>(null)
const editingUser     = ref<AdminUser | null>(null)
const editUserForm    = ref({
  display_name: '',
  email: '',
  role: 'member' as 'member' | 'admin' | 'bot',
  password: '',
  integration_token: '',
})

function openEditUser(u: AdminUser) {
  editingUser.value = u
  editUserForm.value = {
    display_name: u.display_name,
    email:        u.email,
    role:         u.role === 'owner' ? 'member' : u.role as 'member' | 'admin' | 'bot',
    password:     '',
    integration_token: '',
  }
  editUserError.value = null
  editUserOpen.value = true
}

async function submitEditUser() {
  if (!editingUser.value) return
  editUserLoading.value = true
  editUserError.value = null
  try {
    const payload = {
      display_name: editUserForm.value.display_name,
      email:        editUserForm.value.email,
      role:         editingUser.value.role === 'owner' ? editingUser.value.role as 'admin' | 'member' | 'bot' : editUserForm.value.role,
      ...(editUserForm.value.role !== 'bot' && editUserForm.value.password ? { password: editUserForm.value.password } : {}),
      ...(editUserForm.value.role === 'bot' && editUserForm.value.integration_token
        ? { integration_token: editUserForm.value.integration_token }
        : {}),
    }
    const updated = await adminUpdateUser(editingUser.value.id, payload)
    const idx = users.value.findIndex(u => u.id === updated.id)
    if (idx !== -1) users.value[idx] = updated
    editUserOpen.value = false
  } catch (e: unknown) {
    editUserError.value = e instanceof Error ? e.message : 'Failed to save'
  } finally {
    editUserLoading.value = false
  }
}

async function submitCreateUser() {
  createUserLoading.value = true
  createUserError.value = null
  try {
    await adminCreateUser(newUser.value)
    createUserOpen.value = false
    newUser.value = { email: '', password: '', display_name: '', role: 'member', need_change_password: true }
    await loadUsers()
  } catch (e: unknown) {
    createUserError.value = e instanceof Error ? e.message : 'Failed to create user'
  } finally {
    createUserLoading.value = false
  }
}

// ---- Channels ----
const channels        = ref<AdminChannel[]>([])
const channelsLoading  = ref(false)
const channelsError   = ref<string | null>(null)

const createChannelOpen    = ref(false)
const createChannelLoading = ref(false)
const createChannelError   = ref<string | null>(null)
const selectedPrivateMemberIds = ref<string[]>([])
const renameChannelOpen = ref(false)
const renameChannelLoading = ref(false)
const renameChannelError = ref<string | null>(null)
const renameChannelName = ref('')
const renameChannelId = ref('')
const newChannel = ref({
  name: '',
  visibility: 'public' as 'public' | 'private',
  add_all_users: false,
})
const privateMemberCandidates = computed(() => {
  const selfUserID = authStore.user?.id ?? chatStore.workspace?.selfUserId ?? ''
  return users.value.filter(user => user.status === 'active' && user.role !== 'bot' && user.id !== selfUserID)
})
const canSubmitCreateChannel = computed(() => {
  const hasName = newChannel.value.name.trim().length > 0
  if (!hasName) return false
  if (newChannel.value.visibility === 'private') {
    return selectedPrivateMemberIds.value.length > 0
  }
  return true
})

function togglePrivateMemberSelection(userID: string) {
  if (selectedPrivateMemberIds.value.includes(userID)) {
    selectedPrivateMemberIds.value = selectedPrivateMemberIds.value.filter(id => id !== userID)
    return
  }
  selectedPrivateMemberIds.value = [...selectedPrivateMemberIds.value, userID]
}

function resetNewChannelForm() {
  newChannel.value = { name: '', visibility: 'public', add_all_users: false }
  selectedPrivateMemberIds.value = []
}

async function loadChannels() {
  channelsLoading.value = true
  channelsError.value = null
  try {
    channels.value = await adminListChannels()
  } catch (e: unknown) {
    channelsError.value = e instanceof Error ? e.message : 'Failed to load channels'
  } finally {
    channelsLoading.value = false
  }
}

async function deleteChannel(id: string) {
  actionLoading.value = id
  try {
    await adminDeleteChannel(id)
    await loadChannels()
  } catch { /* ignore */ } finally {
    actionLoading.value = null
  }
}

async function submitCreateChannel() {
  if (!canSubmitCreateChannel.value) return
  createChannelLoading.value = true
  createChannelError.value = null
  try {
    await adminCreateChannel({
      kind: 'channel',
      name: newChannel.value.name.trim(),
      visibility: newChannel.value.visibility,
      add_all_users: newChannel.value.visibility === 'public' ? newChannel.value.add_all_users : false,
      member_ids: newChannel.value.visibility === 'private' ? selectedPrivateMemberIds.value : undefined,
    })
    createChannelOpen.value = false
    resetNewChannelForm()
    await loadChannels()
  } catch (e: unknown) {
    createChannelError.value = e instanceof Error ? e.message : 'Failed to create channel'
  } finally {
    createChannelLoading.value = false
  }
}

const canSubmitRenameChannel = computed(() => renameChannelName.value.trim().length > 0)

function openRenameChannel(ch: AdminChannel) {
  renameChannelId.value = ch.id
  renameChannelName.value = ch.name ?? ''
  renameChannelError.value = null
  renameChannelOpen.value = true
}

async function submitRenameChannel() {
  if (!renameChannelId.value || !canSubmitRenameChannel.value) return
  renameChannelLoading.value = true
  renameChannelError.value = null
  try {
    const renamed = await adminRenameChannel(renameChannelId.value, {
      name: renameChannelName.value.trim(),
    })
    const idx = channels.value.findIndex(ch => ch.id === renamed.id)
    if (idx === -1) {
      await loadChannels()
    } else {
      channels.value[idx] = renamed
      channels.value = [...channels.value]
    }
    renameChannelOpen.value = false
  } catch (e: unknown) {
    renameChannelError.value = e instanceof Error ? e.message : 'Failed to rename channel'
  } finally {
    renameChannelLoading.value = false
  }
}

// ---- Logs ----
const logs        = ref<AdminLog[]>([])
const logsLoading  = ref(false)
const logsError   = ref<string | null>(null)

async function loadLogs() {
  logsLoading.value = true
  logsError.value = null
  try {
    logs.value = await adminGetLogs(200)
  } catch (e: unknown) {
    logsError.value = e instanceof Error ? e.message : 'Failed to load logs'
  } finally {
    logsLoading.value = false
  }
}

function formatLogTime(t: string): string {
  try {
    return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return t
  }
}

onMounted(() => {
  loadUsers()
  // Only kick off realtime flow if already at AUTH_COMPLETE on mount.
  // See MainView.vue for rationale — the watch() handles post-mount transitions.
  if (wsStore.state === 'AUTH_COMPLETE') {
    chatStore.startRealtimeFlow()
  }
})

watch(activeTab, (tab) => {
  if (tab === 'channels') { loadChannels(); return }
  if (tab === 'logs')     { loadLogs() }
})

watch(() => newChannel.value.visibility, (visibility) => {
  if (visibility === 'private') {
    newChannel.value.add_all_users = false
    return
  }
  selectedPrivateMemberIds.value = []
})
</script>
