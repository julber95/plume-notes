// Faux OneDrive en mémoire, au niveau HTTP : le vrai client Graph de
// l'application est utilisé tel quel dans les tests.

interface Item {
  id: string
  name: string
  parentId: string | null
  folder: boolean
  content?: Uint8Array
  sha256?: string
  eTagN: number
  cTagN: number
  deleted?: boolean
  changedAt: number
}

const BASE = 'https://graph.microsoft.com/v1.0'

export class FakeDrive {
  items = new Map<string, Item>()
  private seq = 0
  private nextId = 1
  online = true
  /** Journal des requêtes « MÉTHODE chemin ». */
  calls: string[] = []
  /** Appelé une fois juste avant le prochain envoi de contenu (PUT). */
  beforeNextPut: (() => void) | null = null
  /** false : le suivi des changements (delta) est refusé. */
  deltaSupported = true
  tokenValid = true

  constructor() {
    this.items.set('ROOT', { id: 'ROOT', name: 'root', parentId: null, folder: true, eTagN: 0, cTagN: 0, changedAt: 0 })
  }

  // ----- Actions « faites depuis un autre appareil » -----

  private touch(it: Item, content = false): void {
    it.eTagN++
    if (content) it.cTagN++
    it.changedAt = ++this.seq
  }

  children(parentId: string): Item[] {
    return [...this.items.values()].filter((i) => i.parentId === parentId && !i.deleted)
  }

  find(path: string): Item | undefined {
    let cur: Item | undefined = this.items.get('ROOT')
    for (const part of path.split('/').filter(Boolean)) {
      cur = cur && this.children(cur.id).find((c) => c.name.toLowerCase() === part.toLowerCase())
    }
    return cur
  }

  /** Arborescence lisible, pour les assertions. */
  tree(id = 'ROOT', prefix = ''): string[] {
    const out: string[] = []
    for (const c of this.children(id).sort((a, b) => a.name.localeCompare(b.name))) {
      out.push(prefix + c.name + (c.folder ? '/' : ''))
      if (c.folder) out.push(...this.tree(c.id, `${prefix}${c.name}/`))
    }
    return out
  }

  add(parentId: string, name: string, content?: Uint8Array): Item {
    const it: Item = { id: `I${this.nextId++}`, name, parentId, folder: !content, content, eTagN: 0, cTagN: 0, changedAt: 0 }
    this.items.set(it.id, it)
    this.touch(it, true)
    return it
  }

  rename(it: Item, name: string): void {
    it.name = name
    this.touch(it)
  }

  move(it: Item, parent: Item): void {
    it.parentId = parent.id
    this.touch(it)
  }

  replace(it: Item, content: Uint8Array): void {
    it.content = content
    it.sha256 = undefined
    this.touch(it, true)
  }

  delete(it: Item): void {
    // Comme OneDrive peut le faire : seul l'élément supprimé est signalé, pas son contenu.
    const mark = (i: Item) => {
      i.deleted = true
      for (const c of [...this.items.values()].filter((x) => x.parentId === i.id)) mark(c)
    }
    mark(it)
    it.changedAt = ++this.seq
  }

  // ----- Serveur HTTP -----

  private async hashAll(): Promise<void> {
    for (const it of this.items.values()) {
      if (!it.content || it.sha256) continue
      const d = new Uint8Array(await crypto.subtle.digest('SHA-256', it.content as BufferSource))
      it.sha256 = Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()
    }
  }

  private async runPutHook(): Promise<void> {
    const hook = this.beforeNextPut
    this.beforeNextPut = null
    hook?.()
    if (!this.online) throw new TypeError('Failed to fetch')
    await this.hashAll()
  }

  private json(it: Item, withDownload = false): Record<string, unknown> {
    const out: Record<string, unknown> = {
      id: it.id,
      name: it.name,
      eTag: `"{${it.id}},${it.eTagN}"`,
      cTag: `"c:{${it.id}},${it.cTagN}"`,
      parentReference: { id: it.parentId },
    }
    if (it.deleted) out.deleted = {}
    if (it.folder) out.folder = {}
    else {
      out.file = { hashes: { sha256Hash: it.sha256 } }
      out.size = it.content!.length
      if (withDownload) out['@microsoft.graph.downloadUrl'] = `https://download.example/${it.id}`
    }
    return out
  }

  private inTree(it: Item, rootId: string): boolean {
    for (let cur: Item | undefined = it; cur; cur = cur.parentId ? this.items.get(cur.parentId) : undefined) if (cur.id === rootId) return true
    return false
  }

  private nameTaken(parentId: string, name: string, except?: string): boolean {
    return this.children(parentId).some((c) => c.id !== except && c.name.toLowerCase() === name.toLowerCase())
  }

  fetch: typeof fetch = async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (!this.online) throw new TypeError('Failed to fetch')
    await this.hashAll()
    const reply = (status: number, body?: unknown) =>
      new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    const fail = (status: number, code: string) => reply(status, { error: { code, message: code } })

    if (url.startsWith('https://download.example/')) {
      this.calls.push('GET download')
      const it = this.items.get(url.split('/').pop()!)
      return it?.content ? new Response(it.content as BodyInit) : fail(404, 'itemNotFound')
    }
    const headers = new Headers(init?.headers)
    if (!this.tokenValid || headers.get('Authorization') !== 'Bearer TOKEN') return fail(401, 'InvalidAuthenticationToken')
    const u = new URL(url)
    const path = decodeURIComponent(u.pathname.replace('/v1.0', ''))
    this.calls.push(`${method} ${path}`)
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, any>) : undefined
    let m: RegExpExecArray | null

    if (method === 'GET' && path === '/me/drive') return reply(200, { owner: { user: { displayName: 'Valérie' } } })

    if (method === 'GET' && (m = /^\/me\/drive\/root:\/([^:]+)$/.exec(path))) {
      const it = this.find(m[1])
      return it ? reply(200, this.json(it)) : fail(404, 'itemNotFound')
    }

    if (method === 'GET' && ((m = /^\/me\/drive\/items\/([^/:]+)\/delta$/.exec(path)) || path === '/delta')) {
      if (!this.deltaSupported) return fail(400, 'notSupported')
      const rootId = m ? m[1] : u.searchParams.get('root')!
      const since = m ? -1 : Number(u.searchParams.get('token'))
      const root = this.items.get(rootId)
      if (!root || root.deleted) return fail(404, 'itemNotFound')
      const value = [...this.items.values()]
        .filter((i) => this.inTree(i, rootId) && (since < 0 ? !i.deleted : i.changedAt > since))
        .map((i) => this.json(i))
      return reply(200, { value, '@odata.deltaLink': `${BASE}/delta?token=${this.seq}&root=${rootId}` })
    }

    if (method === 'GET' && (m = /^\/me\/drive\/items\/([^/:]+)\/children$/.exec(path))) {
      return reply(200, { value: this.children(m[1]).map((i) => this.json(i)) })
    }

    if (method === 'GET' && (m = /^\/me\/drive\/items\/([^/:]+):\/([^:]+)$/.exec(path))) {
      const it = this.children(m[1]).find((c) => c.name.toLowerCase() === m![2].toLowerCase())
      return it ? reply(200, this.json(it)) : fail(404, 'itemNotFound')
    }

    if (method === 'POST' && (m = /^\/me\/drive\/(?:root|items\/([^/:]+))\/children$/.exec(path))) {
      const parentId = m[1] ?? 'ROOT'
      const parent = this.items.get(parentId)
      if (!parent || parent.deleted) return fail(404, 'itemNotFound')
      if (this.nameTaken(parentId, body!.name)) return fail(409, 'nameAlreadyExists')
      return reply(201, this.json(this.add(parentId, body!.name)))
    }

    if (method === 'PUT' && (m = /^\/me\/drive\/items\/([^/:]+):\/([^:]+):\/content$/.exec(path))) {
      await this.runPutHook()
      const parent = this.items.get(m[1])
      if (!parent || parent.deleted) return fail(404, 'itemNotFound')
      if (this.nameTaken(m[1], m[2])) return fail(409, 'nameAlreadyExists')
      const created = this.add(m[1], m[2], new Uint8Array(init!.body as Uint8Array))
      await this.hashAll()
      return reply(201, this.json(created))
    }

    if ((m = /^\/me\/drive\/items\/([^/:]+)(\/content)?$/.exec(path))) {
      if (method === 'PUT' && m[2]) {
        await this.runPutHook()
      }
      const it = this.items.get(m[1])
      if (!it || it.deleted) return fail(404, 'itemNotFound')
      if (method === 'GET' && !m[2]) return reply(200, this.json(it, true))
      if (method === 'DELETE') {
        this.delete(it)
        return reply(204)
      }
      if (method === 'PATCH') {
        const parentId = body!.parentReference?.id ?? it.parentId
        const name = body!.name ?? it.name
        if (this.nameTaken(parentId, name, it.id)) return fail(409, 'nameAlreadyExists')
        it.name = name
        it.parentId = parentId
        this.touch(it)
        return reply(200, this.json(it))
      }
      if (method === 'PUT' && m[2]) {
        const match = headers.get('If-Match')
        if (match && match !== `"{${it.id}},${it.eTagN}"`) return fail(412, 'resourceModified')
        this.replace(it, new Uint8Array(init!.body as Uint8Array))
        await this.hashAll()
        return reply(200, this.json(it))
      }
    }
    return fail(400, `route inconnue : ${method} ${path}`)
  }
}
