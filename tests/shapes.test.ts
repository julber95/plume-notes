import { describe, expect, it } from 'vitest'
import { recognizeShape } from '../src/shapes'
import { rng } from './helpers'

const rand = rng(11)
const jitter = (amount: number) => (rand() - 0.5) * 2 * amount

/** A hand-drawn version of a path through `corners`: wobbly, with rounded corners. */
function drawn(corners: [number, number][], wobble = 1.2, perSide = 24): Float32Array {
  const out: number[] = []
  for (let i = 0; i + 1 < corners.length; i++) {
    const [ax, ay] = corners[i]
    const [bx, by] = corners[i + 1]
    for (let k = 0; k < perSide; k++) {
      const t = k / perSide
      out.push(ax + (bx - ax) * t + jitter(wobble), ay + (by - ay) * t + jitter(wobble), 0.4)
    }
  }
  const [lx, ly] = corners[corners.length - 1]
  out.push(lx + jitter(wobble), ly + jitter(wobble), 0.4)
  return Float32Array.from(out)
}

function drawnCurve(f: (t: number) => [number, number], n = 80, wobble = 1): Float32Array {
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const [x, y] = f(i / (n - 1))
    out.push(x + jitter(wobble), y + jitter(wobble), 0.4)
  }
  return Float32Array.from(out)
}

const near = (a: number, b: number, tol: number) => expect(Math.abs(a - b)).toBeLessThan(tol)

describe('shape recognition', () => {
  it('straightens a wobbly line, and levels it when nearly horizontal or vertical', () => {
    const slanted = recognizeShape(drawn([[100, 100], [220, 160]]))!
    expect(slanted.kind).toBe('line')
    expect(slanted.points.length).toBe(4)
    near(slanted.points[0], 100, 3)
    near(slanted.points[3], 160, 3)

    const flat = recognizeShape(drawn([[100, 300], [260, 304]]))!
    expect(flat.kind).toBe('line')
    expect(flat.points[1]).toBe(flat.points[3]) // exactly horizontal

    const upright = recognizeShape(drawn([[100, 300], [103, 420]]))!
    expect(upright.points[0]).toBe(upright.points[2]) // exactly vertical
  })

  it('turns a rough rectangle into a clean upright one', () => {
    const r = recognizeShape(drawn([[100, 100], [240, 103], [238, 180], [98, 178], [101, 102]]))!
    expect(r.kind).toBe('rectangle')
    const p = r.points
    expect(p.length).toBe(10)
    expect([p[1], p[2], p[5], p[6]]).toEqual([p[3], p[4], p[7], p[0]]) // right angles, sides parallel to the page
    near(p[2] - p[0], 140, 6)
    near(p[5] - p[1], 78, 6)
  })

  it('makes a near-square exactly square', () => {
    const r = recognizeShape(drawn([[100, 100], [182, 101], [181, 178], [99, 179], [100, 100]]))!
    expect(r.kind).toBe('rectangle')
    near(r.points[2] - r.points[0], r.points[5] - r.points[1], 1e-6)
  })

  it('keeps a tilted rectangle tilted, with right angles', () => {
    const c = Math.cos(0.5)
    const s = Math.sin(0.5)
    const tilt = ([x, y]: [number, number]): [number, number] => [200 + x * c - y * s, 200 + x * s + y * c]
    const r = recognizeShape(drawn(([[-70, -35], [70, -35], [70, 35], [-70, 35], [-70, -35]] as [number, number][]).map(tilt)))!
    expect(r.kind).toBe('rectangle')
    const p = r.points
    const dot = (p[2] - p[0]) * (p[4] - p[2]) + (p[3] - p[1]) * (p[5] - p[3])
    near(dot, 0, 1e-6)
    near(Math.atan2(p[3] - p[1], p[2] - p[0]), 0.5, 0.08)
  })

  it('recognises circles, ellipses and triangles', () => {
    const circle = recognizeShape(drawnCurve((t) => [200 + 40 * Math.cos(t * 6.4), 200 + 42 * Math.sin(t * 6.4)]))!
    expect(circle.kind).toBe('ellipse')
    const xs = circle.points.filter((_, i) => i % 2 === 0)
    const ys = circle.points.filter((_, i) => i % 2 === 1)
    near(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 1e-6) // a true circle

    const oval = recognizeShape(drawnCurve((t) => [200 + 70 * Math.cos(t * 6.4), 200 + 30 * Math.sin(t * 6.4)]))!
    expect(oval.kind).toBe('ellipse')

    const tri = recognizeShape(drawn([[100, 200], [180, 80], [260, 200], [102, 201]]))!
    expect(tri.kind).toBe('triangle')
    expect(tri.points.length).toBe(8)
  })

  it('cleans up a pair of axes drawn in one stroke', () => {
    const axes = recognizeShape(drawn([[100, 100], [102, 240], [280, 243]]))!
    expect(axes.kind).toBe('polyline')
    const p = axes.points
    expect(p.length).toBe(6)
    expect(p[0]).toBe(p[2]) // vertical axis
    expect(p[3]).toBe(p[5]) // horizontal axis
  })

  it('smooths curves without changing their shape or their ends', () => {
    const arc = recognizeShape(drawnCurve((t) => [100 + 160 * t, 200 - 60 * Math.sin(t * Math.PI)]))!
    expect(arc.kind).toBe('arc')

    const wave = recognizeShape(drawnCurve((t) => [100 + 300 * t, 200 + 40 * Math.sin(t * 12)], 160))!
    expect(wave.kind).toBe('curve')
    const p = wave.points
    near(p[0], 100, 2)
    near(p[p.length - 2], 400, 2)
    // Smooth: no sharp turn anywhere, yet the wave is still there.
    let sharpest = 0
    for (let i = 2; i + 3 < p.length; i += 2) {
      const a = Math.atan2(p[i + 1] - p[i - 1], p[i] - p[i - 2])
      const b = Math.atan2(p[i + 3] - p[i + 1], p[i + 2] - p[i])
      sharpest = Math.max(sharpest, Math.abs(((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI))
    }
    expect(sharpest).toBeLessThan(0.25)
    const ys = p.filter((_, i) => i % 2 === 1)
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(60)
  })

  it('ignores marks too small to be a shape', () => {
    expect(recognizeShape(drawn([[100, 100], [102, 101]], 0.2))).toBeNull()
  })
})
