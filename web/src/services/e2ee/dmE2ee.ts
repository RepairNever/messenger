import {
  listEncryptedDMDevices,
  registerE2EEDevice,
  type E2EEDeviceRegistrationPayload,
  type E2EEDeviceItem,
  type EncryptedDMPayloadItem,
} from '@/services/http/chatApi'

export const ENCRYPTED_DM_ALGORITHM = 'dm-p256-aesgcm-v1'

interface LocalE2EEDevice {
  deviceId: string
  publicKeyJwk: JsonWebKey
  privateKeyJwk: JsonWebKey
}

export type E2EERecoveryErrorCode = 'invalid' | 'unsupported' | 'unavailable'

export class E2EERecoveryError extends Error {
  constructor(public readonly code: E2EERecoveryErrorCode) {
    super(code === 'unsupported'
      ? 'This recovery package is not supported.'
      : code === 'unavailable'
        ? 'No encrypted DM identity is available on this browser.'
        : 'Could not unlock this recovery package.')
    this.name = 'E2EERecoveryError'
  }
}

export interface PreparedEncryptedDMRecoveryImport {
  readonly deviceId: string
  readonly registration: E2EEDeviceRegistrationPayload
  install(): void
}

export interface EncryptedDMEnvelope {
  recipientDeviceId: string
  senderDeviceId: string
  algorithm: string
  sessionMessage: Uint8Array
  metadataAad: Uint8Array
}

const STORAGE_KEY = 'msgnr:e2ee:dm-device:v1'
const RECOVERY_PACKAGE_PREFIX = 'MSGE2E-R1.'
const RECOVERY_PACKAGE_PURPOSE = 'msgnr:e2ee:dm-recovery:v1'
const RECOVERY_PACKAGE_VERSION = 1
const RECOVERY_ARGON2_MEMORY_KIB = 64 * 1024
const RECOVERY_ARGON2_ITERATIONS = 3
const RECOVERY_ARGON2_PARALLELISM = 1
const RECOVERY_KEY_LENGTH_BYTES = 32
const RECOVERY_SALT_LENGTH_BYTES = 16
const RECOVERY_IV_LENGTH_BYTES = 12
const RECOVERY_MAX_PACKAGE_LENGTH = 32 * 1024
const RECOVERY_MAX_CIPHERTEXT_LENGTH = 16 * 1024
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const encoder = new TextEncoder()
const decoder = new TextDecoder()

interface RecoveryPackageV1 {
  purpose: string
  version: number
  kdf: {
    name: string
    memoryKiB: number
    iterations: number
    parallelism: number
    salt: string
  }
  cipher: {
    name: string
    iv: string
  }
  ciphertext: string
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function stringToBase64(value: string): string {
  return bytesToBase64(encoder.encode(value))
}

function base64ToString(value: string): string {
  return decoder.decode(base64ToBytes(value))
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function base64UrlToBytes(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new E2EERecoveryError('invalid')
  }
  const remainder = value.length % 4
  if (remainder === 1) throw new E2EERecoveryError('invalid')
  const padding = remainder === 0 ? '' : '='.repeat(4 - remainder)
  try {
    return base64ToBytes(value.replace(/-/g, '+').replace(/_/g, '/') + padding)
  } catch {
    throw new E2EERecoveryError('invalid')
  }
}

function wipe(bytes: Uint8Array | undefined) {
  bytes?.fill(0)
}

function wipeArrayBuffer(buffer: ArrayBuffer) {
  new Uint8Array(buffer).fill(0)
}

function readLocalDevice(): LocalE2EEDevice | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as LocalE2EEDevice
    if (!parsed.deviceId || !parsed.publicKeyJwk || !parsed.privateKeyJwk) return null
    return parsed
  } catch {
    return null
  }
}

function writeLocalDevice(device: LocalE2EEDevice) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(device))
}

export function localEncryptedDMDeviceId(): string | undefined {
  return readLocalDevice()?.deviceId
}

export function hasLocalEncryptedDMDevice(): boolean {
  return readLocalDevice() !== null
}

async function importPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey'])
}

async function importPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
}

async function deriveAesKey(privateKey: CryptoKey, publicKey: CryptoKey): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: publicKey },
    privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function createLocalDevice(): Promise<LocalE2EEDevice> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey'])
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  const device = {
    deviceId: crypto.randomUUID(),
    publicKeyJwk,
    privateKeyJwk,
  }
  writeLocalDevice(device)
  return device
}

function currentDeviceLabel(): string {
  return typeof navigator === 'undefined' ? 'web' : navigator.userAgent.slice(0, 120)
}

function registrationPayloadForDevice(device: LocalE2EEDevice): E2EEDeviceRegistrationPayload {
  const publicKey = JSON.stringify(device.publicKeyJwk)
  return {
    device_id: device.deviceId,
    device_label: currentDeviceLabel(),
    identity_key_public: stringToBase64(publicKey),
    signed_prekey_id: 1,
    signed_prekey_public: stringToBase64(publicKey),
    signed_prekey_signature: stringToBase64('webcrypto-p256-v1'),
  }
}

export async function ensureEncryptedDMDevice(): Promise<LocalE2EEDevice> {
  const device = readLocalDevice() ?? await createLocalDevice()
  await registerE2EEDevice(registrationPayloadForDevice(device))
  return device
}

function recoveryAad(salt: string, iv: string): Uint8Array {
  return encoder.encode(JSON.stringify({
    purpose: RECOVERY_PACKAGE_PURPOSE,
    version: RECOVERY_PACKAGE_VERSION,
    kdf: {
      name: 'argon2id',
      memoryKiB: RECOVERY_ARGON2_MEMORY_KIB,
      iterations: RECOVERY_ARGON2_ITERATIONS,
      parallelism: RECOVERY_ARGON2_PARALLELISM,
      salt,
    },
    cipher: {
      name: 'AES-256-GCM',
      iv,
    },
  }))
}

async function deriveRecoveryKey(passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
  if (!passphrase) throw new E2EERecoveryError('invalid')
  const { argon2id } = await import('hash-wasm')
  const password = encoder.encode(passphrase)
  try {
    const derived = await argon2id({
      password,
      salt,
      parallelism: RECOVERY_ARGON2_PARALLELISM,
      iterations: RECOVERY_ARGON2_ITERATIONS,
      memorySize: RECOVERY_ARGON2_MEMORY_KIB,
      hashLength: RECOVERY_KEY_LENGTH_BYTES,
      outputType: 'binary',
    })
    if (!(derived instanceof Uint8Array) || derived.byteLength !== RECOVERY_KEY_LENGTH_BYTES) {
      throw new E2EERecoveryError('invalid')
    }
    return derived
  } finally {
    wipe(password)
  }
}

async function importRecoveryAesKey(keyMaterial: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  const buffer = bytesToArrayBuffer(keyMaterial)
  try {
    return await crypto.subtle.importKey(
      'raw',
      buffer,
      { name: 'AES-GCM', length: 256 },
      false,
      usages,
    )
  } finally {
    wipeArrayBuffer(buffer)
  }
}

function recoveryPackageFromValue(value: string): RecoveryPackageV1 {
  const trimmed = value.trim()
  if (!trimmed.startsWith(RECOVERY_PACKAGE_PREFIX) || trimmed.length > RECOVERY_MAX_PACKAGE_LENGTH) {
    throw new E2EERecoveryError('invalid')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(decoder.decode(base64UrlToBytes(trimmed.slice(RECOVERY_PACKAGE_PREFIX.length))))
  } catch (error) {
    if (error instanceof E2EERecoveryError) throw error
    throw new E2EERecoveryError('invalid')
  }
  if (!parsed || typeof parsed !== 'object') throw new E2EERecoveryError('invalid')
  return parsed as RecoveryPackageV1
}

function validateRecoveryPackageHeader(recoveryPackage: RecoveryPackageV1): { salt: Uint8Array; iv: Uint8Array; ciphertext: Uint8Array } {
  if (recoveryPackage.purpose !== RECOVERY_PACKAGE_PURPOSE) throw new E2EERecoveryError('invalid')
  if (recoveryPackage.version !== RECOVERY_PACKAGE_VERSION) throw new E2EERecoveryError('unsupported')
  if (
    recoveryPackage.kdf?.name !== 'argon2id'
    || recoveryPackage.kdf.memoryKiB !== RECOVERY_ARGON2_MEMORY_KIB
    || recoveryPackage.kdf.iterations !== RECOVERY_ARGON2_ITERATIONS
    || recoveryPackage.kdf.parallelism !== RECOVERY_ARGON2_PARALLELISM
    || recoveryPackage.cipher?.name !== 'AES-256-GCM'
  ) {
    throw new E2EERecoveryError('unsupported')
  }
  const salt = base64UrlToBytes(recoveryPackage.kdf.salt)
  const iv = base64UrlToBytes(recoveryPackage.cipher.iv)
  const ciphertext = base64UrlToBytes(recoveryPackage.ciphertext)
  if (
    salt.byteLength !== RECOVERY_SALT_LENGTH_BYTES
    || iv.byteLength !== RECOVERY_IV_LENGTH_BYTES
    || ciphertext.byteLength < 16
    || ciphertext.byteLength > RECOVERY_MAX_CIPHERTEXT_LENGTH
  ) {
    throw new E2EERecoveryError('invalid')
  }
  return { salt, iv, ciphertext }
}

async function validateRecoveryDevice(device: LocalE2EEDevice): Promise<void> {
  if (!UUID_PATTERN.test(device.deviceId)) throw new E2EERecoveryError('invalid')
  if (
    device.publicKeyJwk?.kty !== 'EC'
    || device.publicKeyJwk.crv !== 'P-256'
    || typeof device.publicKeyJwk.x !== 'string'
    || typeof device.publicKeyJwk.y !== 'string'
    || device.privateKeyJwk?.kty !== 'EC'
    || device.privateKeyJwk.crv !== 'P-256'
    || typeof device.privateKeyJwk.x !== 'string'
    || typeof device.privateKeyJwk.y !== 'string'
    || typeof device.privateKeyJwk.d !== 'string'
    || device.privateKeyJwk.x !== device.publicKeyJwk.x
    || device.privateKeyJwk.y !== device.publicKeyJwk.y
  ) {
    throw new E2EERecoveryError('invalid')
  }
  try {
    await Promise.all([
      importPrivateKey(device.privateKeyJwk),
      importPublicKey(device.publicKeyJwk),
    ])
  } catch {
    throw new E2EERecoveryError('invalid')
  }
}

export async function exportEncryptedDMRecoveryPackage(passphrase: string): Promise<string> {
  const device = readLocalDevice()
  if (!device) throw new E2EERecoveryError('unavailable')
  await validateRecoveryDevice(device)

  const salt = crypto.getRandomValues(new Uint8Array(RECOVERY_SALT_LENGTH_BYTES))
  const iv = crypto.getRandomValues(new Uint8Array(RECOVERY_IV_LENGTH_BYTES))
  const saltEncoded = bytesToBase64Url(salt)
  const ivEncoded = bytesToBase64Url(iv)
  const aad = recoveryAad(saltEncoded, ivEncoded)
  let keyMaterial: Uint8Array | undefined
  let plaintext: Uint8Array | undefined
  try {
    keyMaterial = await deriveRecoveryKey(passphrase, salt)
    const key = await importRecoveryAesKey(keyMaterial, ['encrypt'])
    plaintext = encoder.encode(JSON.stringify({
      deviceId: device.deviceId,
      publicKeyJwk: device.publicKeyJwk,
      privateKeyJwk: device.privateKeyJwk,
    }))
    const ivBuffer = bytesToArrayBuffer(iv)
    const aadBuffer = bytesToArrayBuffer(aad)
    const plaintextBuffer = bytesToArrayBuffer(plaintext)
    let ciphertext: Uint8Array
    try {
      ciphertext = new Uint8Array(await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: ivBuffer, additionalData: aadBuffer },
        key,
        plaintextBuffer,
      ))
    } finally {
      wipeArrayBuffer(ivBuffer)
      wipeArrayBuffer(aadBuffer)
      wipeArrayBuffer(plaintextBuffer)
    }
    const recoveryPackage: RecoveryPackageV1 = {
      purpose: RECOVERY_PACKAGE_PURPOSE,
      version: RECOVERY_PACKAGE_VERSION,
      kdf: {
        name: 'argon2id',
        memoryKiB: RECOVERY_ARGON2_MEMORY_KIB,
        iterations: RECOVERY_ARGON2_ITERATIONS,
        parallelism: RECOVERY_ARGON2_PARALLELISM,
        salt: saltEncoded,
      },
      cipher: {
        name: 'AES-256-GCM',
        iv: ivEncoded,
      },
      ciphertext: bytesToBase64Url(ciphertext),
    }
    return RECOVERY_PACKAGE_PREFIX + bytesToBase64Url(encoder.encode(JSON.stringify(recoveryPackage)))
  } finally {
    wipe(keyMaterial)
    wipe(plaintext)
    wipe(salt)
    wipe(iv)
    wipe(aad)
  }
}

export async function prepareEncryptedDMRecoveryImport(
  recoveryPackageText: string,
  passphrase: string,
): Promise<PreparedEncryptedDMRecoveryImport> {
  const recoveryPackage = recoveryPackageFromValue(recoveryPackageText)
  const { salt, iv, ciphertext } = validateRecoveryPackageHeader(recoveryPackage)
  const aad = recoveryAad(recoveryPackage.kdf.salt, recoveryPackage.cipher.iv)
  let keyMaterial: Uint8Array | undefined
  let plaintext: Uint8Array | undefined
  try {
    keyMaterial = await deriveRecoveryKey(passphrase, salt)
    const key = await importRecoveryAesKey(keyMaterial, ['decrypt'])
    const ivBuffer = bytesToArrayBuffer(iv)
    const aadBuffer = bytesToArrayBuffer(aad)
    const ciphertextBuffer = bytesToArrayBuffer(ciphertext)
    try {
      plaintext = new Uint8Array(await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: ivBuffer, additionalData: aadBuffer },
        key,
        ciphertextBuffer,
      ))
    } catch {
      throw new E2EERecoveryError('invalid')
    } finally {
      wipeArrayBuffer(ivBuffer)
      wipeArrayBuffer(aadBuffer)
      wipeArrayBuffer(ciphertextBuffer)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(decoder.decode(plaintext))
    } catch {
      throw new E2EERecoveryError('invalid')
    }
    if (!parsed || typeof parsed !== 'object') throw new E2EERecoveryError('invalid')
    const device = parsed as LocalE2EEDevice
    await validateRecoveryDevice(device)
    return {
      deviceId: device.deviceId,
      registration: registrationPayloadForDevice(device),
      install() {
        writeLocalDevice(device)
      },
    }
  } finally {
    wipe(keyMaterial)
    wipe(plaintext)
    wipe(salt)
    wipe(iv)
    wipe(ciphertext)
    wipe(aad)
  }
}

function publicKeyFromDevice(device: E2EEDeviceItem): JsonWebKey {
  return JSON.parse(base64ToString(device.identity_key_public)) as JsonWebKey
}

export async function encryptDMMessage(conversationId: string, clientMsgId: string, body: string): Promise<{
  senderDeviceId: string
  envelopes: EncryptedDMEnvelope[]
}> {
  const localDevice = await ensureEncryptedDMDevice()
  const recipientDevices = await listEncryptedDMDevices(conversationId)
  if (recipientDevices.length === 0) {
    throw new Error('No E2E devices are available for this conversation')
  }
  const plaintext = encoder.encode(JSON.stringify({ body }))
  const envelopes: EncryptedDMEnvelope[] = []
  for (const recipientDevice of recipientDevices) {
    const recipientPublicKey = await importPublicKey(publicKeyFromDevice(recipientDevice))
    const ephemeralPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey'])
    const ephemeralPublicJwk = await crypto.subtle.exportKey('jwk', ephemeralPair.publicKey)
    const aesKey = await deriveAesKey(ephemeralPair.privateKey, recipientPublicKey)
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const metadataAad = encoder.encode(JSON.stringify({
      conversationId,
      clientMsgId,
      senderDeviceId: localDevice.deviceId,
      recipientDeviceId: recipientDevice.device_id,
      algorithm: ENCRYPTED_DM_ALGORITHM,
    }))
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: bytesToArrayBuffer(iv), additionalData: bytesToArrayBuffer(metadataAad) },
      aesKey,
      bytesToArrayBuffer(plaintext),
    ))
    const sessionMessage = encoder.encode(JSON.stringify({
      v: 1,
      epk: ephemeralPublicJwk,
      iv: bytesToBase64(iv),
      ct: bytesToBase64(ciphertext),
    }))
    envelopes.push({
      recipientDeviceId: recipientDevice.device_id,
      senderDeviceId: localDevice.deviceId,
      algorithm: ENCRYPTED_DM_ALGORITHM,
      sessionMessage,
      metadataAad,
    })
  }
  return { senderDeviceId: localDevice.deviceId, envelopes }
}

export async function conversationHasEncryptedDMDevices(conversationId: string): Promise<boolean> {
  await ensureEncryptedDMDevice()
  const devices = await listEncryptedDMDevices(conversationId)
  return devices.length > 0
}

export async function decryptDMMessage(payloads: EncryptedDMPayloadItem[] | EncryptedDMEnvelope[] | undefined): Promise<string | null> {
  if (!payloads || payloads.length === 0) return null
  const localDevice = readLocalDevice()
  if (!localDevice) return null
  const payload = payloads.find(item => {
    const recipientDeviceId = 'recipient_device_id' in item ? item.recipient_device_id : item.recipientDeviceId
    return recipientDeviceId === localDevice.deviceId
  })
  if (!payload) return null
  const sessionMessageBytes = 'session_message' in payload
    ? base64ToBytes(payload.session_message)
    : payload.sessionMessage
  const metadataAad = 'metadata_aad' in payload
    ? base64ToBytes(payload.metadata_aad)
    : payload.metadataAad
  const sessionMessage = JSON.parse(decoder.decode(sessionMessageBytes)) as { epk: JsonWebKey; iv: string; ct: string }
  const privateKey = await importPrivateKey(localDevice.privateKeyJwk)
  const ephemeralPublicKey = await importPublicKey(sessionMessage.epk)
  const aesKey = await deriveAesKey(privateKey, ephemeralPublicKey)
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytesToArrayBuffer(base64ToBytes(sessionMessage.iv)), additionalData: bytesToArrayBuffer(metadataAad) },
    aesKey,
    bytesToArrayBuffer(base64ToBytes(sessionMessage.ct)),
  )
  const parsed = JSON.parse(decoder.decode(new Uint8Array(decrypted))) as { body?: string }
  return parsed.body ?? ''
}
