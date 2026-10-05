// Temporary visual harness: mounts the real chat surface with seeded store
// state so the redesign can be reviewed without a backend. Reachable only via
// /preview-chat.html in the dev server; delete when done reviewing.
import { createApp, h } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import AppSidebar from './components/AppSidebar.vue'
import ChatArea from './components/ChatArea.vue'
import { applyStoredColorTheme, setColorTheme } from './composables/useColorTheme'
import type { ThemeId } from './services/theme/themes'
import { useChatStore, type Message } from './stores/chat'
import { useAuthStore } from './stores/auth'
import { useWsStore } from './stores/ws'
import { NotificationLevel } from './shared/proto/packets_pb'
import './style.css'

const pinia = createPinia()
setActivePinia(pinia)

const app = createApp({
  setup() {
    return () => h('div', { class: 'flex h-screen w-full overflow-hidden bg-chat-bg' }, [
      h('div', { class: 'w-[264px] shrink-0' }, [h(AppSidebar)]),
      h('div', { class: 'min-w-0 flex-1' }, [h(ChatArea)]),
    ])
  },
})
app.use(pinia)

const chat = useChatStore()
const auth = useAuthStore()
const ws = useWsStore()

chat.workspace = {
  id: 'w1',
  name: 'Msgnr',
  selfUserId: 'u-you',
  selfDisplayName: 'Sasha Park',
  selfRole: 'member',
}
auth.user = { id: 'u-you', email: 'sasha@msgnr.app', displayName: 'Sasha Park', role: 'member' }
ws.state = 'LIVE_SYNCED'

const now = Date.now()
const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString()

chat.channels = [
  { id: 'ch-design', name: 'design', kind: 'channel', visibility: 'public', unread: 4, notificationLevel: NotificationLevel.ALL, lastMessageSeq: 7n },
  { id: 'ch-eng', name: 'engineering', kind: 'channel', visibility: 'public', unread: 3, notificationLevel: NotificationLevel.ALL, lastMessageSeq: 5n },
  { id: 'ch-product', name: 'product', kind: 'channel', visibility: 'public', unread: 0, notificationLevel: NotificationLevel.ALL, lastMessageSeq: 3n },
  { id: 'ch-leadership', name: 'leadership', kind: 'channel', visibility: 'private', unread: 0, notificationLevel: NotificationLevel.ALL, lastMessageSeq: 2n },
]
chat.directMessages = [
  { id: 'dm-maya', userId: 'u-maya', displayName: 'Maya Chen', presence: 'online', unread: 0, notificationLevel: NotificationLevel.ALL, encryptionMode: 'dm_pairwise_signal_v1' },
  { id: 'dm-priya', userId: 'u-priya', displayName: 'Priya Sharma', presence: 'online', unread: 0, notificationLevel: NotificationLevel.ALL },
  { id: 'dm-jonas', userId: 'u-jonas', displayName: 'Jonas Weber', presence: 'away', unread: 0, notificationLevel: NotificationLevel.ALL },
  { id: 'dm-alex', userId: 'u-alex', displayName: 'Alex Kim', presence: 'offline', unread: 0, notificationLevel: NotificationLevel.ALL },
]
chat.activeChannelId = 'ch-design'

const messages: Message[] = [
  {
    id: 'm1', channelId: 'ch-design', senderId: 'u-maya', senderName: 'Maya Chen',
    body: 'Morning team! The new onboarding flow is live on staging 🎉 Would love a pass from everyone before Friday\'s review.',
    entities: [], channelSeq: 1n, threadSeq: 0n, mentionedUserIds: [], mentionEveryone: false,
    createdAt: iso(240), reactions: [{ emoji: '👍', count: 6 }, { emoji: '🎉', count: 3 }], myReactions: ['👍'],
  },
  {
    id: 'm2', channelId: 'ch-design', senderId: 'u-jonas', senderName: 'Jonas Weber',
    body: 'Step 2 still shows the old illustration — I filed a ticket for it — @Maya can you double-check?',
    entities: [], channelSeq: 2n, threadSeq: 0n, mentionedUserIds: [], mentionEveryone: false,
    createdAt: iso(238), reactions: [], myReactions: [], editedAt: iso(230),
  },
  {
    id: 'm3', channelId: 'ch-design', senderId: 'u-jonas', senderName: 'Jonas Weber',
    body: 'New hero treatment — sized for all three breakpoints:',
    entities: [], channelSeq: 3n, threadSeq: 0n, mentionedUserIds: [], mentionEveryone: false,
    createdAt: iso(237), reactions: [], myReactions: [],
    attachments: [{ id: 'att-1', fileName: 'hero-treatment-v2.png', fileSize: 1200 * 800, mimeType: 'image/png' }],
  },
  {
    id: 'm4', channelId: 'ch-design', senderId: 'u-priya', senderName: 'Priya Sharma',
    body: 'Handoff spec is ready — spacing tokens moved to the 4px scale, shadows documented.',
    entities: [], channelSeq: 4n, threadSeq: 0n, mentionedUserIds: [], mentionEveryone: false,
    createdAt: iso(210), reactions: [], myReactions: [],
    attachments: [{ id: 'att-2', fileName: 'handoff-spec-v3.pdf', fileSize: 2.4 * 1024 * 1024, mimeType: 'application/pdf' }],
  },
  {
    id: 'm5', channelId: 'ch-design', senderId: 'u-alex', senderName: 'Alex Kim',
    body: 'Thanks @Maya Chen — I\'ll review the copy this afternoon and leave comments in the doc.',
    entities: [{ kind: 'user', start: 7, end: 17, targetId: 'u-maya', label: 'Maya Chen', href: '' }],
    channelSeq: 5n, threadSeq: 0n, mentionedUserIds: ['u-maya'], mentionEveryone: false,
    createdAt: iso(205), reactions: [], myReactions: [],
  },
  {
    id: 'm6', channelId: 'ch-design', senderId: 'u-you', senderName: 'Sasha Park',
    body: 'Perfect. Demo notes are in the doc — I\'ll present at 15:00.',
    entities: [], channelSeq: 6n, threadSeq: 0n, mentionedUserIds: [], mentionEveryone: false,
    createdAt: iso(180), reactions: [], myReactions: [], editedAt: iso(178),
  },
  {
    id: 'm7', channelId: 'ch-design', senderId: 'u-you', senderName: 'Sasha Park',
    body: 'Grouped follow-up on the same bubble stack.',
    entities: [], channelSeq: 7n, threadSeq: 0n, mentionedUserIds: [], mentionEveryone: false,
    createdAt: iso(178), reactions: [], myReactions: [],
  },
]
chat.messages['ch-design'] = messages
chat.threadSummaries['m1'] = { replyCount: 4, lastThreadSeq: 8n, lastReplyAt: iso(12), lastReplyUserId: 'u-jonas' }
chat.typingByConversationId['ch-design'] = [{ userId: 'u-maya' }]

app.mount('#app')
const themeParam = new URLSearchParams(window.location.search).get('theme')
if (themeParam) {
  setColorTheme(themeParam as ThemeId)
} else {
  applyStoredColorTheme()
}
