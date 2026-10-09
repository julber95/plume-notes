// Displays the pages of imported PDFs (with PDF.js, loaded only when needed).

import type { PDFDocumentProxy } from 'pdfjs-dist'

let library: Promise<typeof import('pdfjs-dist')> | null = null

function load(): Promise<typeof import('pdfjs-dist')> {
  library ??= (async () => {
    const pdfjs = await import('pdfjs-dist')
    pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
    return pdfjs
  })()
  return library
}

export class PdfView {
  private docs = new Map<string, Promise<PDFDocumentProxy>>()
  private tasks: { destroy(): Promise<void> }[] = []
  /** Pages are drawn one after the other, so a long PDF never floods the device. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private bytesOf: (asset: string) => Promise<Uint8Array | undefined>) {}

  private open(asset: string): Promise<PDFDocumentProxy> {
    let doc = this.docs.get(asset)
    if (!doc) {
      doc = (async () => {
        const [pdfjs, bytes] = await Promise.all([load(), this.bytesOf(asset)])
        if (!bytes) throw new Error('PDF not found on this device')
        // PDF.js takes over the buffer it is given: hand it a copy.
        const task = pdfjs.getDocument({ data: bytes.slice(), standardFontDataUrl: new URL('pdfjs/standard_fonts/', document.baseURI).href })
        this.tasks.push(task)
        return task.promise
      })()
      this.docs.set(asset, doc)
      doc.catch(() => this.docs.delete(asset))
    }
    return doc
  }

  /**
   * Image of a page, `scale` pixels per point of the page as Plume displays it
   * (`width` points wide).
   */
  render(asset: string, index: number, width: number, scale: number): Promise<HTMLCanvasElement> {
    const job = this.queue.then(async () => {
      const page = await (await this.open(asset)).getPage(index + 1)
      const viewport = page.getViewport({ scale: (scale * width) / page.getViewport({ scale: 1 }).width })
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(viewport.width))
      canvas.height = Math.max(1, Math.round(viewport.height))
      await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise
      return canvas
    })
    this.queue = job.catch(() => {})
    return job
  }

  destroy(): void {
    for (const task of this.tasks) void task.destroy().catch(() => {})
    this.tasks = []
    this.docs.clear()
  }
}
