// Library: folders and notebooks, as they appear in OneDrive.

import { COVER_COLORS, COVER_TEMPLATES, drawCover, type Cover, type CoverTemplate } from '../covers'
import { allNodes, kvGet, kvSet, updateNode } from '../db'
import { createFolder, createNotebook, deleteNode, importNotebook, moveNode, pathTo, renameNode, setLook, subtree } from '../library'
import { DEFAULT_FOLDER_COLOR, DEFAULT_NOTEBOOK_COLOR, FOLDER_COLORS, NOTEBOOK_COLORS, SYMBOLS, firstGlyph, folderIcon, notebookIcon, symbolIcon } from '../looks'
import { BACKGROUNDS, ROOT, isDirtyNotebook, pageSize, uid, type Background, type LibNode, type Look, type Orientation, type Page } from '../model'
import { extractData } from '../pdf/client'
import { dataToContent } from '../pdf/codec'
import { preparePicture } from './pictures'
import type { SyncEngine } from '../sync/engine'
import { openThemeMenu } from './settings'
import { button, confirmDialog, dialogButtons, h, iconButton, icons, logo, openDialog, openMenu, promptDialog, toast } from './dom'

export interface LibraryDeps {
  engine: SyncEngine
  syncChip: HTMLElement
  /** Opens a folder or a notebook. */
  open(node: LibNode): void
  goTo(folderId: string): void
  openSettings(): void
  /** The library was modified locally. */
  changed(): void
  /** false: sync is not active (local deletion only). */
  synced(): boolean
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

/** The search in progress, kept when the library redraws itself (after a sync, for instance). */
const searching = { folder: '', query: '', focused: false }

/** Shown in place of a folder: everything marked as a favourite, wherever it is. */
export const FAVOURITES = '~favourites'
const LONG_PRESS_MS = 500
const TREE_KEY = 'plume.tree'
const OPEN_KEY = 'plume.treeOpen'
/** Too narrow for the folder tree to sit beside the content: it slides over it instead. */
const narrow = window.matchMedia('(max-width: 699px)')
/** Is the tree shown over the content (narrow screens only)? */
let drawer = false
/** Folder shown at the last drawing: its parents are unfolded when it changes. */
let lastFolder: string | null = null

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // storage unavailable: the choice lasts until the application is closed
  }
}

/** Folders unfolded in the tree. */
const unfolded = new Set<string>(
  (() => {
    try {
      const v: unknown = JSON.parse(stored(OPEN_KEY) ?? '[]')
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  })(),
)

const treeShown = () => (narrow.matches ? drawer : stored(TREE_KEY) !== '0')

interface NotebookOptions {
  bg: Background
  orient: Orientation
  /** Cover template used last time (none if absent), and its colour. */
  coverTemplate?: CoverTemplate
  coverColor?: string
}

interface NewNotebook {
  name: string
  bg: Background
  orient: Orientation
  coverColor: string
  cover?: Cover
}

/** Everything chosen when creating a notebook: its name, its cover and its pages. */
function newNotebookDialog(last: NotebookOptions): Promise<NewNotebook | null> {
  return openDialog<NewNotebook>(
    'New notebook',
    (d) => {
      const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })
      const name = h('input', { type: 'text', value: `Notes ${today}`, maxLength: 120, autocomplete: 'off' })
      const subtitle = h('input', { type: 'text', maxLength: 80, autocomplete: 'off', placeholder: 'For example: Semester 1, Prof. Martin' })
      let bg = last.bg
      let orient = last.orient
      let template: CoverTemplate | null = last.coverTemplate ?? null
      let color = last.coverColor ?? COVER_COLORS[0]
      const covers = h('div', { class: 'cover-tiles', role: 'radiogroup', 'aria-label': 'Cover' })
      const colors = h('div', { class: 'swatches cover-colors' })
      const coverOptions = h('div', { class: 'cover-options' }, h('div', { class: 'field' }, h('span', {}, 'Colour'), colors), h('label', { class: 'field' }, h('span', {}, 'Subtitle (optional)'), subtitle))
      const tiles = h('div', { class: 'bg-tiles', role: 'radiogroup', 'aria-label': 'Page background' })
      const orients = h('div', { class: 'segmented' })
      const cover = (t: CoverTemplate): Cover => ({ template: t, title: name.value.trim() || 'Title', color, ...(subtitle.value.trim() ? { subtitle: subtitle.value.trim() } : {}) })
      /** A small picture of the cover, as it will look with this name and colour. */
      const preview = (t: CoverTemplate): HTMLCanvasElement => {
        const { w, h: ph } = pageSize({ orient })
        const width = orient === 'landscape' ? 92 : 66
        const ratio = Math.min(window.devicePixelRatio || 1, 2)
        const c = h('canvas', { class: 'cover-preview', width: Math.round(width * ratio), height: Math.round(((width * ph) / w) * ratio), style: `width:${width}px` })
        const g = c.getContext('2d')!
        g.fillStyle = '#ffffff'
        g.fillRect(0, 0, c.width, c.height)
        g.scale(c.width / w, c.width / w)
        drawCover(g, cover(t), w, ph)
        return c
      }
      const draw = () => {
        covers.replaceChildren(
          h('button', { type: 'button', role: 'radio', 'aria-checked': String(template === null), class: `cover-tile ${template === null ? 'selected' : ''}`, onClick: () => ((template = null), draw()) }, h('span', { class: `cover-preview none ${orient === 'landscape' ? 'landscape' : ''}` }, 'No cover'), 'None'),
          ...COVER_TEMPLATES.map((t) =>
            h('button', { type: 'button', role: 'radio', 'aria-checked': String(t.id === template), class: `cover-tile ${t.id === template ? 'selected' : ''}`, onClick: () => ((template = t.id), draw()) }, preview(t.id), t.label),
          ),
        )
        coverOptions.hidden = template === null
        colors.replaceChildren(
          ...COVER_COLORS.map((c) => h('button', { type: 'button', class: `swatch ${c === color ? 'selected' : ''}`, style: `background:${c}`, 'aria-label': `Cover colour ${c}`, onClick: () => ((color = c), draw()) })),
        )
        tiles.replaceChildren(
          ...BACKGROUNDS.map((b) =>
            h('button', { type: 'button', role: 'radio', 'aria-checked': String(b.id === bg), class: `bg-tile ${b.id === bg ? 'selected' : ''}`, onClick: () => ((bg = b.id), draw()) }, h('span', { class: `paper bg-${b.id}` }), b.label),
          ),
        )
        orients.replaceChildren(
          ...(['portrait', 'landscape'] as const).map((o) =>
            h('button', { type: 'button', class: o === orient ? 'selected' : '', onClick: () => ((orient = o), draw()) }, o === 'portrait' ? 'Portrait' : 'Landscape'),
          ),
        )
      }
      // The previews follow what is typed.
      name.addEventListener('input', draw)
      subtitle.addEventListener('input', draw)
      draw()
      setTimeout(() => name.select())
      return h(
        'form',
        {
          onSubmit: (e: Event) => {
            e.preventDefault()
            if (name.value.trim()) d.close({ name: name.value, bg, orient, coverColor: color, ...(template ? { cover: cover(template) } : {}) })
          },
        },
        h('label', { class: 'field' }, h('span', {}, 'Name'), name),
        h('div', { class: 'field' }, h('span', {}, 'Cover page'), covers),
        coverOptions,
        h('div', { class: 'field' }, h('span', {}, 'Pages'), tiles),
        h('div', { class: 'field' }, h('span', {}, 'A4 format'), orients),
        dialogButtons(button('Cancel', () => d.close(null)), h('button', { class: 'btn primary', type: 'submit' }, 'Create')),
      )
    },
    'wide',
  )
}

/** The icon of an item of the library, as an element. */
function art(node: Pick<LibNode, 'kind' | 'look' | 'orient' | 'foreign' | 'fromPdf'>, filled = false, small = false): HTMLElement {
  const svg = node.kind === 'folder' ? folderIcon(node.look, filled, { small }) : notebookIcon(node.look, node.orient, !!(node.foreign || node.fromPdf), { small })
  return h('span', { class: `art ${small ? 'small' : ''}`, html: svg })
}

/**
 * The choice of a colour and a symbol, with the icon as it will look.
 * `value()` gives the look chosen (nothing in it for the default one).
 */
function lookPicker(sample: Pick<LibNode, 'kind' | 'orient' | 'foreign' | 'fromPdf'>, initial: Look | undefined, filled = false): { el: HTMLElement; value(): Look } {
  const isFolder = sample.kind === 'folder'
  const palette = isFolder ? FOLDER_COLORS : NOTEBOOK_COLORS
  const fallback = isFolder ? DEFAULT_FOLDER_COLOR : DEFAULT_NOTEBOOK_COLOR
  let color = initial?.color ?? fallback
  let symbol = initial?.symbol ?? ''
  const drawn = (id: string) => SYMBOLS.some((s) => s.id === id)
  const preview = h('div', { class: 'look-preview' })
  const colors = h('div', { class: 'look-colors', role: 'radiogroup', 'aria-label': 'Colour' })
  const symbols = h('div', { class: 'look-symbols', role: 'radiogroup', 'aria-label': 'Symbol' })
  const emoji = h('input', { type: 'text', class: 'look-emoji', maxLength: 16, autocomplete: 'off', placeholder: '😀', 'aria-label': 'Emoji', value: symbol && !drawn(symbol) ? symbol : '' })
  const value = (): Look => ({ ...(color !== fallback ? { color } : {}), ...(symbol ? { symbol } : {}) })
  // A notebook without a chosen symbol shows the feather of Plume.
  const feather = !isFolder && !sample.foreign && !sample.fromPdf
  const draw = () => {
    preview.replaceChildren(art({ ...sample, look: value() }, filled))
    colors.replaceChildren(
      ...palette.map((c) =>
        h('button', { type: 'button', role: 'radio', 'aria-checked': String(c.id === color), class: `swatch ${c.id === color ? 'selected' : ''}`, style: `background:${c.id}`, title: c.label, 'aria-label': c.label, onClick: () => ((color = c.id), draw()) }),
      ),
    )
    const pick = (id: string, label: string, content: string | null) =>
      h(
        'button',
        { type: 'button', role: 'radio', 'aria-checked': String(id === symbol), class: `symbol ${id === symbol ? 'selected' : ''}`, title: label, 'aria-label': label, html: content ?? undefined, onClick: () => ((symbol = id), (emoji.value = ''), draw()) },
        content ? null : 'None',
      )
    symbols.replaceChildren(pick('', feather ? 'Plume feather' : 'No symbol', feather ? symbolIcon('feather') : null), ...SYMBOLS.filter((s) => !feather || s.id !== 'feather').map((s) => pick(s.id, s.label, symbolIcon(s.id))))
  }
  emoji.addEventListener('input', () => {
    const glyph = firstGlyph(emoji.value)
    if (glyph !== emoji.value) emoji.value = glyph
    symbol = glyph
    draw()
  })
  draw()
  return {
    el: h(
      'div',
      { class: 'look-picker' },
      preview,
      h('div', { class: 'look-choices' }, h('div', { class: 'field' }, h('span', {}, 'Colour'), colors), h('div', { class: 'field' }, h('span', {}, 'Symbol'), symbols), h('label', { class: 'field inline look-own' }, h('span', {}, 'Or an emoji of your own'), emoji)),
    ),
    value,
  }
}

/** Changes the colour and the symbol of a folder, or the logo of a notebook. */
function lookDialog(node: LibNode, filled: boolean): Promise<Look | null> {
  return openDialog<Look>(
    node.kind === 'folder' ? 'Folder colour' : 'Notebook logo',
    (d) => {
      const picker = lookPicker(node, node.look, filled)
      return [h('p', { class: 'dialog-text muted look-name' }, node.name), picker.el, dialogButtons(button('Cancel', () => d.close(null)), button('Save', () => d.close(picker.value()), 'primary'))]
    },
    'wide',
  )
}

/** A new folder: its name and, as in OneDrive, its colour. */
function newFolderDialog(): Promise<{ name: string; look: Look } | null> {
  return openDialog<{ name: string; look: Look }>(
    'New folder',
    (d) => {
      const name = h('input', { type: 'text', maxLength: 120, autocomplete: 'off', enterKeyHint: 'done' })
      const picker = lookPicker({ kind: 'folder' }, undefined)
      setTimeout(() => name.focus())
      return h(
        'form',
        {
          onSubmit: (e: Event) => {
            e.preventDefault()
            if (name.value.trim()) d.close({ name: name.value.trim(), look: picker.value() })
          },
        },
        h('label', { class: 'field' }, h('span', {}, 'Folder name'), name),
        picker.el,
        dialogButtons(button('Cancel', () => d.close(null)), h('button', { class: 'btn primary', type: 'submit' }, 'Create')),
      )
    },
    'wide',
  )
}

function glow(e: PointerEvent): void {
  const card = (e.target as Element).closest?.('.card') as HTMLElement | null
  if (!card) return
  const r = card.getBoundingClientRect()
  card.style.setProperty('--mx', `${e.clientX - r.left}px`)
  card.style.setProperty('--my', `${e.clientY - r.top}px`)
}

function moveDialog(nodes: LibNode[], node: LibNode): Promise<string | null> {
  const excluded = new Set(node.kind === 'folder' ? subtree(nodes, node.id) : [])
  const rows: HTMLElement[] = []
  return openDialog<string>(`Move "${node.name}"`, (d) => {
    const add = (id: string, name: string, depth: number, folder?: LibNode) => {
      rows.push(
        h(
          'button',
          { type: 'button', class: 'move-row', disabled: id === node.parentId, style: `padding-left:${12 + depth * 20}px`, onClick: () => d.close(id) },
          folder ? art(folder, nodes.some((c) => c.parentId === id), true) : h('span', { class: 'menu-icon', html: icons.home }),
          name,
          id === node.parentId ? h('span', { class: 'muted' }, ' (current location)') : null,
        ),
      )
      const kids = nodes.filter((n) => n.kind === 'folder' && n.parentId === id && !n.deleted && !excluded.has(n.id)).sort((a, b) => collator.compare(a.name, b.name))
      for (const k of kids) add(k.id, k.name, depth + 1, k)
    }
    add(ROOT, 'Plume', 0)
    return [h('div', { class: 'move-list' }, ...rows), dialogButtons(button('Cancel', () => d.close(null)))]
  })
}

/** Turns a PDF or a picture chosen by the user into a notebook. */
async function importFile(file: File, folderId: string): Promise<LibNode | null> {
  const name = file.name.replace(/\.[a-z0-9]{1,5}$/i, '') || 'Imported'
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    const data = await extractData(new Uint8Array(await file.arrayBuffer()))
    if (!data || !data.pages.length) {
      toast('This PDF could not be opened: it is damaged or protected by a password.', 6000)
      return null
    }
    return importNotebook(folderId, name, data.bg, data.orient, (id) => dataToContent(id, data))
  }
  // A picture: one page, in the direction of the picture, which fills it.
  const picture = await preparePicture(file)
  const orient: Orientation = picture.width > picture.height ? 'landscape' : 'portrait'
  return importNotebook(folderId, name, 'blank', orient, (notebookId) => {
    const page: Page = { id: uid(), notebookId, bg: 'blank', orient, rev: 0 }
    const { w, h } = pageSize(page)
    const margin = 24
    const fit = Math.min((w - 2 * margin) / picture.width, (h - 2 * margin) / picture.height)
    const pw = picture.width * fit
    const ph = picture.height * fit
    const x = (w - pw) / 2
    const y = (h - ph) / 2
    return {
      pages: [page],
      strokes: [{ id: uid(), pageId: page.id, seq: 1, tool: 'image', color: '', width: 0, pts: Float32Array.from([x, y, 0, x + pw, y + ph, 0]), image: { mime: picture.mime, data: picture.data } }],
    }
  })
}

export async function renderLibrary(root: HTMLElement, folderId: string, deps: LibraryDeps): Promise<void> {
  const nodes = (await allNodes()).filter((n) => !n.deleted)
  const favView = folderId === FAVOURITES
  if (folderId !== ROOT && !favView && !nodes.some((n) => n.id === folderId && n.kind === 'folder')) return deps.goTo(ROOT)
  const here = nodes.filter((n) => n.parentId === folderId)
  const folders = here.filter((n) => n.kind === 'folder').sort((a, b) => collator.compare(a.name, b.name))
  const notebooks = here.filter((n) => n.kind === 'notebook').sort((a, b) => collator.compare(a.name, b.name))
  const notices = await deps.engine.notices()

  const hasContent = (id: string) => nodes.some((n) => n.parentId === id)

  const act = async (fn: () => Promise<unknown>) => {
    await fn()
    deps.changed()
  }

  const itemMenu = (node: LibNode, anchor: HTMLElement) =>
    openMenu(anchor, [
      {
        label: node.favorite ? 'Remove from favourites' : 'Add to favourites',
        icon: icons.star,
        action: async () => {
          await updateNode(node.id, (n) => void (n.favorite = !n.favorite))
          void renderLibrary(root, folderId, deps)
        },
      },
      {
        label: 'Rename',
        icon: icons.pen,
        action: async () => {
          const name = await promptDialog('Rename', 'New name', node.name, 'Rename')
          if (name) await act(() => renameNode(node.id, name))
        },
      },
      {
        label: node.kind === 'folder' ? 'Folder colour' : 'Notebook logo',
        icon: icons.palette,
        action: async () => {
          const look = await lookDialog(node, hasContent(node.id))
          if (look) await act(() => setLook(node.id, look))
        },
      },
      {
        label: 'Move…',
        icon: icons.folder,
        action: async () => {
          const dest = await moveDialog(nodes, node)
          if (dest) await act(() => moveNode(node.id, dest))
        },
      },
      {
        label: 'Delete',
        icon: icons.trash,
        danger: true,
        action: async () => {
          const count = subtree(nodes, node.id).filter((id) => nodes.find((n) => n.id === id)?.kind === 'notebook').length
          const what = node.kind === 'folder' ? `The folder "${node.name}" and everything in it (${count} notebook${count === 1 ? '' : 's'})` : `The notebook "${node.name}"`
          const where = deps.synced() && node.remoteId ? ' will be deleted from this device and from OneDrive, where a copy stays recoverable in the recycle bin for 30 days.' : ' will be permanently deleted from this device.'
          if (await confirmDialog('Delete', `${what}${where}`, 'Delete', true)) await act(() => deleteNode(node.id))
        },
      },
    ])

  const byId = new Map(nodes.map((n) => [n.id, n]))
  /** When the item last changed here; for a folder, the latest change of anything in it. */
  const modified = (node: LibNode): number =>
    node.kind === 'folder' ? Math.max(node.updatedAt, ...subtree(nodes, node.id).map((id) => byId.get(id)?.updatedAt ?? 0)) : node.updatedAt
  const when = (t: number): string => {
    const d = new Date(t)
    const now = new Date()
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) })
  }
  const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`

  /** A line of the listing; `tile`: a small sheet for the rows of shortcuts instead. */
  const card = (node: LibNode, where = false, tile = false): HTMLElement => {
    const isFolder = node.kind === 'folder'
    let sub: string
    if (isFolder) {
      const inside = nodes.filter((c) => c.parentId === node.id)
      const books = inside.filter((c) => c.kind === 'notebook').length
      const dirs = inside.length - books
      sub = [books ? plural(books, 'notebook') : '', dirs ? plural(dirs, 'folder') : ''].filter(Boolean).join(' · ') || 'Empty'
    } else if (node.foreign) sub = 'External PDF'
    else if (node.needsDownload && !node.pageIds?.length) sub = 'To download'
    else sub = plural(node.pageIds?.length ?? 0, 'page')
    const pending = !isFolder && deps.synced() && isDirtyNotebook(node)
    const more = iconButton(icons.more, `Actions for ${node.name}`, (e) => {
      e.stopPropagation()
      itemMenu(node, more)
    }, 'small')
    // In search results and shortcut lists, say where the item lives.
    const place = ['Plume', ...pathTo(nodes, node.parentId).map((f) => f.name)].join(' › ')
    if (tile) sub = place
    else if (where) sub = `${place} · ${sub}`
    const changed = modified(node)
    // A long press (or a right click) opens the same menu as the three dots.
    let timer = 0
    let held = false
    let start = { x: 0, y: 0 }
    const release = () => {
      clearTimeout(timer)
      timer = 0
    }
    return h(
      'div',
      {
        class: `card ${isFolder ? 'folder' : 'notebook'} ${node.favorite ? 'favorite' : ''} ${tile ? 'tile' : ''}`,
        role: 'button',
        tabIndex: 0,
        onClick: () => {
          if (!held) deps.open(node)
        },
        onKeydown: (e: KeyboardEvent) => e.key === 'Enter' && deps.open(node),
        onPointerdown: (e: PointerEvent) => {
          held = false
          release()
          if (e.pointerType === 'mouse' || more.contains(e.target as Node)) return
          start = { x: e.clientX, y: e.clientY }
          timer = window.setTimeout(() => {
            timer = 0
            held = true
            itemMenu(node, more)
          }, LONG_PRESS_MS)
        },
        onPointermove: (e: PointerEvent) => {
          if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) release()
        },
        onPointerup: release,
        onPointercancel: release,
        onPointerleave: release,
        onContextmenu: (e: MouseEvent) => {
          e.preventDefault()
          // On a touch screen the long press above may have opened it already.
          if (held) return
          release()
          held = true
          itemMenu(node, more)
        },
      },
      h('span', { class: 'card-art' }, art(node, isFolder && hasContent(node.id))),
      h(
        'div',
        { class: 'card-text' },
        // The marks sit beside the name, never on the icon.
        h(
          'div',
          { class: 'card-title' },
          h('span', { class: 'card-name' }, node.name),
          node.favorite ? h('span', { class: 'fav-mark', title: 'Favourite', html: icons.star }) : null,
          pending ? h('span', { class: 'pending-dot', title: 'Not yet sent to OneDrive' }) : null,
        ),
        h('div', { class: 'card-sub' }, sub),
      ),
      tile ? null : h('span', { class: 'card-date', title: `Modified ${new Date(changed).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}` }, when(changed)),
      more,
    )
  }

  const importer = h('input', {
    type: 'file',
    accept: 'application/pdf,.pdf,image/*',
    hidden: true,
    onChange: async () => {
      const file = importer.files?.[0]
      importer.value = ''
      if (!file) return
      try {
        const node = await importFile(file, folderId)
        if (!node) return
        deps.changed()
        deps.open(node)
      } catch (e) {
        console.error('Import', e)
        toast('This file could not be imported.')
      }
    },
  })

  const crumbs = h(
    'nav',
    { class: 'crumbs', 'aria-label': 'Location' },
    h('button', { type: 'button', class: folderId === ROOT ? 'current' : '', onClick: () => deps.goTo(ROOT) }, 'Plume'),
    ...(favView ? [h('span', { class: 'crumb-sep' }, '›'), h('button', { type: 'button', class: 'current' }, 'Favourites')] : []),
    ...pathTo(nodes, folderId).flatMap((f, i, all) => [
      h('span', { class: 'crumb-sep' }, '›'),
      h('button', { type: 'button', class: i === all.length - 1 ? 'current' : '', onClick: () => deps.goTo(f.id) }, art(f, hasContent(f.id), true), h('span', { class: 'crumb-name' }, f.name)),
    ]),
  )

  const empty = folders.length + notebooks.length === 0
  const byName = (a: LibNode, b: LibNode) => collator.compare(a.name, b.name)
  /** One line per item: the folders, then the notebooks. */
  const grids = (items: LibNode[], where = false) => {
    const dirs = items.filter((n) => n.kind === 'folder')
    const books = items.filter((n) => n.kind === 'notebook')
    return [...(dirs.length ? [h('div', { class: 'grid folders' }, ...dirs.map((n) => card(n, where)))] : []), ...(books.length ? [h('div', { class: 'grid' }, ...books.map((n) => card(n, where)))] : [])]
  }
  const heading = (title: string, count: number) => h('h2', { class: 'lib-section' }, title, h('span', { class: 'count' }, String(count)))
  const sectionOf = (title: string, items: LibNode[], where = false) => (items.length ? [heading(title, items.length), ...grids(items, where)] : [])
  const section = (title: string, items: LibNode[]) => sectionOf(title, items)
  /** Shortcuts: small sheets on a single row, which scrolls sideways. */
  const strip = (title: string, items: LibNode[]) => (items.length ? [heading(title, items.length), h('div', { class: 'grid strip' }, ...items.map((n) => card(n, true, true)))] : [])

  /** What is listed under the buttons: the folder, or what matches the search. */
  const listing = h('div', { class: 'listing' })
  const showListing = (query: string): void => {
    const q = query.trim().toLowerCase()
    if (q) {
      // Search the names of everything in the library, wherever it is.
      const found = nodes.filter((n) => n.name.toLowerCase().includes(q)).sort((a, b) => (a.kind === b.kind ? byName(a, b) : a.kind === 'folder' ? -1 : 1))
      listing.replaceChildren(...(found.length ? [h('h2', { class: 'lib-section' }, `${found.length} result${found.length > 1 ? 's' : ''}`), ...grids(found, true)] : [h('p', { class: 'empty' }, `Nothing is named "${query.trim()}".`)]))
      return
    }
    if (favView) {
      const favourites = nodes.filter((n) => n.favorite)
      listing.replaceChildren(
        ...(favourites.length
          ? [...sectionOf('Folders', favourites.filter((n) => n.kind === 'folder').sort(byName), true), ...sectionOf('Notebooks', favourites.filter((n) => n.kind === 'notebook').sort(byName), true)]
          : [h('p', { class: 'empty' }, 'No favourites yet. Press and hold a notebook or a folder, then choose "Add to favourites".')]),
      )
      return
    }
    const books = nodes.filter((n) => n.kind === 'notebook')
    // The notebooks opened last, on the first screen of the library only.
    const recent = folderId === ROOT ? books.filter((n) => n.openedAt).sort((a, b) => b.openedAt! - a.openedAt!).slice(0, 10) : []
    const shortcuts = strip('Recent', recent)
    listing.replaceChildren(
      ...shortcuts,
      ...(empty
        ? [h('p', { class: 'empty' }, folderId === ROOT ? 'No notes yet. Create a notebook to start writing.' : 'This folder is empty.')]
        : [...section('Folders', folders), ...section('Notebooks', notebooks)]),
    )
  }
  if (searching.folder !== folderId) Object.assign(searching, { folder: folderId, query: '', focused: false })
  const search = h('input', {
    type: 'search',
    class: 'search',
    placeholder: 'Search by name',
    'aria-label': 'Search by name',
    autocomplete: 'off',
    value: searching.query,
    onInput: () => showListing((searching.query = search.value)),
    onFocus: () => (searching.focused = true),
    onBlur: () => (searching.focused = false),
  })
  const wasSearching = searching.focused
  showListing(searching.query)

  // ---------- Folder tree ----------

  const allFolders = nodes.filter((n) => n.kind === 'folder')
  // Arriving on a screen plays its entrance; a redraw of the same screen (after a sync) does not.
  const arriving = lastFolder !== folderId || !root.querySelector(':scope > .library')
  if (lastFolder !== folderId) {
    // Arriving in a folder: the way to it is unfolded, and the tree gets out of the way on narrow screens.
    for (const f of pathTo(nodes, folderId).slice(0, -1)) unfolded.add(f.id)
    lastFolder = folderId
    drawer = false
  }
  const tree = h('nav', { class: 'tree', 'aria-label': 'Folders' })
  const treeRow = (id: string, name: string, depth: number, kids: LibNode[], folder?: LibNode): HTMLElement => {
    const open = unfolded.has(id)
    return h(
      'div',
      { class: `tree-row ${id === folderId ? 'current' : ''}`, style: `padding-left:${4 + depth * 16}px` },
      id !== ROOT && kids.length
        ? h('button', {
            type: 'button',
            class: `tree-toggle ${open ? 'open' : ''}`,
            'aria-label': `${open ? 'Fold' : 'Unfold'} ${name}`,
            'aria-expanded': String(open),
            html: icons.chevron,
            onClick: () => {
              if (open) unfolded.delete(id)
              else unfolded.add(id)
              store(OPEN_KEY, JSON.stringify([...unfolded]))
              drawTree()
            },
          })
        : h('span', { class: 'tree-toggle' }),
      h(
        'button',
        {
          type: 'button',
          class: 'tree-go',
          'aria-current': id === folderId ? 'page' : undefined,
          onClick: () => {
            if (id === folderId) setTree(false, true)
            else deps.goTo(id)
          },
        },
        folder ? art(folder, hasContent(id), true) : h('span', { class: 'menu-icon', html: icons.home }),
        h('span', { class: 'tree-name' }, name),
      ),
    )
  }
  const drawTree = (): void => {
    const rows: HTMLElement[] = []
    const add = (id: string, name: string, depth: number, folder?: LibNode) => {
      const kids = allFolders.filter((n) => n.parentId === id).sort(byName)
      rows.push(treeRow(id, name, depth, kids, folder))
      if (id === ROOT || unfolded.has(id)) for (const k of kids) add(k.id, k.name, depth + 1, k)
    }
    add(ROOT, 'Plume', 0)
    rows.splice(
      1,
      0,
      h(
        'div',
        { class: `tree-row ${favView ? 'current' : ''}`, style: 'padding-left:4px' },
        h('span', { class: 'tree-toggle' }),
        h(
          'button',
          { type: 'button', class: 'tree-go', 'aria-current': favView ? 'page' : undefined, onClick: () => (favView ? setTree(false, true) : deps.goTo(FAVOURITES)) },
          h('span', { class: 'menu-icon', html: icons.star }),
          h('span', { class: 'tree-name' }, 'Favourites'),
        ),
      ),
    )
    tree.replaceChildren(...rows)
  }
  drawTree()

  /** Top of the first screen: the name of the application, and what the library holds. */
  const total = { books: nodes.filter((n) => n.kind === 'notebook').length, pages: nodes.reduce((sum, n) => sum + (n.pageIds?.length ?? 0), 0) }
  const hero = h(
    'section',
    { class: 'hero' },
    h('span', { class: 'brand-mark', html: logo() }),
    h(
      'div',
      {},
      h('h1', { class: 'wordmark' }, 'Plume'),
      h('p', { class: 'hero-sub' }, 'Handwritten notes, synced with OneDrive', h('span', { class: 'hero-stats' }, [plural(total.books, 'notebook'), plural(total.pages, 'page')].join(' · '))),
    ),
  )
  const themeButton = iconButton(icons.sun, 'Appearance', () => openThemeMenu(themeButton))
  // A glow follows the pointer over the cards.
  const library = h('div', { class: `library ${treeShown() ? '' : 'tree-hidden'} ${arriving ? 'arriving' : ''}`, onPointermove: glow, onPointerdown: glow })
  /** Shows or hides the tree; on narrow screens only (`drawerOnly`), or wherever it is. */
  const setTree = (shown: boolean, drawerOnly = false): void => {
    if (narrow.matches) drawer = shown
    else if (drawerOnly) return
    else store(TREE_KEY, shown ? '1' : '0')
    library.classList.toggle('tree-hidden', !shown)
  }

  library.append(
    h('aside', { class: 'lib-side' }, h('div', { class: 'brand' }, h('span', { class: 'brand-mark', html: logo() }), h('span', { class: 'wordmark' }, 'Plume')), tree),
    h('div', { class: 'lib-scrim', onClick: () => setTree(false) }),
    h(
      'div',
      { class: 'lib-main' },
      h(
        'header',
        { class: 'lib-head' },
        iconButton(icons.sidebar, 'Folders', () => setTree(library.classList.contains('tree-hidden'))),
        crumbs,
        h('div', { class: 'spacer' }),
        deps.syncChip,
        themeButton,
        iconButton(icons.settings, 'Settings', deps.openSettings),
      ),
      folderId === ROOT ? hero : null,
      h(
        'div',
        { class: 'lib-actions', hidden: favView },
        h(
          'button',
          {
            class: 'btn primary',
            type: 'button',
            onClick: async () => {
              const last = (await kvGet<NotebookOptions>('lastNotebook')) ?? { bg: 'grid', orient: 'portrait' }
              const r = await newNotebookDialog(last)
              if (!r) return
              await kvSet('lastNotebook', { bg: r.bg, orient: r.orient, coverTemplate: r.cover?.template, coverColor: r.coverColor } satisfies NotebookOptions)
              const node = await createNotebook(folderId, r.name, r.bg, r.orient, r.cover)
              deps.changed()
              deps.open(node)
            },
          },
          h('span', { class: 'menu-icon', html: icons.plus }),
          'Notebook',
        ),
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onClick: async () => {
              const r = await newFolderDialog()
              if (r) await act(() => createFolder(folderId, r.name, r.look))
            },
          },
          h('span', { class: 'menu-icon', html: icons.folderPlus }),
          'Folder',
        ),
        h('button', { class: 'btn', type: 'button', title: 'Import a PDF or a picture', onClick: () => importer.click() }, h('span', { class: 'menu-icon', html: icons.importFile }), 'Import'),
        importer,
        h('div', { class: 'spacer' }),
        h('label', { class: 'search-box' }, h('span', { class: 'menu-icon', html: icons.search }), search),
      ),
      ...notices.map((n) =>
        h('div', { class: 'notice', role: 'alert' }, h('span', {}, n.text), iconButton(icons.close, 'Dismiss notice', () => void deps.engine.dismissNotice(n.id), 'small')),
      ),
      listing,
    ),
  )
  root.replaceChildren(library)
  if (wasSearching) search.focus()
}

export function notOpenable(node: LibNode): boolean {
  if (node.foreign) {
    toast('This PDF could not be opened: it is damaged or protected by a password.', 5000)
    return true
  }
  if (node.needsDownload && !node.pageIds?.length) {
    toast('This notebook is being downloaded from OneDrive.')
    return true
  }
  return false
}
