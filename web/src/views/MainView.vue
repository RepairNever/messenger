<template>
  <div class="flex h-screen overflow-hidden">
    <aside class="flex w-14 shrink-0 flex-col items-center gap-3 border-r border-white/10 bg-sidebar-bg py-3">
      <div class="group relative">
        <button
          type="button"
          class="flex h-10 w-10 items-center justify-center rounded-lg text-sidebar-textMuted transition-colors hover:bg-sidebar-hover hover:text-sidebar-text"
          :title="sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'"
          :aria-label="sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'"
          data-testid="mode-collapse"
          @click="toggleSidebarCollapsed"
        >
          <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="4" y="5" width="16" height="14" rx="2" />
            <path d="M9 5v14" />
            <path v-if="sidebarCollapsed" d="m11 12 3-3v6l-3-3Z" fill="currentColor" stroke="none" />
            <path v-else d="m13 12 3-3v6l-3-3Z" fill="currentColor" stroke="none" />
          </svg>
        </button>
        <span class="pointer-events-none absolute left-12 top-1/2 -translate-y-1/2 whitespace-nowrap rounded border border-chat-border bg-chat-header px-2 py-1 text-xs text-gray-200 opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
          {{ sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar' }}
        </span>
      </div>
      <div class="group relative">
        <button
          type="button"
          class="flex h-10 w-10 items-center justify-center rounded-lg transition-colors"
          :class="appMode === 'chat' ? 'bg-sidebar-active text-white' : 'text-sidebar-textMuted hover:bg-sidebar-hover hover:text-sidebar-text'"
          title="Chat"
          aria-label="Chat"
          data-testid="mode-chat"
          @click="goToChatMode"
        >
          <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />
          </svg>
        </button>
        <span
          v-if="showChatModeUnreadBadge"
          data-testid="mode-chat-unread-badge"
          class="pointer-events-none absolute -top-1 -right-1 z-10 inline-flex min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1 text-[11px] font-bold leading-[18px] text-white"
        >
          {{ chatModeUnreadBadgeLabel }}
        </span>
        <span class="pointer-events-none absolute left-12 top-1/2 -translate-y-1/2 rounded border border-chat-border bg-chat-header px-2 py-1 text-xs text-gray-200 opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
          Chat
        </span>
      </div>
      <div class="group relative">
        <button
          type="button"
          class="flex h-10 w-10 items-center justify-center rounded-lg transition-colors"
          :class="appMode === 'task-tracker' ? 'bg-sidebar-active text-white' : 'text-sidebar-textMuted hover:bg-sidebar-hover hover:text-sidebar-text'"
          title="Task tracker"
          aria-label="Task tracker"
          data-testid="mode-task-tracker"
          @click="goToTaskTrackerMode"
        >
          <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 11 11 13 15 9" />
            <rect x="4" y="4" width="16" height="16" rx="2" />
          </svg>
        </button>
        <span class="pointer-events-none absolute left-12 top-1/2 -translate-y-1/2 whitespace-nowrap rounded border border-chat-border bg-chat-header px-2 py-1 text-xs text-gray-200 opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
          Task tracker
        </span>
      </div>
      <div class="group relative">
        <button
          type="button"
          class="flex h-10 w-10 items-center justify-center rounded-lg transition-colors"
          :class="appMode === 'documents' ? 'bg-sidebar-active text-white' : 'text-sidebar-textMuted hover:bg-sidebar-hover hover:text-sidebar-text'"
          title="Documents"
          aria-label="Documents"
          data-testid="mode-documents"
          @click="goToDocumentsMode"
        >
          <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
            <path d="M14 3v6h6" />
          </svg>
        </button>
        <span class="pointer-events-none absolute left-12 top-1/2 -translate-y-1/2 whitespace-nowrap rounded border border-chat-border bg-chat-header px-2 py-1 text-xs text-gray-200 opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
          Documents
        </span>
      </div>
      <div class="group relative">
        <button
          type="button"
          class="flex h-10 w-10 items-center justify-center rounded-lg transition-colors"
          :class="appMode === 'dayoffs' ? 'bg-sidebar-active text-white' : 'text-sidebar-textMuted hover:bg-sidebar-hover hover:text-sidebar-text'"
          title="Dayoffs"
          aria-label="Dayoffs"
          data-testid="mode-dayoffs"
          @click="goToDayoffsMode"
        >
          <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="5" width="18" height="16" rx="2" />
            <path d="M7 3v4M17 3v4M3 10h18" />
            <path d="m8 15 2 2 5-5" />
          </svg>
        </button>
        <span class="pointer-events-none absolute left-12 top-1/2 -translate-y-1/2 whitespace-nowrap rounded border border-chat-border bg-chat-header px-2 py-1 text-xs text-gray-200 opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
          Dayoffs
        </span>
      </div>
    </aside>
    <ResizableSidebar
      v-if="appMode === 'chat' && !sidebarCollapsed"
      storage-key="msgnr:sidebar-width:chat:v1"
      :default-width="240"
      :min-width="220"
      :max-width="420"
    >
      <AppSidebar @profile="openSettings" @settings="openAudioSettings" @search="openGlobalMessageSearch" />
    </ResizableSidebar>
    <main class="flex-1 min-w-0 min-h-0">
      <ConnectionBanner
        :is-reconnecting="isReconnecting"
        :reconnect-attempt="reconnectAttempt"
        :queue-length="offlineQueue.queue.value.length"
        :is-auth-degraded="showSessionRecoveryBanner"
        @reconnect-now="reconnectNow"
      />
      <template v-if="appMode === 'chat'">
        <UnreadFeedPane
          v-if="chatStore.chatViewMode === 'unread'"
          @open-item="openUnreadFeedItem"
        />
        <SavedMessagesPane
          v-else-if="chatStore.chatViewMode === 'saved'"
          @open-item="openSavedMessageItem"
        />
        <ChatArea v-else @search-conversation="openConversationMessageSearch" />
      </template>
      <template v-else-if="appMode === 'task-tracker'">
        <TaskTrackerShell
          v-model="selectedTemplateFilter"
          :sidebar-collapsed="sidebarCollapsed"
          :current-view="taskTrackerBaseRouteName"
          :view-mode="taskTrackerViewMode"
          @open-list="openTaskListRoute"
          @open-kanban="openTaskKanbanRoute"
          @open-task="openTask"
          @back="backToList"
        />
      </template>
      <template v-else-if="appMode === 'documents'">
        <DocumentsShell
          :sidebar-collapsed="sidebarCollapsed"
          :selected-teamspace-id="documentsSelectedTeamspaceId"
          :selected-document-id="routeDocumentId || documentsStore.selectedDocument?.id || null"
          :search-query="documentsStore.searchQuery"
          :view-mode="documentsViewMode"
          @open-teamspaces="openDocumentsTeamspacesRoute"
          @open-teamspace="openDocumentsTeamspaceRoute"
          @open-document="openDocument"
          @documents-deleted="handleDocumentsDeleted"
          @search-query-change="handleDocumentsSearchQueryChange"
          @back="backToDocuments"
          @open-parent="openDocument"
        />
      </template>
      <DayoffsShell v-else :sidebar-collapsed="sidebarCollapsed" />
    </main>
    <PinnedDialogsHost />
    <MessageSearchDialog
      :open="messageSearchOpen"
      :scope="messageSearchScope"
      :conversation-id="messageSearchConversationId"
      :conversation-title="messageSearchConversationTitle"
      @close="messageSearchOpen = false"
      @open-result="openMessageSearchResult"
    />
    <div
      v-if="chatStore.toast"
      class="pointer-events-none fixed right-4 bottom-4 z-50 rounded-md border border-red-300/40 bg-red-500/90 px-3 py-2 text-sm text-white shadow-lg"
      role="status"
      aria-live="polite"
    >
      {{ chatStore.toast.message }}
    </div>

    <Teleport to="body">
      <div
        v-if="settingsOpen"
        class="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
        @click.self="closeSettings"
      >
        <div class="flex w-full max-w-lg flex-col overflow-hidden rounded-xl border border-chat-border bg-chat-header shadow-2xl max-h-[90vh]">
          <div class="shrink-0 border-b border-chat-border px-5 pt-4">
            <h2 class="text-lg font-semibold text-app-text">Profile</h2>
            <div class="mt-4 flex gap-1 overflow-x-auto" role="tablist" aria-label="Profile settings sections">
              <button
                v-for="tab in profileSettingsTabs"
                :key="tab.id"
                type="button"
                role="tab"
                class="whitespace-nowrap rounded-t-md border-x border-t px-3 py-2 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-accent"
                :class="settingsActiveTab === tab.id
                  ? 'border-chat-border bg-chat-input text-app-text'
                  : 'border-transparent text-app-muted hover:bg-chat-msgHover hover:text-app-text'"
                :aria-selected="settingsActiveTab === tab.id"
                :data-testid="`profile-tab-${tab.id}`"
                @click="setSettingsActiveTab(tab.id)"
              >
                {{ tab.label }}
              </button>
            </div>
          </div>

          <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <section v-if="settingsActiveTab === 'profile'" class="space-y-4" role="tabpanel" aria-label="Profile">
              <div class="rounded border border-chat-border bg-chat-input/60 p-3">
                <div class="flex items-center gap-3">
                  <UserAvatar
                    :user-id="authStore.user?.id ?? chatStore.workspace?.selfUserId ?? ''"
                    :display-name="settingsDisplayName || settingsEmail || 'User'"
                    :avatar-url="authStore.user?.avatarUrl ?? chatStore.workspace?.selfAvatarUrl ?? ''"
                    :custom-status="settingsPreviewCustomStatus"
                    size="xl"
                  />
                  <div class="flex flex-col gap-2">
                    <input
                      ref="profileAvatarInput"
                      type="file"
                      class="hidden"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      @change="onProfileAvatarSelected"
                    >
                    <button
                      type="button"
                      class="rounded border border-chat-border px-3 py-1.5 text-xs text-app-secondaryText hover:bg-chat-msgHover disabled:opacity-50"
                      :disabled="settingsAvatarLoading"
                      @click="openProfileAvatarPicker"
                    >
                      {{ settingsAvatarLoading ? 'Uploading...' : 'Upload avatar' }}
                    </button>
                    <button
                      type="button"
                      class="rounded border border-chat-border px-3 py-1.5 text-xs text-app-secondaryText hover:bg-chat-msgHover disabled:opacity-50"
                      :disabled="settingsAvatarLoading || !(authStore.user?.avatarUrl ?? '').trim()"
                      @click="removeProfileAvatar"
                    >
                      Remove avatar
                    </button>
                  </div>
                </div>
                <p class="mt-2 text-[11px] text-app-muted">Max 5 MB. JPG, PNG, WEBP, GIF.</p>
              </div>

              <div>
                <label class="block text-sm text-app-muted mb-1">Display name</label>
                <input
                  v-model="settingsDisplayName"
                  type="text"
                  class="w-full bg-chat-input border border-chat-border rounded px-3 py-2 text-app-text text-sm outline-none focus:border-accent"
                  placeholder="Display name"
                />
              </div>
              <div>
                <label class="block text-sm text-app-muted mb-1">Email</label>
                <input
                  v-model="settingsEmail"
                  type="email"
                  class="w-full bg-chat-input border border-chat-border rounded px-3 py-2 text-app-text text-sm outline-none focus:border-accent"
                  placeholder="you@example.com"
                />
              </div>
            </section>

            <section v-else-if="settingsActiveTab === 'status'" class="rounded border border-chat-border bg-chat-input/40 p-3" role="tabpanel" aria-label="Status">
              <div class="mb-3 flex items-center justify-between gap-3">
                <h3 class="text-sm font-semibold text-app-text">Status</h3>
                <button
                  type="button"
                  class="text-xs text-app-muted transition-colors hover:text-app-text disabled:opacity-50"
                  :disabled="!hasStatusDraft && !settingsInitialCustomStatusKey"
                  @click="clearStatusDraft"
                >
                  Clear status
                </button>
              </div>
              <div class="grid grid-cols-[auto_1fr] gap-2">
                <button
                  ref="statusEmojiPickerToggleButton"
                  type="button"
                  class="flex h-10 min-w-10 items-center justify-center rounded border border-chat-border bg-chat-input px-2 text-sm text-app-secondaryText transition-colors hover:bg-chat-msgHover"
                  @click.stop="toggleStatusEmojiPicker"
                >
                  {{ settingsStatusEmoji || 'Emoji' }}
                </button>
                <input
                  v-model="settingsStatusText"
                  type="text"
                  maxlength="120"
                  class="w-full rounded border border-chat-border bg-chat-input px-3 py-2 text-sm text-app-text outline-none focus:border-accent"
                  placeholder="gone to a meeting"
                />
                <div class="col-span-2">
                  <label class="mb-1 block text-xs text-app-muted">Valid for</label>
                  <div class="grid grid-cols-3 gap-2">
                    <label class="min-w-0">
                      <span class="mb-1 block text-[11px] text-app-muted">Days</span>
                      <input
                        v-model.number="settingsStatusDurationDays"
                        type="number"
                        min="0"
                        step="1"
                        inputmode="numeric"
                        class="w-full rounded border border-chat-border bg-chat-input px-3 py-2 text-sm text-app-text outline-none focus:border-accent"
                      />
                    </label>
                    <label class="min-w-0">
                      <span class="mb-1 block text-[11px] text-app-muted">Hours</span>
                      <input
                        v-model.number="settingsStatusDurationHours"
                        type="number"
                        min="0"
                        max="23"
                        step="1"
                        inputmode="numeric"
                        class="w-full rounded border border-chat-border bg-chat-input px-3 py-2 text-sm text-app-text outline-none focus:border-accent"
                      />
                    </label>
                    <label class="min-w-0">
                      <span class="mb-1 block text-[11px] text-app-muted">Minutes</span>
                      <input
                        v-model.number="settingsStatusDurationMinutes"
                        type="number"
                        min="0"
                        max="59"
                        step="1"
                        inputmode="numeric"
                        class="w-full rounded border border-chat-border bg-chat-input px-3 py-2 text-sm text-app-text outline-none focus:border-accent"
                      />
                    </label>
                  </div>
                </div>
              </div>
              <p v-if="settingsStatusError" class="mt-2 text-xs text-red-400">{{ settingsStatusError }}</p>
            </section>

            <section v-else-if="settingsActiveTab === 'theme'" aria-labelledby="profile-color-theme-heading" role="tabpanel">
              <h3 id="profile-color-theme-heading" class="text-sm font-semibold text-app-text">Color theme</h3>
              <div class="mt-3 grid grid-cols-3 gap-2">
                <button
                  v-for="theme in colorThemes"
                  :key="theme.id"
                  type="button"
                  class="rounded border px-2 py-2 text-left text-xs transition-colors focus:outline-none focus:ring-2 focus:ring-accent"
                  :class="currentThemeId === theme.id
                    ? 'border-accent bg-app-selection text-app-selectionText'
                    : 'border-chat-border bg-chat-input text-app-secondaryText hover:bg-chat-msgHover'"
                  :aria-pressed="currentThemeId === theme.id"
                  :data-testid="`profile-theme-${theme.id}`"
                  @click="setColorTheme(theme.id)"
                >
                  <span class="mb-2 flex gap-1" aria-hidden="true">
                    <span
                      v-for="swatch in theme.swatches"
                      :key="swatch"
                      class="h-4 flex-1 rounded-sm border border-chat-border"
                      :style="{ backgroundColor: swatch }"
                    />
                  </span>
                  <span class="block truncate font-medium">{{ theme.label }}</span>
                </button>
              </div>
            </section>

            <section v-else-if="settingsActiveTab === 'password'" class="space-y-3" role="tabpanel" aria-label="Password">
              <div>
                <label class="block text-sm text-app-muted mb-1">New password</label>
                <input
                  v-model="settingsNewPassword"
                  type="password"
                  autocomplete="new-password"
                  class="w-full bg-chat-input border border-chat-border rounded px-3 py-2 text-app-text text-sm outline-none focus:border-accent"
                  placeholder="••••••••"
                  @keyup.enter="savePassword"
                />
              </div>
              <div>
                <label class="block text-sm text-app-muted mb-1">Confirm new password</label>
                <input
                  v-model="settingsConfirmPassword"
                  type="password"
                  autocomplete="new-password"
                  class="w-full bg-chat-input border border-chat-border rounded px-3 py-2 text-app-text text-sm outline-none focus:border-accent"
                  placeholder="••••••••"
                  @keyup.enter="savePassword"
                />
              </div>
            </section>

            <section v-else class="space-y-6" role="tabpanel" aria-label="Security">
              <div>
                <h3 class="text-sm font-semibold text-app-text">Encrypted direct messages</h3>
                <p class="mt-1 text-xs leading-5 text-app-muted">
                  {{ settingsE2EEDeviceAvailable
                    ? 'This browser has an encrypted-DM identity.'
                    : 'This browser has no encrypted-DM identity yet.' }}
                </p>
              </div>

              <div class="border-t border-chat-border pt-5">
                <h4 class="text-sm font-medium text-app-text">Create recovery package</h4>
                <p class="mt-1 text-xs leading-5 text-app-muted">
                  Anyone with this package and its passphrase can read encrypted-DM history available to this identity.
                </p>
                <template v-if="settingsE2EEDeviceAvailable">
                  <div class="mt-4 space-y-3">
                    <label class="block">
                      <span class="mb-1 block text-xs text-app-muted">Recovery passphrase</span>
                      <input
                        v-model="settingsE2EEExportPassphrase"
                        type="password"
                        autocomplete="new-password"
                        class="w-full rounded border border-chat-border bg-chat-input px-3 py-2 text-sm text-app-text outline-none focus:border-accent"
                        data-testid="e2ee-recovery-export-passphrase"
                        @input="clearE2EERecoveryPackage"
                      >
                    </label>
                    <label class="block">
                      <span class="mb-1 block text-xs text-app-muted">Confirm passphrase</span>
                      <input
                        v-model="settingsE2EEExportPassphraseConfirmation"
                        type="password"
                        autocomplete="new-password"
                        class="w-full rounded border border-chat-border bg-chat-input px-3 py-2 text-sm text-app-text outline-none focus:border-accent"
                        data-testid="e2ee-recovery-export-passphrase-confirmation"
                        @input="clearE2EERecoveryPackage"
                      >
                    </label>
                    <button
                      type="button"
                      class="rounded bg-accent px-3 py-2 text-xs font-medium text-app-onAccent transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                      :disabled="!canCreateE2EERecoveryPackage || settingsE2EEExporting"
                      data-testid="e2ee-recovery-create"
                      @click="createE2EERecoveryPackage"
                    >
                      {{ settingsE2EEExporting ? 'Creating...' : 'Create recovery package' }}
                    </button>
                  </div>

                  <div v-if="settingsE2EERecoveryPackage" class="mt-4 space-y-2">
                    <label class="block">
                      <span class="mb-1 block text-xs text-app-muted">Recovery package</span>
                      <textarea
                        :value="settingsE2EERecoveryPackage"
                        readonly
                        rows="4"
                        spellcheck="false"
                        autocapitalize="off"
                        autocomplete="off"
                        class="w-full resize-y rounded border border-chat-border bg-chat-input px-3 py-2 font-mono text-xs text-app-text outline-none focus:border-accent"
                        data-testid="e2ee-recovery-export-package"
                      ></textarea>
                    </label>
                    <button
                      type="button"
                      class="rounded border border-chat-border px-3 py-2 text-xs text-app-secondaryText transition-colors hover:bg-chat-msgHover"
                      data-testid="e2ee-recovery-copy"
                      @click="copyE2EERecoveryPackage"
                    >
                      Copy recovery package
                    </button>
                  </div>
                </template>
                <p v-else class="mt-3 text-xs leading-5 text-app-muted">
                  Start or open an encrypted DM on this browser before creating a recovery package.
                </p>
              </div>

              <div class="border-t border-chat-border pt-5">
                <h4 class="text-sm font-medium text-app-text">Restore recovery package</h4>
                <p class="mt-1 text-xs leading-5 text-app-muted">
                  Restoring keeps the original browser active because both browsers share the recovered encrypted-DM identity.
                </p>
                <div class="mt-4 space-y-3">
                  <label class="block">
                    <span class="mb-1 block text-xs text-app-muted">Recovery package</span>
                    <textarea
                      v-model="settingsE2EEImportPackage"
                      rows="4"
                      maxlength="32768"
                      spellcheck="false"
                      autocapitalize="off"
                      autocomplete="off"
                      class="w-full resize-y rounded border border-chat-border bg-chat-input px-3 py-2 font-mono text-xs text-app-text outline-none focus:border-accent"
                      data-testid="e2ee-recovery-import-package"
                      @input="resetE2EERecoveryImportConfirmation"
                    ></textarea>
                  </label>
                  <label class="block">
                    <span class="mb-1 block text-xs text-app-muted">Recovery passphrase</span>
                    <input
                      v-model="settingsE2EEImportPassphrase"
                      type="password"
                      autocomplete="new-password"
                      class="w-full rounded border border-chat-border bg-chat-input px-3 py-2 text-sm text-app-text outline-none focus:border-accent"
                      data-testid="e2ee-recovery-import-passphrase"
                      @input="resetE2EERecoveryImportConfirmation"
                    >
                  </label>
                  <label
                    v-if="settingsE2EEReplacementConfirmationRequired"
                    class="flex items-start gap-2 rounded border border-amber-400/40 bg-amber-500/10 p-3 text-xs leading-5 text-app-secondaryText"
                  >
                    <input
                      v-model="settingsE2EEReplaceConfirmed"
                      type="checkbox"
                      class="mt-1 h-4 w-4 shrink-0 accent-accent"
                      data-testid="e2ee-recovery-replace-confirmation"
                    >
                    <span>
                      I exported this browser's current identity. Replacing it can make messages addressed only to that identity unavailable here.
                    </span>
                  </label>
                  <button
                    type="button"
                    class="rounded bg-accent px-3 py-2 text-xs font-medium text-app-onAccent transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                    :disabled="!canRestoreE2EERecoveryPackage || settingsE2EEImporting"
                    data-testid="e2ee-recovery-restore"
                    @click="restoreE2EERecoveryPackage"
                  >
                    {{ settingsE2EEImporting ? 'Restoring...' : 'Restore encrypted DMs' }}
                  </button>
                </div>
              </div>

              <p v-if="settingsE2EERecoveryError" class="text-xs text-red-400" role="alert">
                {{ settingsE2EERecoveryError }}
              </p>
              <p v-if="settingsE2EERecoverySuccess" class="text-xs text-emerald-300" role="status">
                {{ settingsE2EERecoverySuccess }}
              </p>
            </section>
          </div>

          <div v-if="settingsError" class="px-5 text-red-400 text-sm">
            {{ settingsError }}
          </div>
          <div v-if="settingsAvatarError" class="px-5 text-red-400 text-sm">
            {{ settingsAvatarError }}
          </div>
          <div v-if="settingsSuccess" class="px-5 text-emerald-300 text-sm">
            {{ settingsSuccess }}
          </div>
          <div v-if="settingsPasswordError" class="px-5 text-red-400 text-sm">
            {{ settingsPasswordError }}
          </div>
          <div v-if="settingsPasswordSuccess" class="px-5 text-emerald-300 text-sm">
            {{ settingsPasswordSuccess }}
          </div>

          <div class="flex shrink-0 gap-3 border-t border-chat-border px-5 py-4">
            <button
              class="py-2 rounded bg-chat-msgHover hover:bg-app-tertiary text-app-secondaryText text-sm transition-colors"
              :class="settingsActiveTab === 'security' ? 'w-full' : 'flex-1'"
              :disabled="settingsLoading || settingsE2EEBusy"
              @click="closeSettings"
            >
              Cancel
            </button>
            <button
              v-if="settingsActiveTab === 'profile' || settingsActiveTab === 'status'"
              class="flex-1 py-2 rounded bg-accent hover:bg-accent-hover text-app-onAccent text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="!canSaveSettings || settingsLoading"
              @click="saveSettings"
            >
              {{ settingsLoading ? 'Saving...' : 'Save' }}
            </button>
            <button
              v-if="settingsActiveTab === 'password'"
              class="flex-1 py-2 rounded bg-accent hover:bg-accent-hover text-app-onAccent text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="settingsPasswordLoading || (!settingsNewPassword && !settingsConfirmPassword)"
              @click="savePassword"
            >
              {{ settingsPasswordLoading ? 'Changing...' : 'Change password' }}
            </button>
          </div>
        </div>
      </div>
      <div
        v-if="settingsOpen && showStatusEmojiPicker"
        ref="statusEmojiPickerRoot"
        class="z-[80] emoji-picker-dark"
        :style="statusEmojiPickerStyle"
        @click.stop
      >
        <component
          :is="statusPickerComponent"
          v-if="statusPickerComponent && statusEmojiIndex"
          :data="statusEmojiIndex"
          :native="true"
          set="apple"
          title="Set status emoji"
          emoji="slightly_smiling_face"
          :show-preview="true"
          :show-skin-tones="false"
          :infinite-scroll="true"
          :emoji-size="26"
          :per-line="9"
          :color="statusEmojiPickerAccentColor"
          @select="onSelectStatusEmoji"
          @selected="onSelectStatusEmoji"
        />
        <div
          v-else
          class="rounded-md border border-chat-border bg-chat-header px-3 py-2 text-xs text-app-muted shadow-xl"
        >
          Loading emoji...
        </div>
      </div>
    </Teleport>

    <SettingsDialog :open="audioSettingsOpen" @close="audioSettingsOpen = false" />

    <div
      v-if="incomingInvite"
      class="fixed top-5 left-1/2 z-50 w-[min(92vw,26rem)] -translate-x-1/2 rounded-xl border border-chat-border bg-chat-header/95 p-4 text-white shadow-2xl backdrop-blur"
      role="dialog"
      aria-live="polite"
    >
      <div class="text-sm font-semibold">Incoming call</div>
      <div class="mt-1 text-sm text-gray-200">
        {{ incomingInviteCaller }} is calling in {{ incomingInviteConversationTitle }}.
      </div>
      <div v-if="incomingInviteError" class="mt-2 rounded border border-red-400/40 bg-red-500/10 px-2 py-1 text-xs text-red-200">
        {{ incomingInviteError }}
      </div>
      <div class="mt-3 flex justify-end gap-2">
        <button
          type="button"
          class="rounded border border-chat-border px-3 py-1.5 text-xs text-gray-200 hover:bg-white/10 disabled:opacity-50"
          :disabled="handlingIncomingInvite"
          @click="rejectIncomingInvite"
        >
          Reject
        </button>
        <button
          type="button"
          class="rounded bg-emerald-600 px-3 py-1.5 text-xs text-white hover:bg-emerald-500 disabled:opacity-50"
          :disabled="handlingIncomingInvite"
          @click="acceptIncomingInvite"
        >
          {{ handlingIncomingInvite ? 'Joining...' : 'Accept' }}
        </button>
      </div>
    </div>
    <CallDock />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted, defineAsyncComponent, defineComponent, h } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { PresenceStatus } from '@/shared/proto/packets_pb'
import { useWsStore } from '@/stores/ws'
import { useChatStore, type IncomingMessageNotification, type SavedMessageItem, type UnreadFeedItem } from '@/stores/chat'
import { useAuthStore } from '@/stores/auth'
import { usePinnedDialogsStore } from '@/stores/pinnedDialogs'
import { useSessionOrchestrator } from '@/composables/useSessionOrchestrator'
import { useOfflineQueue } from '@/composables/useOfflineQueue'
import { usePushNotifications, pushSupported } from '@/composables/usePushNotifications'
import { useColorTheme } from '@/composables/useColorTheme'
import { loadPushEndpoint } from '@/services/storage/pushStorage'
import { loadManualPresencePreference } from '@/services/storage/manualPresenceStorage'
import { useNotificationSoundEngine } from '@/services/sound'
import { getPlatformOrNull } from '@/platform'
import { isTauriRuntime } from '@/platform/runtime'
import {
  loadLastOpenedTaskPublicId,
  saveLastOpenedTaskPublicId,
  clearLastOpenedTaskPublicId,
} from '@/services/storage/lastTaskRouteStorage'
import {
  isUuidTaskRouteValue,
  taskPublicIdFromSlug,
  taskSlugFromPublicId,
} from '@/services/taskRoute'
import {
  notificationOpenIntentFromMessage,
  notificationOpenIntentFromQuery,
  stripNotificationOpenQuery,
  type NotificationOpenIntent,
} from '@/services/notificationOpen'
import { activateE2EERecoveryDevice } from '@/services/http/chatApi'
import {
  E2EERecoveryError,
  exportEncryptedDMRecoveryPackage,
  hasLocalEncryptedDMDevice,
  localEncryptedDMDeviceId,
  prepareEncryptedDMRecoveryImport,
} from '@/services/e2ee/dmE2ee'
import { loadSidebarCollapsed, saveSidebarCollapsed } from '@/services/storage/sidebarCollapseStorage'
import ResizableSidebar from '@/components/ResizableSidebar.vue'
import AppSidebar from '@/components/AppSidebar.vue'
import ChatArea from '@/components/ChatArea.vue'
import PinnedDialogsHost from '@/components/PinnedDialogsHost.vue'
import ConnectionBanner from '@/components/ConnectionBanner.vue'
import UnreadFeedPane from '@/components/UnreadFeedPane.vue'
import SavedMessagesPane from '@/components/SavedMessagesPane.vue'
import MessageSearchDialog from '@/components/MessageSearchDialog.vue'
import CallDock from '@/components/CallDock.vue'
import UserAvatar from '@/components/UserAvatar.vue'
import type { MessageSearchResult } from '@/services/http/searchApi'
import { useTasksStore } from '@/stores/tasks'
import { useDocumentsStore } from '@/stores/documents'
import { useComposerEmojiPicker } from '@/composables/useComposerEmojiPicker'
import {
  isUserCustomStatusActive,
  type UserCustomStatus,
} from '@/types/userStatus'
const SettingsDialog = defineAsyncComponent(() => import('@/components/SettingsDialog.vue'))
function createTaskTrackerShellStub() {
  return defineComponent({
    name: 'TaskTrackerShellStub',
    props: {
      modelValue: {
        type: String,
        default: null,
      },
      currentView: {
        type: String,
        required: true,
      },
      viewMode: {
        type: String,
        required: true,
      },
      sidebarCollapsed: {
        type: Boolean,
        required: true,
      },
    },
    emits: ['update:modelValue', 'openList', 'openKanban', 'openTask', 'back'],
    setup(props, { emit }) {
      return () => h('div', { 'data-testid': 'task-tracker' }, [
        !props.sidebarCollapsed ? h('aside', { 'data-testid': 'task-tracker-sidebar' }) : null,
        props.viewMode === 'card'
          ? h('section', { 'data-testid': 'task-card' }, [
              h('button', {
                'data-testid': 'task-card-back',
                type: 'button',
                onClick: () => emit('back'),
              }, 'back'),
            ])
          : props.viewMode === 'kanban'
            ? h('section', { 'data-testid': 'task-kanban-view' }, [
                h('button', {
                  'data-testid': 'task-kanban-open',
                  type: 'button',
                  onClick: () => emit('openTask', 'TASK-K'),
                }, 'open'),
              ])
            : h('section', { 'data-testid': 'task-list-view' }, [
                h('button', {
                  'data-testid': 'task-list-open',
                  type: 'button',
                  onClick: () => emit('openTask', 'TASK-1'),
                }, 'open'),
              ]),
        h('div', { 'data-testid': 'task-create-dialog' }),
      ])
    },
  })
}

function createDocumentsShellStub() {
  return defineComponent({
    name: 'DocumentsShellStub',
    props: {
      selectedTeamspaceId: {
        type: String,
        default: null,
      },
      selectedDocumentId: {
        type: String,
        default: null,
      },
      searchQuery: {
        type: String,
        default: '',
      },
      viewMode: {
        type: String,
        required: true,
      },
      sidebarCollapsed: {
        type: Boolean,
        required: true,
      },
    },
    emits: ['openTeamspaces', 'openTeamspace', 'openDocument', 'documentsDeleted', 'searchQueryChange', 'back', 'openParent'],
    setup(props, { emit }) {
      return () => h('div', { 'data-testid': 'documents-mode' }, [
        !props.sidebarCollapsed ? h('aside', { 'data-testid': 'documents-sidebar' }, [
          h('input', {
            'data-testid': 'documents-search-input',
            value: props.searchQuery,
            onInput: (event: Event) => emit('searchQueryChange', (event.target as HTMLInputElement).value),
          }),
        ]) : null,
        props.viewMode === 'card'
          ? h('section', { 'data-testid': 'document-card' }, [
              h('button', {
                'data-testid': 'document-card-back',
                type: 'button',
                onClick: () => emit('back'),
              }, 'back'),
            ])
          : props.viewMode === 'search'
            ? h('section', { 'data-testid': 'documents-search-view' }, [
                h('button', {
                  'data-testid': 'documents-search-open',
                  type: 'button',
                  onClick: () => emit('openDocument', 'search-doc-1'),
                }, 'open'),
              ])
          : h('section', { 'data-testid': 'teamspaces-view' }),
      ])
    },
  })
}

function createDayoffsShellStub() {
  return defineComponent({
    name: 'DayoffsShellStub',
    props: {
      sidebarCollapsed: {
        type: Boolean,
        default: false,
      },
    },
    setup(props) {
      return () => h('section', { 'data-testid': 'dayoffs-mode' }, [
        !props.sidebarCollapsed ? h('aside', { 'data-testid': 'dayoffs-sidebar' }) : null,
        'Dayoffs',
      ])
    },
  })
}

const TaskTrackerShell = import.meta.env.MODE === 'test'
  ? createTaskTrackerShellStub()
  : defineAsyncComponent(() => import('@/components/tasks/TaskTrackerShell.vue'))
const DocumentsShell = import.meta.env.MODE === 'test'
  ? createDocumentsShellStub()
  : defineAsyncComponent(() => import('@/components/documents/DocumentsShell.vue'))
const DayoffsShell = import.meta.env.MODE === 'test'
  ? createDayoffsShellStub()
  : defineAsyncComponent(() => import('@/components/dayoffs/DayoffsShell.vue'))
import { useCallStore } from '@/stores/call'

const route = useRoute()
const router = useRouter()
type ProfileSettingsTab = 'profile' | 'status' | 'theme' | 'password' | 'security'
const profileSettingsTabs: Array<{ id: ProfileSettingsTab; label: string }> = [
  { id: 'profile', label: 'Profile' },
  { id: 'status', label: 'Status' },
  { id: 'theme', label: 'Theme' },
  { id: 'password', label: 'Password' },
  { id: 'security', label: 'Security' },
]
const settingsOpen = ref(false)
const settingsActiveTab = ref<ProfileSettingsTab>('profile')
const audioSettingsOpen = ref(false)
const settingsLoading = ref(false)
const settingsError = ref('')
const settingsSuccess = ref('')
const settingsDisplayName = ref('')
const settingsEmail = ref('')
const settingsInitialDisplayName = ref('')
const settingsInitialEmail = ref('')
const settingsStatusText = ref('')
const settingsStatusEmoji = ref('')
const settingsStatusDurationDays = ref(0)
const settingsStatusDurationHours = ref(1)
const settingsStatusDurationMinutes = ref(0)
const settingsInitialCustomStatusKey = ref('')
const settingsStatusSaveError = ref('')
const settingsNewPassword = ref('')
const settingsConfirmPassword = ref('')
const settingsPasswordLoading = ref(false)
const settingsPasswordError = ref('')
const settingsPasswordSuccess = ref('')
const settingsE2EEDeviceAvailable = ref(false)
const settingsE2EEExportPassphrase = ref('')
const settingsE2EEExportPassphraseConfirmation = ref('')
const settingsE2EERecoveryPackage = ref('')
const settingsE2EEImportPackage = ref('')
const settingsE2EEImportPassphrase = ref('')
const settingsE2EEReplacementConfirmationRequired = ref(false)
const settingsE2EEReplaceConfirmed = ref(false)
const settingsE2EEExporting = ref(false)
const settingsE2EEImporting = ref(false)
const settingsE2EERecoveryError = ref('')
const settingsE2EERecoverySuccess = ref('')
let e2eeRecoveryOperationGeneration = 0
const settingsAvatarLoading = ref(false)
const settingsAvatarError = ref('')
const profileAvatarInput = ref<HTMLInputElement | null>(null)
const {
  showEmojiPicker: showStatusEmojiPicker,
  pickerRoot: statusEmojiPickerRoot,
  pickerToggleButton: statusEmojiPickerToggleButton,
  pickerComponent: statusPickerComponent,
  emojiIndex: statusEmojiIndex,
  emojiPickerStyle: statusEmojiPickerStyle,
  toggleEmojiPicker: toggleStatusEmojiPicker,
  closeEmojiPicker: closeStatusEmojiPicker,
  onSelectEmoji: onSelectStatusEmoji,
} = useComposerEmojiPicker({
  onSelect: (emoji) => {
    settingsStatusEmoji.value = emoji
  },
})
const sidebarCollapsed = ref(loadSidebarCollapsed())
const wsStore = useWsStore()
const chatStore = useChatStore()
const pinnedDialogsStore = usePinnedDialogsStore()
const callStore = useCallStore()
const authStore = useAuthStore()
const { logout, isReconnecting, reconnectAttempt, reconnectNow } = useSessionOrchestrator()
const { themes: colorThemes, currentTheme, currentThemeId, setTheme: setColorTheme } = useColorTheme()
const statusEmojiPickerAccentColor = computed(() => currentTheme.value.tokens.accent)
const offlineQueue = useOfflineQueue()
const soundEngine = useNotificationSoundEngine()
const platform = getPlatformOrNull()
const isDesktopRuntime = isTauriRuntime()
const { checkExistingSubscription: checkPushSubscription, subscribe: subscribePush } = usePushNotifications()
const showSessionRecoveryBanner = computed(() => authStore.authState === 'AUTH_DEGRADED')
const handlingIncomingInvite = ref(false)
const incomingInviteError = ref('')
const dismissedInviteIds = ref<string[]>([])
const messageSearchOpen = ref(false)
const messageSearchScope = ref<'global' | 'conversation'>('global')
const selectedTemplateFilter = ref<string | null>(null)
const lastTaskTrackerNonCardRoute = ref<'tasks-list' | 'tasks-kanban'>('tasks-list')
type DocumentsBrowseRoute =
  | { name: 'documents-teamspaces' }
  | { name: 'documents-teamspace'; teamspaceId: string }
type DocumentsNonCardRoute =
  | DocumentsBrowseRoute
  | { name: 'documents-search'; query: string }
type DocumentsCardRoute = {
  documentId: string
}

const lastDocumentsBrowseRoute = ref<DocumentsBrowseRoute>({
  name: 'documents-teamspaces',
})
const lastDocumentsNonCardRoute = ref<DocumentsNonCardRoute>({
  name: 'documents-teamspaces',
})
const lastDocumentsCardRoute = ref<DocumentsCardRoute | null>(null)
let unsubscribeIncomingMessageSound: (() => void) | null = null
const tasksStore = useTasksStore()
const documentsStore = useDocumentsStore()
const isTaskTrackerRoute = computed(() => (
  route.name === 'tasks-list'
  || route.name === 'tasks-kanban'
  || route.name === 'tasks-card'
))
const isDocumentsRoute = computed(() => (
  route.name === 'documents-teamspaces'
  || route.name === 'documents-teamspace'
  || route.name === 'documents-search'
  || route.name === 'documents-card'
))
const isDayoffsRoute = computed(() => route.name === 'dayoffs')
const taskTrackerBaseRouteName = computed<'tasks-list' | 'tasks-kanban'>(() => {
  if (route.name === 'tasks-list') return 'tasks-list'
  if (route.name === 'tasks-kanban') return 'tasks-kanban'
  return lastTaskTrackerNonCardRoute.value
})
const appMode = computed<'chat' | 'task-tracker' | 'documents' | 'dayoffs'>(() => {
  if (isTaskTrackerRoute.value) return 'task-tracker'
  if (isDocumentsRoute.value) return 'documents'
  if (isDayoffsRoute.value) return 'dayoffs'
  return 'chat'
})
const taskTrackerViewMode = computed<'list' | 'kanban' | 'card'>(() => {
  if (route.name === 'tasks-card') return 'card'
  if (route.name === 'tasks-kanban') return 'kanban'
  return 'list'
})
const documentsViewMode = computed<'teamspaces' | 'teamspace' | 'search' | 'card'>(() => {
  if (route.name === 'documents-card') return 'card'
  if (route.name === 'documents-search') return 'search'
  if (route.name === 'documents-teamspace') return 'teamspace'
  return 'teamspaces'
})
const showChatModeUnreadBadge = computed(() => appMode.value !== 'chat' && chatStore.totalUnreadCount > 0)
const chatModeUnreadBadgeLabel = computed(() => (chatStore.totalUnreadCount > 99 ? '99+' : String(chatStore.totalUnreadCount)))
const pendingNotificationOpenIntent = ref<NotificationOpenIntent | null>(null)
const routeTaskSlug = computed(() =>
  typeof route.params.taskSlug === 'string' ? route.params.taskSlug : '',
)
const routeDocumentId = computed(() =>
  typeof route.params.documentId === 'string' ? route.params.documentId : '',
)
const routeDocumentsTeamspaceId = computed(() =>
  typeof route.params.teamspaceId === 'string' ? route.params.teamspaceId : '',
)
const routeDocumentsSearchQuery = computed(() => {
  const value = route.query.q
  return typeof value === 'string' ? value : ''
})
const documentsSelectedTeamspaceId = computed(() =>
  routeDocumentsTeamspaceId.value || documentsStore.selectedDocument?.teamspace_id || null,
)
const messageSearchConversationId = computed(() =>
  messageSearchScope.value === 'conversation' ? chatStore.activeChannelId : undefined
)
const messageSearchConversationTitle = computed(() => {
  if (messageSearchScope.value !== 'conversation') return undefined
  const conversation = chatStore.activeConversation
  if (!conversation) return undefined
  return conversation.kind === 'dm' ? `@${conversation.title}` : `#${conversation.title}`
})
let serviceWorkerMessageHandler: ((event: MessageEvent) => void) | null = null

function setSidebarCollapsed(value: boolean) {
  sidebarCollapsed.value = value
  saveSidebarCollapsed(value)
}

function toggleSidebarCollapsed() {
  setSidebarCollapsed(!sidebarCollapsed.value)
}

async function goToChatMode() {
  if (route.name === 'main') {
    if (sidebarCollapsed.value) {
      setSidebarCollapsed(false)
    }
    return
  }
  setSidebarCollapsed(false)
  await router.push({ name: 'main' })
}

function queueNotificationOpenIntent(intent: NotificationOpenIntent | null) {
  if (!intent?.conversationId) return
  pendingNotificationOpenIntent.value = intent
  void tryConsumeNotificationOpenIntent()
}

function canConsumeNotificationOpenIntent() {
  return authStore.authState === 'AUTHENTICATED'
    && chatStore.bootstrapped
    && wsStore.state === 'LIVE_SYNCED'
}

function hasConversationInSnapshot(conversationId: string): boolean {
  return chatStore.channels.some(channel => channel.id === conversationId)
    || chatStore.directMessages.some(dm => dm.id === conversationId)
}

function hasRootMessageInConversation(conversationId: string, messageId: string): boolean {
  if (!conversationId || !messageId) return false
  return chatStore.getMessagesForConversation(conversationId).some(message => message.id === messageId)
}

function rootMessageIdFromIntent(intent: NotificationOpenIntent): string {
  return intent.threadRootMessageId || intent.messageId || ''
}

async function openChatTarget(intent: NotificationOpenIntent, options: { focusThreadMessage?: boolean } = {}): Promise<boolean> {
  if (!intent.conversationId) return false

  if (router.currentRoute.value.name !== 'main') {
    await router.replace({ name: 'main' })
  }

  chatStore.showConversationView()
  chatStore.clearFocusedMessages()

  if (chatStore.activeChannelId !== intent.conversationId) {
    await chatStore.selectChannel(intent.conversationId)
  } else {
    await chatStore.ensureConversationHistory(intent.conversationId)
  }

  const rootMessageId = rootMessageIdFromIntent(intent)
  if (rootMessageId && !hasRootMessageInConversation(intent.conversationId, rootMessageId)) {
    const contextLoadResult = await chatStore.loadMessageContext(intent.conversationId, rootMessageId)
    if (contextLoadResult === 'forbidden') {
      chatStore.showToast('You no longer have access to this conversation.')
      return false
    }
  }

  if (intent.threadRootMessageId) {
    const rootMessage = chatStore.getMessagesForConversation(intent.conversationId)
      .find(message => message.id === intent.threadRootMessageId)
    if (rootMessage) {
      // Product decision: thread notifications open pinned thread workspace only.
      chatStore.focusConversationMessage(rootMessage.id)
      if (options.focusThreadMessage && intent.messageId && intent.messageId !== rootMessage.id) {
        chatStore.focusThreadMessage(intent.messageId)
      }
      pinnedDialogsStore.ensureThreadPinned(intent.conversationId, rootMessage.id)
      return true
    }
  }

  if (intent.messageId) {
    chatStore.focusConversationMessage(intent.messageId)
  }
  chatStore.requestConversationComposerFocus()
  return true
}

async function clearNotificationOpenQueryParams() {
  const currentRoute = router.currentRoute.value
  if (!notificationOpenIntentFromQuery(currentRoute.query as Record<string, unknown>)) return
  const nextQuery = stripNotificationOpenQuery(currentRoute.query as Record<string, unknown>)
  if (typeof currentRoute.name === 'string') {
    await router.replace({
      name: currentRoute.name,
      params: currentRoute.params,
      query: nextQuery as Record<string, string | string[]>,
      hash: currentRoute.hash,
    })
    return
  }
  await router.replace({
    path: currentRoute.path,
    query: nextQuery as Record<string, string | string[]>,
    hash: currentRoute.hash,
  })
}

async function tryConsumeNotificationOpenIntent() {
  const intent = pendingNotificationOpenIntent.value
  if (!intent || !canConsumeNotificationOpenIntent()) return

  if (!hasConversationInSnapshot(intent.conversationId)) {
    pendingNotificationOpenIntent.value = null
    await clearNotificationOpenQueryParams()
    return
  }

  pendingNotificationOpenIntent.value = null
  await openChatTarget(intent)
  await clearNotificationOpenQueryParams()
}

async function openUnreadFeedItem(item: UnreadFeedItem) {
  const opened = await openChatTarget({
    conversationId: item.conversationId,
    ...(item.messageId ? { messageId: item.messageId } : {}),
    ...(item.threadRootMessageId ? { threadRootMessageId: item.threadRootMessageId } : {}),
  })
  if (!opened) return
  await chatStore.markUnreadFeedItemRead(item)
}

async function openSavedMessageItem(item: SavedMessageItem) {
  await openChatTarget({
    conversationId: item.conversationId,
    messageId: item.messageId,
    ...(item.threadRootMessageId ? { threadRootMessageId: item.threadRootMessageId } : {}),
  }, { focusThreadMessage: true })
}

function openGlobalMessageSearch() {
  messageSearchScope.value = 'global'
  messageSearchOpen.value = true
}

function openConversationMessageSearch() {
  if (!chatStore.activeChannelId) return
  messageSearchScope.value = 'conversation'
  messageSearchOpen.value = true
}

async function openTaskCommentSearchTarget(item: MessageSearchResult): Promise<boolean> {
  if (!item.task_public_id || !item.task_comment_id) {
    chatStore.showToast('Search result is missing task details.')
    return false
  }
  const taskSlug = canonicalTaskSlugFromPublicId(item.task_public_id)
  saveLastOpenedTaskPublicId(item.task_public_id)
  setSidebarCollapsed(false)
  await router.push({
    name: 'tasks-card',
    params: { taskSlug },
    query: { comment: item.task_comment_id },
  })
  return true
}

async function openMessageSearchResult(item: MessageSearchResult) {
  if (item.source === 'chat_message') {
    if (!item.conversation_id || !item.message_id) return
    await openChatTarget({
      conversationId: item.conversation_id,
      messageId: item.message_id,
      ...(item.thread_root_message_id ? { threadRootMessageId: item.thread_root_message_id } : {}),
    }, { focusThreadMessage: true })
    return
  }

  const openedTask = await openTaskCommentSearchTarget(item)
  if (!openedTask) return
  if (item.source !== 'task_comment_thread') return
  if (!item.conversation_id || !item.thread_root_message_id || !item.message_id) return

  const title = item.task_public_id ? `Task ${item.task_public_id}` : 'Task'
  chatStore.focusThreadMessage(item.message_id)
  pinnedDialogsStore.ensureThreadPinned(item.conversation_id, item.thread_root_message_id, title)
}

function canonicalTaskSlugFromPublicId(publicId: string): string {
  return taskSlugFromPublicId(publicId)
}

function canonicalTaskPublicIdFromSlug(taskSlug: string): string {
  return taskPublicIdFromSlug(taskSlug)
}

async function pushTaskRoute(publicId: string, replace = false) {
  const taskSlug = canonicalTaskSlugFromPublicId(publicId)
  if (replace) {
    await router.replace({ name: 'tasks-card', params: { taskSlug } })
    return
  }
  await router.push({ name: 'tasks-card', params: { taskSlug } })
}

async function syncTaskRouteToSelectedTask(replace = false) {
  const task = tasksStore.selectedTask
  if (!task) return
  saveLastOpenedTaskPublicId(task.public_id)
  const canonicalTaskSlug = canonicalTaskSlugFromPublicId(task.public_id)
  if (route.name === 'tasks-card' && routeTaskSlug.value === canonicalTaskSlug) return
  await pushTaskRoute(task.public_id, replace)
}

async function goToTaskTrackerMode() {
  if (isTaskTrackerRoute.value) {
    if (sidebarCollapsed.value) {
      setSidebarCollapsed(false)
    }
    return
  }
  setSidebarCollapsed(false)
  const rememberedTaskPublicId = loadLastOpenedTaskPublicId()
  if (rememberedTaskPublicId) {
    await pushTaskRoute(rememberedTaskPublicId)
    return
  }
  await router.push({ name: 'tasks-list' })
}

async function goToDocumentsMode() {
  if (
    route.name === 'documents-card'
    || route.name === 'documents-teamspace'
    || route.name === 'documents-teamspaces'
    || route.name === 'documents-search'
  ) {
    if (sidebarCollapsed.value) {
      setSidebarCollapsed(false)
    }
    return
  }
  setSidebarCollapsed(false)
  if (lastDocumentsCardRoute.value) {
    await router.push({
      name: 'documents-card',
      params: { documentId: lastDocumentsCardRoute.value.documentId },
    })
    return
  }
  if (lastDocumentsNonCardRoute.value.name === 'documents-search' && lastDocumentsNonCardRoute.value.query.trim()) {
    await router.push({ name: 'documents-search', query: { q: lastDocumentsNonCardRoute.value.query } })
    return
  }
  if (lastDocumentsBrowseRoute.value.name === 'documents-teamspace') {
    const { teamspaceId } = lastDocumentsBrowseRoute.value
    await router.push({ name: 'documents-teamspace', params: { teamspaceId } })
    return
  }
  await router.push({ name: 'documents-teamspaces' })
}

async function goToDayoffsMode() {
  if (isDayoffsRoute.value) return
  setSidebarCollapsed(false)
  await router.push({ name: 'dayoffs' })
}

async function openTaskListRoute() {
  lastTaskTrackerNonCardRoute.value = 'tasks-list'
  if (route.name === 'tasks-list') return
  await router.push({ name: 'tasks-list' })
}

async function openTaskKanbanRoute() {
  lastTaskTrackerNonCardRoute.value = 'tasks-kanban'
  if (route.name === 'tasks-kanban') return
  await router.push({ name: 'tasks-kanban' })
}

async function openTask(publicId: string) {
  saveLastOpenedTaskPublicId(publicId)
  await pushTaskRoute(publicId)
}

async function openDocumentsTeamspacesRoute() {
  documentsStore.clearSearch()
  lastDocumentsNonCardRoute.value = { name: 'documents-teamspaces' }
  lastDocumentsBrowseRoute.value = { name: 'documents-teamspaces' }
  if (route.name === 'documents-teamspaces') return
  await router.push({ name: 'documents-teamspaces' })
}

async function openDocumentsTeamspaceRoute(teamspaceId: string) {
  documentsStore.clearSearch()
  lastDocumentsNonCardRoute.value = { name: 'documents-teamspace', teamspaceId }
  lastDocumentsBrowseRoute.value = { name: 'documents-teamspace', teamspaceId }
  if (route.name === 'documents-teamspace' && routeDocumentsTeamspaceId.value === teamspaceId) return
  await router.push({ name: 'documents-teamspace', params: { teamspaceId } })
}

async function openDocument(id: string) {
  await router.push({ name: 'documents-card', params: { documentId: id } })
}

async function handleDocumentsSearchQueryChange(value: string) {
  documentsStore.setSearchQuery(value)
  const trimmedValue = value.trim()

  if (!trimmedValue) {
    documentsStore.clearSearch()
    if (lastDocumentsBrowseRoute.value.name === 'documents-teamspace') {
      lastDocumentsNonCardRoute.value = {
        name: 'documents-teamspace',
        teamspaceId: lastDocumentsBrowseRoute.value.teamspaceId,
      }
    } else {
      lastDocumentsNonCardRoute.value = { name: 'documents-teamspaces' }
    }
    if (lastDocumentsBrowseRoute.value.name === 'documents-teamspace') {
      await router.replace({ name: 'documents-teamspace', params: { teamspaceId: lastDocumentsBrowseRoute.value.teamspaceId } })
      return
    }
    await router.replace({ name: 'documents-teamspaces' })
    return
  }

  const target = { name: 'documents-search' as const, query: { q: trimmedValue } }
  if (route.name === 'documents-search') {
    await router.replace(target)
    return
  }
  await router.push(target)
}

async function handleDocumentsDeleted(deletedDocumentIds: string[]) {
  if (deletedDocumentIds.length === 0) return
  const currentDocumentId = routeDocumentId.value || documentsStore.selectedDocument?.id || ''
  if (!currentDocumentId || !deletedDocumentIds.includes(currentDocumentId)) {
    return
  }
  if (lastDocumentsCardRoute.value?.documentId === currentDocumentId) {
    lastDocumentsCardRoute.value = null
  }
  documentsStore.clearSelectedDocument()
  await backToDocuments()
}

function routeTaskSlugMatchesSelected(routeSlug: string): boolean {
  const task = tasksStore.selectedTask
  if (!task) return false
  return task.public_id === canonicalTaskPublicIdFromSlug(routeSlug)
}

function routeDocumentIdMatchesSelected(routeID: string): boolean {
  const documentItem = documentsStore.selectedDocument
  if (!documentItem) return false
  return documentItem.id === routeID
}

async function backToList() {
  tasksStore.clearSelectedTask()
  // Refresh the list so any edits made in the card are reflected
  await tasksStore.loadTaskList()
  await router.push({ name: lastTaskTrackerNonCardRoute.value })
}

async function backToDocuments(forceSidebarRefresh = false) {
  documentsStore.clearSelectedDocument()
  if (forceSidebarRefresh) {
    await documentsStore.loadSidebar(true)
  }
  if (lastDocumentsNonCardRoute.value.name === 'documents-search' && lastDocumentsNonCardRoute.value.query.trim()) {
    await router.push({ name: 'documents-search', query: { q: lastDocumentsNonCardRoute.value.query } })
    return
  }
  if (lastDocumentsBrowseRoute.value.name === 'documents-teamspace') {
    await router.push({ name: 'documents-teamspace', params: { teamspaceId: lastDocumentsBrowseRoute.value.teamspaceId } })
    return
  }
  await router.push({ name: 'documents-teamspaces' })
}

watch(
  () => ({
    name: route.name,
    taskSlug: routeTaskSlug.value,
    documentId: routeDocumentId.value,
    teamspaceId: routeDocumentsTeamspaceId.value,
    searchQuery: routeDocumentsSearchQuery.value,
  }),
  async ({ name, taskSlug, documentId, teamspaceId, searchQuery }) => {
    if (name === 'tasks-card') {
      if (!taskSlug || isUuidTaskRouteValue(taskSlug)) {
        await router.replace({ name: lastTaskTrackerNonCardRoute.value })
        return
      }
      if (routeTaskSlugMatchesSelected(taskSlug)) {
        await syncTaskRouteToSelectedTask(true)
        return
      }
      const publicId = canonicalTaskPublicIdFromSlug(taskSlug)
      tasksStore.clearSelectedTask()
      await tasksStore.selectTaskByPublicId(publicId, true)
      if (routeTaskSlugMatchesSelected(taskSlug)) {
        await syncTaskRouteToSelectedTask(true)
      } else {
        clearLastOpenedTaskPublicId()
        await router.replace({ name: lastTaskTrackerNonCardRoute.value })
      }
      return
    }

    if (name === 'tasks-list' || name === 'tasks-kanban') {
      lastTaskTrackerNonCardRoute.value = name
      tasksStore.clearSelectedTask()
      return
    }

    if (name === 'documents-card') {
      if (!documentId) {
        await backToDocuments()
        return
      }
      lastDocumentsCardRoute.value = { documentId }
      void documentsStore.loadSidebar()
      if (routeDocumentIdMatchesSelected(documentId)) {
        return
      }
      documentsStore.clearSelectedDocument()
      await documentsStore.selectDocument(documentId, true)
      if (!routeDocumentIdMatchesSelected(documentId)) {
        if (lastDocumentsCardRoute.value?.documentId === documentId) {
          lastDocumentsCardRoute.value = null
        }
        await backToDocuments()
      }
      return
    }

    if (name === 'documents-teamspace') {
      if (!teamspaceId) {
        await router.replace({ name: 'documents-teamspaces' })
        return
      }
      documentsStore.clearSearch()
      lastDocumentsNonCardRoute.value = { name: 'documents-teamspace', teamspaceId }
      lastDocumentsBrowseRoute.value = { name: 'documents-teamspace', teamspaceId }
      documentsStore.clearSelectedDocument()
      void documentsStore.loadTeamspaces()
      void documentsStore.loadSidebar()
      return
    }

    if (name === 'documents-search') {
      const trimmedSearchQuery = searchQuery.trim()
      lastDocumentsNonCardRoute.value = { name: 'documents-search', query: trimmedSearchQuery }
      documentsStore.clearSelectedDocument()
      void documentsStore.loadTeamspaces()
      void documentsStore.loadSidebar()
      documentsStore.setSearchQuery(trimmedSearchQuery)
      if (!trimmedSearchQuery) {
        documentsStore.clearSearch()
        return
      }
      documentsStore.scheduleSearch(trimmedSearchQuery)
      return
    }

    if (name === 'documents-teamspaces') {
      documentsStore.clearSearch()
      lastDocumentsNonCardRoute.value = { name: 'documents-teamspaces' }
      lastDocumentsBrowseRoute.value = { name: 'documents-teamspaces' }
      documentsStore.clearSelectedDocument()
      void documentsStore.loadTeamspaces()
      void documentsStore.loadSidebar()
      return
    }

    if (name === 'main') {
      tasksStore.clearSelectedTask()
      documentsStore.clearSelectedDocument()
    }
  },
  { immediate: true },
)

// Keep URL in sync when selected task changes from inside the card (subtasks, create dialog).
watch(() => tasksStore.selectedTask?.public_id, (taskPublicId) => {
  if (!taskPublicId || !isTaskTrackerRoute.value) return
  // While browsing the list, avoid re-opening a card due stale task selections.
  // The list should auto-open a card only for freshly created tasks.
  if (
    route.name !== 'tasks-card'
    && !(tasksStore.createDialogOpen && (route.name === 'tasks-list' || route.name === 'tasks-kanban'))
  ) {
    return
  }
  void syncTaskRouteToSelectedTask(route.name === 'tasks-card')
})

watch(() => documentsStore.selectedDocument?.id, (documentId) => {
  if (!documentId || !isDocumentsRoute.value) return
  if (
    route.name !== 'documents-card'
    && route.name !== 'documents-teamspace'
    && route.name !== 'documents-teamspaces'
    && route.name !== 'documents-search'
  ) return
  if (route.name === 'documents-card' && routeDocumentId.value === documentId) return
  void router.push({ name: 'documents-card', params: { documentId } })
})

watch(
  () => route.name,
  (name) => {
    if (
      name === 'tasks-list'
      || name === 'tasks-kanban'
      || name === 'tasks-card'
      || name === 'documents-teamspaces'
      || name === 'documents-teamspace'
      || name === 'documents-search'
      || name === 'documents-card'
    ) return
    selectedTemplateFilter.value = null
  }
)

const incomingInvite = computed(() => {
  const pending = chatStore.pendingInvites
    .filter(item => !dismissedInviteIds.value.includes(item.id))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  return pending[0] ?? null
})

const incomingInviteConversation = computed(() => {
  const invite = incomingInvite.value
  if (!invite) return null
  const channel = chatStore.channels.find(item => item.id === invite.conversationId)
  if (channel) {
    return {
      kind: 'channel' as const,
      visibility: channel.visibility,
      title: `#${channel.name}`,
    }
  }
  const dm = chatStore.directMessages.find(item => item.id === invite.conversationId)
  if (dm) {
    return {
      kind: 'dm' as const,
      visibility: 'dm' as const,
      title: `@${dm.displayName}`,
    }
  }
  return {
    kind: 'channel' as const,
    visibility: 'public' as const,
    title: 'this conversation',
  }
})

const incomingInviteCaller = computed(() => {
  const invite = incomingInvite.value
  if (!invite) return 'Someone'
  return chatStore.resolveDisplayName(invite.inviterUserId)
})

const incomingInviteConversationTitle = computed(() => incomingInviteConversation.value?.title ?? 'this conversation')

watch(incomingInvite, (invite) => {
  if (invite) {
    void soundEngine.startCallInviteRing()
    return
  }
  soundEngine.stopCallInviteRing()
}, { immediate: true })

const DEFAULT_STATUS_DURATION_MINUTES = 60

function statusDurationPart(value: unknown): number | null {
  if (value === '') return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) return null
  return parsed
}

function currentStatusDurationTotalMinutes(): number | null {
  const days = statusDurationPart(settingsStatusDurationDays.value)
  const hours = statusDurationPart(settingsStatusDurationHours.value)
  const minutes = statusDurationPart(settingsStatusDurationMinutes.value)
  if (days === null || hours === null || minutes === null) return null
  if (hours > 23 || minutes > 59) return null
  return days * 24 * 60 + hours * 60 + minutes
}

function setStatusDurationFromMinutes(totalMinutes: number) {
  const normalized = Math.max(1, Math.floor(totalMinutes))
  settingsStatusDurationDays.value = Math.floor(normalized / (24 * 60))
  const dayRemainder = normalized % (24 * 60)
  settingsStatusDurationHours.value = Math.floor(dayRemainder / 60)
  settingsStatusDurationMinutes.value = dayRemainder % 60
}

function resetStatusDuration() {
  setStatusDurationFromMinutes(DEFAULT_STATUS_DURATION_MINUTES)
}

function currentStatusExpiryIso(): string {
  const totalMinutes = currentStatusDurationTotalMinutes()
  if (totalMinutes === null || totalMinutes <= 0) return ''
  return new Date(Date.now() + totalMinutes * 60 * 1000).toISOString()
}

function currentStatusKey(): string {
  const text = settingsStatusText.value.trim()
  if (!text) return ''
  const totalMinutes = currentStatusDurationTotalMinutes()
  return JSON.stringify([
    text,
    settingsStatusEmoji.value.trim(),
    totalMinutes,
  ])
}

const hasStatusDraft = computed(() =>
  Boolean(settingsStatusText.value.trim() || settingsStatusEmoji.value.trim()),
)

const settingsStatusValidationError = computed(() => {
  if (!settingsStatusText.value.trim()) return ''
  const totalMinutes = currentStatusDurationTotalMinutes()
  if (totalMinutes === null) return 'Enter a valid status duration.'
  if (totalMinutes <= 0) return 'Status duration must be at least 1 minute.'
  return ''
})

const settingsStatusError = computed(() => settingsStatusValidationError.value || settingsStatusSaveError.value)
const settingsE2EEBusy = computed(() => settingsE2EEExporting.value || settingsE2EEImporting.value)
const canCreateE2EERecoveryPackage = computed(() =>
  settingsE2EEDeviceAvailable.value
  && settingsE2EEExportPassphrase.value.length > 0
  && settingsE2EEExportPassphrase.value === settingsE2EEExportPassphraseConfirmation.value,
)
const canRestoreE2EERecoveryPackage = computed(() =>
  settingsE2EEImportPackage.value.trim().length > 0
  && settingsE2EEImportPassphrase.value.length > 0,
)

const settingsPreviewCustomStatus = computed<UserCustomStatus | null>(() => {
  const text = settingsStatusText.value.trim()
  if (!text || settingsStatusValidationError.value) {
    return null
  }
  return {
    text,
    emoji: settingsStatusEmoji.value.trim(),
    expiresAt: currentStatusExpiryIso(),
  }
})

const canSaveSettings = computed(() => {
  const displayName = settingsDisplayName.value.trim()
  const email = settingsEmail.value.trim()
  const profileChanged = displayName !== settingsInitialDisplayName.value
    || email !== settingsInitialEmail.value
  const hasValue = !!displayName || !!email
  const statusChanged = currentStatusKey() !== settingsInitialCustomStatusKey.value
  const statusValid = !settingsStatusValidationError.value
  return (profileChanged && hasValue) || (statusChanged && statusValid)
})

async function handleLogout() {
  soundEngine.stopCallInviteRing()
  offlineQueue.clear()
  await logout()
  await router.push({ name: 'login' })
}

function handleClientFocus() {
  chatStore.setClientActive(true)
  chatStore.onClientFocus()
  reportClientWindowActivity(true)
}

function handleClientBlur() {
  chatStore.setClientActive(false)
  reportClientWindowActivity(false)
}

function handleVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    chatStore.setClientActive(false)
    reportClientWindowActivity(false)
    return
  }
  handleClientFocus()
}

function isWsActivitySignalReady(): boolean {
  return wsStore.state === 'AUTH_COMPLETE'
    || wsStore.state === 'BOOTSTRAPPING'
    || wsStore.state === 'LIVE_SYNCED'
    || wsStore.state === 'RECOVERING_GAP'
    || wsStore.state === 'STALE_REBOOTSTRAP'
}

function isChatWindowActive(): boolean {
  return document.visibilityState !== 'hidden' && document.hasFocus()
}

function reportClientWindowActivity(active: boolean) {
  if (!isWsActivitySignalReady()) return
  wsStore.sendSetClientWindowActivity(active)
}

function applyManualPresencePreference() {
  const preferred = loadManualPresencePreference()
  if (!preferred) return
  wsStore.sendSetPresence(preferred === 'away' ? PresenceStatus.AWAY : PresenceStatus.ONLINE)
}

function dismissInvite(inviteId: string) {
  dismissedInviteIds.value = Array.from(new Set([...dismissedInviteIds.value, inviteId]))
}

function conversationNotificationTitle(conversationId: string): string {
  const channel = chatStore.channels.find(item => item.id === conversationId)
  if (channel) return `#${channel.name}`
  const dm = chatStore.directMessages.find(item => item.id === conversationId)
  if (dm) return dm.displayName
  return 'Msgnr'
}

function toMessagePreview(event: IncomingMessageNotification): string {
  const body = event.body.trim().replace(/\s+/g, ' ')
  if (body) {
    return body.length > 160 ? `${body.slice(0, 157)}...` : body
  }
  if (event.attachmentCount > 0) {
    return event.attachmentCount === 1 ? 'Sent an attachment' : `Sent ${event.attachmentCount} attachments`
  }
  return 'New message'
}

function conversationNotificationBody(event: IncomingMessageNotification): string {
  const preview = toMessagePreview(event)
  const isChannelConversation = chatStore.channels.some(item => item.id === event.conversationId)
  if (isChannelConversation && event.senderName) {
    return `${event.senderName}: ${preview}`
  }
  return preview
}

function setStatusDraftFromStatus(status: UserCustomStatus | null) {
  if (isUserCustomStatusActive(status)) {
    settingsStatusText.value = status.text
    settingsStatusEmoji.value = status.emoji
    const remainingMinutes = Math.ceil((Date.parse(status.expiresAt) - Date.now()) / (60 * 1000))
    setStatusDurationFromMinutes(remainingMinutes)
  } else {
    settingsStatusText.value = ''
    settingsStatusEmoji.value = ''
    resetStatusDuration()
  }
  settingsInitialCustomStatusKey.value = currentStatusKey()
}

function clearStatusDraft() {
  settingsStatusText.value = ''
  settingsStatusEmoji.value = ''
  resetStatusDuration()
  settingsStatusSaveError.value = ''
  closeStatusEmojiPicker()
}

function clearE2EERecoveryForm() {
  e2eeRecoveryOperationGeneration += 1
  settingsE2EEExportPassphrase.value = ''
  settingsE2EEExportPassphraseConfirmation.value = ''
  settingsE2EERecoveryPackage.value = ''
  settingsE2EEImportPackage.value = ''
  settingsE2EEImportPassphrase.value = ''
  settingsE2EEReplacementConfirmationRequired.value = false
  settingsE2EEReplaceConfirmed.value = false
  settingsE2EERecoveryError.value = ''
  settingsE2EERecoverySuccess.value = ''
}

function clearE2EERecoveryPackage() {
  e2eeRecoveryOperationGeneration += 1
  settingsE2EERecoveryPackage.value = ''
  settingsE2EERecoveryError.value = ''
  settingsE2EERecoverySuccess.value = ''
}

function resetE2EERecoveryImportConfirmation() {
  e2eeRecoveryOperationGeneration += 1
  settingsE2EEReplacementConfirmationRequired.value = false
  settingsE2EEReplaceConfirmed.value = false
  settingsE2EERecoveryError.value = ''
  settingsE2EERecoverySuccess.value = ''
}

function recoveryErrorMessage(error: unknown): string {
  if (error instanceof E2EERecoveryError && error.code === 'unsupported') {
    return 'This recovery package uses an unsupported format.'
  }
  if (error instanceof E2EERecoveryError && error.code === 'unavailable') {
    return 'No encrypted-DM identity is available on this browser.'
  }
  return 'Could not unlock the recovery package. Check the passphrase and try again.'
}

async function createE2EERecoveryPackage() {
  if (!canCreateE2EERecoveryPackage.value || settingsE2EEExporting.value) return

  const operation = ++e2eeRecoveryOperationGeneration
  const passphrase = settingsE2EEExportPassphrase.value
  settingsE2EEExporting.value = true
  settingsE2EERecoveryError.value = ''
  settingsE2EERecoverySuccess.value = ''
  try {
    const recoveryPackage = await exportEncryptedDMRecoveryPackage(passphrase)
    if (operation !== e2eeRecoveryOperationGeneration) return
    settingsE2EERecoveryPackage.value = recoveryPackage
    settingsE2EEExportPassphrase.value = ''
    settingsE2EEExportPassphraseConfirmation.value = ''
    settingsE2EERecoverySuccess.value = 'Recovery package created.'
  } catch (error) {
    if (operation !== e2eeRecoveryOperationGeneration) return
    if (error instanceof E2EERecoveryError && error.code === 'unavailable') {
      settingsE2EEDeviceAvailable.value = false
    }
    settingsE2EERecoveryError.value = recoveryErrorMessage(error)
  } finally {
    settingsE2EEExporting.value = false
  }
}

async function copyE2EERecoveryPackage() {
  const recoveryPackage = settingsE2EERecoveryPackage.value
  if (!recoveryPackage) return

  settingsE2EERecoveryError.value = ''
  settingsE2EERecoverySuccess.value = ''
  try {
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      throw new Error('Clipboard unavailable')
    }
    await navigator.clipboard.writeText(recoveryPackage)
    settingsE2EERecoverySuccess.value = 'Recovery package copied.'
  } catch {
    settingsE2EERecoveryError.value = 'Clipboard access is unavailable. Copy the recovery package from the field.'
  }
}

async function restoreE2EERecoveryPackage() {
  if (!canRestoreE2EERecoveryPackage.value || settingsE2EEImporting.value) return

  const operation = ++e2eeRecoveryOperationGeneration
  const recoveryPackage = settingsE2EEImportPackage.value
  const passphrase = settingsE2EEImportPassphrase.value
  settingsE2EEImporting.value = true
  settingsE2EERecoveryError.value = ''
  settingsE2EERecoverySuccess.value = ''
  try {
    const prepared = await prepareEncryptedDMRecoveryImport(recoveryPackage, passphrase)
    if (operation !== e2eeRecoveryOperationGeneration) return

    const currentDeviceID = localEncryptedDMDeviceId()
    const replacingCurrentDevice = Boolean(currentDeviceID && currentDeviceID !== prepared.deviceId)
    if (replacingCurrentDevice && !settingsE2EEReplaceConfirmed.value) {
      settingsE2EEReplacementConfirmationRequired.value = true
      settingsE2EERecoveryError.value = 'Export this browser\'s current encrypted-DM identity before replacing it.'
      return
    }

    await activateE2EERecoveryDevice({
      ...prepared.registration,
      ...(replacingCurrentDevice ? { replace_device_id: currentDeviceID } : {}),
    })
    prepared.install()
    settingsE2EEDeviceAvailable.value = true
    await chatStore.reloadActiveEncryptedDMHistory()

    if (operation !== e2eeRecoveryOperationGeneration) return
    settingsE2EEExportPassphrase.value = ''
    settingsE2EEExportPassphraseConfirmation.value = ''
    settingsE2EERecoveryPackage.value = ''
    settingsE2EEImportPackage.value = ''
    settingsE2EEImportPassphrase.value = ''
    settingsE2EEReplacementConfirmationRequired.value = false
    settingsE2EEReplaceConfirmed.value = false
    settingsE2EERecoverySuccess.value = 'Encrypted-DM recovery completed.'
  } catch (error) {
    if (operation !== e2eeRecoveryOperationGeneration) return
    settingsE2EERecoveryError.value = error instanceof E2EERecoveryError
      ? recoveryErrorMessage(error)
      : 'Could not restore encrypted DMs. Check the package and try again.'
  } finally {
    settingsE2EEImporting.value = false
  }
}

function closeSettings() {
  if (settingsE2EEBusy.value) return
  settingsOpen.value = false
  settingsError.value = ''
  settingsAvatarError.value = ''
  settingsStatusSaveError.value = ''
  settingsNewPassword.value = ''
  settingsConfirmPassword.value = ''
  settingsPasswordError.value = ''
  settingsPasswordSuccess.value = ''
  clearE2EERecoveryForm()
  closeStatusEmojiPicker()
}

function setSettingsActiveTab(tab: ProfileSettingsTab) {
  if (settingsE2EEBusy.value) return
  if (tab !== 'security') {
    clearE2EERecoveryForm()
  } else {
    settingsE2EEDeviceAvailable.value = hasLocalEncryptedDMDevice()
  }
  settingsActiveTab.value = tab
  if (tab !== 'status') {
    closeStatusEmojiPicker()
  }
}

function syncSettingsFormFromUser() {
  const displayName = authStore.user?.displayName?.trim()
    || chatStore.workspace?.selfDisplayName?.trim()
  settingsDisplayName.value = displayName || authStore.user?.email?.trim() || ''
  settingsEmail.value = authStore.user?.email?.trim() || ''
  settingsInitialDisplayName.value = settingsDisplayName.value.trim()
  settingsInitialEmail.value = settingsEmail.value.trim()
  const selfUserId = authStore.user?.id ?? chatStore.workspace?.selfUserId ?? ''
  setStatusDraftFromStatus(
    authStore.user ? (authStore.user.customStatus ?? null) : chatStore.resolveUserCustomStatus(selfUserId),
  )
}

async function openSettings() {
  settingsError.value = ''
  settingsAvatarError.value = ''
  settingsStatusSaveError.value = ''
  settingsSuccess.value = ''
  settingsNewPassword.value = ''
  settingsConfirmPassword.value = ''
  settingsPasswordError.value = ''
  settingsPasswordSuccess.value = ''
  clearE2EERecoveryForm()
  try {
    await authStore.ensureUserLoaded()
  } catch (error) {
    settingsError.value = error instanceof Error ? error.message : 'Failed to load profile'
  }
  syncSettingsFormFromUser()
  settingsE2EEDeviceAvailable.value = hasLocalEncryptedDMDevice()
  settingsActiveTab.value = 'profile'
  settingsOpen.value = true
}

function openAudioSettings() {
  audioSettingsOpen.value = true
}

async function saveSettings() {
  if (!canSaveSettings.value || settingsLoading.value) return
  settingsLoading.value = true
  settingsError.value = ''
  settingsStatusSaveError.value = ''
  settingsSuccess.value = ''
  let savingStatus = false
  try {
    const displayName = settingsDisplayName.value.trim()
    const email = settingsEmail.value.trim()
    const profileChanged = displayName !== settingsInitialDisplayName.value
      || email !== settingsInitialEmail.value
    const statusChanged = currentStatusKey() !== settingsInitialCustomStatusKey.value
    let updated = authStore.user
    if (profileChanged) {
      updated = await authStore.updateProfile({
        display_name: displayName,
        email,
      })
    }
    savingStatus = true
    if (statusChanged) {
      if (settingsStatusText.value.trim()) {
        const expiresAt = currentStatusExpiryIso()
        if (!expiresAt) {
          throw new Error('Choose when the status should expire.')
        }
        updated = await authStore.setCustomStatus({
          text: settingsStatusText.value.trim(),
          emoji: settingsStatusEmoji.value.trim(),
          expires_at: expiresAt,
        })
      } else {
        updated = await authStore.clearCustomStatus()
      }
    }
    if (!updated) throw new Error('Failed to save settings')
    settingsSuccess.value = 'Profile updated'
    chatStore.registerUserIdentity(updated.id, updated.displayName, updated.email, updated.avatarUrl, updated.customStatus)
    settingsOpen.value = false
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to save settings'
    if (savingStatus) {
      settingsStatusSaveError.value = message
    } else {
      settingsError.value = message
    }
  } finally {
    settingsLoading.value = false
  }
}

function openProfileAvatarPicker() {
  profileAvatarInput.value?.click()
}

async function onProfileAvatarSelected(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return

  settingsAvatarLoading.value = true
  settingsAvatarError.value = ''
  settingsSuccess.value = ''
  try {
    const updated = await authStore.uploadAvatar(file)
    chatStore.registerUserIdentity(updated.id, updated.displayName, updated.email, updated.avatarUrl, updated.customStatus)
    settingsSuccess.value = 'Avatar updated'
  } catch (error) {
    settingsAvatarError.value = error instanceof Error ? error.message : 'Failed to upload avatar'
  } finally {
    settingsAvatarLoading.value = false
  }
}

async function removeProfileAvatar() {
  settingsAvatarLoading.value = true
  settingsAvatarError.value = ''
  settingsSuccess.value = ''
  try {
    const updated = await authStore.removeAvatar()
    chatStore.registerUserIdentity(updated.id, updated.displayName, updated.email, updated.avatarUrl, updated.customStatus)
    settingsSuccess.value = 'Avatar removed'
  } catch (error) {
    settingsAvatarError.value = error instanceof Error ? error.message : 'Failed to remove avatar'
  } finally {
    settingsAvatarLoading.value = false
  }
}

async function savePassword() {
  settingsPasswordError.value = ''
  settingsPasswordSuccess.value = ''
  if (!settingsNewPassword.value) {
    settingsPasswordError.value = 'Please enter a new password.'
    return
  }
  if (settingsNewPassword.value !== settingsConfirmPassword.value) {
    settingsPasswordError.value = 'Passwords do not match.'
    return
  }
  settingsPasswordLoading.value = true
  try {
    await authStore.changePassword(settingsNewPassword.value)
    settingsPasswordSuccess.value = 'Password changed successfully.'
    settingsNewPassword.value = ''
    settingsConfirmPassword.value = ''
  } catch (error) {
    settingsPasswordError.value = error instanceof Error ? error.message : 'Failed to change password.'
  } finally {
    settingsPasswordLoading.value = false
  }
}

async function acceptIncomingInvite() {
  const invite = incomingInvite.value
  const conversation = incomingInviteConversation.value
  if (!invite || !conversation) return
  handlingIncomingInvite.value = true
  incomingInviteError.value = ''
  let accepted = false
  try {
    await wsStore.requestAcceptCallInvite(invite.id, { leaveExistingCalls: true })
    accepted = true
    dismissInvite(invite.id)
    await callStore.startOrJoinCall({
      conversationId: invite.conversationId,
      kind: conversation.kind,
      visibility: conversation.visibility,
      joinExistingOnly: true,
    })
  } catch (err) {
    incomingInviteError.value = err instanceof Error ? err.message : 'Failed to join call'
    if (!accepted) {
      dismissedInviteIds.value = dismissedInviteIds.value.filter(item => item !== invite.id)
    }
  } finally {
    handlingIncomingInvite.value = false
  }
}

function rejectIncomingInvite() {
  const invite = incomingInvite.value
  if (!invite) return
  incomingInviteError.value = ''
  wsStore.sendRejectCallInvite(invite.id)
  dismissInvite(invite.id)
}

// Register WS→chat handlers once
chatStore.registerWsHandlers()
callStore.registerWsHandlers()

watch(() => chatStore.activeCalls, () => {
  callStore.syncWithActiveCalls()
}, { deep: true })

watch(() => chatStore.pendingInvites.map(item => item.id), (ids) => {
  dismissedInviteIds.value = dismissedInviteIds.value.filter(id => ids.includes(id))
  if (!ids.length) {
    incomingInviteError.value = ''
    handlingIncomingInvite.value = false
  }
})

// Register self in the user name cache
watch(() => authStore.user, (u) => {
  if (u) chatStore.registerUserIdentity(u.id, u.displayName, u.email, u.avatarUrl, u.customStatus)
  if (settingsOpen.value && u) {
    syncSettingsFormFromUser()
  }
}, { immediate: true })

watch(settingsOpen, (isOpen) => {
  if (isOpen) {
    syncSettingsFormFromUser()
  }
}, { immediate: true })

watch(() => authStore.authState, (state) => {
  if (state === 'ANON') {
    pinnedDialogsStore.clearAll()
  }
}, { immediate: true })

watch(
  [() => authStore.authState, () => wsStore.state, () => chatStore.bootstrapped],
  () => {
    void tryConsumeNotificationOpenIntent()
  },
  { immediate: true },
)

// Load channels once WS auth is complete (real data) and also on mount if
// already authenticated (page refresh scenario)
watch(() => wsStore.state, (state) => {
  if (state !== 'AUTH_COMPLETE') return
  reportClientWindowActivity(isChatWindowActive())
  chatStore.startRealtimeFlow()
  applyManualPresencePreference()
  // Re-validate push subscription if user had push enabled before.
  if (!isDesktopRuntime && pushSupported && loadPushEndpoint()) {
    checkPushSubscription().then(() => {
      // If the browser subscription was invalidated (SW update, etc.),
      // re-subscribe transparently — permission was already granted.
      if (!loadPushEndpoint()) {
        subscribePush().catch(() => {})
      }
    })
  }
})

function handleGlobalKeydown(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    openGlobalMessageSearch()
    return
  }
  if ((event.metaKey || event.ctrlKey) && event.key === 'd') {
    if (!callStore.activeCallId) return
    event.preventDefault()
    callStore.toggleMute().catch(() => {})
  }
}

onMounted(async () => {
  unsubscribeIncomingMessageSound = chatStore.onIncomingMessageNotification((event) => {
    const windowActive = isChatWindowActive()
    const shouldShowLocalNotification = platform?.type === 'tauri' || windowActive
    if (platform && shouldShowLocalNotification) {
      void platform.notifications.show({
        title: conversationNotificationTitle(event.conversationId),
        body: conversationNotificationBody(event),
        conversationId: event.conversationId,
        tag: `conv:${event.conversationId}`,
      })
    }
    if (platform?.type === 'tauri') {
      void platform.notifications.playSound?.('message-ping')
      return
    }

    void soundEngine.playMessagePing()
  })

  window.addEventListener('focus', handleClientFocus)
  window.addEventListener('blur', handleClientBlur)
  document.addEventListener('visibilitychange', handleVisibilityChange)
  document.addEventListener('keydown', handleGlobalKeydown)
  const active = isChatWindowActive()
  chatStore.setClientActive(active)
  if (active) {
    chatStore.onClientFocus()
  }

  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    serviceWorkerMessageHandler = (event: MessageEvent) => {
      queueNotificationOpenIntent(notificationOpenIntentFromMessage(event.data))
    }
    navigator.serviceWorker.addEventListener('message', serviceWorkerMessageHandler)
  }

  queueNotificationOpenIntent(notificationOpenIntentFromQuery(route.query as Record<string, unknown>))

  // Only kick off the realtime flow if already at AUTH_COMPLETE on mount
  // (e.g. page refresh with fast session restore). The watch() above handles
  // the AUTH_COMPLETE transition for connections that complete after mount.
  // Do NOT use authStore.accessToken here — having a token does not mean the
  // WS is authenticated; calling startRealtimeFlow() before AUTH_COMPLETE is a no-op
  // and would cause a double-call when the watch fires moments later.
  if (wsStore.state === 'AUTH_COMPLETE') {
    reportClientWindowActivity(active)
    chatStore.startRealtimeFlow()
  }
})

onUnmounted(() => {
  unsubscribeIncomingMessageSound?.()
  unsubscribeIncomingMessageSound = null
  // Keep singleton engine alive across remounts; only stop active playback.
  soundEngine.stopCallInviteRing()

  window.removeEventListener('focus', handleClientFocus)
  window.removeEventListener('blur', handleClientBlur)
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  document.removeEventListener('keydown', handleGlobalKeydown)
  if (serviceWorkerMessageHandler && typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.removeEventListener('message', serviceWorkerMessageHandler)
    serviceWorkerMessageHandler = null
  }
})
</script>
