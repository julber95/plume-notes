// Shared types and constants. All coordinates are in PDF points (1/72 inch),
// with the origin at the top-left corner of the page.

export const A4 = { w: 595.28, h: 841.89 }
export const MM = 72 / 25.4

export type Background = 'blank' | 'lined' | 'grid' | 'dots' | 'seyes'
export type Orientation = 'portrait' | 'landscape'
export type StrokeTool = 'pen' | 'pencil' | 'highlighter' | 'line'

export const BACKGROUNDS: { id: Background; label: string }[] = [
  { id: 'blank', label: 'Blank' },
  { id: 'lined', label: 'Lined' },
  { id: 'grid', label: 'Grid' },
  { id: 'dots', label: 'Dotted' },
  { id: 'seyes', label: 'Seyès' },
]

export interface Stroke {
  id: string
  pageId: string
  seq: number
  tool: StrokeTool
  color: string
  width: number
  /** Triplets x, y, pressure (0..1). */
  pts: Float32Array
}

export interface Page {
  id: string
  notebookId: string
  bg: Background
  orient: Orientation
  /** Incremented on every change to the page. */
  rev: number
}

export const ROOT = 'root'

export interface LibNode {
  id: string
  kind: 'folder' | 'notebook'
  name: string
  /** Local id of the parent folder, or ROOT. */
  parentId: string
  createdAt: number
  updatedAt: number

  // OneDrive sync state
  remoteId?: string
  eTag?: string
  cTag?: string
  sha1?: string
  sha256?: string
  /** Name or location changed locally, to be applied on OneDrive. */
  metaDirty?: boolean
  /** Deleted locally, OneDrive deletion pending. */
  deleted?: boolean

  // Notebooks only
  pageIds?: string[]
  bg?: Background
  orient?: Orientation
  /** Incremented on every content change. */
  rev?: number
  /** Value of rev at the last successful upload (-1: never uploaded). */
  uploadedRev?: number
  /** The OneDrive version is newer than the local copy. */
  needsDownload?: boolean
  /** PDF present in the folder but not created by Plume. */
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

/** Makes a name acceptable to OneDrive. */
export function sanitizeName(raw: string): string {
  let s = raw.replace(FORBIDDEN, '-').replace(/\s+/g, ' ').trim()
  s = s.replace(/[. ]+$/, '').replace(/^[ ~]+/, '')
  if (s.length > 120) s = s.slice(0, 120).trim()
  if (!s || RESERVED.test(s)) s = s ? `${s}_` : 'Untitled'
  return s
}

/** Returns `name`, suffixed with "(2)", "(3)"… if it is already taken. */
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
