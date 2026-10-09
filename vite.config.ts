import { defineConfig } from 'vitest/config'
import { VitePWA } from 'vite-plugin-pwa'
// @ts-expect-error plain JavaScript helper, without type declarations
import { pdfAssets } from './scripts/pdf-assets.mjs'

export default defineConfig({
  // Relative paths: the application works whatever sub-folder it is hosted in
  // (for example https://myaccount.github.io/plume/).
  base: './',
  define: { __APP_VERSION__: JSON.stringify('1.0.0') },
  build: { target: 'es2022' },
  worker: { format: 'es' },
  plugins: [
    pdfAssets(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Plume',
        short_name: 'Plume',
        description: 'Handwritten notes synced with OneDrive',
        lang: 'en',
        start_url: './',
        scope: './',
        display: 'standalone',
        orientation: 'any',
        background_color: '#f4f5f7',
        theme_color: '#f4f5f7',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      // Includes the PDF display engine and its fonts, so imported PDFs open offline too.
      workbox: { globPatterns: ['**/*.{js,mjs,css,html,svg,png,woff2,pfb,ttf}'], maximumFileSizeToCacheInBytes: 4 * 1024 * 1024 },
    }),
  ],
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
})
