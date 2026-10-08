// Builds the PDF of a notebook: vector pages identical to the screen, each
// carrying its editable data (PieceInfo dictionary, the mechanism the PDF
// format provides for an application's private data).

import { PDFDocument, PDFName, PDFString, type PDFRef } from 'pdf-lib'
import { strToU8, zlibSync } from 'fflate'
import { backgroundSpec } from '../backgrounds'
import { HIGHLIGHTER_ALPHA, THINNING, centerline, hexToRgb, penOutline, simplify, smoothClosed } from '../geometry'
import { GRAIN_TILE, PENCIL_BASE_ALPHA, PENCIL_GRAIN_ALPHA, grainSpecks } from '../grain'
import { pageSize, type Background, type Orientation, type Page, type Stroke } from '../model'
import { FORMAT_VERSION, encodePage } from './codec'

export interface PdfPageInput extends Pick<Page, 'id' | 'bg' | 'orient' | 'rev'> {
  strokes: Stroke[]
}

export interface PdfNotebookInput {
  name: string
  bg: Background
  orient: Orientation
  pages: PdfPageInput[]
}

export interface PageCacheEntry {
  rev: number
  /** Drawing of the page (compressed PDF stream). */
  content: Uint8Array
  /** Editable data of the page (compressed). */
  data: Uint8Array
}

/** Already computed page renderings, so that only modified pages are redone. */
export type PageCache = Map<string, PageCacheEntry>

const num = (v: number) => String(Math.round(v * 100) / 100)
/** Precision of 0.05 pt (0.02 mm), enough for an outline. */
const fine = (v: number) => String(Math.round(v * 20) / 20)

function rgb(hex: string): string {
  const [r, g, b] = hexToRgb(hex)
  return `${num(r)} ${num(g)} ${num(b)}`
}

/** Path expressed relative to its first point, for short numbers. */
function localPath(flat: ArrayLike<number>, paint: string): string {
  const ox = Math.round(flat[0])
  const oy = Math.round(flat[1])
  let s = `q 1 0 0 1 ${ox} ${oy} cm\n${fine(flat[0] - ox)} ${fine(flat[1] - oy)} m\n`
  for (let i = 2; i < flat.length; i += 2) s += `${fine(flat[i] - ox)} ${fine(flat[i + 1] - oy)} l\n`
  // A single point: zero-length segment, rendered as a round dot.
  if (flat.length === 2) s += `${fine(flat[0] - ox)} ${fine(flat[1] - oy)} l\n`
  return `${s}${paint} Q\n`
}

function strokedPath(s: Stroke): string {
  return `${rgb(s.color)} RG ${num(s.width)} w\n${localPath(centerline(s.pts), 'S')}`
}

function pageContent(page: PdfPageInput): string {
  const { h } = pageSize(page.orient)
  let out = `q 1 0 0 -1 0 ${num(h)} cm\n`
  if (page.bg !== 'blank') out += '/Bg Do\n'
  out += '1 J 1 j\n'
  const highlights = page.strokes.filter((s) => s.tool === 'highlighter')
  if (highlights.length) {
    out += 'q /GSh gs\n'
    for (const s of highlights) out += strokedPath(s)
    out += 'Q\n'
  }
  let fill = ''
  for (const s of page.strokes) {
    if (s.tool === 'pen') {
      // Outline rounded as on screen, then lightened: maximum deviation 0.05 pt (0.02 mm).
      const outline = simplify(smoothClosed(penOutline(s.pts, s.width)), 0.05)
      if (outline.length < 4) continue
      const color = rgb(s.color)
      if (color !== fill) out += `${(fill = color)} rg\n`
      out += localPath(outline, 'f')
    } else if (s.tool === 'pencil') {
      const outline = simplify(smoothClosed(penOutline(s.pts, s.width, true, THINNING.pencil)), 0.05)
      if (outline.length < 4) continue
      // An even light layer, then the grain pattern on top, both in the stroke's colour.
      const color = rgb(s.color)
      out += `q /GSb gs ${color} rg\n${localPath(outline, 'f')}/GSg gs /CsG cs ${color} /Grain scn\n${localPath(outline, 'f')}Q\n`
      fill = ''
    } else if (s.tool === 'line') {
      out += strokedPath(s)
    }
  }
  return out + 'Q\n'
}

function backgroundContent(bg: Background, w: number, h: number): string {
  const spec = backgroundSpec(bg, w, h)
  let out = ''
  for (const g of spec.lines) {
    out += `${rgb(g.color)} RG ${num(g.width)} w 0 J\n`
    for (let i = 0; i < g.segs.length; i += 4) {
      out += `${num(g.segs[i])} ${num(g.segs[i + 1])} m ${num(g.segs[i + 2])} ${num(g.segs[i + 3])} l\n`
    }
    out += 'S\n'
  }
  const d = spec.dots
  if (d) {
    out += `${rgb(d.color)} RG ${num(d.radius * 2)} w 1 J\n`
    for (let j = 0; j < d.ny; j++) {
      for (let i = 0; i < d.nx; i++) {
        const p = `${num(d.x0 + i * d.step)} ${num(d.y0 + j * d.step)}`
        out += `${p} m ${p} l\n`
      }
    }
    out += 'S\n'
  }
  return out
}

export function renderPage(page: PdfPageInput): PageCacheEntry {
  return {
    rev: page.rev,
    content: zlibSync(strToU8(pageContent(page)), { level: 6 }),
    data: zlibSync(encodePage(page, page.strokes), { level: 6 }),
  }
}

export async function buildNotebookPdf(nb: PdfNotebookInput, cache: PageCache = new Map()): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.setTitle(nb.name)
  doc.setProducer('Plume')
  doc.setCreator('Plume')
  const ctx = doc.context
  const flate = { Filter: 'FlateDecode' }
  const stamp = PDFString.fromDate(new Date())
  const PieceInfo = PDFName.of('PieceInfo')
  const LastModified = PDFName.of('LastModified')

  const highlighterState = ctx.register(ctx.obj({ Type: 'ExtGState', CA: HIGHLIGHTER_ALPHA, ca: HIGHLIGHTER_ALPHA, BM: 'Multiply' }))
  const backgrounds = new Map<string, PDFRef>()
  // Pencil grain: a repeating pattern of specks, painted in any colour.
  let grain = ''
  const specks = grainSpecks()
  for (let i = 0; i < specks.length; i += 4) grain += `${specks[i]} ${specks[i + 1]} ${specks[i + 2]} ${specks[i + 3]} re\n`
  const grainPattern = ctx.register(
    ctx.stream(zlibSync(strToU8(`${grain}f\n`), { level: 6 }), {
      Type: 'Pattern',
      PatternType: 1,
      PaintType: 2,
      TilingType: 1,
      BBox: [0, 0, GRAIN_TILE, GRAIN_TILE],
      XStep: GRAIN_TILE,
      YStep: GRAIN_TILE,
      Resources: {},
      ...flate,
    }),
  )
  const pencilBase = ctx.register(ctx.obj({ Type: 'ExtGState', CA: PENCIL_BASE_ALPHA, ca: PENCIL_BASE_ALPHA }))
  const pencilGrain = ctx.register(ctx.obj({ Type: 'ExtGState', CA: PENCIL_GRAIN_ALPHA, ca: PENCIL_GRAIN_ALPHA }))
  const grainResources = { pattern: ctx.obj({ Grain: grainPattern }), space: ctx.obj({ CsG: ['Pattern', 'DeviceRGB'] }) }

  for (const p of nb.pages) {
    const { w, h } = pageSize(p.orient)
    let entry = cache.get(p.id)
    if (!entry || entry.rev !== p.rev) {
      entry = renderPage(p)
      cache.set(p.id, entry)
    }

    const page = doc.addPage([w, h])
    page.node.addContentStream(ctx.register(ctx.stream(entry.content, flate)))
    page.node.setExtGState(PDFName.of('GSh'), highlighterState)
    page.node.setExtGState(PDFName.of('GSb'), pencilBase)
    page.node.setExtGState(PDFName.of('GSg'), pencilGrain)
    const resources = page.node.normalizedEntries().Resources
    resources.set(PDFName.of('Pattern'), grainResources.pattern)
    resources.set(PDFName.of('ColorSpace'), grainResources.space)
    if (p.bg !== 'blank') {
      const key = `${p.bg}/${p.orient}`
      let ref = backgrounds.get(key)
      if (!ref) {
        const body = zlibSync(strToU8(backgroundContent(p.bg, w, h)), { level: 6 })
        ref = ctx.register(ctx.stream(body, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, w, h], Resources: {}, ...flate }))
        backgrounds.set(key, ref)
      }
      page.node.setXObject(PDFName.of('Bg'), ref)
    }
    const data = ctx.register(ctx.stream(entry.data, flate))
    page.node.set(LastModified, stamp)
    page.node.set(PieceInfo, ctx.obj({ Plume: { LastModified: stamp, Private: data } }))
  }

  doc.catalog.set(
    PieceInfo,
    ctx.obj({ Plume: { LastModified: stamp, Private: { Version: FORMAT_VERSION, Bg: nb.bg, Orient: nb.orient } } }),
  )
  return doc.save()
}
