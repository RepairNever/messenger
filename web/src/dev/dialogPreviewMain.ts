// Dev-only harness: mounts the prop-driven dialogs on the real theme tokens.
// Not part of the production build (see vite config inputs / .zcodeignore).
import { createApp, defineComponent, h, ref } from 'vue'
import '@/style.css'
import DayoffDialog from '@/components/dayoffs/DayoffDialog.vue'
import DayoffDeleteConfirmDialog from '@/components/dayoffs/DayoffDeleteConfirmDialog.vue'
import BusyCallConfirmDialog from '@/components/BusyCallConfirmDialog.vue'
import { setColorTheme } from '@/composables/useColorTheme'
import type { ThemeId } from '@/services/theme/themes'
import type { Dayoff } from '@/stores/dayoffs'

const THEMES = ['dark', 'light', 'pink', 'rose'] as const

const record: Dayoff = {
  id: 'd1',
  userId: 'u1',
  type: 'vacation',
  startDate: '2026-10-12',
  endDate: '2026-10-16',
  note: 'Family trip',
} as unknown as Dayoff

const App = defineComponent({
  setup() {
    const theme = ref<string>('dark')
    const dayoffOpen = ref(true)
    const dayoffDeleteOpen = ref(false)
    const busyOpen = ref(false)

    function applyTheme(id: string) {
      theme.value = id
      setColorTheme(id as ThemeId)
    }

    const bar = () =>
      h(
        'div',
        {
          style:
            'position:fixed;top:8px;left:50%;transform:translateX(-50%);display:flex;gap:8px;z-index:100000;',
        },
        [
          ...THEMES.map((t) =>
            h(
              'button',
              {
                key: t,
                onClick: () => applyTheme(t),
                style: `padding:4px 10px;border-radius:8px;font-size:12px;border:1px solid ${theme.value === t ? '#7c5cff' : 'transparent'};`,
              },
              t,
            ),
          ),
          h('span', { style: 'width:12px' }),
          h('button', { onClick: () => { dayoffOpen.value = true; dayoffDeleteOpen.value = false; busyOpen.value = false }, style: 'padding:4px 10px;border-radius:8px;font-size:12px;' }, 'form'),
          h('button', { onClick: () => { dayoffOpen.value = false; dayoffDeleteOpen.value = true; busyOpen.value = false }, style: 'padding:4px 10px;border-radius:8px;font-size:12px;' }, 'confirm'),
          h('button', { onClick: () => { dayoffOpen.value = false; dayoffDeleteOpen.value = false; busyOpen.value = true }, style: 'padding:4px 10px;border-radius:8px;font-size:12px;' }, 'busy'),
        ],
      )

    return () =>
      h('div', { style: 'min-height:100vh;display:flex;align-items:center;justify-content:center;' }, [
        bar(),
        h(DayoffDialog, {
          open: dayoffOpen.value,
          record: null,
          employees: [
            { id: 'u1', displayName: 'Park Sang-woo', avatarUrl: '' },
            { id: 'u2', displayName: 'Maria Ivanova', avatarUrl: '' },
          ],
          selfUserId: 'u1',
          initialUserId: 'u1',
          isElevated: true,
          saving: false,
          error: '',
          onClose: () => (dayoffOpen.value = false),
          onSubmit: () => (dayoffOpen.value = false),
        }),
        h(DayoffDeleteConfirmDialog, {
          open: dayoffDeleteOpen.value,
          record,
          saving: false,
          error: '',
          onClose: () => (dayoffDeleteOpen.value = false),
          onConfirm: () => (dayoffDeleteOpen.value = false),
        }),
        h(BusyCallConfirmDialog, {
          open: busyOpen.value,
          userNames: ['Maria Ivanova', 'Bot Runner'],
          confirmLabel: 'Continue',
          onCancel: () => (busyOpen.value = false),
          onConfirm: () => (busyOpen.value = false),
        }),
      ])
  },
})

createApp(App).mount('#app')
