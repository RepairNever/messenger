<template>
  <aside class="flex h-full w-full min-w-0 flex-col bg-sidebar-bg select-none">

    <!-- Workspace header -->
    <div class="flex h-14 shrink-0 items-center justify-between border-b border-chat-border px-4 transition-colors">
      <span class="font-bold text-white text-[15px] truncate">Msgnr</span>
    </div>

    <!-- Scrollable nav -->
    <nav class="flex-1 overflow-y-auto py-2">

      <!-- Search -->
      <button
        data-testid="sidebar-search-button"
        class="mx-2 flex w-[calc(100%-16px)] items-center gap-2 rounded-full border border-chat-border bg-app-tertiary px-3 py-1.5 text-sm text-sidebar-text transition-colors hover:bg-sidebar-hover"
        @click="$emit('search')"
      >
        <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
        </svg>
        <span class="text-sidebar-textMuted">Search</span>
        <span class="ml-auto rounded border border-chat-border bg-chat-bg px-1.5 py-0.5 text-[10.5px] text-sidebar-textMuted">⌘K</span>
      </button>

      <div class="mt-3">
        <div class="relative mx-1">
          <button
            data-testid="sidebar-unread-button"
            class="flex min-h-8 w-full items-center gap-2 rounded-full px-3 py-1 text-left text-[15px] transition-colors"
            :class="chatStore.chatViewMode === 'unread'
              ? 'bg-sidebar-active text-app-selectionText'
              : (chatStore.totalUnreadCount > 0 ? 'text-sidebar-text hover:bg-sidebar-hover' : 'text-sidebar-textMuted hover:bg-sidebar-hover')"
            @click="openUnreadView"
          >
            <span class="flex w-8 shrink-0 items-center justify-center" :class="chatStore.chatViewMode === 'unread' ? 'text-app-selectionText' : 'text-sidebar-textMuted'">
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />
              </svg>
            </span>
            <span
              class="flex-1 truncate"
              :class="chatStore.chatViewMode === 'unread'
                ? 'font-semibold text-app-selectionText'
                : (chatStore.totalUnreadCount > 0 ? 'font-semibold text-white' : 'font-normal text-sidebar-text')"
            >
              Unread
            </span>
            <span
              v-if="chatStore.totalUnreadCount > 0"
              data-testid="sidebar-unread-badge"
              class="inline-flex min-w-[18px] shrink-0 items-center justify-center rounded-full bg-red-500 px-1 text-[11px] font-bold text-sidebar-unreadBadge"
            >
              {{ unreadBadgeLabel }}
            </span>
          </button>
        </div>
        <div class="relative mx-1 mt-0.5">
          <button
            data-testid="sidebar-saved-button"
            class="flex min-h-8 w-full items-center gap-2 rounded-full px-3 py-1 text-left text-[15px] transition-colors"
            :class="chatStore.chatViewMode === 'saved'
              ? 'bg-sidebar-active text-app-selectionText'
              : 'text-sidebar-text hover:bg-sidebar-hover'"
            @click="openSavedView"
          >
            <span class="flex w-8 shrink-0 items-center justify-center" :class="chatStore.chatViewMode === 'saved' ? 'text-app-selectionText' : 'text-sidebar-textMuted'">
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M19 21 12 17 5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
              </svg>
            </span>
            <span class="flex-1 truncate" :class="chatStore.chatViewMode === 'saved' ? 'font-semibold text-app-selectionText' : 'font-normal text-sidebar-text'">Saved Message</span>
          </button>
        </div>
      </div>

      <!-- Channels section -->
      <div class="mt-3">
        <div class="flex items-center pr-1">
          <button
            class="flex items-center gap-1 px-3 py-0.5 flex-1 text-left min-w-0"
            @click="channelsOpen = !channelsOpen"
          >
            <svg
              class="h-3.5 w-3.5 text-sidebar-heading transition-transform shrink-0"
              :class="channelsOpen ? 'rotate-90' : ''"
              fill="currentColor" viewBox="0 0 20 20"
            >
              <path fill-rule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clip-rule="evenodd"/>
            </svg>
            <span class="text-xs font-semibold text-sidebar-heading uppercase tracking-wide">Channels</span>
          </button>
          <button
            class="h-5 w-5 flex items-center justify-center rounded text-sidebar-heading hover:text-sidebar-text hover:bg-sidebar-hover shrink-0 transition-colors"
            title="Join channel"
            data-testid="add-channel-button"
            @click.stop="openChannelPicker"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
              <path d="M12 5v14M5 12h14"/>
            </svg>
          </button>
        </div>

        <div v-if="channelsOpen" class="mt-0.5">
          <SidebarItem
            v-for="ch in sortedChannels"
            :key="ch.id"
            :active="isConversationActive(ch.id)"
            :unread="ch.unread"
            :muted="ch.notificationLevel === NotificationLevel.NOTHING"
            :actions-pinned="isConversationMenuOpen('channel', ch.id)"
            @click="openConversation(ch.id)"
            @contextmenu.prevent="toggleConversationMenu('channel', ch.id)"
          >
            <template #icon>
              <span v-if="ch.visibility === 'private'" class="flex" :class="isConversationActive(ch.id) ? 'text-app-selectionText' : 'text-sidebar-textMuted'" :data-testid="`channel-private-icon-${ch.id}`">
                <svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                  <rect x="5" y="11" width="14" height="10" rx="2" ry="2" />
                  <path d="M8 11V8a4 4 0 1 1 8 0v3" />
                </svg>
              </span>
              <span v-else class="flex" :class="isConversationActive(ch.id) ? 'text-app-selectionText' : 'text-sidebar-textMuted'" :data-testid="`channel-hash-icon-${ch.id}`">
                <svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" viewBox="0 0 24 24">
                  <path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" />
                </svg>
              </span>
            </template>
            <span class="inline-flex items-center gap-1">
              <span class="min-w-0 truncate" :title="ch.name">{{ ch.name }}</span>
              <CallPresenceIcon
                v-if="hasActiveCall(ch.id)"
                :testid="`active-call-icon-channel-${ch.id}`"
                title="Active call"
              />
            </span>
            <template #actions>
              <div class="relative z-40" data-conversation-menu-root @click.stop>
                <button
                  :data-testid="`conversation-menu-button-channel-${ch.id}`"
                  class="flex h-6 w-6 items-center justify-center rounded text-sidebar-textMuted transition-colors hover:bg-sidebar-hover hover:text-sidebar-text"
                  @click.stop="toggleConversationMenu('channel', ch.id)"
                >
                  <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M10 6a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm0 5.5A1.5 1.5 0 1010 8a1.5 1.5 0 000 3.5zm0 5.5a1.5 1.5 0 110-3 1.5 1.5 0 010 3z"/>
                  </svg>
                </button>
                <div
                  v-if="isConversationMenuOpen('channel', ch.id)"
                  class="absolute right-0 top-8 z-50 min-w-44 rounded-lg border border-chat-border bg-chat-header p-1 shadow-2xl"
                >
                  <NotificationLevelSelector
                    :model-value="ch.notificationLevel"
                    @update:model-value="(level) => { chatStore.setNotificationLevel(ch.id, level); closeConversationMenus() }"
                  />
                  <div class="mt-1 border-t border-white/10 pt-1">
                    <button
                      :data-testid="`conversation-leave-channel-${ch.id}`"
                      class="w-full rounded px-3 py-2 text-left text-sm text-red-300 transition-colors hover:bg-red-500/10 hover:text-red-200 disabled:opacity-50"
                      :disabled="isLeavingConversation('channel', ch.id)"
                      @click.stop="leaveConversationFromSidebar('channel', ch.id)"
                    >
                      Leave
                    </button>
                  </div>
                </div>
              </div>
            </template>
          </SidebarItem>

          <div v-if="!chatStore.bootstrapped && sortedChannels.length === 0" class="mx-1 mt-0.5 space-y-1" aria-hidden="true">
            <div v-for="i in 3" :key="i" class="h-8 animate-pulse rounded-md bg-sidebar-hover" :style="{ width: `${94 - i * 12}%` }" />
          </div>
          <p v-else-if="sortedChannels.length === 0" class="mx-1 px-3 py-1.5 text-xs text-sidebar-textMuted">
            No channels yet
          </p>
        </div>
      </div>

      <!-- Direct Messages section -->
      <div class="mt-3">
        <div class="flex items-center pr-1">
          <button
            class="flex items-center gap-1 px-3 py-0.5 flex-1 text-left min-w-0"
            @click="dmsOpen = !dmsOpen"
          >
            <svg
              class="h-3.5 w-3.5 text-sidebar-heading transition-transform shrink-0"
              :class="dmsOpen ? 'rotate-90' : ''"
              fill="currentColor" viewBox="0 0 20 20"
            >
              <path fill-rule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clip-rule="evenodd"/>
            </svg>
            <span class="text-xs font-semibold text-sidebar-heading uppercase tracking-wide">Direct Messages</span>
          </button>
          <button
            class="h-5 w-5 flex items-center justify-center rounded text-sidebar-heading hover:text-sidebar-text hover:bg-sidebar-hover shrink-0 transition-colors"
            title="New message"
            data-testid="new-message-button"
            @click.stop="openDmPicker"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
              <path d="M12 5v14M5 12h14"/>
            </svg>
          </button>
        </div>

      <div v-if="dmsOpen" class="mt-0.5">
        <SidebarItem
          v-for="dm in sortedDirectMessages"
          :key="dm.id"
            :active="isConversationActive(dm.id)"
            :unread="dm.unread"
            :muted="dm.notificationLevel === NotificationLevel.NOTHING"
            :actions-pinned="isConversationMenuOpen('dm', dm.id)"
            @click="openConversation(dm.id)"
            @contextmenu.prevent="toggleConversationMenu('dm', dm.id)"
          >
            <template #icon>
              <span class="relative inline-flex">
                <UserAvatar
                  :user-id="dm.userId"
                  :display-name="dm.displayName"
                  :avatar-url="dm.avatarUrl"
                  :custom-status="null"
                  size="sm"
                  :presence="dm.presence"
                />
                <span
                  v-if="isEncryptedDirectMessage(dm)"
                  class="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-sidebar-bg bg-sidebar-hover text-sidebar-text"
                  aria-label="Encrypted DM"
                  title="Encrypted DM"
                >
                  <svg class="h-2.5 w-2.5" fill="none" stroke="currentColor" stroke-width="2.4" viewBox="0 0 24 24" aria-hidden="true">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M7 11V8a5 5 0 0110 0v3" />
                    <path stroke-linecap="round" stroke-linejoin="round" d="M6 11h12v9H6z" />
                  </svg>
                </span>
              </span>
            </template>
            <span class="inline-flex min-w-0 items-center gap-1.5">
              <span
                v-if="activeStatus(dm.customStatus)"
                class="shrink-0 text-lg leading-none"
                :title="statusTitle(activeStatus(dm.customStatus))"
                :aria-label="statusTitle(activeStatus(dm.customStatus))"
              >
                {{ activeStatus(dm.customStatus)?.emoji }}
              </span>
              <span class="min-w-0 truncate" :title="dm.displayName">{{ dm.displayName }}</span>
              <CallPresenceIcon
                v-if="hasUserInCall(dm.userId)"
                class="shrink-0"
                :testid="`active-call-icon-dm-${dm.id}`"
                title="In a call"
              />
            </span>
            <template #actions>
              <div class="relative z-40" data-conversation-menu-root @click.stop>
                <button
                  :data-testid="`conversation-menu-button-dm-${dm.id}`"
                  class="flex h-6 w-6 items-center justify-center rounded text-sidebar-textMuted transition-colors hover:bg-sidebar-hover hover:text-sidebar-text"
                  @click.stop="toggleConversationMenu('dm', dm.id)"
                >
                  <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M10 6a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm0 5.5A1.5 1.5 0 1010 8a1.5 1.5 0 000 3.5zm0 5.5a1.5 1.5 0 110-3 1.5 1.5 0 010 3z"/>
                  </svg>
                </button>
                <div
                  v-if="isConversationMenuOpen('dm', dm.id)"
                  class="absolute right-0 top-8 z-50 min-w-44 rounded-lg border border-chat-border bg-chat-header p-1 shadow-2xl"
                >
                  <NotificationLevelSelector
                    :model-value="dm.notificationLevel"
                    @update:model-value="(level) => { chatStore.setNotificationLevel(dm.id, level); closeConversationMenus() }"
                  />
                  <div class="mt-1 border-t border-white/10 pt-1">
                    <button
                      v-if="!isEncryptedDirectMessage(dm)"
                      :data-testid="`conversation-start-e2ee-dm-${dm.id}`"
                      class="w-full rounded px-3 py-2 text-left text-sm text-sidebar-text transition-colors hover:bg-sidebar-hover hover:text-white disabled:opacity-50"
                      :disabled="isStartingE2EConversation(dm.id)"
                      @click.stop="startE2ESessionFromSidebar(dm.id)"
                    >
                      Start E2E session
                    </button>
                    <button
                      :data-testid="`conversation-clear-history-dm-${dm.id}`"
                      class="w-full rounded px-3 py-2 text-left text-sm text-red-300 transition-colors hover:bg-red-500/10 hover:text-red-200 disabled:opacity-50"
                      :disabled="isClearingConversation('dm', dm.id)"
                      @click.stop="clearDMHistoryFromSidebar(dm.id)"
                    >
                      Clear history
                    </button>
                    <button
                      v-if="!isSelfDirectMessage(dm.id)"
                      :data-testid="`conversation-leave-dm-${dm.id}`"
                      class="w-full rounded px-3 py-2 text-left text-sm text-red-300 transition-colors hover:bg-red-500/10 hover:text-red-200 disabled:opacity-50"
                      :disabled="isLeavingConversation('dm', dm.id)"
                      @click.stop="leaveConversationFromSidebar('dm', dm.id)"
                    >
                      Leave
                    </button>
                  </div>
                </div>
              </div>
            </template>
          </SidebarItem>

          <div v-if="!chatStore.bootstrapped && sortedDirectMessages.length === 0" class="mx-1 mt-0.5 space-y-1" aria-hidden="true">
            <div v-for="i in 3" :key="i" class="h-8 animate-pulse rounded-md bg-sidebar-hover" :style="{ width: `${94 - i * 12}%` }" />
          </div>
          <p v-else-if="sortedDirectMessages.length === 0" class="mx-1 px-3 py-1.5 text-xs text-sidebar-textMuted">
            No conversations yet
          </p>
        </div>
      </div>
      <div v-if="conversationActionError" class="px-3 mt-1 text-[11px] text-red-300">
        {{ conversationActionError }}
      </div>
    </nav>

    <!-- Footer actions -->
    <div class="border-t border-white/10 px-3 py-2 space-y-0.5">
      <router-link
        v-if="isAdmin"
        to="/admin"
        class="flex items-center gap-2 px-2 py-1.5 rounded text-sidebar-text hover:bg-sidebar-hover text-sm transition-colors"
        active-class="bg-sidebar-active text-white"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18"/>
        </svg>
        Admin
      </router-link>

      <button
        class="flex items-center gap-2 px-2 py-1.5 rounded text-sidebar-text hover:bg-sidebar-hover text-sm transition-colors w-full"
        @click="$emit('profile')"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <circle cx="12" cy="8" r="4"/>
          <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
        </svg>
        Profile
      </button>

      <button
        class="flex items-center gap-2 px-2 py-1.5 rounded text-sidebar-text hover:bg-sidebar-hover text-sm transition-colors w-full"
        @click="$emit('settings')"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
        Settings
      </button>

      <!-- User identity -->
      <div class="flex items-center gap-2 px-2 py-1.5 mt-1">
        <UserAvatar
          :user-id="sidebarIdentity.userId"
          :display-name="sidebarIdentity.displayName || sidebarIdentity.fallback"
          :avatar-url="sidebarIdentity.avatarUrl"
          :custom-status="null"
          size="sm"
          :presence="selfPresence"
        />
        <div class="min-w-0">
          <div class="flex min-w-0 items-center gap-1.5 text-sm font-medium text-sidebar-text">
            <span
              v-if="activeStatus(sidebarIdentity.customStatus)"
              class="shrink-0 text-lg leading-none"
              :title="statusTitle(activeStatus(sidebarIdentity.customStatus))"
              :aria-label="statusTitle(activeStatus(sidebarIdentity.customStatus))"
            >
              {{ activeStatus(sidebarIdentity.customStatus)?.emoji }}
            </span>
            <span class="min-w-0 truncate">{{ sidebarIdentity.displayName }}</span>
          </div>
          <div class="text-xs text-sidebar-textMuted truncate flex items-center gap-1">
            <span>{{ sidebarIdentity.role }}</span>
            <span>·</span>
            <button
              type="button"
              data-testid="presence-menu-button"
              class="inline-flex items-center gap-1 hover:text-sidebar-text transition-colors"
              @click="presenceMenuOpen = !presenceMenuOpen"
            >
              <span class="w-1.5 h-1.5 rounded-full inline-block" :class="selfPresenceDotClass"/>
              <span>{{ selfPresenceLabel }}</span>
            </button>
          </div>
        </div>
        <button class="ml-auto text-sidebar-textMuted hover:text-red-400 transition-colors" @click="handleLogout">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/>
          </svg>
        </button>
      </div>
      <div v-if="presenceMenuOpen" class="px-2 pb-1">
        <div class="rounded border border-white/10 bg-sidebar-hover/60 p-1 space-y-0.5">
          <button
            type="button"
            data-testid="presence-set-active"
            class="w-full text-left px-2 py-1 rounded text-xs text-sidebar-text hover:bg-white/10"
            @click="setManualPresence('online')"
          >
            Set as active
          </button>
          <button
            type="button"
            data-testid="presence-set-away"
            class="w-full text-left px-2 py-1 rounded text-xs text-sidebar-text hover:bg-white/10"
            @click="setManualPresence('away')"
          >
            Set as away
          </button>
        </div>
      </div>
    </div>

  </aside>

  <Teleport to="body">
    <div
      v-if="channelPickerOpen"
      class="dlg-overlay z-50"
      @click.self="closeChannelPicker"
    >
      <div class="dlg-window" role="dialog" aria-modal="true" aria-label="Join channels">
        <div class="dlg-head">
          <div class="dlg-title">Join channels</div>
          <div class="dlg-sub">Select public channels you want to join.</div>
        </div>

        <div v-if="channelPickerError" class="dlg-note dlg-note-danger">
          {{ channelPickerError }}
        </div>

        <div class="dlg-list">
          <button
            v-for="candidate in channelCandidates"
            :key="candidate.id"
            :data-testid="`channel-candidate-${candidate.id}`"
            class="dlg-row"
            @click="toggleChannelSelection(candidate.id)"
          >
            <span
              class="dlg-check"
              :class="selectedChannelIds.includes(candidate.id) ? 'dlg-check-on' : ''"
            >
              <CallIcon v-if="selectedChannelIds.includes(candidate.id)" name="check" :size="13" />
            </span>
            <div class="min-w-0 flex-1">
              <div class="dlg-row-name truncate"># {{ candidate.name }}</div>
            </div>
          </button>

          <div v-if="!channelLoading && channelCandidates.length === 0" class="dlg-empty">
            No available public channels
          </div>

          <div v-if="channelLoading" class="dlg-empty">
            Loading channels...
          </div>
        </div>

        <div class="dlg-foot-end">
          <button
            class="dlg-btn dlg-btn-ghost"
            @click="closeChannelPicker"
          >
            Close
          </button>
          <button
            data-testid="join-selected-channels-button"
            class="dlg-btn dlg-btn-primary"
            :disabled="selectedChannelIds.length === 0 || joiningChannels"
            @click="joinSelectedChannels"
          >
            {{ joiningChannels ? 'Joining...' : 'Join selected' }}
          </button>
        </div>
      </div>
    </div>

    <div
      v-if="dmPickerOpen"
      class="dlg-overlay z-50"
      @click.self="closeDmPicker"
    >
      <div class="dlg-window" role="dialog" aria-modal="true" aria-label="Start direct message">
        <div class="dlg-head">
          <div class="dlg-title">Start direct message</div>
          <div class="dlg-sub">Choose an active user to open a 1:1 DM.</div>
        </div>

        <div v-if="dmPickerError" class="dlg-note dlg-note-danger">
          {{ dmPickerError }}
        </div>

        <div class="dlg-list">
          <button
            v-for="candidate in dmCandidates"
            :key="candidate.userId"
            :data-testid="`dm-candidate-${candidate.userId}`"
            class="dlg-row"
            @click="selectDmCandidate(candidate.userId)"
          >
            <UserAvatar
              :user-id="candidate.userId"
              :display-name="candidate.displayName"
              :avatar-url="candidate.avatarUrl"
              :custom-status="candidate.customStatus"
              size="sm"
              class="!h-[34px] !w-[34px]"
            />
            <div class="min-w-0 flex-1">
              <div class="dlg-row-name truncate">{{ candidate.displayName }}</div>
            </div>
          </button>

          <div v-if="!dmLoading && dmCandidates.length === 0" class="dlg-empty">
            No available users
          </div>

          <div v-if="dmLoading" class="dlg-empty">
            Loading users...
          </div>
        </div>

        <div class="dlg-foot-end">
          <button
            class="dlg-btn dlg-btn-ghost"
            @click="closeDmPicker"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { NotificationLevel, PresenceStatus } from '@/shared/proto/packets_pb'
import { useAuthStore } from '@/stores/auth'
import { useChatStore } from '@/stores/chat'
import { useWsStore } from '@/stores/ws'
import { useSessionOrchestrator } from '@/composables/useSessionOrchestrator'
import { createOrOpenDm, createOrOpenEncryptedDm, joinChannels, leaveConversation, listAvailableChannels, listDmCandidates } from '@/services/http/chatApi'
import type { DirectMessageItem } from '@/services/http/chatApi'
import { loadManualPresencePreference, saveManualPresencePreference } from '@/services/storage/manualPresenceStorage'
import SidebarItem from './SidebarItem.vue'
import CallIcon from './CallIcon.vue'
import NotificationLevelSelector from './NotificationLevelSelector.vue'
import UserAvatar from './UserAvatar.vue'
import CallPresenceIcon from './CallPresenceIcon.vue'
import {
  formatUserCustomStatusTitle,
  isUserCustomStatusActive,
  userCustomStatusFromDto,
  type UserCustomStatus,
} from '@/types/userStatus'

defineEmits<{ profile: []; settings: []; search: [] }>()

const router = useRouter()
const authStore = useAuthStore()
const chatStore = useChatStore()
const wsStore = useWsStore()
const { logout } = useSessionOrchestrator()

const channelsOpen = ref(true)
const dmsOpen = ref(true)
const channelPickerOpen = ref(false)
const channelLoading = ref(false)
const joiningChannels = ref(false)
const channelPickerError = ref('')
const channelCandidates = ref<Array<{ id: string; name: string }>>([])
const selectedChannelIds = ref<string[]>([])
const dmPickerOpen = ref(false)
const dmLoading = ref(false)
const dmPickerError = ref('')
const dmCandidates = ref<Array<{ userId: string; displayName: string; email: string; avatarUrl: string; customStatus: UserCustomStatus | null }>>([])
const presenceMenuOpen = ref(false)
const manualPresence = ref<'online' | 'away'>(loadManualPresencePreference() ?? 'online')
const openConversationMenuKey = ref('')
const leavingConversationKey = ref('')
const clearingConversationKey = ref('')
const startingE2EConversationKey = ref('')
const conversationActionError = ref('')

type SidebarDirectMessage = typeof chatStore.directMessages[number] & { encryption_mode?: string }

function dmEncryptionMode(dm: SidebarDirectMessage): string {
  return dm.encryptionMode ?? dm.encryption_mode ?? 'none'
}

function isEncryptedDirectMessage(dm: SidebarDirectMessage): boolean {
  return dmEncryptionMode(dm) === 'dm_pairwise_signal_v1'
}

function directMessageFromDto(dm: DirectMessageItem): typeof chatStore.directMessages[number] {
  const customStatus = userCustomStatusFromDto(dm.custom_status)
  return {
    id: dm.conversation_id,
    userId: dm.user_id,
    displayName: dm.display_name || dm.email,
    avatarUrl: dm.avatar_url,
    ...(customStatus ? { customStatus } : {}),
    presence: 'offline',
    encryptionMode: dm.encryption_mode === 'dm_pairwise_signal_v1' ? 'dm_pairwise_signal_v1' : 'none',
    unread: 0,
    notificationLevel: NotificationLevel.ALL,
  }
}

const isAdmin = computed(() => {
  const role = authStore.effectiveRole ?? chatStore.workspace?.selfRole
  return role === 'admin' || role === 'owner'
})
const unreadBadgeLabel = computed(() => (
  chatStore.totalUnreadCount > 99 ? '99+' : String(chatStore.totalUnreadCount)
))
const sortedChannels = computed(() =>
  [...chatStore.channels].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
)
// Direct messages are ordered by their latest message activity (newest first),
// independent of read/unread state. Missing timestamps sort last; ties fall
// back to lastMessageSeq, then name, then id for a stable deterministic order.
const sortedDirectMessages = computed(() =>
  [...chatStore.directMessages].sort((a, b) => {
    const aTime = a.lastActivityAt ? Date.parse(a.lastActivityAt) : Number.NaN
    const bTime = b.lastActivityAt ? Date.parse(b.lastActivityAt) : Number.NaN
    const aHasTime = Number.isFinite(aTime)
    const bHasTime = Number.isFinite(bTime)
    if (aHasTime && bHasTime && aTime !== bTime) {
      return bTime - aTime
    }
    if (aHasTime !== bHasTime) {
      return aHasTime ? -1 : 1
    }

    const aSeq = typeof a.lastMessageSeq === 'bigint' ? a.lastMessageSeq : 0n
    const bSeq = typeof b.lastMessageSeq === 'bigint' ? b.lastMessageSeq : 0n
    if (aSeq !== bSeq) {
      return aSeq > bSeq ? -1 : 1
    }

    const byName = a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' })
    if (byName !== 0) {
      return byName
    }

    const byUserId = a.userId.localeCompare(b.userId, undefined, { sensitivity: 'base' })
    if (byUserId !== 0) {
      return byUserId
    }

    return a.id.localeCompare(b.id, undefined, { sensitivity: 'base' })
  })
)

const sidebarIdentity = computed(() => ({
  userId: authStore.user?.id ?? chatStore.workspace?.selfUserId ?? '',
  displayName: authStore.user?.displayName ?? chatStore.workspace?.selfDisplayName ?? '',
  avatarUrl: authStore.user?.avatarUrl ?? chatStore.workspace?.selfAvatarUrl ?? '',
  customStatus: authStore.user ? (authStore.user.customStatus ?? null) : (chatStore.workspace?.selfCustomStatus ?? null),
  role: authStore.effectiveRole ?? chatStore.workspace?.selfRole ?? '',
  fallback: authStore.user?.email ?? chatStore.workspace?.name ?? '?',
}))
const selfPresence = computed(() => {
  const selfUserId = authStore.user?.id ?? chatStore.workspace?.selfUserId ?? ''
  if (!selfUserId) return manualPresence.value
  const presence = chatStore.presenceByUserId[selfUserId]?.effectivePresence
  if (presence === PresenceStatus.AWAY) return 'away'
  if (presence === PresenceStatus.ONLINE) return 'online'
  return manualPresence.value
})
const selfPresenceLabel = computed(() => selfPresence.value === 'away' ? 'Away' : 'Active')
const selfPresenceDotClass = computed(() => selfPresence.value === 'away' ? 'bg-amber-400' : 'bg-green-400')

function hasActiveCall(conversationId: string): boolean {
  return chatStore.activeCalls.some(call => call.conversationId === conversationId)
}

function hasUserInCall(userId: string): boolean {
  return (chatStore.userCallPresenceByUserId[userId] ?? 0) > 0
}

function activeStatus(status: UserCustomStatus | null | undefined): UserCustomStatus | null {
  return isUserCustomStatusActive(status) && status.emoji.trim() ? status : null
}

function statusTitle(status: UserCustomStatus | null): string {
  return status ? formatUserCustomStatusTitle(status) : ''
}

function isConversationActive(conversationId: string): boolean {
  return chatStore.chatViewMode === 'conversation' && chatStore.activeChannelId === conversationId
}

async function handleLogout() {
  await logout()
  router.push({ name: 'login' })
}

async function openConversation(conversationId: string) {
  chatStore.selectChannel(conversationId)
  if (router.currentRoute.value.name !== 'main') {
    await router.push({ name: 'main' })
  }
}

async function openUnreadView() {
  chatStore.showUnreadView()
  void chatStore.refreshUnreadFeed()
  if (router.currentRoute.value.name !== 'main') {
    await router.push({ name: 'main' })
  }
}

async function openSavedView() {
  chatStore.showSavedView()
  void chatStore.refreshSavedMessages()
  if (router.currentRoute.value.name !== 'main') {
    await router.push({ name: 'main' })
  }
}

function canSendPresence() {
  return wsStore.state === 'AUTH_COMPLETE'
    || wsStore.state === 'BOOTSTRAPPING'
    || wsStore.state === 'LIVE_SYNCED'
    || wsStore.state === 'RECOVERING_GAP'
    || wsStore.state === 'STALE_REBOOTSTRAP'
}

function setManualPresence(value: 'online' | 'away') {
  manualPresence.value = value
  saveManualPresencePreference(value)
  if (canSendPresence()) {
    wsStore.sendSetPresence(value === 'away' ? PresenceStatus.AWAY : PresenceStatus.ONLINE)
  }
  presenceMenuOpen.value = false
}

function conversationMenuKey(kind: 'channel' | 'dm', conversationId: string) {
  return `${kind}:${conversationId}`
}

function isConversationMenuOpen(kind: 'channel' | 'dm', conversationId: string) {
  return openConversationMenuKey.value === conversationMenuKey(kind, conversationId)
}

function isLeavingConversation(kind: 'channel' | 'dm', conversationId: string) {
  return leavingConversationKey.value === conversationMenuKey(kind, conversationId)
}

function isClearingConversation(kind: 'channel' | 'dm', conversationId: string) {
  return clearingConversationKey.value === conversationMenuKey(kind, conversationId)
}

function isStartingE2EConversation(conversationId: string) {
  return startingE2EConversationKey.value === conversationMenuKey('dm', conversationId)
}

function toggleConversationMenu(kind: 'channel' | 'dm', conversationId: string) {
  const key = conversationMenuKey(kind, conversationId)
  openConversationMenuKey.value = openConversationMenuKey.value === key ? '' : key
  conversationActionError.value = ''
}

function closeConversationMenus() {
  openConversationMenuKey.value = ''
}

async function leaveConversationFromSidebar(kind: 'channel' | 'dm', conversationId: string) {
  if (kind === 'dm' && isSelfDirectMessage(conversationId)) {
    return
  }
  const key = conversationMenuKey(kind, conversationId)
  leavingConversationKey.value = key
  conversationActionError.value = ''
  try {
    await leaveConversation(conversationId)
    chatStore.removeConversationLocal(conversationId)
    openConversationMenuKey.value = ''
  } catch (err) {
    conversationActionError.value = err instanceof Error ? err.message : 'Failed to leave conversation'
  } finally {
    if (leavingConversationKey.value === key) {
      leavingConversationKey.value = ''
    }
  }
}

async function clearDMHistoryFromSidebar(conversationId: string) {
  if (typeof window !== 'undefined' && !window.confirm('Clear this direct message history for both members?')) {
    return
  }
  const key = conversationMenuKey('dm', conversationId)
  clearingConversationKey.value = key
  conversationActionError.value = ''
  try {
    await chatStore.clearDMConversationHistory(conversationId)
    openConversationMenuKey.value = ''
  } catch (err) {
    conversationActionError.value = err instanceof Error ? err.message : 'Failed to clear history'
  } finally {
    if (clearingConversationKey.value === key) {
      clearingConversationKey.value = ''
    }
  }
}

async function startE2ESessionFromSidebar(conversationId: string) {
  const key = conversationMenuKey('dm', conversationId)
  startingE2EConversationKey.value = key
  conversationActionError.value = ''
  try {
    const dm = await createOrOpenEncryptedDm(conversationId)
    chatStore.openDirectMessage(directMessageFromDto(dm))
    dmsOpen.value = true
    openConversationMenuKey.value = ''
  } catch (err) {
    conversationActionError.value = err instanceof Error ? err.message : 'Failed to start E2E session'
  } finally {
    if (startingE2EConversationKey.value === key) {
      startingE2EConversationKey.value = ''
    }
  }
}

onMounted(() => {
  document.addEventListener('click', closeConversationMenus)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', closeConversationMenus)
})

async function openDmPicker() {
  dmPickerOpen.value = true
  dmLoading.value = true
  dmPickerError.value = ''
  try {
    const candidates = await listDmCandidates()
    const selfCandidate = sidebarIdentity.value.userId
      ? [{
          userId: sidebarIdentity.value.userId,
          displayName: sidebarIdentity.value.displayName || authStore.user?.email || sidebarIdentity.value.fallback,
          email: authStore.user?.email ?? '',
          avatarUrl: sidebarIdentity.value.avatarUrl,
          customStatus: sidebarIdentity.value.customStatus,
        }]
      : []
    const existingDmUserIds = new Set(
      chatStore.directMessages
        .map(dm => dm.userId)
        .filter(userId => userId.trim().length > 0),
    )
    dmCandidates.value = [...selfCandidate, ...candidates.map(candidate => ({
      userId: candidate.user_id,
      displayName: candidate.display_name || candidate.email,
      email: candidate.email,
      avatarUrl: candidate.avatar_url,
      customStatus: userCustomStatusFromDto(candidate.custom_status),
    }))]
      .filter(candidate => !existingDmUserIds.has(candidate.userId))
  } catch (err) {
    dmPickerError.value = err instanceof Error ? err.message : 'Failed to load users'
  } finally {
    dmLoading.value = false
  }
}

async function openChannelPicker() {
  channelPickerOpen.value = true
  channelLoading.value = true
  channelPickerError.value = ''
  selectedChannelIds.value = []
  try {
    const channels = await listAvailableChannels()
    channelCandidates.value = channels
      .filter(channel => channel.kind === 'channel' && channel.visibility === 'public')
      .map(channel => ({
        id: channel.id,
        name: channel.name,
      }))
  } catch (err) {
    channelPickerError.value = err instanceof Error ? err.message : 'Failed to load channels'
  } finally {
    channelLoading.value = false
  }
}

function closeChannelPicker() {
  closeConversationMenus()
  channelPickerOpen.value = false
  channelPickerError.value = ''
  joiningChannels.value = false
}

function toggleChannelSelection(channelId: string) {
  if (selectedChannelIds.value.includes(channelId)) {
    selectedChannelIds.value = selectedChannelIds.value.filter(id => id !== channelId)
    return
  }
  selectedChannelIds.value = [...selectedChannelIds.value, channelId]
}

async function joinSelectedChannels() {
  if (selectedChannelIds.value.length === 0) return
  joiningChannels.value = true
  channelPickerError.value = ''
  try {
    const selectedInDialogOrder = channelCandidates.value
      .filter(channel => selectedChannelIds.value.includes(channel.id))
      .map(channel => channel.id)

    const joined = await joinChannels(selectedInDialogOrder)
    for (const channel of joined) {
      const mapped = {
        id: channel.id,
        name: channel.name,
        kind: 'channel' as const,
        visibility: channel.visibility === 'private' ? 'private' as const : 'public' as const,
        unread: 0,
        lastActivityAt: channel.last_activity_at,
        notificationLevel: NotificationLevel.ALL,
      }
      const existingIdx = chatStore.channels.findIndex(existing => existing.id === channel.id)
      if (existingIdx === -1) {
        chatStore.channels.unshift(mapped)
      } else {
        chatStore.channels.splice(existingIdx, 1, mapped)
      }
    }
    if (joined.length > 0) {
      channelsOpen.value = true
      chatStore.selectChannel(joined[0].id)
    }
    closeChannelPicker()
  } catch (err) {
    channelPickerError.value = err instanceof Error ? err.message : 'Failed to join channels'
  } finally {
    joiningChannels.value = false
  }
}

function closeDmPicker() {
  closeConversationMenus()
  dmPickerOpen.value = false
  dmPickerError.value = ''
}

async function selectDmCandidate(userId: string) {
  dmPickerError.value = ''
  try {
    const dm = await createOrOpenDm(userId)
    chatStore.openDirectMessage(directMessageFromDto(dm))
    dmsOpen.value = true
    closeDmPicker()
  } catch (err) {
    dmPickerError.value = err instanceof Error ? err.message : 'Failed to open direct message'
  }
}

function isSelfDirectMessage(conversationId: string) {
  const dm = chatStore.directMessages.find(item => item.id === conversationId)
  return dm?.userId === (authStore.user?.id ?? chatStore.workspace?.selfUserId ?? '')
}
</script>
