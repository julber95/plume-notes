import { describe, expect, it } from 'vitest'
import { isScribble, scribbleTargets, strokeBBox } from '../src/geometry'

/** Builds stroke points from a parametric curve sampled `n` times. */
function curve(n: number, f: (t: number) => [number, number]): Float32Array {
  const pts = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const [x, y] = f(i / (n - 1))
    pts.set([x, y, 0.4], i * 3)
  }
  return pts
}

const triangle = (u: number) => Math.abs(((u % 1) + 1) % 1 - 0.5) * 2 // 0..1..0

/** Rubbing back and forth over [x0, x1], `passes` times, drifting down a little. */
const rub = (x0: number, x1: number, y: number, passes: number) => curve(passes * 16, (t) => [x0 + (x1 - x0) * triangle((t * passes) / 2), y + t * 4 + Math.sin(t * 40) * 0.5])
/** A zigzag advancing sideways, like "www" with `teeth` teeth. */
const zigzag = (x0: number, x1: number, y: number, height: number, teeth: number) => curve(teeth * 14, (t) => [x0 + (x1 - x0) * t, y + height * triangle(t * teeth)])
const withBox = (pts: Float32Array, width = 1.3) => ({ pts, width, bbox: strokeBBox({ pts, width }) })

describe('scribble detection', () => {
  it('recognises rubbing back and forth, in any direction', () => {
    expect(isScribble(rub(100, 140, 200, 6))).toBe(true)
    // the same gesture, vertical then diagonal
    const horizontal = rub(0, 40, 0, 6)
    const rotated = (c: number, s: number) => Float32Array.from(horizontal, (v, i) => (i % 3 === 0 ? 100 + v * c - horizontal[i + 1] * s : i % 3 === 1 ? 100 + horizontal[i - 1] * s + v * c : v))
    expect(isScribble(rotated(0, 1))).toBe(true)
    expect(isScribble(rotated(Math.SQRT1_2, Math.SQRT1_2))).toBe(true)
  })

  it('recognises a long, tight zigzag across a word', () => {
    expect(isScribble(zigzag(100, 150, 200, 10, 9))).toBe(true)
  })

  it('does not mistake ordinary writing for a scribble', () => {
    expect(isScribble(zigzag(100, 130, 200, 8, 3))).toBe(false) // "www"
    expect(isScribble(curve(40, (t) => [100 + t * 80, 200 + t * 5]))).toBe(false) // a line
    expect(isScribble(curve(40, (t) => [100 + 10 * Math.cos(t * 6.3), 200 + 10 * Math.sin(t * 6.3)]))).toBe(false) // a circle
    expect(isScribble(curve(90, (t) => [100 + t * 60 + 3 * Math.cos(t * 31), 200 + 4 * Math.sin(t * 31)]))).toBe(false) // cursive loops
    expect(isScribble(rub(100, 140, 200, 2))).toBe(false) // a double underline
    expect(isScribble(curve(30, (t) => [100 + 2 * Math.cos(t * 30), 200 + 2 * Math.sin(t * 30)]))).toBe(false) // a dot filled in
  })
})

describe('scribble targets', () => {
  const word = [0, 1, 2, 3].map((i) => withBox(curve(20, (t) => [102 + i * 9 + 3 * Math.cos(t * 6.3), 202 + 3 * Math.sin(t * 6.3)])))
  const farWord = withBox(curve(20, (t) => [300 + 3 * Math.cos(t * 6.3), 202 + 3 * Math.sin(t * 6.3)]))
  const longUnderline = withBox(curve(2, (t) => [20 + t * 400, 203]))
  const shortUnderline = withBox(curve(2, (t) => [104 + t * 30, 204]))
  const scribble = { pts: rub(100, 140, 199, 6), width: 1.3 }

  it('erases the strokes the scribble covers, and only those', () => {
    const hit = scribbleTargets(scribble, [...word, farWord, longUnderline, shortUnderline])
    expect(hit).toEqual([...word, shortUnderline])
  })

  it('erases nothing when the scribble is over blank paper', () => {
    expect(scribbleTargets({ pts: rub(400, 440, 500, 6), width: 1.3 }, [...word, farWord, longUnderline])).toEqual([])
  })
})
