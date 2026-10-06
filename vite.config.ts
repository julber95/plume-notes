import { defineConfig } from 'vitest/config'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  // Chemins relatifs : l'application fonctionne quel que soit le sous-dossier
  // où elle est hébergée (par exemple https://moncompte.github.io/plume/).
  base: './',
  build: { target: 'es2022' },
  worker: { format: 'es' },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Plume',
        short_name: 'Plume',
        description: 'Prise de notes manuscrites synchronisée avec OneDrive',
        lang: 'fr',
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
      workbox: { globPatterns: ['**/*.{js,css,html,svg,png,woff2}'] },
    }),
  ],
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
})
