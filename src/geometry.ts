// Géométrie des traits : contour du stylo, simplification, test de contact et
// gomme partielle. Sans dépendance au DOM (utilisé aussi par l'export PDF).

import { getStroke } from 'perfect-freehand'
import type { Stroke } from './model'

export type BBox = [number, number, number, number]

/** Ramer–Douglas–Peucker sur une polyligne plate [x0, y0, x1, y1, …]. */
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
 * La bibliothèque de tracé raisonne en pixels d'écran (elle ignore par exemple
 * les 3 dernières unités d'un trait). Nos coordonnées sont en points de page,
 * bien plus grands : on les agrandit donc avant le calcul, sinon la fin de
 * chaque trait devient un segment droit d'un millimètre.
 */
const UNIT = 12

/**
 * Polygone de contrôle (plat) du contour d'un trait de stylo sensible à la
 * pression. À dessiner arrondi : voir `smoothClosed`. `complete` vaut false
 * pendant le tracé.
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
    last: complete,
  })
  const flat: number[] = new Array(outline.length * 2)
  for (let i = 0; i < outline.length; i++) {
    flat[2 * i] = outline[i][0] / UNIT
    flat[2 * i + 1] = outline[i][1] / UNIT
  }
  return complete ? simplify(flat, 0.01) : flat
}

/**
 * Arrondit un polygone fermé : chaque sommet devient le point de contrôle d'une
 * courbe passant par les milieux des côtés. Retourne la courbe sous forme de
 * polyligne assez fine pour que l'écart reste sous `tol`.
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
    // Écart maximal entre la courbe et sa corde ; divisé par 4 à chaque doublement des segments.
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

/** Ligne centrale [x, y, …] d'un trait à largeur constante (surligneur, trait droit). */
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

/** Le disque (x, y, r) touche-t-il le trait ? */
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
 * Gomme partielle : retire du trait la partie couverte par le disque (x, y, r).
 * Retourne null si le trait n'est pas touché, sinon les morceaux restants
 * (éventuellement aucun).
 */
export function eraseFromStroke(s: Pick<Stroke, 'pts' | 'width' | 'tool'>, x: number, y: number, r: number): Float32Array[] | null {
  if (!strokeHit(s, x, y, r)) return null
  const p = s.pts
  const cut = r + s.width / 4
  const cut2 = cut * cut
  const step = Math.max(0.4, r / 3)

  // Rééchantillonne pour que la coupe soit nette même sur de longs segments.
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

/** Convertit « #rrggbb » en composantes 0..1. */
export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) return [0, 0, 0]
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255]
}

export const HIGHLIGHTER_ALPHA = 0.4
