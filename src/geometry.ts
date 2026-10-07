// Stroke geometry: pen outline, simplification, hit testing and partial
// erasing. No DOM dependency (also used by the PDF export).

import { getStroke } from 'perfect-freehand'
import type { Stroke } from './model'

export type BBox = [number, number, number, number]

/** Ramer–Douglas–Peucker on a flat polyline [x0, y0, x1, y1, …]. */
export function simplify(flat: ArrayLike<number>, tol: number): number[] {
  const n = flat.length / 2
  if (n <= 2) return Array.from(flat)
  const keep = new Uint8Array(n)
  keep[0] = keep[n - 1] = 1
  const stack: number[] = [0, n - 1]
  const tol2 = tol * tol
  while (stack.length) {
    const b = stack.pop()!
    const a = stack.pop()!
    const ax = flat[2 * a]
    const ay = flat[2 * a + 1]
    const dx = flat[2 * b] - ax
    const dy = flat[2 * b + 1] - ay
    const len2 = dx * dx + dy * dy
    let worst = -1
    let worstD = tol2
    for (let i = a + 1; i < b; i++) {
      const px = flat[2 * i] - ax
      const py = flat[2 * i + 1] - ay
      let d: number
      if (len2 === 0) d = px * px + py * py
      else {
        const c = px * dy - py * dx
        d = (c * c) / len2
      }
      if (d > worstD) {
        worstD = d
        worst = i
      }
    }
    if (worst > 0) {
      keep[worst] = 1
      stack.push(a, worst, worst, b)
    }
  }
  const out: number[] = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(flat[2 * i], flat[2 * i + 1])
  return out
}

/**
 * The stroke library thinks in screen pixels (for instance it ignores the last
 * 3 units of a stroke). Our coordinates are in page points, which are much
 * larger, so we scale them up before the computation; otherwise the end of
 * every stroke becomes a straight segment one millimetre long.
 */
const UNIT = 12

/**
 * Control polygon (flat) of the outline of a pressure-sensitive pen stroke.
 * Meant to be drawn rounded: see `smoothClosed`. `complete` is false while
 * the stroke is being drawn.
 */
export function penOutline(pts: ArrayLike<number>, width: number, complete = true): number[] {
  const input: number[][] = []
  for (let i = 0; i < pts.length; i += 3) input.push([pts[i] * UNIT, pts[i + 1] * UNIT, pts[i + 2]])
  const outline = getStroke(input, {
    size: width * UNIT,
    thinning: 0.5,
    smoothing: 0.5,
    streamline: 0.4,
    simulatePressure: false,
    // Always end exactly on the last point: while drawing, the tip of the
    // stroke must sit under the stylus rather than trail behind it.
    last: true,
  })
  const flat: number[] = new Array(outline.length * 2)
  for (let i = 0; i < outline.length; i++) {
    flat[2 * i] = outline[i][0] / UNIT
    flat[2 * i + 1] = outline[i][1] / UNIT
  }
  return complete ? simplify(flat, 0.01) : flat
}

/**
 * Rounds a closed polygon: each vertex becomes the control point of a curve
 * through the midpoints of the sides. Returns the curve as a polyline fine
 * enough for the deviation to stay below `tol`.
 */
export function smoothClosed(flat: ArrayLike<number>, tol = 0.02): number[] {
  const n = flat.length / 2
  if (n < 3) return Array.from(flat)
  const out: number[] = []
  let ax = (flat[2 * n - 2] + flat[0]) / 2
  let ay = (flat[2 * n - 1] + flat[1]) / 2
  out.push(ax, ay)
  for (let i = 0; i < n; i++) {
    const cx = flat[2 * i]
    const cy = flat[2 * i + 1]
    const j = (i + 1) % n
    const bx = (cx + flat[2 * j]) / 2
    const by = (cy + flat[2 * j + 1]) / 2
    // Maximum gap between the curve and its chord; divided by 4 each time the segments are doubled.
    const dev = Math.hypot(ax - 2 * cx + bx, ay - 2 * cy + by) / 4
    const steps = Math.min(8, Math.max(1, Math.ceil(Math.sqrt(dev / tol))))
    for (let k = 1; k <= steps; k++) {
      const t = k / steps
      const u = 1 - t
      out.push(u * u * ax + 2 * u * t * cx + t * t * bx, u * u * ay + 2 * u * t * cy + t * t * by)
    }
    ax = bx
    ay = by
  }
  return out
}

/** Centreline [x, y, …] of a constant-width stroke (highlighter, straight line). */
export function centerline(pts: ArrayLike<number>): number[] {
  const out: number[] = []
  for (let i = 0; i < pts.length; i += 3) out.push(pts[i], pts[i + 1])
  return out
}

export function strokeBBox(s: Pick<Stroke, 'pts' | 'width'>): BBox {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const p = s.pts
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < minX) minX = p[i]
    if (p[i] > maxX) maxX = p[i]
    if (p[i + 1] < minY) minY = p[i + 1]
    if (p[i + 1] > maxY) maxY = p[i + 1]
  }
  const pad = s.width
  return [minX - pad, minY - pad, maxX + pad, maxY + pad]
}

function distToSegment2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const cx = ax + t * dx - px
  const cy = ay + t * dy - py
  return cx * cx + cy * cy
}

/** Does the disc (x, y, r) touch the stroke? */
export function strokeHit(s: Pick<Stroke, 'pts' | 'width'>, x: number, y: number, r: number): boolean {
  const p = s.pts
  const reach = r + s.width / 2
  const reach2 = reach * reach
  if (p.length === 3) {
    const dx = p[0] - x
    const dy = p[1] - y
    return dx * dx + dy * dy <= reach2
  }
  for (let i = 0; i + 5 < p.length; i += 3) {
    if (distToSegment2(x, y, p[i], p[i + 1], p[i + 3], p[i + 4]) <= reach2) return true
  }
  return false
}

/**
 * Partial eraser: removes from the stroke the part covered by the disc
 * (x, y, r). Returns null if the stroke is not touched, otherwise the
 * remaining pieces (possibly none).
 */
export function eraseFromStroke(s: Pick<Stroke, 'pts' | 'width' | 'tool'>, x: number, y: number, r: number): Float32Array[] | null {
  if (!strokeHit(s, x, y, r)) return null
  const p = s.pts
  const cut = r + s.width / 4
  const cut2 = cut * cut
  const step = Math.max(0.4, r / 3)

  // Resample so that the cut is clean even on long segments.
  const dense: number[] = [p[0], p[1], p[2]]
  for (let i = 3; i < p.length; i += 3) {
    const ax = p[i - 3]
    const ay = p[i - 2]
    const ap = p[i - 1]
    const d = Math.hypot(p[i] - ax, p[i + 1] - ay)
    const n = Math.ceil(d / step)
    for (let k = 1; k <= n; k++) {
      const t = k / n
      dense.push(ax + (p[i] - ax) * t, ay + (p[i + 1] - ay) * t, ap + (p[i + 2] - ap) * t)
    }
  }

  const runs: Float32Array[] = []
  let run: number[] = []
  let removed = false
  const flush = () => {
    const minPts = p.length === 3 ? 1 : 2
    if (run.length >= 3 * minPts) {
      if (s.tool === 'line' && run.length > 6) run = [...run.slice(0, 3), ...run.slice(-3)]
      runs.push(Float32Array.from(run))
    }
    run = []
  }
  for (let i = 0; i < dense.length; i += 3) {
    const dx = dense[i] - x
    const dy = dense[i + 1] - y
    if (dx * dx + dy * dy < cut2) {
      removed = true
      flush()
    } else {
      run.push(dense[i], dense[i + 1], dense[i + 2])
    }
  }
  flush()
  return removed ? runs : null
}

/** Converts "#rrggbb" to 0..1 components. */
export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) return [0, 0, 0]
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255]
}

export const HIGHLIGHTER_ALPHA = 0.4

// ---------- Scribble to erase ----------

/** Spread of the points along a direction, and number of back-and-forth reversals along it. */
function sweep(pts: ArrayLike<number>, ax: number, ay: number, slackRatio: number): { extent: number; reversals: number } {
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < pts.length; i += 3) {
    const t = pts[i] * ax + pts[i + 1] * ay
    if (t < lo) lo = t
    if (t > hi) hi = t
  }
  const extent = hi - lo
  // Small wobbles do not count as a reversal.
  const slack = Math.max(1.5, extent * slackRatio)
  let reversals = 0
  let dir = 0
  let extreme = pts[0] * ax + pts[1] * ay
  for (let i = 3; i < pts.length; i += 3) {
    const t = pts[i] * ax + pts[i + 1] * ay
    if (dir === 0) {
      if (Math.abs(t - extreme) > slack) {
        dir = t > extreme ? 1 : -1
        extreme = t
      }
    } else if ((t - extreme) * dir > 0) {
      extreme = t
    } else if ((extreme - t) * dir > slack) {
      reversals++
      dir = -dir
      extreme = t
    }
  }
  return { extent, reversals }
}

/**
 * Is this pen stroke a scribble, i.e. a tight back-and-forth zigzag?
 *
 * Two shapes are recognised. Going back and forth along the stroke's main
 * direction (rubbing over a word) is unmistakable. A zigzag that advances
 * sideways looks like writing "www", so it needs many more strokes to count.
 */
export function isScribble(pts: ArrayLike<number>): boolean {
  const n = pts.length / 3
  if (n < 12) return false
  let mx = 0
  let my = 0
  let length = 0
  for (let i = 0; i < pts.length; i += 3) {
    mx += pts[i]
    my += pts[i + 1]
    if (i) length += Math.hypot(pts[i] - pts[i - 3], pts[i + 1] - pts[i - 2])
  }
  mx /= n
  my /= n
  // Main direction: principal axis of the points.
  let sxx = 0
  let sxy = 0
  let syy = 0
  for (let i = 0; i < pts.length; i += 3) {
    const dx = pts[i] - mx
    const dy = pts[i + 1] - my
    sxx += dx * dx
    sxy += dx * dy
    syy += dy * dy
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy)
  const ax = Math.cos(angle)
  const ay = Math.sin(angle)

  const main = sweep(pts, ax, ay, 0.25)
  if (main.extent < 5 || length < main.extent * 3) return false
  if (main.reversals >= 4) return true
  const across = sweep(pts, -ay, ax, 0.4)
  return across.extent >= 4 && across.reversals >= 7
}

/**
 * Among `strokes`, those a scribble is meant to erase: the scribble crosses
 * them and covers most of them. A long stroke merely crossed at one end is
 * left alone.
 */
export function scribbleTargets<T extends Pick<Stroke, 'pts' | 'width'> & { bbox: BBox }>(scribble: Pick<Stroke, 'pts' | 'width'>, strokes: T[]): T[] {
  const box = strokeBBox(scribble)
  const pad = 2
  const out: T[] = []
  for (const s of strokes) {
    const b = s.bbox
    if (b[2] < box[0] || b[0] > box[2] || b[3] < box[1] || b[1] > box[3]) continue
    // Sample the stroke regularly (a straight line only stores its two ends).
    const p = s.pts
    let total = 0
    let inside = 0
    let touched = false
    const visit = (x: number, y: number) => {
      total++
      if (x < box[0] - pad || x > box[2] + pad || y < box[1] - pad || y > box[3] + pad) return
      inside++
      if (!touched && strokeHit(scribble, x, y, s.width / 2 + 0.5)) touched = true
    }
    visit(p[0], p[1])
    for (let i = 3; i < p.length; i += 3) {
      const d = Math.hypot(p[i] - p[i - 3], p[i + 1] - p[i - 2])
      const steps = Math.max(1, Math.ceil(d / 1.5))
      for (let k = 1; k <= steps; k++) visit(p[i - 3] + ((p[i] - p[i - 3]) * k) / steps, p[i - 2] + ((p[i + 1] - p[i - 2]) * k) / steps)
    }
    if (touched && inside >= total * 0.6) out.push(s)
  }
  return out
}
