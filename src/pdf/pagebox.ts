// Geometry of a page of an existing PDF: its visible size, and how to draw on
// it in the same coordinates as on screen (origin at the top-left of the page
// as displayed, y pointing down).

import type { PDFPage } from 'pdf-lib'

export interface PageFrame {
  /** Size of the page as displayed (after its rotation), in points. */
  w: number
  h: number
  /** PDF matrix (a b c d e f) taking displayed coordinates to the page's own. */
  matrix: number[]
}

export function pageFrame(page: PDFPage): PageFrame {
  const media = page.getMediaBox()
  const crop = page.getCropBox()
  // The visible part: the crop box, limited to the media box.
  const x0 = Math.max(media.x, crop.x)
  const y0 = Math.max(media.y, crop.y)
  const x1 = Math.min(media.x + media.width, crop.x + crop.width)
  const y1 = Math.min(media.y + media.height, crop.y + crop.height)
  const w = x1 > x0 ? x1 - x0 : media.width
  const h = y1 > y0 ? y1 - y0 : media.height
  const turn = (((page.getRotation().angle % 360) + 360) % 360) as 0 | 90 | 180 | 270
  switch (turn) {
    case 90:
      return { w: h, h: w, matrix: [0, 1, 1, 0, x0, y0] }
    case 180:
      return { w, h, matrix: [-1, 0, 0, 1, x0 + w, y0] }
    case 270:
      return { w: h, h: w, matrix: [0, -1, -1, 0, x0 + w, y0 + h] }
    default:
      return { w, h, matrix: [1, 0, 0, -1, x0, y0 + h] }
  }
}
