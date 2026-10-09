// Picture of a notebook's first page, shown on its card in the library. It is
// drawn once, kept on the device, and redrawn only when the notebook changes.

import { getAsset, getPages, getStrokes, kvGet, kvSet } from '../db'
import { pageSize, type LibNode } from '../model'
import { InkCanvas, type ToolState } from './canvas'
import { PdfView } from './pdfview'

interface Saved {
  /** State of the notebook the picture was drawn from. */
  rev: number
  page: string
  blob: Blob
}

const TOOL: ToolState = {
  kind: 'pen',
  pen: { color: '#1a1a1a', width: 1.3 },
  pencil: { color: '#1a1a1a', width: 1.5 },
  scribbleErase: false,
  shapeHold: false,
  highlighter: { color: '#ffe14d', width: 14 },
  eraser: { mode: 'stroke', size: 12 },
}

const key = (id: string) => `firstpage:${id}`

async function draw(node: LibNode, width: number): Promise<Saved | null> {
  const pageId = node.pageIds?.[0]
  const page = pageId ? (await getPages(node.id)).find((p) => p.id === pageId) : undefined
  if (!page) return null
  const pdf = new PdfView(async (asset) => (await getAsset(asset))?.bytes)
  // The same drawing code as the writing screen, used off screen.
  let late: (() => void) | null = null
  const canvas = new InkCanvas(
    document.createElement('div'),
    {
      loadStrokes: getStrokes,
      onChange: () => {},
      onViewChange: () => {},
      onAddPage: () => {},
      onSelection: () => {},
      onLassoTap: () => {},
      onPictureReady: () => late?.(),
      renderPdf: async (p, scale) => (p.pdf ? pdf.render(p.pdf.asset, p.pdf.index, pageSize(p).w, scale) : null),
    },
    TOOL,
  )
  try {
    canvas.setPages([page])
    let out = await canvas.thumbnail(page.id, width)
    const pictures = (await getStrokes(page.id)).some((s) => s.tool === 'image')
    if (page.pdf || pictures) {
      // The PDF page and pictures arrive a moment later: wait for them, then draw again.
      await new Promise<void>((done) => {
        const timer = setTimeout(done, 4000)
        let pending = (page.pdf ? 1 : 0) + (pictures ? 1 : 0)
        late = () => {
          if (--pending > 0) return
          clearTimeout(timer)
          done()
        }
      })
      out = await canvas.thumbnail(page.id, width)
    }
    if (!out) return null
    const blob = await new Promise<Blob | null>((done) => out!.toBlob(done, 'image/jpeg', 0.82))
    return blob ? { rev: node.rev ?? 0, page: page.id, blob } : null
  } finally {
    canvas.destroy()
    pdf.destroy()
  }
}

/** One picture at a time, so opening a large library stays smooth. */
let queue: Promise<unknown> = Promise.resolve()

/**
 * Picture of the notebook's first page (null if it cannot be drawn, for
 * instance before the notebook has been downloaded).
 */
export function firstPagePicture(node: LibNode, width = 150): Promise<Blob | null> {
  const job = queue.then(async () => {
    const saved = await kvGet<Saved>(key(node.id))
    if (saved && saved.rev === (node.rev ?? 0) && saved.page === node.pageIds?.[0]) return saved.blob
    const fresh = await draw(node, width)
    if (fresh) await kvSet(key(node.id), fresh)
    return fresh?.blob ?? saved?.blob ?? null
  })
  queue = job.catch(() => {})
  return job
}
