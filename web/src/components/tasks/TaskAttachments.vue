<template>
  <div
    data-testid="task-attachments-dropzone"
    class="rounded-lg border border-transparent transition-colors"
    :class="isDragOver ? 'border-accent bg-chat-input/70' : ''"
    @dragenter.prevent="onDragEnter"
    @dragover.prevent="onDragOver"
    @dragleave.prevent="onDragLeave"
    @drop.prevent="onDrop"
  >
    <div class="flex items-center justify-between mb-3">
      <span class="text-xs text-gray-500 uppercase tracking-wide">
        Attachments ({{ attachments.length }})
      </span>
      <label
        class="text-xs text-accent hover:text-accent-hover transition-colors cursor-pointer"
        :class="uploading ? 'opacity-50 pointer-events-none' : ''"
      >
        {{ uploading ? `Uploading… (${uploadProgress.done}/${uploadProgress.total})` : '+ Add file' }}
        <input
          ref="fileInput"
          type="file"
          class="hidden"
          multiple
          @change="handleFileChange"
        />
      </label>
    </div>

    <!-- Global error -->
    <p v-if="error" class="text-red-400 text-xs mb-2">{{ error }}</p>

    <!-- Per-file upload errors -->
    <ul v-if="uploadErrors.length" class="mb-2 space-y-0.5">
      <li v-for="(ue, i) in uploadErrors" :key="i" class="text-red-400 text-xs">
        {{ ue.name }}: {{ ue.message }}
      </li>
    </ul>
    <p v-if="isDragOver" class="text-accent text-xs mb-2 px-0.5">Drop files to attach</p>

    <!-- Loading -->
    <div v-if="loading" class="text-sm text-gray-500 italic">Loading…</div>

    <!-- Empty state -->
    <p v-else-if="!attachments.length" class="text-sm text-gray-500 italic">No attachments yet</p>

    <!-- Attachment list -->
    <ul v-else class="space-y-1.5">
      <li
        v-for="att in attachments"
        :key="att.id"
        class="rounded bg-chat-input border border-chat-border transition-colors"
        :class="audioPlayer.attachmentId === att.id && audioPlayer.open
          ? 'border-accent/40'
          : 'hover:border-accent/30'"
      >
        <!-- Main row -->
        <div class="flex items-center gap-3 px-3 py-2 group">

          <!-- Leading icon / thumbnail -->
          <span class="shrink-0">
            <!-- Image thumbnail -->
            <button
              v-if="isImage(att.mime_type)"
              class="block w-10 h-10 rounded overflow-hidden bg-black/20 focus:outline-none focus:ring-2 focus:ring-accent"
              title="Preview image"
              @click="openLightbox(att)"
            >
              <img
                v-if="thumbs[att.id]"
                :src="thumbs[att.id]!"
                :alt="att.file_name"
                class="w-full h-full object-cover"
              />
              <!-- Fetch failed — show a broken-image placeholder -->
              <span v-else-if="thumbs[att.id] === null" class="flex items-center justify-center w-full h-full text-gray-600" title="Preview unavailable">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3 3l18 18M9.75 9.75a2.25 2.25 0 110-4.5 2.25 2.25 0 010 4.5z" /></svg>
              </span>
              <!-- Still fetching -->
              <span v-else class="flex items-center justify-center w-full h-full text-gray-600">
                <SpinnerIcon class="w-4 h-4" />
              </span>
            </button>

            <!-- Video play badge -->
            <button
              v-else-if="isVideo(att.mime_type)"
              class="flex items-center justify-center w-10 h-10 rounded bg-black/30 border border-white/10 text-accent hover:text-accent-hover hover:bg-black/50 transition-colors focus:outline-none focus:ring-2 focus:ring-accent"
              title="Play video"
              @click="openPlayer(att)"
            >
              <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
            </button>

            <!-- Audio waveform / play badge -->
            <button
              v-else-if="isAudio(att.mime_type)"
              class="flex items-center justify-center w-10 h-10 rounded bg-black/30 border border-white/10 transition-colors focus:outline-none focus:ring-2 focus:ring-accent"
              :class="audioPlayer.attachmentId === att.id && audioPlayer.open
                ? 'text-accent border-accent/40'
                : 'text-gray-400 hover:text-accent hover:bg-black/50'"
              :title="audioPlayer.attachmentId === att.id && audioPlayer.open ? 'Collapse player' : 'Play audio'"
              @click="toggleAudio(att)"
            >
              <!-- Animated bars when this file is playing -->
              <span
                v-if="audioPlayer.attachmentId === att.id && audioPlayer.open && audioPlayer.playing"
                class="flex items-end gap-[2px] h-5"
              >
                <span class="w-[3px] rounded-full bg-accent animate-audio-bar" style="animation-delay:0ms;height:60%"/>
                <span class="w-[3px] rounded-full bg-accent animate-audio-bar" style="animation-delay:150ms;height:100%"/>
                <span class="w-[3px] rounded-full bg-accent animate-audio-bar" style="animation-delay:75ms;height:75%"/>
                <span class="w-[3px] rounded-full bg-accent animate-audio-bar" style="animation-delay:225ms;height:45%"/>
              </span>
              <!-- Static waveform icon otherwise -->
              <svg v-else class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
              </svg>
            </button>

            <!-- Generic file icon -->
            <span v-else class="text-gray-500">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                <polyline points="14,2 14,8 20,8"/>
              </svg>
            </span>
          </span>

          <!-- File info -->
          <div class="flex-1 min-w-0">
            <p class="text-sm text-gray-200 truncate">{{ att.file_name }}</p>
            <p class="text-xs text-gray-500">{{ formatSize(att.file_size) }}</p>
          </div>

          <!-- Row actions -->
          <div class="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              v-if="isImage(att.mime_type)"
              class="p-1 rounded text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
              title="Preview"
              @click="openLightbox(att)"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
              </svg>
            </button>
            <button
              v-else-if="isVideo(att.mime_type)"
              class="p-1 rounded text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
              title="Play video"
              @click="openPlayer(att)"
            >
              <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
            </button>
            <button
              v-else-if="isAudio(att.mime_type)"
              class="p-1 rounded text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
              title="Play audio"
              @click="toggleAudio(att)"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
              </svg>
            </button>

            <!-- Download -->
            <button
              class="p-1 rounded text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
              title="Download"
              :disabled="downloading.has(att.id)"
              @click="download(att)"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                <polyline points="7,10 12,15 17,10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
            </button>

            <!-- Delete -->
            <button
              class="p-1 rounded text-gray-400 hover:text-red-400 hover:bg-white/10 transition-colors"
              title="Delete"
              :disabled="deleting.has(att.id)"
              @click="deleteAttachment(att.id)"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <polyline points="3,6 5,6 21,6"/>
                <path d="M19 6l-1 14H6L5 6"/>
                <path d="M10 11v6"/><path d="M14 11v6"/>
                <path d="M9 6V4h6v2"/>
              </svg>
            </button>
          </div>
        </div>

        <!-- ── Inline audio player (expands below the row) ── -->
        <Transition
          enter-active-class="transition-all duration-200 ease-out overflow-hidden"
          enter-from-class="max-h-0 opacity-0"
          enter-to-class="max-h-24 opacity-100"
          leave-active-class="transition-all duration-150 ease-in overflow-hidden"
          leave-from-class="max-h-24 opacity-100"
          leave-to-class="max-h-0 opacity-0"
        >
          <div
            v-if="audioPlayer.attachmentId === att.id && audioPlayer.open"
            class="px-3 pb-3"
          >
            <!-- Loading -->
            <div v-if="audioPlayer.loading" class="flex items-center gap-2 text-gray-500 text-xs py-1">
              <SpinnerIcon class="w-4 h-4" />
              <span>Loading audio…</span>
            </div>

            <!-- Error -->
            <div v-else-if="audioPlayer.fetchError" class="text-red-400 text-xs py-1">
              {{ audioPlayer.fetchError }}
            </div>

            <!-- Player controls -->
            <div v-else class="flex items-center gap-2">
              <!-- Play / Pause -->
              <button
                class="shrink-0 flex items-center justify-center w-7 h-7 rounded-full bg-accent hover:bg-accent-hover text-white transition-colors focus:outline-none focus:ring-2 focus:ring-accent"
                :title="audioPlayer.playing ? 'Pause' : 'Play'"
                @click="togglePlayPause"
              >
                <svg v-if="audioPlayer.playing" class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                  <rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>
                </svg>
                <svg v-else class="w-3.5 h-3.5 translate-x-px" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z"/>
                </svg>
              </button>

              <!-- Time elapsed -->
              <span class="shrink-0 text-xs text-gray-400 w-10 text-right tabular-nums">
                {{ formatTime(audioPlayer.currentTime) }}
              </span>

              <!-- Scrubber -->
              <div class="flex-1 relative group/scrubber">
                <input
                  type="range"
                  min="0"
                  :max="audioPlayer.duration || 100"
                  step="0.1"
                  :value="audioPlayer.currentTime"
                  class="audio-scrubber w-full h-1 appearance-none rounded-full bg-white/20 cursor-pointer accent-accent"
                  @input="onScrub"
                  @mousedown="onScrubStart"
                  @mouseup="onScrubEnd"
                  @touchstart.passive="onScrubStart"
                  @touchend="onScrubEnd"
                />
              </div>

              <!-- Duration -->
              <span class="shrink-0 text-xs text-gray-500 w-10 tabular-nums">
                {{ audioPlayer.duration ? formatTime(audioPlayer.duration) : '–:––' }}
              </span>

              <!-- Volume -->
              <button
                class="shrink-0 p-1 rounded text-gray-400 hover:text-white transition-colors focus:outline-none"
                :title="audioPlayer.muted ? 'Unmute' : 'Mute'"
                @click="toggleMute"
              >
                <svg v-if="audioPlayer.muted || audioPlayer.volume === 0" class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                  <polygon points="11,5 6,9 2,9 2,15 6,15 11,19"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>
                </svg>
                <svg v-else-if="audioPlayer.volume < 0.5" class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                  <polygon points="11,5 6,9 2,9 2,15 6,15 11,19"/><path d="M15.54 8.46a5 5 0 010 7.07"/>
                </svg>
                <svg v-else class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                  <polygon points="11,5 6,9 2,9 2,15 6,15 11,19"/><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/>
                </svg>
              </button>

              <!-- Volume slider -->
              <input
                type="range"
                min="0"
                max="1"
                step="0.02"
                :value="audioPlayer.muted ? 0 : audioPlayer.volume"
                class="audio-scrubber w-16 h-1 appearance-none rounded-full bg-white/20 cursor-pointer accent-accent"
                @input="onVolumeChange"
              />
            </div>
          </div>
        </Transition>
      </li>
    </ul>

    <!-- ── Image lightbox ──────────────────────────────────────────── -->
    <Teleport to="body">
      <Transition
        enter-active-class="transition duration-200 ease-out"
        enter-from-class="opacity-0"
        enter-to-class="opacity-100"
        leave-active-class="transition duration-150 ease-in"
        leave-from-class="opacity-100"
        leave-to-class="opacity-0"
      >
        <div
          v-if="lightbox.open"
          class="fixed inset-0 z-[100] flex items-center justify-center bg-black/90"
          role="dialog"
          aria-modal="true"
          :aria-label="lightbox.fileName"
          @click.self="closeLightbox"
        >
          <OverlayTopBar
            :downloading="lightbox.downloading"
            @close="closeLightbox"
            @download="downloadFromLightbox"
          />
          <div class="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 px-4 py-1.5 rounded-full bg-black/50 text-white text-xs max-w-xs truncate pointer-events-none">
            {{ lightbox.fileName }}
          </div>
          <div v-if="!lightbox.src" class="flex items-center justify-center">
            <SpinnerIcon class="w-10 h-10 text-white/40" />
          </div>
          <img
            v-else
            :src="lightbox.src"
            :alt="lightbox.fileName"
            class="max-w-full max-h-full object-contain select-none"
            draggable="false"
          />
        </div>
      </Transition>
    </Teleport>

    <!-- ── Video player ────────────────────────────────────────────── -->
    <Teleport to="body">
      <Transition
        enter-active-class="transition duration-200 ease-out"
        enter-from-class="opacity-0"
        enter-to-class="opacity-100"
        leave-active-class="transition duration-150 ease-in"
        leave-from-class="opacity-100"
        leave-to-class="opacity-0"
      >
        <div
          v-if="player.open"
          class="fixed inset-0 z-[100] flex items-center justify-center bg-black"
          role="dialog"
          aria-modal="true"
          :aria-label="player.fileName"
          @click.self="closePlayer"
        >
          <OverlayTopBar
            :downloading="player.downloading"
            @close="closePlayer"
            @download="downloadFromPlayer"
          />
          <div v-if="player.loading" class="flex flex-col items-center gap-3 text-white/60">
            <SpinnerIcon class="w-10 h-10" />
            <span class="text-sm">Loading video…</span>
          </div>
          <div v-else-if="player.fetchError" class="flex flex-col items-center gap-3 text-white/60">
            <svg class="w-10 h-10" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <span class="text-sm">{{ player.fetchError }}</span>
          </div>
          <video
            v-else-if="player.src"
            ref="videoEl"
            :src="player.src"
            :type="player.mimeType"
            class="max-w-full max-h-full outline-none"
            controls
            autoplay
            @click.stop
          />
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted, watch, nextTick, defineComponent, h } from 'vue'
import {
  tasksListAttachments,
  tasksUploadAttachments,
  tasksDeleteAttachment,
  tasksDownloadAttachment,
  type TaskAttachment,
} from '@/services/http/tasksApi'
import { createAuthenticatedClient } from '@/services/http/client'

const props = defineProps<{ taskId: string }>()

// ── Inline sub-components ─────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const SpinnerIcon = defineComponent({
  props: { class: String },
  setup(p) {
    return () => h('svg', {
      class: ['animate-spin text-white/40', p.class].filter(Boolean).join(' '),
      fill: 'none', viewBox: '0 0 24 24',
    }, [
      h('circle', { class: 'opacity-25', cx: 12, cy: 12, r: 10, stroke: 'currentColor', 'stroke-width': 4 }),
      h('path', { class: 'opacity-75', fill: 'currentColor', d: 'M4 12a8 8 0 018-8v8H4z' }),
    ])
  },
})

// Shared top-bar for image and video overlays.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const OverlayTopBar = defineComponent({
  props: { downloading: Boolean },
  emits: ['close', 'download'],
  setup(_p, { emit }) {
    return () => h('div', {
      class: 'absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-4 py-3 pointer-events-none',
    }, [
      h('button', {
        class: 'pointer-events-auto flex items-center justify-center w-9 h-9 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors focus:outline-none focus:ring-2 focus:ring-white/50',
        title: 'Download',
        disabled: _p.downloading,
        onClick: () => emit('download'),
      }, [
        h('svg', { class: 'w-4 h-4', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, viewBox: '0 0 24 24' }, [
          h('path', { d: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4' }),
          h('polyline', { points: '7,10 12,15 17,10' }),
          h('line', { x1: 12, y1: 15, x2: 12, y2: 3 }),
        ]),
      ]),
      h('button', {
        class: 'pointer-events-auto flex items-center justify-center w-9 h-9 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors focus:outline-none focus:ring-2 focus:ring-white/50',
        'aria-label': 'Close',
        onClick: () => emit('close'),
      }, [
        h('svg', { class: 'w-5 h-5', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, viewBox: '0 0 24 24' }, [
          h('path', { d: 'M6 18L18 6M6 6l12 12' }),
        ]),
      ]),
    ])
  },
})

// ── State ─────────────────────────────────────────────────────────────────

const attachments = ref<TaskAttachment[]>([])
const loading = ref(false)
const error = ref('')
const uploading = ref(false)
const uploadErrors = ref<{ name: string; message: string }[]>([])
const uploadProgress = ref({ done: 0, total: 0 })
const downloading = ref(new Set<string>())
const deleting = ref(new Set<string>())
const isDragOver = ref(false)
let dragDepth = 0

// thumbs maps attachment id → blob URL (string) or null (fetch failed).
// undefined means not yet attempted.
const thumbs = ref<Record<string, string | null>>({})
const thumbFetching = new Set<string>()

// ── Image lightbox ────────────────────────────────────────────────────────

const lightbox = reactive({
  open: false,
  attachmentId: '',
  fileName: '',
  src: '',
  downloading: false,
})

// ── Video player (full-screen overlay) ───────────────────────────────────

const player = reactive({
  open: false,
  attachmentId: '',
  fileName: '',
  mimeType: '',
  src: '',
  loading: false,
  fetchError: '',
  downloading: false,
})
const videoEl = ref<HTMLVideoElement | null>(null)

// ── Audio player (inline, per-row) ───────────────────────────────────────

const audioPlayer = reactive({
  open: false,           // whether the inline player panel is expanded
  attachmentId: '',
  fileName: '',
  mimeType: '',
  src: '',               // blob URL
  loading: false,
  fetchError: '',
  playing: false,
  currentTime: 0,
  duration: 0,
  volume: 1,
  muted: false,
  scrubbing: false,      // true while user drags the scrubber
})
const audioEl = ref<HTMLAudioElement | null>(null)

// ── Shared blob fetch ─────────────────────────────────────────────────────

async function fetchBlob(attachmentId: string): Promise<string> {
  const http = createAuthenticatedClient()
  const { data } = await http.get<Blob>(
    `/api/tasks/${props.taskId}/attachments/${attachmentId}/download`,
    { responseType: 'blob' },
  )
  return URL.createObjectURL(data)
}

// ── Image thumbnails ──────────────────────────────────────────────────────

async function loadThumbs(list: TaskAttachment[]) {
  for (const att of list) {
    // Skip if: not an image, already resolved (url or null), or fetch in-flight
    if (!isImage(att.mime_type) || att.id in thumbs.value || thumbFetching.has(att.id)) continue
    thumbFetching.add(att.id)
    fetchBlob(att.id)
      .then(url => { thumbs.value = { ...thumbs.value, [att.id]: url } })
      .catch(() => {
        // Record failure so the spinner is replaced with an error state instead
        // of spinning forever. Also clear the in-flight guard so the user can
        // retry by navigating away and back (component remount).
        thumbFetching.delete(att.id)
        thumbs.value = { ...thumbs.value, [att.id]: null }
      })
  }
}

watch(attachments, (list) => loadThumbs(list), { immediate: false })

// ── Lightbox ──────────────────────────────────────────────────────────────

async function openLightbox(att: TaskAttachment) {
  lightbox.open = true
  lightbox.attachmentId = att.id
  lightbox.fileName = att.file_name
  lightbox.downloading = false
  if (thumbs.value[att.id]) {
    lightbox.src = thumbs.value[att.id]!
  } else {
    lightbox.src = ''
    fetchBlob(att.id)
      .then(url => {
        if (lightbox.open && lightbox.attachmentId === att.id) {
          lightbox.src = url
          thumbs.value = { ...thumbs.value, [att.id]: url }
        }
      })
      .catch(() => {
        if (lightbox.open && lightbox.attachmentId === att.id) {
          lightbox.open = false
          error.value = 'Failed to load image preview'
        }
      })
  }
}

function closeLightbox() {
  lightbox.open = false
  lightbox.src = ''
}

async function downloadFromLightbox() {
  if (lightbox.downloading) return
  lightbox.downloading = true
  try {
    await tasksDownloadAttachment(props.taskId, lightbox.attachmentId, lightbox.fileName)
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Download failed'
  } finally {
    lightbox.downloading = false
  }
}

// ── Video player ──────────────────────────────────────────────────────────

async function openPlayer(att: TaskAttachment) {
  if (player.src) { URL.revokeObjectURL(player.src); player.src = '' }
  player.open = true
  player.attachmentId = att.id
  player.fileName = att.file_name
  player.mimeType = att.mime_type
  player.loading = true
  player.fetchError = ''
  player.downloading = false
  try {
    const url = await fetchBlob(att.id)
    if (!player.open || player.attachmentId !== att.id) { URL.revokeObjectURL(url); return }
    player.src = url
    player.loading = false
    await nextTick()
    videoEl.value?.play().catch(() => {})
  } catch (e) {
    if (player.open && player.attachmentId === att.id) {
      player.loading = false
      player.fetchError = e instanceof Error ? e.message : 'Failed to load video'
    }
  }
}

function closePlayer() {
  if (videoEl.value) { videoEl.value.pause(); videoEl.value.src = ''; videoEl.value.load() }
  if (player.src) { URL.revokeObjectURL(player.src); player.src = '' }
  player.open = false; player.fetchError = ''; player.loading = false
}

async function downloadFromPlayer() {
  if (player.downloading) return
  player.downloading = true
  try {
    await tasksDownloadAttachment(props.taskId, player.attachmentId, player.fileName)
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Download failed'
  } finally {
    player.downloading = false
  }
}

// ── Audio player ──────────────────────────────────────────────────────────

// Toggle the inline audio panel for a given attachment.
// If another track is already playing, stop it first.
async function toggleAudio(att: TaskAttachment) {
  // Clicking the same row's button while open → close.
  if (audioPlayer.open && audioPlayer.attachmentId === att.id) {
    closeAudio()
    return
  }

  // Stop any currently playing track.
  if (audioPlayer.open) closeAudio()

  audioPlayer.open = true
  audioPlayer.attachmentId = att.id
  audioPlayer.fileName = att.file_name
  audioPlayer.mimeType = att.mime_type
  audioPlayer.loading = true
  audioPlayer.fetchError = ''
  audioPlayer.playing = false
  audioPlayer.currentTime = 0
  audioPlayer.duration = 0

  try {
    const url = await fetchBlob(att.id)
    if (!audioPlayer.open || audioPlayer.attachmentId !== att.id) {
      URL.revokeObjectURL(url)
      return
    }
    audioPlayer.src = url
    audioPlayer.loading = false

    // Build the audio element imperatively so we can attach event listeners
    // without relying on a template ref that may not yet exist.
    await nextTick()
    mountAudioElement()
  } catch (e) {
    if (audioPlayer.open && audioPlayer.attachmentId === att.id) {
      audioPlayer.loading = false
      audioPlayer.fetchError = e instanceof Error ? e.message : 'Failed to load audio'
    }
  }
}

function mountAudioElement() {
  // Dispose any previous element.
  disposeAudioElement()

  const el = new Audio(audioPlayer.src)
  el.preload = 'auto'
  el.volume = audioPlayer.volume
  el.muted = audioPlayer.muted

  el.addEventListener('loadedmetadata', () => {
    audioPlayer.duration = isFinite(el.duration) ? el.duration : 0
  })
  el.addEventListener('timeupdate', () => {
    if (!audioPlayer.scrubbing) audioPlayer.currentTime = el.currentTime
  })
  el.addEventListener('play', () => { audioPlayer.playing = true })
  el.addEventListener('pause', () => { audioPlayer.playing = false })
  el.addEventListener('ended', () => {
    audioPlayer.playing = false
    audioPlayer.currentTime = 0
  })
  el.addEventListener('volumechange', () => {
    audioPlayer.volume = el.volume
    audioPlayer.muted = el.muted
  })

  audioEl.value = el
  el.play().catch(() => { /* browser autoplay block — user can press play */ })
}

function disposeAudioElement() {
  if (audioEl.value) {
    audioEl.value.pause()
    audioEl.value.src = ''
    audioEl.value.load()
    audioEl.value = null
  }
}

function closeAudio() {
  disposeAudioElement()
  if (audioPlayer.src) { URL.revokeObjectURL(audioPlayer.src); audioPlayer.src = '' }
  audioPlayer.open = false
  audioPlayer.playing = false
  audioPlayer.currentTime = 0
  audioPlayer.duration = 0
  audioPlayer.fetchError = ''
  audioPlayer.loading = false
}

function togglePlayPause() {
  if (!audioEl.value) return
  if (audioEl.value.paused) {
    audioEl.value.play().catch(() => {})
  } else {
    audioEl.value.pause()
  }
}

function toggleMute() {
  if (!audioEl.value) return
  audioEl.value.muted = !audioEl.value.muted
}

function onScrubStart() {
  audioPlayer.scrubbing = true
}

function onScrubEnd() {
  audioPlayer.scrubbing = false
}

function onScrub(e: Event) {
  const val = parseFloat((e.target as HTMLInputElement).value)
  audioPlayer.currentTime = val
  if (audioEl.value) audioEl.value.currentTime = val
}

function onVolumeChange(e: Event) {
  const val = parseFloat((e.target as HTMLInputElement).value)
  if (audioEl.value) {
    audioEl.value.volume = val
    audioEl.value.muted = val === 0
  }
  audioPlayer.volume = val
  audioPlayer.muted = val === 0
}

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

// ── Upload ────────────────────────────────────────────────────────────────

async function handleFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (!files.length) return
  await uploadFiles(files)
}

async function uploadFiles(files: File[]) {
  if (!files.length || uploading.value) return
  dragDepth = 0
  isDragOver.value = false
  uploading.value = true
  uploadErrors.value = []
  uploadProgress.value = { done: 0, total: files.length }
  try {
    const result = await tasksUploadAttachments(props.taskId, files)
    attachments.value = [...attachments.value, ...result.attachments]
    uploadErrors.value = result.errors.map(error => ({
      name: error.file_name || '(unknown)',
      message: error.message || 'Upload failed',
    }))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Upload failed'
    uploadErrors.value = files.map(file => ({ name: file.name, message }))
  } finally {
    uploadProgress.value.done = files.length
    uploading.value = false
  }
}

function isFileDragEvent(event: DragEvent): boolean {
  return event.dataTransfer?.types?.includes('Files') ?? false
}

function onDragEnter(event: DragEvent) {
  if (!isFileDragEvent(event) || uploading.value) return
  dragDepth += 1
  isDragOver.value = true
}

function onDragOver(event: DragEvent) {
  if (!isFileDragEvent(event) || uploading.value) return
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'copy'
  }
  isDragOver.value = true
}

function onDragLeave(_event: DragEvent) {
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) {
    isDragOver.value = false
  }
}

async function onDrop(event: DragEvent) {
  if (!isFileDragEvent(event)) return
  dragDepth = 0
  isDragOver.value = false
  const files = Array.from(event.dataTransfer?.files ?? [])
  if (!files.length) return
  await uploadFiles(files)
}

// ── Download / delete ─────────────────────────────────────────────────────

async function download(att: TaskAttachment) {
  downloading.value.add(att.id)
  try {
    await tasksDownloadAttachment(props.taskId, att.id, att.file_name)
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Download failed'
  } finally {
    downloading.value.delete(att.id)
  }
}

async function deleteAttachment(id: string) {
  deleting.value.add(id)
  error.value = ''
  try {
    await tasksDeleteAttachment(props.taskId, id)
    attachments.value = attachments.value.filter(a => a.id !== id)
    if (thumbs.value[id]) {
      URL.revokeObjectURL(thumbs.value[id])
      const next = { ...thumbs.value }; delete next[id]; thumbs.value = next
    }
    if (lightbox.open && lightbox.attachmentId === id) closeLightbox()
    if (player.open && player.attachmentId === id) closePlayer()
    if (audioPlayer.open && audioPlayer.attachmentId === id) closeAudio()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Delete failed'
  } finally {
    deleting.value.delete(id)
  }
}

// ── Keyboard ──────────────────────────────────────────────────────────────

function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  if (lightbox.open) { closeLightbox(); return }
  if (player.open) { closePlayer(); return }
  if (audioPlayer.open) closeAudio()
}

// ── Type predicates ───────────────────────────────────────────────────────

function isImage(mimeType: string): boolean { return mimeType.startsWith('image/') }
function isVideo(mimeType: string): boolean { return mimeType.startsWith('video/') }
function isAudio(mimeType: string): boolean { return mimeType.startsWith('audio/') }

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ── Lifecycle ─────────────────────────────────────────────────────────────

onMounted(() => {
  load()
  window.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  Object.values(thumbs.value).forEach(url => {
    if (url) URL.revokeObjectURL(url)
  })
  if (player.src) URL.revokeObjectURL(player.src)
  disposeAudioElement()
  if (audioPlayer.src) URL.revokeObjectURL(audioPlayer.src)
})

async function load() {
  loading.value = true; error.value = ''
  try {
    attachments.value = await tasksListAttachments(props.taskId)
    loadThumbs(attachments.value)
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load attachments'
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
/* Range input cross-browser styling */
.audio-scrubber::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: theme('colors.accent.DEFAULT');
  cursor: pointer;
}
.audio-scrubber::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border: none;
  border-radius: 50%;
  background: theme('colors.accent.DEFAULT');
  cursor: pointer;
}

/* Animated equaliser bars */
@keyframes audio-bar {
  0%, 100% { transform: scaleY(0.4); }
  50%       { transform: scaleY(1); }
}
.animate-audio-bar {
  animation: audio-bar 0.8s ease-in-out infinite;
  transform-origin: bottom;
}
</style>
