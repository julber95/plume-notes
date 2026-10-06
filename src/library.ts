// Opérations de la bibliothèque (dossiers et blocs-notes). Elles n'écrivent que
// dans le stockage local ; la synchronisation les reporte ensuite sur OneDrive.

import { allNodes, clearNotebookContent, createNotebook as dbCreateNotebook, mutateNodes, purgeNodes, putNodes } from './db'
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

export async function createNotebook(parentId: string, rawName: string, bg: Background, orient: Orientation): Promise<LibNode> {
  const nodes = await allNodes()
  const now = Date.now()
  const id = uid()
  const page: Page = { id: uid(), notebookId: id, bg, orient, rev: 0 }
  const node: LibNode = {
    id,
    kind: 'notebook',
    name: uniqueName(sanitizeName(rawName), siblingNames(nodes, parentId, 'notebook')),
    parentId,
    createdAt: now,
    updatedAt: now,
    pageIds: [page.id],
    bg,
    orient,
    rev: 0,
    uploadedRev: -1,
  }
  await dbCreateNotebook(node, [page])
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

/** Identifiants de `id` et de tout ce qu'il contient. */
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
    // Un dossier ne peut pas être déplacé dans lui-même.
    if (subtree(nodes, id).includes(newParentId)) return
    n.name = uniqueName(n.name, siblingNames(nodes, newParentId, n.kind, n.id))
    n.parentId = newParentId
    n.metaDirty = true
    n.updatedAt = Date.now()
    s.put(n)
  })
}

/** Supprime un élément et tout son contenu. */
export async function deleteNode(id: string): Promise<void> {
  const purge: string[] = []
  const clear: string[] = []
  await mutateNodes(async (s) => {
    const nodes = await s.all()
    const byId = new Map(nodes.map((n) => [n.id, n]))
    for (const nid of subtree(nodes, id)) {
      const n = byId.get(nid)!
      if (n.remoteId) {
        // Déjà sur OneDrive : on garde une trace pour y reporter la suppression.
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

/** Chemin d'un dossier depuis la racine (pour le fil d'Ariane). */
export function pathTo(nodes: LibNode[], folderId: string): LibNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const out: LibNode[] = []
  for (let cur = byId.get(folderId); cur; cur = cur.parentId === ROOT ? undefined : byId.get(cur.parentId)) out.unshift(cur)
  return out
}
