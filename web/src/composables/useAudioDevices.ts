import { ref, watch, onUnmounted } from 'vue'
import { loadAudioPrefs, saveAudioPrefs } from '@/services/storage/audioPrefsStorage'

export type PermissionState = 'unknown' | 'granted' | 'denied' | 'prompt'

export function useAudioDevices() {
  const inputDevices = ref<MediaDeviceInfo[]>([])
  const outputDevices = ref<MediaDeviceInfo[]>([])
  const permissionState = ref<PermissionState>('unknown')
  const selectedInputId = ref<string>('')
  const selectedOutputId = ref<string>('')
  const inputStatus = ref<string>('')
  const outputStatus = ref<string>('')
  const outputSupported = ref<boolean>(false)
  const inputLevel = ref<number>(0)
  const isTesting = ref<boolean>(false)
  const isTestingOutput = ref<boolean>(false)
  const testError = ref<string>('')
  const noiseSuppression = ref<boolean>(true)
  const echoCancellation = ref<boolean>(true)
  const autoGainControl = ref<boolean>(true)
  const microphoneGain = ref<number>(100) // 0–200, 100 = unity
  const rnnoiseEnabled = ref<boolean>(true) // software noise suppression via RNNoise WASM
  const muteMicOnJoinCall = ref<boolean>(false)

  // Internal refs for active streams / audio context
  let micStream: MediaStream | null = null
  let micAudioCtx: AudioContext | null = null
  let micGainNode: GainNode | null = null
  let micAnalyser: AnalyserNode | null = null
  let micLevelTimer: number | null = null
  let micWorkletNode: AudioWorkletNode | null = null
  let outputAudioCtx: AudioContext | null = null
  let outputTimer: number | null = null
  let deviceChangeListener: (() => void) | null = null

  // ── Helpers ──────────────────────────────────────────────────────────────

  function getMediaDevices(): MediaDevices | null {
    return typeof navigator !== 'undefined' && navigator.mediaDevices ? navigator.mediaDevices : null
  }

  function checkOutputSupport(): boolean {
    // setSinkId is available on HTMLAudioElement in Chrome/Edge but not Firefox/Safari
    return typeof HTMLAudioElement !== 'undefined' && 'setSinkId' in HTMLAudioElement.prototype
  }

  function labelForDevice(d: MediaDeviceInfo): string {
    return d.label || `${d.kind === 'audioinput' ? 'Microphone' : 'Speaker'} (${d.deviceId.slice(0, 8)})`
  }

  function deviceListContains(list: MediaDeviceInfo[], id: string): boolean {
    if (!id) return true // '' (system default) always valid
    return list.some(d => d.deviceId === id)
  }

  function buildInputStatus(deviceId: string, perm: PermissionState): string {
    if (perm === 'denied') return 'Microphone access denied. Allow access in your browser settings.'
    if (perm === 'prompt') return 'Microphone permission required.'
    if (perm === 'granted') {
      if (deviceId && !deviceListContains(inputDevices.value, deviceId)) {
        return 'Selected device disconnected. Using system default.'
      }
      if (inputDevices.value.length === 0) return 'No input devices found.'
      return 'Microphone access granted.'
    }
    return 'Checking microphone access…'
  }

  function buildOutputStatus(deviceId: string): string {
    if (!outputSupported.value) return 'Output device switching is not supported on this platform.'
    if (deviceId && !deviceListContains(outputDevices.value, deviceId)) {
      return 'Selected device disconnected. Using system default.'
    }
    if (outputDevices.value.length === 0) return 'No output devices found.'
    return 'Connected.'
  }

  function refreshStatuses() {
    inputStatus.value = buildInputStatus(selectedInputId.value, permissionState.value)
    outputStatus.value = buildOutputStatus(selectedOutputId.value)
  }

  // ── Permission check (non-prompting) ─────────────────────────────────────

  async function checkPermissionState(): Promise<void> {
    try {
      if (typeof navigator === 'undefined' || !navigator.permissions) return
      const result = await navigator.permissions.query({ name: 'microphone' as PermissionName })
      permissionState.value = result.state as PermissionState
      result.addEventListener('change', () => {
        permissionState.value = result.state as PermissionState
        refreshStatuses()
        // If permission just became granted, re-enumerate to get labels
        if (result.state === 'granted') loadDevices()
      })
    } catch {
      // permissions API not available — leave as 'unknown'
    }
  }

  // ── Device enumeration ───────────────────────────────────────────────────

  async function enumerateDevices(): Promise<void> {
    const md = getMediaDevices()
    if (!md) {
      inputStatus.value = 'Media devices not available in this environment.'
      return
    }
    try {
      const all = await md.enumerateDevices()
      inputDevices.value = all.filter(d => d.kind === 'audioinput')
      outputDevices.value = all.filter(d => d.kind === 'audiooutput')

      // Validate saved selection against current device list
      if (selectedInputId.value && !deviceListContains(inputDevices.value, selectedInputId.value)) {
        selectedInputId.value = ''
      }
      if (selectedOutputId.value && !deviceListContains(outputDevices.value, selectedOutputId.value)) {
        selectedOutputId.value = ''
      }
      refreshStatuses()
    } catch (err) {
      inputStatus.value = 'Failed to enumerate devices.'
    }
  }

  async function loadDevices(): Promise<void> {
    outputSupported.value = checkOutputSupport()
    await checkPermissionState()
    await enumerateDevices()

    // Load saved prefs
    const prefs = loadAudioPrefs()
    selectedInputId.value = prefs.inputDeviceId
    selectedOutputId.value = prefs.outputDeviceId
    noiseSuppression.value = prefs.noiseSuppression
    echoCancellation.value = prefs.echoCancellation
    autoGainControl.value = prefs.autoGainControl
    microphoneGain.value = prefs.microphoneGain
    rnnoiseEnabled.value = prefs.rnnoiseEnabled
    muteMicOnJoinCall.value = prefs.muteMicOnJoinCall
    refreshStatuses()

    // Listen for device hotplug events
    const md = getMediaDevices()
    if (md && !deviceChangeListener) {
      deviceChangeListener = () => enumerateDevices()
      md.addEventListener('devicechange', deviceChangeListener)
    }
  }

  async function requestPermission(): Promise<void> {
    const md = getMediaDevices()
    if (!md) return
    try {
      const stream = await md.getUserMedia({ audio: true })
      stream.getTracks().forEach(t => t.stop())
      permissionState.value = 'granted'
      await enumerateDevices()
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'NotAllowedError') {
        permissionState.value = 'denied'
      }
      refreshStatuses()
    }
  }

  // ── Mic test (level meter) ───────────────────────────────────────────────

  async function testMicrophone(): Promise<void> {
    testError.value = ''
    const md = getMediaDevices()
    if (!md) {
      testError.value = 'Media devices not available.'
      return
    }

    // Request permission implicitly if still unknown/prompt.
    // We read the state via a cast after the async call because TypeScript's
    // control flow analysis doesn't re-check reactive refs after an await.
    if (permissionState.value !== 'granted') {
      await requestPermission()
    }
    if ((permissionState.value as PermissionState) !== 'granted') {
      testError.value = (permissionState.value as PermissionState) === 'denied'
        ? 'Microphone access denied.'
        : 'Microphone permission required.'
      return
    }

    try {
      // When RNNoise is enabled it handles noise suppression, so disable the
      // browser's native noise suppression to avoid double-processing.
      const useRnnoise = rnnoiseEnabled.value
      const audioConstraints: MediaTrackConstraints = {
        noiseSuppression: useRnnoise ? false : noiseSuppression.value,
        echoCancellation: echoCancellation.value,
        autoGainControl: autoGainControl.value,
        // Explicitly request mono capture — all voice processing runs on a
        // single channel and Bluetooth HFP/HSP mics deliver mono regardless.
        channelCount: 1,
      }
      if (selectedInputId.value) {
        audioConstraints.deviceId = { exact: selectedInputId.value }
      }
      micStream = await md.getUserMedia({ audio: audioConstraints })
      isTesting.value = true

      micAudioCtx = new AudioContext()
      const source = micAudioCtx.createMediaStreamSource(micStream)

      // Mono node options: lock every processing node to 1 channel so the
      // pipeline never silently up-mixes mid-chain.
      const monoNodeOptions: AudioNodeOptions = {
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
      }
      micGainNode = new GainNode(micAudioCtx, monoNodeOptions)
      micGainNode.gain.value = microphoneGain.value / 100
      micAnalyser = micAudioCtx.createAnalyser()
      micAnalyser.fftSize = 256

      if (useRnnoise) {
        try {
          // audioWorklet.addModule() runs in an ES module context; importScripts
          // is not available there.  We combine rnnoise-classic.js (a plain IIFE,
          // no ES module syntax) and the processor into a single Blob so that
          // createRNNWasmModuleSync is in scope for RNNoiseProcessor.
          const [rnnoiseJs, processorJs] = await Promise.all([
            fetch('/rnnoise-classic.js').then(r => r.text()),
            fetch('/rnnoise-processor.js').then(r => r.text()),
          ])
          const blob = new Blob([rnnoiseJs + '\n' + processorJs], { type: 'application/javascript' })
          const blobUrl = URL.createObjectURL(blob)
          try {
            await micAudioCtx.audioWorklet.addModule(blobUrl)
          } finally {
            URL.revokeObjectURL(blobUrl)
          }
          micWorkletNode = new AudioWorkletNode(micAudioCtx, 'rnnoise-processor', {
            ...monoNodeOptions,
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
          })
          source.connect(micGainNode)
          micGainNode.connect(micWorkletNode)
          micWorkletNode.connect(micAnalyser)
        } catch (workletErr) {
          // If worklet fails to load, fall back to direct connection
          console.error('[useAudioDevices] RNNoise worklet failed, falling back:', workletErr)
          micWorkletNode = null
          source.connect(micGainNode)
          micGainNode.connect(micAnalyser)
        }
      } else {
        source.connect(micGainNode)
        micGainNode.connect(micAnalyser)
      }

      const bufferLength = micAnalyser.frequencyBinCount
      const dataArray = new Uint8Array(bufferLength)

      function readLevel() {
        if (!micAnalyser || !isTesting.value) return
        micAnalyser.getByteFrequencyData(dataArray)
        const avg = dataArray.reduce((s, v) => s + v, 0) / bufferLength
        inputLevel.value = Math.round((avg / 255) * 100)
        micLevelTimer = window.requestAnimationFrame(readLevel)
      }
      readLevel()

      // Handle device disconnect mid-test
      micStream.getTracks().forEach(track => {
        track.addEventListener('ended', () => {
          if (isTesting.value) {
            testError.value = 'Microphone disconnected during test.'
            stopMicTest()
          }
        })
      })
    } catch (err: unknown) {
      isTesting.value = false
      if (err instanceof Error) {
        if (err.name === 'NotAllowedError') {
          permissionState.value = 'denied'
          testError.value = 'Microphone access denied.'
        } else if (err.name === 'NotFoundError') {
          testError.value = 'Selected microphone not found.'
        } else if (err.name === 'NotReadableError') {
          testError.value = 'Microphone is in use by another application.'
        } else {
          testError.value = `Could not start microphone: ${err.message}`
        }
      } else {
        testError.value = 'Could not start microphone.'
      }
      refreshStatuses()
    }
  }

  function stopMicTest(): void {
    if (micLevelTimer !== null) {
      cancelAnimationFrame(micLevelTimer)
      micLevelTimer = null
    }
    if (micStream) {
      micStream.getTracks().forEach(t => t.stop())
      micStream = null
    }
    if (micWorkletNode) {
      micWorkletNode.disconnect()
      micWorkletNode = null
    }
    if (micAudioCtx) {
      micAudioCtx.close().catch(() => {})
      micAudioCtx = null
      micGainNode = null
      micAnalyser = null
    }
    isTesting.value = false
    inputLevel.value = 0
  }

  // ── Output test (synthesised tone) ───────────────────────────────────────

  async function testOutput(): Promise<void> {
    if (isTestingOutput.value) return
    isTestingOutput.value = true
    testError.value = ''

    try {
      outputAudioCtx = new AudioContext()

      // Route to selected output device if supported
      if (outputSupported.value && selectedOutputId.value) {
        try {
          await (outputAudioCtx as unknown as { setSinkId(id: string): Promise<void> }).setSinkId(selectedOutputId.value)
        } catch {
          // setSinkId on AudioContext may not be supported everywhere; fall back silently
        }
      }

      const oscillator = outputAudioCtx.createOscillator()
      const gainNode = outputAudioCtx.createGain()

      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(440, outputAudioCtx.currentTime)

      // Fade in then out to avoid clicks
      gainNode.gain.setValueAtTime(0, outputAudioCtx.currentTime)
      gainNode.gain.linearRampToValueAtTime(0.4, outputAudioCtx.currentTime + 0.05)
      gainNode.gain.linearRampToValueAtTime(0.4, outputAudioCtx.currentTime + 0.6)
      gainNode.gain.linearRampToValueAtTime(0, outputAudioCtx.currentTime + 0.8)

      oscillator.connect(gainNode)
      gainNode.connect(outputAudioCtx.destination)

      oscillator.start()
      oscillator.stop(outputAudioCtx.currentTime + 0.85)

      // For browsers where AudioContext itself doesn't support setSinkId, we also
      // attach the playback to a hidden <audio> element routed to the right sink
      if (outputSupported.value && selectedOutputId.value) {
        try {
          const dest = outputAudioCtx.createMediaStreamDestination()
          gainNode.connect(dest)
          const audioEl = document.createElement('audio')
          audioEl.srcObject = dest.stream
          await (audioEl as unknown as { setSinkId(id: string): Promise<void> }).setSinkId(selectedOutputId.value)
          audioEl.play().catch(() => {})
          outputTimer = window.setTimeout(() => {
            audioEl.pause()
            audioEl.srcObject = null
          }, 1200)
        } catch {
          // Best effort
        }
      }

      outputTimer = window.setTimeout(() => {
        stopOutputTest()
      }, 1000)
    } catch (err: unknown) {
      isTestingOutput.value = false
      testError.value = err instanceof Error ? `Output test failed: ${err.message}` : 'Output test failed.'
    }
  }

  function stopOutputTest(): void {
    if (outputTimer !== null) {
      clearTimeout(outputTimer)
      outputTimer = null
    }
    if (outputAudioCtx) {
      outputAudioCtx.close().catch(() => {})
      outputAudioCtx = null
    }
    isTestingOutput.value = false
  }

  // ── Persist ──────────────────────────────────────────────────────────────

  function savePrefs(
    inputId: string,
    outputId: string,
    ns: boolean,
    ec: boolean,
    agc: boolean,
    gain: number,
    rnnoise: boolean,
    muteOnJoin: boolean,
  ): void {
    saveAudioPrefs({
      inputDeviceId: inputId,
      outputDeviceId: outputId,
      noiseSuppression: ns,
      echoCancellation: ec,
      autoGainControl: agc,
      microphoneGain: gain,
      rnnoiseEnabled: rnnoise,
      muteMicOnJoinCall: muteOnJoin,
    })
    selectedInputId.value = inputId
    selectedOutputId.value = outputId
    noiseSuppression.value = ns
    echoCancellation.value = ec
    autoGainControl.value = agc
    microphoneGain.value = gain
    rnnoiseEnabled.value = rnnoise
    muteMicOnJoinCall.value = muteOnJoin
    refreshStatuses()
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────

  function dispose(): void {
    stopMicTest()
    stopOutputTest()
    const md = getMediaDevices()
    if (md && deviceChangeListener) {
      md.removeEventListener('devicechange', deviceChangeListener)
      deviceChangeListener = null
    }
  }

  onUnmounted(dispose)

  // Keep the live gain node in sync while the test is running
  watch(microphoneGain, (val) => {
    if (micGainNode) {
      micGainNode.gain.setTargetAtTime(val / 100, micGainNode.context.currentTime, 0.01)
    }
  })

  return {
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
    dispose,
  }
}
