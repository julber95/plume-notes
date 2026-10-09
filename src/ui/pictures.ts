// Preparing a picture chosen by the user before it goes on a page.

export interface PreparedPicture {
  mime: string
  data: Uint8Array
  width: number
  height: number
}

/**
 * Reads an image file and returns it as a JPEG of at most 2000 pixels on its
 * long side: sharp on a page, light in the PDF. Transparent areas become white.
 */
export async function preparePicture(file: Blob): Promise<PreparedPicture> {
  const source = await createImageBitmap(file)
  const scale = Math.min(1, 2000 / Math.max(source.width, source.height))
  const sheet = document.createElement('canvas')
  sheet.width = Math.max(1, Math.round(source.width * scale))
  sheet.height = Math.max(1, Math.round(source.height * scale))
  const g = sheet.getContext('2d')!
  g.fillStyle = '#ffffff'
  g.fillRect(0, 0, sheet.width, sheet.height)
  g.drawImage(source, 0, 0, sheet.width, sheet.height)
  const blob = await new Promise<Blob | null>((done) => sheet.toBlob(done, 'image/jpeg', 0.88))
  if (!blob) throw new Error('encoding failed')
  return { mime: 'image/jpeg', data: new Uint8Array(await blob.arrayBuffer()), width: sheet.width, height: sheet.height }
}
