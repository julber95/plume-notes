// Library: folders and notebooks, as they appear in OneDrive.

import { allNodes, kvGet, kvSet } from '../db'
import { createFolder, createNotebook, deleteNode, importNotebook, moveNode, pathTo, renameNode, subtree } from '../library'
import { BACKGROUNDS, ROOT, isDirtyNotebook, pageSize, uid, type Background, type LibNode, type Orientation, type Page } from '../model'
import { extractData } from '../pdf/client'
import { dataToContent } from '../pdf/codec'
import { preparePicture } from './pictures'
import type { SyncEngine } from '../sync/engine'
import { button, confirmDialog, dialogButtons, h, iconButton, icons, openDialog, openMenu, promptDialog, toast } from './dom'

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

interface NotebookOptions {
  bg: Background
  orient: Orientation
}

function newNotebookDialog(last: NotebookOptions): Promise<({ name: string } & NotebookOptions) | null> {
  return openDialog<{ name: string } & NotebookOptions>('New notebook', (d) => {
    const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })
    const name = h('input', { type: 'text', value: `Notes ${today}`, maxLength: 120, autocomplete: 'off' })
    let bg = last.bg
    let orient = last.orient
    const tiles = h('div', { class: 'bg-tiles', role: 'radiogroup', 'aria-label': 'Page background' })
    const orients = h('div', { class: 'segmented' })
    const draw = () => {
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
    draw()
    setTimeout(() => name.select())
    return h(
      'form',
      {
        onSubmit: (e: Event) => {
          e.preventDefault()
          if (name.value.trim()) d.close({ name: name.value, bg, orient })
        },
      },
      h('label', { class: 'field' }, h('span', {}, 'Name'), name),
      h('div', { class: 'field' }, h('span', {}, 'Page background'), tiles),
      h('div', { class: 'field' }, h('span', {}, 'A4 format'), orients),
      dialogButtons(button('Cancel', () => d.close(null)), h('button', { class: 'btn primary', type: 'submit' }, 'Create')),
    )
  })
}

function moveDialog(nodes: LibNode[], node: LibNode): Promise<string | null> {
  const excluded = new Set(node.kind === 'folder' ? subtree(nodes, node.id) : [])
  const rows: HTMLElement[] = []
  return openDialog<string>(`Move "${node.name}"`, (d) => {
    const add = (id: string, name: string, depth: number) => {
      rows.push(
        h(
          'button',
          { type: 'button', class: 'move-row', disabled: id === node.parentId, style: `padding-left:${12 + depth * 20}px`, onClick: () => d.close(id) },
          h('span', { class: 'menu-icon', html: icons.folder }),
          name,
          id === node.parentId ? h('span', { class: 'muted' }, ' (current location)') : null,
        ),
      )
      const kids = nodes.filter((n) => n.kind === 'folder' && n.parentId === id && !n.deleted && !excluded.has(n.id)).sort((a, b) => collator.compare(a.name, b.name))
      for (const k of kids) add(k.id, k.name, depth + 1)
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
  if (folderId !== ROOT && !nodes.some((n) => n.id === folderId && n.kind === 'folder')) return deps.goTo(ROOT)
  const here = nodes.filter((n) => n.parentId === folderId)
  const folders = here.filter((n) => n.kind === 'folder').sort((a, b) => collator.compare(a.name, b.name))
  const notebooks = here.filter((n) => n.kind === 'notebook').sort((a, b) => collator.compare(a.name, b.name))
  const notices = await deps.engine.notices()

  const act = async (fn: () => Promise<unknown>) => {
    await fn()
    deps.changed()
  }

  const itemMenu = (node: LibNode, anchor: HTMLElement) =>
    openMenu(anchor, [
      {
        label: 'Rename',
        icon: icons.pen,
        action: async () => {
          const name = await promptDialog('Rename', 'New name', node.name, 'Rename')
          if (name) await act(() => renameNode(node.id, name))
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

  const card = (node: LibNode): HTMLElement => {
    const isFolder = node.kind === 'folder'
    let sub: string
    if (isFolder) {
      const n = nodes.filter((c) => c.parentId === node.id).length
      sub = n === 0 ? 'Empty' : `${n} item${n > 1 ? 's' : ''}`
    } else if (node.foreign) sub = 'External PDF'
    else if (node.needsDownload && !node.pageIds?.length) sub = 'To download'
    else {
      const n = node.pageIds?.length ?? 0
      sub = `${n} page${n > 1 ? 's' : ''}`
    }
    const pending = !isFolder && deps.synced() && isDirtyNotebook(node)
    const more = iconButton(icons.more, `Actions for ${node.name}`, (e) => {
      e.stopPropagation()
      itemMenu(node, more)
    }, 'small')
    return h(
      'div',
      { class: `card ${isFolder ? 'folder' : 'notebook'}`, role: 'button', tabIndex: 0, onClick: () => deps.open(node), onKeydown: (e: KeyboardEvent) => e.key === 'Enter' && deps.open(node) },
      isFolder ? h('div', { class: 'cover folder-cover', html: icons.folder }) : h('div', { class: `cover paper bg-${node.bg ?? 'blank'} ${node.orient === 'landscape' ? 'landscape' : ''}` }),
      h('div', { class: 'card-text' }, h('div', { class: 'card-name' }, node.name), h('div', { class: 'card-sub' }, sub, pending ? h('span', { class: 'pending-dot', title: 'Not yet sent to OneDrive' }) : null)),
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
    ...pathTo(nodes, folderId).flatMap((f, i, all) => [h('span', { class: 'crumb-sep' }, '›'), h('button', { type: 'button', class: i === all.length - 1 ? 'current' : '', onClick: () => deps.goTo(f.id) }, f.name)]),
  )

  const empty = folders.length + notebooks.length === 0

  root.replaceChildren(
    h(
      'div',
      { class: 'library' },
      h('header', { class: 'lib-head' }, crumbs, h('div', { class: 'spacer' }), deps.syncChip, iconButton(icons.settings, 'Settings', deps.openSettings)),
      h(
        'div',
        { class: 'lib-actions' },
        h(
          'button',
          {
            class: 'btn primary',
            type: 'button',
            onClick: async () => {
              const last = (await kvGet<NotebookOptions>('lastNotebook')) ?? { bg: 'grid', orient: 'portrait' }
              const r = await newNotebookDialog(last)
              if (!r) return
              await kvSet('lastNotebook', { bg: r.bg, orient: r.orient })
              const node = await createNotebook(folderId, r.name, r.bg, r.orient)
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
              const name = await promptDialog('New folder', 'Folder name', '', 'Create')
              if (name) await act(() => createFolder(folderId, name))
            },
          },
          h('span', { class: 'menu-icon', html: icons.folderPlus }),
          'Folder',
        ),
        h('button', { class: 'btn', type: 'button', title: 'Import a PDF or a picture', onClick: () => importer.click() }, h('span', { class: 'menu-icon', html: icons.importFile }), 'Import'),
        importer,
      ),
      ...notices.map((n) =>
        h('div', { class: 'notice', role: 'alert' }, h('span', {}, n.text), iconButton(icons.close, 'Dismiss notice', () => void deps.engine.dismissNotice(n.id), 'small')),
      ),
      empty
        ? h('p', { class: 'empty' }, folderId === ROOT ? 'No notes yet. Create a notebook to start writing.' : 'This folder is empty.')
        : h('div', { class: 'grid' }, ...folders.map(card), ...notebooks.map(card)),
    ),
  )
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
