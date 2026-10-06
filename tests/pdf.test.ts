import { describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { buildNotebookPdf, type PageCache, type PdfNotebookInput } from '../src/pdf/build'
import { extractPlumeData } from '../src/pdf/extract'
import { dataToContent, decodePage, encodePage } from '../src/pdf/codec'
import { A4, type Stroke } from '../src/model'
import { letter, rng, writtenPage } from './helpers'

function notebook(): PdfNotebookInput {
  const rand = rng(1)
  const p1: Stroke[] = [
    letter('p1', 100, 100, 0, rand),
    letter('p1', 120, 100, 1, rand, 'highlighter'),
    { ...letter('p1', 0, 0, 2, rand), tool: 'line', color: '#c62828', width: 2, pts: Float32Array.from([50, 200, 0.5, 300, 240, 0.5]) },
    { ...letter('p1', 0, 0, 3, rand), pts: Float32Array.from([400, 400, 0.6]) },
  ]
  return {
    name: 'Analyse — chapitre 1',
    bg: 'grid',
    orient: 'portrait',
    pages: [
      { id: 'p1', bg: 'grid', orient: 'portrait', rev: 1, strokes: p1 },
      { id: 'p2', bg: 'seyes', orient: 'landscape', rev: 0, strokes: [] },
      { id: 'p3', bg: 'dots', orient: 'portrait', rev: 0, strokes: [letter('p3', 200, 300, 0, rand)] },
      { id: 'p4', bg: 'lined', orient: 'portrait', rev: 0, strokes: [] },
      { id: 'p5', bg: 'blank', orient: 'portrait', rev: 0, strokes: [] },
    ],
  }
}

describe('codage des points', () => {
  it('restitue les points au centième de point près', () => {
    const pts = Float32Array.from([12.345, 678.9, 0.5, 12.5, 679.25, 0.75, 0, 0, 0, 595.28, 841.89, 1])
    const page = decodePage(encodePage({ bg: 'dots', orient: 'landscape' }, [{ tool: 'pen', color: '#102030', width: 1.3, pts }, { tool: 'highlighter', color: '#ffee00', width: 12, pts }]))!
    expect([page.bg, page.orient, page.strokes.length, page.strokes[1].tool, page.strokes[1].color]).toEqual(['dots', 'landscape', 2, 'highlighter', '#ffee00'])
    const back = page.strokes[1].pts
    expect(back.length).toBe(pts.length)
    for (let i = 0; i < pts.length; i++) expect(Math.abs(back[i] - pts[i])).toBeLessThan(i % 3 === 2 ? 0.003 : 0.006)
  })
})

describe('export PDF', () => {
  it('produit un PDF valide, au bon format, relisible par un lecteur standard', async () => {
    const bytes = await buildNotebookPdf(notebook())
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-')
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBe(5)
    expect(doc.getTitle()).toBe('Analyse — chapitre 1')
    const s1 = doc.getPage(0).getSize()
    expect(s1.width).toBeCloseTo(A4.w, 1)
    expect(s1.height).toBeCloseTo(A4.h, 1)
    const s2 = doc.getPage(1).getSize()
    expect(s2.width).toBeCloseTo(A4.h, 1)
  })

  it('aller-retour : chaque trait reste modifiable après export puis relecture', async () => {
    const nb = notebook()
    const data = await extractPlumeData(await buildNotebookPdf(nb))
    expect(data).not.toBeNull()
    const content = dataToContent('nb', data!)
    expect(data!.bg).toBe('grid')
    expect(content.pages.map((p) => [p.bg, p.orient])).toEqual(nb.pages.map((p) => [p.bg, p.orient]))
    nb.pages.forEach((src, i) => {
      const got = content.strokes.filter((s) => s.pageId === content.pages[i].id)
      expect(got.length).toBe(src.strokes.length)
      got.forEach((g, k) => {
        const o = src.strokes[k]
        expect([g.tool, g.color, g.width]).toEqual([o.tool, o.color, o.width])
        expect(g.pts.length).toBe(o.pts.length)
        for (let j = 0; j < o.pts.length; j++) expect(Math.abs(g.pts[j] - o.pts[j])).toBeLessThan(0.006)
      })
    })
  })

  it('un second export après relecture donne le même contenu', async () => {
    const first = await extractPlumeData(await buildNotebookPdf(notebook()))
    const c = dataToContent('nb', first!)
    const again = await buildNotebookPdf({
      name: 'x',
      bg: first!.bg,
      orient: first!.orient,
      pages: c.pages.map((p) => ({ ...p, strokes: c.strokes.filter((s) => s.pageId === p.id) })),
    })
    const second = await extractPlumeData(again)
    expect(second).toEqual(first)
  })

  it('un PDF ordinaire est reconnu comme étranger à Plume', async () => {
    const doc = await PDFDocument.create()
    doc.addPage()
    expect(await extractPlumeData(await doc.save())).toBeNull()
    expect(await extractPlumeData(new Uint8Array([1, 2, 3]))).toBeNull()
  })

  it('ne recalcule que les pages modifiées', async () => {
    const nb = notebook()
    const cache: PageCache = new Map()
    await buildNotebookPdf(nb, cache)
    const before = cache.get('p3')!.content
    nb.pages[0].rev++
    nb.pages[0].strokes = nb.pages[0].strokes.slice(0, 1)
    const data = await extractPlumeData(await buildNotebookPdf(nb, cache))
    expect(cache.get('p3')!.content).toBe(before)
    expect(data!.pages[0].strokes.length).toBe(1)
  })

  it('reste d’une taille raisonnable pour 50 pages d’écriture dense', async () => {
    const pages = Array.from({ length: 50 }, (_, i) => ({
      id: `p${i}`,
      bg: 'seyes' as const,
      orient: 'portrait' as const,
      rev: 0,
      strokes: writtenPage(`p${i}`, i + 1),
    }))
    const t0 = performance.now()
    const cache: PageCache = new Map()
    const bytes = await buildNotebookPdf({ name: 'Gros cours', bg: 'seyes', orient: 'portrait', pages }, cache)
    const t1 = performance.now()
    pages[49].rev++
    await buildNotebookPdf({ name: 'Gros cours', bg: 'seyes', orient: 'portrait', pages }, cache)
    const t2 = performance.now()
    const data = await extractPlumeData(bytes)
    const t3 = performance.now()
    console.log(
      `50 pages, ${pages.length * pages[0].strokes.length} traits : ${(bytes.length / 1e6).toFixed(1)} Mo, ` +
        `export complet ${Math.round(t1 - t0)} ms, export après 1 page modifiée ${Math.round(t2 - t1)} ms, relecture ${Math.round(t3 - t2)} ms`,
    )
    expect(data!.pages.length).toBe(50)
    expect(bytes.length).toBeLessThan(40e6)
  }, 120000)
})
