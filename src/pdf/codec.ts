// Format of the editable data embedded in each page of the PDF.
//
// One block per page: [header length on 4 bytes][JSON header][points].
// The header describes the page and its strokes; the points are integers
// (hundredths of a point, pressure out of 255) delta-encoded then stored as
// varints, which compresses very well.

import { COVER_TEMPLATES, type Cover } from '../covers'
import { uid, type Asset, type Background, type Orientation, type Page, type Stroke, type StrokeTool } from '../model'
import type { NotebookContent } from '../db'

export const FORMAT_VERSION = 1

interface HeaderStroke {
  t: 'p' | 'g' | 'h' | 'l' | 'i'
  c: string
  w: number
  n: number
  /** Images only: number of the picture among those of the page ("Im0", "Im1"…). */
  im?: number
}

interface Header {
  bg: Background
  o: Orientation
  s: HeaderStroke[]
  /** 1 when the page is a page of an imported PDF. */
  pdf?: 1
  /** Name of the page's bookmark. */
  bm?: string
  /** Cover design of the page. */
  cv?: Cover
}

export interface PageData {
  bg: Background
  orient: Orientation
  strokes: (Pick<Stroke, 'tool' | 'color' | 'width' | 'pts' | 'image'> & { imageIndex?: number })[]
  /** Page of an imported PDF: its size, and its number in the PDF kept as `asset`. */
  pdf?: boolean
  w?: number
  h?: number
  pdfIndex?: number
  bookmark?: string
  cover?: Cover
}

const TOOL_CODE: Record<StrokeTool, HeaderStroke['t']> = { pen: 'p', pencil: 'g', highlighter: 'h', line: 'l', image: 'i' }
const CODE_TOOL: Record<HeaderStroke['t'], StrokeTool> = { p: 'pen', g: 'pencil', h: 'highlighter', l: 'line', i: 'image' }
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
    // zigzag: small numbers, positive or negative, fit in one byte
    let u = v < 0 ? -2 * v - 1 : 2 * v
    while (u >= 128) {
      this.buf[this.len++] = (u % 128) | 128
      u = Math.floor(u / 128)
    }
    this.buf[this.len++] = u
  }
}

export function encodePage(page: Pick<Page, 'bg' | 'orient' | 'pdf' | 'bookmark' | 'cover'>, strokes: Pick<Stroke, 'tool' | 'color' | 'width' | 'pts'>[]): Uint8Array {
  let images = 0
  const header: Header = {
    bg: page.bg,
    o: page.orient,
    ...(page.pdf ? { pdf: 1 as const } : {}),
    ...(page.bookmark ? { bm: page.bookmark } : {}),
    ...(page.cover ? { cv: page.cover } : {}),
    s: strokes.map((s) => ({
      t: TOOL_CODE[s.tool],
      c: s.color,
      w: Math.round(s.width * 100) / 100,
      n: s.pts.length / 3,
      // The picture itself is stored once, as an ordinary PDF image.
      ...(s.tool === 'image' ? { im: images++ } : {}),
    })),
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
      // x and y: second difference (a smooth curve gives small numbers)
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
        if (pos >= bytes.length) throw new Error('truncated data')
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
      if (CODE_TOOL[hs.t]) strokes.push({ tool: CODE_TOOL[hs.t], color: hs.c, width: hs.w, pts, ...(hs.im !== undefined ? { imageIndex: hs.im } : {}) })
    }
    return {
      bg: BGS.has(header.bg) ? header.bg : 'blank',
      orient: header.o === 'landscape' ? 'landscape' : 'portrait',
      strokes,
      ...(header.pdf ? { pdf: true } : {}),
      ...(typeof header.bm === 'string' && header.bm ? { bookmark: header.bm } : {}),
      ...(header.cv && COVER_TEMPLATES.some((t) => t.id === header.cv!.template) && typeof header.cv.title === 'string' && /^#[0-9a-f]{6}$/i.test(header.cv.color)
        ? { cover: { template: header.cv.template, title: header.cv.title, color: header.cv.color, ...(typeof header.cv.subtitle === 'string' ? { subtitle: header.cv.subtitle } : {}) } }
        : {}),
    }
  } catch {
    return null
  }
}

export interface NotebookData {
  bg: Background
  orient: Orientation
  pages: PageData[]
  /** The imported PDF the pages come from, without anything written by Plume. */
  asset?: Uint8Array
}

/** Turns the data read into local pages and strokes (fresh ids). */
export function dataToContent(notebookId: string, data: NotebookData): NotebookContent {
  const pages: Page[] = []
  const strokes: Stroke[] = []
  const assets: Asset[] = data.asset ? [{ id: uid(), notebookId, bytes: data.asset }] : []
  for (const dp of data.pages) {
    const page: Page = { id: uid(), notebookId, bg: dp.bg, orient: dp.orient, rev: 0 }
    if (dp.bookmark) page.bookmark = dp.bookmark
    if (dp.cover) page.cover = dp.cover
    if (dp.pdfIndex !== undefined && assets.length && dp.w && dp.h) Object.assign(page, { w: dp.w, h: dp.h, pdf: { asset: assets[0].id, index: dp.pdfIndex } } satisfies Partial<Page>)
    pages.push(page)
    dp.strokes.forEach(({ imageIndex: _i, ...s }, seq) => strokes.push({ ...s, id: uid(), pageId: page.id, seq }))
  }
  return { pages, strokes, assets }
}
