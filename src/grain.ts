// Pencil grain: the lead does not cover the paper evenly. The same pattern of
// specks is used on screen and in the PDF.

/** Side of the repeating grain tile, in points. */
export const GRAIN_TILE = 9
/**
 * A pencil stroke is an even light layer plus darker specks on top. Both are
 * translucent, so overlapping strokes get darker, like graphite.
 */
export const PENCIL_BASE_ALPHA = 0.5
export const PENCIL_GRAIN_ALPHA = 0.5

let cached: number[] | null = null

/** Specks of the tile as x, y, width, height (points), always the same. */
export function grainSpecks(): number[] {
  if (cached) return cached
  let seed = 20240917
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
  const out: number[] = []
  // About 60 % of the tile is covered, in fine specks of uneven size.
  const cell = 0.24
  for (let y = 0; y < GRAIN_TILE - 1e-6; y += cell) {
    for (let x = 0; x < GRAIN_TILE - 1e-6; x += cell) {
      if (rand() < 0.4) continue
      const w = cell * (0.75 + rand() * 0.45)
      const h = cell * (0.75 + rand() * 0.45)
      out.push(Math.round(x * 100) / 100, Math.round(y * 100) / 100, Math.round(Math.min(w, GRAIN_TILE - x) * 100) / 100, Math.round(Math.min(h, GRAIN_TILE - y) * 100) / 100)
    }
  }
  cached = out
  return out
}
