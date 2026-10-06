import { uid, type Stroke, type StrokeTool } from '../src/model'

/** Reproducible pseudo-random generator. */
export function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** A stroke that looks like a handwritten letter (a loop of about 8 pt). */
export function letter(pageId: string, x: number, y: number, seq: number, rand: () => number, tool: StrokeTool = 'pen'): Stroke {
  const n = 28
  const pts = new Float32Array(n * 3)
  const a0 = rand() * 6.28
  const rx = 2.5 + rand() * 2
  const ry = 3 + rand() * 2.5
  for (let i = 0; i < n; i++) {
    const t = a0 + (i / n) * 7.5
    pts[3 * i] = x + Math.cos(t) * rx + i * 0.12
    pts[3 * i + 1] = y + Math.sin(t) * ry
    pts[3 * i + 2] = 0.3 + 0.3 * Math.sin(i / 4) + rand() * 0.05
  }
  return { id: uid(), pageId, seq, tool, color: '#1a1a1a', width: tool === 'pen' ? 1.3 : 12, pts }
}

/** A densely written page: `lines` lines of `perLine` letters. */
export function writtenPage(pageId: string, seed: number, lines = 30, perLine = 60): Stroke[] {
  const rand = rng(seed)
  const out: Stroke[] = []
  let seq = 0
  for (let l = 0; l < lines; l++) {
    for (let c = 0; c < perLine; c++) out.push(letter(pageId, 40 + c * 8.5, 60 + l * 25, seq++, rand))
  }
  return out
}
