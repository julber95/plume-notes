// Fabrication du PDF d'un bloc-notes : pages vectorielles identiques à l'écran,
// chacune accompagnée de ses données modifiables (dictionnaire PieceInfo, le
// mécanisme prévu par le format PDF pour les données privées d'une application).

import { PDFDocument, PDFName, PDFString, type PDFRef } from 'pdf-lib'
import { strToU8, zlibSync } from 'fflate'
import { backgroundSpec } from '../backgrounds'
import { HIGHLIGHTER_ALPHA, centerline, hexToRgb, penOutline, simplify, smoothClosed } from '../geometry'
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
  /** Dessin de la page (flux PDF compressé). */
  content: Uint8Array
  /** Données modifiables de la page (compressées). */
  data: Uint8Array
}

/** Rendu des pages déjà calculé, pour ne refaire que les pages modifiées. */
export type PageCache = Map<string, PageCacheEntry>

const num = (v: number) => String(Math.round(v * 100) / 100)
/** Précision de 0,05 pt (0,02 mm), suffisante pour un contour. */
const fine = (v: number) => String(Math.round(v * 20) / 20)

function rgb(hex: string): string {
  const [r, g, b] = hexToRgb(hex)
  return `${num(r)} ${num(g)} ${num(b)}`
}

/** Chemin exprimé par rapport à son premier point, pour des nombres courts. */
function localPath(flat: ArrayLike<number>, paint: string): string {
  const ox = Math.round(flat[0])
  const oy = Math.round(flat[1])
  let s = `q 1 0 0 1 ${ox} ${oy} cm\n${fine(flat[0] - ox)} ${fine(flat[1] - oy)} m\n`
  for (let i = 2; i < flat.length; i += 2) s += `${fine(flat[i] - ox)} ${fine(flat[i + 1] - oy)} l\n`
  // Un point isolé : segment de longueur nulle, rendu comme un point rond.
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
      // Contour arrondi comme à l'écran, puis allégé : écart maximal de 0,05 pt (0,02 mm).
      const outline = simplify(smoothClosed(penOutline(s.pts, s.width)), 0.05)
      if (outline.length < 4) continue
      const color = rgb(s.color)
      if (color !== fill) out += `${(fill = color)} rg\n`
      out += localPath(outline, 'f')
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
