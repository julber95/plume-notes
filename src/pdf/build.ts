// Builds the PDF of a notebook: vector pages identical to the screen, each
// carrying its editable data (PieceInfo dictionary, the mechanism the PDF
// format provides for an application's private data).

import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFString, type PDFImage, type PDFPage, type PDFRef } from 'pdf-lib'
import { strToU8, zlibSync } from 'fflate'
import { backgroundSpec } from '../backgrounds'
import { centerline, hexToRgb, highlightRgb, penOutline, pencilOutline, simplify, smoothClosed } from '../geometry'
import { GRAIN_TILE, PENCIL_LEVELS, grainSpecks, pencilAlpha, pencilLevel } from '../grain'
import { pageSize, type Background, type Orientation, type Page, type Stroke } from '../model'
import { FORMAT_VERSION, encodePage } from './codec'
import { pageFrame } from './pagebox'

export interface PdfPageInput extends Pick<Page, 'id' | 'bg' | 'orient' | 'rev' | 'w' | 'h' | 'pdf' | 'bookmark'> {
  strokes: Stroke[]
  /** Pictures of the page, when `strokes` was not loaded because the page is cached. */
  imageStrokes?: Stroke[]
}

export interface PdfNotebookInput {
  name: string
  bg: Background
  orient: Orientation
  pages: PdfPageInput[]
  /** Imported PDFs the pages refer to, by id. */
  assets?: Map<string, Uint8Array>
}

export interface PageCacheEntry {
  rev: number
  /** Drawing of the page (compressed PDF stream). */
  content: Uint8Array
  /** Editable data of the page (compressed). */
  data: Uint8Array
  /** Ids of the page's pictures, in the order of their names ("Im0", "Im1"…). */
  images?: string[]
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

const pictures = (page: PdfPageInput) => page.strokes.filter((s) => s.tool === 'image' && s.image && s.pts.length >= 6)

/**
 * What Plume draws on a page, in screen-like coordinates (origin at the top
 * left, y down). The caller sets up those coordinates and closes them.
 * Resource names start with "Plm" so they never clash with those of an
 * imported PDF.
 */
function pageContent(page: PdfPageInput): string {
  let out = ''
  if (page.bg !== 'blank' && !page.pdf) out += '/PlmBg Do\n'
  // Pictures first: ink and highlighter go over them.
  pictures(page).forEach((s, i) => {
    const x = Math.min(s.pts[0], s.pts[3])
    const y = Math.min(s.pts[1], s.pts[4])
    const w = Math.abs(s.pts[3] - s.pts[0])
    const h = Math.abs(s.pts[4] - s.pts[1])
    out += `q ${num(w)} 0 0 ${num(-h)} ${num(x)} ${num(y + h)} cm /PlmIm${i} Do Q\n`
  })
  out += '1 J 1 j\n'
  const highlights = page.strokes.filter((s) => s.tool === 'highlighter')
  if (highlights.length) {
    out += 'q /PlmGSh gs\n'
    for (const s of highlights) out += `${highlightRgb(s.color).map(num).join(' ')} RG ${num(s.width)} w\n${localPath(centerline(s.pts), 'S')}`
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
      const outline = simplify(smoothClosed(pencilOutline(s.pts, s.width)), 0.05)
      if (outline.length < 4) continue
      // An even light layer, then the grain pattern on top, both in the stroke's colour.
      const color = rgb(s.color)
      const level = pencilLevel(s.pts)
      out += `q /PlmGSb${level} gs ${color} rg\n${localPath(outline, 'f')}/PlmGSg${level} gs /PlmCsG cs ${color} /PlmGrain scn\n${localPath(outline, 'f')}Q\n`
      fill = ''
    } else if (s.tool === 'line') {
      out += strokedPath(s)
    }
  }
  return out
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
    data: zlibSync(encodePage(page, page.strokes.filter((s) => s.tool !== 'image' || pictures(page).includes(s))), { level: 6 }),
    images: pictures(page).map((s) => s.id),
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

  const highlighterState = ctx.register(ctx.obj({ Type: 'ExtGState', BM: 'Darken' }))
  const backgrounds = new Map<string, PDFRef>()
  const embedded = new Map<Uint8Array, PDFImage>()
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
  const pencilStates = Array.from({ length: PENCIL_LEVELS }, (_, level) => {
    const { base, grain } = pencilAlpha(level)
    return { base: ctx.register(ctx.obj({ Type: 'ExtGState', CA: base, ca: base })), grain: ctx.register(ctx.obj({ Type: 'ExtGState', CA: grain, ca: grain })) }
  })
  const pop = ctx.register(ctx.stream('Q\n'))

  // Pages of imported PDFs are copied from their source, all those of one
  // source together so that what they share (fonts…) is copied only once.
  const copies = new Map<PdfPageInput, PDFPage>()
  const bySource = new Map<string, PdfPageInput[]>()
  for (const p of nb.pages) if (p.pdf && nb.assets?.has(p.pdf.asset)) bySource.set(p.pdf.asset, [...(bySource.get(p.pdf.asset) ?? []), p])
  for (const [asset, users] of bySource) {
    const source = await PDFDocument.load(nb.assets!.get(asset)!, { updateMetadata: false })
    // A source page used twice (a duplicated page) needs a copy of its own.
    const pending = users.filter((p) => p.pdf!.index < source.getPageCount())
    while (pending.length) {
      const seen = new Set<number>()
      const batch = pending.filter((p) => !seen.has(p.pdf!.index) && seen.add(p.pdf!.index))
      const copied = await doc.copyPages(source, batch.map((p) => p.pdf!.index))
      batch.forEach((p, i) => copies.set(p, copied[i]))
      for (const p of batch) pending.splice(pending.indexOf(p), 1)
    }
  }

  /** Gives the page resources of its own (a PDF may share them between pages) and returns its dictionaries. */
  const ownResources = (page: PDFPage): Record<'XObject' | 'ExtGState' | 'Pattern' | 'ColorSpace', PDFDict> => {
    const shared = page.node.Resources()
    const own = shared ? shared.clone(ctx) : ctx.obj({})
    const out = {} as Record<string, PDFDict>
    for (const key of ['XObject', 'ExtGState', 'Pattern', 'ColorSpace']) {
      const name = PDFName.of(key)
      const dict = own.lookupMaybe(name, PDFDict)
      out[key] = dict ? dict.clone(ctx) : ctx.obj({})
      own.set(name, out[key])
    }
    page.node.set(PDFName.of('Resources'), own)
    return out
  }

  const bookmarks: { title: string; page: PDFRef }[] = []
  for (const p of nb.pages) {
    let entry = cache.get(p.id)
    if (!entry || entry.rev !== p.rev) {
      entry = renderPage(p)
      cache.set(p.id, entry)
    }

    const copy = copies.get(p)
    let page: PDFPage
    let w: number
    let h: number
    let matrix: number[]
    const added: PDFRef[] = []
    if (copy) {
      // The original page, untouched and closed off, then Plume's layer on top.
      page = doc.addPage(copy)
      ;({ w, h, matrix } = pageFrame(page))
      // The library closes off the original content itself, with these two
      // shared streams, the first time the page is modified.
      page.node.normalize()
      added.push(ctx.getPushGraphicsStateContentStream(), ctx.getPopGraphicsStateContentStream())
    } else {
      ;({ w, h } = pageSize(p))
      page = doc.addPage([w, h])
      matrix = [1, 0, 0, -1, 0, h]
    }
    const open = ctx.register(ctx.stream(`q ${matrix.map(num).join(' ')} cm\n`))
    const content = ctx.register(ctx.stream(entry.content, flate))
    added.push(open, content, pop)
    for (const ref of [open, content, pop]) page.node.addContentStream(ref)

    const res = ownResources(page)
    res.ExtGState.set(PDFName.of('PlmGSh'), highlighterState)
    pencilStates.forEach((st, level) => {
      res.ExtGState.set(PDFName.of(`PlmGSb${level}`), st.base)
      res.ExtGState.set(PDFName.of(`PlmGSg${level}`), st.grain)
    })
    res.Pattern.set(PDFName.of('PlmGrain'), grainPattern)
    res.ColorSpace.set(PDFName.of('PlmCsG'), ctx.obj(['Pattern', 'DeviceRGB']))
    if (p.bg !== 'blank' && !copy) {
      const key = `${p.bg}/${w}/${h}`
      let ref = backgrounds.get(key)
      if (!ref) {
        const body = zlibSync(strToU8(backgroundContent(p.bg, w, h)), { level: 6 })
        ref = ctx.register(ctx.stream(body, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, w, h], Resources: {}, ...flate }))
        backgrounds.set(key, ref)
      }
      res.XObject.set(PDFName.of('PlmBg'), ref)
    }
    if (entry.images?.length) {
      const byId = new Map([...p.strokes, ...(p.imageStrokes ?? [])].map((s) => [s.id, s]))
      for (let i = 0; i < entry.images.length; i++) {
        const bytes = byId.get(entry.images[i])?.image?.data
        if (!bytes) continue
        let image = embedded.get(bytes)
        if (!image) embedded.set(bytes, (image = await doc.embedJpg(bytes)))
        res.XObject.set(PDFName.of(`PlmIm${i}`), image.ref)
      }
    }
    if (p.bookmark) bookmarks.push({ title: p.bookmark, page: page.ref })
    const data = ctx.register(ctx.stream(entry.data, flate))
    page.node.set(LastModified, stamp)
    // `Added` lists what Plume put on the page, so it can be taken off again
    // to get the original page back.
    page.node.set(PieceInfo, ctx.obj({ Plume: { LastModified: stamp, Private: data, Added: added } }))
  }

  if (bookmarks.length) {
    // Real PDF bookmarks: any PDF reader lists them in its bookmarks panel.
    const outline = ctx.nextRef()
    const items = bookmarks.map(() => ctx.nextRef())
    bookmarks.forEach((b, i) => {
      const item = ctx.obj({ Title: PDFHexString.fromText(b.title), Parent: outline, Dest: [b.page, 'Fit'] })
      if (i > 0) item.set(PDFName.of('Prev'), items[i - 1])
      if (i < items.length - 1) item.set(PDFName.of('Next'), items[i + 1])
      ctx.assign(items[i], item)
    })
    ctx.assign(outline, ctx.obj({ Type: 'Outlines', First: items[0], Last: items[items.length - 1], Count: items.length }))
    doc.catalog.set(PDFName.of('Outlines'), outline)
  }

  doc.catalog.set(
    PieceInfo,
    ctx.obj({ Plume: { LastModified: stamp, Private: { Version: FORMAT_VERSION, Bg: nb.bg, Orient: nb.orient } } }),
  )
  return doc.save()
}
