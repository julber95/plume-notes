// Pencil look: graphite catches on the tooth of the paper, so a stroke is an
// even light layer plus a darker, clumpy grain. The same grain is used on
// screen and in the PDF.

/** Side of the repeating grain tile, in points. */
export const GRAIN_TILE = 12

/** Opacity of the even layer and of the grain, for a firm stroke. */
const BASE_ALPHA = 0.34
const GRAIN_ALPHA = 0.6

/** Opacity steps: a light touch gives a lighter stroke. */
export const PENCIL_LEVELS = 5

/** Opacity step (0 = lightest) for a stroke, from its average pressure. */
export function pencilLevel(pts: ArrayLike<number>): number {
  let sum = 0
  for (let i = 2; i < pts.length; i += 3) sum += pts[i]
  const pressure = pts.length ? sum / (pts.length / 3) : 0.5
  const strength = Math.min(1, Math.max(0.45, 0.4 + 1.2 * pressure))
  return Math.round(((strength - 0.45) / 0.55) * (PENCIL_LEVELS - 1))
}

/** Opacity of the even layer and of the grain at a given step. */
export function pencilAlpha(level: number): { base: number; grain: number } {
  const strength = 0.45 + (0.55 * level) / (PENCIL_LEVELS - 1)
  return { base: Math.round(BASE_ALPHA * strength * 100) / 100, grain: Math.round(GRAIN_ALPHA * strength * 100) / 100 }
}

let cached: number[] | null = null

/**
 * Grain of the tile as rectangles x, y, width, height (points), always the
 * same. Fine random specks gathered into irregular clumps, and repeating
 * seamlessly from one tile to the next.
 */
export function grainSpecks(): number[] {
  if (cached) return cached
  let seed = 20240917
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
  const cells = 64
  const cell = GRAIN_TILE / cells
  // Slow variation (the clumps), on a coarse grid that wraps around the tile.
  const coarse = 12
  const lattice = Array.from({ length: coarse * coarse }, rand)
  const slow = (cx: number, cy: number): number => {
    const fx = (cx / cells) * coarse
    const fy = (cy / cells) * coarse
    const x0 = Math.floor(fx)
    const y0 = Math.floor(fy)
    const tx = fx - x0
    const ty = fy - y0
    const at = (x: number, y: number) => lattice[(y % coarse) * coarse + (x % coarse)]
    return (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty
  }
  const value = new Float32Array(cells * cells)
  for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) value[y * cells + x] = 0.55 * slow(x, y) + 0.45 * rand()
  // Keep the 62 % of cells where the graphite catches best.
  const threshold = Array.from(value).sort((a, b) => a - b)[Math.floor(cells * cells * 0.38)]
  const out: number[] = []
  const r = (v: number) => Math.round(v * 1000) / 1000
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      if (value[y * cells + x] < threshold) continue
      let run = 1
      while (x + run < cells && value[y * cells + x + run] >= threshold) run++
      out.push(r(x * cell), r(y * cell), r(run * cell), r(cell))
      x += run
    }
  }
  cached = out
  return out
}
