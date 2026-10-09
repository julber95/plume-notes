import { putPdfCache, snapshotNotebook, type PdfCacheRecord } from '../db'
import { buildNotebookPdf, type PageCache } from './build'

export interface BuiltPdf {
  bytes: Uint8Array
  /** Notebook revision contained in this PDF. */
  rev: number
}

/** Reads a notebook from local storage and produces its PDF. */
export async function buildFromDb(notebookId: string): Promise<BuiltPdf> {
  const snap = await snapshotNotebook(notebookId)
  if (!snap) throw new Error('Notebook not found')
  const cache: PageCache = new Map()
  for (const p of snap.pages) if (p.cached) cache.set(p.id, p.cached)
  const bytes = await buildNotebookPdf(
    {
      name: snap.node.name,
      bg: snap.node.bg ?? 'blank',
      orient: snap.node.orient ?? 'portrait',
      pages: snap.pages,
      assets: new Map(snap.assets.map((a) => [a.id, a.bytes])),
    },
    cache,
  )
  const fresh: PdfCacheRecord[] = []
  for (const p of snap.pages) if (!p.cached) fresh.push({ pageId: p.id, ...cache.get(p.id)! })
  if (fresh.length) await putPdfCache(fresh)
  return { bytes, rev: snap.node.rev ?? 0 }
}
