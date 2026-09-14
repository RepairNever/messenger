<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-dialog-title"
      @click.self="handleClose"
      @keydown.esc="handleClose"
    >
      <div
        ref="panelRef"
        class="w-full max-w-lg rounded-xl border border-chat-border bg-[#1a1d21] shadow-2xl flex flex-col max-h-[90vh]"
        tabindex="-1"
      >
        <!-- ── Header ──────────────────────────────────────────────── -->
        <div class="flex items-center justify-between px-6 py-4 border-b border-chat-border shrink-0">
          <h2 id="settings-dialog-title" class="text-base font-semibold text-white">Settings</h2>
          <button
            class="text-gray-400 hover:text-white transition-colors rounded p-1 focus:outline-none focus:ring-2 focus:ring-accent"
            aria-label="Close settings"
            @click="handleClose"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <!-- ── Body ───────────────────────────────────────────────── -->
        <div class="overflow-y-auto flex-1 px-6 py-5 space-y-6">
          <section aria-labelledby="audio-section-heading">
            <h3 id="audio-section-heading" class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">Audio</h3>

            <!-- Permission denied -->
            <div
              v-if="permissionState === 'denied'"
              role="alert"
              class="mb-5 flex items-start gap-3 rounded-lg bg-red-500/10 border border-red-500/30 px-4 py-3 text-sm"
            >
              <svg class="w-4 h-4 mt-0.5 shrink-0 text-red-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/>
              </svg>
              <div class="text-red-300">
                <p class="font-medium">Microphone access denied.</p>
                <p class="mt-0.5 text-red-400/80 text-xs">Allow microphone access in your browser or OS settings, then reopen this dialog.</p>
              </div>
            </div>

            <!-- Permission prompt -->
            <div
              v-else-if="permissionState === 'prompt' || permissionState === 'unknown'"
              class="mb-5 flex items-center gap-3 rounded-lg bg-amber-500/10 border border-amber-500/30 px-4 py-3 text-sm text-amber-200"
            >
              <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/>
              </svg>
              <p class="flex-1 text-xs">Microphone permission is needed to list and test input devices.</p>
              <button
                class="shrink-0 rounded-md bg-amber-500/20 hover:bg-amber-500/40 px-3 py-1.5 text-xs font-medium text-amber-100 transition-colors focus:outline-none focus:ring-2 focus:ring-amber-400"
                @click="requestPermission"
              >Grant access</button>
            </div>

            <!-- ── Input Device row ───────────────────────────────── -->
            <div class="flex items-start gap-4 mb-6">
              <!-- Left label -->
              <div class="w-28 shrink-0 pt-2.5">
                <label for="input-device-select" class="text-sm font-medium text-white block leading-tight">
                  Input Device
                </label>
                <p class="text-[11px] text-gray-500 mt-1 leading-snug">
                  Choose which microphone the agent uses for voice input.
                </p>
              </div>

              <!-- Right controls -->
              <div class="flex-1 min-w-0 space-y-2.5">
                <!-- Select -->
                <div class="relative">
                  <select
                    id="input-device-select"
                    v-model="selectedInputId"
                    :disabled="permissionState === 'denied'"
                    class="w-full appearance-none bg-[#222529] border border-chat-border rounded-md px-3 py-2 pr-8 text-sm text-white focus:outline-none focus:border-accent disabled:opacity-40 disabled:cursor-not-allowed transition-colors hover:border-white/30"
                  >
                    <option value="">System Default Microphone</option>
                    <option v-for="d in inputDevices" :key="d.deviceId" :value="d.deviceId">
                      {{ d.label || `Microphone (${d.deviceId.slice(0, 8)}…)` }}
                    </option>
                  </select>
                  <svg class="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M6 9l6 6 6-6"/>
                  </svg>
                </div>

                <!-- Status -->
                <p
                  role="status"
                  aria-live="polite"
                  class="text-[11px] leading-snug"
                  :class="inputStatusClass"
                >{{ inputStatus }}</p>

                <!-- Test Microphone button -->
                <button
                  class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border transition-colors focus:outline-none focus:ring-2 focus:ring-accent"
                  :class="isTesting
                    ? 'bg-red-500/15 hover:bg-red-500/25 text-red-300 border-red-500/40'
                    : 'bg-white/8 hover:bg-white/15 text-gray-300 border-white/12'"
                  :disabled="permissionState === 'denied'"
                  :aria-pressed="isTesting"
                  @click="handleToggleMicTest"
                >
                  <!-- Mic icon -->
                  <svg v-if="!isTesting" class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v4M8 23h8"/>
                  </svg>
                  <!-- Stop icon -->
                  <svg v-else class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true">
                    <rect x="6" y="6" width="12" height="12" rx="1"/>
                  </svg>
                  {{ isTesting ? 'Stop test' : 'Test Microphone' }}
                </button>

                <!-- Level meter (only while testing) -->
                <div v-if="isTesting" aria-label="Microphone level" class="space-y-1 pt-0.5">
                  <div class="flex items-center gap-2">
                    <div
                      class="flex-1 h-2 rounded-full bg-white/10 overflow-hidden"
                      role="meter"
                      :aria-valuenow="inputLevel"
                      aria-valuemin="0"
                      aria-valuemax="100"
                      :aria-label="`Microphone input level ${inputLevel}%`"
                    >
                      <div
                        class="h-full rounded-full transition-all duration-75"
                        :class="inputLevelBarClass"
                        :style="{ width: `${inputLevel}%` }"
                      />
                    </div>
                    <span class="text-[11px] text-gray-400 w-8 text-right tabular-nums shrink-0">{{ inputLevel }}%</span>
                  </div>
                  <p class="text-[11px] text-gray-500">
                    {{ inputLevel === 0 ? 'No input detected.' : 'Speak to see your input level.' }}
                  </p>
                </div>

                <!-- Mic test error -->
                <p v-if="testError && !isTestingOutput" role="alert" class="text-[11px] text-red-400">{{ testError }}</p>
              </div>
            </div>

            <!-- ── Divider ─────────────────────────────────────────── -->
            <div class="border-t border-white/5 mb-6" aria-hidden="true"/>

            <!-- ── Output Device row ──────────────────────────────── -->
            <div class="flex items-start gap-4 mb-6">
              <!-- Left label -->
              <div class="w-28 shrink-0 pt-2.5">
                <label for="output-device-select" class="text-sm font-medium text-white block leading-tight">
                  Output Device
                </label>
                <p class="text-[11px] text-gray-500 mt-1 leading-snug">
                  Choose where audio responses are played.
                </p>
              </div>

              <!-- Right controls -->
              <div class="flex-1 min-w-0 space-y-2.5">
                <!-- Select -->
                <div class="relative">
                  <select
                    id="output-device-select"
                    v-model="selectedOutputId"
                    :disabled="!outputSupported"
                    class="w-full appearance-none bg-[#222529] border border-chat-border rounded-md px-3 py-2 pr-8 text-sm text-white focus:outline-none focus:border-accent disabled:opacity-40 disabled:cursor-not-allowed transition-colors hover:border-white/30"
                  >
                    <option value="">System Default</option>
                    <option v-for="d in outputDevices" :key="d.deviceId" :value="d.deviceId">
                      {{ d.label || `Speaker (${d.deviceId.slice(0, 8)}…)` }}
                    </option>
                  </select>
                  <svg class="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M6 9l6 6 6-6"/>
                  </svg>
                </div>

                <!-- Helper text for unsupported platforms -->
                <p v-if="!outputSupported" class="text-[11px] text-amber-400/80 leading-snug">
                  System default follows your operating system's current device.
                </p>

                <!-- Status -->
                <p
                  role="status"
                  aria-live="polite"
                  class="text-[11px] leading-snug"
                  :class="outputStatusClass"
                >{{ outputStatus }}</p>

                <!-- Play Test Sound button -->
                <button
                  class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border transition-colors focus:outline-none focus:ring-2 focus:ring-accent"
                  :class="isTestingOutput
                    ? 'bg-accent/15 text-accent border-accent/30'
                    : 'bg-white/8 hover:bg-white/15 text-gray-300 border-white/12'"
                  :disabled="isTestingOutput"
                  @click="handleTestOutput"
                >
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                    <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
                  </svg>
                  {{ isTestingOutput ? 'Playing…' : 'Play Test Sound' }}
                </button>

                <!-- Output test error -->
                <p v-if="testError && isTestingOutput" role="alert" class="text-[11px] text-red-400">{{ testError }}</p>
              </div>
            </div>

            <!-- ── Advanced audio settings ────────────────────────── -->
            <div class="border-t border-white/5 pt-4">
              <details class="group">
                <summary
                  class="flex items-center gap-2 cursor-pointer text-sm text-gray-400 hover:text-gray-200 transition-colors list-none rounded select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  tabindex="0"
                >
                  <svg
                    class="w-3.5 h-3.5 shrink-0 transition-transform duration-150 group-open:rotate-90"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.5"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path d="M9 18l6-6-6-6"/>
                  </svg>
                  Advanced audio settings
                </summary>

                <div class="mt-4 space-y-1">

                  <!-- Noise Suppression -->
                  <div class="flex items-center justify-between gap-4 px-1 py-2.5 rounded-lg hover:bg-white/4 transition-colors">
                    <div class="min-w-0">
                      <p class="text-sm text-white leading-tight">Noise Suppression</p>
                      <p class="text-[11px] text-gray-500 mt-0.5 leading-snug">Reduces background noise picked up by the microphone.</p>
                    </div>
                    <button
                      role="switch"
                      :aria-checked="noiseSuppression"
                      :aria-label="`Noise suppression ${noiseSuppression ? 'on' : 'off'}`"
                      class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-[#1a1d21]"
                      :class="noiseSuppression ? 'bg-accent' : 'bg-white/20'"
                      @click="noiseSuppression = !noiseSuppression"
                    >
                      <span
                        class="pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200"
                        :class="noiseSuppression ? 'translate-x-4' : 'translate-x-0'"
                        aria-hidden="true"
                      />
                    </button>
                  </div>

                  <!-- Echo Cancellation -->
                  <div class="flex items-center justify-between gap-4 px-1 py-2.5 rounded-lg hover:bg-white/4 transition-colors">
                    <div class="min-w-0">
                      <p class="text-sm text-white leading-tight">Echo Cancellation</p>
                      <p class="text-[11px] text-gray-500 mt-0.5 leading-snug">Prevents your speakers from being heard back through your microphone.</p>
                    </div>
                    <button
                      role="switch"
                      :aria-checked="echoCancellation"
                      :aria-label="`Echo cancellation ${echoCancellation ? 'on' : 'off'}`"
                      class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-[#1a1d21]"
                      :class="echoCancellation ? 'bg-accent' : 'bg-white/20'"
                      @click="echoCancellation = !echoCancellation"
                    >
                      <span
                        class="pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200"
                        :class="echoCancellation ? 'translate-x-4' : 'translate-x-0'"
                        aria-hidden="true"
                      />
                    </button>
                  </div>

                  <!-- Auto Gain Control -->
                  <div class="flex items-center justify-between gap-4 px-1 py-2.5 rounded-lg hover:bg-white/4 transition-colors">
                    <div class="min-w-0">
                      <p class="text-sm text-white leading-tight">Auto Gain Control</p>
                      <p class="text-[11px] text-gray-500 mt-0.5 leading-snug">Automatically adjusts microphone sensitivity to keep your volume consistent.</p>
                    </div>
                    <button
                      role="switch"
                      :aria-checked="autoGainControl"
                      :aria-label="`Auto gain control ${autoGainControl ? 'on' : 'off'}`"
                      class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-[#1a1d21]"
                      :class="autoGainControl ? 'bg-accent' : 'bg-white/20'"
                      @click="autoGainControl = !autoGainControl"
                    >
                      <span
                        class="pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200"
                        :class="autoGainControl ? 'translate-x-4' : 'translate-x-0'"
                        aria-hidden="true"
                      />
                    </button>
                  </div>

                  <!-- Software Noise Suppression (RNNoise) -->
                  <div class="flex items-center justify-between gap-4 px-1 py-2.5 rounded-lg hover:bg-white/4 transition-colors">
                    <div class="min-w-0">
                      <p class="text-sm text-white leading-tight">Software Noise Suppression (RNNoise)</p>
                      <p class="text-[11px] text-gray-500 mt-0.5 leading-snug">AI-based noise removal via WebAssembly. Overrides browser noise suppression when enabled.</p>
                    </div>
                    <button
                      role="switch"
                      :aria-checked="rnnoiseEnabled"
                      :aria-label="`Software noise suppression ${rnnoiseEnabled ? 'on' : 'off'}`"
                      class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-[#1a1d21]"
                      :class="rnnoiseEnabled ? 'bg-accent' : 'bg-white/20'"
                      @click="rnnoiseEnabled = !rnnoiseEnabled"
                    >
                      <span
                        class="pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200"
                        :class="rnnoiseEnabled ? 'translate-x-4' : 'translate-x-0'"
                        aria-hidden="true"
                      />
                    </button>
                  </div>

                  <!-- Mute Microphone On Join -->
                  <div class="flex items-center justify-between gap-4 px-1 py-2.5 rounded-lg hover:bg-white/4 transition-colors">
                    <div class="min-w-0">
                      <p class="text-sm text-white leading-tight">Mute microphone on join call</p>
                      <p class="text-[11px] text-gray-500 mt-0.5 leading-snug">Join calls with your microphone muted until you unmute it manually.</p>
                    </div>
                    <button
                      role="switch"
                      :aria-checked="muteMicOnJoinCall"
                      :aria-label="`Mute microphone on join call ${muteMicOnJoinCall ? 'on' : 'off'}`"
                      class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-[#1a1d21]"
                      :class="muteMicOnJoinCall ? 'bg-accent' : 'bg-white/20'"
                      @click="muteMicOnJoinCall = !muteMicOnJoinCall"
                    >
                      <span
                        class="pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200"
                        :class="muteMicOnJoinCall ? 'translate-x-4' : 'translate-x-0'"
                        aria-hidden="true"
                      />
                    </button>
                  </div>

                  <!-- Microphone Level (only when AGC is off) -->
                  <Transition
                    enter-active-class="transition-all duration-200 ease-out"
                    enter-from-class="opacity-0 -translate-y-1"
                    enter-to-class="opacity-100 translate-y-0"
                    leave-active-class="transition-all duration-150 ease-in"
                    leave-from-class="opacity-100 translate-y-0"
                    leave-to-class="opacity-0 -translate-y-1"
                  >
                    <div
                      v-if="!autoGainControl"
                      class="px-1 py-2.5"
                    >
                      <div class="flex items-start justify-between gap-4 mb-2">
                        <div class="min-w-0">
                          <label for="mic-gain-slider" class="text-sm text-white leading-tight block">Microphone Level</label>
                          <p class="text-[11px] text-gray-500 mt-0.5 leading-snug">Manually adjust your microphone volume.</p>
                        </div>
                        <span
                          class="text-sm tabular-nums font-medium w-10 text-right shrink-0 pt-0.5"
                          :class="(microphoneGain ?? 100) === 100 ? 'text-gray-400' : 'text-white'"
                          aria-hidden="true"
                        >{{ microphoneGain ?? 100 }}%</span>
                      </div>
                      <div class="relative flex items-center gap-3">
                        <span class="text-[10px] text-gray-600 shrink-0 w-5 text-right">0</span>
                        <div class="relative flex-1">
                          <!-- Track fill -->
                          <div class="absolute inset-y-0 my-auto h-1 rounded-full bg-white/10 w-full" aria-hidden="true"/>
                          <div
                            class="absolute inset-y-0 my-auto h-1 rounded-full bg-accent transition-all duration-75"
                            :style="{ width: `${((microphoneGain ?? 100) / 400) * 100}%` }"
                            aria-hidden="true"
                          />
                          <input
                            id="mic-gain-slider"
                            type="range"
                            min="0"
                            max="400"
                            step="5"
                            :value="microphoneGain ?? 100"
                            :aria-valuenow="microphoneGain ?? 100"
                            aria-valuemin="0"
                            aria-valuemax="400"
                            :aria-label="`Microphone level ${microphoneGain ?? 100}%`"
                            class="relative w-full h-4 appearance-none bg-transparent cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:shadow [&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-transparent [&::-moz-range-track]:h-1 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-transparent"
                            @input="microphoneGain = Number(($event.target as HTMLInputElement).value)"
                          />
                        </div>
                        <span class="text-[10px] text-gray-600 shrink-0 w-7">400</span>
                      </div>
                      <!-- Unity marker hint -->
                      <div class="flex pl-8 pr-7 mt-0.5">
                        <div class="relative flex-1">
                          <span class="absolute text-[10px] text-gray-600" style="left: 25%; transform: translateX(-50%)">100%</span>
                        </div>
                      </div>
                    </div>
                  </Transition>

                </div>
              </details>
            </div>

          </section>

          <!-- ── Notifications Section ───────────────────────────── -->
          <section aria-labelledby="notifications-section-heading">
            <h3 id="notifications-section-heading" class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">Notifications</h3>

            <div
              v-if="isDesktopRuntime"
              class="rounded-lg border border-chat-border bg-sidebar-bg/60 px-4 py-3 text-sm"
            >
              <p class="text-white text-sm font-medium">Desktop notifications</p>
              <p class="mt-1 text-xs text-gray-400">
                Msgnr uses native macOS notifications in desktop mode. Push subscription settings are web-only.
              </p>
              <div class="mt-3 flex items-center justify-between gap-3">
                <span class="text-xs text-gray-400">Permission: {{ desktopPermissionLabel }}</span>
                <button
                  type="button"
                  class="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover transition-colors"
                  @click="requestDesktopNotificationPermission"
                >
                  Request permission
                </button>
              </div>
            </div>

            <!-- Unsupported browser -->
            <div
              v-else-if="pushUnsupported"
              class="flex items-start gap-3 rounded-lg bg-gray-500/10 border border-gray-500/30 px-4 py-3 text-sm"
            >
              <svg class="w-4 h-4 mt-0.5 shrink-0 text-gray-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/>
              </svg>
              <p class="text-gray-400 text-xs">Push notifications are not supported in this browser.</p>
            </div>

            <!-- iOS not installed -->
            <IosInstallGuide v-else-if="pushNeedsIosInstall" />

            <!-- Notification permission denied -->
            <div
              v-else-if="pushPermission === 'denied'"
              class="flex items-start gap-3 rounded-lg bg-red-500/10 border border-red-500/30 px-4 py-3 text-sm"
            >
              <svg class="w-4 h-4 mt-0.5 shrink-0 text-red-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/>
              </svg>
              <div class="text-red-300 text-xs">
                <p class="font-medium">Notification permission denied.</p>
                <p class="mt-0.5 text-red-400/80">Reset notification permissions in your browser settings, then try again.</p>
              </div>
            </div>

            <!-- Push toggle -->
            <div v-else class="flex items-center justify-between gap-4">
              <div class="min-w-0">
                <p class="text-sm font-medium text-white leading-tight">Push notifications</p>
                <p class="text-[11px] text-gray-500 mt-0.5 leading-snug">
                  Receive notifications for new messages when Msgnr is closed.
                </p>
              </div>
              <button
                role="switch"
                :aria-checked="pushSubscribed"
                :aria-label="pushSubscribed ? 'Disable push notifications' : 'Enable push notifications'"
                :disabled="pushLoading"
                type="button"
                class="relative inline-flex items-center h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-[#1a1d21] disabled:cursor-not-allowed disabled:opacity-50"
                :class="pushSubscribed ? 'bg-accent' : 'bg-white/20'"
                @click="togglePush"
              >
                <span
                  class="pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200"
                  :class="pushSubscribed ? 'translate-x-4' : 'translate-x-0'"
                  aria-hidden="true"
                />
              </button>
            </div>

            <!-- Error -->
            <p v-if="!isDesktopRuntime && pushError" class="mt-2 text-xs text-red-400">{{ pushError }}</p>
          </section>
        </div>

        <!-- ── Footer ─────────────────────────────────────────────── -->
        <div class="flex items-center justify-between px-6 py-4 border-t border-chat-border shrink-0">
          <button
            class="px-4 py-2 rounded-md bg-white/10 hover:bg-white/20 text-gray-200 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-accent"
            @click="handleClose"
          >
            Cancel
          </button>
          <button
            class="px-4 py-2 rounded-md text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-40 disabled:cursor-not-allowed"
            :class="isDirty ? 'bg-accent hover:bg-accent-hover text-white' : 'bg-white/10 text-gray-400 cursor-not-allowed'"
            :disabled="!isDirty"
            @click="handleSave"
          >
            Save
          </button>
        </div>

      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { useAudioDevices } from '@/composables/useAudioDevices'
import { loadAudioPrefs } from '@/services/storage/audioPrefsStorage'
import { usePushNotifications } from '@/composables/usePushNotifications'
import IosInstallGuide from '@/components/IosInstallGuide.vue'
import { isTauriRuntime } from '@/platform/runtime'
import { getPlatformOrNull } from '@/platform'

// ── Props / emits ─────────────────────────────────────────────────────────

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

// ── Audio device composable ───────────────────────────────────────────────
// We use the composable's own selectedInputId / selectedOutputId as the live
// draft — they are writable reactive refs that testMicrophone() also reads,
// so selecting a device and immediately testing it works without extra sync.

const {
  inputDevices,
  outputDevices,
  permissionState,
  selectedInputId,
  selectedOutputId,
  inputStatus,
  outputStatus,
  outputSupported,
  inputLevel,
  isTesting,
  isTestingOutput,
  testError,
  noiseSuppression,
  echoCancellation,
  autoGainControl,
  microphoneGain,
  rnnoiseEnabled,
  muteMicOnJoinCall,
  loadDevices,
  requestPermission,
  testMicrophone,
  stopMicTest,
  testOutput,
  stopOutputTest,
  savePrefs,
} = useAudioDevices()

// ── Push notifications ────────────────────────────────────────────────────

const {
  permissionState: pushPermission,
  isSubscribed: pushSubscribed,
  isLoading: pushLoading,
  error: pushError,
  isUnsupported: pushUnsupported,
  needsIosInstall: pushNeedsIosInstall,
  subscribe: pushSubscribe,
  unsubscribe: pushUnsubscribe,
  checkExistingSubscription,
} = usePushNotifications()
const isDesktopRuntime = isTauriRuntime()
const desktopPermission = ref<'granted' | 'denied' | 'default'>('default')

const desktopPermissionLabel = computed(() => {
  if (desktopPermission.value === 'granted') return 'granted'
  if (desktopPermission.value === 'denied') return 'denied'
  return 'not requested'
})

async function togglePush() {
  if (pushSubscribed.value) {
    await pushUnsubscribe()
  } else {
    await pushSubscribe()
  }
}

async function requestDesktopNotificationPermission() {
  const platform = getPlatformOrNull()
  if (!platform) return
  desktopPermission.value = await platform.notifications.requestPermission()
}

// ── Saved-prefs snapshot (for dirty-checking) ─────────────────────────────

const savedPrefs = ref(loadAudioPrefs())

const isDirty = computed(() =>
  (selectedInputId.value ?? '') !== savedPrefs.value.inputDeviceId
  || (selectedOutputId.value ?? '') !== savedPrefs.value.outputDeviceId
  || (noiseSuppression.value ?? true) !== savedPrefs.value.noiseSuppression
  || (echoCancellation.value ?? true) !== savedPrefs.value.echoCancellation
  || (autoGainControl.value ?? false) !== savedPrefs.value.autoGainControl
  || (microphoneGain.value ?? 100) !== savedPrefs.value.microphoneGain
  || (rnnoiseEnabled.value ?? true) !== savedPrefs.value.rnnoiseEnabled
  || (muteMicOnJoinCall.value ?? false) !== savedPrefs.value.muteMicOnJoinCall
)

// ── Panel ref (focus trap) ────────────────────────────────────────────────

const panelRef = ref<HTMLElement | null>(null)

// ── Status colour helpers ─────────────────────────────────────────────────

const inputStatusClass = computed(() => {
  const s: string = inputStatus.value ?? ''
  if (s.includes('denied') || s.includes('disconnected') || s.includes('not found') || s.includes('Failed')) return 'text-red-400'
  if (s.includes('permission') || s.includes('required') || s.includes('Checking') || s.includes('No input')) return 'text-amber-400'
  if (s.includes('granted')) return 'text-emerald-400'
  return 'text-gray-500'
})

const outputStatusClass = computed(() => {
  const s: string = outputStatus.value ?? ''
  if (s.includes('not supported')) return 'text-amber-400'
  if (s.includes('disconnected') || s.includes('not found')) return 'text-red-400'
  if (s.includes('Connected')) return 'text-emerald-400'
  return 'text-gray-500'
})

const inputLevelBarClass = computed(() => {
  const level: number = inputLevel.value ?? 0
  if (level > 80) return 'bg-red-500'
  if (level > 50) return 'bg-amber-400'
  return 'bg-emerald-500'
})

// ── Open / close lifecycle ────────────────────────────────────────────────

watch(
  () => props.open,
  async (isOpen) => {
    if (isOpen) {
      // Snapshot persisted prefs before loading (for dirty-check baseline)
      savedPrefs.value = loadAudioPrefs()

      // loadDevices() enumerates, checks permission, and sets selectedInputId /
      // selectedOutputId from persisted prefs — so they start at the saved value.
      await loadDevices()

      // Sync push notification state with browser (web/PWA only).
      if (!isDesktopRuntime) {
        checkExistingSubscription()
      }

      // Clear any leftover error from a previous session
      testError.value = ''

      // Focus panel for keyboard trap / screen reader
      await nextTick()
      panelRef.value?.focus()
    } else {
      stopMicTest()
      stopOutputTest()
    }
  },
  { immediate: false }
)

// ── Handlers ─────────────────────────────────────────────────────────────

function handleClose() {
  stopMicTest()
  stopOutputTest()
  emit('close')
}

function handleSave() {
  const inputId: string = selectedInputId.value ?? ''
  const outputId: string = selectedOutputId.value ?? ''
  const ns: boolean = noiseSuppression.value ?? true
  const ec: boolean = echoCancellation.value ?? true
  const agc: boolean = autoGainControl.value ?? false
  const gain: number = microphoneGain.value ?? 100
  const rnnoise: boolean = rnnoiseEnabled.value ?? true
  const muteOnJoin: boolean = muteMicOnJoinCall.value ?? false
  savePrefs(inputId, outputId, ns, ec, agc, gain, rnnoise, muteOnJoin)
  savedPrefs.value = loadAudioPrefs()
  emit('close')
}

async function handleToggleMicTest() {
  if (isTesting.value) {
    stopMicTest()
  } else {
    testError.value = ''
    await testMicrophone()
  }
}

async function handleTestOutput() {
  testError.value = ''
  await testOutput()
}
</script>
