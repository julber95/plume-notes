import { describe, expect, it } from 'vitest'
import { PDFArray, PDFDocument, StandardFonts, degrees } from 'pdf-lib'
import { buildNotebookPdf, type PdfNotebookInput } from '../src/pdf/build'
import { dataToContent } from '../src/pdf/codec'
import { extractPlumeData } from '../src/pdf/extract'
import { letter, rng } from './helpers'

/** A PDF as a teacher would hand it out: text, an odd page size, a page turned sideways. */
async function handout(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const a4 = doc.addPage([595.28, 841.89])
  a4.drawText('Chapter 1: limits', { x: 60, y: 760, size: 22, font })
  const letterSize = doc.addPage([612, 792])
  letterSize.drawText('Exercise sheet', { x: 60, y: 720, size: 18, font })
  const sideways = doc.addPage([595.28, 841.89])
  sideways.setRotation(degrees(90))
  sideways.drawText('A slide, turned sideways', { x: 60, y: 760, size: 18, font })
  return doc.save()
}

const contentStreams = async (bytes: Uint8Array, page: number) => {
  const c = (await PDFDocument.load(bytes)).getPage(page).node.Contents()
  return c instanceof PDFArray ? c.size() : 1
}

describe('importing a PDF', () => {
  it('turns an ordinary PDF into pages to write on, at their own size', async () => {
    const source = await handout()
    const data = (await extractPlumeData(source))!
    expect(data.asset).toBe(source) // kept exactly as it is
    expect(data.pages.map((p) => [p.pdf, p.pdfIndex, Math.round(p.w!), Math.round(p.h!), p.orient])).toEqual([
      [true, 0, 595, 842, 'portrait'],
      [true, 1, 612, 792, 'portrait'],
      [true, 2, 842, 595, 'landscape'], // displayed turned
    ])
    const content = dataToContent('nb', data)
    expect(content.assets!.length).toBe(1)
    expect(content.pages.map((p) => p.pdf?.index)).toEqual([0, 1, 2])
  })

  it('exports the original pages with the writing on top, and reads both back', async () => {
    const rand = rng(3)
    const source = await handout()
    const content = dataToContent('nb', (await extractPlumeData(source))!)
    const [p1, p2, p3] = content.pages
    const blank = { id: 'extra', notebookId: 'nb', bg: 'grid' as const, orient: 'portrait' as const, rev: 0 }
    const nb: PdfNotebookInput = {
      name: 'Annotated',
      bg: 'blank',
      orient: 'portrait',
      assets: new Map(content.assets!.map((a) => [a.id, a.bytes])),
      pages: [
        { ...p1, strokes: [letter(p1.id, 100, 100, 0, rand), letter(p1.id, 130, 100, 1, rand, 'highlighter')] },
        { ...blank, strokes: [letter('extra', 200, 200, 0, rand)] }, // a page of notes added in between
        { ...p2, strokes: [] },
        { ...p3, strokes: [letter(p3.id, 400, 300, 0, rand)] },
      ],
    }
    const out = await buildNotebookPdf(nb)
    ;(globalThis as { __keep?: (b: Uint8Array) => void }).__keep?.(out)
    const doc = await PDFDocument.load(out)
    expect(doc.getPageCount()).toBe(4)
    expect(doc.getPages().map((p) => [Math.round(p.getWidth()), Math.round(p.getHeight()), p.getRotation().angle])).toEqual([
      [595, 842, 0],
      [595, 842, 0],
      [612, 792, 0],
      [595, 842, 90],
    ])

    const back = (await extractPlumeData(out))!
    expect(back.pages.map((p) => [!!p.pdf, p.pdfIndex, p.strokes.length])).toEqual([
      [true, 0, 2],
      [false, undefined, 1],
      [true, 1, 0],
      [true, 2, 1],
    ])
    // The PDF kept for editing is the original again: three pages, nothing of Plume left on them.
    const kept = await PDFDocument.load(back.asset!)
    expect(kept.getPageCount()).toBe(3)
    expect(await contentStreams(back.asset!, 0)).toBe(await contentStreams(source, 0))
    for (const page of kept.getPages()) expect(page.node.get(kept.context.obj('PieceInfo') as never)).toBeUndefined()

    // A second trip does not pile anything up.
    const again = dataToContent('nb', back)
    const out2 = await buildNotebookPdf({
      name: 'Annotated',
      bg: back.bg,
      orient: back.orient,
      assets: new Map(again.assets!.map((a) => [a.id, a.bytes])),
      pages: again.pages.map((p) => ({ ...p, strokes: again.strokes.filter((s) => s.pageId === p.id) })),
    })
    const back2 = (await extractPlumeData(out2))!
    expect(back2.pages.map((p) => p.strokes.length)).toEqual([2, 1, 0, 1])
    expect(await contentStreams(back2.asset!, 0)).toBe(await contentStreams(source, 0))
    expect(Math.abs(out2.length - out.length)).toBeLessThan(out.length * 0.05)
  })

  it('refuses a password-protected PDF', async () => {
    const doc = await PDFDocument.create()
    doc.addPage()
    doc.context.trailerInfo.Encrypt = doc.context.register(doc.context.obj({ Filter: 'Standard', V: 1, R: 2 }))
    expect(await extractPlumeData(await doc.save())).toBeNull()
  })
})
