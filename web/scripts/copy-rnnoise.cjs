/**
 * Postinstall script: copies rnnoise WASM glue files to public/.
 *
 * rnnoise-sync.js from @jitsi/rnnoise-wasm is an ES module (uses
 * import.meta.url + export default).  AudioWorklet addModule() runs in an ES
 * module context. The AudioWorkletGlobalScope extends WorkletGlobalScope (NOT
 * WorkerGlobalScope), so `self`, `window`, `document`, and `importScripts`
 * are all undefined there.
 *
 * This script generates rnnoise-classic.js:
 *   - Strips `export default createRNNWasmModuleSync;`
 *   - Replaces `import.meta.url` with '' (empty string)
 *     _scriptDir is only used to set scriptDirectory for locateFile().
 *     Since the WASM binary is a base64 data URI, locateFile() is never
 *     called — an empty string is safe (the `if (_scriptDir)` guard skips it).
 *   - Replaces `self.location.href` with '' for the same reason.
 *     This appears in the ENVIRONMENT_IS_WORKER branch which won't execute in
 *     AudioWorklet ES module scope (importScripts is undefined there), but we
 *     patch it defensively so the file never throws ReferenceError.
 *
 * The result is a plain IIFE safe to embed in an AudioWorklet Blob bundle.
 */

'use strict'
const fs = require('fs')
const path = require('path')

const SRC          = path.resolve(__dirname, '../node_modules/@jitsi/rnnoise-wasm/dist/rnnoise-sync.js')
const DEST_SYNC    = path.resolve(__dirname, '../public/rnnoise-sync.js')
const DEST_CLASSIC = path.resolve(__dirname, '../public/rnnoise-classic.js')

fs.mkdirSync(path.resolve(__dirname, '../public'), { recursive: true })

// 1. Plain copy (kept for reference / alternative usage)
fs.copyFileSync(SRC, DEST_SYNC)

// 2. AudioWorklet-safe version
let content = fs.readFileSync(SRC, 'utf8')

// Strip trailing ES module export declaration
content = content.trimEnd()
const EXPORT_STMT = 'export default createRNNWasmModuleSync;'
if (content.endsWith(EXPORT_STMT)) {
  content = content.slice(0, -EXPORT_STMT.length).trimEnd()
}

// Replace import.meta.url → '' (not valid outside ES modules)
content = content.split('import.meta.url').join("''")

// Replace self.location.href → ''
// AudioWorkletGlobalScope (WorkletGlobalScope) has no `self`.
// _scriptDir / scriptDirectory is only used by locateFile() which is never
// called because wasmBinaryFile is a base64 data URI.
content = content.split('self.location.href').join("''")

fs.writeFileSync(DEST_CLASSIC, content, 'utf8')

console.log('[copy-rnnoise] rnnoise-sync.js and rnnoise-classic.js written to public/')
