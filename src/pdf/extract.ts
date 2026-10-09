// Reads a PDF back into something editable.
//
// A PDF produced by Plume carries the editable data of each page. Any other
// PDF becomes a notebook whose pages show the PDF, ready to be written on.

import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, decodePDFRawStream } from 'pdf-lib'
import type { Background, Orientation } from '../model'
import { decodePage, type NotebookData, type PageData } from './codec'
import { pageFrame } from './pagebox'

const PieceInfo = PDFName.of('PieceInfo')
const Plume = PDFName.of('Plume')
const Private = PDFName.of('Private')

function plumeInfo(dict: PDFDict): PDFDict | undefined {
  return dict.lookupMaybe(PieceInfo, PDFDict)?.lookupMaybe(Plume, PDFDict)
}

/** Returns null if the file is not a PDF that can be opened (damaged or password-protected). */
export async function extractPlumeData(bytes: Uint8Array): Promise<NotebookData | null> {
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true })
    if (doc.isEncrypted) return null
    const root = plumeInfo(doc.catalog)?.lookup(Private)
    const made = root instanceof PDFDict
    const data: NotebookData = {
      bg: made ? ((root.lookupMaybe(PDFName.of('Bg'), PDFName)?.decodeText() ?? 'blank') as Background) : 'blank',
      orient: made ? ((root.lookupMaybe(PDFName.of('Orient'), PDFName)?.decodeText() ?? 'portrait') as Orientation) : 'portrait',
      pages: [],
    }

    // Pages that come from an imported PDF are kept, cleaned of what Plume
    // added; pages made by Plume alone are dropped from that copy.
    const keep: number[] = []
    doc.getPages().forEach((page, index) => {
      const info = plumeInfo(page.node)
      const stream = info?.lookup(Private)
      let decoded: PageData | null = stream instanceof PDFRawStream ? decodePage(decodePDFRawStream(stream).decode()) : null
      const resources = page.node.Resources()
      const images = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict)
      if (decoded) {
        // Pictures: their bytes are the page's own PDF images.
        decoded.strokes = decoded.strokes.filter((s) => {
          if (s.tool !== 'image') return true
          const picture = images?.lookup(PDFName.of(`PlmIm${s.imageIndex}`)) ?? images?.lookup(PDFName.of(`Im${s.imageIndex}`))
          if (!(picture instanceof PDFRawStream)) return false
          s.image = { mime: 'image/jpeg', data: picture.contents.slice() }
          return true
        })
      } else {
        // No data: a page of an ordinary PDF (or one added by another program).
        decoded = { bg: 'blank', orient: 'portrait', strokes: [], pdf: true }
      }
      if (decoded.pdf) {
        // Take off Plume's layer to get the original page back.
        const added = info?.lookupMaybe(PDFName.of('Added'), PDFArray)
        const contents = page.node.Contents()
        if (added && contents instanceof PDFArray) {
          const mine = new Set(added.asArray().filter((r): r is PDFRef => r instanceof PDFRef).map((r) => r.toString()))
          for (let i = contents.size() - 1; i >= 0; i--) {
            const item = contents.get(i)
            if (item instanceof PDFRef && mine.has(item.toString())) contents.remove(i)
          }
        }
        for (const kind of ['XObject', 'ExtGState', 'Pattern', 'ColorSpace', 'Font']) {
          const dict = resources?.lookupMaybe(PDFName.of(kind), PDFDict)
          for (const key of dict?.keys() ?? []) if (key.decodeText().startsWith('Plm')) dict!.delete(key)
        }
        page.node.delete(PieceInfo)
        const { w, h } = pageFrame(page)
        Object.assign(decoded, { w, h, orient: w > h ? 'landscape' : 'portrait', pdfIndex: keep.length })
        keep.push(index)
      }
      data.pages.push(decoded)
    })

    if (keep.length) {
      if (made) {
        for (let i = doc.getPageCount() - 1; i >= 0; i--) if (!keep.includes(i)) doc.removePage(i)
        doc.catalog.delete(PieceInfo)
        data.asset = await doc.save()
      } else {
        // An ordinary PDF: kept exactly as it is.
        data.asset = bytes
      }
    }
    return data
  } catch {
    return null
  }
}
