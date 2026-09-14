/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{vue,js,ts,jsx,tsx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      fontSize: {
        sm: '1.05rem',
      },
      colors: {
        sidebar: {
          bg: 'rgb(var(--color-sidebar-bg) / <alpha-value>)',
          hover: 'rgb(var(--color-sidebar-hover) / <alpha-value>)',
          active: 'rgb(var(--color-selection-bg) / <alpha-value>)',
          text: 'rgb(var(--color-sidebar-text) / <alpha-value>)',
          unreadBadge: 'rgb(var(--color-sidebar-unread-badge) / <alpha-value>)',
          textMuted: 'rgb(var(--color-sidebar-text-muted) / <alpha-value>)',
          heading: 'rgb(var(--color-sidebar-heading) / <alpha-value>)',
        },
        chat: {
          bg: 'rgb(var(--color-bg-primary) / <alpha-value>)',
          header: 'rgb(var(--color-surface) / <alpha-value>)',
          input: 'rgb(var(--color-input) / <alpha-value>)',
          border: 'rgb(var(--color-divider) / <alpha-value>)',
          msgHover: 'rgb(var(--color-surface-hover) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'rgb(var(--color-accent) / <alpha-value>)',
          hover: 'rgb(var(--color-accent-hover) / <alpha-value>)',
        },
        public_id: 'rgb(var(--color-task-id) / <alpha-value>)',
        app: {
          bg: 'rgb(var(--color-bg-primary) / <alpha-value>)',
          secondary: 'rgb(var(--color-bg-secondary) / <alpha-value>)',
          tertiary: 'rgb(var(--color-bg-tertiary) / <alpha-value>)',
          surface: 'rgb(var(--color-surface) / <alpha-value>)',
          hover: 'rgb(var(--color-surface-hover) / <alpha-value>)',
          divider: 'rgb(var(--color-divider) / <alpha-value>)',
          text: 'rgb(var(--color-text-primary) / <alpha-value>)',
          muted: 'rgb(var(--color-text-muted) / <alpha-value>)',
          secondaryText: 'rgb(var(--color-text-secondary) / <alpha-value>)',
          onAccent: 'rgb(var(--color-text-on-accent) / <alpha-value>)',
          selection: 'rgb(var(--color-selection-bg) / <alpha-value>)',
          selectionText: 'rgb(var(--color-selection-text) / <alpha-value>)',
          selectionBorder: 'rgb(var(--color-selection-border) / <alpha-value>)',
          taskIdBg: 'rgb(var(--color-task-id-bg) / <alpha-value>)',
          success: 'rgb(var(--color-status-green) / <alpha-value>)',
          danger: 'rgb(var(--color-status-red) / <alpha-value>)',
          warning: 'rgb(var(--color-status-amber) / <alpha-value>)',
        },
      },
    },
  },
  plugins: [],
}
