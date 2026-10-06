// Écran d'écriture : barre d'outils, pages, annuler/rétablir.

import { applyPageStructure, applyStrokeChange, getNode, getPages, getStrokes, kvGet, kvSet } from '../db'
import { BACKGROUNDS, uid, type Background, type LibNode, type Page, type Stroke } from '../model'
import { InkCanvas, type StrokeChange, type ToolKind, type ToolState } from './canvas'
import { closePopovers, confirmDialog, h, iconButton, icons, showPopover, toast } from './dom'

export interface EditorHandle {
  notebookId: string
  /** Attend que tout soit enregistré localement. */
  flush(): Promise<void>
  /** Recharge le contenu (remplacé par une version venue de OneDrive). */
  reload(): Promise<void>
  destroy(): void
}

export interface EditorDeps {
  onClose(): void
  /** Appelé après chaque enregistrement local. */
  onSaved(): void
  syncChip: HTMLElement
}

const PEN_COLORS = ['#1a1a1a', '#4a4f57', '#1d4ed8', '#0e7490', '#15803d', '#b45309', '#c62828', '#9d174d', '#6d28d9', '#8a5a2b']
const HL_COLORS = ['#ffe14d', '#a8f06e', '#7fd8ff', '#ffa8d0', '#ffbf6b', '#c9b3ff']
const PEN_WIDTHS = [0.8, 1.3, 2.2]
const HL_WIDTHS = [8, 14, 22]
const ERASER_SIZES = [6, 12, 24]

const DEFAULT_TOOL: ToolState = {
  kind: 'pen',
  pen: { color: PEN_COLORS[0], width: PEN_WIDTHS[1] },
  highlighter: { color: HL_COLORS[0], width: HL_WIDTHS[1] },
  eraser: { mode: 'stroke', size: ERASER_SIZES[1] },
}

const TOOLS: { kind: ToolKind; label: string; icon: string }[] = [
  { kind: 'pen', label: 'Stylo', icon: icons.pen },
  { kind: 'highlighter', label: 'Surligneur', icon: icons.highlighter },
  { kind: 'eraser', label: 'Gomme', icon: icons.eraser },
  { kind: 'line', label: 'Trait droit', icon: icons.line },
]

export async function openEditor(root: HTMLElement, notebookId: string, deps: EditorDeps): Promise<EditorHandle | null> {
  let node = await getNode(notebookId)
  if (!node || node.deleted) return null

  const saved = await kvGet<ToolState>('tool')
  const tool: ToolState = { ...DEFAULT_TOOL, ...saved, pen: { ...DEFAULT_TOOL.pen, ...saved?.pen }, highlighter: { ...DEFAULT_TOOL.highlighter, ...saved?.highlighter }, eraser: { ...DEFAULT_TOOL.eraser, ...saved?.eraser } }
  let pages: Page[] = []
  let undo: StrokeChange[] = []
  let redo: StrokeChange[] = []

  // Les écritures locales s'enchaînent dans l'ordre, sans jamais bloquer le tracé.
  let chain: Promise<void> = Promise.resolve()
  const enqueue = (fn: () => Promise<void>): Promise<void> => {
    chain = chain.then(fn).then(deps.onSaved, (e) => {
      console.error('Enregistrement', e)
      toast("Erreur d'enregistrement sur cet appareil. Vérifiez l'espace de stockage disponible.", 8000)
    })
    return chain
  }

  const loadPages = async (n: LibNode): Promise<Page[]> => {
    const byId = new Map((await getPages(n.id)).map((p) => [p.id, p]))
    return (n.pageIds ?? []).map((id) => byId.get(id)).filter((p): p is Page => !!p)
  }
  pages = await loadPages(node)

  const persist = (added: Stroke[], removed: Stroke[]): void => {
    const pageIds = new Set([...added, ...removed].map((s) => s.pageId))
    for (const pageId of pageIds) {
      const add = added.filter((s) => s.pageId === pageId)
      const del = removed.filter((s) => s.pageId === pageId).map((s) => s.id)
      void enqueue(() => applyStrokeChange(notebookId, pageId, add, del))
    }
  }

  // ---------- Structure de l'écran ----------

  const stage = h('div', { class: 'stage' })
  const title = h('div', { class: 'editor-title' }, node.name)
  const undoBtn = iconButton(icons.undo, 'Annuler', () => doUndo())
  const redoBtn = iconButton(icons.redo, 'Rétablir', () => doRedo())
  const toolButtons = new Map<ToolKind, HTMLButtonElement>()
  const quick = h('div', { class: 'quick' })
  const pageLabel = h('button', { class: 'page-pill', type: 'button', title: 'Pages', onClick: () => togglePanel() })
  const panel = h('aside', { class: 'pages-panel', hidden: true })

  const toolbar = h(
    'header',
    { class: 'toolbar' },
    iconButton(icons.back, 'Retour à la bibliothèque', () => void close()),
    title,
    h(
      'div',
      { class: 'tools' },
      ...TOOLS.map((t) => {
        const b = iconButton(t.icon, t.label, () => selectTool(t.kind, b))
        b.append(h('span', { class: 'tool-dot' }))
        toolButtons.set(t.kind, b)
        return b
      }),
    ),
    quick,
    h('div', { class: 'spacer' }),
    undoBtn,
    redoBtn,
    iconButton(icons.pages, 'Pages', () => togglePanel()),
    deps.syncChip,
  )
  const corner = h(
    'div',
    { class: 'corner' },
    iconButton(icons.zoomOut, 'Dézoomer', () => canvas.zoomBy(1 / 1.25), 'small'),
    iconButton(icons.zoomIn, 'Zoomer', () => canvas.zoomBy(1.25), 'small'),
    h('button', { class: 'page-pill', type: 'button', title: 'Ajuster à la largeur', onClick: () => canvas.zoomBy('fit') }, 'Ajuster'),
    pageLabel,
  )
  const view = h('div', { class: 'editor' }, toolbar, h('div', { class: 'editor-body' }, stage, corner, panel))
  root.replaceChildren(view)

  const canvas = new InkCanvas(
    stage,
    {
      loadStrokes: async (pageId) => {
        await chain
        return getStrokes(pageId)
      },
      onChange: (c) => {
        undo.push(c)
        if (undo.length > 200) undo.shift()
        redo = []
        persist(c.added, c.removed)
        refreshButtons()
      },
      onViewChange: (i) => (pageLabel.textContent = `${i + 1} / ${pages.length}`),
      onAddPage: () => addPage(pages.length - 1),
    },
    tool,
  )
  canvas.setPages(pages)
  pageLabel.textContent = `1 / ${pages.length}`

  // ---------- Outils ----------

  function refreshButtons(): void {
    undoBtn.disabled = undo.length === 0
    redoBtn.disabled = redo.length === 0
    for (const [kind, b] of toolButtons) {
      b.classList.toggle('active', kind === tool.kind)
      const dot = b.querySelector<HTMLElement>('.tool-dot')!
      dot.style.background = kind === 'pen' || kind === 'line' ? tool.pen.color : kind === 'highlighter' ? tool.highlighter.color : 'transparent'
    }
    renderQuick()
  }

  function saveTool(): void {
    void kvSet('tool', tool)
    refreshButtons()
  }

  function selectTool(kind: ToolKind, button: HTMLElement): void {
    if (tool.kind !== kind) {
      tool.kind = kind
      closePopovers()
      saveTool()
      return
    }
    // Second appui sur l'outil actif : ses réglages.
    showPopover(button, toolPanel(kind))
  }

  function swatches(colors: string[], current: string, pick: (c: string) => void): HTMLElement {
    const custom = h('input', { type: 'color', class: 'swatch custom', title: 'Autre couleur', value: current, onInput: () => pick(custom.value) })
    return h(
      'div',
      { class: 'swatches' },
      ...colors.map((c) =>
        h('button', { type: 'button', class: `swatch ${c === current ? 'selected' : ''}`, style: `background:${c}`, title: c, 'aria-label': `Couleur ${c}`, onClick: () => pick(c) }),
      ),
      custom,
    )
  }

  function slider(label: string, value: number, min: number, max: number, step: number, set: (v: number) => void, unit = 'pt'): HTMLElement {
    const out = h('span', { class: 'slider-value' }, `${value} ${unit}`)
    const input = h('input', {
      type: 'range',
      min,
      max,
      step,
      value,
      onInput: () => {
        out.textContent = `${input.value} ${unit}`
        set(Number(input.value))
      },
    })
    return h('label', { class: 'slider' }, h('span', {}, label), input, out)
  }

  function toolPanel(kind: ToolKind): HTMLElement {
    const box = h('div', { class: 'popover tool-panel' })
    const rebuild = () => {
      saveTool()
      box.replaceChildren(...content())
    }
    const content = (): HTMLElement[] => {
      if (kind === 'eraser') {
        const modes: [ToolState['eraser']['mode'], string][] = [
          ['stroke', 'Trait entier'],
          ['partial', 'Précise'],
        ]
        return [
          h(
            'div',
            { class: 'segmented' },
            ...modes.map(([m, label]) =>
              h(
                'button',
                {
                  type: 'button',
                  class: tool.eraser.mode === m ? 'selected' : '',
                  onClick: () => {
                    tool.eraser.mode = m
                    rebuild()
                  },
                },
                label,
              ),
            ),
          ),
          slider('Taille', tool.eraser.size, 3, 40, 1, (v) => {
            tool.eraser.size = v
            saveTool()
          }),
        ]
      }
      const t = kind === 'highlighter' ? tool.highlighter : tool.pen
      const hl = kind === 'highlighter'
      return [
        swatches(hl ? HL_COLORS : PEN_COLORS, t.color, (c) => {
          t.color = c
          rebuild()
        }),
        slider('Épaisseur', t.width, hl ? 4 : 0.4, hl ? 30 : 5, hl ? 1 : 0.1, (v) => {
          t.width = v
          saveTool()
        }),
      ]
    }
    box.append(...content())
    return box
  }

  /** Accès direct aux couleurs et épaisseurs courantes (écrans assez larges). */
  function renderQuick(): void {
    if (tool.kind === 'eraser') {
      quick.replaceChildren(
        ...ERASER_SIZES.map((s) =>
          h('button', { type: 'button', class: `width ${tool.eraser.size === s ? 'selected' : ''}`, title: `Gomme ${s} pt`, onClick: () => ((tool.eraser.size = s), saveTool()) }, h('span', { class: 'ring', style: `width:${6 + s / 2}px;height:${6 + s / 2}px` })),
        ),
      )
      return
    }
    const hl = tool.kind === 'highlighter'
    const t = hl ? tool.highlighter : tool.pen
    const colors = (hl ? HL_COLORS : PEN_COLORS.filter((_, i) => [0, 2, 6, 4].includes(i))).slice(0, 4)
    if (!colors.includes(t.color)) colors[colors.length - 1] = t.color
    quick.replaceChildren(
      ...colors.map((c) => h('button', { type: 'button', class: `swatch ${c === t.color ? 'selected' : ''}`, style: `background:${c}`, 'aria-label': `Couleur ${c}`, onClick: () => ((t.color = c), saveTool()) })),
      h('span', { class: 'sep' }),
      ...(hl ? HL_WIDTHS : PEN_WIDTHS).map((w) =>
        h('button', { type: 'button', class: `width ${t.width === w ? 'selected' : ''}`, title: `${w} pt`, onClick: () => ((t.width = w), saveTool()) }, h('span', { class: 'bar', style: `height:${hl ? w / 3 : Math.max(1.5, w * 2)}px` })),
      ),
    )
  }

  function doUndo(): void {
    const c = undo.pop()
    if (!c) return
    redo.push(c)
    canvas.applyChange(c.removed, c.added)
    persist(c.removed, c.added)
    refreshButtons()
  }

  function doRedo(): void {
    const c = redo.pop()
    if (!c) return
    undo.push(c)
    canvas.applyChange(c.added, c.removed)
    persist(c.added, c.removed)
    refreshButtons()
  }

  // ---------- Pages ----------

  const pageIds = () => pages.map((p) => p.id)

  function structureChanged(scrollTo?: number): void {
    canvas.setPages(pages)
    if (scrollTo !== undefined) canvas.scrollToPage(scrollTo)
    pageLabel.textContent = `${canvas.currentPageIndex() + 1} / ${pages.length}`
    if (!panel.hidden) renderPanel()
  }

  function addPage(after: number): void {
    const ref = pages[after] ?? pages[pages.length - 1]
    const page: Page = { id: uid(), notebookId, bg: ref?.bg ?? node!.bg ?? 'blank', orient: ref?.orient ?? node!.orient ?? 'portrait', rev: 0 }
    pages.splice(after + 1, 0, page)
    void enqueue(() => applyPageStructure(notebookId, { pageIds: pageIds(), putPages: [page] }))
    structureChanged(after + 1)
  }

  async function duplicatePage(index: number): Promise<void> {
    const src = pages[index]
    await chain
    const page: Page = { ...src, id: uid(), rev: 0 }
    const strokes = (await getStrokes(src.id)).map((s) => ({ ...s, id: uid(), pageId: page.id }))
    pages.splice(index + 1, 0, page)
    void enqueue(() => applyPageStructure(notebookId, { pageIds: pageIds(), putPages: [page], addStrokes: strokes }))
    structureChanged(index + 1)
  }

  async function deletePage(index: number): Promise<void> {
    const page = pages[index]
    if (!(await confirmDialog('Supprimer la page', `La page ${index + 1} et tout ce qui y est écrit seront supprimés. Cette action ne peut pas être annulée.`, 'Supprimer', true))) return
    pages.splice(index, 1)
    const put: Page[] = []
    if (!pages.length) {
      // Un bloc-notes garde toujours au moins une page.
      const blank: Page = { id: uid(), notebookId, bg: page.bg, orient: page.orient, rev: 0 }
      pages.push(blank)
      put.push(blank)
    }
    const touches = (c: StrokeChange) => [...c.added, ...c.removed].some((s) => s.pageId === page.id)
    undo = undo.filter((c) => !touches(c))
    redo = redo.filter((c) => !touches(c))
    void enqueue(() => applyPageStructure(notebookId, { pageIds: pageIds(), putPages: put, deletePageIds: [page.id] }))
    refreshButtons()
    structureChanged()
  }

  function movePage(index: number, delta: number): void {
    const to = index + delta
    if (to < 0 || to >= pages.length) return
    const [p] = pages.splice(index, 1)
    pages.splice(to, 0, p)
    void enqueue(() => applyPageStructure(notebookId, { pageIds: pageIds() }))
    structureChanged(to)
  }

  function setBackground(index: number, bg: Background): void {
    const page = pages[index]
    pages[index] = { ...page, bg }
    void enqueue(() => applyPageStructure(notebookId, { pageIds: pageIds(), putPages: [pages[index]] }))
    structureChanged()
  }

  function togglePanel(): void {
    panel.hidden = !panel.hidden
    if (!panel.hidden) renderPanel()
  }

  function renderPanel(): void {
    const current = canvas.currentPageIndex()
    panel.replaceChildren(
      h('div', { class: 'panel-head' }, h('strong', {}, `Pages (${pages.length})`), iconButton(icons.close, 'Fermer', () => togglePanel(), 'small')),
      h('button', { class: 'btn wide', type: 'button', onClick: () => addPage(canvas.currentPageIndex()) }, `Ajouter une page après la page ${current + 1}`),
      h(
        'ol',
        { class: 'page-list' },
        ...pages.map((p, i) =>
          h(
            'li',
            { class: i === current ? 'current' : '' },
            h('button', { class: 'page-go', type: 'button', onClick: () => (canvas.scrollToPage(i), renderPanel()) }, `Page ${i + 1}`),
            h(
              'select',
              { 'aria-label': `Fond de la page ${i + 1}`, onChange: (e: Event) => setBackground(i, (e.target as HTMLSelectElement).value as Background) },
              ...BACKGROUNDS.map((b) => h('option', { value: b.id, selected: b.id === p.bg }, b.label)),
            ),
            iconButton(icons.up, 'Monter', () => movePage(i, -1), 'small'),
            iconButton(icons.down, 'Descendre', () => movePage(i, 1), 'small'),
            iconButton(icons.copy, 'Dupliquer', () => void duplicatePage(i), 'small'),
            iconButton(icons.trash, 'Supprimer', () => void deletePage(i), 'small danger'),
          ),
        ),
      ),
    )
  }

  // ---------- Clavier, fermeture ----------

  const onKey = (e: KeyboardEvent): void => {
    if (!(e.ctrlKey || e.metaKey) || document.querySelector('dialog[open]')) return
    const k = e.key.toLowerCase()
    if (k === 'z' && !e.shiftKey) doUndo()
    else if (k === 'y' || (k === 'z' && e.shiftKey)) doRedo()
    else return
    e.preventDefault()
  }
  window.addEventListener('keydown', onKey)

  async function close(): Promise<void> {
    await chain
    deps.onClose()
  }

  refreshButtons()

  return {
    notebookId,
    flush: () => chain,
    async reload() {
      await chain
      const fresh = await getNode(notebookId)
      if (!fresh || fresh.deleted) return deps.onClose()
      node = fresh
      title.textContent = fresh.name
      pages = await loadPages(fresh)
      undo = []
      redo = []
      canvas.setPages(pages, true)
      refreshButtons()
      structureChanged()
    },
    destroy() {
      window.removeEventListener('keydown', onKey)
      closePopovers()
      canvas.destroy()
    },
  }
}
