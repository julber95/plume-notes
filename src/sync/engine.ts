// OneDrive synchronisation.
//
// Principle: local storage is the source of truth while writing; each node
// carries its own state ("to create", "to rename", "to upload", "to delete").
// A sync cycle first reads the OneDrive changes, then pushes everything that
// is pending. Nothing is ever silently overwritten: if a notebook changed on
// both sides, both versions are kept.

import { ONEDRIVE_FOLDER } from '../config'
import { allNodes, getNode, kvGet, kvSet, mutateNodes, purgeNodes, replaceNotebookContent, updateNode } from '../db'
import { ROOT, conflictStamp, hasPendingSync, isDirtyNotebook, siblingNames, uid, uniqueName, type LibNode, type Page } from '../model'
import { dataToContent, type NotebookData } from '../pdf/codec'
import type { BuiltPdf } from '../pdf/fromDb'
import { AuthRequiredError, GraphError, type DriveItem, type GraphClient } from './graph'

export type SyncState = 'disabled' | 'signedOut' | 'offline' | 'syncing' | 'pending' | 'ok' | 'error'

export interface SyncStatus {
  state: SyncState
  message?: string
  lastSync?: number
}

export interface Notice {
  id: string
  text: string
  at: number
}

export type SyncEvent = { type: 'status' } | { type: 'library' } | { type: 'replaced'; notebookId: string } | { type: 'notices' }

export interface SyncHost {
  /** 'disabled': OneDrive not configured; 'signedOut': sign-in required. */
  authState(): 'disabled' | 'signedOut' | 'ready'
  graph(): GraphClient
  isOnline(): boolean
  buildPdf(notebookId: string): Promise<BuiltPdf>
  extract(bytes: Uint8Array): Promise<NotebookData | null>
  /** Notebook currently open in the editor, if any. */
  openNotebookId(): string | null
}

async function digest(algo: string, bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest(algo, bytes as BufferSource)
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Is the OneDrive content the one we already know? */
function sameContent(n: LibNode, it: DriveItem): boolean {
  if (it.cTag && n.cTag && it.cTag === n.cTag) return true
  const h = it.file?.hashes
  if (h?.sha256Hash && n.sha256) return h.sha256Hash.toLowerCase() === n.sha256
  if (h?.sha1Hash && n.sha1) return h.sha1Hash.toLowerCase() === n.sha1
  return false
}

/** Cuts the link with OneDrive: the node will be uploaded again as a new item. */
function detach(n: LibNode): void {
  n.remoteId = n.eTag = n.cTag = n.sha1 = n.sha256 = undefined
  n.metaDirty = false
  if (n.kind === 'notebook') {
    n.uploadedRev = -1
    n.needsDownload = false
  }
}

/**
 * Conflict: `n` keeps the local content and becomes a separate copy; a new
 * node takes the place of the OneDrive version, which will be downloaded.
 */
function forkConflict(nodes: LibNode[], n: LibNode, remoteName?: string, remoteParentId?: string): LibNode {
  const now = Date.now()
  const twin: LibNode = {
    id: uid(),
    kind: 'notebook',
    name: remoteName ?? n.name,
    parentId: remoteParentId ?? n.parentId,
    createdAt: now,
    updatedAt: now,
    remoteId: n.remoteId,
    eTag: n.eTag,
    pageIds: [],
    bg: n.bg,
    orient: n.orient,
    rev: 0,
    uploadedRev: 0,
    needsDownload: true,
  }
  detach(n)
  n.name = uniqueName(`${twin.name} (conflict ${conflictStamp(new Date(now))})`, siblingNames(nodes, n.parentId, 'notebook', n.id))
  n.updatedAt = now
  nodes.push(twin)
  return twin
}

const conflictText = (original: string, copy: string) =>
  `"${original}" was modified in two places. The changes you made here are kept in "${copy}".`

export class SyncEngine {
  status: SyncStatus = { state: 'disabled' }
  private running: Promise<void> | null = null
  private again = false
  private listeners = new Set<(e: SyncEvent) => void>()

  constructor(private host: SyncHost) {}

  subscribe(fn: (e: SyncEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(e: SyncEvent): void {
    for (const fn of this.listeners) fn(e)
  }

  private async setStatus(state: SyncState, message?: string): Promise<void> {
    this.status = { state, message, lastSync: await kvGet<number>('lastSync') }
    this.emit({ type: 'status' })
  }

  /** Recomputes the displayed state without sending anything (after a local change). */
  async refresh(): Promise<void> {
    if (this.running) return
    const auth = this.host.authState()
    if (auth !== 'ready') return this.setStatus(auth)
    if (!this.host.isOnline()) return this.setStatus('offline')
    if (this.status.state === 'error') return
    const pending = (await allNodes()).some(hasPendingSync)
    await this.setStatus(pending ? 'pending' : 'ok')
  }

  /** Starts a sync (or schedules another one if one is already running). */
  sync(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = this.loop().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async loop(): Promise<void> {
    let rounds = 0
    do {
      this.again = false
      const auth = this.host.authState()
      if (auth !== 'ready') return this.setStatus(auth)
      if (!this.host.isOnline()) return this.setStatus('offline')
      await this.setStatus('syncing')
      try {
        await this.cycle(this.host.graph())
        await kvSet('lastSync', Date.now())
      } catch (e) {
        if (e instanceof AuthRequiredError) return this.setStatus(this.host.authState() === 'ready' ? 'error' : 'signedOut', e.message)
        if (e instanceof GraphError && e.status === 0) return this.setStatus('offline')
        console.error('Sync', e)
        return this.setStatus('error', e instanceof Error ? e.message : String(e))
      }
    } while (this.again && ++rounds < 8)
    const pending = (await allNodes()).some(hasPendingSync)
    await this.setStatus(pending ? 'pending' : 'ok')
  }

  // ---------- Notices to the user ----------

  async notices(): Promise<Notice[]> {
    return (await kvGet<Notice[]>('notices')) ?? []
  }

  private async notify(texts: string[]): Promise<void> {
    if (!texts.length) return
    const list = await this.notices()
    for (const text of texts) list.push({ id: uid(), text, at: Date.now() })
    await kvSet('notices', list)
    this.emit({ type: 'notices' })
  }

  async dismissNotice(id: string): Promise<void> {
    await kvSet('notices', (await this.notices()).filter((n) => n.id !== id))
    this.emit({ type: 'notices' })
  }

  // ---------- Cycle ----------

  private async cycle(g: GraphClient): Promise<void> {
    let rootId = await kvGet<string>('rootRemoteId')
    if (!rootId) {
      rootId = (await g.ensureRoot(ONEDRIVE_FOLDER)).id
      await kvSet('rootRemoteId', rootId)
      await kvSet('deltaLink', undefined)
    }
    try {
      await this.pull(g, rootId)
    } catch (e) {
      if (!(e instanceof GraphError) || e.status !== 404) throw e
      // The Plume folder has disappeared from OneDrive. Nothing is deleted here:
      // all local content will be uploaded again into a recreated folder.
      await this.detachAll()
      await kvSet('rootRemoteId', undefined)
      await kvSet('deltaLink', undefined)
      await this.notify([`The "${ONEDRIVE_FOLDER}" folder had disappeared from OneDrive. It was recreated from the content of this device.`])
      this.again = true
      return
    }
    await this.pushDeletes(g)
    await this.pushFolders(g, rootId)
    await this.pushMeta(g, rootId)
    await this.pushNotebooks(g, rootId)
    await this.downloads(g)
  }

  private async detachAll(): Promise<void> {
    const gone: string[] = []
    await mutateNodes(async (s) => {
      for (const n of await s.all()) {
        if (n.deleted || (n.kind === 'notebook' && n.needsDownload && !isDirtyNotebook(n))) gone.push(n.id)
        else {
          detach(n)
          s.put(n)
        }
      }
    })
    await purgeNodes(gone)
    this.emit({ type: 'library' })
  }

  /** Applies locally the changes made on OneDrive. */
  private async pull(g: GraphClient, rootId: string): Promise<void> {
    const ch = await g.changes(rootId, await kvGet<string>('deltaLink'))
    const remote = new Map<string, DriveItem>()
    for (const it of ch.items) if (it.id !== rootId) remote.set(it.id, it)
    const openId = this.host.openNotebookId()
    const notices: string[] = []
    const removed = new Set<string>()
    let changed = false

    await mutateNodes(async (s) => {
      const nodes = await s.all()
      const byRemote = new Map<string, LibNode>()
      for (const n of nodes) if (n.remoteId) byRemote.set(n.remoteId, n)
      const dirty = new Set<LibNode>()
      const now = Date.now()
      const childrenOf = (id: string) => nodes.filter((c) => c.parentId === id && !removed.has(c.id))

      const remoteDelete = (n: LibNode): void => {
        if (removed.has(n.id) || !n.remoteId) return
        if (n.deleted) {
          removed.add(n.id)
        } else if (n.kind === 'folder') {
          for (const c of childrenOf(n.id)) remoteDelete(c)
          if (childrenOf(n.id).length === 0) removed.add(n.id)
          else {
            // Unsent local content remains: the folder will be recreated.
            detach(n)
            dirty.add(n)
          }
        } else if ((isDirtyNotebook(n) && !n.needsDownload) || n.id === openId) {
          detach(n)
          dirty.add(n)
          notices.push(`"${n.name}" was deleted on OneDrive while it contained unsent changes. It was kept and will be uploaded again.`)
        } else {
          removed.add(n.id)
        }
      }

      const done = new Map<string, LibNode | undefined>()
      const ensure = (it: DriveItem): LibNode | undefined => {
        if (done.has(it.id)) return done.get(it.id)
        done.set(it.id, undefined)
        const n = upsert(it)
        done.set(it.id, n)
        return n
      }
      const upsert = (it: DriveItem): LibNode | undefined => {
        const isFolder = !!it.folder
        if (!it.name || (!isFolder && !(it.file && /\.pdf$/i.test(it.name)))) return undefined
        const pid = it.parentReference?.id
        let parentId: string | undefined
        if (pid === rootId) parentId = ROOT
        else if (pid) {
          const pIt = remote.get(pid)
          const p = pIt && !pIt.deleted ? ensure(pIt) : byRemote.get(pid)
          if (p && p.kind === 'folder' && !p.deleted && !removed.has(p.id)) parentId = p.id
        }
        if (!parentId) return undefined
        const kind = isFolder ? 'folder' : 'notebook'
        const name = isFolder ? it.name : it.name.replace(/\.pdf$/i, '')
        const sameSpot = (c: LibNode) => c.kind === kind && c.parentId === parentId && !c.deleted && c.name.toLowerCase() === name.toLowerCase()

        let n = byRemote.get(it.id)
        if (n && (removed.has(n.id) || n.deleted || n.kind !== kind)) return n.deleted ? n : undefined
        if (!n && isFolder) {
          // A folder with the same name created here and not yet uploaded: it is the same one.
          n = nodes.find((c) => !c.remoteId && sameSpot(c))
          if (n) {
            n.remoteId = it.id
            n.name = name
            n.metaDirty = false
            byRemote.set(it.id, n)
          }
        }
        if (!n) {
          // A local notebook with the same name, never uploaded, gives up the name.
          for (const c of nodes) {
            if (!c.remoteId && sameSpot(c)) {
              c.name = uniqueName(c.name, [...siblingNames(nodes, parentId, kind, c.id), name])
              dirty.add(c)
            }
          }
          n = { id: uid(), kind, name, parentId, createdAt: now, updatedAt: now, remoteId: it.id }
          if (!isFolder) Object.assign(n, { pageIds: [], bg: 'blank', orient: 'portrait', rev: 0, uploadedRev: 0, needsDownload: true } satisfies Partial<LibNode>)
          nodes.push(n)
          byRemote.set(it.id, n)
        } else if (!n.metaDirty && (n.name !== name || n.parentId !== parentId)) {
          n.name = name
          n.parentId = parentId
        } else if (n.eTag === it.eTag && (isFolder || sameContent(n, it))) {
          return n
        }
        n.eTag = it.eTag
        dirty.add(n)

        if (!isFolder && !n.needsDownload && n.cTag !== undefined && !sameContent(n, it)) {
          if (n.foreign) {
            n.cTag = it.cTag
          } else if (isDirtyNotebook(n)) {
            const original = n.name
            const twin = forkConflict(nodes, n, name, parentId)
            twin.eTag = it.eTag
            byRemote.set(it.id, twin)
            dirty.add(twin)
            notices.push(conflictText(original, n.name))
          } else {
            n.needsDownload = true
          }
        } else if (!isFolder && it.cTag && n.cTag !== undefined) {
          n.cTag = it.cTag
        }
        return n
      }
      // First creations, renames and moves, then deletions: a file moved out
      // of a folder before that folder is deleted must not disappear with
      // it.
      for (const it of remote.values()) if (!it.deleted) ensure(it)

      for (const it of remote.values()) {
        const n = it.deleted && byRemote.get(it.id)
        if (n) remoteDelete(n)
      }
      if (ch.full) {
        for (const n of nodes) {
          const it = n.remoteId && remote.get(n.remoteId)
          if (n.remoteId && (!it || it.deleted)) remoteDelete(n)
        }
      }

      for (const n of dirty) if (!removed.has(n.id)) s.put(n)
      for (const id of removed) s.delete(id)
      changed = dirty.size > 0 || removed.size > 0
    })

    if (removed.size) await purgeNodes([...removed])
    await kvSet('deltaLink', ch.link)
    await this.notify(notices)
    if (changed) this.emit({ type: 'library' })
  }

  private async pushDeletes(g: GraphClient): Promise<void> {
    for (const n of await allNodes()) {
      if (!n.deleted) continue
      if (n.remoteId) await g.remove(n.remoteId)
      await purgeNodes([n.id])
    }
  }

  /** OneDrive id of the parent folder, if it already exists there. */
  private parentRemote(n: LibNode, byId: Map<string, LibNode>, rootId: string): string | undefined {
    if (n.parentId === ROOT) return rootId
    const p = byId.get(n.parentId)
    return p && !p.deleted ? p.remoteId : undefined
  }

  private async pushFolders(g: GraphClient, rootId: string): Promise<void> {
    for (let round = 0; round < 50; round++) {
      const nodes = await allNodes()
      const byId = new Map(nodes.map((n) => [n.id, n]))
      const ready = nodes.filter((n) => n.kind === 'folder' && !n.deleted && !n.remoteId && this.parentRemote(n, byId, rootId))
      if (!ready.length) return
      for (const n of ready) {
        const parent = this.parentRemote(n, byId, rootId)!
        let item: DriveItem | undefined
        try {
          item = await g.createFolder(parent, n.name)
        } catch (e) {
          if (!(e instanceof GraphError) || e.status !== 409) throw e
          const existing = await g.childByName(parent, n.name)
          if (existing?.folder && !nodes.some((o) => o.remoteId === existing.id)) item = existing
        }
        if (!item) {
          await updateNode(n.id, (m) => void (m.name = uniqueName(m.name, [m.name])))
          continue
        }
        const created = item
        await updateNode(n.id, (m) => {
          m.remoteId = created.id
          m.eTag = created.eTag
          m.metaDirty = m.name !== n.name || m.parentId !== n.parentId
        })
      }
      this.emit({ type: 'library' })
    }
  }

  private async pushMeta(g: GraphClient, rootId: string): Promise<void> {
    const nodes = await allNodes()
    const byId = new Map(nodes.map((n) => [n.id, n]))
    for (const n of nodes) {
      if (n.deleted || !n.remoteId || !n.metaDirty) continue
      const parent = this.parentRemote(n, byId, rootId)
      if (!parent) continue
      let item: DriveItem
      try {
        item = await g.patch(n.remoteId, n.kind === 'folder' ? n.name : `${n.name}.pdf`, parent)
      } catch (e) {
        if (!(e instanceof GraphError) || (e.status !== 409 && e.status !== 404)) throw e
        // 409: name already taken on OneDrive; 404: the item no longer exists there.
        await updateNode(n.id, (m) => {
          if (e.status === 409) m.name = uniqueName(m.name, [m.name])
          else detach(m)
        })
        this.again = true
        this.emit({ type: 'library' })
        continue
      }
      await updateNode(n.id, (m) => {
        m.eTag = item.eTag
        m.metaDirty = m.name !== n.name || m.parentId !== n.parentId
      })
    }
  }

  private async pushNotebooks(g: GraphClient, rootId: string): Promise<void> {
    const candidates = (await allNodes()).filter((n) => !n.deleted && isDirtyNotebook(n))
    for (const c of candidates) {
      const nodes = await allNodes()
      const n = nodes.find((o) => o.id === c.id)
      if (!n || n.deleted || !isDirtyNotebook(n)) continue
      const parent = this.parentRemote(n, new Map(nodes.map((o) => [o.id, o])), rootId)
      if (!parent) continue
      if (n.needsDownload && n.remoteId) {
        // Modified here while a newer version is waiting on OneDrive.
        await this.fork(n.id)
        continue
      }
      if (!n.pageIds?.length) continue

      const built = await this.host.buildPdf(n.id)
      const [sha1, sha256] = await Promise.all([digest('SHA-1', built.bytes), digest('SHA-256', built.bytes)])
      let item: DriveItem
      try {
        item = n.remoteId ? await g.uploadReplace(n.remoteId, built.bytes, n.eTag) : await g.uploadNew(parent, `${n.name}.pdf`, built.bytes)
      } catch (e) {
        if (!(e instanceof GraphError) || ![404, 409, 412].includes(e.status)) throw e
        if (!n.remoteId) {
          // A file with the same name already exists on OneDrive: pick another one.
          await updateNode(n.id, (m) => void (m.name = uniqueName(m.name, [m.name])))
        } else if (e.status === 404) {
          await updateNode(n.id, detach)
        } else {
          const current = await g.getItem(n.remoteId)
          if (sameContent(n, current)) {
            await updateNode(n.id, (m) => {
              m.eTag = current.eTag
              m.cTag = current.cTag ?? m.cTag
            })
          } else {
            await this.fork(n.id, current)
          }
        }
        this.again = true
        this.emit({ type: 'library' })
        continue
      }
      await updateNode(n.id, (m) => {
        if (!m.remoteId) m.metaDirty = m.name !== n.name || m.parentId !== n.parentId
        m.remoteId = item.id
        m.eTag = item.eTag
        m.cTag = item.cTag ?? ''
        m.sha1 = sha1
        m.sha256 = sha256
        m.uploadedRev = built.rev
      })
      this.emit({ type: 'library' })
    }
  }

  private async fork(id: string, current?: DriveItem): Promise<void> {
    let text = ''
    await mutateNodes(async (s) => {
      const nodes = await s.all()
      const n = nodes.find((o) => o.id === id)
      if (!n || !n.remoteId) return
      const twin = forkConflict(nodes, n, current?.name?.replace(/\.pdf$/i, ''))
      if (current?.eTag) twin.eTag = current.eTag
      s.put(n)
      s.put(twin)
      text = conflictText(twin.name, n.name)
    })
    if (text) await this.notify([text])
    this.again = true
    this.emit({ type: 'library' })
  }

  /** Downloads the notebooks for which OneDrive holds a newer version. */
  private async downloads(g: GraphClient): Promise<void> {
    for (const c of await allNodes()) {
      if (c.kind !== 'notebook' || c.deleted || !c.needsDownload || !c.remoteId) continue
      const n = await getNode(c.id)
      if (!n || n.deleted || !n.needsDownload || !n.remoteId || isDirtyNotebook(n)) continue
      let item: DriveItem
      let bytes: Uint8Array
      try {
        item = await g.getItem(n.remoteId)
        bytes = await g.download(item)
      } catch (e) {
        if (e instanceof GraphError && e.status === 404) continue // the next cycle will notice the deletion
        throw e
      }
      const data = await this.host.extract(bytes)
      const [sha1, sha256] = await Promise.all([digest('SHA-1', bytes), digest('SHA-256', bytes)])
      const stamp = (m: LibNode) => {
        m.needsDownload = false
        m.eTag = item.eTag
        m.cTag = item.cTag ?? ''
        m.sha1 = sha1
        m.sha256 = sha256
      }
      if (!data) {
        await updateNode(n.id, (m) => {
          stamp(m)
          m.foreign = true
        })
      } else {
        const content = dataToContent(n.id, data)
        if (!content.pages.length) content.pages.push({ id: uid(), notebookId: n.id, bg: data.bg, orient: data.orient, rev: 0 } satisfies Page)
        const ok = await replaceNotebookContent(n.id, n.rev ?? 0, content, (m) => {
          stamp(m)
          m.foreign = false
          m.bg = data.bg
          m.orient = data.orient
          m.rev = (m.rev ?? 0) + 1
          m.uploadedRev = m.rev
        })
        if (ok) this.emit({ type: 'replaced', notebookId: n.id })
      }
      this.emit({ type: 'library' })
    }
  }
}
