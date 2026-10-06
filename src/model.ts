// Types et constantes partagés. Toutes les coordonnées sont exprimées en points
// PDF (1/72 de pouce), origine en haut à gauche de la page.

export const A4 = { w: 595.28, h: 841.89 }
export const MM = 72 / 25.4

export type Background = 'blank' | 'lined' | 'grid' | 'dots' | 'seyes'
export type Orientation = 'portrait' | 'landscape'
export type StrokeTool = 'pen' | 'highlighter' | 'line'

export const BACKGROUNDS: { id: Background; label: string }[] = [
  { id: 'blank', label: 'Blanc' },
  { id: 'lined', label: 'Ligné' },
  { id: 'grid', label: 'Quadrillé' },
  { id: 'dots', label: 'Pointillé' },
  { id: 'seyes', label: 'Seyès' },
]

export interface Stroke {
  id: string
  pageId: string
  seq: number
  tool: StrokeTool
  color: string
  width: number
  /** Triplets x, y, pression (0..1). */
  pts: Float32Array
}

export interface Page {
  id: string
  notebookId: string
  bg: Background
  orient: Orientation
  /** Incrémenté à chaque modification de la page. */
  rev: number
}

export const ROOT = 'root'

export interface LibNode {
  id: string
  kind: 'folder' | 'notebook'
  name: string
  /** Identifiant local du dossier parent, ou ROOT. */
  parentId: string
  createdAt: number
  updatedAt: number

  // État de synchronisation OneDrive
  remoteId?: string
  eTag?: string
  cTag?: string
  sha1?: string
  sha256?: string
  /** Nom ou emplacement modifié localement, à reporter sur OneDrive. */
  metaDirty?: boolean
  /** Supprimé localement, suppression OneDrive en attente. */
  deleted?: boolean

  // Blocs-notes uniquement
  pageIds?: string[]
  bg?: Background
  orient?: Orientation
  /** Incrémenté à chaque modification du contenu. */
  rev?: number
  /** Valeur de rev au dernier envoi réussi (-1 : jamais envoyé). */
  uploadedRev?: number
  /** La version OneDrive est plus récente que la copie locale. */
  needsDownload?: boolean
  /** PDF présent dans le dossier mais non créé par Plume. */
  foreign?: boolean
}

export function pageSize(orient: Orientation): { w: number; h: number } {
  return orient === 'landscape' ? { w: A4.h, h: A4.w } : { w: A4.w, h: A4.h }
}

export function uid(): string {
  return crypto.randomUUID()
}

export function isDirtyNotebook(n: LibNode): boolean {
  return n.kind === 'notebook' && !n.foreign && (!n.remoteId || n.rev !== n.uploadedRev)
}

export function hasPendingSync(n: LibNode): boolean {
  if (n.deleted) return true
  if (n.kind === 'notebook' && n.foreign) return false
  return !n.remoteId || !!n.metaDirty || isDirtyNotebook(n) || !!n.needsDownload
}

const FORBIDDEN = /["*:<>?/\\|\u0000-\u001f]/g
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9]|\.lock|desktop\.ini)$/i

/** Rend un nom acceptable pour OneDrive. */
export function sanitizeName(raw: string): string {
  let s = raw.replace(FORBIDDEN, '-').replace(/\s+/g, ' ').trim()
  s = s.replace(/[. ]+$/, '').replace(/^[ ~]+/, '')
  if (s.length > 120) s = s.slice(0, 120).trim()
  if (!s || RESERVED.test(s)) s = s ? `${s}_` : 'Sans titre'
  return s
}

/** Retourne `name`, suffixé « (2) », « (3) »… s'il est déjà pris. */
export function uniqueName(name: string, taken: Iterable<string>): string {
  const used = new Set<string>()
  for (const t of taken) used.add(t.toLowerCase())
  if (!used.has(name.toLowerCase())) return name
  const m = /^(.*) \((\d+)\)$/.exec(name)
  const base = m ? m[1] : name
  let i = m ? parseInt(m[2], 10) + 1 : 2
  while (used.has(`${base} (${i})`.toLowerCase())) i++
  return `${base} (${i})`
}

export function siblingNames(nodes: Iterable<LibNode>, parentId: string, kind: LibNode['kind'], exceptId?: string): string[] {
  const out: string[] = []
  for (const n of nodes) {
    if (n.parentId === parentId && n.kind === kind && !n.deleted && n.id !== exceptId) out.push(n.name)
  }
  return out
}

export function conflictStamp(d: Date): string {
  const p = (v: number) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}h${p(d.getMinutes())}`
}
