<template>
  <div v-if="isVisible" :class="containerClass">
    <!-- ── Minimized pill ─────────────────────────────────────────────────── -->
    <div
      v-if="callStore.minimized"
      ref="minimizedDockEl"
      class="cw-pill"
      :style="minimizedDockStyle"
      data-testid="calldock-minimized-root"
      @pointerdown="handleMinimizedDockPointerDown"
    >
      <!-- Expand back to panel -->
      <button
        class="flex items-center gap-2 rounded-full px-0.5 py-0.5 transition-opacity hover:opacity-85"
        data-testid="calldock-minimized-expand"
        @click="callStore.toggleMinimized()"
      >
        <span class="cw-dot-live" />
        <span class="max-w-[180px] truncate text-[13px] font-semibold">{{ callStore.activeConversationTitle || 'Huddle' }}</span>
      </button>
      <span class="shrink-0 text-xs tabular-nums text-[var(--cw-text-3)]">{{ elapsedLabel }}</span>
      <div class="h-[18px] w-px shrink-0 bg-[var(--cw-line-strong)]" />
      <span class="flex shrink-0 items-center gap-1.5 text-xs text-[var(--cw-text-3)]">
        <CallIcon name="users" :size="13" />
        {{ participantCount }}
      </span>
      <!-- Mic toggle -->
      <button
        class="cw-pill-btn"
        :class="callStore.micEnabled ? '' : 'cw-pill-btn-mic-off'"
        :title="callStore.micEnabled ? 'Mute' : 'Unmute'"
        @click="handleToggleMute"
      >
        <CallIcon :name="callStore.micEnabled ? 'mic' : 'micOff'" :size="15" />
      </button>
      <!-- Leave -->
      <button class="cw-pill-btn cw-pill-btn-leave" title="Leave call" @click="handleLeave">
        <CallIcon name="phone" :size="15" class="rotate-[135deg]" />
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
        class="cw-topbar"
        :class="maximized ? '' : 'cursor-move'"
        data-testid="calldock-expanded-drag-handle"
        @pointerdown="handleExpandedDockPointerDown"
      >
        <span class="cw-dot-live" />
        <span class="min-w-0 truncate text-[13px] font-semibold text-[var(--cw-text-1)]">{{ callStore.activeConversationTitle || 'Huddle' }}</span>
        <span class="cw-chip shrink-0 tabular-nums">{{ elapsedLabel }}</span>
        <span class="cw-chip shrink-0">
          <CallIcon name="users" :size="13" class="text-[var(--cw-text-3)]" />
          {{ participantCount }}
        </span>
        <span class="cw-chip cw-chip-ok shrink-0">
          <CallIcon name="shieldCheck" :size="13" />
          E2EE · HD
        </span>
        <div class="ml-auto flex shrink-0 items-center gap-0.5">
          <!-- Layout switcher — static showcase, no behavior yet -->
          <span class="cw-iconbtn" aria-hidden="true"><CallIcon name="layoutGrid" :size="15" /></span>
          <button class="cw-iconbtn" title="Minimize" @click="handleMinimize">
            <CallIcon name="minus" :size="15" />
          </button>
          <button class="cw-iconbtn" :title="maximized ? 'Restore' : 'Maximize'" @click="toggleMaximized">
            <CallIcon :name="maximized ? 'minimize' : 'maximize'" :size="15" />
          </button>
        </div>
      </header>

      <!-- Body -->
      <div :class="contentClass">

        <!-- Error / audio blocked banners -->
        <div v-if="callStore.errorMessage" class="cw-banner cw-banner-danger">
          {{ callStore.errorMessage }}
        </div>
        <div v-if="inputDeviceError" class="cw-banner cw-banner-amber">
          {{ inputDeviceError }}
        </div>
        <div v-if="callStore.playbackBlocked" class="cw-banner cw-banner-amber">
          <div class="mb-2">Audio playback is blocked by the browser.</div>
          <button class="cw-mini-btn" @click="handleEnableAudio">
            Enable audio
          </button>
        </div>

        <!-- ── Main stage ─────────────────────────────────────────────── -->
        <div ref="stageEl" class="cw-stage-zone">

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
            <div v-else class="flex h-full w-full items-center justify-center text-sm text-[var(--cw-text-3)]">
              Shared screen paused for you
            </div>
            <div class="absolute inset-0 bg-black/35" />
          </div>

          <template v-if="remoteScreenStageVisible || remoteScreenStagePausedVisible">
            <!-- Owner chip — bottom left -->
            <div class="cw-owner">
              <UserAvatar
                :user-id="availableRemoteScreenShare?.participantIdentity ?? ''"
                :display-name="remoteScreenOwnerDisplayLabel"
                :avatar-url="chatStore.resolveAvatarUrl(availableRemoteScreenShare?.participantIdentity ?? '')"
                size="xs"
                class="!h-[22px] !w-[22px]"
              />
              <span class="max-w-[220px] truncate">{{ remoteScreenStagePausedVisible ? `${remoteScreenOwnerDisplayLabel} · paused for you` : remoteScreenOwnerDisplayLabel }}</span>
              <CallIcon name="screenShare" :size="14" class="shrink-0 text-[var(--cw-live)]" />
            </div>
            <!-- Stage actions — bottom right -->
            <div class="absolute bottom-4 right-4 z-10 flex items-center gap-2">
              <button
                class="cw-ghost"
                :title="remoteScreenReceiveToggleTitle"
                :data-testid="callStore.remoteScreenShareReceiveEnabled ? 'calldock-remote-share-stage-stop' : 'calldock-remote-share-stage-resume'"
                @click="callStore.remoteScreenShareReceiveEnabled ? handleStopRemoteScreenShareForMe() : handleStartRemoteScreenShareForMe()"
              >
                <CallIcon name="pause" :size="14" class="text-[var(--cw-text-3)]" />
                {{ callStore.remoteScreenShareReceiveEnabled ? 'Pause for me' : 'Resume' }}
              </button>
              <button
                class="cw-ghost !px-2"
                :title="remoteScreenViewerToggleTitle"
                data-testid="calldock-remote-share-stage-toggle"
                @click="toggleRemoteScreenPresentationMode"
              >
                <CallIcon name="maximize2" :size="14" class="text-[var(--cw-text-3)]" />
              </button>
            </div>
          </template>

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
            <!-- Pinned chip — top left -->
            <div class="cw-pin-chip absolute left-3 top-3 z-10">
              <CallIcon name="pin" :size="13" />
              Pinned
            </div>
            <div
              v-if="pinnedTile?.raisedHandPosition"
              class="cw-hand absolute left-3 top-[46px] z-10"
              :aria-label="`Raised hand position ${pinnedTile.raisedHandPosition}`"
              :data-testid="`calldock-pinned-hand-${pinnedTile.raisedHandPosition}`"
            >
              <CallIcon name="hand" :size="15" />
              <span class="font-bold">{{ pinnedTile.raisedHandPosition }}</span>
            </div>
            <div
              v-if="pinnedTile?.reactionEmoji"
              class="cw-react absolute bottom-12 right-3 z-20"
              role="status"
              :aria-label="`${pinnedTileName} reacted ${pinnedTile.reactionEmoji}`"
              :data-testid="`calldock-pinned-reaction-${pinnedTile.sid}`"
            >
              <span aria-hidden="true">{{ pinnedTile.reactionEmoji }}</span>
            </div>
            <!-- Name tag — bottom left -->
            <div class="cw-tag absolute bottom-3 left-3 z-10">
              <span v-if="pinnedTile && !pinnedTile.micOn" class="text-[var(--cw-danger)]"><CallIcon name="micOff" :size="13" /></span>
              <span v-else class="cw-eq" :class="pinnedTile?.isSpeaking ? 'cw-eq-on' : ''"><i /><i /><i /></span>
              <span class="max-w-[220px] truncate font-medium">{{ pinnedTileName }}</span>
            </div>
            <!-- Unpin — top right -->
            <button class="cw-ghost absolute right-3 top-3 z-10" title="Unpin" @click="unpinTile">
              <CallIcon name="pinOff" :size="14" class="text-[var(--cw-text-3)]" />
              Unpin
            </button>
          </template>

          <!-- Camera tile grid (shown when no remote screen share and nothing pinned) -->
          <template v-if="!remoteScreenStageVisible && !pinnedSid">
            <div :class="tileGridClass">

              <!-- Local tile — NOT in v-for so ref="localVideoEl" / ref="localScreenEl"
                   are always stable single-element refs, never arrays. -->
              <div :class="[tileItemClass, localTile?.isSpeaking ? 'cw-tile-speaking' : '']">
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
                <div
                  v-if="localTile?.raisedHandPosition"
                  class="cw-hand absolute left-2 top-2 z-10"
                  :aria-label="`Raised hand position ${localTile.raisedHandPosition}`"
                  :data-testid="`calldock-local-hand-${localTile.raisedHandPosition}`"
                >
                  <CallIcon name="hand" :size="13" />
                  <span class="font-bold">{{ localTile.raisedHandPosition }}</span>
                </div>
                <!-- "Sharing screen" chip -->
                <div
                  v-if="localTile?.screenShareOn"
                  class="cw-sharechip absolute z-10"
                  :class="localTile?.raisedHandPosition ? 'top-[46px]' : 'top-2'"
                >
                  <CallIcon name="screenShare" :size="12" />
                  Sharing screen
                </div>
                <div
                  v-if="localTile?.reactionEmoji"
                  class="cw-react absolute bottom-10 right-2 z-20"
                  role="status"
                  :aria-label="`${localTile.name} reacted ${localTile.reactionEmoji}`"
                  data-testid="calldock-local-reaction"
                >
                  <span aria-hidden="true">{{ localTile.reactionEmoji }}</span>
                </div>
                <!-- Name tag + mic state — bottom left -->
                <div class="cw-tag absolute bottom-2 left-2 z-10 max-w-[calc(100%-16px)]">
                  <span v-if="!localTile?.micOn" class="text-[var(--cw-danger)]"><CallIcon name="micOff" :size="13" /></span>
                  <span v-else class="cw-eq" :class="localTile?.isSpeaking ? 'cw-eq-on' : ''"><i /><i /><i /></span>
                  <span class="truncate font-medium">{{ localTile?.name ?? '' }}</span>
                </div>
                <!-- Pin button (hover) -->
                <button
                  v-if="localTile"
                  class="cw-pinbtn absolute right-2 top-2 z-10"
                  title="Pin to full view"
                  @click.stop="pinTile(localTile.sid)"
                >
                  <CallIcon name="pin" :size="14" />
                </button>
              </div>

              <!-- Remote tiles -->
              <div
                v-for="tile in remoteTiles"
                :key="tile.sid"
                :class="[tileItemClass, tile.isSpeaking ? 'cw-tile-speaking' : '']"
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
                  <div v-else class="flex h-full w-full items-center justify-center text-sm text-[var(--cw-text-3)]">
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
                <div
                  v-if="tile.raisedHandPosition"
                  class="cw-hand absolute left-2 top-2 z-10"
                  :aria-label="`Raised hand position ${tile.raisedHandPosition}`"
                  :data-testid="`calldock-remote-hand-${tile.sid}-${tile.raisedHandPosition}`"
                >
                  <CallIcon name="hand" :size="13" />
                  <span class="font-bold">{{ tile.raisedHandPosition }}</span>
                </div>
                <div
                  v-if="tile.screenShareOn"
                  class="cw-sharechip absolute z-10"
                  :class="tile.raisedHandPosition ? 'top-[46px]' : 'top-2'"
                  :data-testid="`calldock-remote-share-badge-${tile.sid}`"
                >
                  <CallIcon name="screenShare" :size="12" />
                  {{ callStore.remoteScreenShareReceiveEnabled ? 'Sharing screen' : 'Screen share paused' }}
                </div>
                <div
                  v-if="tile.reactionEmoji"
                  class="cw-react absolute bottom-10 right-2 z-20"
                  role="status"
                  :aria-label="`${tile.name} reacted ${tile.reactionEmoji}`"
                  :data-testid="`calldock-remote-reaction-${tile.sid}`"
                >
                  <span aria-hidden="true">{{ tile.reactionEmoji }}</span>
                </div>
                <div class="cw-tag absolute bottom-2 left-2 z-10 max-w-[calc(100%-16px)]">
                  <span v-if="!tile.micOn" class="text-[var(--cw-danger)]"><CallIcon name="micOff" :size="13" /></span>
                  <span v-else class="cw-eq" :class="tile.isSpeaking ? 'cw-eq-on' : ''"><i /><i /><i /></span>
                  <span class="truncate font-medium">{{ tile.name }}</span>
                </div>
                <div
                  v-if="tile.screenShareOn"
                  class="absolute right-2 top-2 z-10 flex items-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100"
                >
                  <button
                    class="cw-ghost !py-1.5"
                    :title="remoteScreenReceiveToggleTitle"
                    :data-testid="callStore.remoteScreenShareReceiveEnabled ? `calldock-remote-share-tile-stop-${tile.sid}` : `calldock-remote-share-tile-resume-${tile.sid}`"
                    @click.stop="callStore.remoteScreenShareReceiveEnabled ? handleStopRemoteScreenShareForMe() : handleStartRemoteScreenShareForMe()"
                  >
                    <CallIcon v-if="callStore.remoteScreenShareReceiveEnabled" name="pause" :size="12" class="text-[var(--cw-text-3)]" />
                    {{ callStore.remoteScreenShareReceiveEnabled ? 'Pause' : 'Resume' }}
                  </button>
                  <button
                    class="cw-pinbtn"
                    :title="remoteScreenViewerToggleTitle"
                    :data-testid="`calldock-remote-share-tile-toggle-${tile.sid}`"
                    @click.stop="toggleRemoteScreenPresentationMode()"
                  >
                    <CallIcon name="maximize2" :size="13" />
                  </button>
                </div>
                <button
                  v-else
                  class="cw-pinbtn absolute right-2 top-2 z-10"
                  title="Pin to full view"
                  @click.stop="pinTile(tile.sid)"
                >
                  <CallIcon name="pin" :size="14" />
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

          <!-- Annotation toolbar — static showcase, functionality comes later -->
          <div
            v-if="annotationDrawMode"
            class="cw-anno pointer-events-none"
            aria-hidden="true"
          >
            <span class="cw-anno-btn cw-anno-btn-on"><CallIcon name="pencil" :size="15" /></span>
            <span class="cw-anno-btn"><CallIcon name="mousePointer2" :size="15" /></span>
            <span class="cw-anno-sep" />
            <span class="cw-anno-swatch" style="background: #7c86e8;" />
            <span class="cw-anno-swatch" style="background: #4cd48a;" />
            <span class="cw-anno-swatch" style="background: #f2b33d;" />
            <span class="cw-anno-swatch" style="background: #f26d6d;" />
            <span class="cw-anno-sep" />
            <span class="cw-anno-btn"><CallIcon name="undo2" :size="15" /></span>
            <span class="cw-anno-btn"><CallIcon name="trash2" :size="15" /></span>
          </div>

        </div>

        <!-- Console -->
        <div class="cw-console">

          <!-- Microphone + device selector -->
          <div ref="inputSelectorWrapEl" class="cw-ctl-group">
            <button
              class="cw-ctl"
              :class="callStore.micEnabled ? '' : 'cw-ctl-off'"
              :title="callStore.micEnabled ? 'Mute microphone' : 'Unmute microphone'"
              @click="handleToggleMute"
            >
              <CallIcon :name="callStore.micEnabled ? 'mic' : 'micOff'" :size="18" />
            </button>
            <div class="cw-ctl-sep" />
            <button
              class="cw-ctl cw-ctl-chev"
              title="Select input device"
              data-testid="calldock-input-device-toggle"
              :disabled="inputDeviceLoading || inputDeviceSwitching || !callStore.connected"
              @pointerdown="logInputSelectorPointerDown"
              @click="toggleInputDeviceMenu"
            >
              <CallIcon name="chevronUp" :size="14" />
            </button>

            <!-- Input device popover -->
            <div
              v-if="inputDeviceMenuOpen"
              class="cw-pop"
              data-testid="calldock-input-device-menu"
            >
              <div class="cw-pop-head">Microphone</div>
              <button
                class="cw-dev-row"
                :class="selectedInputDeviceId === '' ? 'cw-dev-row-on' : ''"
                data-testid="calldock-input-device-option-default"
                @click="handleInputDeviceSelect('')"
              >
                <span class="cw-dev-check"><CallIcon v-if="selectedInputDeviceId === ''" name="check" :size="15" /></span>
                <span class="truncate">System mic</span>
              </button>
              <button
                v-for="device in inputDevices"
                :key="device.deviceId"
                class="cw-dev-row"
                :class="selectedInputDeviceId === device.deviceId ? 'cw-dev-row-on' : ''"
                :data-testid="`calldock-input-device-option-${device.deviceId}`"
                @click="handleInputDeviceSelect(device.deviceId)"
              >
                <span class="cw-dev-check"><CallIcon v-if="selectedInputDeviceId === device.deviceId" name="check" :size="15" /></span>
                <span class="truncate">{{ labelInputDevice(device) }}</span>
              </button>
            </div>
          </div>

          <!-- Raise / lower hand -->
          <button
            class="cw-ctl"
            :class="callStore.localHandRaised ? 'cw-ctl-hand' : ''"
            :title="callStore.localHandRaised ? 'Lower hand' : 'Raise hand'"
            :aria-label="callStore.localHandRaised ? 'Lower hand' : 'Raise hand'"
            :aria-pressed="callStore.localHandRaised"
            :disabled="callStore.handActionInFlight || !callStore.connected"
            data-testid="calldock-raise-hand"
            @click="handleToggleHandRaised"
          >
            <CallIcon name="hand" :size="18" />
          </button>

          <!-- Call reactions -->
          <div ref="reactionPickerWrapEl" class="relative">
            <button
              class="cw-ctl"
              title="Reactions"
              aria-label="Reactions"
              aria-haspopup="menu"
              :aria-expanded="reactionPickerOpen"
              :disabled="!callStore.connected"
              data-testid="calldock-reactions-toggle"
              @click="toggleReactionPicker"
            >
              <CallIcon name="smile" :size="18" />
            </button>
            <div
              v-if="reactionPickerOpen"
              class="cw-react-pop"
              role="menu"
              aria-label="Call reactions"
              data-testid="calldock-reactions-picker"
            >
              <button
                v-for="reaction in reactionOptions"
                :key="reaction.emoji"
                class="cw-react-emoji"
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
            class="cw-ctl"
            :class="callStore.cameraEnabled ? '' : 'cw-ctl-off'"
            :title="callStore.cameraEnabled ? 'Turn off camera' : 'Turn on camera'"
            @click="handleToggleCamera"
          >
            <CallIcon :name="callStore.cameraEnabled ? 'video' : 'videoOff'" :size="18" />
          </button>

          <!-- Screen share -->
          <button
            class="cw-ctl"
            :class="[
              callStore.screenShareEnabled ? 'cw-ctl-share' : '',
              !callStore.screenShareEnabled && callStore.remoteScreenShareActive ? 'cw-ctl-disabled' : '',
            ]"
            :title="!callStore.screenShareEnabled && callStore.remoteScreenShareActive
              ? 'Someone is already sharing their screen'
              : callStore.screenShareEnabled ? 'Stop sharing screen' : 'Share screen'"
            :disabled="!callStore.screenShareEnabled && callStore.remoteScreenShareActive"
            @click="handleToggleScreenShare"
          >
            <CallIcon :name="callStore.screenShareEnabled ? 'screenShare' : 'screenShareOff'" :size="18" />
          </button>

          <!-- Screen annotation -->
          <button
            class="cw-ctl"
            :class="[annotationDrawMode ? 'cw-ctl-anno' : '', !annotationCanDraw ? 'cw-ctl-disabled' : '']"
            data-testid="calldock-annotation-toggle"
            :title="annotationToggleTitle"
            :disabled="!annotationCanDraw"
            @click="toggleAnnotationDrawMode"
          >
            <CallIcon name="pencil" :size="18" />
          </button>

          <!-- Invite members -->
          <button
            class="cw-ctl cw-ctl-invite"
            title="Invite members"
            data-testid="calldock-invite-button"
            :disabled="inviteLoading || inviteSubmitting"
            :class="inviteLoading || inviteSubmitting ? 'cw-ctl-disabled' : ''"
            @click="openInviteDialog"
          >
            <CallIcon name="userPlus" :size="16" />
            <span>Invite</span>
          </button>

          <!-- End call -->
          <button class="cw-ctl cw-ctl-leave" title="Leave call" @click="handleLeave">
            <CallIcon name="phone" :size="18" class="rotate-[135deg]" />
          </button>

          <!-- Mute hotkey hint -->
          <span class="cw-kbd-hint">
            <kbd class="cw-kbd">⌘D</kbd>
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
      class="cw-modal-overlay"
      data-testid="calldock-invite-modal"
      @click.self="closeInviteDialog"
    >
      <div class="cw-modal" role="dialog" aria-modal="true" aria-label="Invite members to call">
        <header class="cw-modal-head">
          <div class="cw-modal-title">Invite members</div>
          <div class="cw-modal-sub">Select members and send invite notifications.</div>
        </header>

        <div v-if="inviteError" class="cw-modal-note cw-modal-note-danger">
          {{ inviteError }}
        </div>
        <div v-if="inviteResultSummary" class="cw-modal-note cw-modal-note-ok">
          {{ inviteResultSummary }}
        </div>

        <div class="cw-modal-search">
          <CallIcon name="search" :size="15" class="shrink-0 text-[var(--cw-text-3)]" />
          <input
            v-model="inviteSearch"
            type="text"
            data-testid="calldock-invite-search"
            placeholder="Search by nickname or email..."
            class="cw-modal-input"
            autofocus
          >
          <kbd class="cw-kbd">⌘K</kbd>
        </div>

        <div class="cw-modal-list">
          <div v-if="inviteLoading" class="cw-modal-empty">
            Loading members...
          </div>
          <div v-else-if="inviteCandidates.length === 0" class="cw-modal-empty">
            No members are available to invite.
          </div>
          <div v-else-if="filteredInviteCandidates.length === 0" class="cw-modal-empty">
            No members match your search.
          </div>
          <template v-else>
            <button
              v-for="candidate in filteredInviteCandidates"
              :key="candidate.userId"
              :data-testid="`calldock-invite-candidate-${candidate.userId}`"
              class="cw-inv-row"
              :class="candidate.inCall ? 'cw-inv-row-disabled' : ''"
              :disabled="candidate.inCall"
              @click="toggleInviteCandidate(candidate.userId)"
            >
              <UserAvatar
                :user-id="candidate.userId"
                :display-name="candidate.displayName || candidate.email"
                :avatar-url="candidate.avatarUrl"
                size="sm"
                class="!h-[34px] !w-[34px]"
              />
              <div class="min-w-0 flex-1">
                <div class="truncate text-[13.5px] font-medium leading-tight text-[var(--cw-text-1)]">{{ candidate.displayName || candidate.email }}</div>
                <div class="truncate text-[12px] text-[var(--cw-text-3)]">{{ candidate.email }}</div>
              </div>
              <span v-if="candidate.inCall" class="cw-in-call">In call</span>
              <span
                v-else
                class="cw-checkbox"
                :class="selectedInviteeIds.includes(candidate.userId) ? 'cw-checkbox-on' : ''"
              >
                <CallIcon v-if="selectedInviteeIds.includes(candidate.userId)" name="check" :size="13" />
              </span>
            </button>
          </template>
        </div>

        <footer class="cw-modal-foot">
          <span class="cw-modal-count">Selected: {{ selectedInviteeIds.length }}</span>
          <div class="flex items-center gap-2">
            <button class="cw-btn-ghost" @click="closeInviteDialog">
              Close
            </button>
            <button
              class="cw-btn-primary"
              data-testid="calldock-send-invites"
              :disabled="inviteLoading || inviteSubmitting || selectedInviteeIds.length === 0"
              @click="sendCallInvites"
            >
              <CallIcon name="send" :size="14" />
              {{ inviteSubmitting ? 'Sending...' : 'Send invites' }}
            </button>
          </div>
        </footer>
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
import CallIcon from './CallIcon.vue'
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
  /** Already connected to the active call — shown as a disabled row. */
  inCall?: boolean
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

// ── Elapsed call timer ────────────────────────────────────────────────────────

const callStartedAt = ref<number | null>(null)
const elapsedSeconds = ref(0)
let elapsedTicker: ReturnType<typeof setInterval> | null = null

watch(() => callStore.connected, (connected) => {
  if (connected) {
    callStartedAt.value = Date.now()
    elapsedSeconds.value = 0
    if (!elapsedTicker) {
      elapsedTicker = setInterval(() => {
        if (callStartedAt.value === null) return
        elapsedSeconds.value = Math.floor((Date.now() - callStartedAt.value) / 1000)
      }, 1000)
    }
    return
  }
  callStartedAt.value = null
  elapsedSeconds.value = 0
  if (elapsedTicker) {
    clearInterval(elapsedTicker)
    elapsedTicker = null
  }
})

const elapsedLabel = computed(() => {
  if (callStartedAt.value === null) return 'Connecting…'
  const total = Math.max(0, elapsedSeconds.value)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
})

const participantCount = computed(() => participantTiles.value.length)

const filteredInviteCandidates = computed(() => {
  const query = normalizeCallInviteSearchQuery(inviteSearch.value)
  if (!query) return inviteCandidates.value
  return inviteCandidates.value.filter(candidate => matchesCallInviteSearch(candidate, query))
})

const containerClass = computed(() =>
  maximized.value ? 'fixed inset-0 z-50' : 'fixed inset-0 z-50 pointer-events-none'
)

const panelClass = computed(() =>
  maximized.value ? 'cw-window cw-window-max' : 'cw-window'
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
    ? 'flex min-h-0 flex-1 flex-col overflow-hidden'
    : 'flex flex-col'
)

// Tile grid — explicit rows/heights in maximized mode to avoid tile overlap.
const tileGridClass = computed(() => {
  const n = participantTiles.value.length
  const base = 'cw-grid'
  if (maximized.value) {
    if (n <= 1) return `${base} cw-grid-1`
    if (n === 2) return `${base} cw-grid-2`
    if (n <= 4) return `${base} cw-grid-4`
    return `${base} cw-grid-many cw-grid-scroll`
  }
  if (n <= 1) return `${base} cw-grid-1`
  if (n === 2) return `${base} cw-grid-2`
  if (n <= 4) return `${base} cw-grid-4`
  return `${base} cw-grid-many`
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
// `group` drives the Tailwind group-hover reveals inside tiles.
const tileItemClass = computed(() =>
  maximized.value ? 'cw-tile cw-tile-max group' : 'cw-tile group'
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
  if (elapsedTicker) {
    clearInterval(elapsedTicker)
    elapsedTicker = null
  }

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
    // Only the current user is excluded from the list; members already
    // connected to this call stay visible as disabled "In call" rows.
    const selfUserId = authStore.user?.id ?? chatStore.workspace?.selfUserId ?? ''
    const inCall = activeCallParticipantIds()
    inviteCandidates.value = members
      .filter(member => member.user_id && member.user_id !== selfUserId)
      .map(member => ({
        ...toInviteCandidate(member),
        inCall: inCall.has(member.user_id),
      }))
  } catch (err) {
    inviteCandidates.value = []
    inviteError.value = err instanceof Error ? err.message : 'Failed to load members'
  } finally {
    inviteLoading.value = false
  }
}

function toggleInviteCandidate(userId: string) {
  const candidate = inviteCandidates.value.find(item => item.userId === userId)
  if (!candidate || candidate.inCall) return
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

<style scoped>
/* ═══ Call window — A2 «Console» design ═════════════════════════════════════
   Fixed dark graphite theme independent of the app color themes (Zoom-style
   local tokens). Token block is repeated on each teleported/root element so
   children resolve the vars in every mount context. */

.cw-window,
.cw-pill,
.cw-modal-overlay {
  --cw-bg: #101216;
  --cw-surface: #14161b;
  --cw-raised: #1a1d24;
  --cw-stage: #07080a;
  --cw-line: rgba(255, 255, 255, 0.08);
  --cw-line-strong: rgba(255, 255, 255, 0.14);
  --cw-text-1: #e9ebf0;
  --cw-text-2: #b4b8c2;
  --cw-text-3: #82868f;
  --cw-accent: #7c86e8;
  --cw-accent-soft: rgba(124, 134, 232, 0.14);
  --cw-accent-border: rgba(124, 134, 232, 0.42);
  --cw-accent-text: #aeb5f2;
  --cw-live: #4cd48a;
  --cw-danger: #e5484d;
  --cw-danger-hover: #f05a5f;
  --cw-amber: #f2b33d;
  --cw-amber-soft: rgba(242, 179, 61, 0.16);
}

/* ── Window ──────────────────────────────────────────────────────────────── */

.cw-window {
  position: absolute;
  display: flex;
  flex-direction: column;
  width: min(96vw, 980px);
  overflow: hidden;
  border: 1px solid var(--cw-line-strong);
  border-radius: 14px;
  background: var(--cw-bg);
  color: var(--cw-text-2);
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.55), 0 4px 18px rgba(0, 0, 0, 0.4);
  pointer-events: auto;
  font-size: 13px;
  line-height: 1.45;
}

.cw-window-max {
  position: relative;
  width: 100%;
  height: 100%;
  border: none;
  border-radius: 0;
}

/* ── Top bar ─────────────────────────────────────────────────────────────── */

.cw-topbar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 56px;
  padding: 0 14px;
  border-bottom: 1px solid var(--cw-line);
  background: var(--cw-surface);
  flex-shrink: 0;
}

.cw-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 9px;
  border: 1px solid var(--cw-line);
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.04);
  font-size: 11.5px;
  font-weight: 500;
  color: var(--cw-text-2);
  white-space: nowrap;
}

.cw-chip-ok {
  border-color: rgba(76, 212, 138, 0.25);
  background: rgba(76, 212, 138, 0.08);
  color: var(--cw-live);
}

.cw-iconbtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  color: var(--cw-text-3);
}

button.cw-iconbtn {
  cursor: pointer;
}

button.cw-iconbtn:hover {
  background: rgba(255, 255, 255, 0.06);
  color: var(--cw-text-1);
}

.cw-dot-live {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--cw-live);
  box-shadow: 0 0 0 3px rgba(76, 212, 138, 0.15);
  flex-shrink: 0;
}

/* ── Stage ───────────────────────────────────────────────────────────────── */

.cw-stage-zone {
  position: relative;
  height: 476px;
  background: var(--cw-stage);
  overflow: hidden;
  flex-shrink: 0;
}

.cw-window-max .cw-stage-zone {
  height: auto;
  min-height: 0;
  flex: 1 1 0;
}

.cw-owner {
  position: absolute;
  left: 12px;
  bottom: 12px;
  z-index: 10;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 26px;
  padding: 0 9px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 7px;
  background: rgba(10, 11, 14, 0.72);
  backdrop-filter: blur(6px);
  font-size: 11.5px;
  font-weight: 500;
  color: var(--cw-text-1);
}

.cw-ghost {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 11px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 9px;
  background: rgba(10, 11, 14, 0.72);
  backdrop-filter: blur(6px);
  font-size: 12px;
  font-weight: 500;
  color: var(--cw-text-1);
  cursor: pointer;
  white-space: nowrap;
}

.cw-ghost:hover {
  background: rgba(255, 255, 255, 0.12);
}

.cw-pin-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 9px;
  border: 1px solid var(--cw-accent-border);
  border-radius: 7px;
  background: rgba(10, 11, 14, 0.72);
  backdrop-filter: blur(6px);
  font-size: 11.5px;
  font-weight: 600;
  color: var(--cw-accent-text);
}

.cw-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  height: 24px;
  padding: 0 8px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 7px;
  background: rgba(10, 11, 14, 0.72);
  backdrop-filter: blur(6px);
  font-size: 11px;
  font-weight: 500;
  color: var(--cw-text-1);
}

.cw-eq {
  display: inline-flex;
  align-items: flex-end;
  gap: 1.5px;
  height: 10px;
  flex-shrink: 0;
}

.cw-eq i {
  width: 2.5px;
  height: 5px;
  border-radius: 1px;
  background: var(--cw-text-3);
  transform-origin: center bottom;
}

.cw-eq i:nth-child(2) { height: 8px; }
.cw-eq i:nth-child(3) { height: 6px; }

.cw-eq-on i {
  background: var(--cw-live);
  animation: cw-eq-bounce 0.9s ease-in-out infinite;
}

.cw-eq-on i:nth-child(2) { animation-delay: 0.15s; }
.cw-eq-on i:nth-child(3) { animation-delay: 0.3s; }

@keyframes cw-eq-bounce {
  0%, 100% { transform: scaleY(0.45); }
  50% { transform: scaleY(1); }
}

.cw-hand {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 9px;
  border-radius: 8px;
  background: var(--cw-amber);
  color: #171106;
  font-size: 11.5px;
  box-shadow: 0 6px 18px rgba(242, 179, 61, 0.25);
}

.cw-react {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 999px;
  background: rgba(10, 11, 14, 0.78);
  font-size: 17px;
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.45);
}

.cw-sharechip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--cw-accent-border);
  border-radius: 7px;
  background: var(--cw-accent-soft);
  font-size: 11px;
  font-weight: 600;
  color: var(--cw-accent-text);
}

.cw-pinbtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  background: rgba(10, 11, 14, 0.72);
  color: var(--cw-text-1);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s ease, background 0.15s ease;
}

.cw-tile:hover .cw-pinbtn,
.cw-pinbtn:focus-visible {
  opacity: 1;
}

.cw-pinbtn:hover {
  background: rgba(255, 255, 255, 0.14);
}

.cw-tile {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--cw-line);
  border-radius: 12px;
  background: var(--cw-raised);
}

.cw-tile-max {
  height: 100%;
}

.cw-tile-speaking {
  border-color: var(--cw-accent-border);
  box-shadow: 0 0 0 1px var(--cw-accent-border), 0 0 18px rgba(124, 134, 232, 0.18);
}

.cw-grid {
  display: grid;
  gap: 10px;
  width: 100%;
  height: 100%;
  padding: 12px;
  min-height: 0;
}

.cw-grid-1 { grid-template-columns: 1fr; }
.cw-grid-2 { grid-template-columns: repeat(2, 1fr); }
.cw-grid-4 {
  grid-template-columns: repeat(2, 1fr);
  grid-template-rows: repeat(2, minmax(0, 1fr));
}
.cw-grid-many { grid-template-columns: repeat(3, 1fr); }
.cw-grid-scroll {
  overflow-y: auto;
  align-content: start;
}

/* ── Annotation toolbar (static showcase) ────────────────────────────────── */

.cw-anno {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 30;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 42px;
  padding: 0 8px;
  border: 1px solid var(--cw-line-strong);
  border-radius: 12px;
  background: rgba(10, 11, 14, 0.82);
  backdrop-filter: blur(8px);
  box-shadow: 0 12px 34px rgba(0, 0, 0, 0.45);
}

.cw-anno-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  color: var(--cw-text-3);
}

.cw-anno-btn-on {
  background: var(--cw-accent-soft);
  color: var(--cw-accent-text);
}

.cw-anno-sep {
  width: 1px;
  height: 18px;
  margin: 0 3px;
  background: var(--cw-line-strong);
}

.cw-anno-swatch {
  width: 16px;
  height: 16px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 6px;
}

/* ── Banners ─────────────────────────────────────────────────────────────── */

.cw-banner {
  margin: 10px 12px 0;
  padding: 8px 12px;
  border-radius: 10px;
  font-size: 12.5px;
  flex-shrink: 0;
}

.cw-banner-danger {
  border: 1px solid rgba(229, 72, 77, 0.35);
  background: rgba(229, 72, 77, 0.12);
  color: #f5a3a6;
}

.cw-banner-amber {
  border: 1px solid rgba(242, 179, 61, 0.4);
  background: var(--cw-amber-soft);
  color: var(--cw-amber);
}

.cw-mini-btn {
  height: 26px;
  padding: 0 10px;
  border-radius: 8px;
  background: rgba(242, 179, 61, 0.9);
  color: #171106;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

/* ── Console ─────────────────────────────────────────────────────────────── */

.cw-console {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 10px 16px;
  border-top: 1px solid var(--cw-line);
  background: var(--cw-surface);
  flex-shrink: 0;
}

.cw-ctl-group {
  position: relative;
  display: flex;
  align-items: center;
  border: 1px solid var(--cw-line-strong);
  border-radius: 12px;
  background: var(--cw-raised);
}

.cw-ctl {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 42px;
  height: 42px;
  border-radius: 10px;
  color: var(--cw-text-2);
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.15s ease, color 0.15s ease;
}

.cw-ctl:hover {
  background: rgba(255, 255, 255, 0.06);
  color: var(--cw-text-1);
}

.cw-ctl:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.cw-ctl-sep {
  width: 1px;
  height: 20px;
  background: var(--cw-line-strong);
  flex-shrink: 0;
}

.cw-ctl-chev { width: 30px; }

.cw-ctl-off {
  background: rgba(229, 72, 77, 0.14);
  color: var(--cw-danger);
}

.cw-ctl-off:hover {
  background: rgba(229, 72, 77, 0.22);
  color: var(--cw-danger);
}

.cw-ctl-hand {
  background: var(--cw-amber-soft);
  color: var(--cw-amber);
}

.cw-ctl-hand:hover {
  background: rgba(242, 179, 61, 0.26);
  color: var(--cw-amber);
}

.cw-ctl-share,
.cw-ctl-anno {
  background: var(--cw-accent-soft);
  color: var(--cw-accent-text);
}

.cw-ctl-share:hover,
.cw-ctl-anno:hover {
  background: rgba(124, 134, 232, 0.24);
  color: var(--cw-accent-text);
}

.cw-ctl-disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.cw-ctl-invite {
  width: auto;
  padding: 0 13px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--cw-text-1);
}

.cw-ctl-leave {
  background: var(--cw-danger);
  color: #fff;
}

.cw-ctl-leave:hover {
  background: var(--cw-danger-hover);
  color: #fff;
}

.cw-kbd-hint {
  position: absolute;
  right: 16px;
  top: 50%;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10.5px;
  color: var(--cw-text-3);
  pointer-events: none;
  user-select: none;
}

.cw-kbd {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 5px;
  border: 1px solid var(--cw-line-strong);
  border-radius: 5px;
  background: var(--cw-raised);
  font-family: inherit;
  font-size: 10.5px;
  color: var(--cw-text-3);
}

/* ── Popovers ────────────────────────────────────────────────────────────── */

.cw-pop {
  position: absolute;
  bottom: calc(100% + 10px);
  left: 0;
  z-index: 40;
  width: 288px;
  padding: 6px;
  border: 1px solid var(--cw-line-strong);
  border-radius: 14px;
  background: var(--cw-raised);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.5);
}

.cw-pop-head {
  padding: 8px 10px 6px;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--cw-text-3);
}

.cw-dev-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border-radius: 9px;
  font-size: 12.5px;
  color: var(--cw-text-2);
  cursor: pointer;
  text-align: left;
}

.cw-dev-row:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--cw-text-1);
}

.cw-dev-row-on {
  color: var(--cw-text-1);
  font-weight: 500;
}

.cw-dev-check {
  display: inline-flex;
  justify-content: center;
  width: 15px;
  color: var(--cw-accent);
  flex-shrink: 0;
}

.cw-react-pop {
  position: absolute;
  bottom: calc(100% + 10px);
  left: 50%;
  transform: translateX(-50%);
  z-index: 40;
  display: flex;
  gap: 4px;
  padding: 6px;
  border: 1px solid var(--cw-line-strong);
  border-radius: 14px;
  background: var(--cw-raised);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.5);
}

.cw-react-emoji {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  font-size: 19px;
  cursor: pointer;
}

.cw-react-emoji:hover {
  background: rgba(255, 255, 255, 0.07);
}

/* ── Minimized pill ──────────────────────────────────────────────────────── */

.cw-pill {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  height: 44px;
  padding: 0 8px 0 14px;
  border: 1px solid var(--cw-line-strong);
  border-radius: 999px;
  background: rgba(16, 18, 22, 0.92);
  backdrop-filter: blur(10px);
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.5);
  font-size: 12.5px;
  color: var(--cw-text-1);
  cursor: default;
  user-select: none;
}

.cw-pill-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 999px;
  color: var(--cw-text-2);
  cursor: pointer;
}

.cw-pill-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--cw-text-1);
}

.cw-pill-btn-mic-off {
  background: rgba(229, 72, 77, 0.14);
  color: var(--cw-danger);
}

.cw-pill-btn-leave {
  background: var(--cw-danger);
  color: #fff;
}

.cw-pill-btn-leave:hover {
  background: var(--cw-danger-hover);
  color: #fff;
}

/* ── Invite modal ────────────────────────────────────────────────────────── */

.cw-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(4, 5, 7, 0.62);
  backdrop-filter: blur(3px);
}

.cw-modal {
  display: flex;
  flex-direction: column;
  width: min(100vw, 430px);
  max-height: min(86vh, 640px);
  overflow: hidden;
  border: 1px solid var(--cw-line-strong);
  border-radius: 16px;
  background: var(--cw-raised);
  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.6);
  color: var(--cw-text-2);
}

.cw-modal-head {
  padding: 16px 16px 12px;
}

.cw-modal-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--cw-text-1);
}

.cw-modal-sub {
  margin-top: 2px;
  font-size: 12.5px;
  color: var(--cw-text-3);
}

.cw-modal-note {
  padding: 8px 16px;
  border-top: 1px solid var(--cw-line);
  border-bottom: 1px solid var(--cw-line);
  font-size: 12.5px;
}

.cw-modal-note-danger {
  background: rgba(229, 72, 77, 0.1);
  color: #f5a3a6;
}

.cw-modal-note-ok {
  background: rgba(76, 212, 138, 0.08);
  color: var(--cw-live);
}

.cw-modal-search {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  margin: 4px 16px 10px;
  padding: 0 10px;
  border: 1px solid var(--cw-line-strong);
  border-radius: 10px;
  background: var(--cw-surface);
}

.cw-modal-search:focus-within {
  border-color: var(--cw-accent-border);
}

.cw-modal-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  font-size: 13px;
  color: var(--cw-text-1);
}

.cw-modal-input::placeholder {
  color: var(--cw-text-3);
}

.cw-modal-list {
  flex: 1 1 auto;
  min-height: 120px;
  overflow-y: auto;
  padding: 0 8px 8px;
}

.cw-modal-empty {
  padding: 28px 12px;
  font-size: 12.5px;
  color: var(--cw-text-3);
  text-align: center;
}

.cw-inv-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px;
  border-radius: 10px;
  cursor: pointer;
  text-align: left;
}

.cw-inv-row:hover {
  background: rgba(255, 255, 255, 0.05);
}

.cw-inv-row-disabled {
  opacity: 0.55;
  cursor: default;
}

.cw-inv-row-disabled:hover {
  background: transparent;
}

.cw-in-call {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 8px;
  border: 1px solid rgba(76, 212, 138, 0.28);
  border-radius: 999px;
  background: rgba(76, 212, 138, 0.1);
  color: var(--cw-live);
  font-size: 10.5px;
  font-weight: 600;
  flex-shrink: 0;
}

.cw-checkbox {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 19px;
  height: 19px;
  border: 1px solid var(--cw-line-strong);
  border-radius: 6px;
  background: transparent;
  color: #10131a;
  flex-shrink: 0;
}

.cw-checkbox-on {
  border-color: var(--cw-accent);
  background: var(--cw-accent);
}

.cw-modal-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-top: 1px solid var(--cw-line);
  background: var(--cw-surface);
}

.cw-modal-count {
  font-size: 12px;
  color: var(--cw-text-3);
}

.cw-btn-ghost {
  height: 32px;
  padding: 0 12px;
  border-radius: 9px;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--cw-text-2);
  cursor: pointer;
}

.cw-btn-ghost:hover {
  background: rgba(255, 255, 255, 0.06);
  color: var(--cw-text-1);
}

.cw-btn-primary {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 32px;
  padding: 0 14px;
  border-radius: 9px;
  background: var(--cw-accent);
  color: #10131a;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
}

.cw-btn-primary:hover {
  background: #8d96ec;
}

.cw-btn-primary:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

@media (prefers-reduced-motion: reduce) {
  .cw-eq-on i {
    animation: none;
  }
}
</style>
