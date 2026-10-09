// Library operations (folders and notebooks). They only write to local
// storage; the sync engine then applies them to OneDrive.

import { allNodes, clearNotebookContent, createNotebook as dbCreateNotebook, mutateNodes, purgeNodes, putNodes, type NotebookContent } from './db'
import type { Cover } from './covers'
import { ROOT, sanitizeName, siblingNames, uid, uniqueName, type Background, type LibNode, type Orientation, type Page } from './model'

export async function createFolder(parentId: string, rawName: string): Promise<LibNode> {
  const nodes = await allNodes()
  const now = Date.now()
  const node: LibNode = {
    id: uid(),
    kind: 'folder',
    name: uniqueName(sanitizeName(rawName), siblingNames(nodes, parentId, 'folder')),
    parentId,
    createdAt: now,
    updatedAt: now,
  }
  await putNodes([node])
  return node
}

/** Creates a notebook with a first page, preceded by a cover page if one is given. */
export async function createNotebook(parentId: string, rawName: string, bg: Background, orient: Orientation, cover?: Cover): Promise<LibNode> {
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
  }
  await dbCreateNotebook(node, content.pages, content.strokes, content.assets)
  return node
}

export function renameNode(id: string, rawName: string): Promise<void> {
  return mutateNodes(async (s) => {
    const nodes = await s.all()
    const n = nodes.find((o) => o.id === id)
    if (!n) return
    const name = uniqueName(sanitizeName(rawName), siblingNames(nodes, n.parentId, n.kind, n.id))
    if (name === n.name) return
    n.name = name
    n.metaDirty = true
    n.updatedAt = Date.now()
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
