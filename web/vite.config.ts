import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath, URL } from 'node:url'
import Components from 'unplugin-vue-components/vite'
import { AntDesignVueResolver } from 'unplugin-vue-components/resolvers'

export default defineConfig({
  plugins: [
    vue(),
    Components({
      resolvers: [
        AntDesignVueResolver({ importStyle: false }),
      ],
    }),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      devOptions: {
        enabled: true,
        type: 'module',
      },
      includeAssets: [
        'favicon.ico',
        'apple-touch-icon-180x180.png',
        'badge-72x72.png',
        'pwa-64x64.png',
        'pwa-192x192.png',
        'pwa-512x512.png',
        'maskable-icon-512x512.png',
        'sounds/*.wav',
      ],
      manifest: {
        name: 'Msgnr',
        short_name: 'Msgnr',
        description: 'Team messenger',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        theme_color: '#1a1d21',
        background_color: '#1a1d21',
        icons: [
          {
            src: 'pwa-64x64.png',
            sizes: '64x64',
            type: 'image/png',
          },
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'maskable-icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      injectManifest: {
        // Precache: app shell JS/CSS/HTML + SVG + fonts.
        // PNG/ICO icons handled via includeAssets above.
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        // Exclude heavy lazy-loaded chunks from precache — they use runtime cache instead.
        globIgnores: [
          '**/rnnoise-*.js',        // ~3.8MB WASM, only needed during voice calls
          '**/vendor-livekit-*.js',  // ~439KB, lazy-loaded on call join
          '**/vendor-emoji-*.js',    // ~885KB, lazy-loaded on first emoji click
          '**/vendor-emoji-*.css',   // emoji picker styles
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          // LiveKit — large WebRTC library, keep in its own cached chunk
          if (id.includes('livekit-client')) return 'vendor-livekit'

          // Emoji picker data + source — lazy-loaded on first emoji click
          if (id.includes('emoji-mart-vue-fast') || id.includes('@emoji-mart')) return 'vendor-emoji'

          // Protobuf runtime — separate from Vue core so each can be cached independently
          if (id.includes('@bufbuild/protobuf')) return 'vendor-proto'

          // Vue core + router + pinia + axios — shared bootstrap
          if (
            id.includes('/node_modules/vue/') ||
            id.includes('/node_modules/@vue/') ||
            id.includes('/node_modules/vue-router/') ||
            id.includes('/node_modules/pinia/') ||
            id.includes('/node_modules/axios/')
          ) return 'vendor-core'
        },
      },
    },
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/ws': {
        target: 'ws://localhost:8080',
        ws: true,
      },
      '/api': 'http://localhost:8080',
      '/health': 'http://localhost:8080',
      '/ready': 'http://localhost:8080',
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
