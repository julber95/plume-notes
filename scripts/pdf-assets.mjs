// Vite plugin: makes the standard PDF fonts available to the application, so
// that imported PDFs which do not embed them (Helvetica, Times…) display with
// the right letter shapes. They are copied from PDF.js at each build.
import { cpSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function pdfAssets() {
  return {
    name: 'plume-pdf-assets',
    buildStart() {
      const from = fileURLToPath(new URL('../node_modules/pdfjs-dist/standard_fonts', import.meta.url))
      const to = fileURLToPath(new URL('../public/pdfjs/standard_fonts', import.meta.url))
      if (existsSync(from)) cpSync(from, to, { recursive: true })
    },
  }
}
