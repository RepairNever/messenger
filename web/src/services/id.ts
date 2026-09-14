const UUID_SEGMENTS = {
  template: 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx',
}

export function generateId(): string {
  const cryptoObj = globalThis.crypto
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID()
  }

  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    const bytes = new Uint8Array(16)
    cryptoObj.getRandomValues(bytes)
    return formatUuidFromBytes(bytes)
  }

  return fallbackUuidV4()
}

function formatUuidFromBytes(bytes: Uint8Array): string {
  return `${byteToHex(bytes[0])}${byteToHex(bytes[1])}${byteToHex(bytes[2])}${byteToHex(bytes[3])}-${
    byteToHex(bytes[4])}${byteToHex(bytes[5])}-${
    byteToHex((bytes[6] & 0x0f) | 0x40)}${byteToHex(bytes[7])}-${
    byteToHex((bytes[8] & 0x3f) | 0x80)}${byteToHex(bytes[9])}-${
    byteToHex(bytes[10])}${byteToHex(bytes[11])}${byteToHex(bytes[12])}${byteToHex(bytes[13])}${
    byteToHex(bytes[14])}${byteToHex(bytes[15])
  }`
}

function byteToHex(byte: number): string {
  return byte.toString(16).padStart(2, '0')
}

function fallbackUuidV4(): string {
  return UUID_SEGMENTS.template.replace(/[xy]/g, char => {
    const random = Math.floor(Math.random() * 16)
    const value = char === 'x'
      ? random
      : (random & 0x3) | 0x8
    return value.toString(16)
  })
}

