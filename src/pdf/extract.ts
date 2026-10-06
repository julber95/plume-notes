// Relecture des données modifiables embarquées dans un PDF produit par Plume.

import { PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib'
import type { Background, Orientation } from '../model'
import { decodePage, type NotebookData } from './codec'

const PieceInfo = PDFName.of('PieceInfo')
const Plume = PDFName.of('Plume')
const Private = PDFName.of('Private')

function plumePrivate(dict: PDFDict): unknown {
  return dict.lookupMaybe(PieceInfo, PDFDict)?.lookupMaybe(Plume, PDFDict)?.lookup(Private)
}

/** Retourne null si le PDF ne contient pas de données Plume lisibles. */
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
        data.pages.push(decoded)
      } else {
        // Page sans données (ajoutée par un autre logiciel) : page vierge au même format.
        const { width, height } = page.getSize()
        data.pages.push({ bg: 'blank', orient: width > height ? 'landscape' : 'portrait', strokes: [] })
      }
    }
    return data
  } catch {
    return null
  }
}
