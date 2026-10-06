// Format des données modifiables embarquées dans chaque page du PDF.
//
// Un bloc par page : [longueur de l'en-tête sur 4 octets][en-tête JSON][points].
// L'en-tête décrit la page et ses traits ; les points sont des entiers
// (centièmes de point, pression sur 255) codés en différences puis en varints,
// ce qui se compresse très bien.

import { uid, type Background, type Orientation, type Page, type Stroke, type StrokeTool } from '../model'
import type { NotebookContent } from '../db'

export const FORMAT_VERSION = 1

interface HeaderStroke {
  t: 'p' | 'h' | 'l'
  c: string
  w: number
  n: number
}

interface Header {
  bg: Background
  o: Orientation
  s: HeaderStroke[]
}

export interface PageData {
  bg: Background
  orient: Orientation
  strokes: Pick<Stroke, 'tool' | 'color' | 'width' | 'pts'>[]
}

const TOOL_CODE: Record<StrokeTool, HeaderStroke['t']> = { pen: 'p', highlighter: 'h', line: 'l' }
const CODE_TOOL: Record<HeaderStroke['t'], StrokeTool> = { p: 'pen', h: 'highlighter', l: 'line' }
const BGS = new Set<string>(['blank', 'lined', 'grid', 'dots', 'seyes'])

class Writer {
  buf = new Uint8Array(4096)
  len = 0
  varint(v: number): void {
    if (this.len + 6 > this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2)
      next.set(this.buf)
      this.buf = next
    }
    // zigzag : les petits nombres, positifs ou négatifs, tiennent sur un octet
    let u = v < 0 ? -2 * v - 1 : 2 * v
    while (u >= 128) {
      this.buf[this.len++] = (u % 128) | 128
      u = Math.floor(u / 128)
    }
    this.buf[this.len++] = u
  }
}

export function encodePage(page: Pick<Page, 'bg' | 'orient'>, strokes: Pick<Stroke, 'tool' | 'color' | 'width' | 'pts'>[]): Uint8Array {
  const header: Header = {
    bg: page.bg,
    o: page.orient,
    s: strokes.map((s) => ({ t: TOOL_CODE[s.tool], c: s.color, w: Math.round(s.width * 100) / 100, n: s.pts.length / 3 })),
  }
  const w = new Writer()
  for (const s of strokes) {
    let px = 0
    let py = 0
    let pp = 0
    let dx = 0
    let dy = 0
    for (let i = 0; i < s.pts.length; i += 3) {
      const x = Math.round(s.pts[i] * 100)
      const y = Math.round(s.pts[i + 1] * 100)
      const p = Math.round(s.pts[i + 2] * 255)
      // x et y : différence seconde (une courbe régulière donne de petits nombres)
      w.varint(x - px - dx)
      w.varint(y - py - dy)
      w.varint(p - pp)
      dx = x - px
      dy = y - py
      px = x
      py = y
      pp = p
    }
  }
  const head = new TextEncoder().encode(JSON.stringify(header))
  const out = new Uint8Array(4 + head.length + w.len)
  new DataView(out.buffer).setUint32(0, head.length, true)
  out.set(head, 4)
  out.set(w.buf.subarray(0, w.len), 4 + head.length)
  return out
}

export function decodePage(bytes: Uint8Array): PageData | null {
  try {
    const headLen = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true)
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headLen))) as Header
    let pos = 4 + headLen
    const varint = (): number => {
      let u = 0
      let mul = 1
      for (;;) {
        if (pos >= bytes.length) throw new Error('données tronquées')
        const b = bytes[pos++]
        u += (b & 127) * mul
        if (b < 128) break
        mul *= 128
      }
      return u % 2 ? -(u + 1) / 2 : u / 2
    }
    const strokes: PageData['strokes'] = []
    for (const hs of header.s) {
      const pts = new Float32Array(hs.n * 3)
      let x = 0
      let y = 0
      let p = 0
      let dx = 0
      let dy = 0
      for (let i = 0; i < pts.length; i += 3) {
        dx += varint()
        dy += varint()
        p += varint()
        x += dx
        y += dy
        pts[i] = x / 100
        pts[i + 1] = y / 100
        pts[i + 2] = p / 255
      }
      if (CODE_TOOL[hs.t]) strokes.push({ tool: CODE_TOOL[hs.t], color: hs.c, width: hs.w, pts })
    }
    return {
      bg: BGS.has(header.bg) ? header.bg : 'blank',
      orient: header.o === 'landscape' ? 'landscape' : 'portrait',
      strokes,
    }
  } catch {
    return null
  }
}

export interface NotebookData {
  bg: Background
  orient: Orientation
  pages: PageData[]
}

/** Transforme les données lues en pages et traits locaux (identifiants neufs). */
export function dataToContent(notebookId: string, data: NotebookData): NotebookContent {
  const pages: Page[] = []
  const strokes: Stroke[] = []
  for (const dp of data.pages) {
    const page: Page = { id: uid(), notebookId, bg: dp.bg, orient: dp.orient, rev: 0 }
    pages.push(page)
    dp.strokes.forEach((s, seq) => strokes.push({ ...s, id: uid(), pageId: page.id, seq }))
  }
  return { pages, strokes }
}
