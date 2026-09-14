import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { create } from '@bufbuild/protobuf'
import {
  EventType,
  MessageAlertEventSchema,
  NotificationLevel,
  PresenceStatus,
  ServerEventSchema,
} from '@/shared/proto/packets_pb'
import { useAuthStore } from '@/stores/auth'
import { useTasksStore } from '@/stores/tasks'
import { useDocumentsStore } from '@/stores/documents'
import { useWsStore } from '@/stores/ws'
import { useChatStore } from '@/stores/chat'
import { useCallStore } from '@/stores/call'
import { usePinnedDialogsStore } from '@/stores/pinnedDialogs'
import { useOfflineQueue } from '@/composables/useOfflineQueue'
import { isUuidTaskRouteValue, taskSlugFromPublicId } from '@/services/taskRoute'
import { COLOR_THEME_STORAGE_KEY } from '@/services/storage/colorThemeStorage'
import { storage } from '@/services/storage/storageAdapter'
import * as chatApi from '@/services/http/chatApi'
import { toNotificationOpenMessage } from '@/services/notificationOpen'
import MainView from '@/views/MainView.vue'

const orchestratorMocks = vi.hoisted(() => ({
  logout: vi.fn<() => Promise<void>>(),
  reconnectNow: vi.fn<() => void>(),
  isReconnecting: null as ReturnType<typeof ref<boolean>> | null,
  reconnectAttempt: null as ReturnType<typeof ref<number>> | null,
}))

const taskRouteStorageMocks = vi.hoisted(() => ({
  loadLastOpenedTaskPublicId: vi.fn<() => string>(),
  saveLastOpenedTaskPublicId: vi.fn<(publicId: string) => void>(),
  clearLastOpenedTaskPublicId: vi.fn<() => void>(),
}))

const soundMocks = vi.hoisted(() => ({
  playMessagePing: vi.fn<() => Promise<void>>(),
  startCallInviteRing: vi.fn<() => Promise<void>>(),
  stopCallInviteRing: vi.fn<() => void>(),
}))

const platformMocks = vi.hoisted(() => ({
  adapter: null as any,
  show: vi.fn<(payload: Record<string, unknown>) => Promise<void>>(),
  playSound: vi.fn<(name: string) => Promise<void>>(),
  setBadge: vi.fn<(count: number) => Promise<void>>(),
  clearBadge: vi.fn<() => Promise<void>>(),
}))

const e2eeRecoveryMocks = vi.hoisted(() => ({
  hasLocalEncryptedDMDevice: vi.fn(),
  localEncryptedDMDeviceId: vi.fn(),
  exportEncryptedDMRecoveryPackage: vi.fn(),
  prepareEncryptedDMRecoveryImport: vi.fn(),
}))

const e2eeRecoveryApiMocks = vi.hoisted(() => ({
  activateE2EERecoveryDevice: vi.fn(),
}))

const clipboardMocks = vi.hoisted(() => ({
  writeText: vi.fn(),
}))

vi.mock('@/composables/useSessionOrchestrator', () => ({
  useSessionOrchestrator: () => ({
    logout: orchestratorMocks.logout,
    reconnectNow: orchestratorMocks.reconnectNow,
    isReconnecting: orchestratorMocks.isReconnecting,
    reconnectAttempt: orchestratorMocks.reconnectAttempt,
  }),
}))

vi.mock('@/services/sound', () => ({
  useNotificationSoundEngine: () => ({
    playMessagePing: soundMocks.playMessagePing,
    startCallInviteRing: soundMocks.startCallInviteRing,
    stopCallInviteRing: soundMocks.stopCallInviteRing,
  }),
}))

vi.mock('@/platform', () => ({
  getPlatformOrNull: () => platformMocks.adapter,
}))

vi.mock('@/services/e2ee/dmE2ee', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/e2ee/dmE2ee')>()
  return {
    ...actual,
    hasLocalEncryptedDMDevice: e2eeRecoveryMocks.hasLocalEncryptedDMDevice,
    localEncryptedDMDeviceId: e2eeRecoveryMocks.localEncryptedDMDeviceId,
    exportEncryptedDMRecoveryPackage: e2eeRecoveryMocks.exportEncryptedDMRecoveryPackage,
    prepareEncryptedDMRecoveryImport: e2eeRecoveryMocks.prepareEncryptedDMRecoveryImport,
  }
})

vi.mock('@/services/http/chatApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/http/chatApi')>()
  return {
    ...actual,
    activateE2EERecoveryDevice: e2eeRecoveryApiMocks.activateE2EERecoveryDevice,
  }
})

vi.mock('@/services/storage/lastTaskRouteStorage', () => ({
  loadLastOpenedTaskPublicId: taskRouteStorageMocks.loadLastOpenedTaskPublicId,
  saveLastOpenedTaskPublicId: taskRouteStorageMocks.saveLastOpenedTaskPublicId,
  clearLastOpenedTaskPublicId: taskRouteStorageMocks.clearLastOpenedTaskPublicId,
}))

vi.mock('@/components/AppSidebar.vue', () => ({
  default: {
    emits: ['search', 'profile', 'settings'],
    template: '<aside data-testid="sidebar"><button data-testid="sidebar-search-button" @click="$emit(\'search\')">search</button></aside>',
  },
}))

vi.mock('@/components/ResizableSidebar.vue', () => ({
  default: {
    template: '<div data-testid="resizable-sidebar"><slot /></div>',
  },
}))

vi.mock('@/components/ChatArea.vue', () => ({
  default: {
    emits: ['search-conversation'],
    template: '<section data-testid="chat-area"><button data-testid="conversation-search-button" @click="$emit(\'search-conversation\')">search</button></section>',
  },
}))

vi.mock('@/components/MessageSearchDialog.vue', () => ({
  default: {
    props: ['open', 'scope', 'conversationId', 'conversationTitle'],
    emits: ['close', 'openResult'],
    template: `
      <section
        v-if="open"
        data-testid="message-search-dialog"
        :data-scope="scope"
        :data-conversation-id="conversationId || ''"
        :data-conversation-title="conversationTitle || ''"
      >
        <button
          data-testid="message-search-open-chat"
          @click="$emit('openResult', {
            source: 'chat_message',
            id: 'chat:msg-1',
            body: 'needle',
            created_at: '2026-05-12T00:00:00Z',
            actor_id: 'user-2',
            actor_name: 'Bob',
            conversation_id: 'channel-1',
            conversation_title: 'general',
            conversation_kind: 'channel',
            conversation_visibility: 'public',
            message_id: 'msg-1'
          })"
        >open chat</button>
        <button
          data-testid="message-search-open-task-thread"
          @click="$emit('openResult', {
            source: 'task_comment_thread',
            id: 'task-comment-thread:reply-1',
            body: 'needle',
            created_at: '2026-05-12T00:00:00Z',
            actor_id: 'user-2',
            actor_name: 'Bob',
            conversation_id: 'hidden-conv-1',
            message_id: 'reply-1',
            thread_root_message_id: 'root-1',
            task_id: 'task-1',
            task_public_id: 'TASK-1',
            task_title: 'Fix search',
            task_comment_id: 'comment-1'
          })"
        >open task thread</button>
        <button
          data-testid="message-search-open-broken-task-thread"
          @click="$emit('openResult', {
            source: 'task_comment_thread',
            id: 'task-comment-thread:reply-bad',
            body: 'needle',
            created_at: '2026-05-12T00:00:00Z',
            actor_id: 'user-2',
            actor_name: 'Bob',
            conversation_id: 'hidden-conv-1',
            message_id: 'reply-bad',
            thread_root_message_id: 'root-1'
          })"
        >open broken task thread</button>
      </section>
    `,
  },
}))

vi.mock('@/components/UnreadFeedPane.vue', () => ({
  default: {
    props: [],
    emits: ['open-item'],
    template: '<section data-testid="unread-feed"><button data-testid="unread-feed-open" @click="$emit(\'open-item\', { id: \'thread:notif-1\', notificationId: \'notif-1\', conversationId: \'dm-1\', kind: \'thread\', messageId: \'msg-1\', threadRootMessageId: \'root-1\' })">open</button></section>',
  },
}))

vi.mock('@/components/tasks/TaskTrackerShell.vue', () => ({
  __isTeleport: false,
  default: {
    props: ['modelValue', 'currentView', 'viewMode'],
    emits: ['update:modelValue', 'openList', 'openKanban', 'openTask', 'back'],
    template: `
      <div data-testid="task-tracker">
        <aside data-testid="task-tracker-sidebar" />
        <section v-if="viewMode === 'card'" data-testid="task-card">
          <button data-testid="task-card-back" @click="$emit('back')">back</button>
        </section>
        <section v-else-if="viewMode === 'kanban'" data-testid="task-kanban-view">
          <button data-testid="task-kanban-open" @click="$emit('openTask', 'TASK-K')">open</button>
        </section>
        <section v-else data-testid="task-list-view">
          <button data-testid="task-list-open" @click="$emit('openTask', 'TASK-1')">open</button>
        </section>
        <div data-testid="task-create-dialog" />
      </div>
    `,
  },
}))

vi.mock('@/components/tasks/TaskTrackerSidebar.vue', () => ({
  default: {
    props: ['modelValue', 'currentView'],
    emits: ['update:modelValue', 'openList', 'openKanban'],
    template: '<aside data-testid="task-tracker-sidebar" />',
  },
}))

vi.mock('@/components/tasks/TaskListView.vue', () => ({
  default: {
    emits: ['openTask'],
    template: '<section data-testid="task-list-view"><button data-testid="task-list-open" @click="$emit(\'openTask\', \'TASK-1\')">open</button></section>',
  },
}))

vi.mock('@/components/tasks/TaskKanbanView.vue', () => ({
  default: {
    emits: ['openTask'],
    template: '<section data-testid="task-kanban-view"><button data-testid="task-kanban-open" @click="$emit(\'openTask\', \'TASK-K\')">open</button></section>',
  },
}))

vi.mock('@/components/tasks/TaskCard.vue', () => ({
  default: {
    emits: ['back'],
    template: '<section data-testid="task-card"><button data-testid="task-card-back" @click="$emit(\'back\')">back</button></section>',
  },
}))

vi.mock('@/components/tasks/TaskCreateDialog.vue', () => ({
  default: {
    template: '<div data-testid="task-create-dialog" />',
  },
}))

vi.mock('@/components/documents/DocumentsSidebar.vue', () => ({
  default: {
    props: ['selectedTeamspaceId', 'selectedDocumentId', 'searchQuery'],
    emits: ['openTeamspaces', 'openTeamspace', 'openDocument', 'searchQueryChange'],
    template: '<aside data-testid="documents-sidebar"><input data-testid="documents-search-input" :value="searchQuery" @input="$emit(\'searchQueryChange\', $event.target.value)" /></aside>',
  },
}))

vi.mock('@/components/documents/DocumentsShell.vue', () => ({
  __isTeleport: false,
  default: {
    props: ['selectedTeamspaceId', 'selectedDocumentId', 'searchQuery', 'viewMode'],
    emits: ['openTeamspaces', 'openTeamspace', 'openDocument', 'documentsDeleted', 'searchQueryChange', 'back', 'openParent'],
    template: `
      <div data-testid="documents-mode">
        <aside data-testid="documents-sidebar">
          <input data-testid="documents-search-input" :value="searchQuery" @input="$emit('searchQueryChange', $event.target.value)" />
        </aside>
        <section v-if="viewMode === 'card'" data-testid="document-card">
          <button data-testid="document-card-back" @click="$emit('back')">back</button>
        </section>
        <section v-else-if="viewMode === 'search'" data-testid="documents-search-view">
          <button data-testid="documents-search-open" @click="$emit('openDocument', 'search-doc-1')">open</button>
        </section>
        <section v-else data-testid="teamspaces-view" />
      </div>
    `,
  },
}))

vi.mock('@/components/documents/TeamspacesView.vue', () => ({
  default: {
    props: ['selectedTeamspaceId'],
    emits: ['openTeamspace'],
    template: '<section data-testid="teamspaces-view" />',
  },
}))

vi.mock('@/components/documents/DocumentCard.vue', () => ({
  default: {
    emits: ['back', 'openParent'],
    template: '<section data-testid="document-card"><button data-testid="document-card-back" @click="$emit(\'back\')">back</button></section>',
  },
}))

function createMainRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'main', component: MainView },
      { path: '/tasks', name: 'tasks-list', component: MainView },
      { path: '/tasks/kanban', name: 'tasks-kanban', component: MainView },
      {
        path: '/tasks/:taskSlug',
        name: 'tasks-card',
        component: MainView,
        beforeEnter: (to) => {
          const taskSlug = typeof to.params.taskSlug === 'string' ? to.params.taskSlug : ''
          if (!taskSlug || isUuidTaskRouteValue(taskSlug)) {
            return { name: 'tasks-list' }
          }

          const canonicalTaskSlug = taskSlugFromPublicId(taskSlug)
          if (taskSlug !== canonicalTaskSlug) {
            return {
              name: 'tasks-card',
              params: { taskSlug: canonicalTaskSlug },
              query: to.query,
              hash: to.hash,
              replace: true,
            }
          }

          return true
        },
      },
      { path: '/documents', name: 'documents-teamspaces', component: MainView },
      { path: '/documents/teamspaces/:teamspaceId', name: 'documents-teamspace', component: MainView },
      { path: '/documents/search', name: 'documents-search', component: MainView },
      { path: '/documents/:documentId', name: 'documents-card', component: MainView },
      { path: '/dayoffs', name: 'dayoffs', component: MainView },
      { path: '/login', name: 'login', component: { template: '<div>login</div>' } },
    ],
  })
}

async function flushUi() {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

async function flushAsyncWork(cycles = 4) {
  for (let i = 0; i < cycles; i += 1) {
    await flushUi()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function mountAtRoute(router: ReturnType<typeof createMainRouter>) {
  return mount(
    { template: '<router-view />' },
    { global: { plugins: [pinia, router] } },
  )
}

function createServiceWorkerContainerMock() {
  const listeners = new Set<(event: MessageEvent) => void>()
  return {
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      if (type !== 'message' || typeof listener !== 'function') return
      listeners.add(listener as (event: MessageEvent) => void)
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      if (type !== 'message' || typeof listener !== 'function') return
      listeners.delete(listener as (event: MessageEvent) => void)
    },
    dispatchMessage(data: unknown) {
      const event = { data } as MessageEvent
      for (const listener of listeners) listener(event)
    },
  }
}

let pinia: Pinia
let serviceWorkerContainerMock: ReturnType<typeof createServiceWorkerContainerMock>

describe('MainView server unavailable state', () => {
  beforeEach(() => {
    storage.clear()
    useOfflineQueue().clear()
    pinia = createPinia()
    setActivePinia(pinia)
    serviceWorkerContainerMock = createServiceWorkerContainerMock()
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: serviceWorkerContainerMock,
    })
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    })
    Object.defineProperty(document, 'hasFocus', {
      configurable: true,
      value: vi.fn(() => true),
    })
    orchestratorMocks.logout.mockReset()
    orchestratorMocks.logout.mockResolvedValue()
    orchestratorMocks.reconnectNow.mockReset()
    orchestratorMocks.isReconnecting = ref(false)
    orchestratorMocks.reconnectAttempt = ref(0)
    taskRouteStorageMocks.loadLastOpenedTaskPublicId.mockReset()
    taskRouteStorageMocks.loadLastOpenedTaskPublicId.mockReturnValue('')
    taskRouteStorageMocks.saveLastOpenedTaskPublicId.mockReset()
    taskRouteStorageMocks.clearLastOpenedTaskPublicId.mockReset()
    soundMocks.playMessagePing.mockReset()
    soundMocks.playMessagePing.mockResolvedValue(undefined)
    soundMocks.startCallInviteRing.mockReset()
    soundMocks.startCallInviteRing.mockResolvedValue(undefined)
    soundMocks.stopCallInviteRing.mockReset()
    platformMocks.adapter = null
    platformMocks.show.mockReset()
    platformMocks.show.mockResolvedValue(undefined)
    platformMocks.playSound.mockReset()
    platformMocks.playSound.mockResolvedValue(undefined)
    platformMocks.setBadge.mockReset()
    platformMocks.setBadge.mockResolvedValue(undefined)
    platformMocks.clearBadge.mockReset()
    platformMocks.clearBadge.mockResolvedValue(undefined)
    e2eeRecoveryMocks.hasLocalEncryptedDMDevice.mockReset()
    e2eeRecoveryMocks.hasLocalEncryptedDMDevice.mockReturnValue(false)
    e2eeRecoveryMocks.localEncryptedDMDeviceId.mockReset()
    e2eeRecoveryMocks.localEncryptedDMDeviceId.mockReturnValue(undefined)
    e2eeRecoveryMocks.exportEncryptedDMRecoveryPackage.mockReset()
    e2eeRecoveryMocks.prepareEncryptedDMRecoveryImport.mockReset()
    e2eeRecoveryApiMocks.activateE2EERecoveryDevice.mockReset()
    e2eeRecoveryApiMocks.activateE2EERecoveryDevice.mockResolvedValue({})
    clipboardMocks.writeText.mockReset()
    clipboardMocks.writeText.mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardMocks.writeText },
    })

    const tasksStore = useTasksStore(pinia)
    vi.spyOn(tasksStore, 'selectTask').mockImplementation(async (id: string) => {
      tasksStore.selectedTask = { id, public_id: id.toUpperCase() } as any
    })
    vi.spyOn(tasksStore, 'selectTaskByPublicId').mockImplementation(async (publicId: string) => {
      tasksStore.selectedTask = { id: `uuid-for-${publicId}`, public_id: publicId } as any
    })
    vi.spyOn(tasksStore, 'loadTaskList').mockResolvedValue()

    const documentsStore = useDocumentsStore(pinia)
    vi.spyOn(documentsStore, 'selectDocument').mockImplementation(async (id: string) => {
      documentsStore.selectedDocument = { id, teamspace_id: 'teamspace-1' } as any
    })
    vi.spyOn(documentsStore, 'clearSelectedDocument').mockImplementation(() => {
      documentsStore.selectedDocument = null
    })
    vi.spyOn(documentsStore, 'setSearchQuery')
    vi.spyOn(documentsStore, 'clearSearch')
    vi.spyOn(documentsStore, 'scheduleSearch')
    vi.spyOn(documentsStore, 'loadTeamspaces').mockResolvedValue()
    vi.spyOn(documentsStore, 'loadSidebar').mockResolvedValue()
  })

  it('shows session recovery banner while auth is degraded', async () => {
    const router = createMainRouter()
    router.push('/')
    await router.isReady()

    const authStore = useAuthStore()
    authStore.authState = 'AUTH_DEGRADED'
    authStore.lastAuthError = 'Server is unavailable'

    const wrapper = mountAtRoute(router)

    expect(wrapper.text()).toContain('Session unavailable')
    expect(wrapper.find('svg.animate-spin').exists()).toBe(true)
    expect(wrapper.text()).toContain('Retry now')
  })

  it('retries session recovery when the banner action is clicked', async () => {
    const router = createMainRouter()
    router.push('/')
    await router.isReady()

    const authStore = useAuthStore()
    authStore.authState = 'AUTH_DEGRADED'
    authStore.lastAuthError = 'Server is unavailable'

    const wrapper = mountAtRoute(router)

    await wrapper.get('[data-testid="connection-banner-retry"]').trigger('click')
    await nextTick()

    expect(orchestratorMocks.reconnectNow).toHaveBeenCalledTimes(1)
  })

  it('shows normal transport recovery and its durable queue count', async () => {
    const router = createMainRouter()
    router.push('/')
    await router.isReady()

    orchestratorMocks.isReconnecting = ref(true)
    orchestratorMocks.reconnectAttempt = ref(2)
    useOfflineQueue().enqueue({
      conversationId: 'channel-1',
      body: 'send after reconnect',
      clientMsgId: 'queued-message-1',
    })

    const wrapper = mountAtRoute(router)

    expect(wrapper.text()).toContain('Disconnected - reconnecting')
    expect(wrapper.text()).toContain('(attempt 2)')
    expect(wrapper.text()).toContain('1 message queued')

    await wrapper.get('[data-testid="connection-banner-retry"]').trigger('click')
    expect(orchestratorMocks.reconnectNow).toHaveBeenCalledTimes(1)
  })

  it('applies stored manual away preference when auth completes', async () => {
    storage.setItem('msgnr:manual-presence', 'away')
    const router = createMainRouter()
    router.push('/')
    await router.isReady()

    const wrapper = mountAtRoute(router)

    const wsStore = useWsStore()
    const sendSetPresenceSpy = vi.spyOn(wsStore, 'sendSetPresence')
    wsStore.state = 'AUTH_COMPLETE'
    await nextTick()

    expect(sendSetPresenceSpy).toHaveBeenCalledWith(PresenceStatus.AWAY)
    wrapper.unmount()
  })

  it('opens task list route when no remembered task exists', async () => {
    const router = createMainRouter()
    router.push('/')
    await router.isReady()

    const wrapper = mountAtRoute(router)

    expect(wrapper.find('[data-testid=\"chat-area\"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid=\"sidebar\"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid=\"task-tracker\"]').exists()).toBe(false)

    await (wrapper.findComponent(MainView).vm as any).goToTaskTrackerMode()
    await flushUi()

    expect(router.currentRoute.value.name).toBe('tasks-list')
    expect(wrapper.find('[data-testid=\"task-tracker\"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid=\"task-list-view\"]').exists()).toBe(true)
  })

  it('renders the collapse button for the modes rail', async () => {
    const router = createMainRouter()
    router.push('/')
    await router.isReady()

    const wrapper = mountAtRoute(router)

    expect(wrapper.find('[data-testid="mode-collapse"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="mode-collapse"]').attributes('aria-label')).toBe('Collapse sidebar')
  })

  it('applies profile color theme selection immediately', async () => {
    const router = createMainRouter()
    router.push('/')
    await router.isReady()

    const authStore = useAuthStore()
    authStore.user = {
      id: 'user-1',
      email: 'user@example.com',
      displayName: 'User One',
      avatarUrl: '',
      role: 'member',
      customStatus: null,
    }

    const wrapper = mountAtRoute(router)
    await (wrapper.findComponent(MainView).vm as any).openSettings()
    await flushUi()

    const themeTab = document.body.querySelector('[data-testid="profile-tab-theme"]') as HTMLButtonElement | null
    expect(themeTab).not.toBeNull()
    themeTab?.click()
    await flushUi()

    const pinkButton = document.body.querySelector('[data-testid="profile-theme-pink"]') as HTMLButtonElement | null
    expect(pinkButton).not.toBeNull()
    expect(document.body.querySelector('[data-testid="profile-theme-rose"]')).not.toBeNull()

    pinkButton?.click()
    await flushUi()

    expect(storage.getItem(COLOR_THEME_STORAGE_KEY)).toBe('pink')
    expect(document.documentElement.dataset.colorTheme).toBe('pink')
    expect(pinkButton?.getAttribute('aria-pressed')).toBe('true')

    wrapper.unmount()
  })

  it('keeps profile settings sections in tabs instead of one tall form', async () => {
    const router = createMainRouter()
    router.push('/')
    await router.isReady()

    const authStore = useAuthStore()
    authStore.user = {
      id: 'user-1',
      email: 'user@example.com',
      displayName: 'User One',
      avatarUrl: '',
      role: 'member',
      customStatus: null,
    }

    const wrapper = mountAtRoute(router)
    await (wrapper.findComponent(MainView).vm as any).openSettings()
    await flushUi()

    expect(document.body.querySelector('[data-testid="profile-tab-profile"]')?.getAttribute('aria-selected')).toBe('true')
    expect(document.body.textContent).toContain('Display name')
    expect(document.body.textContent).not.toContain('Change password')
    expect(document.body.querySelector('[data-testid="profile-theme-pink"]')).toBeNull()

    const passwordTab = document.body.querySelector('[data-testid="profile-tab-password"]') as HTMLButtonElement | null
    passwordTab?.click()
    await flushUi()

    expect(passwordTab?.getAttribute('aria-selected')).toBe('true')
    expect(document.body.textContent).toContain('Change password')
    expect(document.body.textContent).not.toContain('Display name')

    wrapper.unmount()
  })

  it('exports and restores encrypted-DM recovery packages without sending private key material', async () => {
    const router = createMainRouter()
    router.push('/')
    await router.isReady()

    const authStore = useAuthStore()
    authStore.user = {
      id: 'user-1',
      email: 'user@example.com',
      displayName: 'User One',
      avatarUrl: '',
      role: 'member',
      customStatus: null,
    }
    const publicRegistration = {
      device_id: 'recovered-device',
      device_label: 'Recovered browser',
      identity_key_public: 'public-identity',
      signed_prekey_id: 1,
      signed_prekey_public: 'public-prekey',
      signed_prekey_signature: 'public-signature',
    }
    const install = vi.fn()
    e2eeRecoveryMocks.hasLocalEncryptedDMDevice.mockReturnValue(true)
    e2eeRecoveryMocks.localEncryptedDMDeviceId.mockReturnValue('temporary-device')
    e2eeRecoveryMocks.exportEncryptedDMRecoveryPackage.mockResolvedValue('MSGE2E-R1.exported-package')
    e2eeRecoveryMocks.prepareEncryptedDMRecoveryImport.mockResolvedValue({
      deviceId: 'recovered-device',
      registration: publicRegistration,
      install,
    })
    const chatStore = useChatStore()
    const reloadHistory = vi.spyOn(chatStore, 'reloadActiveEncryptedDMHistory').mockResolvedValue(undefined)

    const wrapper = mountAtRoute(router)
    await (wrapper.findComponent(MainView).vm as any).openSettings()
    await flushUi()
    ;(document.body.querySelector('[data-testid="profile-tab-security"]') as HTMLButtonElement).click()
    await flushUi()

    const exportPassphrase = document.body.querySelector('[data-testid="e2ee-recovery-export-passphrase"]') as HTMLInputElement
    const exportConfirmation = document.body.querySelector('[data-testid="e2ee-recovery-export-passphrase-confirmation"]') as HTMLInputElement
    exportPassphrase.value = 'recovery passphrase'
    exportPassphrase.dispatchEvent(new Event('input'))
    exportConfirmation.value = 'recovery passphrase'
    exportConfirmation.dispatchEvent(new Event('input'))
    await flushUi()
    ;(document.body.querySelector('[data-testid="e2ee-recovery-create"]') as HTMLButtonElement).click()
    await flushUi()

    expect(e2eeRecoveryMocks.exportEncryptedDMRecoveryPackage).toHaveBeenCalledWith('recovery passphrase')
    const exportedPackage = document.body.querySelector('[data-testid="e2ee-recovery-export-package"]') as HTMLTextAreaElement
    expect(exportedPackage.value).toBe('MSGE2E-R1.exported-package')
    expect(exportPassphrase.value).toBe('')
    expect(exportConfirmation.value).toBe('')

    clipboardMocks.writeText.mockRejectedValueOnce(new Error('clipboard unavailable'))
    ;(document.body.querySelector('[data-testid="e2ee-recovery-copy"]') as HTMLButtonElement).click()
    await flushUi()
    expect(document.body.textContent).toContain('Clipboard access is unavailable')
    expect(exportedPackage.value).toBe('MSGE2E-R1.exported-package')

    const importPackage = document.body.querySelector('[data-testid="e2ee-recovery-import-package"]') as HTMLTextAreaElement
    const importPassphrase = document.body.querySelector('[data-testid="e2ee-recovery-import-passphrase"]') as HTMLInputElement
    importPackage.value = 'MSGE2E-R1.imported-package'
    importPackage.dispatchEvent(new Event('input'))
    importPassphrase.value = 'recovery passphrase'
    importPassphrase.dispatchEvent(new Event('input'))
    await flushUi()
    ;(document.body.querySelector('[data-testid="e2ee-recovery-restore"]') as HTMLButtonElement).click()
    await flushUi()

    expect(e2eeRecoveryApiMocks.activateE2EERecoveryDevice).not.toHaveBeenCalled()
    const replaceConfirmation = document.body.querySelector('[data-testid="e2ee-recovery-replace-confirmation"]') as HTMLInputElement
    expect(replaceConfirmation).not.toBeNull()
    replaceConfirmation.checked = true
    replaceConfirmation.dispatchEvent(new Event('change'))
    await flushUi()
    ;(document.body.querySelector('[data-testid="e2ee-recovery-restore"]') as HTMLButtonElement).click()
    await flushUi()

    expect(e2eeRecoveryApiMocks.activateE2EERecoveryDevice).toHaveBeenCalledWith({
      ...publicRegistration,
      replace_device_id: 'temporary-device',
    })
    const activationPayload = e2eeRecoveryApiMocks.activateE2EERecoveryDevice.mock.calls[0][0]
    expect(JSON.stringify(activationPayload)).not.toContain('privateKeyJwk')
    expect(install).toHaveBeenCalledTimes(1)
    expect(reloadHistory).toHaveBeenCalledTimes(1)
    expect(importPackage.value).toBe('')
    expect(importPassphrase.value).toBe('')
    expect(document.body.textContent).toContain('Encrypted-DM recovery completed.')

    wrapper.unmount()
  })

  it('toggles the chat sidebar from the collapse button', async () => {
    const router = createMainRouter()
    router.push('/')
    await router.isReady()

    const wrapper = mountAtRoute(router)

    expect(wrapper.find('[data-testid="sidebar"]').exists()).toBe(true)

    await wrapper.get('[data-testid="mode-collapse"]').trigger('click')
    await flushUi()

    expect(wrapper.find('[data-testid="sidebar"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="mode-collapse"]').attributes('aria-label')).toBe('Expand sidebar')

    await wrapper.get('[data-testid="mode-collapse"]').trigger('click')
    await flushUi()

    expect(wrapper.find('[data-testid="sidebar"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="mode-collapse"]').attributes('aria-label')).toBe('Collapse sidebar')
  })

  it('restores persisted collapsed sidebar state on mount', async () => {
    storage.setItem('msgnr:sidebar-collapsed:v1', 'true')
    const router = createMainRouter()
    router.push('/')
    await router.isReady()

    const wrapper = mountAtRoute(router)
    await flushUi()

    expect(wrapper.find('[data-testid="sidebar"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="mode-collapse"]').attributes('aria-label')).toBe('Expand sidebar')
  })

  it('opens the notified conversation from a service worker message without reloading the app shell', async () => {
    const router = createMainRouter()
    router.push('/tasks')
    await router.isReady()

    const authStore = useAuthStore()
    authStore.authState = 'AUTHENTICATED'
    const wsStore = useWsStore()
    wsStore.state = 'LIVE_SYNCED'
    const chatStore = useChatStore()
    chatStore.bootstrapped = true
    chatStore.directMessages = [{
      id: 'dm-1',
      userId: 'user-2',
      displayName: 'Bob',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }] as any
    const requestConversationComposerFocusSpy = vi.spyOn(chatStore, 'requestConversationComposerFocus')
    vi.spyOn(chatStore, 'selectChannel').mockImplementation(async (conversationId: string) => {
      chatStore.activeChannelId = conversationId
    })

    mountAtRoute(router)
    await flushUi()

    serviceWorkerContainerMock.dispatchMessage(toNotificationOpenMessage({
      conversationId: 'dm-1',
      messageId: 'msg-1',
      url: '/',
    }))
    await flushAsyncWork()

    expect(router.currentRoute.value.name).toBe('main')
    expect(chatStore.activeChannelId).toBe('dm-1')
    expect(requestConversationComposerFocusSpy).toHaveBeenCalled()
  })

  it('shows a local notification and plays sound for active-window hidden targets', async () => {
    platformMocks.adapter = {
      type: 'pwa',
      notifications: {
        show: platformMocks.show,
        playSound: platformMocks.playSound,
        setBadge: platformMocks.setBadge,
        clearBadge: platformMocks.clearBadge,
      },
    }
    const router = createMainRouter()
    router.push('/')
    await router.isReady()

    const chatStore = useChatStore()
    chatStore.setClientActive(true)
    chatStore.bootstrapped = true
    chatStore.chatViewMode = 'conversation' as any
    chatStore.activeChannelId = 'channel-2'
    chatStore.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }, {
      id: 'channel-2',
      name: 'random',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }] as any

    mountAtRoute(router)
    await flushUi()

    chatStore.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 1n,
      eventId: 'evt-hidden-target-main-1',
      eventType: EventType.MESSAGE_ALERT,
      conversationId: 'channel-1',
      payload: {
        case: 'messageAlert',
        value: create(MessageAlertEventSchema, {
          conversationId: 'channel-1',
          messageId: 'message-hidden-target-main-1',
          senderId: 'user-2',
          senderName: 'Bob',
          body: 'hidden hello',
          threadRootMessageId: '',
          attachmentCount: 0,
        }),
      },
    }))
    await flushUi()

    expect(platformMocks.show).toHaveBeenCalledWith(expect.objectContaining({
      body: 'Bob: hidden hello',
      conversationId: 'channel-1',
      tag: 'conv:channel-1',
    }))
    expect(soundMocks.playMessagePing).toHaveBeenCalledTimes(1)
  })

  it('does not play sound for active visible message targets', async () => {
    platformMocks.adapter = {
      type: 'pwa',
      notifications: {
        show: platformMocks.show,
        playSound: platformMocks.playSound,
        setBadge: platformMocks.setBadge,
        clearBadge: platformMocks.clearBadge,
      },
    }
    const router = createMainRouter()
    router.push('/')
    await router.isReady()

    const chatStore = useChatStore()
    chatStore.setClientActive(true)
    chatStore.bootstrapped = true
    chatStore.chatViewMode = 'conversation' as any
    chatStore.activeChannelId = 'channel-1'
    chatStore.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }] as any

    mountAtRoute(router)
    await flushUi()

    chatStore.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 1n,
      eventId: 'evt-visible-target-main-1',
      eventType: EventType.MESSAGE_ALERT,
      conversationId: 'channel-1',
      payload: {
        case: 'messageAlert',
        value: create(MessageAlertEventSchema, {
          conversationId: 'channel-1',
          messageId: 'message-visible-target-main-1',
          senderId: 'user-2',
          senderName: 'Bob',
          body: 'visible hello',
          threadRootMessageId: '',
          attachmentCount: 0,
        }),
      },
    }))
    await flushUi()

    expect(platformMocks.show).not.toHaveBeenCalled()
    expect(soundMocks.playMessagePing).not.toHaveBeenCalled()
  })

  it('consumes cold-start notification query params after bootstrap and clears them', async () => {
    const router = createMainRouter()
    router.push({ path: '/', query: { notificationOpen: '1', conversationId: 'dm-1', messageId: 'msg-1' } })
    await router.isReady()

    const authStore = useAuthStore()
    authStore.authState = 'AUTHENTICATED'
    const wsStore = useWsStore()
    wsStore.state = 'LIVE_SYNCED'
    const chatStore = useChatStore()
    chatStore.bootstrapped = true
    chatStore.directMessages = [{
      id: 'dm-1',
      userId: 'user-2',
      displayName: 'Bob',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }] as any
    vi.spyOn(chatStore, 'selectChannel').mockImplementation(async (conversationId: string) => {
      chatStore.activeChannelId = conversationId
    })

    mountAtRoute(router)
    await flushAsyncWork()

    expect(chatStore.activeChannelId).toBe('dm-1')
    expect(router.currentRoute.value.query.notificationOpen).toBeUndefined()
    expect(router.currentRoute.value.query.conversationId).toBeUndefined()
    expect(router.currentRoute.value.query.messageId).toBeUndefined()
  })

  it('defers cold-start notification open until chat bootstrap is live', async () => {
    const router = createMainRouter()
    router.push({ path: '/', query: { notificationOpen: '1', conversationId: 'dm-1' } })
    await router.isReady()

    const authStore = useAuthStore()
    authStore.authState = 'AUTHENTICATED'
    const wsStore = useWsStore()
    wsStore.state = 'BOOTSTRAPPING'
    const chatStore = useChatStore()
    chatStore.bootstrapped = false
    const selectChannelSpy = vi.spyOn(chatStore, 'selectChannel').mockImplementation(async (conversationId: string) => {
      chatStore.activeChannelId = conversationId
    })

    mountAtRoute(router)
    await flushUi()

    expect(selectChannelSpy).not.toHaveBeenCalled()
    expect(chatStore.activeChannelId).toBe('')

    chatStore.directMessages = [{
      id: 'dm-1',
      userId: 'user-2',
      displayName: 'Bob',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }] as any
    chatStore.bootstrapped = true
    wsStore.state = 'LIVE_SYNCED'
    await flushAsyncWork()

    expect(chatStore.activeChannelId).toBe('dm-1')
    expect(router.currentRoute.value.query.notificationOpen).toBeUndefined()
  })

  it('hides chat mode unread badge while chat mode is active', async () => {
    const router = createMainRouter()
    router.push('/')
    await router.isReady()

    const chatStore = useChatStore()
    chatStore.channels = [{
      id: 'channel-1',
      name: 'General',
      kind: 'channel',
      visibility: 'public',
      unread: 4,
      notificationLevel: NotificationLevel.ALL,
    }] as any

    const wrapper = mountAtRoute(router)
    await flushUi()

    expect(wrapper.find('[data-testid="mode-chat-unread-badge"]').exists()).toBe(false)
  })

  it('shows chat mode unread badge in task tracker mode when unread exists', async () => {
    const router = createMainRouter()
    router.push('/tasks')
    await router.isReady()

    const chatStore = useChatStore()
    chatStore.unreadFeedTotalCount = 7 as any

    const wrapper = mountAtRoute(router)
    await flushUi()

    const badge = wrapper.find('[data-testid="mode-chat-unread-badge"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('7')
  })

  it('caps chat mode unread badge text at 99+', async () => {
    const router = createMainRouter()
    router.push('/tasks')
    await router.isReady()

    const chatStore = useChatStore()
    chatStore.unreadFeedTotalCount = 120 as any

    const wrapper = mountAtRoute(router)
    await flushUi()

    const badge = wrapper.find('[data-testid="mode-chat-unread-badge"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('99+')
  })

  it('does not render chat mode unread badge in task tracker mode when unread is zero', async () => {
    const router = createMainRouter()
    router.push('/tasks')
    await router.isReady()

    const chatStore = useChatStore()
    chatStore.channels = [{
      id: 'channel-1',
      name: 'General',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }] as any

    const wrapper = mountAtRoute(router)
    await flushUi()

    expect(wrapper.find('[data-testid="mode-chat-unread-badge"]').exists()).toBe(false)
  })

  it('opens remembered task route when task tracker button is clicked', async () => {
    taskRouteStorageMocks.loadLastOpenedTaskPublicId.mockReturnValue('TASK-REMEMBERED')
    const router = createMainRouter()
    router.push('/')
    await router.isReady()

    const wrapper = mountAtRoute(router)

    await (wrapper.findComponent(MainView).vm as any).goToTaskTrackerMode()
    await flushUi()

    expect(router.currentRoute.value.name).toBe('tasks-card')
    expect(router.currentRoute.value.params.taskSlug).toBe('task-remembered')
    expect(wrapper.find('[data-testid=\"task-card\"]').exists()).toBe(true)
  })

  it('opens task tracker mode with its sidebar when selected from collapsed chat', async () => {
    const router = createMainRouter()
    router.push('/')
    await router.isReady()

    const wrapper = mountAtRoute(router)

    await wrapper.get('[data-testid="mode-collapse"]').trigger('click')
    await flushUi()
    expect(wrapper.find('[data-testid="sidebar"]').exists()).toBe(false)

    await wrapper.get('[data-testid="mode-task-tracker"]').trigger('click')
    await flushAsyncWork()

    expect(router.currentRoute.value.name).toBe('tasks-list')
    expect(wrapper.find('[data-testid="task-tracker"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="task-tracker-sidebar"]').exists()).toBe(true)
  })

  it('opens documents route when documents button is clicked', async () => {
    const router = createMainRouter()
    router.push('/')
    await router.isReady()

    const wrapper = mountAtRoute(router)

    await (wrapper.findComponent(MainView).vm as any).goToDocumentsMode()
    await flushUi()

    expect(router.currentRoute.value.name).toBe('documents-teamspaces')
    expect(wrapper.find('[data-testid="documents-mode"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="documents-sidebar"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="teamspaces-view"]').exists()).toBe(true)
  })

  it('restores the open document when returning from chat in the same session', async () => {
    const router = createMainRouter()
    router.push('/documents/document-123')
    await router.isReady()

    const wrapper = mountAtRoute(router)
    await flushAsyncWork()

    await (wrapper.findComponent(MainView).vm as any).goToChatMode()
    await flushAsyncWork()
    expect(router.currentRoute.value.name).toBe('main')

    await (wrapper.findComponent(MainView).vm as any).goToDocumentsMode()
    await flushAsyncWork()

    expect(router.currentRoute.value.name).toBe('documents-card')
    expect(router.currentRoute.value.params.documentId).toBe('document-123')
    expect(wrapper.find('[data-testid="document-card"]').exists()).toBe(true)
  })

  it('opens documents mode with its sidebar when selected from collapsed chat', async () => {
    const router = createMainRouter()
    router.push('/')
    await router.isReady()

    const wrapper = mountAtRoute(router)

    await wrapper.get('[data-testid="mode-collapse"]').trigger('click')
    await flushUi()
    expect(wrapper.find('[data-testid="sidebar"]').exists()).toBe(false)

    await wrapper.get('[data-testid="mode-documents"]').trigger('click')
    await flushAsyncWork()

    expect(router.currentRoute.value.name).toBe('documents-teamspaces')
    expect(wrapper.find('[data-testid="documents-mode"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="documents-sidebar"]').exists()).toBe(true)
  })

  it('opens the Dayoffs route when the Dayoffs rail button is clicked', async () => {
    const router = createMainRouter()
    router.push('/')
    await router.isReady()

    const wrapper = mountAtRoute(router)

    await wrapper.get('[data-testid="mode-dayoffs"]').trigger('click')
    await flushAsyncWork()

    expect(router.currentRoute.value.name).toBe('dayoffs')
    expect(wrapper.find('[data-testid="dayoffs-mode"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="mode-dayoffs"]').classes()).toContain('bg-sidebar-active')
  })

  it('toggles the Dayoffs sidebar from the collapse button', async () => {
    const router = createMainRouter()
    router.push('/dayoffs')
    await router.isReady()

    const wrapper = mountAtRoute(router)
    await flushUi()

    expect(wrapper.find('[data-testid="dayoffs-sidebar"]').exists()).toBe(true)

    await wrapper.get('[data-testid="mode-collapse"]').trigger('click')
    await flushUi()

    expect(wrapper.find('[data-testid="dayoffs-sidebar"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="mode-collapse"]').attributes('aria-label')).toBe('Expand sidebar')

    await wrapper.get('[data-testid="mode-collapse"]').trigger('click')
    await flushUi()

    expect(wrapper.find('[data-testid="dayoffs-sidebar"]').exists()).toBe(true)
  })

  it('reopens the active mode sidebar without changing the current sub-route', async () => {
    const router = createMainRouter()
    router.push('/tasks/kanban')
    await router.isReady()

    const wrapper = mountAtRoute(router)
    await flushUi()

    await wrapper.get('[data-testid="mode-collapse"]').trigger('click')
    await flushUi()

    expect(wrapper.find('[data-testid="task-tracker-sidebar"]').exists()).toBe(false)
    expect(router.currentRoute.value.name).toBe('tasks-kanban')

    await wrapper.get('[data-testid="mode-task-tracker"]').trigger('click')
    await flushUi()

    expect(router.currentRoute.value.name).toBe('tasks-kanban')
    expect(wrapper.find('[data-testid="task-tracker-sidebar"]').exists()).toBe(true)
  })

  it('navigates to documents search and schedules loading when typing a query', async () => {
    const router = createMainRouter()
    router.push('/documents')
    await router.isReady()

    const wrapper = mountAtRoute(router)
    await flushUi()

    const documentsStore = useDocumentsStore(pinia)
    await (wrapper.findComponent(MainView).vm as any).handleDocumentsSearchQueryChange('spec')
    await flushAsyncWork()

    expect(router.currentRoute.value.name).toBe('documents-search')
    expect(router.currentRoute.value.query.q).toBe('spec')
    expect(documentsStore.setSearchQuery).toHaveBeenCalledWith('spec')
    expect(documentsStore.scheduleSearch).toHaveBeenCalledWith('spec')
  })

  it('clearing search returns to the prior documents browse route', async () => {
    const router = createMainRouter()
    router.push('/documents/teamspaces/teamspace-1')
    await router.isReady()

    const wrapper = mountAtRoute(router)
    await flushUi()

    await (wrapper.findComponent(MainView).vm as any).handleDocumentsSearchQueryChange('spec')
    await flushAsyncWork()
    expect(router.currentRoute.value.name).toBe('documents-search')

    await (wrapper.findComponent(MainView).vm as any).handleDocumentsSearchQueryChange('')
    await flushAsyncWork()

    const documentsStore = useDocumentsStore(pinia)
    expect(router.currentRoute.value.name).toBe('documents-teamspace')
    expect(router.currentRoute.value.params.teamspaceId).toBe('teamspace-1')
    expect(documentsStore.clearSearch).toHaveBeenCalled()
  })

  it('returns to search results after backing out of a document opened from search', async () => {
    const router = createMainRouter()
    router.push({ name: 'documents-search', query: { q: 'spec' } })
    await router.isReady()

    const wrapper = mountAtRoute(router)
    await flushUi()

    expect(wrapper.find('[data-testid="documents-search-view"]').exists()).toBe(true)

    await (wrapper.findComponent(MainView).vm as any).openDocument('search-doc-1')
    await flushAsyncWork()
    expect(router.currentRoute.value.name).toBe('documents-card')

    await (wrapper.findComponent(MainView).vm as any).backToDocuments()
    await flushAsyncWork()

    expect(router.currentRoute.value.name).toBe('documents-search')
    expect(router.currentRoute.value.query.q).toBe('spec')
  })

  it('clears search state and skips scheduling on direct empty search route entry', async () => {
    const router = createMainRouter()
    router.push({ name: 'documents-search', query: { q: '' } })
    await router.isReady()

    mountAtRoute(router)
    await flushAsyncWork()

    const documentsStore = useDocumentsStore(pinia)
    expect(router.currentRoute.value.name).toBe('documents-search')
    expect(documentsStore.clearSearch).toHaveBeenCalled()
    expect(documentsStore.scheduleSearch).not.toHaveBeenCalled()
  })

  it('returns to the documents browser from a teamspace route', async () => {
    const router = createMainRouter()
    router.push('/documents/teamspaces/teamspace-1')
    await router.isReady()

    const wrapper = mountAtRoute(router)
    await flushUi()

    const documentsStore = useDocumentsStore(pinia)
    await router.push({ name: 'documents-teamspaces' })
    await flushUi()

    expect(router.currentRoute.value.name).toBe('documents-teamspaces')
    expect(documentsStore.selectedDocument).toBeNull()
  })

  it('keeps documents card mode and loads document on direct /documents/:documentId entry', async () => {
    const router = createMainRouter()
    const documentsStore = useDocumentsStore(pinia)
    const selectDocumentSpy = vi.spyOn(documentsStore, 'selectDocument')
    router.push('/documents/document-123')
    await router.isReady()

    const wrapper = mountAtRoute(router)
    await flushUi()

    expect(router.currentRoute.value.name).toBe('documents-card')
    expect(wrapper.find('[data-testid="document-card"]').exists()).toBe(true)
    expect(selectDocumentSpy).toHaveBeenCalledWith('document-123', true)
  })

  it('returns from a deleted document without forcing a sidebar reload', async () => {
    const router = createMainRouter()
    router.push('/documents/doc-1')
    await router.isReady()

    const wrapper = mountAtRoute(router)
    await flushAsyncWork()

    const documentsStore = useDocumentsStore(pinia)
    const loadSidebarSpy = vi.spyOn(documentsStore, 'loadSidebar')
    loadSidebarSpy.mockClear()

    await (wrapper.findComponent(MainView).vm as any).handleDocumentsDeleted(['doc-1'])
    await flushAsyncWork()

    expect(router.currentRoute.value.name).toBe('documents-teamspaces')
    expect(documentsStore.clearSelectedDocument).toHaveBeenCalled()
    expect(loadSidebarSpy).not.toHaveBeenCalledWith(true)
  })

  it('keeps task card mode and loads task on direct /tasks/:taskSlug entry', async () => {
    const router = createMainRouter()
    const tasksStore = useTasksStore(pinia)
    const selectTaskByPublicIdSpy = vi.spyOn(tasksStore, 'selectTaskByPublicId')
    router.push('/tasks/dev-123')
    await router.isReady()

    const wrapper = mountAtRoute(router)
    await flushUi()

    expect(router.currentRoute.value.name).toBe('tasks-card')
    expect(wrapper.find('[data-testid=\"task-card\"]').exists()).toBe(true)
    expect(selectTaskByPublicIdSpy).toHaveBeenCalledWith('DEV-123', true)
  })

  it('normalizes mixed-case task slugs to lowercase', async () => {
    const router = createMainRouter()
    router.push('/tasks/DEV-123')
    await router.isReady()

    mountAtRoute(router)
    await flushUi()
    await flushUi()

    expect(router.currentRoute.value.name).toBe('tasks-card')
    expect(router.currentRoute.value.params.taskSlug).toBe('dev-123')
  })

  it('falls back to the list for legacy UUID task routes', async () => {
    const router = createMainRouter()
    const tasksStore = useTasksStore(pinia)
    const selectTaskByPublicIdSpy = vi.spyOn(tasksStore, 'selectTaskByPublicId')
    router.push('/tasks/92f41023-40a9-42f7-a124-38d426e061ba')
    await router.isReady()

    mountAtRoute(router)
    await flushUi()
    await flushUi()

    expect(router.currentRoute.value.name).toBe('tasks-list')
    expect(selectTaskByPublicIdSpy).not.toHaveBeenCalled()
  })

  it('ignores remembered legacy UUID task routes', async () => {
    taskRouteStorageMocks.loadLastOpenedTaskPublicId.mockReturnValue('')
    const router = createMainRouter()
    router.push('/')
    await router.isReady()

    const wrapper = mountAtRoute(router)

    await (wrapper.findComponent(MainView).vm as any).goToTaskTrackerMode()
    await flushUi()

    expect(router.currentRoute.value.name).toBe('tasks-list')
  })

  it('accepts incoming invites by joining existing call without create-call step', async () => {
    const router = createMainRouter()
    router.push('/')
    await router.isReady()

    const chatStore = useChatStore()
    const wsStore = useWsStore()
    const callStore = useCallStore()
    const startOrJoinSpy = vi.spyOn(callStore, 'startOrJoinCall').mockResolvedValue()
    const acceptInviteSpy = vi.spyOn(wsStore, 'requestAcceptCallInvite').mockResolvedValue({
      ok: true,
      inviteId: 'invite-1',
      resultingState: 2,
      applied: true,
    } as any)
    chatStore.pendingInvites = [{
      id: 'invite-1',
      callId: 'call-1',
      conversationId: 'external-conversation-1',
      inviterUserId: 'user-2',
      state: 'created',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    }]

    const wrapper = mountAtRoute(router)
    await flushUi()

    const acceptButton = wrapper.findAll('button').find(btn => btn.text().includes('Accept'))
    expect(acceptButton).toBeDefined()
    await acceptButton!.trigger('click')
    await flushUi()

    expect(acceptInviteSpy).toHaveBeenCalledWith('invite-1', { leaveExistingCalls: true })
    expect(startOrJoinSpy).toHaveBeenCalledWith({
      conversationId: 'external-conversation-1',
      kind: 'channel',
      visibility: 'public',
      joinExistingOnly: true,
    })
  })

  it('navigates back to /tasks when card emits back', async () => {
    const router = createMainRouter()
    router.push('/tasks/task-555')
    await router.isReady()

    const wrapper = mountAtRoute(router)
    await flushUi()

    await (wrapper.findComponent(MainView).vm as any).backToList()
    await flushUi()

    expect(router.currentRoute.value.name).toBe('tasks-list')
  })

  it('returns to kanban after opening card from kanban route', async () => {
    const router = createMainRouter()
    router.push('/tasks/kanban')
    await router.isReady()

    const wrapper = mountAtRoute(router)
    await flushUi()

    expect(wrapper.find('[data-testid="task-kanban-view"]').exists()).toBe(true)

    await (wrapper.findComponent(MainView).vm as any).openTask('TASK-K')
    await flushUi()
    expect(router.currentRoute.value.name).toBe('tasks-card')
    expect(router.currentRoute.value.params.taskSlug).toBe('task-k')

    await (wrapper.findComponent(MainView).vm as any).backToList()
    await flushUi()

    expect(router.currentRoute.value.name).toBe('tasks-kanban')
  })

  it('renders unread feed in chat mode and opens exact targets from unread items', async () => {
    const router = createMainRouter()
    router.push('/')
    await router.isReady()

    const authStore = useAuthStore()
    authStore.authState = 'AUTHENTICATED'
    const wsStore = useWsStore()
    wsStore.state = 'LIVE_SYNCED'
    const chatStore = useChatStore()
    chatStore.bootstrapped = true
    chatStore.chatViewMode = 'unread' as any
    chatStore.directMessages = [{
      id: 'dm-1',
      userId: 'user-2',
      displayName: 'Bob',
      unread: 2,
      notificationLevel: NotificationLevel.ALL,
    }] as any
    chatStore.messages = {
      'dm-1': [{
        id: 'root-1',
        channelId: 'dm-1',
        senderId: 'user-2',
        senderName: 'Bob',
        body: 'root',
        channelSeq: 1n,
        threadSeq: 0n,
        mentionedUserIds: [],
        mentionEveryone: false,
        createdAt: new Date().toISOString(),
        reactions: [],
        myReactions: [],
      }],
    } as any
    chatStore.unreadFeedItems = [
      {
        id: 'thread:notif-1',
        kind: 'thread',
        notificationId: 'notif-1',
        conversationId: 'dm-1',
        conversationKind: 'dm',
        conversationVisibility: 'dm',
        conversationTitle: 'Bob',
        messageId: 'msg-1',
        threadRootMessageId: 'root-1',
        senderName: 'Bob',
        body: 'reply 1',
        createdAt: '2026-03-06T00:01:00Z',
      },
      {
        id: 'thread:notif-2',
        kind: 'thread',
        notificationId: 'notif-2',
        conversationId: 'dm-1',
        conversationKind: 'dm',
        conversationVisibility: 'dm',
        conversationTitle: 'Bob',
        messageId: 'msg-2',
        threadRootMessageId: 'root-1',
        senderName: 'Bob',
        body: 'reply 2',
        createdAt: '2026-03-06T00:02:00Z',
      },
      {
        id: 'message:root-1',
        kind: 'message',
        conversationId: 'dm-1',
        conversationKind: 'dm',
        conversationVisibility: 'dm',
        conversationTitle: 'Bob',
        messageId: 'root-1',
        senderName: 'Bob',
        body: 'root',
        createdAt: '2026-03-06T00:00:00Z',
      },
      {
        id: 'thread:notif-3',
        kind: 'thread',
        notificationId: 'notif-3',
        conversationId: 'dm-1',
        conversationKind: 'dm',
        conversationVisibility: 'dm',
        conversationTitle: 'Bob',
        messageId: 'msg-3',
        threadRootMessageId: 'root-2',
        senderName: 'Eve',
        body: 'other thread',
        createdAt: '2026-03-06T00:03:00Z',
      },
    ] as any
    chatStore.notifications = [
      {
        id: 'notif-1',
        type: 'thread_reply',
        title: 'Reply',
        body: 'reply 1',
        conversationId: 'dm-1',
        isRead: false,
        createdAt: '2026-03-06T00:01:00Z',
      },
      {
        id: 'notif-2',
        type: 'thread_reply',
        title: 'Reply',
        body: 'reply 2',
        conversationId: 'dm-1',
        isRead: false,
        createdAt: '2026-03-06T00:02:00Z',
      },
      {
        id: 'notif-3',
        type: 'thread_reply',
        title: 'Reply',
        body: 'other thread',
        conversationId: 'dm-1',
        isRead: false,
        createdAt: '2026-03-06T00:03:00Z',
      },
    ] as any
    chatStore.unreadFeedTotalCount = 4
    vi.spyOn(chatStore, 'ensureConversationHistory').mockResolvedValue(undefined)
    vi.spyOn(chatStore, 'loadMessageContext').mockResolvedValue('loaded')
    vi.spyOn(chatApi, 'resolveUnreadFeedNotification').mockResolvedValue(undefined)
    const pinnedStore = usePinnedDialogsStore()

    const wrapper = mountAtRoute(router)
    await flushUi()

    expect(wrapper.find('[data-testid="unread-feed"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="chat-area"]').exists()).toBe(false)

    await wrapper.get('[data-testid="unread-feed-open"]').trigger('click')
    await flushAsyncWork()

    expect(chatStore.activeChannelId).toBe('dm-1')
    expect(chatStore.chatViewMode).toBe('conversation')
    expect(chatStore.focusedMessageId).toBe('root-1')
    expect(chatStore.focusedThreadMessageId).toBe('')
    expect(pinnedStore.activeId).toBe('thread:dm-1:root-1')
    expect(pinnedStore.items.map(item => item.id)).toEqual(['thread:dm-1:root-1'])
    expect(chatStore.unreadFeedItems.map(item => item.id)).toEqual(['thread:notif-3'])
    expect(chatStore.unreadFeedTotalCount).toBe(1)
    expect(chatStore.notifications.map(notification => notification.id)).toEqual(['notif-3'])
    expect(chatApi.resolveUnreadFeedNotification).toHaveBeenCalledTimes(2)
    expect(chatApi.resolveUnreadFeedNotification).toHaveBeenCalledWith('notif-1')
    expect(chatApi.resolveUnreadFeedNotification).toHaveBeenCalledWith('notif-2')
  })

  it('opens global message search from the sidebar and keyboard shortcut', async () => {
    const router = createMainRouter()
    router.push('/')
    await router.isReady()
    const chatStore = useChatStore()
    chatStore.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chatStore.activeChannelId = 'channel-1'

    const wrapper = mountAtRoute(router)
    await flushUi()

    await wrapper.get('[data-testid="sidebar-search-button"]').trigger('click')
    await flushUi()
    expect(wrapper.get('[data-testid="message-search-dialog"]').attributes('data-scope')).toBe('global')

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
    await flushUi()
    expect(wrapper.get('[data-testid="message-search-dialog"]').attributes('data-scope')).toBe('global')
  })

  it('opens conversation-scoped message search from the chat header', async () => {
    const router = createMainRouter()
    router.push('/')
    await router.isReady()
    const chatStore = useChatStore()
    chatStore.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chatStore.activeChannelId = 'channel-1'

    const wrapper = mountAtRoute(router)
    await flushUi()

    await wrapper.get('[data-testid="conversation-search-button"]').trigger('click')
    await flushUi()

    const dialog = wrapper.get('[data-testid="message-search-dialog"]')
    expect(dialog.attributes('data-scope')).toBe('conversation')
    expect(dialog.attributes('data-conversation-id')).toBe('channel-1')
    expect(dialog.attributes('data-conversation-title')).toBe('#general')
  })

  it('opens message search chat and task-thread results', async () => {
    const router = createMainRouter()
    router.push('/')
    await router.isReady()
    const chatStore = useChatStore()
    chatStore.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chatStore.activeChannelId = 'channel-1'
    chatStore.messages = {
      'channel-1': [{
        id: 'msg-1',
        channelId: 'channel-1',
        senderId: 'user-2',
        senderName: 'Bob',
        body: 'needle',
        channelSeq: 1n,
        threadSeq: 0n,
        mentionedUserIds: [],
        mentionEveryone: false,
        createdAt: '2026-05-12T00:00:00Z',
        reactions: [],
        myReactions: [],
      }],
    } as any
    vi.spyOn(chatStore, 'ensureConversationHistory').mockResolvedValue(undefined)
    const pinnedStore = usePinnedDialogsStore()

    const wrapper = mountAtRoute(router)
    await flushUi()
    await wrapper.get('[data-testid="sidebar-search-button"]').trigger('click')
    await flushUi()
    await wrapper.get('[data-testid="message-search-open-chat"]').trigger('click')
    await flushAsyncWork()

    expect(chatStore.chatViewMode).toBe('conversation')
    expect(chatStore.focusedMessageId).toBe('msg-1')

    await wrapper.get('[data-testid="sidebar-search-button"]').trigger('click')
    await flushUi()
    await wrapper.get('[data-testid="message-search-open-task-thread"]').trigger('click')
    await flushAsyncWork()

    expect(router.currentRoute.value.name).toBe('tasks-card')
    expect(router.currentRoute.value.query.comment).toBe('comment-1')
    expect(taskRouteStorageMocks.saveLastOpenedTaskPublicId).toHaveBeenCalledWith('TASK-1')
    expect(chatStore.focusedThreadMessageId).toBe('reply-1')
    expect(pinnedStore.activeId).toBe('thread:hidden-conv-1:root-1')
    expect(pinnedStore.activeItem?.title).toBe('Task TASK-1')
  })

  it('does not pin a task thread search result when task navigation details are missing', async () => {
    const router = createMainRouter()
    router.push('/')
    await router.isReady()
    const chatStore = useChatStore()
    const pinnedStore = usePinnedDialogsStore()
    const showToastSpy = vi.spyOn(chatStore, 'showToast').mockImplementation(() => {})

    const wrapper = mountAtRoute(router)
    await flushUi()
    await wrapper.get('[data-testid="sidebar-search-button"]').trigger('click')
    await flushUi()
    await wrapper.get('[data-testid="message-search-open-broken-task-thread"]').trigger('click')
    await flushAsyncWork()

    expect(showToastSpy).toHaveBeenCalledWith('Search result is missing task details.')
    expect(router.currentRoute.value.name).toBe('main')
    expect(chatStore.focusedThreadMessageId).toBe('')
    expect(pinnedStore.activeId).toBeNull()
  })
})
