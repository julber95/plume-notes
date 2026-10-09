// Graduated axes to draw graphs in: generated as ordinary straight strokes, so
// they can be moved, resized, erased and exported like anything else.

import type { Stroke } from './model'

export interface AxesOptions {
  xMin: number
  xMax: number
  yMin: number
  yMax: number
  grid: boolean
}

type Part = Pick<Stroke, 'tool' | 'color' | 'width' | 'pts'>

/** Digits and minus sign as strokes, on a grid 4 wide and 6 high (y down). */
const GLYPHS: Record<string, number[][]> = {
  '0': [[0, 0, 4, 0, 4, 6, 0, 6, 0, 0]],
  '1': [[1, 1.2, 2.2, 0, 2.2, 6]],
  '2': [[0, 0, 4, 0, 4, 3, 0, 3, 0, 6, 4, 6]],
  '3': [[0, 0, 4, 0, 4, 6, 0, 6], [1, 3, 4, 3]],
  '4': [[0, 0, 0, 3, 4, 3], [4, 0, 4, 6]],
  '5': [[4, 0, 0, 0, 0, 3, 4, 3, 4, 6, 0, 6]],
  '6': [[4, 0, 0, 0, 0, 6, 4, 6, 4, 3, 0, 3]],
  '7': [[0, 0, 4, 0, 1.8, 6]],
  '8': [[0, 0, 4, 0, 4, 6, 0, 6, 0, 0], [0, 3, 4, 3]],
  '9': [[4, 3, 0, 3, 0, 0, 4, 0, 4, 6, 0, 6]],
  '-': [[0.3, 3, 3.2, 3]],
  '.': [[0.5, 5.3, 1.2, 5.3, 1.2, 6, 0.5, 6, 0.5, 5.3]],
}

const INK = '#1a1a1a'
const LABEL = '#4a4f57'
const GRID = '#c5cedb'

function line(color: string, width: number, xy: number[]): Part {
  const pts = new Float32Array((xy.length / 2) * 3)
  for (let i = 0; i < xy.length / 2; i++) pts.set([xy[2 * i], xy[2 * i + 1], 0.5], i * 3)
  return { tool: 'line', color, width, pts }
}

/** A number written with strokes; `anchor` says which point of the text (x, y) is. */
function label(text: string, x: number, y: number, anchor: 'top' | 'right'): Part[] {
  const scale = 0.95
  // The decimal point takes less room than a digit.
  const advance = (ch: string) => (ch === '.' ? 3.1 : 5.4) * scale
  const width = [...text].reduce((w, ch) => w + advance(ch), 0) - 1.4 * scale
  let left = anchor === 'top' ? x - width / 2 : x - width
  const top = anchor === 'top' ? y : y - 3 * scale
  const out: Part[] = []
  for (const ch of text) {
    for (const g of GLYPHS[ch] ?? []) out.push(line(LABEL, 0.6, g.map((v, k) => (k % 2 === 0 ? left + v * scale : top + v * scale))))
    left += advance(ch)
  }
  return out
}

/** A round step (1, 2, 5, 10…) giving at most about ten graduations. */
function niceStep(range: number): number {
  const raw = range / 10
  const power = 10 ** Math.floor(Math.log10(raw))
  return [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? 10 * power
}

/** Strokes of a pair of axes, in points, with the top-left of the graph area at (0, 0). */
export function buildAxes(o: AxesOptions): Part[] {
  const xRange = o.xMax - o.xMin
  const yRange = o.yMax - o.yMin
  // Same scale on both axes, fitting in a 300 pt square.
  const unit = Math.min(300 / xRange, 300 / yRange)
  const W = xRange * unit
  const H = yRange * unit
  const X = (v: number) => (v - o.xMin) * unit
  const Y = (v: number) => (o.yMax - v) * unit
  // The axes cross at the origin when it is in range, at the nearest edge otherwise.
  const ox = X(Math.min(o.xMax, Math.max(o.xMin, 0)))
  const oy = Y(Math.min(o.yMax, Math.max(o.yMin, 0)))
  const stepX = niceStep(xRange)
  const stepY = niceStep(yRange)
  const marks = (min: number, max: number, step: number) => {
    const out: number[] = []
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) out.push(Math.round(v / step) * step)
    return out
  }
  const text = (v: number) => String(Math.round(v * 1000) / 1000)
  const parts: Part[] = []

  if (o.grid) {
    for (const v of marks(o.xMin, o.xMax, stepX)) parts.push(line(GRID, 0.5, [X(v), 0, X(v), H]))
    for (const v of marks(o.yMin, o.yMax, stepY)) parts.push(line(GRID, 0.5, [0, Y(v), W, Y(v)]))
  }
  // Axes, a little longer than the range, ending in arrowheads.
  const over = 10
  parts.push(line(INK, 1.1, [-over / 2, oy, W + over, oy]), line(INK, 1.1, [W + over - 5, oy - 3, W + over, oy, W + over - 5, oy + 3]))
  parts.push(line(INK, 1.1, [ox, H + over / 2, ox, -over]), line(INK, 1.1, [ox - 3, -over + 5, ox, -over, ox + 3, -over + 5]))
  for (const v of marks(o.xMin, o.xMax, stepX)) {
    if (Math.abs(v) < stepX / 1e6) continue
    parts.push(line(INK, 0.8, [X(v), oy - 2.5, X(v), oy + 2.5]), ...label(text(v), X(v), oy + 5, 'top'))
  }
  for (const v of marks(o.yMin, o.yMax, stepY)) {
    if (Math.abs(v) < stepY / 1e6) continue
    parts.push(line(INK, 0.8, [ox - 2.5, Y(v), ox + 2.5, Y(v)]), ...label(text(v), ox - 5, Y(v), 'right'))
  }
  if (o.xMin <= 0 && o.xMax >= 0 && o.yMin <= 0 && o.yMax >= 0) parts.push(...label('0', ox - 5, oy + 5 + 2.85, 'right'))
  return parts
}
