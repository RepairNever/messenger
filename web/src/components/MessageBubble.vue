<template>
  <div
    class="relative flex gap-3 px-2 py-1 rounded group hover:bg-chat-msgHover transition-colors"
    :class="[
      showHeader ? 'mt-4' : 'mt-0.5',
      isActiveThread ? 'border-l-2 border-accent bg-accent/5' : '',
      message.sendStatus === 'failed' ? 'border-l-2 border-red-500/60' : '',
      message.sendStatus === 'queued' ? 'border-l-2 border-dashed border-gray-500/40' : '',
    ]"
  >
    <!-- Active thread indicator -->
    <div
      v-if="isActiveThread"
      class="absolute left-0 top-0 bottom-0 flex items-start pt-2 pl-1 text-accent text-[10px] font-bold select-none"
    >
      ▶
    </div>

    <!-- Avatar column -->
    <div class="w-9 shrink-0 pt-0.5" :class="isActiveThread ? 'ml-3' : ''">
      <UserAvatar
        v-if="showHeader"
        :user-id="message.senderId"
        :display-name="message.senderName"
        :avatar-url="message.senderAvatarUrl"
        :custom-status="null"
        size="lg"
      />
    </div>

    <!-- Content column -->
    <div class="flex-1 min-w-0">

      <!-- Header row: name + timestamp + hover actions -->
      <div v-if="showHeader" class="flex items-baseline gap-2 mb-0.5">
        <span
          v-if="senderStatus"
          class="inline-flex shrink-0 self-center text-lg leading-none"
          :title="senderStatusTitle"
          :aria-label="senderStatusTitle"
        >
          {{ senderStatus.emoji }}
        </span>
        <span class="font-bold text-white">{{ message.senderName }}</span>
        <span class="text-xs text-gray-500">{{ formattedTime }}</span>
        <span
          v-if="message.editedAt"
          data-testid="message-edited-marker"
          class="text-[11px] text-gray-500"
        >(edited)</span>
        <!-- Send status indicators -->
        <span v-if="message.sendStatus === 'sending'" class="inline-flex items-center gap-1 text-xs text-gray-500">
          <svg class="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3"/>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
          </svg>
          sending
        </span>
        <span v-else-if="message.sendStatus === 'queued'" class="inline-flex items-center gap-1 text-xs text-gray-500" title="Message queued — will send when connection is restored">
          <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10"/>
            <polyline points="12,6 12,12 16,14"/>
          </svg>
          queued
        </span>
        <span v-else-if="message.sendStatus === 'failed'" class="inline-flex items-center gap-1 text-xs text-red-400">
          <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          Not sent
        </span>

        <!-- Hover actions (right-aligned) -->
        <div class="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            v-if="canSaveMessage"
            data-testid="save-message-button"
            class="h-7 w-7 rounded flex items-center justify-center transition-colors"
            :class="message.isSaved ? 'text-cyan-300 hover:text-cyan-200 hover:bg-white/10' : 'text-gray-400 hover:text-gray-200 hover:bg-white/10'"
            :title="message.isSaved ? 'Unsave message' : 'Save message'"
            @click.stop="toggleSaved"
          >
            <svg class="w-4 h-4" :fill="message.isSaved ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path d="M19 21 12 17 5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
            </svg>
          </button>
          <!-- 🙂 Add reaction: hide when reactions already exist -->
          <button
            v-if="!hasReactions && showFirstReactionAction"
            data-testid="first-reaction-button"
            ref="pickerToggleButton"
            class="h-7 w-7 rounded flex items-center justify-center text-gray-400 hover:text-gray-200 hover:bg-white/10 transition-colors"
            title="Add reaction"
            @click.stop="togglePickerButton"
          >
            <span class="text-sm leading-none font-semibold">😎</span>
          </button>

          <!-- 💬 Reply in thread: hide when thread already has replies -->
          <button
            v-if="!threadReplyCount && showThreadAction && !isThreadReply"
            data-testid="new-thread-button"
            class="h-7 w-7 rounded flex items-center justify-center text-gray-400 hover:text-gray-200 hover:bg-white/10 transition-colors"
            title="Reply in thread"
            @click="$emit('openThread', message)"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
          </button>

          <!-- ⋯ More actions -->
          <button
            ref="contextMenuTrigger"
            class="h-7 w-7 rounded flex items-center justify-center text-gray-400 hover:text-gray-200 hover:bg-white/10 transition-colors"
            title="More actions"
            @click.stop="toggleContextMenu"
          >
            <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>
            </svg>
          </button>
        </div>
      </div>

      <!-- Hover actions for grouped messages (no header row) -->
      <div v-if="!showHeader" class="absolute right-2 top-0.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          v-if="canSaveMessage"
          data-testid="save-message-button"
          class="h-7 w-7 rounded flex items-center justify-center transition-colors"
          :class="message.isSaved ? 'text-cyan-300 hover:text-cyan-200 hover:bg-white/10' : 'text-gray-400 hover:text-gray-200 hover:bg-white/10'"
          :title="message.isSaved ? 'Unsave message' : 'Save message'"
          @click.stop="toggleSaved"
        >
          <svg class="w-4 h-4" :fill="message.isSaved ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path d="M19 21 12 17 5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
          </svg>
        </button>
        <button
          v-if="!hasReactions && showFirstReactionAction"
          data-testid="first-reaction-button"
          ref="pickerToggleButton"
          class="h-7 w-7 rounded flex items-center justify-center text-gray-400 hover:text-gray-200 hover:bg-white/10 transition-colors"
          title="Add reaction"
          @click.stop="togglePickerButton"
        >
          <span class="text-sm leading-none font-semibold">😎</span>
        </button>
        <button
          v-if="!threadReplyCount && showThreadAction && !isThreadReply"
          data-testid="new-thread-button"
          class="h-7 w-7 rounded flex items-center justify-center text-gray-400 hover:text-gray-200 hover:bg-white/10 transition-colors"
          title="Reply in thread"
          @click="$emit('openThread', message)"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
        </button>
        <!-- ⋯ More actions -->
        <button
          ref="contextMenuTrigger"
          class="h-7 w-7 rounded flex items-center justify-center text-gray-400 hover:text-gray-200 hover:bg-white/10 transition-colors"
          title="More actions"
          @click.stop="toggleContextMenu"
        >
          <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
            <circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>
          </svg>
        </button>
      </div>

      <!-- Send status for grouped messages (no header row) -->
      <div v-if="!showHeader && message.sendStatus" class="mb-0.5 flex items-center gap-1">
        <span v-if="message.sendStatus === 'sending'" class="inline-flex items-center gap-1 text-xs text-gray-500">
          <svg class="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3"/>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
          </svg>
          sending
        </span>
        <span v-else-if="message.sendStatus === 'queued'" class="inline-flex items-center gap-1 text-xs text-gray-500" title="Message queued — will send when connection is restored">
          <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10"/>
            <polyline points="12,6 12,12 16,14"/>
          </svg>
          queued
        </span>
        <span v-else-if="message.sendStatus === 'failed'" class="inline-flex items-center gap-1 text-xs text-red-400">
          <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          Not sent
        </span>
      </div>

      <!-- Message body -->
      <div v-if="isEditing" class="mt-1">
        <RichTextComposer
          ref="editComposer"
          v-model="editBody"
          v-model:entities="editEntities"
          data-testid="message-edit-textarea"
          class="rounded border border-white/10 bg-chat-input px-2.5 py-2"
          :conversation-id="message.channelId"
          :enable-message-entities="true"
          :disabled="editSaving"
          :submit-on-enter="true"
          @resize="handleEditComposerResize"
          @pending-task-url-paste-change="editPendingTaskUrlPaste = $event"
          @submit="saveEdit"
        />
        <div class="mt-1.5 flex items-center justify-between gap-2">
          <span class="text-[11px] text-gray-500">Enter saves in plain text · Shift+Enter newline · Ctrl/Cmd+Enter save anywhere · Esc cancel</span>
          <span v-if="editError" class="text-xs text-red-300">{{ editError }}</span>
        </div>
      </div>

      <template v-else>
        <div
          v-if="message.forwardedFrom"
          data-testid="message-forwarded-banner"
          class="mb-1 inline-flex max-w-full items-center gap-1 rounded border border-chat-border bg-chat-input/70 px-2 py-0.5 text-[11px] text-app-muted"
          :title="formatForwardedMessageLabel(message.forwardedFrom)"
        >
          <svg class="h-3 w-3 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path d="M15 17h5l-5 5v-5z" />
            <path d="M4 4h7a4 4 0 0 1 4 4v9" />
          </svg>
          <span class="truncate">{{ formatForwardedMessageLabel(message.forwardedFrom) }}</span>
        </div>
        <div
          v-if="message.body"
          class="markdown-body"
          :class="bodyTextClass"
          v-html="renderedMessageHtml"
          @click="onMarkdownClick"
        ></div>
        <p
          v-if="!showHeader && message.editedAt"
          data-testid="message-edited-marker"
          class="mt-0.5 text-[11px] text-gray-500"
        >(edited)</p>
      </template>

      <!-- Failed message actions -->
      <div v-if="message.sendStatus === 'failed'" class="mt-1 flex items-center gap-2">
        <span v-if="message.failReason" class="text-xs text-red-400/80">{{ message.failReason }}</span>
        <button
          class="text-xs text-accent hover:text-accent-hover hover:underline transition-colors"
          @click="handleRetry"
        >Retry</button>
        <button
          class="text-xs text-gray-500 hover:text-gray-400 hover:underline transition-colors"
          @click="handleDiscard"
        >Delete</button>
      </div>

      <div v-if="messageAttachments.length > 0" class="mt-2 space-y-2">
        <div
          v-for="attachment in messageAttachments"
          :key="attachment.id"
          :class="isInlinePreviewAttachment(attachment) ? '' : 'rounded-md border border-chat-border bg-chat-input/70 p-2'"
        >
          <div
            v-if="isImageAttachment(attachment)"
            :ref="element => setImagePreviewTarget(attachment, element)"
            :data-message-image-attachment-id="attachment.id"
            class="group/image relative w-fit"
          >
            <button
              data-testid="message-image-thumbnail"
              class="block max-h-[min(38vh,220px)] max-w-[min(72vw,280px)] overflow-hidden rounded-lg bg-chat-input/60 shadow-sm transition-colors hover:bg-chat-input/80 sm:max-w-[min(42vw,360px)] cursor-pointer"
              @click="openMediaPreview(attachment)"
            >
              <img
                v-if="attachmentUrl(attachment)"
                data-testid="message-image-thumbnail-img"
                :src="attachmentUrl(attachment)"
                :alt="attachment.fileName"
                class="max-h-[min(38vh,220px)] w-full object-contain"
              >
              <div v-else class="flex h-24 items-center justify-center text-xs text-gray-500">
                {{ imagePreviewState(attachment) === 'failed' ? 'Preview unavailable' : 'Loading image...' }}
              </div>
            </button>
            <button
              class="absolute right-2 top-2 rounded-md border border-white/20 bg-black/55 p-1 text-white/90 opacity-0 transition-opacity group-hover/image:opacity-100 hover:bg-black/75 hover:text-white"
              title="Download"
              @click.stop="downloadAttachment(attachment)"
            >
              <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7,10 12,15 17,10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </button>
          </div>

          <div
            v-else-if="isVideoAttachment(attachment)"
            :ref="element => setAttachmentPreviewTarget(attachment, element)"
            :data-message-media-attachment-id="attachment.id"
            class="group/video relative w-fit"
          >
            <button
              v-if="attachmentUrl(attachment)"
              data-testid="message-video-thumbnail"
              class="relative block max-h-[min(42vh,260px)] max-w-[min(76vw,420px)] overflow-hidden rounded-lg border border-chat-border/70 bg-black/50 shadow-sm transition-colors hover:border-white/20 sm:max-w-[min(46vw,520px)] cursor-pointer"
              @click="openMediaPreview(attachment)"
            >
              <video
                data-testid="message-video-thumbnail-video"
                class="max-h-[min(42vh,260px)] w-full object-contain"
                preload="metadata"
                :src="attachmentUrl(attachment)"
              />
              <span
                data-testid="message-video-play-overlay"
                aria-hidden="true"
                class="pointer-events-none absolute inset-0 flex items-center justify-center"
              >
                <span class="flex h-12 w-12 items-center justify-center rounded-full border border-white/25 bg-black/55 text-white shadow-lg">
                  <svg class="ml-0.5 h-6 w-6" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5.14v13.72a1 1 0 0 0 1.51.86l10.8-6.86a1 1 0 0 0 0-1.72L9.51 4.28A1 1 0 0 0 8 5.14Z" />
                  </svg>
                </span>
              </span>
            </button>
            <button
              v-else
              type="button"
              data-testid="message-video-load"
              class="rounded-md border border-chat-border bg-chat-input/70 p-2 text-[11px] text-gray-400 transition-colors hover:bg-chat-input hover:text-gray-200"
              @click="openMediaPreview(attachment)"
            >
              {{ loadingAttachmentIds.has(attachment.id) ? 'Loading video...' : 'Load video preview' }}
            </button>
            <button
              class="absolute right-2 top-2 rounded-md border border-white/20 bg-black/55 p-1 text-white/90 opacity-0 transition-opacity group-hover/video:opacity-100 hover:bg-black/75 hover:text-white"
              title="Download"
              @click.stop="downloadAttachment(attachment)"
            >
              <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7,10 12,15 17,10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </button>
          </div>

          <template v-else>
            <div class="mb-1 flex items-center justify-between gap-2">
              <p class="truncate text-xs text-gray-300">{{ attachment.fileName }}</p>
              <button
                class="rounded p-1 text-gray-400 hover:bg-white/10 hover:text-white"
                title="Download"
                @click="downloadAttachment(attachment)"
              >
                <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7,10 12,15 17,10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
              </button>
            </div>

            <div
              v-if="isAudioAttachment(attachment)"
              :ref="element => setAttachmentPreviewTarget(attachment, element)"
              :data-message-media-attachment-id="attachment.id"
            >
              <audio
                v-if="attachmentUrl(attachment)"
                class="w-full"
                controls
                preload="metadata"
                :src="attachmentUrl(attachment)"
              />
              <button
                v-else
                type="button"
                data-testid="message-audio-load"
                class="text-left text-[11px] text-gray-400 transition-colors hover:text-gray-200 hover:underline"
                @click="loadAudioPreview(attachment)"
              >
                {{ loadingAttachmentIds.has(attachment.id) ? 'Loading audio...' : 'Load audio' }}
              </button>
            </div>

            <p v-else class="text-[11px] text-gray-500">
              {{ formatFileSize(attachment.fileSize) }}
            </p>
          </template>
        </div>
      </div>

      <!-- Thread indicator (Section 4) -->
      <button
        v-if="threadReplyCount > 0 && showThreadAction && !isThreadReply"
        data-testid="thread-action-button"
        class="mt-1.5 flex items-center gap-2 text-[13px] text-accent hover:text-accent-hover hover:underline transition-colors"
        @click="$emit('openThread', message)"
      >
        <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        <span class="font-medium">{{ threadReplyCount }} {{ threadReplyCount === 1 ? 'reply' : 'replies' }}</span>
        <span v-if="lastReplyAtLabel" class="text-gray-500 font-normal">Last reply {{ lastReplyAtLabel }}</span>
      </button>

      <!-- Reactions row (Section 3) -->
      <div v-if="hasReactions" class="mt-1.5 flex flex-wrap items-center gap-1">
        <button
          v-for="r in message.reactions"
          :key="r.emoji"
          data-testid="reaction-chip"
          class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-sm border transition-colors"
          :class="reactionChipClass(r.emoji)"
          :title="`${r.count} ${r.count === 1 ? 'reaction' : 'reactions'}`"
          :disabled="chat.isReactionOpPending(message.channelId, message.id, r.emoji)"
          @mouseenter="onReactionChipMouseEnter($event, r.emoji)"
          @mouseleave="onReactionChipMouseLeave(r.emoji)"
          @click="toggleReaction(r.emoji)"
        >
          <span class="text-lg leading-none">{{ r.emoji }}</span>
          <span class="font-medium">{{ r.count }}</span>
        </button>

        <!-- Add reaction button (visible when reactions exist) -->
        <div class="relative inline-flex">
          <button
            ref="pickerToggleButton"
            class="inline-flex items-center justify-center w-7 h-7 rounded-full text-xs border border-chat-border bg-transparent text-app-secondaryText hover:text-app-text hover:bg-chat-msgHover transition-colors opacity-0 group-hover:opacity-100"
            title="Add reaction"
            @click.stop="togglePickerButton"
          >
            <span class="text-sm leading-none font-semibold">+</span>
          </button>
        </div>
      </div>

    </div>
  </div>

  <Teleport to="body">
    <div
      v-if="showEmojiPicker"
      ref="emojiPickerRoot"
      class="z-20 emoji-picker-dark"
      :style="emojiPickerStyle"
      @click.stop
    >
      <component
        :is="pickerComponent"
        v-if="pickerComponent && emojiIndex"
        :data="emojiIndex"
        :native="true"
        set="apple"
        title="Add reaction"
        emoji="slightly_smiling_face"
        :show-preview="true"
        :show-skin-tones="false"
        :infinite-scroll="true"
        :emoji-size="26"
        :per-line="9"
        :color="emojiPickerAccentColor"
        @select="onSelectEmoji"
        @selected="onSelectEmoji"
      />
      <div
        v-else
        class="rounded-md border border-chat-border bg-chat-header px-3 py-2 text-xs text-app-muted shadow-xl"
      >
        Loading emoji...
      </div>
    </div>
  </Teleport>

  <Teleport to="body">
    <div
      v-if="reactionPopupVisible"
      ref="reactionUsersPopupRoot"
      data-testid="reaction-users-popup"
      class="fixed z-[10000] overflow-hidden rounded-md border border-white/10 bg-sidebar-bg shadow-xl"
      :style="reactionUsersPopupStyle"
      @mouseenter="onReactionPopupMouseEnter"
      @mouseleave="onReactionPopupMouseLeave"
    >
      <div class="max-h-72 overflow-y-auto p-1">
        <div
          v-if="reactionUsersLoading"
          data-testid="reaction-users-loading"
          class="px-2 py-1.5 text-xs text-gray-400"
        >
          Loading users...
        </div>
        <div
          v-else-if="reactionUsersError"
          data-testid="reaction-users-error"
          class="px-2 py-1.5 text-xs text-red-300"
        >
          {{ reactionUsersError }}
        </div>
        <div
          v-else-if="activeReactionUsers.length === 0"
          class="px-2 py-1.5 text-xs text-gray-400"
        >
          No reactions yet
        </div>
        <div v-else class="space-y-0.5">
          <div
            v-for="user in activeReactionUsers"
            :key="`${user.user_id}-${activeReactionEmoji}`"
            class="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-white/5"
          >
            <UserAvatar
              :user-id="user.user_id"
              :display-name="user.display_name"
              :avatar-url="user.avatar_url"
              size="xs"
            />
            <span class="truncate text-xs text-gray-200">{{ user.display_name }}</span>
          </div>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- Context menu — teleported to <body> to escape all overflow/clip contexts -->
  <Teleport to="body">
    <div
      v-if="showContextMenu"
      class="fixed z-[9999] min-w-[160px] rounded border border-white/10 bg-sidebar-bg shadow-xl py-1"
      :style="contextMenuStyle"
      @click.stop
    >
      <button
        v-if="canModifyMessage"
        data-testid="message-menu-edit"
        class="w-full text-left px-3 py-1.5 text-sm text-gray-200 hover:bg-white/10 transition-colors"
        :disabled="isDeleting"
        @click="startEdit"
      >
        Edit message
      </button>
      <button
        v-if="canDeleteMessage"
        data-testid="message-menu-delete"
        class="w-full text-left px-3 py-1.5 text-sm text-red-300 hover:bg-red-500/20 transition-colors"
        :disabled="isDeleting"
        @click="deleteCurrentMessage"
      >
        Delete message
      </button>
      <button
        v-if="canForwardMessage"
        data-testid="message-menu-forward"
        class="w-full text-left px-3 py-1.5 text-sm text-gray-200 hover:bg-white/10 transition-colors"
        :disabled="isDeleting"
        @click="openForwardDialog"
      >
        Forward message
      </button>
      <button
        class="w-full text-left px-3 py-1.5 text-sm text-gray-200 hover:bg-white/10 transition-colors"
        :disabled="isDeleting"
        @click="copyMessage"
      >
        Copy message
      </button>
    </div>
  </Teleport>

  <ForwardMessageDialog
    :open="forwardDialogOpen"
    :message="message"
    @close="forwardDialogOpen = false"
  />

  <Teleport to="body">
    <div
      v-if="mediaPreview.open"
      :data-testid="mediaPreview.kind === 'video' ? 'message-video-lightbox' : 'message-image-lightbox'"
      class="fixed inset-0 z-[10000] flex items-center justify-center bg-black/85 p-4 sm:p-6"
      @click.self="closeMediaPreview"
    >
      <div class="relative max-h-[calc(100vh-2rem)] max-w-[calc(100vw-2rem)] rounded-xl bg-black/20 p-2 shadow-xl sm:max-h-[calc(100vh-3rem)] sm:max-w-[calc(100vw-3rem)] sm:p-3">
        <button
          :data-testid="mediaPreview.kind === 'video' ? 'message-video-lightbox-close' : 'message-image-lightbox-close'"
          class="absolute right-2 top-2 rounded-md border border-white/20 bg-black/55 p-1.5 text-white/90 transition-colors hover:bg-black/75 hover:text-white"
          @click="closeMediaPreview"
        >
          <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
        <img
          v-if="mediaPreview.kind === 'image' && mediaPreview.src"
          data-testid="message-image-lightbox-img"
          :src="mediaPreview.src"
          :alt="mediaPreview.fileName"
          class="max-h-[calc(100vh-5rem)] max-w-[calc(100vw-5rem)] rounded-lg object-contain sm:max-h-[calc(100vh-6rem)] sm:max-w-[calc(100vw-6rem)]"
        >
        <video
          v-else-if="mediaPreview.kind === 'video' && mediaPreview.src"
          data-testid="message-video-lightbox-video"
          class="max-h-[calc(100vh-5rem)] max-w-[calc(100vw-5rem)] rounded-lg bg-black object-contain sm:max-h-[calc(100vh-6rem)] sm:max-w-[calc(100vw-6rem)]"
          controls
          autoplay
          preload="metadata"
          :src="mediaPreview.src"
        >
          Sorry, your browser does not support embedded videos.
        </video>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount, onMounted, shallowRef, nextTick, type ComponentPublicInstance, type PropType } from 'vue'
import type { Message, MessageAttachment } from '@/stores/chat'
import { useWsStore } from '@/stores/ws'
import { useChatStore } from '@/stores/chat'
import { useAuthStore } from '@/stores/auth'
import { useColorTheme } from '@/composables/useColorTheme'
import { NotificationLevel } from '@/shared/proto/packets_pb'
import router from '@/router'
import { generateId } from '@/services/id'
import { handleMarkdownLinkClick } from '@/utils/linkNavigation'
import {
  createOrOpenDm,
  fetchMessageAttachmentBlob,
  fetchMessageAttachmentThumbnailBlob,
  listMessageReactionUsers,
  editMessage as editMessageApi,
  deleteMessage as deleteMessageApi,
} from '@/services/http/chatApi'
import {
  enqueueChatMediaRequest,
  isChatMediaRequestCancelled,
  type ChatMediaRequestPriority,
  type QueuedChatMediaRequest,
} from '@/services/chatMediaQueue'
import UserAvatar from './UserAvatar.vue'
import ForwardMessageDialog from './ForwardMessageDialog.vue'
import { activeEmojiPickerId, createEmojiPickerInstanceId } from '@/stores/emojiPicker'
import { renderMessageBodyWithEntities } from '@/utils/renderMessageEntities'
import { formatForwardedMessageLabel } from '@/utils/forwardedMessages'
import RichTextComposer from './RichTextComposer.vue'
import {
  formatUserCustomStatusTitle,
  isUserCustomStatusActive,
  userCustomStatusFromDto,
} from '@/types/userStatus'

const props = defineProps({
  message: {
    type: Object as PropType<Message>,
    required: true,
  },
  showHeader: {
    type: Boolean,
    required: true,
  },
  threadReplyCount: {
    type: Number,
    default: 0,
  },
  showThreadAction: {
    type: Boolean,
    default: true,
  },
  showFirstReactionAction: {
    type: Boolean as PropType<boolean | undefined>,
    default: undefined,
  },
  isActiveThread: {
    type: Boolean,
    default: false,
  },
  editRequestToken: {
    type: Number,
    default: 0,
  },
})

const emit = defineEmits<{
  openThread: [message: Message]
  'edit-open': [messageId: string]
  'edit-close': [messageId: string]
  'edit-resize': [messageId: string, deltaPx: number]
}>()

const showEmojiPicker = ref(false)
const showContextMenu = ref(false)
const contextMenuStyle = ref<{ top: string; left: string }>({ top: '0px', left: '0px' })
const emojiPickerRoot = ref<HTMLElement | null>(null)
const pickerToggleButton = ref<HTMLElement | null>(null)
const contextMenuTrigger = ref<HTMLElement | null>(null)
const pickerComponent = shallowRef<any>(null)
const emojiIndex = shallowRef<any>(null)
const emojiPickerLoading = ref(false)
const emojiPickerStyle = ref<Record<string, string>>({
  position: 'fixed',
  top: '8px',
  left: '8px',
  width: '340px',
})
interface ReactionUserItem {
  user_id: string
  display_name: string
  avatar_url: string
}
const reactionUsersPopupStyle = ref<Record<string, string>>({
  position: 'fixed',
  top: '8px',
  left: '8px',
  width: '260px',
})
const reactionUsersPopupRoot = ref<HTMLElement | null>(null)
const activeReactionEmoji = ref<string | null>(null)
const activeReactionTrigger = ref<HTMLElement | null>(null)
const reactionUsersLoading = ref(false)
const reactionUsersError = ref('')
const reactionUsersCache = ref<Record<string, ReactionUserItem[]>>({})
const reactionCountsSnapshot = ref<Record<string, number>>({})
const reactionTriggerHovered = ref(false)
const reactionPopupHovered = ref(false)
let reactionPopupCloseTimer: ReturnType<typeof setTimeout> | null = null
let reactionUsersFetchToken = 0
const instanceId = createEmojiPickerInstanceId()
const EMOJI_PICKER_WIDTH = 340
const EMOJI_PICKER_HEIGHT = 380
const EMOJI_PICKER_GAP = 8
const EMOJI_PICKER_EDGE_PADDING = 8
const REACTION_USERS_POPUP_WIDTH = 260
const REACTION_USERS_POPUP_MAX_HEIGHT = 288
const REACTION_USERS_POPUP_GAP = 8
const attachmentUrls = ref<Record<string, string>>({})
const originalImageUrls = ref<Record<string, string>>({})
const loadingAttachmentIds = ref(new Set<string>())
type ImagePreviewLoadState = 'idle' | 'loading' | 'loaded' | 'failed'

interface PendingImageBlobLoad {
  attachmentId: string
  request: QueuedChatMediaRequest<Blob>
  promise: Promise<Blob>
}

const imagePreviewStates = ref<Record<string, ImagePreviewLoadState>>({})
const imagePreviewLoads = new Map<string, Promise<string>>()
const originalImageLoads = new Map<string, Promise<string>>()
const attachmentPreviewLoads = new Map<string, Promise<string>>()
const pendingImageBlobLoads = new Map<string, PendingImageBlobLoad>()
const imagePreviewTargets = new Map<string, HTMLElement>()
let imagePreviewObserver: IntersectionObserver | null = null
let imagePreviewObserverStarted = false
const attachmentPreviewTargets = new Map<string, HTMLElement>()
let attachmentPreviewObserver: IntersectionObserver | null = null
let attachmentPreviewObserverStarted = false
let mediaLifecycleActive = true

const mediaPreview = ref<{
  open: boolean
  kind: 'image' | 'video'
  src: string
  fileName: string
  attachmentId?: string
}>({
  open: false,
  kind: 'image',
  src: '',
  fileName: '',
})
const isEditing = ref(false)
const editBody = ref('')
const editEntities = ref<NonNullable<Message['entities']>>([])
const editSaving = ref(false)
const editPendingTaskUrlPaste = ref(false)
const editError = ref('')
const editComposer = ref<InstanceType<typeof RichTextComposer> | null>(null)
const editTagPickerOpen = ref(false)
const isDeleting = ref(false)
const forwardDialogOpen = ref(false)
const ws = useWsStore()
const chat = useChatStore()
const auth = useAuthStore()
const { currentTheme } = useColorTheme()
const DEBUG_REACTIONS = false

function debugReaction(label: string, payload?: unknown) {
  if (!DEBUG_REACTIONS) return
  if (typeof payload === 'undefined') {
    console.debug(`[reactions] ${label}`)
    return
  }
  console.debug(`[reactions] ${label}`, payload)
}

const formattedTime = computed(() => {
  const d = new Date(props.message.createdAt)
  return d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
})

const senderStatus = computed(() => {
  const status = chat.resolveUserCustomStatus(props.message.senderId)
  return isUserCustomStatusActive(status) && status.emoji.trim() ? status : null
})

const senderStatusTitle = computed(() =>
  senderStatus.value ? formatUserCustomStatusTitle(senderStatus.value) : '',
)

const isEncryptedMessage = computed(() => props.message.contentMode === 'dm_pairwise_signal_v1')
const hasReactions = computed(() => !isEncryptedMessage.value && props.message.reactions.length > 0)
const emojiPickerAccentColor = computed(() => currentTheme.value.tokens.accent)
const reactionPopupVisible = computed(() => Boolean(activeReactionEmoji.value))
const activeReactionUsers = computed(() => {
  const emoji = activeReactionEmoji.value
  if (!emoji) return [] as ReactionUserItem[]
  return reactionUsersCache.value[emoji] ?? []
})

const isThreadReply = computed(() => {
  const rootId = props.message.threadRootMessageId
  return Boolean(rootId && rootId !== props.message.id)
})
const canSaveMessage = computed(() => !props.message.sendStatus && !props.message.pending)

const showThreadAction = computed(() => {
  if (isEncryptedMessage.value) return false
  if (props.showThreadAction === false) return false
  return !isThreadReply.value
})
const showFirstReactionAction = computed(() => {
  if (isEncryptedMessage.value) return false
  if (typeof props.showFirstReactionAction === 'boolean') {
    return props.showFirstReactionAction
  }
  return showThreadAction.value
})
const messageAttachments = computed(() => props.message.attachments ?? [])
const selfUserId = computed(() => auth.user?.id || chat.workspace?.selfUserId || '')
const isOwnMessage = computed(() => Boolean(selfUserId.value) && props.message.senderId === selfUserId.value)
const isServerConfirmed = computed(() => !props.message.sendStatus && !props.message.pending)
const canModifyMessage = computed(() => isOwnMessage.value && isServerConfirmed.value && !isEncryptedMessage.value)
const isSecretConversation = computed(() => isEncryptedMessage.value || chat.directMessages.some(
  dm => dm.id === props.message.channelId && dm.encryptionMode === 'dm_pairwise_signal_v1',
))
const canDeleteMessage = computed(() => Boolean(selfUserId.value) && isServerConfirmed.value && (isOwnMessage.value || isSecretConversation.value))
const canForwardMessage = computed(() => isServerConfirmed.value && !isEncryptedMessage.value)
const canSaveEdit = computed(() =>
  !editSaving.value
  && !editPendingTaskUrlPaste.value
  && (editBody.value.trim().length > 0 || messageAttachments.value.length > 0),
)

const lastReplyAtLabel = computed(() => {
  const summary = chat.threadSummaries[props.message.id]
  if (!summary?.lastReplyAt) return null
  return relativeTime(summary.lastReplyAt)
})

function relativeTime(isoString: string): string {
  const diffMs = Date.now() - new Date(isoString).getTime()
  const diffSec = Math.floor(diffMs / 1000)
  if (diffSec < 60) return 'just now'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24) return `${diffH}h ago`
  const diffD = Math.floor(diffH / 24)
  return `${diffD}d ago`
}

const bodyTextClass = computed(() => {
  switch (props.message.sendStatus) {
    case 'sending': return 'text-gray-300 opacity-90'
    case 'queued': return 'text-gray-300 opacity-80'
    case 'failed': return 'text-gray-300 opacity-75'
    default: return props.message.pending ? 'text-gray-400' : 'text-gray-300'
  }
})

const renderedMessageHtml = computed(() => {
  if (!props.message.body) return ''
  return renderMessageBodyWithEntities(props.message.body, props.message.entities ?? [])
})

async function openDirectMessageFromUserMention(userId: string) {
  if (!userId.trim()) return

  const dm = await createOrOpenDm(userId)
  chat.openDirectMessage({
    id: dm.conversation_id,
    userId: dm.user_id,
    displayName: dm.display_name || dm.email,
    avatarUrl: dm.avatar_url,
    customStatus: userCustomStatusFromDto(dm.custom_status),
    presence: 'offline',
    unread: 0,
    notificationLevel: NotificationLevel.ALL,
  })

  if (router.currentRoute.value.name !== 'main') {
    await router.push({ name: 'main' })
  }
}

function onMarkdownClick(event: MouseEvent) {
  const target = event.target
  if (target instanceof HTMLElement) {
    const entityNode = target.closest('[data-message-entity-kind="user"][data-target-id]')
    if (entityNode instanceof HTMLElement) {
      event.preventDefault()
      const targetId = entityNode.getAttribute('data-target-id') ?? ''
      void openDirectMessageFromUserMention(targetId)
      return
    }
  }
  handleMarkdownLinkClick(event, router)
}

function closeEditTagPicker() {
  editTagPickerOpen.value = false
}

function openForwardDialog() {
  if (!canForwardMessage.value) return
  showContextMenu.value = false
  forwardDialogOpen.value = true
}

// ── Send status actions ──────────────────────────────────────────────────────

function handleRetry() {
  const msg = props.message
  if (!msg.clientMsgId || msg.sendStatus !== 'failed') return
  const isThread = Boolean(msg.threadRootMessageId && msg.threadRootMessageId !== msg.id)
  if (isThread && msg.threadRootMessageId) {
    chat.retryThreadMessage(msg.threadRootMessageId, msg.clientMsgId)
  } else {
    chat.retryMessage(msg.channelId, msg.clientMsgId)
  }
}

function handleDiscard() {
  const msg = props.message
  if (!msg.clientMsgId || msg.sendStatus !== 'failed') return
  const isThread = Boolean(msg.threadRootMessageId && msg.threadRootMessageId !== msg.id)
  if (isThread && msg.threadRootMessageId) {
    chat.discardFailedThreadMessage(msg.threadRootMessageId, msg.clientMsgId)
  } else {
    chat.discardFailedMessage(msg.channelId, msg.clientMsgId)
  }
}

// ── Attachments ───────────────────────────────────────────────────────────────

function isImageAttachment(attachment: MessageAttachment): boolean {
  return attachment.mimeType.startsWith('image/')
}

function isVideoAttachment(attachment: MessageAttachment): boolean {
  return attachment.mimeType.startsWith('video/')
}

function isAudioAttachment(attachment: MessageAttachment): boolean {
  return attachment.mimeType.startsWith('audio/')
}

function isInlinePreviewAttachment(attachment: MessageAttachment): boolean {
  return isImageAttachment(attachment) || isVideoAttachment(attachment)
}

function attachmentUrl(attachment: MessageAttachment): string {
  return attachmentUrls.value[attachment.id] ?? originalImageUrls.value[attachment.id] ?? ''
}

function setAttachmentUrl(
  urls: typeof attachmentUrls,
  attachmentId: string,
  blob: Blob,
): string {
  const url = URL.createObjectURL(blob)
  if (!mediaLifecycleActive || !messageAttachments.value.some(item => item.id === attachmentId)) {
    URL.revokeObjectURL(url)
    return ''
  }

  const previous = urls.value[attachmentId]
  if (previous && previous !== url) {
    URL.revokeObjectURL(previous)
  }
  urls.value = {
    ...urls.value,
    [attachmentId]: url,
  }
  return url
}

function revokeAttachmentUrl(urls: typeof attachmentUrls, attachmentId: string) {
  const url = urls.value[attachmentId]
  if (!url) return
  URL.revokeObjectURL(url)
  const { [attachmentId]: _removed, ...remaining } = urls.value
  urls.value = remaining
}

function syncAttachmentUrls() {
  const currentIds = new Set(messageAttachments.value.map(item => item.id))
  for (const id of Object.keys(attachmentUrls.value)) {
    if (!currentIds.has(id)) {
      cancelMediaLoads(id)
      revokeAttachmentUrl(attachmentUrls, id)
    }
  }
  for (const id of Object.keys(originalImageUrls.value)) {
    if (!currentIds.has(id)) {
      cancelMediaLoads(id)
      revokeAttachmentUrl(originalImageUrls, id)
    }
  }
  for (const id of Object.keys(imagePreviewStates.value)) {
    if (!currentIds.has(id)) {
      cancelMediaLoads(id)
      const { [id]: _removed, ...remaining } = imagePreviewStates.value
      imagePreviewStates.value = remaining
    }
  }
  for (const id of [...imagePreviewTargets.keys()]) {
    if (!currentIds.has(id)) {
      cancelMediaLoads(id)
      imagePreviewObserver?.unobserve(imagePreviewTargets.get(id)!)
      imagePreviewTargets.delete(id)
    }
  }
  for (const id of [...attachmentPreviewTargets.keys()]) {
    if (!currentIds.has(id)) {
      cancelMediaLoads(id)
      attachmentPreviewObserver?.unobserve(attachmentPreviewTargets.get(id)!)
      attachmentPreviewTargets.delete(id)
    }
  }
}

function hasThumbnail(attachment: MessageAttachment): boolean {
  return (attachment.thumbnailVersion ?? 0) > 0 && attachment.thumbnailMimeType?.startsWith('image/') === true
}

function imagePreviewState(attachment: MessageAttachment): ImagePreviewLoadState {
  return imagePreviewStates.value[attachment.id] ?? 'idle'
}

function setImagePreviewState(attachmentId: string, state: ImagePreviewLoadState) {
  imagePreviewStates.value = {
    ...imagePreviewStates.value,
    [attachmentId]: state,
  }
}

function queueMediaBlobLoad(
  key: string,
  attachmentId: string,
  load: () => Promise<Blob>,
  priority: ChatMediaRequestPriority,
): Promise<Blob> {
  const existing = pendingImageBlobLoads.get(key)
  if (existing) return existing.promise

  const request = enqueueChatMediaRequest(load, priority)
  const pending: PendingImageBlobLoad = {
    attachmentId,
    request,
    promise: request.promise.finally(() => {
      if (pendingImageBlobLoads.get(key)?.request === request) {
        pendingImageBlobLoads.delete(key)
      }
    }),
  }
  pendingImageBlobLoads.set(key, pending)
  return pending.promise
}

function cancelMediaLoads(attachmentId: string) {
  for (const [key, pending] of pendingImageBlobLoads) {
    if (pending.attachmentId !== attachmentId) continue
    pending.request.cancel()
    pendingImageBlobLoads.delete(key)
  }
  imagePreviewLoads.delete(attachmentId)
  originalImageLoads.delete(attachmentId)
  attachmentPreviewLoads.delete(attachmentId)
}

function updateOpenImagePreview(attachmentId: string, src: string) {
  if (!src || !mediaPreview.value.open || mediaPreview.value.kind !== 'image' || mediaPreview.value.attachmentId !== attachmentId) {
    return
  }
  mediaPreview.value = {
    ...mediaPreview.value,
    src,
  }
}

async function ensureOriginalImageUrl(
  attachment: MessageAttachment,
  priority: ChatMediaRequestPriority,
): Promise<string> {
  const existing = originalImageUrls.value[attachment.id]
  if (existing) return existing

  const inFlight = originalImageLoads.get(attachment.id)
  if (inFlight) return inFlight
  if (props.message.sendStatus || props.message.pending || !mediaLifecycleActive) return ''

  const load = queueMediaBlobLoad(
    `original:${props.message.id}:${attachment.id}`,
    attachment.id,
    () => fetchMessageAttachmentBlob(props.message.id, attachment.id),
    priority,
  )
    .then(blob => setAttachmentUrl(originalImageUrls, attachment.id, blob))
    .finally(() => {
      originalImageLoads.delete(attachment.id)
    })
  originalImageLoads.set(attachment.id, load)
  return load
}

async function ensureImagePreviewUrl(
  attachment: MessageAttachment,
  priority: ChatMediaRequestPriority = 'normal',
): Promise<string> {
  const existing = attachmentUrl(attachment)
  if (existing) return existing

  const inFlight = imagePreviewLoads.get(attachment.id)
  if (inFlight) return inFlight
  if (props.message.sendStatus || props.message.pending || !mediaLifecycleActive) return ''

  setImagePreviewState(attachment.id, 'loading')
  const load = (async () => {
    if (!hasThumbnail(attachment)) {
      return ensureOriginalImageUrl(attachment, priority)
    }

    try {
      const blob = await queueMediaBlobLoad(
        `thumbnail:${props.message.id}:${attachment.id}:v${attachment.thumbnailVersion}`,
        attachment.id,
        () => fetchMessageAttachmentThumbnailBlob(props.message.id, attachment.id, attachment.thumbnailVersion!),
        priority,
      )
      return setAttachmentUrl(attachmentUrls, attachment.id, blob)
    } catch (error) {
      if (isChatMediaRequestCancelled(error)) throw error
      console.debug('[attachments] thumbnail preview load failed; falling back to original', {
        messageId: props.message.id,
        attachmentId: attachment.id,
        error,
      })
      return ensureOriginalImageUrl(attachment, priority)
    }
  })()
    .then(url => {
      if (url) {
        setImagePreviewState(attachment.id, 'loaded')
        updateOpenImagePreview(attachment.id, url)
      }
      return url
    })
    .catch(error => {
      if (!isChatMediaRequestCancelled(error)) {
        console.debug('[attachments] image preview load failed', {
          messageId: props.message.id,
          attachmentId: attachment.id,
          error,
        })
        setImagePreviewState(attachment.id, 'failed')
      }
      return ''
    })
    .finally(() => {
      imagePreviewLoads.delete(attachment.id)
    })
  imagePreviewLoads.set(attachment.id, load)
  return load
}

function setAttachmentLoading(attachmentId: string, loading: boolean) {
  const next = new Set(loadingAttachmentIds.value)
  if (loading) {
    next.add(attachmentId)
  } else {
    next.delete(attachmentId)
  }
  loadingAttachmentIds.value = next
}

async function ensureAttachmentUrl(
  attachment: MessageAttachment,
  priority: ChatMediaRequestPriority = 'normal',
): Promise<string> {
  const existing = attachmentUrls.value[attachment.id]
  if (existing) return existing

  const inFlight = attachmentPreviewLoads.get(attachment.id)
  if (inFlight) return inFlight
  if (props.message.sendStatus || props.message.pending || !mediaLifecycleActive) return ''

  setAttachmentLoading(attachment.id, true)
  let load!: Promise<string>
  load = queueMediaBlobLoad(
    `preview:${props.message.id}:${attachment.id}`,
    attachment.id,
    () => fetchMessageAttachmentBlob(props.message.id, attachment.id),
    priority,
  )
    .then(blob => setAttachmentUrl(attachmentUrls, attachment.id, blob))
    .catch(error => {
      if (!isChatMediaRequestCancelled(error)) {
        console.debug('[attachments] preview load failed', {
          messageId: props.message.id,
          attachmentId: attachment.id,
          error,
        })
      }
      return ''
    })
    .finally(() => {
      if (attachmentPreviewLoads.get(attachment.id) === load) {
        attachmentPreviewLoads.delete(attachment.id)
        setAttachmentLoading(attachment.id, false)
      }
    })
  attachmentPreviewLoads.set(attachment.id, load)
  return load
}

function setImagePreviewTarget(attachment: MessageAttachment, element: Element | ComponentPublicInstance | null) {
  const previous = imagePreviewTargets.get(attachment.id)
  const target = element instanceof HTMLElement
    ? element
    : element && '$el' in element && element.$el instanceof HTMLElement
      ? element.$el
      : null
  if (!target) {
    if (previous) {
      imagePreviewObserver?.unobserve(previous)
      imagePreviewTargets.delete(attachment.id)
    }
    cancelMediaLoads(attachment.id)
    return
  }

  if (previous && previous !== target) {
    imagePreviewObserver?.unobserve(previous)
  }
  imagePreviewTargets.set(attachment.id, target)
  if (imagePreviewObserver) {
    imagePreviewObserver.observe(target)
  } else if (imagePreviewObserverStarted) {
    void ensureImagePreviewUrl(attachment)
  }
}

function setAttachmentPreviewTarget(attachment: MessageAttachment, element: Element | ComponentPublicInstance | null) {
  const previous = attachmentPreviewTargets.get(attachment.id)
  const target = element instanceof HTMLElement
    ? element
    : element && '$el' in element && element.$el instanceof HTMLElement
      ? element.$el
      : null
  if (!target) {
    if (previous) {
      attachmentPreviewObserver?.unobserve(previous)
      attachmentPreviewTargets.delete(attachment.id)
    }
    cancelMediaLoads(attachment.id)
    return
  }

  if (previous && previous !== target) {
    attachmentPreviewObserver?.unobserve(previous)
  }
  attachmentPreviewTargets.set(attachment.id, target)
  if (attachmentPreviewObserver) {
    attachmentPreviewObserver.observe(target)
  } else if (attachmentPreviewObserverStarted) {
    startAttachmentPreviewObserver()
  }
}

function startAttachmentPreviewObserver() {
  attachmentPreviewObserverStarted = true
  if (attachmentPreviewObserver || !messageAttachments.value.some(attachment => (
    isVideoAttachment(attachment) || isAudioAttachment(attachment)
  ))) return
  if (typeof IntersectionObserver !== 'function') {
    // Do not eagerly download full video/audio blobs in older webviews. The
    // explicit load controls remain available when viewport observation is absent.
    return
  }

  attachmentPreviewObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      attachmentPreviewObserver?.unobserve(entry.target)
      const attachmentId = entry.target.getAttribute('data-message-media-attachment-id')
      const attachment = attachmentId
        ? messageAttachments.value.find(item => item.id === attachmentId)
        : undefined
      if (attachment && (isVideoAttachment(attachment) || isAudioAttachment(attachment))) {
        void ensureAttachmentUrl(attachment)
      }
    }
  }, {
    rootMargin: '320px 0px',
  })

  for (const target of attachmentPreviewTargets.values()) {
    attachmentPreviewObserver.observe(target)
  }
}

function syncAttachmentPreviewTargets() {
  if (!attachmentPreviewObserverStarted || !attachmentPreviewObserver) return
  for (const attachment of messageAttachments.value) {
    if (!isVideoAttachment(attachment) && !isAudioAttachment(attachment)) continue
    const target = attachmentPreviewTargets.get(attachment.id)
    if (target) attachmentPreviewObserver.observe(target)
  }
}

function startImagePreviewObserver() {
  imagePreviewObserverStarted = true
  if (typeof IntersectionObserver !== 'function') {
    // Older webviews lack IntersectionObserver. Keep previews functional there,
    // while current browsers defer the request until the preview is nearby.
    for (const attachment of messageAttachments.value) {
      if (isImageAttachment(attachment)) {
        void ensureImagePreviewUrl(attachment)
      }
    }
    return
  }

  imagePreviewObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      imagePreviewObserver?.unobserve(entry.target)
      const attachmentId = entry.target.getAttribute('data-message-image-attachment-id')
      const attachment = attachmentId
        ? messageAttachments.value.find(item => item.id === attachmentId)
        : undefined
      if (attachment && isImageAttachment(attachment)) {
        void ensureImagePreviewUrl(attachment)
      }
    }
  }, {
    rootMargin: '320px 0px',
  })

  for (const target of imagePreviewTargets.values()) {
    imagePreviewObserver.observe(target)
  }
}

function syncImagePreviewTargets() {
  if (!imagePreviewObserverStarted) return
  for (const attachment of messageAttachments.value) {
    if (!isImageAttachment(attachment)) continue
    const target = imagePreviewTargets.get(attachment.id)
    if (target && imagePreviewObserver) {
      imagePreviewObserver.observe(target)
    } else if (!imagePreviewObserver) {
      void ensureImagePreviewUrl(attachment)
    }
  }
}

async function downloadAttachment(attachment: MessageAttachment) {
  try {
    const blob = await fetchMessageAttachmentBlob(props.message.id, attachment.id)
    const objectUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = attachment.fileName
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(objectUrl)
  } catch (error) {
    console.debug('[attachments] download failed', { messageId: props.message.id, attachmentId: attachment.id, error })
  }
}

function openMediaPreview(attachment: MessageAttachment) {
  if (!isImageAttachment(attachment) && !isVideoAttachment(attachment)) return

  if (isImageAttachment(attachment)) {
    mediaPreview.value = {
      open: true,
      kind: 'image',
      src: attachmentUrl(attachment),
      fileName: attachment.fileName,
      attachmentId: attachment.id,
    }
    void ensureImagePreviewUrl(attachment, 'high')
      .then(async previewUrl => {
        if (!previewUrl) return
        updateOpenImagePreview(attachment.id, previewUrl)
        const originalUrl = await ensureOriginalImageUrl(attachment, 'high')
        updateOpenImagePreview(attachment.id, originalUrl)
      })
      .catch(error => {
        if (isChatMediaRequestCancelled(error)) return
        console.debug('[attachments] lightbox original load failed', {
          messageId: props.message.id,
          attachmentId: attachment.id,
          error,
        })
      })
    return
  }

  const src = attachmentUrl(attachment)
  if (src) {
    mediaPreview.value = {
      open: true,
      kind: 'video',
      src,
      fileName: attachment.fileName,
      attachmentId: attachment.id,
    }
    return
  }

  void ensureAttachmentUrl(attachment, 'high').then(previewUrl => {
    if (!previewUrl || !mediaLifecycleActive) return
    mediaPreview.value = {
      open: true,
      kind: 'video',
      src: previewUrl,
      fileName: attachment.fileName,
      attachmentId: attachment.id,
    }
  })
}

function loadAudioPreview(attachment: MessageAttachment) {
  void ensureAttachmentUrl(attachment, 'high')
}

function closeMediaPreview() {
  mediaPreview.value = {
    open: false,
    kind: 'image',
    src: '',
    fileName: '',
    attachmentId: undefined,
  }
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

// ── Reaction users hover popup ───────────────────────────────────────────────

function clearReactionPopupCloseTimer() {
  if (!reactionPopupCloseTimer) return
  clearTimeout(reactionPopupCloseTimer)
  reactionPopupCloseTimer = null
}

function closeReactionUsersPopup() {
  clearReactionPopupCloseTimer()
  reactionTriggerHovered.value = false
  reactionPopupHovered.value = false
  activeReactionEmoji.value = null
  activeReactionTrigger.value = null
  reactionUsersLoading.value = false
  reactionUsersError.value = ''
}

function scheduleReactionPopupClose() {
  clearReactionPopupCloseTimer()
  reactionPopupCloseTimer = setTimeout(() => {
    if (reactionTriggerHovered.value || reactionPopupHovered.value) return
    closeReactionUsersPopup()
  }, 120)
}

function updateReactionUsersPopupPosition() {
  const trigger = activeReactionTrigger.value
  if (!trigger || !activeReactionEmoji.value) return

  const rect = trigger.getBoundingClientRect()
  const viewportHeight = window.innerHeight
  const viewportWidth = window.innerWidth
  if (viewportHeight <= 0 || viewportWidth <= 0) return

  const popupHeight = Math.max(
    0,
    Math.min(REACTION_USERS_POPUP_MAX_HEIGHT, viewportHeight - EMOJI_PICKER_EDGE_PADDING * 2),
  )
  const popupWidth = Math.max(
    0,
    Math.min(REACTION_USERS_POPUP_WIDTH, viewportWidth - EMOJI_PICKER_EDGE_PADDING * 2),
  )
  if (popupHeight <= 0 || popupWidth <= 0) return

  // Keep popup anchored below the reaction chip at all times.
  const rawTop = rect.bottom + REACTION_USERS_POPUP_GAP
  const desiredLeft = rect.left

  const leftMax = viewportWidth - popupWidth - EMOJI_PICKER_EDGE_PADDING
  const top = Math.max(EMOJI_PICKER_EDGE_PADDING, rawTop)
  const left = clamp(desiredLeft, EMOJI_PICKER_EDGE_PADDING, leftMax)

  reactionUsersPopupStyle.value = {
    ...reactionUsersPopupStyle.value,
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`,
    width: `${Math.round(popupWidth)}px`,
    maxHeight: `${Math.round(popupHeight)}px`,
  }
}

async function ensureReactionUsersLoaded(emoji: string) {
  if (reactionUsersCache.value[emoji]) {
    reactionUsersLoading.value = false
    reactionUsersError.value = ''
    return
  }

  const fetchToken = ++reactionUsersFetchToken
  reactionUsersLoading.value = true
  reactionUsersError.value = ''
  try {
    const users = await listMessageReactionUsers(props.message.channelId, props.message.id, emoji)
    if (fetchToken !== reactionUsersFetchToken || activeReactionEmoji.value !== emoji) return
    reactionUsersCache.value = {
      ...reactionUsersCache.value,
      [emoji]: users,
    }
  } catch {
    if (fetchToken !== reactionUsersFetchToken || activeReactionEmoji.value !== emoji) return
    reactionUsersError.value = 'Failed to load reactions'
  } finally {
    if (fetchToken === reactionUsersFetchToken && activeReactionEmoji.value === emoji) {
      reactionUsersLoading.value = false
    }
  }
}

function onReactionChipMouseEnter(evt: MouseEvent, emoji: string) {
  const target = evt.currentTarget as HTMLElement | null
  if (!target || !props.message.channelId) return
  clearReactionPopupCloseTimer()
  reactionTriggerHovered.value = true
  reactionPopupHovered.value = false
  activeReactionEmoji.value = emoji
  activeReactionTrigger.value = target
  reactionUsersError.value = ''
  reactionUsersLoading.value = !Boolean(reactionUsersCache.value[emoji])
  updateReactionUsersPopupPosition()
  if (!reactionUsersCache.value[emoji]) {
    void ensureReactionUsersLoaded(emoji)
  }
}

function onReactionChipMouseLeave(emoji: string) {
  if (activeReactionEmoji.value !== emoji) return
  reactionTriggerHovered.value = false
  scheduleReactionPopupClose()
}

function onReactionPopupMouseEnter() {
  reactionPopupHovered.value = true
  clearReactionPopupCloseTimer()
}

function onReactionPopupMouseLeave() {
  reactionPopupHovered.value = false
  scheduleReactionPopupClose()
}

// invalidate per-emoji cache when count changes so next hover re-fetches fresh users
watch(
  () => props.message.reactions.map(r => `${r.emoji}:${r.count}`).join('|'),
  () => {
    const nextCounts: Record<string, number> = {}
    for (const reaction of props.message.reactions) {
      nextCounts[reaction.emoji] = reaction.count
    }

    const prevCounts = reactionCountsSnapshot.value
    let nextCache = reactionUsersCache.value
    let cacheChanged = false
    for (const [emoji, prevCount] of Object.entries(prevCounts)) {
      const nextCount = nextCounts[emoji]
      if (typeof nextCount === 'undefined' || nextCount !== prevCount) {
        if (typeof nextCache[emoji] !== 'undefined') {
          if (!cacheChanged) {
            nextCache = { ...nextCache }
            cacheChanged = true
          }
          delete nextCache[emoji]
        }
      }
    }
    if (cacheChanged) {
      reactionUsersCache.value = nextCache
    }
    reactionCountsSnapshot.value = nextCounts

    if (activeReactionEmoji.value && typeof nextCounts[activeReactionEmoji.value] === 'undefined') {
      closeReactionUsersPopup()
    }
  },
  { immediate: true },
)

watch(() => props.message.id, () => {
  closeReactionUsersPopup()
  reactionUsersCache.value = {}
  reactionCountsSnapshot.value = {}
  isEditing.value = false
  editBody.value = ''
  editPendingTaskUrlPaste.value = false
  editError.value = ''
  editSaving.value = false
})

watch(() => props.editRequestToken, (token, previous) => {
  if (!token || token === previous) return
  startEdit()
})

watch(isEditing, (next, previous) => {
  if (next === previous) return
  if (next) {
    emit('edit-open', props.message.id)
    return
  }
  emit('edit-close', props.message.id)
})

// ── Reactions ────────────────────────────────────────────────────────────────

function toggleReaction(emoji: string) {
  debugReaction('toggleReaction:clicked', {
    emoji,
    channelId: props.message.channelId,
    messageId: props.message.id,
    mine: props.message.myReactions.includes(emoji),
  })
  if (isEncryptedMessage.value) return
  if (!props.message.channelId) return
  if (chat.isReactionOpPending(props.message.channelId, props.message.id, emoji)) return
  const mine = props.message.myReactions.includes(emoji)
  const opId = generateId()
  if (mine) {
    debugReaction('toggleReaction:remove', { opId, emoji })
    chat.queueReactionOp(opId, props.message.channelId, props.message.id, emoji, 'remove')
    ws.sendRemoveReaction(props.message.channelId, props.message.id, emoji, opId)
  } else {
    debugReaction('toggleReaction:add', { opId, emoji })
    chat.queueReactionOp(opId, props.message.channelId, props.message.id, emoji, 'add')
    ws.sendAddReaction(props.message.channelId, props.message.id, emoji, opId)
  }
}

function toggleSaved() {
  void chat.toggleMessageSaved(props.message)
}

function addReaction(emoji: string) {
  debugReaction('addReaction:entered', {
    emoji,
    channelId: props.message.channelId,
    messageId: props.message.id,
    alreadyMine: props.message.myReactions.includes(emoji),
  })
  showEmojiPicker.value = false
  if (isEncryptedMessage.value) return
  if (!props.message.channelId) return
  if (props.message.myReactions.includes(emoji)) return
  if (chat.isReactionOpPending(props.message.channelId, props.message.id, emoji)) return
  const opId = generateId()
  debugReaction('addReaction:queue+send', { opId, emoji })
  chat.queueReactionOp(opId, props.message.channelId, props.message.id, emoji, 'add')
  ws.sendAddReaction(props.message.channelId, props.message.id, emoji, opId)
}

function onSelectEmoji(emoji: { native?: string; colons?: string; id?: string }) {
  debugReaction('picker:select:event', emoji)
  const value = emoji.native ?? emoji.colons ?? emoji.id
  debugReaction('picker:select:resolved', { value })
  if (!value) return
  addReaction(value)
}

// ── Emoji picker ─────────────────────────────────────────────────────────────

function togglePickerButton() {
  if (isEncryptedMessage.value) return
  if (showEmojiPicker.value) {
    showEmojiPicker.value = false
    if (activeEmojiPickerId.value === instanceId) {
      activeEmojiPickerId.value = null
    }
    return
  }

  activeEmojiPickerId.value = instanceId
  showEmojiPicker.value = true
  if (showEmojiPicker.value) {
    void ensureEmojiPickerLoaded()
    void nextTick(updateEmojiPickerPosition)
  }
  debugReaction('picker:toggle', { visible: showEmojiPicker.value })
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  if (value < min) return min
  if (value > max) return max
  return value
}

function updateEmojiPickerPosition() {
  const trigger = pickerToggleButton.value
  if (!trigger) return

  const rect = trigger.getBoundingClientRect()
  const viewportHeight = window.innerHeight
  const viewportWidth = window.innerWidth
  if (viewportHeight <= 0 || viewportWidth <= 0) return

  const availablePickerHeight = Math.max(
    0,
    Math.min(EMOJI_PICKER_HEIGHT, viewportHeight - EMOJI_PICKER_EDGE_PADDING * 2),
  )
  const availablePickerWidth = Math.max(
    0,
    Math.min(EMOJI_PICKER_WIDTH, viewportWidth - EMOJI_PICKER_EDGE_PADDING * 2),
  )
  if (availablePickerHeight <= 0 || availablePickerWidth <= 0) return

  const spaceBelow = viewportHeight - rect.bottom - EMOJI_PICKER_EDGE_PADDING
  const spaceAbove = rect.top - EMOJI_PICKER_EDGE_PADDING
  const canOpenDown = spaceBelow >= availablePickerHeight + EMOJI_PICKER_GAP
  const canOpenUp = spaceAbove >= availablePickerHeight + EMOJI_PICKER_GAP

  const openUp = canOpenDown ? false : (canOpenUp || spaceAbove > spaceBelow)
  const rawTop = openUp
    ? rect.top - availablePickerHeight - EMOJI_PICKER_GAP
    : rect.bottom + EMOJI_PICKER_GAP

  const alignByRight = !hasReactions.value
  const desiredLeft = alignByRight
    ? rect.right - availablePickerWidth
    : rect.left

  const topMax = viewportHeight - availablePickerHeight - EMOJI_PICKER_EDGE_PADDING
  const leftMax = viewportWidth - availablePickerWidth - EMOJI_PICKER_EDGE_PADDING
  const top = clamp(rawTop, EMOJI_PICKER_EDGE_PADDING, topMax)
  const left = clamp(desiredLeft, EMOJI_PICKER_EDGE_PADDING, leftMax)

  emojiPickerStyle.value = {
    ...emojiPickerStyle.value,
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`,
    overflow: 'hidden',
  }
}

async function ensureEmojiPickerLoaded() {
  if (pickerComponent.value && emojiIndex.value) return
  if (emojiPickerLoading.value) return
  emojiPickerLoading.value = true
  try {
    const [pickerModule, emojiDataModule] = await Promise.all([
      import('emoji-mart-vue-fast/src'),
      import('emoji-mart-vue-fast/data/all.json'),
    ])
    const data = (emojiDataModule as any).default ?? emojiDataModule
    pickerComponent.value = pickerModule.Picker
    emojiIndex.value = new pickerModule.EmojiIndex(data)
    debugReaction('picker:loaded')
  } catch (error) {
    console.error('[reactions] picker:load-failed', error)
    showEmojiPicker.value = false
  } finally {
    emojiPickerLoading.value = false
  }
}

function handleDocumentClick(evt: MouseEvent) {
  const target = evt.target as Node
  // Close emoji picker
  if (showEmojiPicker.value) {
    if (pickerToggleButton.value?.contains(target)) return
    if (emojiPickerRoot.value?.contains(target)) return
    showEmojiPicker.value = false
    if (activeEmojiPickerId.value === instanceId) {
      activeEmojiPickerId.value = null
    }
    debugReaction('picker:outside-close')
  }
  // Close context menu — allow clicks inside the teleported menu itself
  if (showContextMenu.value) {
    showContextMenu.value = false
  }
  if (activeReactionEmoji.value) {
    const insideTrigger = activeReactionTrigger.value?.contains(target)
    const insidePopup = reactionUsersPopupRoot.value?.contains(target)
    if (!insideTrigger && !insidePopup) {
      closeReactionUsersPopup()
    }
  }
  if (editTagPickerOpen.value) {
    closeEditTagPicker()
  }
}

function handleEscape(evt: KeyboardEvent) {
  if (evt.key !== 'Escape') return
  if (isEditing.value) {
    cancelEdit()
    return
  }
  if (mediaPreview.value.open) {
    closeMediaPreview()
  }
  showEmojiPicker.value = false
  showContextMenu.value = false
  closeReactionUsersPopup()
  closeEditTagPicker()
  debugReaction('picker:escape-close')
}

watch(
  [showEmojiPicker, showContextMenu, () => mediaPreview.value.open, reactionPopupVisible, isEditing, editTagPickerOpen],
  ([pickerVisible, menuVisible, previewVisible, popupVisible, editingVisible, editPickerVisible]) => {
  const anyOpen = pickerVisible || menuVisible || previewVisible || popupVisible || editingVisible || editPickerVisible
  if (anyOpen) {
    document.addEventListener('click', handleDocumentClick)
    document.addEventListener('keydown', handleEscape)
  } else {
    document.removeEventListener('click', handleDocumentClick)
    document.removeEventListener('keydown', handleEscape)
  }
  },
)

watch(activeEmojiPickerId, (value) => {
  if (value !== instanceId && showEmojiPicker.value) {
    showEmojiPicker.value = false
    debugReaction('picker:closed-by-other', { active: value })
  }
})

watch(showEmojiPicker, visible => {
  if (visible) {
    void nextTick(updateEmojiPickerPosition)
    window.addEventListener('resize', updateEmojiPickerPosition)
    window.addEventListener('scroll', updateEmojiPickerPosition, true)
    return
  }
  window.removeEventListener('resize', updateEmojiPickerPosition)
  window.removeEventListener('scroll', updateEmojiPickerPosition, true)
})

watch(reactionPopupVisible, visible => {
  if (visible) {
    void nextTick(updateReactionUsersPopupPosition)
    window.addEventListener('resize', updateReactionUsersPopupPosition)
    window.addEventListener('scroll', updateReactionUsersPopupPosition, true)
    return
  }
  window.removeEventListener('resize', updateReactionUsersPopupPosition)
  window.removeEventListener('scroll', updateReactionUsersPopupPosition, true)
})

watch(messageAttachments, () => {
  syncAttachmentUrls()
  syncImagePreviewTargets()
  syncAttachmentPreviewTargets()
}, { immediate: true, deep: true })

watch(
  () => [props.message.sendStatus, props.message.pending],
  () => {
    syncImagePreviewTargets()
    syncAttachmentPreviewTargets()
  },
)

onMounted(() => {
  startImagePreviewObserver()
  startAttachmentPreviewObserver()
  if (props.editRequestToken) startEdit()
})

onBeforeUnmount(() => {
  mediaLifecycleActive = false
  imagePreviewObserver?.disconnect()
  imagePreviewObserver = null
  attachmentPreviewObserver?.disconnect()
  attachmentPreviewObserver = null
  imagePreviewTargets.clear()
  attachmentPreviewTargets.clear()
  for (const { request } of pendingImageBlobLoads.values()) {
    request.cancel()
  }
  pendingImageBlobLoads.clear()
  document.removeEventListener('click', handleDocumentClick)
  document.removeEventListener('keydown', handleEscape)
  window.removeEventListener('resize', updateEmojiPickerPosition)
  window.removeEventListener('scroll', updateEmojiPickerPosition, true)
  window.removeEventListener('resize', updateReactionUsersPopupPosition)
  window.removeEventListener('scroll', updateReactionUsersPopupPosition, true)
  if (activeEmojiPickerId.value === instanceId) {
    activeEmojiPickerId.value = null
  }
  closeReactionUsersPopup()
  closeMediaPreview()
  clearReactionPopupCloseTimer()
  for (const id of Object.keys(attachmentUrls.value)) {
    revokeAttachmentUrl(attachmentUrls, id)
  }
  for (const id of Object.keys(originalImageUrls.value)) {
    revokeAttachmentUrl(originalImageUrls, id)
  }
})

// ── Context menu ─────────────────────────────────────────────────────────────

function startEdit() {
  if (!canModifyMessage.value) return
  showContextMenu.value = false
  editError.value = ''
  editPendingTaskUrlPaste.value = false
  closeEditTagPicker()
  editBody.value = props.message.body
  editEntities.value = (props.message.entities ?? []).map(entity => ({ ...entity }))
  isEditing.value = true
  nextTick(() => {
    editComposer.value?.focusAtEnd()
  })
}

function cancelEdit() {
  if (editSaving.value) return
  isEditing.value = false
  editError.value = ''
  editBody.value = ''
  editEntities.value = []
  editPendingTaskUrlPaste.value = false
  closeEditTagPicker()
}

function handleEditComposerResize(deltaPx: number) {
  if (!isEditing.value || deltaPx === 0) return
  emit('edit-resize', props.message.id, deltaPx)
}

function handleEditTextareaKeydown(evt: KeyboardEvent) {
  if (evt.key === 'Escape') {
    evt.preventDefault()
    cancelEdit()
  }
}

function handleEditTextareaKeyup(evt: KeyboardEvent) {
  if (evt.key === 'Escape') {
    cancelEdit()
  }
}

async function saveEdit() {
  if (!canModifyMessage.value || !canSaveEdit.value) return
  editSaving.value = true
  editError.value = ''
  const nextBody = editBody.value.trim()
  const trimmedDelta = editBody.value.length - editBody.value.trimStart().length
  const nextEntities = editEntities.value
    .map(entity => ({
      ...entity,
      start: entity.start - trimmedDelta,
      end: entity.end - trimmedDelta,
    }))
    .filter(entity => entity.start >= 0 && entity.end <= nextBody.length)
  try {
    const resp = await editMessageApi(props.message.id, nextBody, nextEntities.map(entity => ({
      kind: entity.kind,
      target_id: entity.targetId,
      label: entity.label,
      href: entity.href,
      start: entity.start,
      end: entity.end,
    })))
    const normalizedEntities = (resp.entities ?? []).map(entity => ({
      kind: entity.kind,
      targetId: entity.target_id,
      label: entity.label,
      href: entity.href,
      start: entity.start,
      end: entity.end,
    }))
    chat.applyLocalMessageEdited(
      props.message.channelId,
      props.message.id,
      nextBody,
      normalizedEntities,
      resp.edited_at || new Date().toISOString(),
    )
    isEditing.value = false
    editBody.value = ''
    editEntities.value = []
    editPendingTaskUrlPaste.value = false
    closeEditTagPicker()
  } catch (error) {
    editError.value = error instanceof Error ? error.message : 'Failed to edit message'
  } finally {
    editSaving.value = false
  }
}

async function deleteCurrentMessage() {
  if (!canDeleteMessage.value || isDeleting.value) return
  isDeleting.value = true
  editError.value = ''
  showContextMenu.value = false
  try {
    await deleteMessageApi(props.message.id)
    if (isSecretConversation.value) {
      chat.invalidateSecretHistory(props.message.channelId)
    } else {
      chat.applyLocalMessageDeleted(
        props.message.channelId,
        props.message.id,
        props.message.threadRootMessageId,
      )
    }
  } catch (error) {
    editError.value = error instanceof Error ? error.message : 'Failed to delete message'
    chat.showToast(editError.value)
  } finally {
    isDeleting.value = false
  }
}

function toggleContextMenu() {
  if (showContextMenu.value) {
    showContextMenu.value = false
    return
  }
  if (isEncryptedMessage.value && !canSaveMessage.value) return
  // Calculate position from trigger button before showing
  const trigger = contextMenuTrigger.value
  if (trigger) {
    const rect = trigger.getBoundingClientRect()
    // Align right edge of menu with right edge of trigger; appear below
    const menuWidth = 160
    contextMenuStyle.value = {
      top: `${rect.bottom + 4}px`,
      left: `${rect.right - menuWidth}px`,
    }
  }
  showContextMenu.value = true
  showEmojiPicker.value = false
}

function copyMessage() {
  showContextMenu.value = false
  void navigator.clipboard.writeText(props.message.body)
}

// ── Reaction chip styles ─────────────────────────────────────────────────────

function reactionChipClass(emoji: string): string {
  const mine = props.message.myReactions.includes(emoji)
  const pending = chat.isReactionOpPending(props.message.channelId, props.message.id, emoji)
  if (mine) {
    return pending
      ? 'border-accent/40 bg-accent/20 text-app-text opacity-70'
      : 'border-accent/60 bg-accent/25 text-app-text'
  }
  return pending
    ? 'border-chat-border bg-chat-input text-app-secondaryText opacity-70'
    : 'border-chat-border bg-chat-input hover:bg-chat-msgHover text-app-secondaryText'
}
</script>
