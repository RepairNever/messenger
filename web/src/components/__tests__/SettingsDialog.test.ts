import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import SettingsDialog from '@/components/SettingsDialog.vue'

const mocks = vi.hoisted(() => ({
  audioDevices: null as any,
  pushNotifications: null as any,
  loadAudioPrefs: vi.fn(),
  isTauriRuntime: vi.fn(),
  getPlatformOrNull: vi.fn(),
}))

vi.mock('@/composables/useAudioDevices', () => ({
  useAudioDevices: () => mocks.audioDevices,
}))

vi.mock('@/composables/usePushNotifications', () => ({
  usePushNotifications: () => mocks.pushNotifications,
}))

vi.mock('@/services/storage/audioPrefsStorage', () => ({
  loadAudioPrefs: mocks.loadAudioPrefs,
}))

vi.mock('@/platform/runtime', () => ({
  isTauriRuntime: mocks.isTauriRuntime,
}))

vi.mock('@/platform', () => ({
  getPlatformOrNull: mocks.getPlatformOrNull,
}))

async function flushAll() {
  await Promise.resolve()
  await nextTick()
}

describe('SettingsDialog', () => {
  beforeEach(() => {
    mocks.audioDevices = {
      inputDevices: ref([]),
      outputDevices: ref([]),
      permissionState: ref('granted'),
      selectedInputId: ref(''),
      selectedOutputId: ref(''),
      inputStatus: ref('Microphone access granted.'),
      outputStatus: ref('Connected'),
      outputSupported: ref(true),
      inputLevel: ref(0),
      isTesting: ref(false),
      isTestingOutput: ref(false),
      testError: ref(''),
      noiseSuppression: ref(true),
      echoCancellation: ref(true),
      autoGainControl: ref(true),
      microphoneGain: ref(100),
      rnnoiseEnabled: ref(true),
      muteMicOnJoinCall: ref(false),
      loadDevices: vi.fn().mockResolvedValue(undefined),
      requestPermission: vi.fn(),
      testMicrophone: vi.fn(),
      stopMicTest: vi.fn(),
      testOutput: vi.fn(),
      stopOutputTest: vi.fn(),
      savePrefs: vi.fn(),
    }
    mocks.pushNotifications = {
      permissionState: ref('default'),
      isSubscribed: ref(false),
      isLoading: ref(false),
      error: ref(''),
      isUnsupported: ref(false),
      needsIosInstall: ref(false),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      checkExistingSubscription: vi.fn(),
    }
    mocks.loadAudioPrefs.mockReturnValue({
      inputDeviceId: '',
      outputDeviceId: '',
      noiseSuppression: true,
      echoCancellation: true,
      autoGainControl: true,
      microphoneGain: 100,
      rnnoiseEnabled: true,
      muteMicOnJoinCall: false,
    })
    mocks.isTauriRuntime.mockReturnValue(false)
    mocks.getPlatformOrNull.mockReturnValue(null)
  })

  it('hydrates and persists mute microphone on join call', async () => {
    const wrapper = mount(SettingsDialog, {
      props: { open: false },
      global: {
        stubs: {
          Teleport: true,
          IosInstallGuide: true,
        },
      },
    })

    await wrapper.setProps({ open: true })
    await flushAll()

    const summary = wrapper.get('summary')
    await summary.trigger('click')
    await nextTick()

    const muteOnJoinButton = wrapper.get('button[aria-label="Mute microphone on join call off"]')
    expect(mocks.audioDevices.loadDevices).toHaveBeenCalledTimes(1)

    await muteOnJoinButton.trigger('click')
    await nextTick()

    const saveButton = wrapper.findAll('button').find(node => node.text() === 'Save')
    expect(saveButton?.attributes('disabled')).toBeUndefined()

    await saveButton?.trigger('click')

    expect(mocks.audioDevices.savePrefs).toHaveBeenCalledWith(
      '',
      '',
      true,
      true,
      true,
      100,
      true,
      true,
    )
    expect(wrapper.emitted('close')).toBeTruthy()
  })
})
