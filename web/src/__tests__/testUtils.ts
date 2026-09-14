export function ensureLocalStorageMock() {
  if (
    typeof globalThis.localStorage?.clear === 'function'
    && typeof globalThis.localStorage?.getItem === 'function'
    && typeof globalThis.localStorage?.setItem === 'function'
    && typeof globalThis.localStorage?.removeItem === 'function'
  ) {
    return
  }
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, String(value))
      },
      removeItem: (key: string) => {
        values.delete(key)
      },
      clear: () => {
        values.clear()
      },
    },
  })
}
