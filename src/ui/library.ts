// Bibliothèque : dossiers et blocs-notes, tels qu'ils apparaissent dans OneDrive.

import { allNodes, kvGet, kvSet } from '../db'
import { createFolder, createNotebook, deleteNode, moveNode, pathTo, renameNode, subtree } from '../library'
import { BACKGROUNDS, ROOT, isDirtyNotebook, type Background, type LibNode, type Orientation } from '../model'
import type { SyncEngine } from '../sync/engine'
import { button, confirmDialog, dialogButtons, h, iconButton, icons, openDialog, openMenu, promptDialog, toast } from './dom'

export interface LibraryDeps {
  engine: SyncEngine
  syncChip: HTMLElement
  /** Ouvre un dossier ou un bloc-notes. */
  open(node: LibNode): void
  goTo(folderId: string): void
  openSettings(): void
  /** La bibliothèque a été modifiée localement. */
  changed(): void
  /** false : la synchronisation n'est pas active (suppression locale uniquement). */
  synced(): boolean
}

const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' })

interface NotebookOptions {
  bg: Background
  orient: Orientation
}

function newNotebookDialog(last: NotebookOptions): Promise<({ name: string } & NotebookOptions) | null> {
  return openDialog<{ name: string } & NotebookOptions>('Nouveau bloc-notes', (d) => {
    const today = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })
    const name = h('input', { type: 'text', value: `Notes du ${today}`, maxLength: 120, autocomplete: 'off' })
    let bg = last.bg
    let orient = last.orient
    const tiles = h('div', { class: 'bg-tiles', role: 'radiogroup', 'aria-label': 'Fond de page' })
    const orients = h('div', { class: 'segmented' })
    const draw = () => {
      tiles.replaceChildren(
        ...BACKGROUNDS.map((b) =>
          h('button', { type: 'button', role: 'radio', 'aria-checked': String(b.id === bg), class: `bg-tile ${b.id === bg ? 'selected' : ''}`, onClick: () => ((bg = b.id), draw()) }, h('span', { class: `paper bg-${b.id}` }), b.label),
        ),
      )
      orients.replaceChildren(
        ...(['portrait', 'landscape'] as const).map((o) =>
          h('button', { type: 'button', class: o === orient ? 'selected' : '', onClick: () => ((orient = o), draw()) }, o === 'portrait' ? 'Portrait' : 'Paysage'),
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
      h('label', { class: 'field' }, h('span', {}, 'Nom'), name),
      h('div', { class: 'field' }, h('span', {}, 'Fond de page'), tiles),
      h('div', { class: 'field' }, h('span', {}, 'Format A4'), orients),
      dialogButtons(button('Annuler', () => d.close(null)), h('button', { class: 'btn primary', type: 'submit' }, 'Créer')),
    )
  })
}

function moveDialog(nodes: LibNode[], node: LibNode): Promise<string | null> {
  const excluded = new Set(node.kind === 'folder' ? subtree(nodes, node.id) : [])
  const rows: HTMLElement[] = []
  return openDialog<string>(`Déplacer « ${node.name} »`, (d) => {
    const add = (id: string, name: string, depth: number) => {
      rows.push(
        h(
          'button',
          { type: 'button', class: 'move-row', disabled: id === node.parentId, style: `padding-left:${12 + depth * 20}px`, onClick: () => d.close(id) },
          h('span', { class: 'menu-icon', html: icons.folder }),
          name,
          id === node.parentId ? h('span', { class: 'muted' }, ' (emplacement actuel)') : null,
        ),
      )
      const kids = nodes.filter((n) => n.kind === 'folder' && n.parentId === id && !n.deleted && !excluded.has(n.id)).sort((a, b) => collator.compare(a.name, b.name))
      for (const k of kids) add(k.id, k.name, depth + 1)
    }
    add(ROOT, 'Plume', 0)
    return [h('div', { class: 'move-list' }, ...rows), dialogButtons(button('Annuler', () => d.close(null)))]
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
        label: 'Renommer',
        icon: icons.pen,
        action: async () => {
          const name = await promptDialog('Renommer', 'Nouveau nom', node.name, 'Renommer')
          if (name) await act(() => renameNode(node.id, name))
        },
      },
      {
        label: 'Déplacer…',
        icon: icons.folder,
        action: async () => {
          const dest = await moveDialog(nodes, node)
          if (dest) await act(() => moveNode(node.id, dest))
        },
      },
      {
        label: 'Supprimer',
        icon: icons.trash,
        danger: true,
        action: async () => {
          const count = subtree(nodes, node.id).filter((id) => nodes.find((n) => n.id === id)?.kind === 'notebook').length
          const what = node.kind === 'folder' ? `Le dossier « ${node.name} » et tout son contenu (${count} bloc${count > 1 ? 's' : ''}-notes)` : `Le bloc-notes « ${node.name} »`
          const where = deps.synced() && node.remoteId ? ' sur cet appareil et dans OneDrive, où une copie reste récupérable dans la corbeille pendant 30 jours.' : ' définitivement de cet appareil.'
          if (await confirmDialog('Supprimer', `${what} sera supprimé${where}`, 'Supprimer', true)) await act(() => deleteNode(node.id))
        },
      },
    ])

  const card = (node: LibNode): HTMLElement => {
    const isFolder = node.kind === 'folder'
    let sub: string
    if (isFolder) {
      const n = nodes.filter((c) => c.parentId === node.id).length
      sub = n === 0 ? 'Vide' : `${n} élément${n > 1 ? 's' : ''}`
    } else if (node.foreign) sub = 'PDF externe'
    else if (node.needsDownload && !node.pageIds?.length) sub = 'À télécharger'
    else {
      const n = node.pageIds?.length ?? 0
      sub = `${n} page${n > 1 ? 's' : ''}`
    }
    const pending = !isFolder && deps.synced() && isDirtyNotebook(node)
    const more = iconButton(icons.more, `Actions pour ${node.name}`, (e) => {
      e.stopPropagation()
      itemMenu(node, more)
    }, 'small')
    return h(
      'div',
      { class: `card ${isFolder ? 'folder' : 'notebook'}`, role: 'button', tabIndex: 0, onClick: () => deps.open(node), onKeydown: (e: KeyboardEvent) => e.key === 'Enter' && deps.open(node) },
      isFolder ? h('div', { class: 'cover folder-cover', html: icons.folder }) : h('div', { class: `cover paper bg-${node.bg ?? 'blank'} ${node.orient === 'landscape' ? 'landscape' : ''}` }),
      h('div', { class: 'card-text' }, h('div', { class: 'card-name' }, node.name), h('div', { class: 'card-sub' }, sub, pending ? h('span', { class: 'pending-dot', title: 'Pas encore envoyé vers OneDrive' }) : null)),
      more,
    )
  }

  const crumbs = h(
    'nav',
    { class: 'crumbs', 'aria-label': 'Emplacement' },
    h('button', { type: 'button', class: folderId === ROOT ? 'current' : '', onClick: () => deps.goTo(ROOT) }, 'Plume'),
    ...pathTo(nodes, folderId).flatMap((f, i, all) => [h('span', { class: 'crumb-sep' }, '›'), h('button', { type: 'button', class: i === all.length - 1 ? 'current' : '', onClick: () => deps.goTo(f.id) }, f.name)]),
  )

  const empty = folders.length + notebooks.length === 0

  root.replaceChildren(
    h(
      'div',
      { class: 'library' },
      h('header', { class: 'lib-head' }, crumbs, h('div', { class: 'spacer' }), deps.syncChip, iconButton(icons.settings, 'Réglages', deps.openSettings)),
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
          'Bloc-notes',
        ),
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onClick: async () => {
              const name = await promptDialog('Nouveau dossier', 'Nom du dossier', '', 'Créer')
              if (name) await act(() => createFolder(folderId, name))
            },
          },
          h('span', { class: 'menu-icon', html: icons.folderPlus }),
          'Dossier',
        ),
      ),
      ...notices.map((n) =>
        h('div', { class: 'notice', role: 'alert' }, h('span', {}, n.text), iconButton(icons.close, "Fermer l'avis", () => void deps.engine.dismissNotice(n.id), 'small')),
      ),
      empty
        ? h('p', { class: 'empty' }, folderId === ROOT ? 'Aucune note pour le moment. Créez un bloc-notes pour commencer à écrire.' : 'Ce dossier est vide.')
        : h('div', { class: 'grid' }, ...folders.map(card), ...notebooks.map(card)),
    ),
  )
}

export function notOpenable(node: LibNode): boolean {
  if (node.foreign) {
    toast("Ce PDF n'a pas été créé avec Plume. L'import de PDF est prévu dans la prochaine version.", 5000)
    return true
  }
  if (node.needsDownload && !node.pageIds?.length) {
    toast('Ce bloc-notes est en cours de téléchargement depuis OneDrive.')
    return true
  }
  return false
}
