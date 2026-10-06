// Page backgrounds. The same description is used for display and for PDF
// export, so that the PDF is identical to the screen.

import { MM, type Background } from './model'

export interface BgLines {
  color: string
  width: number
  /** Segments x1, y1, x2, y2. */
  segs: number[]
}

export interface BgDots {
  color: string
  radius: number
  x0: number
  y0: number
  step: number
  nx: number
  ny: number
}

export interface BgSpec {
  lines: BgLines[]
  dots?: BgDots
}

/** Regular positions centred on [0, size]. */
function ticks(size: number, step: number): number[] {
  const n = Math.floor(size / step)
  const start = (size - n * step) / 2
  const out: number[] = []
  for (let i = 0; i <= n; i++) out.push(start + i * step)
  return out
}

export function backgroundSpec(bg: Background, w: number, h: number): BgSpec {
  switch (bg) {
    case 'blank':
      return { lines: [] }
    case 'lined': {
      const segs: number[] = []
      for (let y = 25 * MM; y < h - 10 * MM; y += 8 * MM) segs.push(0, y, w, y)
      return { lines: [{ color: '#c3cedd', width: 0.5, segs }] }
    }
    case 'grid': {
      const segs: number[] = []
      for (const x of ticks(w, 5 * MM)) segs.push(x, 0, x, h)
      for (const y of ticks(h, 5 * MM)) segs.push(0, y, w, y)
      return { lines: [{ color: '#d3dbe6', width: 0.4, segs }] }
    }
    case 'dots': {
      const xs = ticks(w, 5 * MM)
      const ys = ticks(h, 5 * MM)
      return {
        lines: [],
        dots: { color: '#aab4c2', radius: 0.5, x0: xs[0], y0: ys[0], step: 5 * MM, nx: xs.length, ny: ys.length },
      }
    }
    case 'seyes': {
      const fine: number[] = []
      const strong: number[] = []
      const vertical: number[] = []
      const margin = 32 * MM
      const top = 16 * MM
      let i = 0
      for (let y = top; y < h; y += 2 * MM, i++) {
        if (i % 4 === 0) strong.push(0, y, w, y)
        else fine.push(0, y, w, y)
      }
      for (let x = margin + 8 * MM; x < w; x += 8 * MM) vertical.push(x, 0, x, h)
      return {
        lines: [
          { color: '#d9dcf1', width: 0.25, segs: fine },
          { color: '#b7bde6', width: 0.5, segs: strong },
          { color: '#b7bde6', width: 0.4, segs: vertical },
          { color: '#e59aa6', width: 0.6, segs: [margin, 0, margin, h] },
        ],
      }
    }
  }
}
