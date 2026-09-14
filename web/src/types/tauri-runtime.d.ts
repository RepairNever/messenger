export {}

declare global {
  interface Window {
    __TAURI__?: unknown
    __TAURI_INTERNALS__?: unknown
  }
}
