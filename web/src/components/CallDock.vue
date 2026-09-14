<template>
  <div v-if="isVisible" :class="containerClass">
    <!-- ── Minimized pill ─────────────────────────────────────────────────── -->
    <div
      v-if="callStore.minimized"
      ref="minimizedDockEl"
      class="flex items-center gap-1.5 rounded-full border border-chat-border bg-chat-header/95 px-3 py-1.5 text-app-text shadow-xl backdrop-blur touch-none cursor-move"
      :style="minimizedDockStyle"
      data-testid="calldock-minimized-root"
      @pointerdown="handleMinimizedDockPointerDown"
    >
      <!-- Expand back to panel -->
      <button
        class="flex items-center gap-1.5 rounded px-1.5 py-1 text-xs font-medium hover:bg-chat-msgHover"
        data-testid="calldock-minimized-expand"
        @click="callStore.toggleMinimized()"
      >
        <span class="h-2 w-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
        <span class="max-w-[120px] truncate">{{ callStore.activeConversationTitle || 'Huddle' }}</span>
      </button>
      <div class="h-4 w-px bg-chat-border" />
      <!-- Mic toggle -->
      <button
        class="flex h-7 w-7 items-center justify-center rounded-full transition-colors"
        :class="callStore.micEnabled ? 'text-app-secondaryText hover:bg-chat-msgHover' : 'text-app-danger hover:bg-app-danger/10'"
        :title="callStore.micEnabled ? 'Mute' : 'Unmute'"
        @click="handleToggleMute"
      >
        <svg v-if="callStore.micEnabled" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8"/>
        </svg>
        <svg v-else class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <line x1="1" y1="1" x2="23" y2="23"/>
          <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23M12 19v3M8 23h8"/>
        </svg>
      </button>
      <!-- Leave -->
      <button
        class="flex h-7 w-7 items-center justify-center rounded-full bg-red-500/80 text-white hover:bg-red-500 transition-colors"
        title="Leave call"
        @click="handleLeave"
      >
        <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.4 12.4 0 0 0 2.53.59A2 2 0 0 1 22 16.84V19a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.26 11 19.8 19.8 0 0 1 1.18 2.37 2 2 0 0 1 3.16 0H5.5a2 2 0 0 1 2 1.72 12.4 12.4 0 0 0 .57 2.57 2 2 0 0 1-.45 2.11L6.35 7.67a16 16 0 0 0 4.33 5.64z"/>
          <line x1="1" y1="1" x2="23" y2="23"/>
        </svg>
      </button>
    </div>

    <!-- ── Expanded panel ─────────────────────────────────────────────────── -->
    <section
      v-else
      ref="expandedDockEl"
      :class="panelClass"
      :style="expandedDockStyle"
      data-testid="calldock-expanded-root"
    >

      <!-- Header — single compact line -->
      <header
        class="flex items-center gap-2 border-b border-chat-border px-3 py-2 shrink-0 min-w-0 touch-none"
        :class="maximized ? '' : 'cursor-move'"
        data-testid="calldock-expanded-drag-handle"
        @pointerdown="handleExpandedDockPointerDown"
      >
        <span class="h-2 w-2 shrink-0 rounded-full bg-emerald-400 animate-pulse" />
        <span class="truncate text-sm font-semibold text-app-text min-w-0">{{ callStore.activeConversationTitle || 'Huddle' }}</span>
        <span class="shrink-0 text-app-muted">·</span>
        <span class="shrink-0 text-xs text-app-muted">{{ callStore.connecting ? 'Connecting…' : `${callStore.remoteParticipantCount + 1}` }}</span>
        <div class="ml-auto flex items-center gap-0.5 shrink-0">
          <!-- Maximize / restore -->
          <button
            class="flex h-7 w-7 items-center justify-center rounded text-app-muted hover:bg-chat-msgHover hover:text-app-text transition-colors"
            :title="maximized ? 'Restore' : 'Maximize'"
            @click="toggleMaximized"
          >
            <!-- Maximize: arrows-pointing-out -->
            <svg v-if="!maximized" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
              <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
            </svg>
            <!-- Restore: arrows-pointing-in -->
            <svg v-else class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
              <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/>
            </svg>
          </button>
          <!-- Minimize to pill -->
          <button
            class="flex h-7 w-7 items-center justify-center rounded text-app-muted hover:bg-chat-msgHover hover:text-app-text transition-colors"
            title="Minimize"
            @click="handleMinimize"
          >
            <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path d="M5 12h14"/>
            </svg>
          </button>
        </div>
      </header>

      <!-- Body -->
      <div :class="contentClass">

        <!-- Stage wrapper — must pass flex-1 height down in maximized mode -->
        <div :class="maximized ? 'flex-1 min-h-0 flex flex-col' : ''">

          <!-- ── Main stage ─────────────────────────────────────────────── -->
          <div ref="stageEl" :class="stageClass">

            <!--
              Remote screen share video — ALWAYS in DOM (v-show, not v-if) so the
              ref is populated before syncRemoteScreenTrack() tries to attach to it.
            -->
            <video
              ref="remoteScreenEl"
              v-show="remoteScreenStageVisible"
              class="absolute inset-0 h-full w-full bg-black object-contain"
              data-testid="calldock-remote-share-stage"
              autoplay
              playsinline
            />
            <div
              v-if="remoteScreenStagePausedVisible"
              class="absolute inset-0 bg-black"
              data-testid="calldock-remote-share-stage-paused"
            >
              <img
                v-if="remoteScreenPauseFrameSrc"
                :src="remoteScreenPauseFrameSrc"
                class="h-full w-full object-contain"
                data-testid="calldock-remote-share-stage-paused-image"
                alt="Paused shared screen"
              >
              <div v-else class="flex h-full w-full items-center justify-center bg-slate-950 text-sm text-slate-300">
                Shared screen paused for you
              </div>
              <div class="absolute inset-0 bg-black/35" />
            </div>
            <div
              v-if="remoteScreenStageVisible || remoteScreenStagePausedVisible"
              class="absolute left-3 top-3 z-10 rounded-md border border-slate-500/70 bg-black/60 px-2 py-1 text-[11px] text-white"
            >
              {{ remoteScreenStagePausedVisible ? `${remoteScreenOwnerDisplayLabel} paused for you` : remoteScreenOwnerDisplayLabel }}
            </div>
            <div
              v-if="remoteScreenStageVisible || remoteScreenStagePausedVisible"
              class="absolute top-3 right-3 z-10 flex items-center gap-2"
            >
              <button
                class="flex h-7 items-center justify-center rounded-full bg-black/60 px-3 text-xs text-white hover:bg-black/90 transition-colors"
                :title="remoteScreenReceiveToggleTitle"
                :data-testid="callStore.remoteScreenShareReceiveEnabled ? 'calldock-remote-share-stage-stop' : 'calldock-remote-share-stage-resume'"
                @click="callStore.remoteScreenShareReceiveEnabled ? handleStopRemoteScreenShareForMe() : handleStartRemoteScreenShareForMe()"
              >
                {{ callStore.remoteScreenShareReceiveEnabled ? 'Pause for me' : 'Resume' }}
              </button>
              <button
                class="flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/90 transition-colors"
                :title="remoteScreenViewerToggleTitle"
                data-testid="calldock-remote-share-stage-toggle"
                @click="toggleRemoteScreenPresentationMode"
              >
                <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                  <path d="M15 3h6v6M9 21L21 3M21 9V3h-6"/>
                </svg>
              </button>
            </div>

            <!-- Pinned view: fills stage when a tile is pinned -->
            <template v-if="pinnedSid">
              <!-- Pinned video — always in DOM so ref is stable -->
              <video
                ref="pinnedVideoEl"
                class="absolute inset-0 h-full w-full bg-black"
                :class="[pinnedTileHasVideo ? '' : 'invisible', pinnedScreenShareActive ? 'object-contain' : 'object-cover']"
                autoplay
                playsinline
                muted
              />
              <!-- Avatar fallback when pinned tile has no video -->
              <div
                v-if="!pinnedTileHasVideo"
                class="absolute inset-0 flex items-center justify-center"
              >
                <UserAvatar
                  :user-id="pinnedTile?.identity ?? ''"
                  :display-name="pinnedTileName"
                  :avatar-url="pinnedTile?.avatarUrl"
                  size="xl"
                  :class="fallbackAvatarClass"
                />
              </div>
              <div
                v-if="pinnedTile?.reactionEmoji"
                class="absolute right-3 bottom-12 z-10 flex h-9 w-9 items-center justify-center rounded-full border border-white/30 bg-black/65 text-xl shadow-lg"
                role="status"
                :aria-label="`${pinnedTileName} reacted ${pinnedTile.reactionEmoji}`"
                :data-testid="`calldock-pinned-reaction-${pinnedTile.sid}`"
              >
                <span aria-hidden="true">{{ pinnedTile.reactionEmoji }}</span>
              </div>
              <!-- Name badge -->
              <div class="absolute left-3 bottom-12 z-10 rounded-md border border-slate-500/70 bg-black/60 px-2 py-1 text-[11px] text-white">
                {{ pinnedTileName }}
              </div>
              <div
                v-if="pinnedTile?.raisedHandPosition"
                class="absolute left-3 top-3 z-10 flex h-12 items-center gap-2 rounded-lg border border-amber-300/60 bg-amber-400/90 px-3 text-xl font-bold text-slate-950 shadow-lg"
                :aria-label="`Raised hand position ${pinnedTile.raisedHandPosition}`"
                :data-testid="`calldock-pinned-hand-${pinnedTile.raisedHandPosition}`"
              >
                <span class="text-3xl leading-none" aria-hidden="true">✋</span>
                <span>{{ pinnedTile.raisedHandPosition }}</span>
              </div>
              <!-- Unpin button -->
              <button
                class="absolute top-3 right-3 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/90 transition-colors"
                title="Unpin"
                @click="unpinTile"
              >
                <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                  <path d="M18 6L6 18M6 6l12 12"/>
                </svg>
              </button>
            </template>

            <!-- Camera tile grid (shown when no remote screen share and nothing pinned) -->
            <template v-if="!remoteScreenStageVisible && !pinnedSid">
              <div :class="tileGridClass">

                  <!-- Local tile — NOT in v-for so ref="localVideoEl" / ref="localScreenEl"
                       are always stable single-element refs, never arrays. -->
                  <div
                    :class="[tileItemClass, localTile?.isSpeaking ? 'ring-2 ring-emerald-400 ring-offset-1 ring-offset-slate-900' : '']"
                  >
                    <!--
                      Both video elements always in DOM — visibility toggled via CSS.
                      This ensures refs are always populated when watchEffect runs.
                    -->
                    <!-- Camera video -->
                    <video
                      ref="localVideoEl"
                      class="absolute inset-0 h-full w-full object-cover"
                      :class="localTile?.cameraOn && !localTile?.screenShareOn ? 'opacity-100' : 'opacity-0 pointer-events-none'"
                      autoplay
                      playsinline
                      muted
                    />
                    <!-- Local screen share video -->
                    <video
                      ref="localScreenEl"
                      class="absolute inset-0 h-full w-full object-contain bg-black"
                      :class="localTile?.screenShareOn ? 'opacity-100' : 'opacity-0 pointer-events-none'"
                      autoplay
                      playsinline
                      muted
                    />
                    <!-- Avatar fallback -->
                    <div
                      v-if="!localTile?.cameraOn && !localTile?.screenShareOn"
                      class="flex h-full w-full items-center justify-center"
                    >
                      <UserAvatar
                        :user-id="localTile?.identity ?? ''"
                        :display-name="localTile?.name ?? 'You'"
                        :avatar-url="localTile?.avatarUrl"
                        size="lg"
                        :class="fallbackAvatarClass"
                      />
                    </div>
                    <!-- "Sharing screen" badge -->
                    <div
                      v-if="localTile?.screenShareOn"
                      class="absolute left-2 z-10 rounded border border-emerald-400/50 bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-medium text-emerald-200"
                      :class="localTile?.raisedHandPosition ? 'top-14' : 'top-2'"
                    >
                      Sharing screen
                    </div>
                    <div
                      v-if="localTile?.raisedHandPosition"
                      class="absolute left-2 top-2 z-10 flex h-10 items-center gap-1.5 rounded-lg border border-amber-300/60 bg-amber-400/90 px-2.5 text-lg font-bold text-slate-950 shadow-lg"
                      :aria-label="`Raised hand position ${localTile.raisedHandPosition}`"
                      :data-testid="`calldock-local-hand-${localTile.raisedHandPosition}`"
                    >
                      <span class="text-2xl leading-none" aria-hidden="true">✋</span>
                      <span>{{ localTile.raisedHandPosition }}</span>
                    </div>
                    <div
                      v-if="localTile?.reactionEmoji"
                      class="absolute right-2 bottom-9 z-10 flex h-8 w-8 items-center justify-center rounded-full border border-white/30 bg-black/65 text-lg shadow-lg"
                      role="status"
                      :aria-label="`${localTile.name} reacted ${localTile.reactionEmoji}`"
                      data-testid="calldock-local-reaction"
                    >
                      <span aria-hidden="true">{{ localTile.reactionEmoji }}</span>
                    </div>
                    <!-- Name + mic overlay -->
                    <div class="absolute bottom-0 inset-x-0 z-10 flex items-center gap-1.5 bg-gradient-to-t from-black/70 to-transparent px-2 py-1.5">
                      <span class="flex-1 truncate text-[11px] font-medium text-white leading-tight">{{ localTile?.name ?? '' }}</span>
                      <svg v-if="!localTile?.micOn" class="h-3.5 w-3.5 shrink-0 text-red-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                        <line x1="1" y1="1" x2="23" y2="23"/>
                        <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23M12 19v3M8 23h8"/>
                      </svg>
                      <svg v-else class="h-3.5 w-3.5 shrink-0 text-slate-300" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8"/>
                      </svg>
                    </div>
                    <!-- Pin button (hover) -->
                    <button
                      v-if="localTile"
                      class="absolute top-1.5 right-1.5 z-10 flex h-6 w-6 items-center justify-center rounded bg-black/50 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/80"
                      title="Pin to full view"
                      @click.stop="pinTile(localTile.sid)"
                    >
                      <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                        <path d="M15 3h6v6M9 21L21 3M21 9V3h-6"/>
                      </svg>
                    </button>
                  </div>

                  <!-- Remote tiles -->
                  <div
                    v-for="tile in remoteTiles"
                    :key="tile.sid"
                    :class="[tileItemClass, tile.isSpeaking ? 'ring-2 ring-emerald-400 ring-offset-1 ring-offset-slate-900' : '']"
                    :data-testid="`calldock-remote-tile-${tile.sid}`"
                  >
                    <video
                      v-if="tile.cameraOn || isLiveRemoteScreenTile(tile.sid)"
                      :ref="(el) => setRemoteTileRef(tile.sid, el as HTMLVideoElement | null)"
                      class="h-full w-full"
                      :class="isLiveRemoteScreenTile(tile.sid) ? 'bg-black object-contain' : 'object-cover'"
                      autoplay
                      playsinline
                    />
                    <div
                      v-else-if="isPausedRemoteScreenTile(tile.sid)"
                      class="relative h-full w-full bg-black"
                      :data-testid="`calldock-remote-share-tile-paused-${tile.sid}`"
                    >
                      <img
                        v-if="remoteScreenPauseFrameSrc"
                        :src="remoteScreenPauseFrameSrc"
                        class="h-full w-full object-contain"
                        :data-testid="`calldock-remote-share-tile-paused-image-${tile.sid}`"
                        alt="Paused shared screen"
                      >
                      <div v-else class="flex h-full w-full items-center justify-center text-sm text-slate-300">
                        Shared screen paused for you
                      </div>
                      <div class="absolute inset-0 bg-black/30" />
                    </div>
                    <div
                      v-else
                      class="flex h-full w-full items-center justify-center"
                    >
                      <UserAvatar
                        :user-id="tile.identity"
                        :display-name="tile.name"
                        :avatar-url="tile.avatarUrl"
                        size="lg"
                        :class="fallbackAvatarClass"
                      />
                    </div>
                    <div class="absolute bottom-0 inset-x-0 z-10 flex items-center gap-1.5 bg-gradient-to-t from-black/70 to-transparent px-2 py-1.5">
                      <span class="flex-1 truncate text-[11px] font-medium text-white leading-tight">{{ tile.name }}</span>
                      <svg v-if="!tile.micOn" class="h-3.5 w-3.5 shrink-0 text-red-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                        <line x1="1" y1="1" x2="23" y2="23"/>
                        <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23M12 19v3M8 23h8"/>
                      </svg>
                      <svg v-else class="h-3.5 w-3.5 shrink-0 text-slate-300" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8"/>
                      </svg>
                    </div>
                    <div
                      v-if="tile.screenShareOn"
                      class="absolute left-2 z-10 rounded border border-emerald-400/50 bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-medium text-emerald-200"
                      :class="tile.raisedHandPosition ? 'top-14' : 'top-2'"
                      :data-testid="`calldock-remote-share-badge-${tile.sid}`"
                    >
                      {{ callStore.remoteScreenShareReceiveEnabled ? 'Sharing screen' : 'Screen share paused' }}
                    </div>
                    <div
                      v-if="tile.raisedHandPosition"
                      class="absolute left-2 top-2 z-10 flex h-10 items-center gap-1.5 rounded-lg border border-amber-300/60 bg-amber-400/90 px-2.5 text-lg font-bold text-slate-950 shadow-lg"
                      :aria-label="`Raised hand position ${tile.raisedHandPosition}`"
                      :data-testid="`calldock-remote-hand-${tile.sid}-${tile.raisedHandPosition}`"
                    >
                      <span class="text-2xl leading-none" aria-hidden="true">✋</span>
                      <span>{{ tile.raisedHandPosition }}</span>
                    </div>
                    <div
                      v-if="tile.reactionEmoji"
                      class="absolute right-2 bottom-9 z-10 flex h-8 w-8 items-center justify-center rounded-full border border-white/30 bg-black/65 text-lg shadow-lg"
                      role="status"
                      :aria-label="`${tile.name} reacted ${tile.reactionEmoji}`"
                      :data-testid="`calldock-remote-reaction-${tile.sid}`"
                    >
                      <span aria-hidden="true">{{ tile.reactionEmoji }}</span>
                    </div>
                    <div
                      v-if="tile.screenShareOn"
                      class="absolute top-1.5 right-1.5 z-10 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100"
                    >
                      <button
                        class="flex h-6 items-center justify-center rounded bg-black/50 px-2 text-[10px] text-white hover:bg-black/80"
                        :title="remoteScreenReceiveToggleTitle"
                        :data-testid="callStore.remoteScreenShareReceiveEnabled ? `calldock-remote-share-tile-stop-${tile.sid}` : `calldock-remote-share-tile-resume-${tile.sid}`"
                        @click.stop="callStore.remoteScreenShareReceiveEnabled ? handleStopRemoteScreenShareForMe() : handleStartRemoteScreenShareForMe()"
                      >
                        {{ callStore.remoteScreenShareReceiveEnabled ? 'Pause' : 'Resume' }}
                      </button>
                      <button
                        class="flex h-6 w-6 items-center justify-center rounded bg-black/50 text-white hover:bg-black/80"
                        :title="remoteScreenViewerToggleTitle"
                        :data-testid="`calldock-remote-share-tile-toggle-${tile.sid}`"
                        @click.stop="toggleRemoteScreenPresentationMode()"
                      >
                        <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                          <path d="M15 3h6v6M9 21L21 3M21 9V3h-6"/>
                        </svg>
                      </button>
                    </div>
                    <button
                      v-else
                      class="absolute top-1.5 right-1.5 z-10 flex h-6 w-6 items-center justify-center rounded bg-black/50 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/80"
                      title="Pin to full view"
                      @click.stop="pinTile(tile.sid)"
                    >
                      <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                        <path d="M15 3h6v6M9 21L21 3M21 9V3h-6"/>
                      </svg>
                    </button>
                  </div>

              </div>
            </template>

            <canvas
              ref="annotationCanvasEl"
              data-testid="calldock-annotation-overlay"
              :data-surface-kind="annotationSurfaceKind || 'none'"
              :data-active-segments="annotationActiveSegmentCount"
              :data-fading-segments="annotationFadingSegmentCount"
              :class="annotationCanvasClass"
              @pointerdown="handleAnnotationPointerDown"
              @pointermove="handleAnnotationPointerMove"
              @pointerup="handleAnnotationPointerUp"
              @pointercancel="handleAnnotationPointerCancel"
            />

          </div>
        </div>

        <!-- Error / audio blocked banners -->
        <div v-if="callStore.errorMessage" class="rounded-lg border border-red-400/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          {{ callStore.errorMessage }}
        </div>
        <div v-if="inputDeviceError" class="rounded-lg border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
          {{ inputDeviceError }}
        </div>
        <div v-if="callStore.playbackBlocked" class="rounded-lg border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
          <div class="mb-2">Audio playback is blocked by the browser.</div>
          <button class="rounded bg-amber-500/80 px-2 py-1 text-xs text-white hover:bg-amber-500" @click="handleEnableAudio">
            Enable audio
          </button>
        </div>

        <!-- Controls bar — icon-only buttons -->
        <div class="relative flex items-center justify-center gap-2 py-1 shrink-0">

          <!-- Microphone + arrow selector -->
          <div ref="inputSelectorWrapEl" class="relative">
            <div class="flex h-10 items-center overflow-hidden rounded-xl border border-chat-border bg-chat-input">
              <button
                class="flex h-10 w-10 items-center justify-center transition-colors"
                :class="callStore.micEnabled ? 'text-app-text hover:bg-chat-msgHover' : 'text-app-danger hover:bg-app-danger/10'"
                :title="callStore.micEnabled ? 'Mute microphone' : 'Unmute microphone'"
                @click="handleToggleMute"
              >
                <svg v-if="callStore.micEnabled" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8"/>
                </svg>
                <svg v-else class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                  <line x1="1" y1="1" x2="23" y2="23"/>
                  <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23M12 19v3M8 23h8"/>
                </svg>
              </button>
              <div class="h-6 w-px bg-chat-border" />
              <button
                class="flex h-10 w-8 items-center justify-center text-app-secondaryText transition-colors hover:bg-chat-msgHover disabled:cursor-not-allowed disabled:opacity-60"
                title="Select input device"
                data-testid="calldock-input-device-toggle"
                :disabled="inputDeviceLoading || inputDeviceSwitching || !callStore.connected"
                @pointerdown="logInputSelectorPointerDown"
                @click="toggleInputDeviceMenu"
              >
                <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                  <path d="M6 15l6-6 6 6" />
                </svg>
              </button>
            </div>

            <div
              v-if="inputDeviceMenuOpen"
              class="absolute bottom-[calc(100%+8px)] left-0 z-30 w-64 rounded-xl border border-chat-border bg-chat-header shadow-2xl"
              data-testid="calldock-input-device-menu"
            >
              <button
                class="w-full truncate px-3 py-2 text-left text-xs transition-colors hover:bg-chat-msgHover"
                :class="selectedInputDeviceId === '' ? 'text-accent' : 'text-app-text'"
                data-testid="calldock-input-device-option-default"
                @click="handleInputDeviceSelect('')"
              >
                System mic
              </button>
              <button
                v-for="device in inputDevices"
                :key="device.deviceId"
                class="w-full truncate px-3 py-2 text-left text-xs transition-colors hover:bg-chat-msgHover"
                :class="selectedInputDeviceId === device.deviceId ? 'text-accent' : 'text-app-text'"
                :data-testid="`calldock-input-device-option-${device.deviceId}`"
                @click="handleInputDeviceSelect(device.deviceId)"
              >
                {{ labelInputDevice(device) }}
              </button>
            </div>
          </div>

          <!-- Raise / lower hand -->
          <button
            class="flex h-10 w-10 items-center justify-center rounded-xl border transition-colors disabled:cursor-not-allowed disabled:opacity-60"
            :class="callStore.localHandRaised
              ? 'border-amber-300/70 bg-amber-400/90 text-slate-950 hover:bg-amber-300'
              : 'border-chat-border bg-chat-input text-app-text hover:bg-chat-msgHover'"
            :title="callStore.localHandRaised ? 'Lower hand' : 'Raise hand'"
            :aria-label="callStore.localHandRaised ? 'Lower hand' : 'Raise hand'"
            :aria-pressed="callStore.localHandRaised"
            :disabled="callStore.handActionInFlight || !callStore.connected"
            data-testid="calldock-raise-hand"
            @click="handleToggleHandRaised"
          >
            <span class="text-2xl leading-none" aria-hidden="true">✋</span>
          </button>

          <!-- Call reactions -->
          <div ref="reactionPickerWrapEl" class="relative">
            <button
              class="flex h-10 w-10 items-center justify-center rounded-xl border border-chat-border bg-chat-input text-app-text transition-colors hover:bg-chat-msgHover disabled:cursor-not-allowed disabled:opacity-60"
              title="Reactions"
              aria-label="Reactions"
              aria-haspopup="menu"
              :aria-expanded="reactionPickerOpen"
              :disabled="!callStore.connected"
              data-testid="calldock-reactions-toggle"
              @click="toggleReactionPicker"
            >
              <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M8.5 10h.01M15.5 10h.01" />
                <path d="M8.5 14.5c.9 1 2.1 1.5 3.5 1.5s2.6-.5 3.5-1.5" />
              </svg>
            </button>
            <div
              v-if="reactionPickerOpen"
              class="absolute bottom-[calc(100%+8px)] left-1/2 z-30 flex -translate-x-1/2 gap-1 rounded-xl border border-chat-border bg-chat-header p-1.5 shadow-2xl"
              role="menu"
              aria-label="Call reactions"
              data-testid="calldock-reactions-picker"
            >
              <button
                v-for="reaction in reactionOptions"
                :key="reaction.emoji"
                class="flex h-8 w-8 items-center justify-center rounded-lg text-lg transition-colors hover:bg-chat-msgHover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                type="button"
                role="menuitem"
                :aria-label="`Send ${reaction.label} reaction`"
                :data-testid="`calldock-reaction-${reaction.emoji}`"
                @click="handleReactionSelect(reaction.emoji)"
              >
                <span aria-hidden="true">{{ reaction.emoji }}</span>
              </button>
            </div>
          </div>

          <!-- Camera -->
          <button
            class="flex h-10 w-10 items-center justify-center rounded-xl border transition-colors"
            :class="callStore.cameraEnabled
              ? 'border-chat-border bg-chat-input hover:bg-chat-msgHover text-app-text'
              : 'border-chat-border bg-chat-input hover:bg-app-danger/10 text-app-danger'"
            :title="callStore.cameraEnabled ? 'Turn off camera' : 'Turn on camera'"
            @click="handleToggleCamera"
          >
            <!-- Camera on -->
            <svg v-if="callStore.cameraEnabled" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path d="M23 7l-7 5 7 5V7z"/>
              <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
            </svg>
            <!-- Camera off -->
            <svg v-else class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10"/>
              <line x1="1" y1="1" x2="23" y2="23"/>
            </svg>
          </button>

          <!-- Screen share -->
          <button
            class="flex h-10 w-10 items-center justify-center rounded-xl border transition-colors"
            :class="[
              callStore.screenShareEnabled
                ? 'border-emerald-500/50 bg-emerald-600/80 hover:bg-emerald-600 text-white'
                : 'border-chat-border bg-chat-input text-app-text',
              !callStore.screenShareEnabled && callStore.remoteScreenShareActive
                ? 'opacity-50 cursor-not-allowed'
                : !callStore.screenShareEnabled ? 'hover:bg-chat-msgHover' : '',
            ]"
            :title="!callStore.screenShareEnabled && callStore.remoteScreenShareActive
              ? 'Someone is already sharing their screen'
              : callStore.screenShareEnabled ? 'Stop sharing screen' : 'Share screen'"
            :disabled="!callStore.screenShareEnabled && callStore.remoteScreenShareActive"
            @click="handleToggleScreenShare"
          >
            <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <rect x="2" y="3" width="20" height="14" rx="2"/>
              <path d="M8 21h8M12 17v4"/>
              <polyline v-if="callStore.screenShareEnabled" points="17 8 12 3 7 8"/>
              <line v-if="callStore.screenShareEnabled" x1="12" y1="3" x2="12" y2="15"/>
              <polyline v-else points="12 8 12 13 15 10"/>
            </svg>
          </button>

          <!-- Screen annotation -->
          <button
            class="flex h-10 w-10 items-center justify-center rounded-xl border border-chat-border transition-colors"
            data-testid="calldock-annotation-toggle"
            :class="[
              annotationDrawMode
                ? 'bg-amber-500/80 text-white hover:bg-amber-500'
                : 'bg-chat-input text-app-text hover:bg-chat-msgHover',
              !annotationCanDraw ? 'opacity-50 cursor-not-allowed' : '',
            ]"
            :title="annotationToggleTitle"
            :disabled="!annotationCanDraw"
            @click="toggleAnnotationDrawMode"
          >
            <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path d="M12 20h9"/>
              <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>
            </svg>
          </button>

          <!-- Invite members -->
          <button
            class="flex h-10 items-center justify-center gap-1.5 rounded-xl border border-chat-border px-3 transition-colors bg-chat-input text-app-text hover:bg-chat-msgHover"
            title="Invite members"
            data-testid="calldock-invite-button"
            :disabled="inviteLoading || inviteSubmitting"
            :class="inviteLoading || inviteSubmitting ? 'opacity-60 cursor-not-allowed' : ''"
            @click="openInviteDialog"
          >
            <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <path d="M19 8v6M16 11h6"/>
            </svg>
            <span class="text-xs font-medium">Invite</span>
          </button>

          <!-- End call -->
          <button
            class="flex h-10 w-10 items-center justify-center rounded-xl border border-red-400/50 bg-red-500/90 hover:bg-red-500 text-white transition-colors"
            title="Leave call"
            @click="handleLeave"
          >
            <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.4 12.4 0 0 0 2.53.59A2 2 0 0 1 22 16.84V19a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.26 11 19.8 19.8 0 0 1 1.18 2.37 2 2 0 0 1 3.16 0H5.5a2 2 0 0 1 2 1.72 12.4 12.4 0 0 0 .57 2.57 2 2 0 0 1-.45 2.11L6.35 7.67a16 16 0 0 0 4.33 5.64z"/>
              <line x1="1" y1="1" x2="23" y2="23"/>
            </svg>
          </button>

          <!-- Mute hotkey hint -->
          <span class="absolute right-0 flex items-center gap-1 text-[10px] text-app-muted select-none pointer-events-none">
            <kbd class="rounded border border-chat-border bg-chat-input px-1 py-0.5 font-mono leading-none">⌘D</kbd>
            <span>mute</span>
          </span>

        </div>

      </div>
    </section>

    <!-- Hidden audio host for remote audio tracks -->
    <div ref="remoteAudioHostEl" class="pointer-events-none absolute -left-[9999px] h-0 w-0 overflow-hidden" aria-hidden="true" />
  </div>

  <Teleport to="body">
    <div
      v-if="isVisible && inviteDialogOpen"
      class="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4"
      data-testid="calldock-invite-modal"
      @click.self="closeInviteDialog"
    >
      <div class="w-full max-w-md overflow-hidden rounded-xl border border-chat-border bg-chat-header text-app-text shadow-2xl">
        <div class="border-b border-chat-border px-4 py-3">
          <div class="text-sm font-semibold text-app-text">Invite members to call</div>
          <div class="mt-1 text-xs text-app-muted">Select members and send invite notifications.</div>
        </div>

        <div v-if="inviteError" class="border-b border-chat-border px-4 py-2 text-xs text-app-danger">
          {{ inviteError }}
        </div>
        <div v-if="inviteResultSummary" class="border-b border-chat-border px-4 py-2 text-xs text-app-success">
          {{ inviteResultSummary }}
        </div>

        <div class="border-b border-chat-border px-4 py-3">
          <input
            v-model="inviteSearch"
            type="text"
            data-testid="calldock-invite-search"
            placeholder="Search by nickname or email..."
            class="w-full rounded border border-chat-border bg-chat-input px-3 py-2 text-sm text-app-text placeholder-app-muted outline-none focus:border-accent"
            autofocus
          >
        </div>

        <div class="max-h-72 overflow-y-auto">
          <div v-if="inviteLoading" class="px-4 py-6 text-center text-xs text-app-muted">
            Loading members...
          </div>
          <div v-else-if="inviteCandidates.length === 0" class="px-4 py-6 text-center text-xs text-app-muted">
            No members are available to invite.
          </div>
          <div v-else-if="filteredInviteCandidates.length === 0" class="px-4 py-6 text-center text-xs text-app-muted">
            No members match your search.
          </div>
          <template v-else>
            <button
              v-for="candidate in filteredInviteCandidates"
              :key="candidate.userId"
              :data-testid="`calldock-invite-candidate-${candidate.userId}`"
              class="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-chat-msgHover"
              @click="toggleInviteCandidate(candidate.userId)"
            >
              <input
                type="checkbox"
                class="h-4 w-4"
                :checked="selectedInviteeIds.includes(candidate.userId)"
                @click.stop
                @change="toggleInviteCandidate(candidate.userId)"
              >
              <UserAvatar
                :user-id="candidate.userId"
                :display-name="candidate.displayName || candidate.email"
                :avatar-url="candidate.avatarUrl"
                size="sm"
              />
              <div class="min-w-0">
                <div class="truncate text-sm text-app-text">{{ candidate.displayName || candidate.email }}</div>
                <div class="truncate text-xs text-app-muted">{{ candidate.email }}</div>
              </div>
            </button>
          </template>
        </div>

        <div class="flex justify-end gap-2 border-t border-chat-border px-4 py-3">
          <button class="rounded px-3 py-1.5 text-xs text-app-secondaryText hover:bg-chat-msgHover" @click="closeInviteDialog">
            Close
          </button>
          <button
            class="rounded bg-accent px-3 py-1.5 text-xs text-app-onAccent hover:bg-accent-hover disabled:opacity-50"
            data-testid="calldock-send-invites"
            :disabled="inviteLoading || inviteSubmitting || selectedInviteeIds.length === 0"
            @click="sendCallInvites"
          >
            {{ inviteSubmitting ? 'Sending...' : 'Send invites' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>

  <BusyCallConfirmDialog
    :open="busyCallConfirmOpen"
    :user-names="busyCallConfirmNames"
    confirm-label="Send invites"
    @cancel="cancelBusyCallConfirm"
    @confirm="confirmBusyCallInvites"
  />
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, toRaw, watch, watchEffect, type CSSProperties } from 'vue'
import { Track } from 'livekit-client'
import { useCallStore, type CallReactionEmoji, type ScreenAnnotationEvent, type ScreenAnnotationSegmentV1 } from '@/stores/call'
import { useChatStore } from '@/stores/chat'
import { useAuthStore } from '@/stores/auth'
import { listDmCandidates, type DmCandidateItem } from '@/services/http/chatApi'
import { loadAudioPrefs } from '@/services/storage/audioPrefsStorage'
import { matchesCallInviteSearch, normalizeCallInviteSearchQuery } from '@/utils/callInviteSearch'
import { resolveScreenAnnotationStrokeColor } from '@/utils/color'
import { useFloatingDockPosition } from '@/composables/useFloatingDockPosition'
import UserAvatar from './UserAvatar.vue'
import BusyCallConfirmDialog from './BusyCallConfirmDialog.vue'

// ── Types ─────────────────────────────────────────────────────────────────────

type AttachableMediaTrack = {
  sid: string
  kind: string
  attach: (el?: HTMLMediaElement) => HTMLMediaElement
  detach: (el?: HTMLMediaElement) => HTMLMediaElement[]
}

interface ParticipantTile {
  sid: string
  identity: string
  name: string
  avatarUrl?: string
  isLocal: boolean
  cameraOn: boolean
  screenShareOn: boolean
  micOn: boolean
  isSpeaking: boolean
  raisedHandPosition?: number
  reactionEmoji?: CallReactionEmoji
}

interface InviteCandidate {
  userId: string
  displayName: string
  email: string
  avatarUrl: string
}

interface NormalizedPoint {
  x: number
  y: number
}

interface OverlayRect {
  left: number
  top: number
  width: number
  height: number
}

interface AnnotationSurfaceGeometry {
  kind: 'remote' | 'local' | 'pinned'
  trackSid: string
  videoRect: OverlayRect
  contentRect: OverlayRect
}

interface RenderedAnnotationSegment extends ScreenAnnotationEvent {
  key: string
  color: string
  expiresAtMs: number
}

interface RenderedAnnotationStrokeGroup {
  key: string
  color: string
  alpha: number
  points: NormalizedPoint[]
}

interface ActiveAnnotationStroke {
  pointerId: number
  strokeId: string
  seq: number
  shareTrackSid: string
  lastPoint: NormalizedPoint
}

interface PausedRemoteScreenFrame {
  participantSid: string
  trackSid: string
  imageDataUrl: string
}

const reactionOptions: ReadonlyArray<{ emoji: CallReactionEmoji; label: string }> = [
  { emoji: '👍', label: 'thumbs up' },
  { emoji: '👏', label: 'clapping' },
  { emoji: '❤️', label: 'heart' },
  { emoji: '😂', label: 'laughing' },
  { emoji: '🎉', label: 'celebration' },
  { emoji: '😮', label: 'surprised' },
]

const ANNOTATION_SEGMENT_TTL_MS = 20_000
const ANNOTATION_SEGMENT_FADE_MS = 300
const ANNOTATION_STROKE_WIDTH_PX = 3

// ── Stores ────────────────────────────────────────────────────────────────────

const callStore = useCallStore()
const chatStore = useChatStore()
const authStore = useAuthStore()

// ── DOM unwrap helper ─────────────────────────────────────────────────────────
// LiveKit's track.attach(el) calls el.play() internally. Vue can wrap refs in
// a Proxy, making .play() non-callable. Always unwrap to the raw DOM node.
function unwrapEl<T extends HTMLElement>(el: T | null | undefined): T | null {
  if (!el) return null
  if (el instanceof HTMLElement) return el
  const raw = toRaw(el) as T
  return raw instanceof HTMLElement ? raw : null
}

// ── Refs ──────────────────────────────────────────────────────────────────────

const localVideoEl = ref<HTMLVideoElement | null>(null)   // local camera
const localScreenEl = ref<HTMLVideoElement | null>(null)  // local screen share
const remoteScreenEl = ref<HTMLVideoElement | null>(null) // remote screen share (always mounted)
const pinnedVideoEl = ref<HTMLVideoElement | null>(null)  // pinned full-stage view
const stageEl = ref<HTMLDivElement | null>(null)
const annotationCanvasEl = ref<HTMLCanvasElement | null>(null)
const remoteAudioHostEl = ref<HTMLDivElement | null>(null)
const inputSelectorWrapEl = ref<HTMLDivElement | null>(null)
const reactionPickerWrapEl = ref<HTMLDivElement | null>(null)
const minimizedDockEl = ref<HTMLElement | null>(null)
const expandedDockEl = ref<HTMLElement | null>(null)
const maximized = ref(false)
const pinnedSid = ref<string | null>(null)
const inviteDialogOpen = ref(false)
const inviteCandidates = ref<InviteCandidate[]>([])
const inviteSearch = ref('')
const selectedInviteeIds = ref<string[]>([])
const inviteLoading = ref(false)
const inviteSubmitting = ref(false)
const inviteError = ref('')
const inviteResultSummary = ref('')
const busyCallConfirmOpen = ref(false)
const busyCallConfirmNames = ref<string[]>([])
const inputDevices = ref<MediaDeviceInfo[]>([])
const selectedInputDeviceId = ref(loadAudioPrefs().inputDeviceId)
const inputDeviceLoading = ref(false)
const inputDeviceSwitching = ref(false)
const inputDeviceError = ref('')
const inputDeviceMenuOpen = ref(false)
const reactionPickerOpen = ref(false)
const annotationDrawMode = ref(false)
const annotationActiveSegmentCount = ref(0)
const annotationFadingSegmentCount = ref(0)
const remoteScreenPresentationMode = ref<'stage' | 'tile'>('stage')
const pausedRemoteScreenFrame = ref<PausedRemoteScreenFrame | null>(null)

// Imperative track attachment state (not reactive — lives outside Vue reactivity)
let attachedLocalCameraTrack: AttachableMediaTrack | null = null
let attachedLocalScreenTrack: AttachableMediaTrack | null = null
let attachedRemoteScreenTrack: { track: AttachableMediaTrack; element: HTMLVideoElement } | null = null
let attachedPinnedTrack: AttachableMediaTrack | null = null
const attachedRemoteAudio = new Map<string, { track: AttachableMediaTrack; element: HTMLMediaElement }>()
const attachedRemoteCamera = new Map<string, { track: AttachableMediaTrack; element: HTMLVideoElement }>()

// Remote video element refs set by :ref callback in v-for
const remoteTileEls = new Map<string, HTMLVideoElement | null>()

const remoteScreenOwnerLabel = ref('Screen share')
const annotationSegments: RenderedAnnotationSegment[] = []
const annotationSegmentKeys = new Set<string>()
let annotationRenderFrame: number | null = null
let annotationStrokeCounter = 0
let activeAnnotationStroke: ActiveAnnotationStroke | null = null
let canvas2dSupported: boolean | null = null
let inputDeviceChangeListener: (() => void) | null = null

const floatingDockPosition = useFloatingDockPosition()

// ── Debug ─────────────────────────────────────────────────────────────────────

const CALL_DEBUG_STORAGE_KEY = 'debug.calls'

function isCallDebugEnabled(): boolean {
  const envEnabled = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_CALL_DEBUG === '1'
  if (envEnabled) return true
  try { return globalThis.localStorage?.getItem(CALL_DEBUG_STORAGE_KEY) === '1' } catch { return false }
}

function callDebug(message: string, payload?: unknown) {
  if (!isCallDebugEnabled()) return
  if (typeof payload === 'undefined') { console.info(`[call-debug] ${message}`); return }
  console.info(`[call-debug] ${message}`, payload)
}

function isScreenSource(source: unknown): boolean {
  return String(source ?? '').toLowerCase().includes('screen')
}

function mediaDevicesOrNull(): MediaDevices | null {
  if (typeof navigator === 'undefined') return null
  return navigator.mediaDevices ?? null
}

function labelInputDevice(device: MediaDeviceInfo): string {
  return device.label || `Microphone (${device.deviceId.slice(0, 8)}…)`
}

function inputDeviceLog(message: string, payload?: unknown) {
  if (typeof payload === 'undefined') {
    console.info(`[call-input-device] ${message}`)
    return
  }
  console.info(`[call-input-device] ${message}`, payload)
}

function logInputSelectorPointerDown() {
  inputDeviceLog('selector pointerdown', {
    connected: callStore.connected,
    loading: inputDeviceLoading.value,
    switching: inputDeviceSwitching.value,
    disabled: inputDeviceLoading.value || inputDeviceSwitching.value || !callStore.connected,
    knownInputDevices: inputDevices.value.length,
    selectedInputDeviceId: selectedInputDeviceId.value || 'default',
  })
}

async function toggleInputDeviceMenu() {
  const nextOpen = !inputDeviceMenuOpen.value
  inputDeviceLog('toggle input selector menu', {
    nextOpen,
    connected: callStore.connected,
    loading: inputDeviceLoading.value,
    switching: inputDeviceSwitching.value,
    knownInputDevices: inputDevices.value.length,
  })
  inputDeviceMenuOpen.value = nextOpen
  if (nextOpen) {
    await refreshInputDevices('menu-open')
  }
}

function detachInputDeviceChangeListener() {
  const mediaDevices = mediaDevicesOrNull()
  if (!mediaDevices || !inputDeviceChangeListener) return
  mediaDevices.removeEventListener('devicechange', inputDeviceChangeListener)
  inputDeviceLog('detached mediaDevices.devicechange listener')
  inputDeviceChangeListener = null
}

function ensureInputDeviceChangeListener() {
  const mediaDevices = mediaDevicesOrNull()
  if (!mediaDevices || inputDeviceChangeListener) return
  inputDeviceChangeListener = () => {
    inputDeviceLog('mediaDevices.devicechange fired')
    void refreshInputDevices('devicechange')
  }
  mediaDevices.addEventListener('devicechange', inputDeviceChangeListener)
  inputDeviceLog('attached mediaDevices.devicechange listener')
}

async function refreshInputDevices(trigger: string = 'manual') {
  const mediaDevices = mediaDevicesOrNull()
  inputDeviceLog('refresh start', {
    trigger,
    connected: callStore.connected,
    loading: inputDeviceLoading.value,
    switching: inputDeviceSwitching.value,
  })
  if (!mediaDevices || typeof mediaDevices.enumerateDevices !== 'function') {
    inputDevices.value = []
    inputDeviceError.value = 'Input device selection is unavailable on this platform.'
    console.warn('[call-input-device] refresh aborted: enumerateDevices unavailable')
    return
  }

  inputDeviceLoading.value = true
  inputDeviceError.value = ''
  try {
    const devices = await mediaDevices.enumerateDevices()
    inputDevices.value = devices.filter(device => device.kind === 'audioinput')
    inputDeviceLog('enumerated input devices', {
      trigger,
      totalDevices: devices.length,
      inputDevices: inputDevices.value.length,
      labelsAvailable: inputDevices.value.filter(device => Boolean(device.label)).length,
    })

    const savedInputDeviceId = loadAudioPrefs().inputDeviceId
    if (savedInputDeviceId && !inputDevices.value.some(device => device.deviceId === savedInputDeviceId)) {
      selectedInputDeviceId.value = ''
      inputDeviceError.value = 'Selected microphone is unavailable. Using system default.'
      console.warn('[call-input-device] saved device missing, fallback to system default', {
        trigger,
        savedInputDeviceId,
      })
      return
    }
    selectedInputDeviceId.value = savedInputDeviceId
    inputDeviceLog('refresh success', {
      trigger,
      selectedInputDeviceId: selectedInputDeviceId.value || 'default',
    })
  } catch (err) {
    inputDevices.value = []
    inputDeviceError.value = err instanceof Error ? err.message : 'Failed to load input devices.'
    console.warn('[call-input-device] refresh failed', {
      trigger,
      error: err instanceof Error ? err.message : String(err),
    })
  } finally {
    inputDeviceLoading.value = false
    inputDeviceLog('refresh end', {
      trigger,
      loading: inputDeviceLoading.value,
      error: inputDeviceError.value || '',
    })
  }
}

async function handleInputDeviceSelect(deviceId: string) {
  const nextDeviceId = deviceId.trim()
  const previousDeviceId = selectedInputDeviceId.value
  if (nextDeviceId === previousDeviceId) {
    inputDeviceLog('change ignored (same selection)', {
      selectedInputDeviceId: nextDeviceId || 'default',
    })
    inputDeviceMenuOpen.value = false
    return
  }

  inputDeviceLog('change requested', {
    from: previousDeviceId || 'default',
    to: nextDeviceId || 'default',
    connected: callStore.connected,
    micEnabled: callStore.micEnabled,
  })

  selectedInputDeviceId.value = nextDeviceId
  inputDeviceSwitching.value = true
  inputDeviceError.value = ''
  try {
    await callStore.switchInputDevice(nextDeviceId)
    inputDeviceLog('switchInputDevice resolved', {
      selectedInputDeviceId: nextDeviceId || 'default',
    })
    await refreshInputDevices('post-change')
    inputDeviceMenuOpen.value = false
  } catch (err) {
    selectedInputDeviceId.value = previousDeviceId
    inputDeviceError.value = err instanceof Error ? err.message : 'Failed to switch microphone.'
    console.warn('[call-input-device] switchInputDevice failed', {
      from: previousDeviceId || 'default',
      to: nextDeviceId || 'default',
      error: err instanceof Error ? err.message : String(err),
    })
  } finally {
    inputDeviceSwitching.value = false
    inputDeviceLog('change end', {
      selectedInputDeviceId: selectedInputDeviceId.value || 'default',
      switching: inputDeviceSwitching.value,
      error: inputDeviceError.value || '',
    })
  }
}

function toggleReactionPicker() {
  reactionPickerOpen.value = !reactionPickerOpen.value
  if (reactionPickerOpen.value) inputDeviceMenuOpen.value = false
}

async function handleReactionSelect(emoji: CallReactionEmoji) {
  reactionPickerOpen.value = false
  try {
    await callStore.sendCallReaction(emoji)
  } catch {
    // The local reaction is optimistic; the store handles its short lifetime.
  }
}

function handleDocumentPointerDown(event: PointerEvent) {
  const target = event.target instanceof Node ? event.target : null
  if (!target) return

  if (inputDeviceMenuOpen.value) {
    const inputWrap = unwrapEl(inputSelectorWrapEl.value)
    if (inputWrap && !inputWrap.contains(target)) {
      inputDeviceMenuOpen.value = false
      inputDeviceLog('closed input selector menu (outside click)')
    }
  }

  if (reactionPickerOpen.value) {
    const reactionWrap = unwrapEl(reactionPickerWrapEl.value)
    if (reactionWrap && !reactionWrap.contains(target)) {
      reactionPickerOpen.value = false
    }
  }
}

// ── Computed layout ───────────────────────────────────────────────────────────

const isVisible = computed(() => callStore.connected || callStore.connecting || Boolean(callStore.errorMessage))

const filteredInviteCandidates = computed(() => {
  const query = normalizeCallInviteSearchQuery(inviteSearch.value)
  if (!query) return inviteCandidates.value
  return inviteCandidates.value.filter(candidate => matchesCallInviteSearch(candidate, query))
})

const containerClass = computed(() =>
  maximized.value ? 'fixed inset-0 z-50' : 'fixed inset-0 z-50 pointer-events-none'
)

const panelClass = computed(() =>
  maximized.value
    ? 'h-full w-full overflow-hidden rounded-none border-0 bg-chat-header/95 text-app-text flex flex-col'
    : 'w-[min(96vw,640px)] overflow-hidden rounded-2xl border border-chat-border bg-chat-header/95 text-app-text shadow-2xl backdrop-blur'
)

const minimizedDockStyle = computed<CSSProperties>(() => ({
  position: 'absolute',
  pointerEvents: 'auto',
  ...floatingDockPosition.positionStyle('minimized'),
}))

const expandedDockStyle = computed<CSSProperties>(() => (
  maximized.value
    ? {}
    : {
        position: 'absolute',
        pointerEvents: 'auto',
        ...floatingDockPosition.positionStyle('expanded'),
      }
))

const contentClass = computed(() =>
  maximized.value
    ? 'flex-1 p-3 flex flex-col gap-2 min-h-0 overflow-hidden'
    : 'flex flex-col gap-2 p-3'
)

const stageClass = computed(() =>
  // Normal: fixed height so the panel doesn't grow with tile content.
  // Maximized: flex-1 fills all remaining vertical space.
  maximized.value
    ? 'relative flex-1 min-h-0 flex flex-col overflow-hidden rounded-2xl border border-chat-border bg-chat-bg'
    : 'relative h-52 overflow-hidden rounded-2xl border border-chat-border bg-chat-bg'
)

// Tile grid — explicit rows/heights in maximized mode to avoid tile overlap.
const tileGridClass = computed(() => {
  const n = participantTiles.value.length
  if (maximized.value) {
    const base = 'grid gap-2 p-3 h-full min-h-0'
    if (n <= 1) return `${base} grid-cols-1 grid-rows-1`
    if (n === 2) return `${base} grid-cols-2 grid-rows-1`
    if (n <= 4) return `${base} grid-cols-2 grid-rows-2`
    return `${base} grid-cols-3 auto-rows-[minmax(0,1fr)] overflow-y-auto content-start`
  }
  // Normal: grid fills the fixed-height stage; tiles stretch to fill rows
  const base = 'grid gap-1.5 p-1.5 h-full'
  if (n <= 1) return `${base} grid-cols-1`
  if (n === 2) return `${base} grid-cols-2`
  if (n <= 4) return `${base} grid-cols-2 grid-rows-2`
  return `${base} grid-cols-3`
})

const DOCK_DRAG_IGNORE_SELECTOR = 'button, a, input, textarea, select, label, [role="button"], [contenteditable="true"]'

function shouldIgnoreDockDragTarget(event: PointerEvent): boolean {
  const target = event.target instanceof Element ? event.target : null
  return Boolean(target?.closest(DOCK_DRAG_IGNORE_SELECTOR))
}

function syncMinimizedDockRegistration() {
  const dockEl = unwrapEl(minimizedDockEl.value)
  floatingDockPosition.registerElement('minimized', dockEl)
}

function syncExpandedDockRegistration() {
  const dockEl = maximized.value ? null : unwrapEl(expandedDockEl.value)
  floatingDockPosition.registerElement('expanded', dockEl)
}

function handleMinimizedDockPointerDown(event: PointerEvent) {
  if (shouldIgnoreDockDragTarget(event)) return
  floatingDockPosition.startDrag('minimized', event)
}

function handleExpandedDockPointerDown(event: PointerEvent) {
  if (maximized.value) return
  if (shouldIgnoreDockDragTarget(event)) return
  floatingDockPosition.startDrag('expanded', event)
}

// ── Participant tiles ─────────────────────────────────────────────────────────

const participantTiles = computed<ParticipantTile[]>(() => {
  callStore.mediaVersion // reactive dependency on topology changes

  const currentRoom = callStore.room
  const speakerSids = callStore.activeSpeakerSids
  const raisedHandPositions = new Map(callStore.raisedHands.map(hand => [hand.userId, hand.position]))

  const localName = (currentRoom?.localParticipant.name ?? '').trim()
    || authStore.user?.displayName?.trim()
    || authStore.user?.email?.trim()
    || chatStore.workspace?.selfDisplayName?.trim()
    || 'You'

  const localParticipant = currentRoom?.localParticipant
  const localCameraPub = localParticipant?.getTrackPublication(Track.Source.Camera)
  const localScreenPub = localParticipant?.getTrackPublication(Track.Source.ScreenShare)
  const localMicPub = localParticipant?.getTrackPublication(Track.Source.Microphone)

  const tiles: ParticipantTile[] = []

  tiles.push({
    sid: localParticipant?.sid ?? 'local',
    identity: localParticipant?.identity ?? '',
    name: localName,
    avatarUrl: authStore.user?.avatarUrl ?? chatStore.workspace?.selfAvatarUrl ?? '',
    isLocal: true,
    cameraOn: callStore.cameraEnabled && Boolean(localCameraPub?.track) && !localCameraPub?.isMuted,
    screenShareOn: callStore.screenShareEnabled && Boolean(localScreenPub?.track) && !localScreenPub?.isMuted,
    micOn: callStore.micEnabled && Boolean(localMicPub?.track) && !localMicPub?.isMuted,
    isSpeaking: Boolean(localParticipant && speakerSids.has(localParticipant.sid)),
    raisedHandPosition: raisedHandPositions.get(localParticipant?.identity ?? ''),
    reactionEmoji: callStore.reactionsByParticipantId[localParticipant?.identity ?? '']?.emoji,
  })

  if (!currentRoom) return tiles

  for (const participant of currentRoom.remoteParticipants.values()) {
    const name = (participant.name ?? '').trim()
      || chatStore.resolveDisplayName(participant.identity)
      || participant.identity.slice(0, 8)
    const cameraPub = participant.getTrackPublication(Track.Source.Camera)
    const micPub = participant.getTrackPublication(Track.Source.Microphone)

    tiles.push({
      sid: participant.sid,
      identity: participant.identity,
      name,
      avatarUrl: chatStore.resolveAvatarUrl(participant.identity),
      isLocal: false,
      cameraOn: Boolean(cameraPub?.isSubscribed && cameraPub?.track && !cameraPub?.isMuted),
      screenShareOn: participant.sid === remoteScreenTileSid.value,
      micOn: Boolean(micPub?.isSubscribed && micPub?.track && !micPub?.isMuted),
      isSpeaking: speakerSids.has(participant.sid),
      raisedHandPosition: raisedHandPositions.get(participant.identity),
      reactionEmoji: callStore.reactionsByParticipantId[participant.identity]?.emoji,
    })
  }

  return tiles
})

const localTile = computed(() => participantTiles.value.find(t => t.isLocal) ?? null)
const remoteTiles = computed(() => participantTiles.value.filter(t => !t.isLocal))

// Tile wrapper class — always constrained to its grid cell.
const tileItemClass = computed(() =>
  maximized.value
    ? 'group relative h-full min-h-0 overflow-hidden rounded-xl bg-chat-input'
    : 'group relative overflow-hidden rounded-xl bg-chat-input'
)

const fallbackAvatarClass = computed(() =>
  // Keep fallback avatars circular while filling most of the tile in all sizes.
  '!h-[90%] !w-auto !aspect-square !max-w-[90%]'
)

// ── Pin / fullscreen helpers ──────────────────────────────────────────────────

const pinnedTile = computed(() =>
  participantTiles.value.find(t => t.sid === pinnedSid.value) ?? null
)

const pinnedTileName = computed(() => pinnedTile.value?.name ?? '')

const pinnedTileHasVideo = computed(() => {
  const tile = pinnedTile.value
  if (!tile) return false
  return tile.cameraOn || tile.screenShareOn
})

function resolveLocalScreenShareTrackSid(): string {
  const currentRoom = callStore.room
  if (!currentRoom) return ''
  const publication = currentRoom.localParticipant.getTrackPublication(Track.Source.ScreenShare)
  if (!publication?.track || publication.isMuted) return ''
  return publication.track.sid ?? ''
}

function resolveRemoteScreenShareSource(options?: { requireTrack?: boolean }) {
  const currentRoom = callStore.room
  if (!currentRoom) return null
  for (const participant of currentRoom.remoteParticipants.values()) {
    for (const publication of participant.videoTrackPublications.values()) {
      if (!isScreenSource(publication.source)) continue
      if (publication.isMuted) continue
      if (options?.requireTrack && (!publication.track || !publication.track.sid)) continue
      const identity = participant.identity ?? ''
      const owner = identity
        ? (chatStore.resolveDisplayName(identity).trim() || identity.slice(0, 8))
        : (participant.name ?? '').trim() || 'Teammate'
      return {
        participantSid: participant.sid,
        participantIdentity: identity,
        ownerLabel: owner,
        publication,
        track: publication.track as AttachableMediaTrack | null,
        trackSid: publication.track?.sid ?? publication.trackSid ?? '',
      }
    }
  }
  return null
}

// Publication-level view of a remote share. This remains truthy while a remote
// participant is sharing even if this viewer has locally paused receiving it.
const availableRemoteScreenShare = computed(() => {
  void callStore.mediaVersion
  return resolveRemoteScreenShareSource()
})

// Live attached remote share for this viewer. This requires local receive to be
// enabled and the publication to currently expose a track.
const activeRemoteScreenShare = computed(() => {
  void callStore.mediaVersion
  if (!callStore.remoteScreenShareReceiveEnabled) return null
  const source = resolveRemoteScreenShareSource({ requireTrack: true })
  if (!source?.track) return null
  return source
})

const activeRemoteScreenShareTrackSid = computed(() => availableRemoteScreenShare.value?.trackSid ?? '')
const activeRemoteScreenShareParticipantSid = computed(() => availableRemoteScreenShare.value?.participantSid ?? '')
const remoteScreenTileSid = computed(() => (
  remoteScreenPresentationMode.value === 'tile' ? activeRemoteScreenShareParticipantSid.value : ''
))
const remoteScreenStagePausedVisible = computed(() => (
  Boolean(availableRemoteScreenShare.value)
  && !callStore.remoteScreenShareReceiveEnabled
  && remoteScreenPresentationMode.value === 'stage'
  && !pinnedSid.value
))
const remoteScreenStageVisible = computed(() => (
  Boolean(activeRemoteScreenShare.value?.trackSid)
  && remoteScreenPresentationMode.value === 'stage'
  && !pinnedSid.value
))
const remoteScreenViewerToggleTitle = computed(() => (
  remoteScreenPresentationMode.value === 'stage'
    ? 'Fit shared screen into the sharer user card'
    : 'Focus the shared screen again'
))
const remoteScreenReceiveToggleTitle = computed(() => (
  callStore.remoteScreenShareReceiveEnabled ? 'Stop shared screen for me' : 'Resume shared screen'
))
const remoteScreenOwnerDisplayLabel = computed(() => (
  availableRemoteScreenShare.value ? `${availableRemoteScreenShare.value.ownerLabel} is sharing` : remoteScreenOwnerLabel.value
))
const remoteScreenPauseFrameSrc = computed(() => {
  const frame = pausedRemoteScreenFrame.value
  const source = availableRemoteScreenShare.value
  if (!frame || !source) return ''
  if (frame.participantSid !== source.participantSid || frame.trackSid !== source.trackSid) return ''
  return frame.imageDataUrl
})

const pinnedScreenShareTrackSid = computed(() => {
  void callStore.mediaVersion
  const sid = pinnedSid.value
  if (!sid) return ''
  const currentRoom = callStore.room
  if (!currentRoom) return ''

  if (sid === currentRoom.localParticipant.sid) {
    return resolveLocalScreenShareTrackSid()
  }
  const participant = Array.from(currentRoom.remoteParticipants.values()).find(item => item.sid === sid)
  if (!participant) return ''
  for (const publication of participant.videoTrackPublications.values()) {
    if (!isScreenSource(publication.source)) continue
    if (
      !publication.isSubscribed
      && callStore.remoteScreenShareReceiveEnabled
      && typeof publication.setSubscribed === 'function'
    ) {
      publication.setSubscribed(true)
    }
    if (!publication.track || publication.isMuted) continue
    return publication.track.sid
  }
  return ''
})

const pinnedScreenShareActive = computed(() => Boolean(pinnedScreenShareTrackSid.value))

const currentScreenShareTrackSid = computed(() => {
  void callStore.mediaVersion
  if (callStore.screenShareEnabled) {
    return resolveLocalScreenShareTrackSid()
  }
  return activeRemoteScreenShare.value?.trackSid ?? ''
})

const annotationSurfaceMeta = computed(() => {
  void callStore.mediaVersion
  if (pinnedSid.value) {
    const trackSid = pinnedScreenShareTrackSid.value
    if (!trackSid) return null
    return { kind: 'pinned' as const, trackSid }
  }
  const remoteTrackSid = activeRemoteScreenShare.value?.trackSid ?? ''
  if (remoteTrackSid) {
    return { kind: 'remote' as const, trackSid: remoteTrackSid }
  }
  const localTrackSid = resolveLocalScreenShareTrackSid()
  if (localTrackSid && callStore.screenShareEnabled) {
    return { kind: 'local' as const, trackSid: localTrackSid }
  }
  return null
})

const annotationSurfaceKind = computed(() => annotationSurfaceMeta.value?.kind ?? '')
const annotationCanRender = computed(() => Boolean(annotationSurfaceMeta.value?.trackSid))
const annotationRenderInCallCanvas = computed(() => (
  callStore.screenShareEnabled && callStore.annotationSessionMode === 'preview-fallback'
))
const annotationCanDraw = computed(() => (
  annotationCanRender.value && callStore.annotationAvailable && !callStore.screenShareEnabled
))
const annotationToggleTitle = computed(() => {
  if (annotationCanDraw.value) {
    return annotationDrawMode.value ? 'Disable drawing mode' : 'Enable drawing mode'
  }
  if (!annotationCanRender.value) return 'No active shared screen'
  if (callStore.annotationDisabledReason) return callStore.annotationDisabledReason
  if (callStore.screenShareEnabled) return 'Screen sharer cannot draw'
  return annotationDrawMode.value ? 'Disable drawing mode' : 'Enable drawing mode'
})
const annotationCanvasClass = computed(() => (
  annotationCanDraw.value && annotationDrawMode.value
    ? 'absolute inset-0 z-20 touch-none pointer-events-auto cursor-crosshair'
    : 'absolute inset-0 z-20 touch-none pointer-events-none'
))

function pinTile(sid: string) {
  pinnedSid.value = sid
}

function toggleRemoteScreenPresentationMode() {
  remoteScreenPresentationMode.value = remoteScreenPresentationMode.value === 'stage' ? 'tile' : 'stage'
}

function isPausedRemoteScreenTile(sid: string): boolean {
  return !callStore.remoteScreenShareReceiveEnabled
    && remoteScreenPresentationMode.value === 'tile'
    && activeRemoteScreenShareParticipantSid.value === sid
}

function isLiveRemoteScreenTile(sid: string): boolean {
  return callStore.remoteScreenShareReceiveEnabled
    && remoteScreenPresentationMode.value === 'tile'
    && activeRemoteScreenShareParticipantSid.value === sid
}

function clearPausedRemoteScreenFrame() {
  pausedRemoteScreenFrame.value = null
}

function capturePausedRemoteScreenFrame(): string {
  const source = activeRemoteScreenShare.value
  if (!source) return ''
  const video = remoteScreenPresentationMode.value === 'tile'
    ? unwrapEl(remoteTileEls.get(source.participantSid) ?? null)
    : unwrapEl(remoteScreenEl.value)
  if (!video || !video.videoWidth || !video.videoHeight) return ''
  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  const ctx = safeGetCanvasContext(canvas)
  if (!ctx) return ''
  try {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.85)
  } catch {
    return ''
  }
}

function handleStopRemoteScreenShareForMe() {
  const source = activeRemoteScreenShare.value
  if (!source) return
  const imageDataUrl = capturePausedRemoteScreenFrame()
  pausedRemoteScreenFrame.value = {
    participantSid: source.participantSid,
    trackSid: source.trackSid,
    imageDataUrl,
  }
  callStore.stopRemoteScreenShareForMe()
}

function handleStartRemoteScreenShareForMe() {
  clearPausedRemoteScreenFrame()
  callStore.startRemoteScreenShareForMe()
}

function unpinTile() {
  // Detach the pinned track from pinnedVideoEl before clearing
  const video = unwrapEl(pinnedVideoEl.value)
  if (attachedPinnedTrack) {
    attachedPinnedTrack.detach(video ?? undefined)
    attachedPinnedTrack = null
  }
  pinnedSid.value = null
}

// ── Remote tile video element ref setter ──────────────────────────────────────

function setRemoteTileRef(sid: string, el: HTMLVideoElement | null) {
  remoteTileEls.set(sid, unwrapEl(el))
}

function clamp01(value: number): number {
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function annotationSegmentKey(segment: Pick<ScreenAnnotationSegmentV1, 'senderIdentity' | 'strokeId' | 'seq'>): string {
  return `${segment.senderIdentity}:${segment.strokeId}:${segment.seq}`
}

function resolveActiveAnnotationVideoEl(kind: AnnotationSurfaceGeometry['kind']): HTMLVideoElement | null {
  if (kind === 'remote') {
    if (remoteScreenPresentationMode.value === 'tile') {
      return unwrapEl(remoteTileEls.get(activeRemoteScreenShareParticipantSid.value) ?? null)
    }
    return unwrapEl(remoteScreenEl.value)
  }
  if (kind === 'local') return unwrapEl(localScreenEl.value)
  return unwrapEl(pinnedVideoEl.value)
}

function toOverlayRect(videoRect: DOMRect, stageRect: DOMRect): OverlayRect {
  return {
    left: videoRect.left - stageRect.left,
    top: videoRect.top - stageRect.top,
    width: videoRect.width,
    height: videoRect.height,
  }
}

function resolveVideoContentRect(video: HTMLVideoElement, stageRect: DOMRect): OverlayRect | null {
  const videoRect = video.getBoundingClientRect()
  if (videoRect.width <= 0 || videoRect.height <= 0) return null
  const renderedRect = toOverlayRect(videoRect, stageRect)

  const sourceWidth = video.videoWidth || Math.round(videoRect.width)
  const sourceHeight = video.videoHeight || Math.round(videoRect.height)
  if (!sourceWidth || !sourceHeight) return renderedRect

  const fit = getComputedStyle(video).objectFit || 'contain'
  if (fit === 'fill') return renderedRect

  const widthScale = videoRect.width / sourceWidth
  const heightScale = videoRect.height / sourceHeight
  let scale = widthScale
  if (fit === 'cover') {
    scale = Math.max(widthScale, heightScale)
  } else if (fit === 'none') {
    scale = 1
  } else {
    scale = Math.min(widthScale, heightScale)
  }

  const contentWidth = sourceWidth * scale
  const contentHeight = sourceHeight * scale
  return {
    left: renderedRect.left + ((videoRect.width - contentWidth) / 2),
    top: renderedRect.top + ((videoRect.height - contentHeight) / 2),
    width: contentWidth,
    height: contentHeight,
  }
}

function resolveAnnotationSurfaceGeometry(): AnnotationSurfaceGeometry | null {
  const stage = unwrapEl(stageEl.value)
  const meta = annotationSurfaceMeta.value
  if (!stage || !meta?.trackSid) return null
  const video = resolveActiveAnnotationVideoEl(meta.kind)
  if (!video) return null
  const stageRect = stage.getBoundingClientRect()
  if (stageRect.width <= 0 || stageRect.height <= 0) return null
  const videoRect = video.getBoundingClientRect()
  if (videoRect.width <= 0 || videoRect.height <= 0) return null
  const contentRect = resolveVideoContentRect(video, stageRect)
  if (!contentRect) return null

  return {
    kind: meta.kind,
    trackSid: meta.trackSid,
    videoRect: toOverlayRect(videoRect, stageRect),
    contentRect,
  }
}

function ensureAnnotationCanvasSize(canvas: HTMLCanvasElement, stage: HTMLDivElement) {
  const width = Math.max(1, Math.round(stage.clientWidth))
  const height = Math.max(1, Math.round(stage.clientHeight))
  const dpr = Math.max(1, window.devicePixelRatio || 1)
  const nextWidth = Math.round(width * dpr)
  const nextHeight = Math.round(height * dpr)
  if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
    canvas.width = nextWidth
    canvas.height = nextHeight
  }
  const ctx = safeGetCanvasContext(canvas)
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
}

function safeGetCanvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  if (canvas2dSupported === false) return null
  try {
    const ctx = canvas.getContext('2d')
    canvas2dSupported = Boolean(ctx)
    return ctx
  } catch {
    canvas2dSupported = false
    return null
  }
}

function safePlay(element: HTMLMediaElement) {
  try {
    const result = element.play()
    if (result && typeof result.catch === 'function') {
      void result.catch(() => { /* autoplay policy */ })
    }
  } catch {
    // Best effort for test/runtime environments where play() is unavailable.
  }
}

function pruneExpiredAnnotationSegments(nowMs: number): number {
  if (!annotationSegments.length) return 0
  let removed = 0
  for (let i = annotationSegments.length - 1; i >= 0; i -= 1) {
    const segment = annotationSegments[i]
    if (segment.expiresAtMs > nowMs) continue
    annotationSegments.splice(i, 1)
    annotationSegmentKeys.delete(segment.key)
    removed += 1
  }
  return removed
}

function annotationFrameRequest(callback: FrameRequestCallback): number {
  if (typeof window.requestAnimationFrame === 'function') {
    return window.requestAnimationFrame(callback)
  }
  return window.setTimeout(() => callback(Date.now()), 16)
}

function annotationFrameCancel(frameId: number) {
  if (typeof window.cancelAnimationFrame === 'function') {
    window.cancelAnimationFrame(frameId)
    return
  }
  window.clearTimeout(frameId)
}

function toRenderedAnnotationPoint(point: NormalizedPoint, rect: OverlayRect): NormalizedPoint {
  return {
    x: rect.left + (point.x * rect.width),
    y: rect.top + (point.y * rect.height),
  }
}

function buildAnnotationStrokeGroups(
  trackSid: string,
  contentRect: OverlayRect,
  nowMs: number,
): RenderedAnnotationStrokeGroup[] {
  const groups = new Map<string, RenderedAnnotationSegment[]>()
  for (const segment of annotationSegments) {
    if (segment.shareTrackSid !== trackSid) continue
    const msLeft = segment.expiresAtMs - nowMs
    if (msLeft <= 0) continue
    const groupKey = `${segment.senderIdentity}:${segment.strokeId}`
    const group = groups.get(groupKey)
    if (group) {
      group.push(segment)
    } else {
      groups.set(groupKey, [segment])
    }
  }

  return Array.from(groups.entries()).map(([key, segments]) => {
    const ordered = segments.slice().sort((a, b) => a.seq - b.seq)
    const points: NormalizedPoint[] = []
    let alpha = 1
    for (const segment of ordered) {
      const msLeft = segment.expiresAtMs - nowMs
      alpha = Math.min(alpha, msLeft < ANNOTATION_SEGMENT_FADE_MS
        ? clamp01(msLeft / ANNOTATION_SEGMENT_FADE_MS)
        : 1)
      if (points.length === 0) {
        points.push(toRenderedAnnotationPoint(segment.from, contentRect))
      }
      points.push(toRenderedAnnotationPoint(segment.to, contentRect))
    }
    return {
      key,
      color: ordered[0]?.color ?? resolveScreenAnnotationStrokeColor(''),
      alpha,
      points,
    }
  })
}

function strokeSmoothedAnnotationPath(
  ctx: CanvasRenderingContext2D,
  points: NormalizedPoint[],
) {
  if (points.length < 2) return
  ctx.beginPath()
  ctx.moveTo(points[0].x, points[0].y)
  if (points.length === 2) {
    ctx.lineTo(points[1].x, points[1].y)
    ctx.stroke()
    return
  }
  for (let index = 1; index < points.length - 1; index += 1) {
    const current = points[index]
    const next = points[index + 1]
    const midX = (current.x + next.x) / 2
    const midY = (current.y + next.y) / 2
    ctx.quadraticCurveTo(current.x, current.y, midX, midY)
  }
  const last = points[points.length - 1]
  ctx.lineTo(last.x, last.y)
  ctx.stroke()
}

function renderAnnotationOverlay() {
  const canvas = annotationCanvasEl.value
  const stage = unwrapEl(stageEl.value)
  if (!canvas || !stage) return

  const nowMs = Date.now()
  if (pruneExpiredAnnotationSegments(nowMs) > 0) {
    annotationActiveSegmentCount.value = annotationSegments.length
  }
  annotationFadingSegmentCount.value = annotationSegments.reduce((count, segment) => {
    const msLeft = segment.expiresAtMs - nowMs
    return count + (msLeft > 0 && msLeft < ANNOTATION_SEGMENT_FADE_MS ? 1 : 0)
  }, 0)

  ensureAnnotationCanvasSize(canvas, stage)
  const ctx = safeGetCanvasContext(canvas)
  if (!ctx) return

  const stageWidth = Math.max(1, stage.clientWidth)
  const stageHeight = Math.max(1, stage.clientHeight)
  ctx.clearRect(0, 0, stageWidth, stageHeight)
  if (!annotationRenderInCallCanvas.value) return
  const surface = resolveAnnotationSurfaceGeometry()
  if (!surface || !annotationSegments.length) return

  ctx.save()
  ctx.beginPath()
  ctx.rect(surface.videoRect.left, surface.videoRect.top, surface.videoRect.width, surface.videoRect.height)
  ctx.clip()

  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = ANNOTATION_STROKE_WIDTH_PX

  const strokeGroups = buildAnnotationStrokeGroups(surface.trackSid, surface.contentRect, nowMs)
  for (const strokeGroup of strokeGroups) {
    ctx.globalAlpha = strokeGroup.alpha
    ctx.strokeStyle = strokeGroup.color
    strokeSmoothedAnnotationPath(ctx, strokeGroup.points)
  }

  ctx.restore()
  ctx.globalAlpha = 1
}

function stopAnnotationRenderLoop() {
  if (annotationRenderFrame === null) return
  annotationFrameCancel(annotationRenderFrame)
  annotationRenderFrame = null
}

function ensureAnnotationRenderLoop() {
  if (annotationRenderFrame !== null) return
  annotationRenderFrame = annotationFrameRequest(() => {
    annotationRenderFrame = null
    renderAnnotationOverlay()
    if (annotationSegments.length > 0 || activeAnnotationStroke) {
      ensureAnnotationRenderLoop()
    }
  })
}

function clearRenderedAnnotationSegments() {
  annotationSegments.length = 0
  annotationSegmentKeys.clear()
  annotationActiveSegmentCount.value = 0
  annotationFadingSegmentCount.value = 0
  stopAnnotationRenderLoop()
  renderAnnotationOverlay()
}

function addRenderedAnnotationSegment(segment: ScreenAnnotationEvent) {
  if (!annotationRenderInCallCanvas.value) return
  const key = annotationSegmentKey(segment)
  if (annotationSegmentKeys.has(key)) return
  annotationSegmentKeys.add(key)
  annotationSegments.push({
    ...segment,
    key,
    color: resolveScreenAnnotationStrokeColor(segment.senderIdentity),
    expiresAtMs: segment.receivedAtMs + ANNOTATION_SEGMENT_TTL_MS,
  })
  annotationActiveSegmentCount.value = annotationSegments.length
  renderAnnotationOverlay()
  ensureAnnotationRenderLoop()
}

function toggleAnnotationDrawMode() {
  if (!annotationCanDraw.value) return
  annotationDrawMode.value = !annotationDrawMode.value
}

function toNormalizedPoint(
  clientX: number,
  clientY: number,
  contentRect: OverlayRect,
): NormalizedPoint | null {
  if (contentRect.width <= 0 || contentRect.height <= 0) return null
  const x = (clientX - contentRect.left) / contentRect.width
  const y = (clientY - contentRect.top) / contentRect.height
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x: clamp01(x), y: clamp01(y) }
}

function commitLocalAnnotationSegment(
  stroke: ActiveAnnotationStroke,
  nextPoint: NormalizedPoint,
) {
  const senderIdentity = callStore.room?.localParticipant.identity || 'local'
  const segment: ScreenAnnotationSegmentV1 = {
    version: 1,
    kind: 'segment',
    shareTrackSid: stroke.shareTrackSid,
    senderIdentity,
    strokeId: stroke.strokeId,
    seq: stroke.seq,
    from: stroke.lastPoint,
    to: nextPoint,
    sentAtMs: Date.now(),
  }
  stroke.seq += 1
  stroke.lastPoint = nextPoint
  void callStore.publishScreenAnnotationSegment(segment).catch(() => {
    // Best effort.
  })
}

function stopActiveAnnotationStroke(pointerId?: number) {
  if (!activeAnnotationStroke) return
  if (typeof pointerId === 'number' && activeAnnotationStroke.pointerId !== pointerId) return
  activeAnnotationStroke = null
}

function handleAnnotationPointerDown(event: PointerEvent) {
  if (!annotationDrawMode.value || !annotationCanDraw.value) return
  if (event.button !== 0) return
  const surface = resolveAnnotationSurfaceGeometry()
  if (!surface) return
  const point = toNormalizedPoint(event.offsetX, event.offsetY, surface.contentRect)
  if (!point) return
  activeAnnotationStroke = {
    pointerId: event.pointerId,
    strokeId: `stroke-${Date.now()}-${++annotationStrokeCounter}`,
    seq: 0,
    shareTrackSid: surface.trackSid,
    lastPoint: point,
  }
  annotationCanvasEl.value?.setPointerCapture?.(event.pointerId)
  ensureAnnotationRenderLoop()
  event.preventDefault()
}

function handleAnnotationPointerMove(event: PointerEvent) {
  const stroke = activeAnnotationStroke
  if (!stroke || stroke.pointerId !== event.pointerId) return
  const surface = resolveAnnotationSurfaceGeometry()
  if (!surface || surface.trackSid !== stroke.shareTrackSid) {
    stopActiveAnnotationStroke(event.pointerId)
    return
  }
  const point = toNormalizedPoint(event.offsetX, event.offsetY, surface.contentRect)
  if (!point) return
  if (point.x === stroke.lastPoint.x && point.y === stroke.lastPoint.y) return
  commitLocalAnnotationSegment(stroke, point)
}

function handleAnnotationPointerUp(event: PointerEvent) {
  annotationCanvasEl.value?.releasePointerCapture?.(event.pointerId)
  stopActiveAnnotationStroke(event.pointerId)
}

function handleAnnotationPointerCancel(event: PointerEvent) {
  annotationCanvasEl.value?.releasePointerCapture?.(event.pointerId)
  stopActiveAnnotationStroke(event.pointerId)
}

const unsubscribeScreenAnnotations = callStore.onScreenAnnotation((segment) => {
  addRenderedAnnotationSegment(segment)
})

function handleAnnotationWindowResize() {
  renderAnnotationOverlay()
}

if (typeof window !== 'undefined') {
  window.addEventListener('resize', handleAnnotationWindowResize)
}

// ── watchEffect: runs on every mediaVersion bump ──────────────────────────────

watchEffect(() => {
  callStore.mediaVersion // reactive dependency

  syncLocalCameraTrack()
  syncLocalScreenTrack()
  syncRemoteAudioTracks()
  syncRemoteScreenTrack()
  syncRemoteCameraTracks()
  syncPinnedTrack()
  renderAnnotationOverlay()
})

// Re-sync pinned track whenever pinnedSid changes (not covered by mediaVersion)
watch(pinnedSid, () => {
  syncPinnedTrack()
  renderAnnotationOverlay()
})

watch(activeRemoteScreenShareTrackSid, (next, prev) => {
  if (next !== prev) {
    clearPausedRemoteScreenFrame()
    if (callStore.remoteScreenShareReceiveEnabled) {
      remoteScreenPresentationMode.value = 'stage'
    }
  }
})

watch(() => callStore.remoteScreenShareReceiveEnabled, (enabled) => {
  if (enabled) {
    clearPausedRemoteScreenFrame()
  }
})

watch(currentScreenShareTrackSid, (next, prev) => {
  if (!next) {
    annotationDrawMode.value = false
    stopActiveAnnotationStroke()
    clearRenderedAnnotationSegments()
    return
  }
  if (prev && prev !== next) {
    stopActiveAnnotationStroke()
    clearRenderedAnnotationSegments()
  }
})

watch(annotationCanDraw, (next) => {
  if (next) return
  annotationDrawMode.value = false
  stopActiveAnnotationStroke()
})

watch(annotationRenderInCallCanvas, (next) => {
  if (next) return
  clearRenderedAnnotationSegments()
})

watch(annotationSurfaceKind, () => {
  renderAnnotationOverlay()
})

watch(maximized, () => {
  renderAnnotationOverlay()
})

watch([remoteScreenPresentationMode, pinnedSid], () => {
  void nextTick(() => {
    syncRemoteCameraTracks()
    syncRemoteScreenTrack()
    renderAnnotationOverlay()
  })
})

// ── Local camera track ────────────────────────────────────────────────────────

function syncLocalCameraTrack() {
  const video = unwrapEl(localVideoEl.value)
  const track = callStore.localVideoTrack() as AttachableMediaTrack | null

  if (attachedLocalCameraTrack && (!track || track !== attachedLocalCameraTrack || !video)) {
    callDebug('detaching local camera track', { sid: attachedLocalCameraTrack.sid })
    attachedLocalCameraTrack.detach(video ?? undefined)
    attachedLocalCameraTrack = null
  }
  if (!video || !track) return
  if (attachedLocalCameraTrack !== track) {
    track.attach(video)
    callDebug('attached local camera track', { sid: track.sid })
    attachedLocalCameraTrack = track
  }
}

// ── Local screen share track ──────────────────────────────────────────────────

function syncLocalScreenTrack() {
  const video = unwrapEl(localScreenEl.value)
  const track = callStore.localScreenShareTrack() as AttachableMediaTrack | null

  if (attachedLocalScreenTrack && (!track || track !== attachedLocalScreenTrack || !video)) {
    callDebug('detaching local screen track', { sid: attachedLocalScreenTrack.sid })
    attachedLocalScreenTrack.detach(video ?? undefined)
    attachedLocalScreenTrack = null
  }
  if (!video || !track) return
  if (attachedLocalScreenTrack !== track) {
    track.attach(video)
    callDebug('attached local screen track', { sid: track.sid })
    attachedLocalScreenTrack = track
  }
}

// ── Remote camera tracks ──────────────────────────────────────────────────────

function syncRemoteCameraTracks() {
  const currentRoom = callStore.room
  if (!currentRoom) { detachAllRemoteCameraTracks(); return }

  const activeCameraTracks = new Map<string, AttachableMediaTrack>()
  for (const participant of currentRoom.remoteParticipants.values()) {
    // Skip: if this participant is pinned, their track goes to pinnedVideoEl instead
    if (participant.sid === pinnedSid.value) continue
    if (participant.sid === remoteScreenTileSid.value) continue
    const pub = participant.getTrackPublication(Track.Source.Camera)
    if (!pub) continue
    if (!pub.isSubscribed) { pub.setSubscribed(true); continue }
    const track = pub.track as AttachableMediaTrack | null
    if (!track || track.kind !== 'video' || pub.isMuted) continue
    activeCameraTracks.set(participant.sid, track)
  }

  // Detach stale / gone tracks
  for (const [sid, attached] of attachedRemoteCamera) {
    if (activeCameraTracks.get(sid) !== attached.track) {
      callDebug('detaching stale remote camera track', { sid })
      attached.track.detach(attached.element)
      attachedRemoteCamera.delete(sid)
    }
  }

  // Attach new tracks to their tile <video> elements
  for (const [sid, track] of activeCameraTracks) {
    const videoEl = unwrapEl(remoteTileEls.get(sid) ?? null)
    if (!videoEl) continue

    const existing = attachedRemoteCamera.get(sid)
    if (existing) {
      if (existing.element === videoEl && existing.track === track) continue
      existing.track.detach(existing.element)
    }

    track.attach(videoEl)
    videoEl.autoplay = true
    videoEl.setAttribute('playsinline', 'true')
    attachedRemoteCamera.set(sid, { track, element: videoEl })
    callDebug('attached remote camera track', { sid })
    safePlay(videoEl)
  }
}

function detachAllRemoteCameraTracks() {
  for (const [sid, attached] of attachedRemoteCamera) {
    callDebug('detaching remote camera track (cleanup)', { sid })
    attached.track.detach(attached.element)
    attachedRemoteCamera.delete(sid)
  }
}

// ── Remote screen share track ─────────────────────────────────────────────────

function detachRemoteScreenTrack() {
  if (attachedRemoteScreenTrack) {
    callDebug('detaching remote screen track', { sid: attachedRemoteScreenTrack.track.sid })
    attachedRemoteScreenTrack.track.detach(attachedRemoteScreenTrack.element)
    attachedRemoteScreenTrack = null
  }
  remoteScreenOwnerLabel.value = 'Screen share'
}

function syncRemoteScreenTrack() {
  const currentRoom = callStore.room
  const source = activeRemoteScreenShare.value
  if (!currentRoom || !source) { detachRemoteScreenTrack(); return }

  const nextTrack = source.track?.kind === 'video' ? source.track : null

  remoteScreenOwnerLabel.value = `${source.ownerLabel} is sharing`

  const video = remoteScreenPresentationMode.value === 'tile'
    ? unwrapEl(remoteTileEls.get(source.participantSid) ?? null)
    : unwrapEl(remoteScreenEl.value)
  if (!video) {
    if (attachedRemoteScreenTrack && attachedRemoteScreenTrack.track !== nextTrack) {
      attachedRemoteScreenTrack.track.detach(attachedRemoteScreenTrack.element)
      attachedRemoteScreenTrack = null
    }
    return
  }

  if (attachedRemoteScreenTrack && (
    attachedRemoteScreenTrack.track !== nextTrack || attachedRemoteScreenTrack.element !== video
  )) {
    callDebug('detaching stale remote screen track', { sid: attachedRemoteScreenTrack.track.sid })
    attachedRemoteScreenTrack.track.detach(attachedRemoteScreenTrack.element)
    attachedRemoteScreenTrack = null
  }
  if (!nextTrack) return
  if (attachedRemoteScreenTrack?.track === nextTrack && attachedRemoteScreenTrack.element === video) return

  nextTrack.attach(video)
  attachedRemoteScreenTrack = { track: nextTrack, element: video }
  callDebug('attached remote screen track', { sid: nextTrack.sid })
  safePlay(video)
}

// ── Pinned full-stage track ───────────────────────────────────────────────────

function syncPinnedTrack() {
  const sid = pinnedSid.value
  const video = unwrapEl(pinnedVideoEl.value)

  // If nothing is pinned, detach and bail
  if (!sid) {
    if (attachedPinnedTrack) {
      attachedPinnedTrack.detach(video ?? undefined)
      attachedPinnedTrack = null
    }
    return
  }

  // Determine which track should fill the pinned view
  let nextTrack: AttachableMediaTrack | null = null
  const localSid = localTile.value?.sid

  if (sid === localSid) {
    // Local participant — prefer screen share over camera
    if (callStore.screenShareEnabled) {
      nextTrack = callStore.localScreenShareTrack() as AttachableMediaTrack | null
    }
    if (!nextTrack && callStore.cameraEnabled) {
      nextTrack = callStore.localVideoTrack() as AttachableMediaTrack | null
    }
  } else {
    const currentRoom = callStore.room
    if (currentRoom) {
      const participant = Array.from(currentRoom.remoteParticipants.values()).find(p => p.sid === sid)
      if (participant) {
        for (const publication of participant.videoTrackPublications.values()) {
          if (!isScreenSource(publication.source)) continue
          if (!publication.isSubscribed) publication.setSubscribed(true)
          if (!publication.track || publication.isMuted) continue
          nextTrack = publication.track as AttachableMediaTrack | null
          break
        }
        if (!nextTrack) {
          const pub = participant.getTrackPublication(Track.Source.Camera)
          if (pub?.isSubscribed && pub.track && !pub.isMuted) {
            nextTrack = pub.track as AttachableMediaTrack | null
          }
        }
      }
    }
  }

  if (!video) return

  // Detach stale pinned track
  if (attachedPinnedTrack && attachedPinnedTrack !== nextTrack) {
    attachedPinnedTrack.detach(video)
    attachedPinnedTrack = null
  }
  if (!nextTrack || attachedPinnedTrack === nextTrack) return

  nextTrack.attach(video)
  attachedPinnedTrack = nextTrack
  callDebug('attached pinned track', { sid, trackSid: nextTrack.sid })
  safePlay(video)
}

// ── Remote audio tracks ───────────────────────────────────────────────────────

function syncRemoteAudioTracks() {
  const host = remoteAudioHostEl.value
  const currentRoom = callStore.room
  if (!host || !currentRoom) { detachAllRemoteAudioTracks(); return }

  const activeTracks = new Map<string, AttachableMediaTrack>()
  for (const participant of currentRoom.remoteParticipants.values()) {
    for (const publication of participant.audioTrackPublications.values()) {
      const track = publication.track as AttachableMediaTrack | null
      if (!track || track.kind !== 'audio') continue
      activeTracks.set(track.sid, track)
    }
  }

  for (const [sid, attached] of attachedRemoteAudio) {
    if (activeTracks.get(sid) !== attached.track) {
      callDebug('detaching stale remote audio', { sid })
      attached.track.detach(attached.element)
      attached.element.remove()
      attachedRemoteAudio.delete(sid)
    }
  }

  for (const [sid, track] of activeTracks) {
    if (attachedRemoteAudio.has(sid)) continue
    const element = track.attach()
    element.autoplay = true
    element.muted = false
    element.volume = 1
    element.setAttribute('playsinline', 'true')
    element.style.opacity = '0'
    element.style.width = '1px'
    element.style.height = '1px'
    host.appendChild(element)
    attachedRemoteAudio.set(sid, { track, element })
    callDebug('attached remote audio', { sid })
    try {
      const playResult = element.play()
      if (playResult && typeof playResult.catch === 'function') {
        void playResult.catch(async () => {
          try {
            await currentRoom.startAudio()
            safePlay(element)
          } catch {
            // best effort
          }
        })
      }
    } catch {
      // best effort
    }
  }
}

function detachAllRemoteAudioTracks() {
  for (const [sid, attached] of attachedRemoteAudio) {
    callDebug('detaching remote audio (cleanup)', { sid })
    attached.track.detach(attached.element)
    attached.element.remove()
    attachedRemoteAudio.delete(sid)
  }
}

function stopElementStreamTracks(el: HTMLMediaElement | null) {
  if (!el) return
  if (typeof MediaStream === 'undefined') return
  const src = el.srcObject
  if (!(src instanceof MediaStream)) return
  for (const track of src.getTracks()) {
    try {
      track.stop()
    } catch {
      // best effort
    }
  }
  el.srcObject = null
}

function forceStopLocalCapturePreviews() {
  stopElementStreamTracks(unwrapEl(localVideoEl.value))
  stopElementStreamTracks(unwrapEl(localScreenEl.value))
  // If local participant is pinned, also clear the pinned stage stream.
  if (pinnedSid.value && pinnedSid.value === localTile.value?.sid) {
    stopElementStreamTracks(unwrapEl(pinnedVideoEl.value))
  }
}

// ── Cleanup on unmount ────────────────────────────────────────────────────────

onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleEscapeKey)
  document.removeEventListener('pointerdown', handleDocumentPointerDown)
  window.removeEventListener('resize', handleAnnotationWindowResize)
  detachInputDeviceChangeListener()
  unsubscribeScreenAnnotations()
  stopAnnotationRenderLoop()
  stopActiveAnnotationStroke()
  annotationDrawMode.value = false

  const localVid = unwrapEl(localVideoEl.value)
  const localScr = unwrapEl(localScreenEl.value)
  const pinnedVid = unwrapEl(pinnedVideoEl.value)

  if (attachedLocalCameraTrack) {
    attachedLocalCameraTrack.detach(localVid ?? undefined)
    attachedLocalCameraTrack = null
  }
  if (attachedLocalScreenTrack) {
    attachedLocalScreenTrack.detach(localScr ?? undefined)
    attachedLocalScreenTrack = null
  }
  if (attachedPinnedTrack) {
    attachedPinnedTrack.detach(pinnedVid ?? undefined)
    attachedPinnedTrack = null
  }
  detachRemoteScreenTrack()
  detachAllRemoteAudioTracks()
  detachAllRemoteCameraTracks()
  forceStopLocalCapturePreviews()
  clearRenderedAnnotationSegments()
  clearPausedRemoteScreenFrame()
})

// ── Maximize / minimize ───────────────────────────────────────────────────────

watch(() => callStore.minimized, (value) => {
  if (value) maximized.value = false
})

function handleEscapeKey(evt: KeyboardEvent) {
  if (evt.key !== 'Escape') return
  if (inputDeviceMenuOpen.value) {
    inputDeviceMenuOpen.value = false
    return
  }
  if (reactionPickerOpen.value) {
    reactionPickerOpen.value = false
    return
  }
  if (inviteDialogOpen.value) {
    closeInviteDialog()
    return
  }
  if (maximized.value) {
    maximized.value = false
  }
}

watch([maximized, inviteDialogOpen, inputDeviceMenuOpen, reactionPickerOpen], ([isMaximized, isInviteOpen, isInputMenuOpen, isReactionPickerOpen]) => {
  const shouldListen = isMaximized || isInviteOpen || isInputMenuOpen || isReactionPickerOpen
  document.removeEventListener('keydown', handleEscapeKey)
  if (shouldListen) {
    document.addEventListener('keydown', handleEscapeKey)
  }
})

watch([inputDeviceMenuOpen, reactionPickerOpen], ([isInputMenuOpen, isReactionPickerOpen]) => {
  document.removeEventListener('pointerdown', handleDocumentPointerDown)
  if (isInputMenuOpen || isReactionPickerOpen) {
    document.addEventListener('pointerdown', handleDocumentPointerDown)
  }
})

watch(minimizedDockEl, () => {
  syncMinimizedDockRegistration()
}, { immediate: true })

watch([maximized, expandedDockEl], () => {
  syncExpandedDockRegistration()
}, { immediate: true, flush: 'post' })

watch(isVisible, (visible) => {
  if (visible) {
    inputDeviceLog('call dock visible: refreshing input devices')
    void refreshInputDevices('visible')
    ensureInputDeviceChangeListener()
    return
  }
  inputDeviceLog('call dock hidden: detaching input device listener')
  detachInputDeviceChangeListener()
  inputDeviceMenuOpen.value = false
  reactionPickerOpen.value = false
  annotationDrawMode.value = false
  stopActiveAnnotationStroke()
  clearRenderedAnnotationSegments()
  forceStopLocalCapturePreviews()
  clearPausedRemoteScreenFrame()
})

if (isVisible.value) {
  inputDeviceLog('call dock initially visible: refreshing input devices')
  void refreshInputDevices('initial-visible')
  ensureInputDeviceChangeListener()
}

function toggleMaximized() {
  maximized.value = !maximized.value
}

function closeInviteDialog() {
  inviteDialogOpen.value = false
  inviteSearch.value = ''
}

function activeCallParticipantIds(): Set<string> {
  const ids = new Set<string>()
  const selfUserId = authStore.user?.id ?? chatStore.workspace?.selfUserId ?? ''
  if (selfUserId) ids.add(selfUserId)
  const currentRoom = callStore.room
  if (!currentRoom) return ids
  if (currentRoom.localParticipant.identity) {
    ids.add(currentRoom.localParticipant.identity)
  }
  for (const participant of currentRoom.remoteParticipants.values()) {
    if (participant.identity) ids.add(participant.identity)
  }
  return ids
}

function toInviteCandidate(member: DmCandidateItem): InviteCandidate {
  return {
    userId: member.user_id,
    displayName: member.display_name,
    email: member.email,
    avatarUrl: member.avatar_url,
  }
}

async function openInviteDialog() {
  inviteDialogOpen.value = true
  inviteLoading.value = true
  inviteError.value = ''
  inviteResultSummary.value = ''
  inviteSearch.value = ''
  selectedInviteeIds.value = []

  const conversationId = callStore.activeConversationId
  if (!conversationId) {
    inviteLoading.value = false
    inviteError.value = 'No active call conversation.'
    inviteCandidates.value = []
    return
  }

  try {
    const members = await listDmCandidates()
    const inCall = activeCallParticipantIds()
    inviteCandidates.value = members
      .filter(member => member.user_id && !inCall.has(member.user_id))
      .map(toInviteCandidate)
  } catch (err) {
    inviteCandidates.value = []
    inviteError.value = err instanceof Error ? err.message : 'Failed to load members'
  } finally {
    inviteLoading.value = false
  }
}

function toggleInviteCandidate(userId: string) {
  if (selectedInviteeIds.value.includes(userId)) {
    selectedInviteeIds.value = selectedInviteeIds.value.filter(id => id !== userId)
    return
  }
  selectedInviteeIds.value = [...selectedInviteeIds.value, userId]
}

function busyInviteeNames(userIds: string[]): string[] {
  const byId = new Map(inviteCandidates.value.map(candidate => [candidate.userId, candidate]))
  return userIds
    .filter(userId => (chatStore.userCallPresenceByUserId[userId] ?? 0) > 0)
    .map(userId => {
      const candidate = byId.get(userId)
      return candidate?.displayName || candidate?.email || chatStore.resolveDisplayName(userId)
    })
}

function cancelBusyCallConfirm() {
  busyCallConfirmOpen.value = false
  busyCallConfirmNames.value = []
}

async function confirmBusyCallInvites() {
  busyCallConfirmOpen.value = false
  busyCallConfirmNames.value = []
  await sendCallInvitesConfirmed([...selectedInviteeIds.value])
}

async function sendCallInvitesConfirmed(requestIds: string[]) {
  if (!requestIds.length) return
  inviteSubmitting.value = true
  inviteError.value = ''
  inviteResultSummary.value = ''
  try {
    const result = await callStore.inviteMembersToActiveCall(requestIds)
    const invitedCount = result.invitedUserIds.length
    const skippedCount = result.skippedUserIds.length
    inviteResultSummary.value = `Invited ${invitedCount}. Skipped ${skippedCount}.`

    const consumed = new Set([...result.invitedUserIds, ...result.skippedUserIds])
    if (consumed.size > 0) {
      inviteCandidates.value = inviteCandidates.value.filter(candidate => !consumed.has(candidate.userId))
      selectedInviteeIds.value = selectedInviteeIds.value.filter(id => !consumed.has(id))
    }
    closeInviteDialog()
  } catch (err) {
    inviteError.value = err instanceof Error ? err.message : 'Failed to send call invites'
  } finally {
    inviteSubmitting.value = false
  }
}

async function sendCallInvites() {
  if (!selectedInviteeIds.value.length) return
  const busyNames = busyInviteeNames(selectedInviteeIds.value)
  if (busyNames.length > 0) {
    busyCallConfirmNames.value = busyNames
    busyCallConfirmOpen.value = true
    return
  }
  await sendCallInvitesConfirmed([...selectedInviteeIds.value])
}

// ── Control handlers ──────────────────────────────────────────────────────────

async function handleToggleMute() {
  try { await callStore.toggleMute() } catch { /* best effort */ }
}

async function handleToggleHandRaised() {
  try { await callStore.toggleHandRaised() } catch { /* server state remains authoritative */ }
}

async function handleToggleCamera() {
  try { await callStore.toggleCamera() } catch { /* best effort */ }
}

async function handleToggleScreenShare() {
  try { await callStore.toggleScreenShare() } catch { /* best effort */ }
}

async function handleLeave() {
  annotationDrawMode.value = false
  stopActiveAnnotationStroke()
  clearRenderedAnnotationSegments()
  forceStopLocalCapturePreviews()
  await callStore.leaveCall()
  forceStopLocalCapturePreviews()
  maximized.value = false
  pinnedSid.value = null
  remoteScreenPresentationMode.value = 'stage'
  clearPausedRemoteScreenFrame()
  inviteDialogOpen.value = false
}

function handleMinimize() {
  maximized.value = false
  callStore.toggleMinimized()
}

async function handleEnableAudio() {
  try { await callStore.enableAudioPlayback() } catch { /* best effort */ }
}
</script>
