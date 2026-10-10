// Library operations (folders and notebooks). They only write to local
// storage; the sync engine then applies them to OneDrive.

import { allNodes, clearNotebookContent, createNotebook as dbCreateNotebook, mutateNodes, purgeNodes, putNodes, type NotebookContent } from './db'
import type { Cover } from './covers'
import { ROOT, mostlyPdf, sanitizeName, siblingNames, uid, uniqueName, type Background, type LibNode, type Look, type Orientation, type Page } from './model'

/**
 * The trash is an ordinary folder of the library, so that what is thrown away
 * on one device leaves the others too and can be put back from any of them.
 * The library never lists it among the folders.
 */
export const TRASH_FOLDER = 'Trash'
/** What is in the trash is deleted for good after this many days. */
export const TRASH_DAYS = 30

const isTrash = (n: LibNode) => n.kind === 'folder' && n.parentId === ROOT && !n.deleted && n.name.toLowerCase() === TRASH_FOLDER.toLowerCase()

export function trashOf(nodes: LibNode[]): LibNode | undefined {
  return nodes.find(isTrash)
}

/** Names a new folder cannot take in `parentId`: those of its siblings, and that of the trash. */
function takenFolderNames(nodes: Iterable<LibNode>, parentId: string, exceptId?: string): string[] {
  return [...siblingNames(nodes, parentId, 'folder', exceptId), ...(parentId === ROOT ? [TRASH_FOLDER] : [])]
}

/** The fields recording a look chosen now (nothing for the default one). */
function chosen(look?: Look): Partial<LibNode> {
  return look && (look.color || look.symbol) ? { look, lookAt: Date.now(), lookDirty: true } : {}
}

export async function createFolder(parentId: string, rawName: string, look?: Look): Promise<LibNode> {
  const nodes = await allNodes()
  const now = Date.now()
  const node: LibNode = {
    id: uid(),
    kind: 'folder',
    name: uniqueName(sanitizeName(rawName), takenFolderNames(nodes, parentId)),
    parentId,
    createdAt: now,
    updatedAt: now,
    ...chosen(look),
  }
  await putNodes([node])
  return node
}

/** Creates a notebook with a first page, preceded by a cover page if one is given. */
export async function createNotebook(parentId: string, rawName: string, bg: Background, orient: Orientation, cover?: Cover, look?: Look): Promise<LibNode> {
  const nodes = await allNodes()
  const now = Date.now()
  const id = uid()
  const page: Page = { id: uid(), notebookId: id, bg, orient, rev: 0 }
  const pages: Page[] = cover ? [{ id: uid(), notebookId: id, bg: 'blank', orient, rev: 0, cover }, page] : [page]
  const node: LibNode = {
    id,
    kind: 'notebook',
    name: uniqueName(sanitizeName(rawName), siblingNames(nodes, parentId, 'notebook')),
    parentId,
    createdAt: now,
    updatedAt: now,
    pageIds: pages.map((p) => p.id),
    bg,
    orient,
    rev: 0,
    uploadedRev: -1,
    ...chosen(look),
  }
  await dbCreateNotebook(node, pages)
  return node
}

/**
 * Creates a notebook from ready-made content (an imported PDF or picture).
 * `build` receives the id of the notebook being created.
 */
export async function importNotebook(parentId: string, rawName: string, bg: Background, orient: Orientation, build: (notebookId: string) => NotebookContent): Promise<LibNode> {
  const nodes = await allNodes()
  const now = Date.now()
  const id = uid()
  const content = build(id)
  const node: LibNode = {
    id,
    kind: 'notebook',
    name: uniqueName(sanitizeName(rawName), siblingNames(nodes, parentId, 'notebook')),
    parentId,
    createdAt: now,
    updatedAt: now,
    pageIds: content.pages.map((p) => p.id),
    bg,
    orient,
    rev: 0,
    uploadedRev: -1,
    ...(mostlyPdf(content.pages) ? { fromPdf: true } : {}),
  }
  await dbCreateNotebook(node, content.pages, content.strokes, content.assets)
  return node
}

export function renameNode(id: string, rawName: string): Promise<void> {
  return mutateNodes(async (s) => {
    const nodes = await s.all()
    const n = nodes.find((o) => o.id === id)
    if (!n) return
    const name = uniqueName(sanitizeName(rawName), n.kind === 'folder' ? takenFolderNames(nodes, n.parentId, n.id) : siblingNames(nodes, n.parentId, n.kind, n.id))
    if (name === n.name) return
    n.name = name
    n.metaDirty = true
    n.updatedAt = Date.now()
    s.put(n)
  })
}

/** Changes the colour and the symbol of an item's icon. */
export function setLook(id: string, look: Look): Promise<void> {
  return mutateNodes(async (s) => {
    const n = await s.get(id)
    if (!n) return
    n.look = { ...(look.color ? { color: look.color } : {}), ...(look.symbol ? { symbol: look.symbol } : {}) }
    n.lookAt = Date.now()
    n.lookDirty = true
    s.put(n)
  })
}

/** Ids of `id` and of everything it contains. */
export function subtree(nodes: LibNode[], id: string): string[] {
  const out = [id]
  for (let i = 0; i < out.length; i++) for (const n of nodes) if (n.parentId === out[i]) out.push(n.id)
  return out
}

export function moveNode(id: string, newParentId: string): Promise<void> {
  return mutateNodes(async (s) => {
    const nodes = await s.all()
    const n = nodes.find((o) => o.id === id)
    if (!n || n.parentId === newParentId) return
    // A folder cannot be moved into itself.
    if (subtree(nodes, id).includes(newParentId)) return
    n.name = uniqueName(n.name, siblingNames(nodes, newParentId, n.kind, n.id))
    n.parentId = newParentId
    n.metaDirty = true
    n.updatedAt = Date.now()
    s.put(n)
  })
}

/** Puts an item in the trash, with everything it contains. It can be put back for 30 days. */
export function trashNode(id: string): Promise<void> {
  return mutateNodes(async (s) => {
    const nodes = await s.all()
    const n = nodes.find((o) => o.id === id)
    if (!n || n.deleted || isTrash(n)) return
    const now = Date.now()
    let bin = trashOf(nodes)
    if (bin && subtree(nodes, bin.id).includes(id)) return
    if (!bin) {
      bin = { id: uid(), kind: 'folder', name: TRASH_FOLDER, parentId: ROOT, createdAt: now, updatedAt: now }
      nodes.push(bin)
      s.put(bin)
    }
    n.trashedFrom = n.parentId
    n.trashedAt = now
    n.name = uniqueName(n.name, siblingNames(nodes, bin.id, n.kind, n.id))
    n.parentId = bin.id
    n.metaDirty = true
    n.favorite = false
    s.put(n)
  })
}

/** Takes an item out of the trash, back to the folder it was in (to the first screen if that folder is gone). */
export async function restoreNode(id: string): Promise<LibNode | undefined> {
  let home: LibNode | undefined
  await mutateNodes(async (s) => {
    const nodes = await s.all()
    const n = nodes.find((o) => o.id === id)
    const bin = trashOf(nodes)
    if (!n || !bin || n.parentId !== bin.id) return
    const gone = new Set(subtree(nodes, bin.id))
    home = nodes.find((o) => o.id === n.trashedFrom && o.kind === 'folder' && !o.deleted && !gone.has(o.id))
    const parentId = home?.id ?? ROOT
    n.name = uniqueName(n.name, n.kind === 'folder' ? takenFolderNames(nodes, parentId, n.id) : siblingNames(nodes, parentId, n.kind, n.id))
    n.parentId = parentId
    n.trashedAt = n.trashedFrom = undefined
    n.metaDirty = true
    n.updatedAt = Date.now()
    s.put(n)
  })
  return home
}

/** Deletes for good everything that is in the trash. */
export async function emptyTrash(): Promise<void> {
  const nodes = await allNodes()
  const bin = trashOf(nodes)
  if (!bin) return
  for (const n of nodes) if (n.parentId === bin.id && !n.deleted) await deleteNode(n.id)
}

/**
 * Housekeeping of the trash: what has been there for 30 days is deleted for
 * good. An item thrown away on another device is counted from the moment it
 * is first seen here. Returns true if something was deleted.
 */
export async function tidyTrash(now = Date.now()): Promise<boolean> {
  const nodes = await allNodes()
  const bin = trashOf(nodes)
  if (!bin) return false
  const expired: string[] = []
  const unseen: string[] = []
  for (const n of nodes) {
    if (n.parentId !== bin.id || n.deleted) continue
    if (!n.trashedAt) unseen.push(n.id)
    else if (now - n.trashedAt > TRASH_DAYS * 86_400_000) expired.push(n.id)
  }
  if (unseen.length) {
    await mutateNodes(async (s) => {
      for (const id of unseen) {
        const n = await s.get(id)
        if (n && !n.trashedAt) s.put({ ...n, trashedAt: now })
      }
    })
  }
  for (const id of expired) await deleteNode(id)
  return expired.length > 0
}

/** Deletes an item and all its content. */
export async function deleteNode(id: string): Promise<void> {
  const purge: string[] = []
  const clear: string[] = []
  await mutateNodes(async (s) => {
    const nodes = await s.all()
    const byId = new Map(nodes.map((n) => [n.id, n]))
    for (const nid of subtree(nodes, id)) {
      const n = byId.get(nid)!
      if (n.remoteId) {
        // Already on OneDrive: keep a record so the deletion is applied there too.
        n.deleted = true
        s.put(n)
        if (n.kind === 'notebook') clear.push(nid)
      } else {
        purge.push(nid)
      }
    }
  })
  await purgeNodes(purge)
  for (const nid of clear) await clearNotebookContent(nid)
}

/** Path of a folder from the root (for the breadcrumb). */
export function pathTo(nodes: LibNode[], folderId: string): LibNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const out: LibNode[] = []
  for (let cur = byId.get(folderId); cur; cur = cur.parentId === ROOT ? undefined : byId.get(cur.parentId)) out.unshift(cur)
  return out
}
