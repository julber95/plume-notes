// Client minimal de l'API Microsoft Graph pour OneDrive.

import { GRAPH_BASE } from '../config'

export interface DriveItem {
  id: string
  name?: string
  eTag?: string
  cTag?: string
  size?: number
  parentReference?: { id?: string }
  folder?: object
  file?: { hashes?: { sha1Hash?: string; sha256Hash?: string } }
  deleted?: object
  '@microsoft.graph.downloadUrl'?: string
}

export class GraphError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
  /** Pas de réseau, ou serveur momentanément indisponible. */
  get transient(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500
  }
}

/** Levée quand l'utilisateur doit se reconnecter à son compte Microsoft. */
export class AuthRequiredError extends Error {}

export interface RemoteChanges {
  items: DriveItem[]
  /** Lien à réutiliser pour ne demander que les changements suivants. */
  link?: string
  /** true : `items` est la liste complète du dossier, pas seulement les changements. */
  full: boolean
}

const SELECT = '$select=id,name,eTag,cTag,size,parentReference,folder,file,deleted'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class GraphClient {
  constructor(
    private getToken: () => Promise<string>,
    private fetchFn: typeof fetch = (...a) => fetch(...a),
  ) {}

  private async request(method: string, url: string, init: { headers?: Record<string, string>; body?: BodyInit; auth?: boolean } = {}): Promise<Response> {
    const full = url.startsWith('http') ? url : GRAPH_BASE + url
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { ...init.headers }
      if (init.auth !== false) headers.Authorization = `Bearer ${await this.getToken()}`
      let res: Response
      try {
        res = await this.fetchFn(full, { method, headers, body: init.body })
      } catch (e) {
        throw new GraphError(0, 'network', e instanceof Error ? e.message : 'Réseau indisponible')
      }
      if (res.ok) return res
      if ((res.status === 429 || res.status === 503) && attempt < 3) {
        const wait = Math.min(Number(res.headers.get('Retry-After')) || 2 ** attempt, 30)
        await sleep(wait * 1000)
        continue
      }
      let code = String(res.status)
      let message = res.statusText
      try {
        const body = (await res.json()) as { error?: { code?: string; message?: string } }
        code = body.error?.code ?? code
        message = body.error?.message ?? message
      } catch {
        // corps non JSON
      }
      if (res.status === 401) throw new AuthRequiredError(message)
      throw new GraphError(res.status, code, message)
    }
  }

  private async json<T>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await this.request(method, url, {
      headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return (res.status === 204 ? undefined : await res.json()) as T
  }

  /** Nom du titulaire du OneDrive (pour l'afficher dans les réglages). */
  async owner(): Promise<string> {
    const d = await this.json<{ owner?: { user?: { displayName?: string } } }>('GET', '/me/drive?$select=owner')
    return d.owner?.user?.displayName ?? ''
  }

  /** Trouve ou crée le dossier racine de l'application dans OneDrive. */
  async ensureRoot(name: string): Promise<DriveItem> {
    try {
      const item = await this.json<DriveItem>('GET', `/me/drive/root:/${encodeURIComponent(name)}?${SELECT}`)
      if (item.folder) return item
    } catch (e) {
      if (!(e instanceof GraphError) || e.status !== 404) throw e
    }
    return this.json<DriveItem>('POST', '/me/drive/root/children', { name, folder: {}, '@microsoft.graph.conflictBehavior': 'rename' })
  }

  /** Changements du dossier depuis `link` (ou contenu complet sans `link`). */
  async changes(rootId: string, link?: string): Promise<RemoteChanges> {
    const items: DriveItem[] = []
    let full = !link
    let url = link ?? `/me/drive/items/${rootId}/delta?${SELECT}`
    try {
      for (;;) {
        const page = await this.json<{ value: DriveItem[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string }>('GET', url)
        items.push(...page.value)
        if (page['@odata.nextLink']) url = page['@odata.nextLink']
        else return { items, link: page['@odata.deltaLink'], full }
      }
    } catch (e) {
      if (!(e instanceof GraphError) || e.transient) throw e
      if (e.status === 404 && !link) throw e
      if (link) {
        // Lien périmé (410) ou refusé : on repart d'une énumération complète.
        return this.changes(rootId)
      }
      // Suivi des changements indisponible sur ce dossier : parcours classique.
      full = true
      return { items: await this.listTree(rootId), full }
    }
  }

  private async listTree(folderId: string): Promise<DriveItem[]> {
    const out: DriveItem[] = []
    let url: string | undefined = `/me/drive/items/${folderId}/children?${SELECT}&$top=200`
    while (url) {
      const page: { value: DriveItem[]; '@odata.nextLink'?: string } = await this.json('GET', url)
      out.push(...page.value)
      url = page['@odata.nextLink']
    }
    for (const it of [...out]) if (it.folder) out.push(...(await this.listTree(it.id)))
    return out
  }

  getItem(id: string): Promise<DriveItem> {
    return this.json<DriveItem>('GET', `/me/drive/items/${id}?${SELECT},@microsoft.graph.downloadUrl`)
  }

  async childByName(parentId: string, name: string): Promise<DriveItem | undefined> {
    try {
      return await this.json<DriveItem>('GET', `/me/drive/items/${parentId}:/${encodeURIComponent(name)}?${SELECT}`)
    } catch (e) {
      if (e instanceof GraphError && e.status === 404) return undefined
      throw e
    }
  }

  createFolder(parentId: string, name: string): Promise<DriveItem> {
    return this.json<DriveItem>('POST', `/me/drive/items/${parentId}/children`, { name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' })
  }

  /** Renomme et/ou déplace un élément. */
  patch(id: string, name: string, parentId: string): Promise<DriveItem> {
    return this.json<DriveItem>('PATCH', `/me/drive/items/${id}`, { name, parentReference: { id: parentId } })
  }

  /** Supprime un élément (il part dans la corbeille OneDrive). */
  async remove(id: string): Promise<void> {
    try {
      await this.request('DELETE', `/me/drive/items/${id}`)
    } catch (e) {
      if (!(e instanceof GraphError) || e.status !== 404) throw e
    }
  }

  /** Envoie un nouveau fichier ; échoue (409) si le nom est déjà pris. */
  async uploadNew(parentId: string, filename: string, bytes: Uint8Array): Promise<DriveItem> {
    const url = `/me/drive/items/${parentId}:/${encodeURIComponent(filename)}:/content?@microsoft.graph.conflictBehavior=fail`
    const res = await this.request('PUT', url, { headers: { 'Content-Type': 'application/pdf' }, body: bytes as BodyInit })
    return (await res.json()) as DriveItem
  }

  /** Remplace le contenu d'un fichier ; échoue (412) s'il a changé depuis `eTag`. */
  async uploadReplace(id: string, bytes: Uint8Array, eTag?: string): Promise<DriveItem> {
    const headers: Record<string, string> = { 'Content-Type': 'application/pdf' }
    if (eTag) headers['If-Match'] = eTag
    const res = await this.request('PUT', `/me/drive/items/${id}/content`, { headers, body: bytes as BodyInit })
    return (await res.json()) as DriveItem
  }

  async download(item: DriveItem): Promise<Uint8Array> {
    const direct = item['@microsoft.graph.downloadUrl']
    const res = direct ? await this.request('GET', direct, { auth: false }) : await this.request('GET', `/me/drive/items/${item.id}/content`)
    return new Uint8Array(await res.arrayBuffer())
  }
}
