// Cover pages. A cover is described once, as simple shapes and lines of text,
// and that description is drawn both on screen and in the PDF.

export interface Cover {
  template: CoverTemplate
  title: string
  subtitle?: string
  /** Accent colour, "#rrggbb". */
  color: string
}

export type CoverTemplate = 'band' | 'minimal' | 'blueprint' | 'waves' | 'orbits' | 'lattice' | 'aurora' | 'glass' | 'horizon' | 'pulse'

export const COVER_TEMPLATES: { id: CoverTemplate; label: string }[] = [
  { id: 'band', label: 'Band' },
  { id: 'minimal', label: 'Minimal' },
  { id: 'blueprint', label: 'Blueprint' },
  { id: 'waves', label: 'Waves' },
  { id: 'orbits', label: 'Orbits' },
  { id: 'lattice', label: 'Lattice' },
  { id: 'aurora', label: 'Aurora' },
  { id: 'glass', label: 'Glass' },
  { id: 'horizon', label: 'Horizon' },
  { id: 'pulse', label: 'Pulse' },
]

/** The violets of Plume first, then the colours of the older covers. */
export const COVER_COLORS = ['#4f0599', '#8c40ef', '#2b4c8c', '#0e7490', '#15803d', '#b45309', '#9d174d', '#3f3f46']

export type CoverShape =
  | { kind: 'rect'; x: number; y: number; w: number; h: number; color: string }
  | { kind: 'polygon'; pts: number[]; color: string }
  | { kind: 'line'; pts: number[]; color: string; width: number }
  | { kind: 'text'; text: string; x: number; y: number; size: number; color: string; bold: boolean; align: 'left' | 'center' }

const INK = '#1c2430'
const SOFT = '#667085'
/** The night the dark covers are set in: the dark background of the application. */
const NIGHT = '#131217'

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

const disc = (cx: number, cy: number, r: number) => ellipse(cx, cy, r, r, 0)

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

  /** A ground shaded from `from` (top) to `to` (bottom), in thin bands: the PDF has no gradients here. */
  const shade = (from: string, to: string, y0 = 0, y1 = h) => {
    const bands = 48
    const step = (y1 - y0) / bands
    for (let i = 0; i < bands; i++) out.push({ kind: 'rect', x: 0, y: y0 + i * step, w, h: step + 0.6, color: mix(from, to, i / (bands - 1)) })
  }
  /** A light fading out around a point, from `core` at its centre to `edge`. */
  const halo = (cx: number, cy: number, r: number, core: string, edge: string, rings = 44) => {
    for (let i = 0; i < rings; i++) {
      const t = i / (rings - 1)
      out.push({ kind: 'polygon', pts: disc(cx, cy, r * (1 - t * 0.94)), color: mix(edge, core, t * t) })
    }
  }
  const deep = mix(c, NIGHT, 0.86)
  const glow = mix(c, '#ffffff', 0.38)
  const pale = mix(c, '#ffffff', 0.72)

  switch (cover.template) {
    case 'aurora': {
      // A night sky lit from a corner, crossed by the barbs of a feather.
      shade(deep, mix(c, NIGHT, 0.6))
      halo(w * 0.86, h * 0.14, Math.min(w, h) * 0.62, mix(c, '#ffffff', 0.12), mix(c, NIGHT, 0.82))
      for (let k = 0; k < 16; k++) {
        const pts: number[] = []
        const spread = k / 15
        for (let i = 0; i <= 60; i++) {
          const t = i / 60
          // Each barb leaves the shaft (bottom left) and bends towards the light.
          const x = w * (-0.05 + t * 1.1)
          const y = h * (0.98 - spread * 0.5) - Math.sin(t * Math.PI * 0.5) * h * (0.16 + spread * 0.34) - t * t * h * 0.08 * spread
          pts.push(x, y)
        }
        out.push({ kind: 'line', pts, color: mix(c, k % 4 ? glow : '#ffffff', 0.25 + spread * 0.55), width: k % 4 ? 0.6 : 1.1 })
      }
      out.push({ kind: 'rect', x: margin, y: h * 0.2 - 58, w: 44, h: 4, color: glow })
      heading(margin, h * 0.2, w - 2 * margin, '#ffffff', pale)
      break
    }
    case 'glass': {
      // Panes of frosted glass laid over each other, on a pale ground.
      shade('#ffffff', mix(c, '#ffffff', 0.86))
      halo(w * 0.2, h * 0.92, Math.min(w, h) * 0.6, mix(c, '#ffffff', 0.62), mix(c, '#ffffff', 0.9), 16)
      const pane = (x: number, y: number, pw: number, ph: number, tint: number) => {
        const cut = Math.min(pw, ph) * 0.16
        const pts = [x + cut, y, x + pw, y, x + pw, y + ph - cut, x + pw - cut, y + ph, x, y + ph, x, y + cut, x + cut, y]
        out.push({ kind: 'polygon', pts, color: mix(c, '#ffffff', tint) })
        out.push({ kind: 'line', pts, color: mix(c, '#ffffff', tint - 0.26), width: 0.9 })
        out.push({ kind: 'line', pts: [x + cut + 6, y + 6, x + pw - 6, y + 6], color: '#ffffff', width: 1.2 })
      }
      pane(w * 0.5, h * 0.08, w * 0.42, h * 0.3, 0.74)
      pane(w * 0.3, h * 0.2, w * 0.4, h * 0.26, 0.56)
      pane(w * 0.58, h * 0.3, w * 0.3, h * 0.2, 0.36)
      const ly = h * 0.6
      const lw = w - 2 * margin
      out.push({ kind: 'rect', x: margin, y: ly, w: lw, h: 150, color: '#ffffff' })
      out.push({ kind: 'line', pts: [margin, ly, margin + lw, ly, margin + lw, ly + 150, margin, ly + 150, margin, ly], color: mix(c, '#ffffff', 0.55), width: 0.9 })
      out.push({ kind: 'rect', x: margin, y: ly, w: 5, h: 150, color: c })
      heading(margin + 26, ly + 66, lw - 52, INK, SOFT, 'left', 30)
      break
    }
    case 'horizon': {
      // A plain drawn in perspective under a rising light.
      const hy = h * 0.6
      shade(deep, mix(c, NIGHT, 0.5), 0, hy)
      halo(w / 2, hy, Math.min(w, h) * 0.44, '#ffffff', mix(c, NIGHT, 0.5))
      out.push({ kind: 'rect', x: 0, y: hy, w, h: h - hy, color: mix(c, NIGHT, 0.9) })
      // The light is cut by the horizon, and by dark bars thinning upwards.
      for (let i = 0; i < 5; i++) out.push({ kind: 'rect', x: 0, y: hy - 12 - i * 17, w, h: 5.5 - i, color: mix(c, NIGHT, 0.56) })
      for (let i = -14; i <= 14; i++) out.push({ kind: 'line', pts: [w / 2 + i * w * 0.035, hy, w / 2 + i * w * 0.26, h], color: mix(c, glow, 0.5), width: 0.7 })
      for (let i = 0; i < 12; i++) {
        const y = hy + (h - hy) * Math.pow(i / 11, 2.2)
        out.push({ kind: 'line', pts: [0, y, w, y], color: mix(c, glow, 0.5), width: i ? 0.7 : 1.4 })
      }
      out.push({ kind: 'rect', x: margin, y: h * 0.16 - 58, w: 44, h: 4, color: glow })
      heading(margin, h * 0.16, w - 2 * margin, '#ffffff', pale)
      break
    }
    case 'pulse': {
      // An instrument dial: rings, graduations and a trace running through.
      shade(mix(c, NIGHT, 0.8), deep)
      const cx = w / 2
      const cy = h * 0.4
      const r = Math.min(w, h) * 0.3
      halo(cx, cy, r * 1.25, mix(c, '#ffffff', 0.05), mix(c, NIGHT, 0.82), 18)
      for (let k = 0; k < 4; k++) out.push({ kind: 'line', pts: disc(cx, cy, r * (1 - k * 0.22)), color: mix(c, k ? glow : '#ffffff', k ? 0.45 : 0.75), width: k ? 0.7 : 1.3 })
      for (let i = 0; i < 72; i++) {
        const a = (i / 72) * Math.PI * 2
        const long = i % 6 === 0
        out.push({ kind: 'line', pts: [cx + Math.cos(a) * r * 1.06, cy + Math.sin(a) * r * 1.06, cx + Math.cos(a) * r * (long ? 1.16 : 1.1), cy + Math.sin(a) * r * (long ? 1.16 : 1.1)], color: long ? pale : mix(c, glow, 0.4), width: long ? 1.1 : 0.6 })
      }
      const trace: number[] = []
      for (let i = 0; i <= 160; i++) {
        const t = i / 160
        const beat = Math.exp(-Math.pow((t - 0.5) * 9, 2))
        trace.push(cx - r * 1.5 + t * r * 3, cy - Math.sin(t * Math.PI * 14) * r * 0.5 * beat)
      }
      out.push({ kind: 'line', pts: trace, color: '#ffffff', width: 1.5 })
      // Brackets in the corners, as around a viewfinder.
      const b = 26
      for (const [x, y, sx, sy] of [[margin, margin, 1, 1], [w - margin, margin, -1, 1], [margin, h - margin, 1, -1], [w - margin, h - margin, -1, -1]]) {
        out.push({ kind: 'line', pts: [x + sx * b, y, x, y, x, y + sy * b], color: glow, width: 1.2 })
      }
      heading(w / 2, h * 0.76, w - 2 * margin - 40, '#ffffff', pale, 'center', 32)
      break
    }
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
