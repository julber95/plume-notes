// Cover pages. A cover is described once, as simple shapes and lines of text,
// and that description is drawn both on screen and in the PDF.

export interface Cover {
  template: CoverTemplate
  title: string
  subtitle?: string
  /** Accent colour, "#rrggbb". */
  color: string
}

export type CoverTemplate = 'band' | 'minimal' | 'blueprint' | 'waves' | 'orbits' | 'lattice'

export const COVER_TEMPLATES: { id: CoverTemplate; label: string }[] = [
  { id: 'band', label: 'Band' },
  { id: 'minimal', label: 'Minimal' },
  { id: 'blueprint', label: 'Blueprint' },
  { id: 'waves', label: 'Waves' },
  { id: 'orbits', label: 'Orbits' },
  { id: 'lattice', label: 'Lattice' },
]

export const COVER_COLORS = ['#2b4c8c', '#0e7490', '#15803d', '#b45309', '#9d174d', '#3f3f46']

export type CoverShape =
  | { kind: 'rect'; x: number; y: number; w: number; h: number; color: string }
  | { kind: 'polygon'; pts: number[]; color: string }
  | { kind: 'line'; pts: number[]; color: string; width: number }
  | { kind: 'text'; text: string; x: number; y: number; size: number; color: string; bold: boolean; align: 'left' | 'center' }

const INK = '#1c2430'
const SOFT = '#667085'

/** `color` lightened towards `base` (t = 0 gives `color`, 1 gives `base`). */
function mix(color: string, base: string, t: number): string {
  const c = parseInt(color.slice(1), 16)
  const b = parseInt(base.slice(1), 16)
  const ch = (shift: number) => Math.round(((c >> shift) & 255) * (1 - t) + ((b >> shift) & 255) * t)
  return `#${((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1)}`
}

/** Rough width of a text in Helvetica, close enough to choose line breaks and size. */
const widthOf = (text: string, size: number, bold: boolean) => text.length * size * (bold ? 0.56 : 0.52)

/**
 * The title on at most two lines, as large as fits in `maxWidth` (between
 * `minSize` and `size`).
 */
function titleLines(title: string, maxWidth: number, size: number, minSize: number): { lines: string[]; size: number } {
  const words = title.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return { lines: [], size }
  for (let s = size; ; s -= 2) {
    const lines: string[] = []
    let current = ''
    for (const word of words) {
      const next = current ? `${current} ${word}` : word
      if (current && widthOf(next, s, true) > maxWidth) {
        lines.push(current)
        current = word
      } else current = next
    }
    lines.push(current)
    if ((lines.length <= 2 && lines.every((l) => widthOf(l, s, true) <= maxWidth)) || s <= minSize) return { lines: lines.slice(0, 2), size: s }
  }
}

function ellipse(cx: number, cy: number, rx: number, ry: number, tilt: number): number[] {
  const out: number[] = []
  const c = Math.cos(tilt)
  const s = Math.sin(tilt)
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * Math.PI * 2
    const x = rx * Math.cos(a)
    const y = ry * Math.sin(a)
    out.push(cx + x * c - y * s, cy + x * s + y * c)
  }
  return out
}

/** Shapes of a cover for a page `w` by `h` points, in drawing order. */
export function coverShapes(cover: Cover, w: number, h: number): CoverShape[] {
  const c = cover.color
  const out: CoverShape[] = []
  const margin = Math.min(w, h) * 0.09
  /** Title then subtitle, from a baseline; returns the baseline after them. */
  const heading = (x: number, y: number, maxWidth: number, color: string, soft: string, align: 'left' | 'center' = 'left', size = 34): number => {
    const t = titleLines(cover.title, maxWidth, size, 18)
    for (const line of t.lines) {
      out.push({ kind: 'text', text: line, x, y, size: t.size, color, bold: true, align })
      y += t.size * 1.2
    }
    if (cover.subtitle?.trim()) {
      out.push({ kind: 'text', text: cover.subtitle.trim().slice(0, 80), x, y: y + 4, size: 15, color: soft, bold: false, align })
      y += 24
    }
    return y
  }

  switch (cover.template) {
    case 'band': {
      // A solid band across the top carrying the title; the rest stays calm.
      const bandH = h * 0.34
      out.push({ kind: 'rect', x: 0, y: 0, w, h: bandH, color: c })
      out.push({ kind: 'rect', x: 0, y: bandH, w, h: 5, color: mix(c, '#ffffff', 0.55) })
      heading(margin, bandH * 0.52, w - 2 * margin, '#ffffff', mix(c, '#ffffff', 0.8))
      for (let i = 0; i < 4; i++) out.push({ kind: 'line', pts: [margin, h - margin - i * 9, margin + 70 - i * 14, h - margin - i * 9], color: mix(c, '#ffffff', 0.25 + i * 0.18), width: 2 })
      break
    }
    case 'minimal': {
      // Almost nothing: a short coloured rule beside the title.
      const y = h * 0.38
      const end = heading(margin + 18, y, w - 2 * margin - 18, INK, SOFT)
      out.push({ kind: 'rect', x: margin, y: y - 30, w: 5, h: end - y + 30, color: c })
      out.push({ kind: 'line', pts: [margin, h - margin, w - margin, h - margin], color: '#d5dae3', width: 0.8 })
      break
    }
    case 'blueprint': {
      // A technical drawing sheet: fine grid on a coloured ground, title on a label.
      out.push({ kind: 'rect', x: 0, y: 0, w, h, color: c })
      const step = 14.17 // 5 mm
      const fine = mix(c, '#ffffff', 0.16)
      const strong = mix(c, '#ffffff', 0.3)
      for (let i = 1, x = step; x < w; x += step, i++) out.push({ kind: 'line', pts: [x, 0, x, h], color: i % 5 ? fine : strong, width: i % 5 ? 0.4 : 0.8 })
      for (let i = 1, y = step; y < h; y += step, i++) out.push({ kind: 'line', pts: [0, y, w, y], color: i % 5 ? fine : strong, width: i % 5 ? 0.4 : 0.8 })
      const lw = w - 2 * margin
      const lh = 150
      const ly = h * 0.3
      out.push({ kind: 'rect', x: margin, y: ly, w: lw, h: lh, color: '#ffffff' })
      out.push({ kind: 'line', pts: [margin + 8, ly + 8, margin + lw - 8, ly + 8, margin + lw - 8, ly + lh - 8, margin + 8, ly + lh - 8, margin + 8, ly + 8], color: c, width: 0.9 })
      heading(w / 2, ly + 66, lw - 50, INK, SOFT, 'center', 30)
      break
    }
    case 'waves': {
      // Superposed waves along the bottom, like an interference pattern.
      heading(margin, h * 0.24, w - 2 * margin, INK, SOFT)
      out.push({ kind: 'rect', x: margin, y: h * 0.24 - 62, w: 44, h: 5, color: c })
      for (let k = 0; k < 7; k++) {
        const pts: number[] = []
        const base = h * (0.66 + k * 0.035)
        for (let i = 0; i <= 120; i++) {
          const x = (i / 120) * w
          pts.push(x, base + Math.sin((i / 120) * Math.PI * (2.2 + k * 0.35) + k * 0.7) * (34 - k * 3) * Math.sin((i / 120) * Math.PI))
        }
        out.push({ kind: 'line', pts, color: mix(c, '#ffffff', k * 0.11), width: 1.6 - k * 0.12 })
      }
      break
    }
    case 'orbits': {
      // An atom drawn in line: three orbits around a nucleus.
      const cx = w * 0.62
      const cy = h * 0.36
      const r = Math.min(w, h) * 0.3
      for (let k = 0; k < 3; k++) out.push({ kind: 'line', pts: ellipse(cx, cy, r, r * 0.36, (k * Math.PI) / 3), color: mix(c, '#ffffff', 0.15 + k * 0.12), width: 1.4 })
      out.push({ kind: 'polygon', pts: ellipse(cx, cy, r * 0.085, r * 0.085, 0), color: c })
      for (let k = 0; k < 3; k++) {
        const a = k * 2.2 + 0.6
        const tilt = (k * Math.PI) / 3
        const ex = r * Math.cos(a)
        const ey = r * 0.36 * Math.sin(a)
        out.push({ kind: 'polygon', pts: ellipse(cx + ex * Math.cos(tilt) - ey * Math.sin(tilt), cy + ex * Math.sin(tilt) + ey * Math.cos(tilt), r * 0.035, r * 0.035, 0), color: mix(c, '#ffffff', 0.2) })
      }
      heading(margin, h * 0.74, w - 2 * margin, INK, SOFT)
      out.push({ kind: 'rect', x: margin, y: h * 0.74 - 58, w: 44, h: 5, color: c })
      break
    }
    case 'lattice': {
      // A honeycomb, as in a crystal or a molecule, fading out from the corner.
      const side = Math.min(w, h) * 0.055
      const dx = side * Math.sqrt(3)
      for (let row = 0; row < 9; row++) {
        for (let col = 0; col < 9; col++) {
          const fade = (row + col * 0.9) / 9
          if (fade > 1) continue
          const cx = w - margin * 0.4 - col * dx - (row % 2 ? dx / 2 : 0)
          const cy = margin * 0.6 + row * side * 1.5
          const pts: number[] = []
          for (let i = 0; i <= 6; i++) pts.push(cx + side * Math.sin((i * Math.PI) / 3), cy + side * Math.cos((i * Math.PI) / 3))
          out.push({ kind: 'line', pts, color: mix(c, '#ffffff', 0.1 + fade * 0.8), width: 1.1 })
        }
      }
      heading(margin, h * 0.68, w - 2 * margin, INK, SOFT)
      out.push({ kind: 'rect', x: margin, y: h * 0.68 - 58, w: 44, h: 5, color: c })
      break
    }
  }
  return out
}

/** Draws a cover on a canvas already set to the page's coordinates. */
export function drawCover(ctx: CanvasRenderingContext2D, cover: Cover, w: number, h: number): void {
  ctx.save()
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  for (const s of coverShapes(cover, w, h)) {
    if (s.kind === 'rect') {
      ctx.fillStyle = s.color
      ctx.fillRect(s.x, s.y, s.w, s.h)
    } else if (s.kind === 'text') {
      ctx.fillStyle = s.color
      ctx.font = `${s.bold ? 700 : 400} ${s.size}px Helvetica, Arial, sans-serif`
      ctx.textAlign = s.align
      ctx.textBaseline = 'alphabetic'
      ctx.fillText(s.text, s.x, s.y)
    } else {
      ctx.beginPath()
      ctx.moveTo(s.pts[0], s.pts[1])
      for (let i = 2; i < s.pts.length; i += 2) ctx.lineTo(s.pts[i], s.pts[i + 1])
      if (s.kind === 'polygon') {
        ctx.fillStyle = s.color
        ctx.fill()
      } else {
        ctx.strokeStyle = s.color
        ctx.lineWidth = s.width
        ctx.stroke()
      }
    }
  }
  ctx.restore()
}
