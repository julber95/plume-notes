// Stockage local (IndexedDB). Utilisé par l'interface et par le worker PDF :
// aucun accès au DOM ici.

import type { LibNode, Page, Stroke } from './model'

const DB_NAME = 'plume'
const DB_VERSION = 1

let dbPromise: Promise<IDBDatabase> | null = null

export function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        const nodes = db.createObjectStore('nodes', { keyPath: 'id' })
        nodes.createIndex('remoteId', 'remoteId')
        const pages = db.createObjectStore('pages', { keyPath: 'id' })
        pages.createIndex('notebookId', 'notebookId')
        const strokes = db.createObjectStore('strokes', { keyPath: 'id' })
        strokes.createIndex('pageId', 'pageId')
        db.createObjectStore('kv')
        db.createObjectStore('pdfcache', { keyPath: 'pageId' })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return dbPromise
}

/** Pour les tests : oublie la connexion ouverte. */
export async function closeDb(): Promise<void> {
  if (dbPromise) (await dbPromise).close()
  dbPromise = null
}

type StoreName = 'nodes' | 'pages' | 'strokes' | 'kv' | 'pdfcache'

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

/**
 * Exécute `fn` dans une transaction et attend sa validation. `fn` ne doit
 * attendre que des requêtes IndexedDB (sinon la transaction se ferme).
 */
async function tx<T>(stores: StoreName[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => Promise<T> | T, strict = false): Promise<T> {
  const db = await openDb()
  const t = db.transaction(stores, mode, strict ? { durability: 'strict' } : undefined)
  const done = new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error ?? new Error('Transaction annulée'))
  })
  let result: T
  try {
    result = await fn(t)
  } catch (e) {
    try {
      t.abort()
    } catch {
      // déjà terminée
    }
    await done.catch(() => {})
    throw e
  }
  await done
  return result
}

// ---------- Réglages ----------

export function kvGet<T>(key: string): Promise<T | undefined> {
  return tx(['kv'], 'readonly', (t) => req(t.objectStore('kv').get(key)) as Promise<T | undefined>)
}

export function kvSet(key: string, value: unknown): Promise<void> {
  return tx(['kv'], 'readwrite', (t) => {
    if (value === undefined) t.objectStore('kv').delete(key)
    else t.objectStore('kv').put(value, key)
  })
}

// ---------- Bibliothèque ----------

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
 * Lit, modifie et réécrit un nœud dans une seule transaction, pour que
 * l'interface et la synchronisation ne s'écrasent pas mutuellement.
 * `fn` retourne `false` pour ne rien écrire.
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

/** Plusieurs écritures de nœuds dans une seule transaction. */
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

// ---------- Contenu des blocs-notes ----------

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
 * Numéro de révision d'une page : toujours croissant et jamais réutilisé, car
 * le rendu PDF mis en cache est retrouvé par ce numéro.
 */
function nextRev(rev: number): number {
  return Math.max(rev + 1, Date.now())
}

const CONTENT: StoreName[] = ['nodes', 'pages', 'strokes', 'pdfcache']

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
 * Enregistre une modification de traits (ajouts et suppressions sur une page)
 * de façon atomique et durable, et marque la page et le bloc-notes modifiés.
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
  /** Nouvel ordre complet des pages. */
  pageIds: string[]
  putPages?: Page[]
  deletePageIds?: string[]
  addStrokes?: Stroke[]
}

/** Ajout, suppression, déplacement ou changement de fond de pages. */
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

/** Crée un bloc-notes avec ses premières pages. */
export function createNotebook(node: LibNode, pages: Page[]): Promise<void> {
  return tx(['nodes', 'pages'], 'readwrite', (t) => {
    t.objectStore('nodes').put(node)
    for (const p of pages) t.objectStore('pages').put(p)
  })
}

async function deleteNotebookContent(t: IDBTransaction, notebookId: string): Promise<void> {
  const pages = t.objectStore('pages')
  const ids = (await req(pages.index('notebookId').getAllKeys(notebookId))) as string[]
  for (const id of ids) {
    pages.delete(id)
    await deleteStrokesOfPage(t, id)
  }
}

/** Supprime définitivement des nœuds locaux et le contenu des blocs-notes. */
export function purgeNodes(ids: string[]): Promise<void> {
  return tx(CONTENT, 'readwrite', async (t) => {
    for (const id of ids) {
      t.objectStore('nodes').delete(id)
      await deleteNotebookContent(t, id)
    }
  })
}

/** Efface le contenu local d'un bloc-notes (le nœud est conservé). */
export function clearNotebookContent(notebookId: string): Promise<void> {
  return tx(CONTENT, 'readwrite', (t) => deleteNotebookContent(t, notebookId))
}

export interface NotebookContent {
  pages: Page[]
  strokes: Stroke[]
}

/**
 * Remplace le contenu local d'un bloc-notes par celui téléchargé depuis
 * OneDrive. N'écrit rien et retourne `false` si le bloc-notes a été modifié
 * localement entre-temps (rev différent de `expectRev`).
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
      node.pageIds = content.pages.map((p) => p.id)
      patch(node)
      nodes.put(node)
      return true
    },
    true,
  )
}

/** Rendu PDF d'une page, conservé pour ne recalculer que les pages modifiées. */
export interface PdfCacheRecord {
  pageId: string
  rev: number
  content: Uint8Array
  data: Uint8Array
}

export interface NotebookSnapshot {
  node: LibNode
  pages: (Page & { strokes: Stroke[]; cached?: PdfCacheRecord })[]
}

/** Lecture cohérente d'un bloc-notes entier (pour l'export PDF). */
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
      // Les traits d'une page dont le rendu est déjà en cache ne sont pas relus.
      let cached = (await req(t.objectStore('pdfcache').get(id))) as PdfCacheRecord | undefined
      if (cached?.rev !== p.rev) cached = undefined
      let strokes: Stroke[] = []
      if (!cached) {
        strokes = (await req(t.objectStore('strokes').index('pageId').getAll(id))) as Stroke[]
        strokes.sort((a, b) => a.seq - b.seq)
      }
      pages.push({ ...p, strokes, cached })
    }
    return { node, pages }
  })
}

export function putPdfCache(records: PdfCacheRecord[]): Promise<void> {
  return tx(['pdfcache'], 'readwrite', (t) => {
    for (const r of records) t.objectStore('pdfcache').put(r)
  })
}
