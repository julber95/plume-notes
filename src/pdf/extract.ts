// Reads back the editable data embedded in a PDF produced by Plume.

import { PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib'
import type { Background, Orientation } from '../model'
import { decodePage, type NotebookData } from './codec'

const PieceInfo = PDFName.of('PieceInfo')
const Plume = PDFName.of('Plume')
const Private = PDFName.of('Private')

function plumePrivate(dict: PDFDict): unknown {
  return dict.lookupMaybe(PieceInfo, PDFDict)?.lookupMaybe(Plume, PDFDict)?.lookup(Private)
}

/** Returns null if the PDF contains no readable Plume data. */
export async function extractPlumeData(bytes: Uint8Array): Promise<NotebookData | null> {
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true })
    const root = plumePrivate(doc.catalog)
    if (!(root instanceof PDFDict)) return null
    const bg = (root.lookupMaybe(PDFName.of('Bg'), PDFName)?.decodeText() ?? 'blank') as Background
    const orient = (root.lookupMaybe(PDFName.of('Orient'), PDFName)?.decodeText() ?? 'portrait') as Orientation
    const data: NotebookData = { bg, orient, pages: [] }
    for (const page of doc.getPages()) {
      const stream = plumePrivate(page.node)
      const decoded = stream instanceof PDFRawStream ? decodePage(decodePDFRawStream(stream).decode()) : null
      if (decoded) {
        // Pictures: their bytes are the page's own PDF images.
        const images = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict)
        decoded.strokes = decoded.strokes.filter((s) => {
          if (s.tool !== 'image') return true
          const stream = images?.lookup(PDFName.of(`Im${s.imageIndex}`))
          if (!(stream instanceof PDFRawStream)) return false
          s.image = { mime: 'image/jpeg', data: stream.contents.slice() }
          return true
        })
        data.pages.push(decoded)
      } else {
        // Page without data (added by another program): blank page of the same format.
        const { width, height } = page.getSize()
        data.pages.push({ bg: 'blank', orient: width > height ? 'landscape' : 'portrait', strokes: [] })
      }
    }
    return data
  } catch {
    return null
  }
}
