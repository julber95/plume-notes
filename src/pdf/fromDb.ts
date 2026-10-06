import { putPdfCache, snapshotNotebook, type PdfCacheRecord } from '../db'
import { buildNotebookPdf, type PageCache } from './build'

export interface BuiltPdf {
  bytes: Uint8Array
  /** Révision du bloc-notes contenue dans ce PDF. */
  rev: number
}

/** Lit un bloc-notes dans le stockage local et produit son PDF. */
export async function buildFromDb(notebookId: string): Promise<BuiltPdf> {
  const snap = await snapshotNotebook(notebookId)
  if (!snap) throw new Error('Bloc-notes introuvable')
  const cache: PageCache = new Map()
  for (const p of snap.pages) if (p.cached) cache.set(p.id, p.cached)
  const bytes = await buildNotebookPdf(
    { name: snap.node.name, bg: snap.node.bg ?? 'blank', orient: snap.node.orient ?? 'portrait', pages: snap.pages },
    cache,
  )
  const fresh: PdfCacheRecord[] = []
  for (const p of snap.pages) if (!p.cached) fresh.push({ pageId: p.id, ...cache.get(p.id)! })
  if (fresh.length) await putPdfCache(fresh)
  return { bytes, rev: snap.node.rev ?? 0 }
}
