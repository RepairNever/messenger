import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import UserAvatar from '@/components/UserAvatar.vue'
import { ensureLocalStorageMock } from '@/__tests__/testUtils'
import type { UserCustomStatus } from '@/types/userStatus'

type UserAvatarTestProps = {
  userId: string
  displayName?: string
  avatarUrl?: string
  customStatus?: UserCustomStatus | null
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  presence?: 'online' | 'away' | 'offline'
}

const avatarCacheMocks = vi.hoisted(() => ({
  resolveAvatarUrlForDisplay: vi.fn((url: string) => url.trim()),
  getCachedAvatarObjectUrl: vi.fn(() => ''),
  loadCachedAvatarUrl: vi.fn((url: string) => Promise.resolve(url)),
}))

vi.mock('@/services/avatar/avatarCache', () => ({
  resolveAvatarUrlForDisplay: avatarCacheMocks.resolveAvatarUrlForDisplay,
  getCachedAvatarObjectUrl: avatarCacheMocks.getCachedAvatarObjectUrl,
  loadCachedAvatarUrl: avatarCacheMocks.loadCachedAvatarUrl,
}))

let testPinia: ReturnType<typeof createPinia>

beforeEach(() => {
  ensureLocalStorageMock()
  testPinia = createPinia()
  setActivePinia(testPinia)
  avatarCacheMocks.resolveAvatarUrlForDisplay.mockReset()
  avatarCacheMocks.resolveAvatarUrlForDisplay.mockImplementation((url: string) => url.trim())
  avatarCacheMocks.getCachedAvatarObjectUrl.mockReset()
  avatarCacheMocks.getCachedAvatarObjectUrl.mockReturnValue('')
  avatarCacheMocks.loadCachedAvatarUrl.mockReset()
  avatarCacheMocks.loadCachedAvatarUrl.mockImplementation((url: string) => Promise.resolve(url))
})

afterEach(() => {
  ;(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = undefined
  localStorage.removeItem('msgnr.desktop.backend_base_url')
})

describe('UserAvatar', () => {
  it('renders initials fallback and stable color for the same user id', () => {
    const first = mountUserAvatar({
      userId: 'user-42',
      displayName: 'Ada Lovelace',
    })
    const second = mountUserAvatar({
      userId: 'user-42',
      displayName: 'Different Name',
    })

    expect(first.text()).toContain('A')
    expect(second.text()).toContain('D')

    const firstColor = first.find('[style]').attributes('style')
    const secondColor = second.find('[style]').attributes('style')
    expect(firstColor).toBe(secondColor)
  })

  it('shows cached avatar image when url is provided and falls back to initials on error', async () => {
    avatarCacheMocks.loadCachedAvatarUrl.mockResolvedValue('blob:avatar-user-1')
    const wrapper = mountUserAvatar({
      userId: 'user-1',
      displayName: 'Bob',
      avatarUrl: '/api/public/avatars/avatars/user-1/pic.png',
    })
    await flushAvatarLoad()

    expect(wrapper.find('img').exists()).toBe(true)
    expect(wrapper.get('img').attributes('src')).toBe('blob:avatar-user-1')

    await wrapper.get('img').trigger('error')

    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).toContain('B')
  })

  it('renders presence badge when presence is provided', () => {
    const wrapper = mountUserAvatar({
      userId: 'user-7',
      displayName: 'Eve',
      presence: 'online',
    })

    const badge = wrapper.find('span.absolute')
    expect(badge.exists()).toBe(true)
    expect(badge.classes()).toContain('bg-green-400')
  })

  it('renders active custom status badge from props', () => {
    const wrapper = mountUserAvatar({
      userId: 'user-8',
      displayName: 'Grace',
      customStatus: {
        text: 'gone to a meeting',
        emoji: '🌴',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    })

    expect(wrapper.text()).toContain('🌴')
    expect(wrapper.attributes('title')).toContain('gone to a meeting')
  })

  it('uses a synchronous in-memory cached avatar when available', () => {
    avatarCacheMocks.getCachedAvatarObjectUrl.mockReturnValue('blob:cached-avatar')

    const wrapper = mountUserAvatar({
      userId: 'user-9',
      displayName: 'Tauri User',
      avatarUrl: '/api/public/avatars/avatars/user-9/avatar.png',
    })

    expect(wrapper.get('img').attributes('src')).toBe('blob:cached-avatar')
    expect(avatarCacheMocks.loadCachedAvatarUrl).toHaveBeenCalledWith('/api/public/avatars/avatars/user-9/avatar.png')
  })

  it('falls back to the resolved direct url when cache loading fails', async () => {
    avatarCacheMocks.resolveAvatarUrlForDisplay.mockReturnValue('/resolved/avatar.png')
    avatarCacheMocks.loadCachedAvatarUrl.mockRejectedValue(new Error('cache failed'))

    const wrapper = mountUserAvatar({
      userId: 'user-10',
      displayName: 'Cache Fallback',
      avatarUrl: '/api/public/avatars/avatars/user-10/avatar.png',
    })
    await flushAvatarLoad()

    expect(wrapper.get('img').attributes('src')).toBe('/resolved/avatar.png')
  })

  it('loads a new cached avatar source when avatarUrl changes', async () => {
    avatarCacheMocks.loadCachedAvatarUrl.mockImplementation((url: string) => Promise.resolve(`blob:${url}`))
    const wrapper = mountUserAvatar({
      userId: 'user-11',
      displayName: 'Changing User',
      avatarUrl: '/api/public/avatars/avatars/user-11/one.png',
    })
    await flushAvatarLoad()

    expect(wrapper.get('img').attributes('src')).toBe('blob:/api/public/avatars/avatars/user-11/one.png')

    await wrapper.setProps({ avatarUrl: '/api/public/avatars/avatars/user-11/two.png' })
    await flushAvatarLoad()

    expect(wrapper.get('img').attributes('src')).toBe('blob:/api/public/avatars/avatars/user-11/two.png')
    expect(avatarCacheMocks.loadCachedAvatarUrl).toHaveBeenCalledWith('/api/public/avatars/avatars/user-11/two.png')
  })
})

async function flushAvatarLoad() {
  await Promise.resolve()
  await nextTick()
}

function mountUserAvatar(props: UserAvatarTestProps) {
  return mount(UserAvatar, {
    props,
    global: {
      plugins: [testPinia],
    },
  })
}
