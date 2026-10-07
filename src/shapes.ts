// Shape recognition: turns a roughly drawn stroke into a clean line, polygon,
// rectangle, ellipse or smooth curve. No DOM dependency.

import { simplify } from './geometry'

type XY = number[] // flat [x0, y0, x1, y1, …]

const DEG = Math.PI / 180

function pathLength(p: XY): number {
  let len = 0
  for (let i = 2; i < p.length; i += 2) len += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1])
  return len
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return Math.hypot(ax + t * dx - px, ay + t * dy - py)
}

/** Mean distance from the drawn points to a polyline. */
function meanDistance(points: XY, poly: XY): number {
  let sum = 0
  for (let i = 0; i < points.length; i += 2) {
    let best = Infinity
    for (let k = 2; k < poly.length; k += 2) {
      const d = distToSegment(points[i], points[i + 1], poly[k - 2], poly[k - 1], poly[k], poly[k + 1])
      if (d < best) best = d
    }
    sum += best
  }
  return sum / (points.length / 2)
}

/** Points spaced regularly along the path. */
function resample(p: XY, count: number): XY {
  const total = pathLength(p)
  if (total === 0) return p.slice(0, 2)
  const out: XY = [p[0], p[1]]
  const step = total / (count - 1)
  let need = step
  for (let i = 2; i < p.length; i += 2) {
    let ax = p[i - 2]
    let ay = p[i - 1]
    let seg = Math.hypot(p[i] - ax, p[i + 1] - ay)
    while (seg >= need && out.length < (count - 1) * 2) {
      const t = need / seg
      ax += (p[i] - ax) * t
      ay += (p[i + 1] - ay) * t
      out.push(ax, ay)
      seg -= need
      need = step
    }
    need -= seg
  }
  out.push(p[p.length - 2], p[p.length - 1])
  return out
}

function rotate(p: XY, angle: number, cx: number, cy: number): XY {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const out: XY = new Array(p.length)
  for (let i = 0; i < p.length; i += 2) {
    const x = p[i] - cx
    const y = p[i + 1] - cy
    out[i] = cx + x * c - y * s
    out[i + 1] = cy + x * s + y * c
  }
  return out
}

function bounds(p: XY): [number, number, number, number] {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (let i = 0; i < p.length; i += 2) {
    if (p[i] < x0) x0 = p[i]
    if (p[i] > x1) x1 = p[i]
    if (p[i + 1] < y0) y0 = p[i + 1]
    if (p[i + 1] > y1) y1 = p[i + 1]
  }
  return [x0, y0, x1, y1]
}

/** Corners of a closed outline (the first point is not repeated). */
function closedCorners(p: XY, tol: number): XY {
  // Start from the point farthest from the centre, which is surely a corner
  // (or any point of a round shape), so the arbitrary start adds no vertex.
  const n = p.length / 2
  let cx = 0
  let cy = 0
  for (let i = 0; i < p.length; i += 2) {
    cx += p[i]
    cy += p[i + 1]
  }
  cx /= n
  cy /= n
  let far = 0
  let farD = -1
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(p[2 * i] - cx, p[2 * i + 1] - cy)
    if (d > farD) {
      farD = d
      far = i
    }
  }
  const loop: XY = []
  for (let i = 0; i <= n; i++) {
    const k = (far + i) % n
    loop.push(p[2 * k], p[2 * k + 1])
  }
  const s = simplify(loop, tol)
  return s.slice(0, -2)
}

/** A straight line snaps to horizontal or vertical when it is nearly so. */
function cleanLine(ax: number, ay: number, bx: number, by: number): XY {
  const angle = Math.atan2(by - ay, bx - ax)
  const off = Math.abs(((angle / DEG + 360 + 45) % 90) - 45) // distance to the nearest axis, in degrees
  if (off < 5) {
    if (Math.abs(bx - ax) > Math.abs(by - ay)) ay = by = (ay + by) / 2
    else ax = bx = (ax + bx) / 2
  }
  return [ax, ay, bx, by]
}

function ellipse(cx: number, cy: number, rx: number, ry: number): XY {
  const out: XY = []
  const steps = 72
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2
    out.push(cx + rx * Math.cos(a), cy + ry * Math.sin(a))
  }
  return out
}

/** Removes the jitter of a freehand curve while keeping its shape and its ends. */
function smoothCurve(p: XY, closed: boolean): XY {
  const count = Math.max(24, Math.min(240, Math.round(pathLength(p) / 1.5)))
  let cur = resample(p, count)
  const n = cur.length / 2
  const radius = Math.max(2, Math.round(n * 0.04))
  for (let pass = 0; pass < 3; pass++) {
    const next: XY = new Array(cur.length)
    for (let i = 0; i < n; i++) {
      // Near an open end the window shrinks, so the ends stay where they are.
      const r = closed ? radius : Math.min(radius, i, n - 1 - i)
      let sx = 0
      let sy = 0
      for (let k = -r; k <= r; k++) {
        const j = closed ? (((i + k) % (n - 1)) + (n - 1)) % (n - 1) : i + k
        sx += cur[2 * j]
        sy += cur[2 * j + 1]
      }
      next[2 * i] = sx / (2 * r + 1)
      next[2 * i + 1] = sy / (2 * r + 1)
    }
    cur = next
  }
  if (closed) {
    cur[cur.length - 2] = cur[0]
    cur[cur.length - 1] = cur[1]
  }
  return cur
}

/** Simple arc: one curve from the first to the last point, fitted to the drawing. */
function fitArc(p: XY): XY {
  const n = p.length / 2
  const ax = p[0]
  const ay = p[1]
  const bx = p[p.length - 2]
  const by = p[p.length - 1]
  let sx = 0
  let sy = 0
  let sw = 0
  for (let i = 1; i < n - 1; i++) {
    const t = i / (n - 1)
    const w = 2 * t * (1 - t)
    sx += w * (p[2 * i] - (1 - t) * (1 - t) * ax - t * t * bx)
    sy += w * (p[2 * i + 1] - (1 - t) * (1 - t) * ay - t * t * by)
    sw += w * w
  }
  const cx = sx / sw
  const cy = sy / sw
  const out: XY = []
  for (let i = 0; i <= 40; i++) {
    const t = i / 40
    const u = 1 - t
    out.push(u * u * ax + 2 * u * t * cx + t * t * bx, u * u * ay + 2 * u * t * cy + t * t * by)
  }
  return out
}

export interface RecognizedShape {
  kind: 'line' | 'polyline' | 'triangle' | 'rectangle' | 'quad' | 'ellipse' | 'arc' | 'curve'
  /** Clean outline as a flat polyline [x0, y0, x1, y1, …]. */
  points: number[]
}

/**
 * Recognises the shape drawn by a stroke (stored as x, y, pressure triplets)
 * and returns its clean version. Always returns something for a stroke of
 * reasonable size: at worst, the same curve with the jitter removed.
 */
export function recognizeShape(pts: ArrayLike<number>): RecognizedShape | null {
  const raw: XY = []
  for (let i = 0; i < pts.length; i += 3) raw.push(pts[i], pts[i + 1])
  if (raw.length < 8) return null
  const length = pathLength(raw)
  const [x0, y0, x1, y1] = bounds(raw)
  const diag = Math.hypot(x1 - x0, y1 - y0)
  if (length < 8 || diag < 5) return null
  const p = resample(raw, Math.max(32, Math.min(160, Math.round(length / 2))))
  const n = p.length / 2
  const ax = p[0]
  const ay = p[1]
  const bx = p[p.length - 2]
  const by = p[p.length - 1]
  const gap = Math.hypot(bx - ax, by - ay)

  if (gap < Math.max(0.16 * length, 0.25 * diag) && length > 1.5 * diag) {
    // ----- Closed shapes -----
    const limit = 0.045 * diag
    let best: RecognizedShape | null = null
    let bestErr = limit
    const consider = (kind: RecognizedShape['kind'], points: XY, bias = 1) => {
      const err = meanDistance(p, points) * bias
      if (err < bestErr) {
        bestErr = err
        best = { kind, points }
      }
    }

    const corners = closedCorners(p, 0.07 * diag)
    const count = corners.length / 2

    // Rectangle, upright or tilted: orientation taken from its longest side.
    let angle = 0
    if (count === 4) {
      let longest = 0
      for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4
        const dx = corners[2 * j] - corners[2 * i]
        const dy = corners[2 * j + 1] - corners[2 * i + 1]
        if (Math.hypot(dx, dy) > longest) {
          longest = Math.hypot(dx, dy)
          angle = Math.atan2(dy, dx)
        }
      }
      const off = ((angle / DEG + 360 + 45) % 90) - 45
      angle = Math.abs(off) < 9 ? 0 : off * DEG
    }
    const cx = (x0 + x1) / 2
    const cy = (y0 + y1) / 2
    const upright = angle === 0 ? p : rotate(p, -angle, cx, cy)
    const [bx0, by0, bx1, by1] = bounds(upright)
    // Each side sits where the points near it are, not at the single most
    // extreme wobble.
    const side = (axis: 0 | 1, from: number, to: number): number => {
      const near: number[] = []
      for (let i = axis; i < upright.length; i += 2) if (Math.abs(upright[i] - from) < Math.abs(to - from) * 0.12) near.push(upright[i])
      near.sort((a, b) => a - b)
      return near.length ? near[near.length >> 1] : from
    }
    let rx0 = side(0, bx0, bx1)
    let rx1 = side(0, bx1, bx0)
    let ry0 = side(1, by0, by1)
    let ry1 = side(1, by1, by0)
    let w = rx1 - rx0
    let h = ry1 - ry0
    if (Math.abs(w - h) < 0.12 * Math.max(w, h)) {
      // Nearly square (or nearly a circle): make it exact.
      const size = (w + h) / 2
      const mx = (rx0 + rx1) / 2
      const my = (ry0 + ry1) / 2
      rx0 = mx - size / 2
      rx1 = mx + size / 2
      ry0 = my - size / 2
      ry1 = my + size / 2
      w = h = size
    }
    const rect = [rx0, ry0, rx1, ry0, rx1, ry1, rx0, ry1, rx0, ry0]
    consider('rectangle', angle === 0 ? rect : rotate(rect, angle, cx, cy), count === 4 ? 0.8 : 1)
    if (angle === 0) consider('ellipse', ellipse((rx0 + rx1) / 2, (ry0 + ry1) / 2, w / 2, h / 2), count >= 5 ? 0.8 : 1)
    if (count === 3) consider('triangle', [...corners, corners[0], corners[1]], 0.8)
    if (count === 4) consider('quad', [...corners, corners[0], corners[1]], 1.8)
    return best ?? { kind: 'curve', points: smoothCurve([...p, ax, ay], true) }
  }

  // ----- Open shapes -----
  let maxDev = 0
  for (let i = 1; i < n - 1; i++) maxDev = Math.max(maxDev, distToSegment(p[2 * i], p[2 * i + 1], ax, ay, bx, by))
  if (gap > 0.94 * length && maxDev < 0.06 * gap) return { kind: 'line', points: cleanLine(ax, ay, bx, by) }

  // Straight segments joined by clear corners (an "L", a "Z", a pair of axes).
  const bends = simplify(p, 0.05 * diag)
  const segments = bends.length / 2 - 1
  if (segments >= 2 && segments <= 4 && meanDistance(p, bends) < 0.012 * length) {
    let sharp = true
    for (let i = 1; i < segments; i++) {
      const a1 = Math.atan2(bends[2 * i + 1] - bends[2 * i - 1], bends[2 * i] - bends[2 * i - 2])
      const a2 = Math.atan2(bends[2 * i + 3] - bends[2 * i + 1], bends[2 * i + 2] - bends[2 * i])
      const turn = Math.abs(((a2 - a1) / DEG + 540) % 360 - 180)
      if (turn < 35) sharp = false
    }
    if (sharp) {
      // Each segment snaps to horizontal or vertical when it is nearly so.
      const out = bends.slice()
      for (let i = 0; i < segments; i++) {
        const dx = out[2 * i + 2] - out[2 * i]
        const dy = out[2 * i + 3] - out[2 * i + 1]
        const off = Math.abs(((Math.atan2(dy, dx) / DEG + 360 + 45) % 90) - 45)
        if (off >= 6) continue
        if (Math.abs(dx) > Math.abs(dy)) out[2 * i + 3] = out[2 * i + 1]
        else out[2 * i + 2] = out[2 * i]
      }
      return { kind: 'polyline', points: out }
    }
  }

  const arc = fitArc(p)
  if (meanDistance(p, arc) < 0.012 * length) return { kind: 'arc', points: arc }
  return { kind: 'curve', points: smoothCurve(p, false) }
}
