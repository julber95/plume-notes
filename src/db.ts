// Local storage (IndexedDB). Used by the interface and by the PDF worker:
// no DOM access here.

import type { Asset, LibNode, Page, Stroke } from './model'

const DB_NAME = 'plume'
const DB_VERSION = 2

let dbPromise: Promise<IDBDatabase> | null = null

export function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = (e) => {
        const db = req.result
        if (e.oldVersion < 1) {
          const nodes = db.createObjectStore('nodes', { keyPath: 'id' })
          nodes.createIndex('remoteId', 'remoteId')
          const pages = db.createObjectStore('pages', { keyPath: 'id' })
          pages.createIndex('notebookId', 'notebookId')
          const strokes = db.createObjectStore('strokes', { keyPath: 'id' })
          strokes.createIndex('pageId', 'pageId')
          db.createObjectStore('kv')
          db.createObjectStore('pdfcache', { keyPath: 'pageId' })
        }
        if (e.oldVersion < 2) {
          // Imported PDFs. The cached page renderings use names that changed
          // with this version, so they are rebuilt.
          db.createObjectStore('assets', { keyPath: 'id' }).createIndex('notebookId', 'notebookId')
          req.transaction!.objectStore('pdfcache').clear()
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return dbPromise
}

/** For tests: forgets the open connection. */
export async function closeDb(): Promise<void> {
  if (dbPromise) (await dbPromise).close()
  dbPromise = null
}

type StoreName = 'nodes' | 'pages' | 'strokes' | 'kv' | 'pdfcache' | 'assets'

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

/**
 * Runs `fn` in a transaction and waits for it to commit. `fn` must only await
 * IndexedDB requests (otherwise the transaction closes).
 */
async function tx<T>(stores: StoreName[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => Promise<T> | T, strict = false): Promise<T> {
  const db = await openDb()
  const t = db.transaction(stores, mode, strict ? { durability: 'strict' } : undefined)
  const done = new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error ?? new Error('Transaction aborted'))
  })
  let result: T
  try {
    result = await fn(t)
  } catch (e) {
    try {
      t.abort()
    } catch {
      // already finished
    }
    await done.catch(() => {})
    throw e
  }
  await done
  return result
}

// ---------- Settings ----------

export function kvGet<T>(key: string): Promise<T | undefined> {
  return tx(['kv'], 'readonly', (t) => req(t.objectStore('kv').get(key)) as Promise<T | undefined>)
}

export function kvSet(key: string, value: unknown): Promise<void> {
  return tx(['kv'], 'readwrite', (t) => {
    if (value === undefined) t.objectStore('kv').delete(key)
    else t.objectStore('kv').put(value, key)
  })
}

// ---------- Library ----------

export function allNodes(): Promise<LibNode[]> {
  return tx(['nodes'], 'readonly', (t) => req(t.objectStore('nodes').getAll()) as Promise<LibNode[]>)
}

export function getNode(id: string): Promise<LibNode | undefined> {
  return tx(['nodes'], 'readonly', (t) => req(t.objectStore('nodes').get(id)) as Promise<LibNode | undefined>)
}

export function putNodes(nodes: LibNode[]): Promise<void> {
  return tx(['nodes'], 'readwrite', (t) => {
    for (const n of nodes) t.objectStore('nodes').put(n)
  })
}

/**
 * Reads, modifies and writes back a node in a single transaction, so that
 * the interface and the sync engine never overwrite each other.
 * `fn` returns `false` to write nothing.
 */
export function updateNode(id: string, fn: (n: LibNode) => void | false): Promise<LibNode | undefined> {
  return tx(['nodes'], 'readwrite', async (t) => {
    const store = t.objectStore('nodes')
    const n = (await req(store.get(id))) as LibNode | undefined
    if (!n) return undefined
    if (fn(n) === false) return n
    store.put(n)
    return n
  })
}

/** Several node writes in a single transaction. */
export interface NodeStore {
  all(): Promise<LibNode[]>
  get(id: string): Promise<LibNode | undefined>
  put(n: LibNode): void
  delete(id: string): void
}

export function mutateNodes(fn: (store: NodeStore) => Promise<void>): Promise<void> {
  return tx(['nodes'], 'readwrite', async (t) => {
    const s = t.objectStore('nodes')
    await fn({
      all: () => req(s.getAll()) as Promise<LibNode[]>,
      get: (id) => req(s.get(id)) as Promise<LibNode | undefined>,
      put: (n) => void s.put(n),
      delete: (id) => void s.delete(id),
    })
  })
}

// ---------- Notebook content ----------

export function getPages(notebookId: string): Promise<Page[]> {
  return tx(['pages'], 'readonly', (t) => req(t.objectStore('pages').index('notebookId').getAll(notebookId)) as Promise<Page[]>)
}

export function getStrokes(pageId: string): Promise<Stroke[]> {
  return tx(['strokes'], 'readonly', async (t) => {
    const list = (await req(t.objectStore('strokes').index('pageId').getAll(pageId))) as Stroke[]
    return list.sort((a, b) => a.seq - b.seq)
  })
}

/**
 * Revision number of a page: always increasing and never reused, because
 * the cached PDF rendering is looked up by this number.
 */
function nextRev(rev: number): number {
  return Math.max(rev + 1, Date.now())
}

const CONTENT: StoreName[] = ['nodes', 'pages', 'strokes', 'pdfcache', 'assets']

function deleteStrokesOfPage(t: IDBTransaction, pageId: string): Promise<void> {
  t.objectStore('pdfcache').delete(pageId)
  return new Promise((resolve, reject) => {
    const cur = t.objectStore('strokes').index('pageId').openKeyCursor(IDBKeyRange.only(pageId))
    cur.onsuccess = () => {
      const c = cur.result
      if (!c) return resolve()
      t.objectStore('strokes').delete(c.primaryKey)
      c.continue()
    }
    cur.onerror = () => reject(cur.error)
  })
}

/**
 * Saves a stroke change (additions and removals on one page) atomically and
 * durably, and marks the page and the notebook as modified.
 */
export function applyStrokeChange(notebookId: string, pageId: string, add: Stroke[], removeIds: string[]): Promise<void> {
  return tx(
    ['nodes', 'pages', 'strokes'],
    'readwrite',
    async (t) => {
      const strokes = t.objectStore('strokes')
      for (const id of removeIds) strokes.delete(id)
      for (const s of add) strokes.put(s)
      const pages = t.objectStore('pages')
      const page = (await req(pages.get(pageId))) as Page | undefined
      if (page) {
        page.rev = nextRev(page.rev)
        pages.put(page)
      }
      const nodes = t.objectStore('nodes')
      const node = (await req(nodes.get(notebookId))) as LibNode | undefined
      if (node) {
        node.rev = (node.rev ?? 0) + 1
        node.updatedAt = Date.now()
        nodes.put(node)
      }
    },
    true,
  )
}

export interface PageStructureChange {
  /** New complete page order. */
  pageIds: string[]
  putPages?: Page[]
  deletePageIds?: string[]
  addStrokes?: Stroke[]
}

/** Adding, deleting, moving pages or changing their background. */
export function applyPageStructure(notebookId: string, change: PageStructureChange): Promise<void> {
  return tx(
    CONTENT,
    'readwrite',
    async (t) => {
      const pages = t.objectStore('pages')
      for (const p of change.putPages ?? []) {
        const existing = (await req(pages.get(p.id))) as Page | undefined
        p.rev = nextRev(Math.max(p.rev, existing?.rev ?? 0))
        pages.put(p)
      }
      for (const id of change.deletePageIds ?? []) {
        pages.delete(id)
        await deleteStrokesOfPage(t, id)
      }
      for (const s of change.addStrokes ?? []) t.objectStore('strokes').put(s)
      const nodes = t.objectStore('nodes')
      const node = (await req(nodes.get(notebookId))) as LibNode | undefined
      if (node) {
        node.pageIds = change.pageIds
        node.rev = (node.rev ?? 0) + 1
        node.updatedAt = Date.now()
        nodes.put(node)
      }
    },
    true,
  )
}

/** Creates a notebook with its first pages. */
export function createNotebook(node: LibNode, pages: Page[], strokes: Stroke[] = [], assets: Asset[] = []): Promise<void> {
  return tx(['nodes', 'pages', 'strokes', 'assets'], 'readwrite', (t) => {
    t.objectStore('nodes').put(node)
    for (const p of pages) t.objectStore('pages').put(p)
    for (const s of strokes) t.objectStore('strokes').put(s)
    for (const a of assets) t.objectStore('assets').put(a)
  })
}

export function getAsset(id: string): Promise<Asset | undefined> {
  return tx(['assets'], 'readonly', (t) => req(t.objectStore('assets').get(id)) as Promise<Asset | undefined>)
}

async function deleteNotebookContent(t: IDBTransaction, notebookId: string): Promise<void> {
  const pages = t.objectStore('pages')
  const ids = (await req(pages.index('notebookId').getAllKeys(notebookId))) as string[]
  for (const id of ids) {
    pages.delete(id)
    await deleteStrokesOfPage(t, id)
  }
  const assets = t.objectStore('assets')
  for (const id of (await req(assets.index('notebookId').getAllKeys(notebookId))) as string[]) assets.delete(id)
}

/** Permanently deletes local nodes and the content of notebooks. */
export function purgeNodes(ids: string[]): Promise<void> {
  return tx(CONTENT, 'readwrite', async (t) => {
    for (const id of ids) {
      t.objectStore('nodes').delete(id)
      await deleteNotebookContent(t, id)
    }
  })
}

/** Erases the local content of a notebook (the node is kept). */
export function clearNotebookContent(notebookId: string): Promise<void> {
  return tx(CONTENT, 'readwrite', (t) => deleteNotebookContent(t, notebookId))
}

export interface NotebookContent {
  pages: Page[]
  strokes: Stroke[]
  assets?: Asset[]
}

/**
 * Replaces the local content of a notebook with the one downloaded from
 * OneDrive. Writes nothing and returns `false` if the notebook was modified
 * locally in the meantime (rev different from `expectRev`).
 */
export function replaceNotebookContent(notebookId: string, expectRev: number, content: NotebookContent, patch: (n: LibNode) => void): Promise<boolean> {
  return tx(
    CONTENT,
    'readwrite',
    async (t) => {
      const nodes = t.objectStore('nodes')
      const node = (await req(nodes.get(notebookId))) as LibNode | undefined
      if (!node || node.deleted || (node.rev ?? 0) !== expectRev) return false
      await deleteNotebookContent(t, notebookId)
      for (const p of content.pages) t.objectStore('pages').put(p)
      for (const s of content.strokes) t.objectStore('strokes').put(s)
      for (const a of content.assets ?? []) t.objectStore('assets').put(a)
      node.pageIds = content.pages.map((p) => p.id)
      patch(node)
      nodes.put(node)
      return true
    },
    true,
  )
}

/** PDF rendering of a page, kept so that only modified pages are recomputed. */
export interface PdfCacheRecord {
  pageId: string
  rev: number
  content: Uint8Array
  data: Uint8Array
  images?: string[]
}

export interface NotebookSnapshot {
  node: LibNode
  pages: (Page & { strokes: Stroke[]; cached?: PdfCacheRecord; imageStrokes?: Stroke[] })[]
  /** Imported PDFs used by the pages. */
  assets: Asset[]
}

/** Consistent read of a whole notebook (for PDF export). */
export function snapshotNotebook(notebookId: string): Promise<NotebookSnapshot | undefined> {
  return tx(CONTENT, 'readonly', async (t) => {
    const node = (await req(t.objectStore('nodes').get(notebookId))) as LibNode | undefined
    if (!node) return undefined
    const all = (await req(t.objectStore('pages').index('notebookId').getAll(notebookId))) as Page[]
    const byId = new Map(all.map((p) => [p.id, p]))
    const pages: NotebookSnapshot['pages'] = []
    for (const id of node.pageIds ?? []) {
      const p = byId.get(id)
      if (!p) continue
      // Strokes of a page whose rendering is already cached are not read again.
      let cached = (await req(t.objectStore('pdfcache').get(id))) as PdfCacheRecord | undefined
      if (cached?.rev !== p.rev) cached = undefined
      let strokes: Stroke[] = []
      if (!cached) {
        strokes = (await req(t.objectStore('strokes').index('pageId').getAll(id))) as Stroke[]
        strokes.sort((a, b) => a.seq - b.seq)
      }
      // A cached page still needs its pictures, which are embedded at every export.
      const imageStrokes: Stroke[] = []
      for (const sid of cached?.images ?? []) {
        const s = (await req(t.objectStore('strokes').get(sid))) as Stroke | undefined
        if (s) imageStrokes.push(s)
      }
      pages.push({ ...p, strokes, cached, imageStrokes })
    }
    const assets: Asset[] = []
    for (const id of new Set(pages.map((p) => p.pdf?.asset))) {
      const a = id && ((await req(t.objectStore('assets').get(id))) as Asset | undefined)
      if (a) assets.push(a)
    }
    return { node, pages, assets }
  })
}

export function putPdfCache(records: PdfCacheRecord[]): Promise<void> {
  return tx(['pdfcache'], 'readwrite', (t) => {
    for (const r of records) t.objectStore('pdfcache').put(r)
  })
}
