import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureLocalStorageMock } from '@/__tests__/testUtils'

const apiMocks = vi.hoisted(() => ({
  listEncryptedDMDevices: vi.fn(),
  registerE2EEDevice: vi.fn(),
}))

const argon2idMock = vi.hoisted(() => vi.fn())

vi.mock('@/services/http/chatApi', () => ({
  listEncryptedDMDevices: apiMocks.listEncryptedDMDevices,
  registerE2EEDevice: apiMocks.registerE2EEDevice,
}))

vi.mock('hash-wasm', () => ({
  argon2id: argon2idMock,
}))

import {
  E2EERecoveryError,
  decryptDMMessage,
  encryptDMMessage,
  ensureEncryptedDMDevice,
  exportEncryptedDMRecoveryPackage,
  hasLocalEncryptedDMDevice,
  localEncryptedDMDeviceId,
  prepareEncryptedDMRecoveryImport,
} from '@/services/e2ee/dmE2ee'

function deviceItemFromRegistration() {
  const calls = apiMocks.registerE2EEDevice.mock.calls
  const payload = calls[calls.length - 1]?.[0]
  if (!payload) throw new Error('expected E2EE device registration')
  return {
    device_id: payload.device_id,
    user_id: 'user-1',
    device_label: payload.device_label,
    identity_key_public: payload.identity_key_public,
    signed_prekey_id: payload.signed_prekey_id,
    signed_prekey_public: payload.signed_prekey_public,
    signed_prekey_signature: payload.signed_prekey_signature,
  }
}

async function expectRecoveryError(promise: Promise<unknown>, code: E2EERecoveryError['code']) {
  await expect(promise).rejects.toMatchObject({ code })
}

function encodeRecoveryPackage(value: unknown): string {
  return `MSGE2E-R1.${btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')}`
}

describe('encrypted DM recovery package', () => {
  beforeEach(() => {
    ensureLocalStorageMock()
    localStorage.clear()
    apiMocks.listEncryptedDMDevices.mockReset()
    apiMocks.registerE2EEDevice.mockReset()
    apiMocks.registerE2EEDevice.mockResolvedValue({})
    argon2idMock.mockReset()
    argon2idMock.mockImplementation(async ({ password, salt }: { password: Uint8Array; salt: Uint8Array }) => {
      const material = new Uint8Array(32)
      for (let index = 0; index < material.length; index += 1) {
        material[index] = (password[index % password.length] ?? 0) ^ salt[index % salt.length]
      }
      return material
    })
  })

  it('exports an existing identity and restores it to decrypt pre-feature ciphertext', async () => {
    await ensureEncryptedDMDevice()
    const originalDeviceId = localEncryptedDMDeviceId()
    expect(originalDeviceId).toBeTruthy()
    apiMocks.listEncryptedDMDevices.mockResolvedValue([deviceItemFromRegistration()])

    const encrypted = await encryptDMMessage('conversation-1', 'client-message-1', 'existing secret history')
    const recoveryPackage = await exportEncryptedDMRecoveryPackage('correct horse battery staple')

    expect(recoveryPackage).toMatch(/^MSGE2E-R1\./)
    expect(recoveryPackage).not.toContain('existing secret history')
    expect(argon2idMock).toHaveBeenCalledWith(expect.objectContaining({
      memorySize: 64 * 1024,
      iterations: 3,
      parallelism: 1,
      hashLength: 32,
      outputType: 'binary',
    }))

    localStorage.clear()
    expect(hasLocalEncryptedDMDevice()).toBe(false)
    await expect(decryptDMMessage(encrypted.envelopes)).resolves.toBeNull()

    const prepared = await prepareEncryptedDMRecoveryImport(recoveryPackage, 'correct horse battery staple')
    expect(JSON.stringify(prepared.registration)).not.toContain('privateKeyJwk')
    expect(JSON.stringify(prepared.registration)).not.toContain('"d"')
    prepared.install()

    expect(localEncryptedDMDeviceId()).toBe(originalDeviceId)
    await expect(decryptDMMessage(encrypted.envelopes)).resolves.toBe('existing secret history')
  })

  it('does not replace a current identity when the passphrase is wrong or the package is tampered', async () => {
    await ensureEncryptedDMDevice()
    const originalDeviceId = localEncryptedDMDeviceId()
    const recoveryPackage = await exportEncryptedDMRecoveryPackage('right passphrase')

    await expectRecoveryError(
      prepareEncryptedDMRecoveryImport(recoveryPackage, 'wrong passphrase'),
      'invalid',
    )
    expect(localEncryptedDMDeviceId()).toBe(originalDeviceId)

    const tampered = recoveryPackage.slice(0, -1) + (recoveryPackage.endsWith('A') ? 'B' : 'A')
    await expectRecoveryError(
      prepareEncryptedDMRecoveryImport(tampered, 'right passphrase'),
      'invalid',
    )
    expect(localEncryptedDMDeviceId()).toBe(originalDeviceId)
  })

  it('rejects an unsupported recovery package before running the KDF', async () => {
    const recoveryPackage = encodeRecoveryPackage({
      purpose: 'msgnr:e2ee:dm-recovery:v1',
      version: 2,
      kdf: {
        name: 'argon2id',
        memoryKiB: 64 * 1024,
        iterations: 3,
        parallelism: 1,
        salt: 'AAAAAAAAAAAAAAAAAAAAAA',
      },
      cipher: { name: 'AES-256-GCM', iv: 'AAAAAAAAAAAAAAAA' },
      ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA',
    })

    await expectRecoveryError(prepareEncryptedDMRecoveryImport(recoveryPackage, 'passphrase'), 'unsupported')
    expect(argon2idMock).not.toHaveBeenCalled()
  })

  it('rejects malformed, oversized, and disallowed-KDF packages without changing the local identity', async () => {
    await ensureEncryptedDMDevice()
    const originalDevice = localStorage.getItem('msgnr:e2ee:dm-device:v1')
    argon2idMock.mockClear()

    await expectRecoveryError(prepareEncryptedDMRecoveryImport('MSGE2E-R1.%not-base64url', 'passphrase'), 'invalid')
    await expectRecoveryError(prepareEncryptedDMRecoveryImport(`MSGE2E-R1.${'A'.repeat(32 * 1024)}`, 'passphrase'), 'invalid')
    await expectRecoveryError(prepareEncryptedDMRecoveryImport(encodeRecoveryPackage({
      purpose: 'msgnr:e2ee:dm-recovery:v1',
      version: 1,
      kdf: {
        name: 'argon2id',
        memoryKiB: 1024,
        iterations: 3,
        parallelism: 1,
        salt: 'AAAAAAAAAAAAAAAAAAAAAA',
      },
      cipher: { name: 'AES-256-GCM', iv: 'AAAAAAAAAAAAAAAA' },
      ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA',
    }), 'passphrase'), 'unsupported')

    expect(localStorage.getItem('msgnr:e2ee:dm-device:v1')).toBe(originalDevice)
    expect(argon2idMock).not.toHaveBeenCalled()
  })

  it('does not export a recovery package when this browser has no E2EE identity', async () => {
    await expectRecoveryError(exportEncryptedDMRecoveryPackage('passphrase'), 'unavailable')
  })
})
