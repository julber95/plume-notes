// Icons of the folders and the notebooks in the library: a folder with a
// relief, as in OneDrive, and a notebook logo. Both take a colour and a symbol
// chosen by the user. Plain SVG text: nothing here touches the page.

import type { Look, Orientation } from './model'

/** The folder colours offered by OneDrive, the default yellow first. */
export const FOLDER_COLORS: { id: string; label: string }[] = [
  { id: '#ffc83d', label: 'Yellow' },
  { id: '#a4262c', label: 'Dark red' },
  { id: '#ca5010', label: 'Dark orange' },
  { id: '#0b6a0b', label: 'Dark green' },
  { id: '#038387', label: 'Dark teal' },
  { id: '#0f548c', label: 'Dark blue' },
  { id: '#5c2e91', label: 'Dark purple' },
  { id: '#9b1a6e', label: 'Dark pink' },
  { id: '#7a7574', label: 'Grey' },
  { id: '#ee6b6e', label: 'Light red' },
  { id: '#f7894a', label: 'Light orange' },
  { id: '#6cc24a', label: 'Light green' },
  { id: '#30c6cc', label: 'Light teal' },
  { id: '#4f9ef5', label: 'Light blue' },
  { id: '#a58be6', label: 'Light purple' },
  { id: '#ee6fb5', label: 'Light pink' },
]

export const DEFAULT_FOLDER_COLOR = FOLDER_COLORS[0].id

/** Notebook colours: the violets of Plume first, with white and black, then the folder colours. */
export const NOTEBOOK_COLORS: { id: string; label: string }[] = [
  { id: '#4f0599', label: 'Plume violet' },
  { id: '#8c40ef', label: 'Bright violet' },
  { id: '#b28cf8', label: 'Soft violet' },
  { id: '#f4f1fa', label: 'White' },
  { id: '#1b1a21', label: 'Black' },
  ...FOLDER_COLORS.filter((c) => !['#5c2e91', '#a58be6', '#7a7574'].includes(c.id)),
]

export const DEFAULT_NOTEBOOK_COLOR = NOTEBOOK_COLORS[0].id

/** Symbols drawn in line, in a box of 24 by 24. */
const SYMBOL_PATHS: Record<string, string> = {
  feather: '<path d="M19.5 4.5c-6.5.6-11.3 5-13 11.6L5 20.5"/><path d="M19.5 4.5c.6 3.6-.3 6.9-2.6 9.3-2 2.1-4.9 3.1-8.4 3"/><path d="M5 20.5C7.6 15 11 11.2 15 8.5"/>',
  sigma: '<path d="M17.5 7V5h-11l6 7-6 7h11v-2"/>',
  atom: '<ellipse cx="12" cy="12" rx="9" ry="3.6"/><ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(120 12 12)"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>',
  flask: '<path d="M9.5 4h5M10.5 4v5.5L5.5 18a1.5 1.5 0 001.3 2.3h10.4a1.5 1.5 0 001.3-2.3l-5-8.5V4"/><path d="M8 15h8"/>',
  leaf: '<path d="M5 19c0-8 5-13.5 14-14 .5 9-4.5 14.5-12 14"/><path d="M5 19c2.5-4.5 5.5-7.5 9.5-9.5"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.4 3.9 5.2 3.9 8.5s-1.3 6.1-3.9 8.5c-2.6-2.4-3.9-5.2-3.9-8.5s1.3-6.1 3.9-8.5z"/>',
  book: '<path d="M12 6.5c-2-1.3-4.7-1.8-8-1.5v13c3.3-.3 6 .2 8 1.5 2-1.3 4.7-1.8 8-1.5V5c-3.3-.3-6 .2-8 1.5zM12 6.5v13"/>',
  scales: '<path d="M12 4v16M7.5 20h9M5 7.5h14"/><path d="M5 7.5l-2.5 6a2.7 2.7 0 005 0zM19 7.5l-2.5 6a2.7 2.7 0 005 0z"/>',
  code: '<path d="M8.5 7.5L4 12l4.5 4.5M15.5 7.5L20 12l-4.5 4.5M13.5 5l-3 14"/>',
  chat: '<path d="M4.5 6.5a2 2 0 012-2h11a2 2 0 012 2v8a2 2 0 01-2 2H11l-4.5 3.5v-3.5a2 2 0 01-2-2z"/><path d="M8.5 9.5h7M8.5 12.5h4.5"/>',
  music: '<path d="M9.5 17.5V6l9-2v11.5"/><circle cx="7" cy="17.5" r="2.5"/><circle cx="16" cy="15.5" r="2.5"/>',
  palette: '<path d="M12 3.5a8.5 8.5 0 100 17c1.4 0 2-.9 2-1.8 0-1.7-1.2-1.7-1.2-3.2 0-1 .8-1.7 1.9-1.7H17a3.5 3.5 0 003.5-3.5c0-3.8-3.8-6.8-8.5-6.8z"/><circle cx="8" cy="11" r="1" fill="currentColor"/><circle cx="11" cy="7.5" r="1" fill="currentColor"/><circle cx="15.5" cy="8.5" r="1" fill="currentColor"/>',
  chart: '<path d="M4 4.5v15h16"/><path d="M7.5 15.5l3.5-4.5 3 2.5 4.5-6.5"/>',
  hourglass: '<path d="M7 4h10M7 20h10M8 4c0 4 4 5 4 8s-4 4-4 8M16 4c0 4-4 5-4 8s4 4 4 8"/>',
  heart: '<path d="M12 19.5l-6.3-6.2a4.2 4.2 0 016-6l.3.4.3-.4a4.2 4.2 0 016 6z"/>',
  bolt: '<path d="M13 3.5L5.5 13.5H11l-1 7 7.5-10H12z"/>',
  star: '<path d="M12 4.2l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.6-4.8 2.6.9-5.4-3.9-3.8 5.4-.8z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.5M12 18v2.5M3.5 12H6M18 12h2.5M6 6l1.8 1.8M16.2 16.2L18 18M6 18l1.8-1.8M16.2 7.8L18 6"/>',
}

export const SYMBOLS: { id: string; label: string }[] = [
  { id: 'feather', label: 'Feather' },
  { id: 'sigma', label: 'Maths' },
  { id: 'atom', label: 'Physics' },
  { id: 'flask', label: 'Chemistry' },
  { id: 'leaf', label: 'Biology' },
  { id: 'globe', label: 'Geography' },
  { id: 'book', label: 'Literature' },
  { id: 'scales', label: 'Law' },
  { id: 'code', label: 'Computing' },
  { id: 'chat', label: 'Languages' },
  { id: 'music', label: 'Music' },
  { id: 'palette', label: 'Art' },
  { id: 'chart', label: 'Economics' },
  { id: 'hourglass', label: 'History' },
  { id: 'heart', label: 'Health' },
  { id: 'bolt', label: 'Energy' },
  { id: 'star', label: 'Star' },
  { id: 'gear', label: 'Engineering' },
]

const isHex = (c: unknown): c is string => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)

/** `color` moved towards `base` (t = 0 gives `color`, 1 gives `base`). */
function mix(color: string, base: string, t: number): string {
  const c = parseInt(color.slice(1), 16)
  const b = parseInt(base.slice(1), 16)
  const ch = (shift: number) => Math.round(((c >> shift) & 255) * (1 - t) + ((b >> shift) & 255) * t)
  return `#${((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1)}`
}

/** Perceived lightness, 0 (black) to 1 (white). */
function lightness(color: string): number {
  const c = parseInt(color.slice(1), 16)
  return (0.299 * ((c >> 16) & 255) + 0.587 * ((c >> 8) & 255) + 0.114 * (c & 255)) / 255
}

const escapeText = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** The first character of what was typed (an emoji may be made of several code points). */
export function firstGlyph(text: string): string {
  const t = text.trim()
  if (!t) return ''
  const Segmenter = (Intl as { Segmenter?: new (l?: string, o?: { granularity: 'grapheme' }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter
  if (Segmenter) for (const s of new Segmenter(undefined, { granularity: 'grapheme' }).segment(t)) return s.segment
  return Array.from(t)[0] ?? ''
}

/**
 * The symbol, centred on (cx, cy) and `size` wide: one of the drawn symbols
 * in `ink`, or an emoji as it is.
 */
function symbolMark(symbol: string | undefined, cx: number, cy: number, size: number, ink: string): string {
  if (!symbol) return ''
  const path = SYMBOL_PATHS[symbol]
  if (path) {
    const k = size / 24
    return `<g transform="translate(${cx - size / 2} ${cy - size / 2}) scale(${k})" fill="none" stroke="${ink}" stroke-width="${Math.min(2.4, 1.5 / k + 0.5)}" stroke-linecap="round" stroke-linejoin="round" color="${ink}">${path}</g>`
  }
  return `<text x="${cx}" y="${cy}" font-size="${size * 0.86}" text-anchor="middle" dominant-baseline="central" fill="${ink}">${escapeText(firstGlyph(symbol))}</text>`
}

/** A drawn symbol alone (for the buttons of the symbol picker). */
export function symbolIcon(symbol: string): string {
  return `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">${symbolMark(symbol, 12, 12, 24, 'currentColor')}</svg>`
}

let serial = 0

export interface IconOptions {
  /** Small sizes (the folder tree, menus): the fine details are left out. */
  small?: boolean
}

/** A folder in relief; `filled`: sheets stick out of it. */
export function folderIcon(look: Look | undefined, filled = false, opts: IconOptions = {}): string {
  const c = isHex(look?.color) ? look.color : DEFAULT_FOLDER_COLOR
  const id = `fo${++serial}`
  const light = lightness(c) > 0.62
  const ink = light ? mix(c, '#000000', 0.62) : '#ffffff'
  const back = `<path d="M4 9a3 3 0 013-3h10.8a3 3 0 012.2 1l2.4 2.6H41a3 3 0 013 3V36a3 3 0 01-3 3H7a3 3 0 01-3-3z" fill="url(#${id}b)"/>`
  const sheets = filled
    ? `<rect x="9.5" y="11.5" width="30" height="14" rx="1.6" fill="${mix(c, '#ffffff', 0.6)}"/><rect x="7.5" y="13.5" width="33" height="14" rx="1.6" fill="#ffffff"/>`
    : ''
  const front = `<path d="M4 19.5a3 3 0 013-3h34a3 3 0 013 3V37a3 3 0 01-3 3H7a3 3 0 01-3-3z" fill="url(#${id}f)"/>`
  const details = opts.small
    ? ''
    : `<path d="M4 37V19.5a3 3 0 013-3h20L14 40H7a3 3 0 01-3-3z" fill="#ffffff" opacity=".13"/>` +
      `<path d="M6.5 17.2h35" stroke="#ffffff" stroke-opacity=".65" stroke-width="1" stroke-linecap="round" fill="none"/>` +
      `<path d="M36 36.2h4.5" stroke="${ink}" stroke-opacity=".5" stroke-width="1.4" stroke-linecap="round" fill="none"/>` +
      symbolMark(look?.symbol, 24, 28.3, 13.5, ink)
  return (
    `<svg class="lib-icon folder-art" viewBox="0 0 48 48" aria-hidden="true"><defs>` +
    `<linearGradient id="${id}b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${mix(c, '#000000', 0.16)}"/><stop offset="1" stop-color="${mix(c, '#000000', 0.34)}"/></linearGradient>` +
    `<linearGradient id="${id}f" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${mix(c, '#ffffff', 0.34)}"/><stop offset=".55" stop-color="${c}"/><stop offset="1" stop-color="${mix(c, '#000000', 0.14)}"/></linearGradient>` +
    `</defs>${back}${sheets}${front}${details}</svg>`
  )
}

/**
 * The logo of a notebook: a bound book seen from the front, upright or wide.
 * `pdf`: a sheet with a folded corner instead, for a notebook that came from a PDF.
 */
export function notebookIcon(look: Look | undefined, orient: Orientation = 'portrait', pdf = false, opts: IconOptions = {}): string {
  const c = isHex(look?.color) ? look.color : DEFAULT_NOTEBOOK_COLOR
  const id = `nb${++serial}`
  const l = lightness(c)
  const ink = l > 0.62 ? mix(c, '#000000', 0.7) : '#ffffff'
  // On a dark screen a dark cover needs a clear edge, and a white one on a light screen.
  const rim = l > 0.8 ? mix(c, '#000000', 0.22) : mix(c, '#ffffff', 0.42)
  const wide = orient === 'landscape'
  const w = wide ? 42 : 31
  const h = wide ? 31 : 42
  const x = (48 - w) / 2
  const y = (48 - h) / 2
  const top = mix(c, '#ffffff', l < 0.25 ? 0.42 : 0.26)
  const bottom = mix(c, '#000000', 0.18)
  const defs =
    `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${top}"/><stop offset=".6" stop-color="${c}"/><stop offset="1" stop-color="${bottom}"/></linearGradient>` +
    `<clipPath id="${id}c"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3"/></clipPath></defs>`
  const symbol = look?.symbol ?? (pdf ? undefined : 'feather')

  if (pdf) {
    // A sheet, its corner folded, with a band that says what it is.
    const f = 9
    const sheet = `M${x + 3} ${y}H${x + w - f}L${x + w} ${y + f}V${y + h - 3}a3 3 0 01-3 3H${x + 3}a3 3 0 01-3-3V${y + 3}a3 3 0 013-3z`
    const band = h * 0.56
    return (
      `<svg class="lib-icon notebook-art pdf" viewBox="0 0 48 48" aria-hidden="true">${defs}` +
      `<path d="${sheet}" fill="#f6f4fb" stroke="${mix(c, '#ffffff', 0.35)}" stroke-width="1"/>` +
      `<path d="M${x + w - f} ${y}v${f - 2.5}a2.5 2.5 0 002.5 2.5H${x + w}z" fill="${mix(c, '#ffffff', 0.55)}"/>` +
      (opts.small ? '' : `<path d="M${x + 5} ${y + 8}h${w - f - 9}M${x + 5} ${y + 12.5}h${w - 10}" stroke="${mix(c, '#ffffff', 0.6)}" stroke-width="1.3" stroke-linecap="round"/>`) +
      `<rect x="${x - 2.5}" y="${y + band - 6}" width="${Math.min(w + 1, 27)}" height="12" rx="2.5" fill="url(#${id})"/>` +
      `<text x="${x - 2.5 + Math.min(w + 1, 27) / 2}" y="${y + band + 0.3}" font-family="Oxanium Variable, Inter Variable, sans-serif" font-size="8.2" font-weight="700" letter-spacing=".6" text-anchor="middle" dominant-baseline="central" fill="${ink}">PDF</text>` +
      (opts.small || !look?.symbol ? '' : symbolMark(look.symbol, x + w - 8, y + h - 8.5, 9, mix(c, '#000000', 0.1))) +
      `</svg>`
    )
  }

  const spine = 6.5
  const pages = `<rect x="${x + 3}" y="${y + 2}" width="${w - 1.5}" height="${h - 4}" rx="2" fill="#ffffff" opacity=".92"/><path d="M${x + w + 0.2} ${y + 5}v${h - 10}" stroke="${mix(c, '#ffffff', 0.5)}" stroke-width=".8" fill="none"/>`
  const cover = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="url(#${id})"/>`
  const binding =
    `<g clip-path="url(#${id}c)"><rect x="${x}" y="${y}" width="${spine}" height="${h}" fill="#000000" opacity=".24"/>` +
    (opts.small ? '' : `<path d="M${x - 2} ${y + h}L${x + w * 0.62} ${y}h${w * 0.2}L${x + w * 0.18} ${y + h}z" fill="#ffffff" opacity=".1"/>`) +
    `</g>`
  const rings = opts.small
    ? ''
    : [0.2, 0.5, 0.8].map((t) => `<rect x="${x - 1.8}" y="${y + h * t - 1.3}" width="6" height="2.6" rx="1.3" fill="${mix(c, '#ffffff', 0.78)}"/>`).join('')
  const cx = x + spine + (w - spine) / 2
  const size = wide ? 15 : 14
  const emblem = opts.small
    ? ''
    : `<circle cx="${cx}" cy="${y + h * 0.44}" r="${size * 0.74}" fill="${ink}" opacity=".13"/>` +
      symbolMark(symbol, cx, y + h * 0.44, size, ink) +
      `<path d="M${cx - 5} ${y + h - 5.5}h10" stroke="${ink}" stroke-opacity=".45" stroke-width="1.3" stroke-linecap="round"/>`
  const edge = `<rect x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${h - 1}" rx="2.6" fill="none" stroke="${rim}" stroke-opacity=".7" stroke-width="1"/>`
  return `<svg class="lib-icon notebook-art ${wide ? 'landscape' : ''}" viewBox="0 0 48 48" aria-hidden="true">${defs}${pages}${cover}${binding}${edge}${rings}${emblem}</svg>`
}
