/**
 * RNNoise AudioWorkletProcessor
 *
 * Buffers microphone samples into 480-sample frames (10 ms at 48 kHz),
 * passes them through RNNoise WASM for noise suppression, and outputs
 * the cleaned audio.
 *
 * RNNoise expects samples in the range [-32768, 32767] (Int16 scale).
 * Web Audio API uses [-1.0, 1.0] float, so we scale on the way in/out.
 *
 * Loading strategy:
 *   - `rnnoise-classic.js` is a plain IIFE (no ES module syntax) generated
 *     by scripts/copy-rnnoise.cjs at postinstall time.
 *   - importScripts() is only available in classic Workers and classic
 *     AudioWorklet contexts.  AudioWorklet addModule() runs as an ES module
 *     by default, so importScripts() is NOT available.
 *   - We therefore load this processor itself as a classic script workaround:
 *     the main thread registers the worklet using a Blob URL that wraps both
 *     the rnnoise IIFE and this processor class in one classic script.
 *     (See the registerRNNoiseWorklet() helper in the app code.)
 *
 * This file is NOT loaded directly by audioWorklet.addModule().
 * It is fetched as text and combined with rnnoise-classic.js into a Blob
 * by the applyRnnoise() / registerRNNoiseWorklet() helpers.
 */

const FRAME_SIZE = 480 // RNNoise processes exactly 480 samples per call
const SCALE      = 32767 // Int16 max — RNNoise internal scale

class RNNoiseProcessor extends AudioWorkletProcessor {
  constructor () {
    // Declare explicit mono I/O so the worklet always processes exactly one
    // channel and never writes a silent second channel into the output buffer.
    // Without this, the default channelCountMode:"max" / channelCount:2 causes
    // process() to receive a 2-ch input but only write outputs[0][0], leaving
    // outputs[0][1] as zeros — remote participants hear audio on one side only.
    //
    // The downstream MediaStreamAudioDestinationNode (2 ch by default) receives
    // the 1-ch output and the Web Audio spec §4.4 mono→stereo upmix rule
    // populates both L and R with the same signal: L = M, R = M.
    super({
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    })

    this._initialized = false

    // Ring buffers: accumulate input, drain output
    this._inputBuf    = new Float32Array(FRAME_SIZE * 2)
    this._inputWrite  = 0
    this._inputRead   = 0
    this._inputCount  = 0

    this._outputBuf   = new Float32Array(FRAME_SIZE * 2)
    this._outputWrite = 0
    this._outputRead  = 0
    this._outputCount = 0

    // _readyPromise resolves when the WASM module is fully initialised.
    // process() passes audio through unprocessed until it resolves.
    this._readyPromise = this._initRNNoise()
  }

  async _initRNNoise () {
    try {
      // createRNNWasmModuleSync is injected by the Blob bundle that combines
      // rnnoise-classic.js (the stripped IIFE) with this processor.
      /* global createRNNWasmModuleSync */
      const mod = createRNNWasmModuleSync()

      // Wait for the WASM binary to be decoded and instantiated.
      // rnnoise-sync uses WebAssembly.instantiateSync internally, but it still
      // calls run() via setTimeout in some builds — await Module.ready to be safe.
      await mod.ready

      this._mod   = mod
      this._state = mod._rnnoise_create()

      // Allocate two FRAME_SIZE Float32 buffers on the WASM heap (4 bytes each)
      this._inPtr  = mod._malloc(FRAME_SIZE * 4)
      this._outPtr = mod._malloc(FRAME_SIZE * 4)

      this._initialized = true
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[RNNoiseProcessor] init failed:', e)
    }
  }

  _writeInput (samples) {
    const buf = this._inputBuf
    const len = buf.length
    for (let i = 0; i < samples.length; i++) {
      buf[this._inputWrite] = samples[i]
      this._inputWrite = (this._inputWrite + 1) % len
      this._inputCount++
    }
  }

  _processFrame () {
    const mod    = this._mod
    const heap32 = new Float32Array(mod.HEAPF32.buffer, this._inPtr, FRAME_SIZE)
    const buf    = this._inputBuf
    const len    = buf.length

    // Copy input ring → WASM heap, scale ±1 → ±32767
    for (let i = 0; i < FRAME_SIZE; i++) {
      heap32[i] = buf[this._inputRead] * SCALE
      this._inputRead = (this._inputRead + 1) % len
      this._inputCount--
    }

    mod._rnnoise_process_frame(this._state, this._outPtr, this._inPtr)

    // Copy WASM heap → output ring, scale back ±32767 → ±1
    const heapOut = new Float32Array(mod.HEAPF32.buffer, this._outPtr, FRAME_SIZE)
    const obuf    = this._outputBuf
    const olen    = obuf.length
    for (let i = 0; i < FRAME_SIZE; i++) {
      obuf[this._outputWrite] = heapOut[i] / SCALE
      this._outputWrite = (this._outputWrite + 1) % olen
      this._outputCount++
    }
  }

  _readOutput (dest) {
    const count = Math.min(dest.length, this._outputCount)
    const obuf  = this._outputBuf
    const olen  = obuf.length
    for (let i = 0; i < count; i++) {
      dest[i] = obuf[this._outputRead]
      this._outputRead = (this._outputRead + 1) % olen
      this._outputCount--
    }
    // Zero-fill if the output ring isn't full yet (startup latency)
    for (let i = count; i < dest.length; i++) {
      dest[i] = 0
    }
  }

  process (inputs, outputs) {
    const input     = inputs[0]
    const output    = outputs[0]
    const inChannel  = input  && input[0]
    const outChannel = output && output[0]

    if (!inChannel || !outChannel) return true

    if (!this._initialized) {
      // Pass through while WASM is still initialising (first few frames only)
      outChannel.set(inChannel)
      return true
    }

    this._writeInput(inChannel)

    while (this._inputCount >= FRAME_SIZE) {
      this._processFrame()
    }

    this._readOutput(outChannel)

    return true
  }
}

registerProcessor('rnnoise-processor', RNNoiseProcessor)
