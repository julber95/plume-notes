// Writing screen: toolbar, pages, undo/redo.

import { applyPageStructure, applyStrokeChange, getNode, getPages, getStrokes, kvGet, kvSet } from '../db'
import { BACKGROUNDS, uid, type Background, type LibNode, type Page, type Stroke } from '../model'
import { InkCanvas, type StrokeChange, type ToolKind, type ToolState } from './canvas'
import { closePopovers, confirmDialog, h, iconButton, icons, showPopover, toast } from './dom'

export interface EditorHandle {
  notebookId: string
  /** Waits until everything is saved locally. */
  flush(): Promise<void>
  /** Reloads the content (replaced by a version coming from OneDrive). */
  reload(): Promise<void>
  destroy(): void
}

export interface EditorDeps {
  onClose(): void
  /** Called after each local save. */
  onSaved(): void
  syncChip: HTMLElement
}

const PEN_COLORS = ['#1a1a1a', '#4a4f57', '#1d4ed8', '#0e7490', '#15803d', '#b45309', '#c62828', '#9d174d', '#6d28d9', '#8a5a2b']
const HL_COLORS = ['#ffe14d', '#a8f06e', '#7fd8ff', '#ffa8d0', '#ffbf6b', '#c9b3ff']
const PEN_WIDTHS = [0.8, 1.3, 2.2]
const PENCIL_WIDTHS = [1.2, 1.8, 2.8]
const HL_WIDTHS = [8, 14, 22]
const ERASER_SIZES = [6, 12, 24]

const DEFAULT_TOOL: ToolState = {
  kind: 'pen',
  pen: { color: PEN_COLORS[0], width: PEN_WIDTHS[1] },
  pencil: { color: PEN_COLORS[0], width: PENCIL_WIDTHS[1] },
  scribbleErase: true,
  shapeHold: true,
  highlighter: { color: HL_COLORS[0], width: HL_WIDTHS[1] },
  eraser: { mode: 'stroke', size: ERASER_SIZES[1] },
}

const TOOLS: { kind: ToolKind; label: string; icon: string }[] = [
  { kind: 'pen', label: 'Pen', icon: icons.pen },
  { kind: 'pencil', label: 'Pencil', icon: icons.pencil },
  { kind: 'highlighter', label: 'Highlighter', icon: icons.highlighter },
  { kind: 'eraser', label: 'Eraser', icon: icons.eraser },
  { kind: 'line', label: 'Straight line', icon: icons.line },
]

export async function openEditor(root: HTMLElement, notebookId: string, deps: EditorDeps): Promise<EditorHandle | null> {
  let node = await getNode(notebookId)
  if (!node || node.deleted) return null

  const saved = await kvGet<ToolState>('tool')
  const tool: ToolState = { ...DEFAULT_TOOL, ...saved, pen: { ...DEFAULT_TOOL.pen, ...saved?.pen }, pencil: { ...DEFAULT_TOOL.pencil, ...saved?.pencil }, highlighter: { ...DEFAULT_TOOL.highlighter, ...saved?.highlighter }, eraser: { ...DEFAULT_TOOL.eraser, ...saved?.eraser } }
  let pages: Page[] = []
  let undo: StrokeChange[] = []
  let redo: StrokeChange[] = []

  // Local writes are chained in order, without ever blocking the drawing.
  let chain: Promise<void> = Promise.resolve()
  const enqueue = (fn: () => Promise<void>): Promise<void> => {
    chain = chain.then(fn).then(deps.onSaved, (e) => {
      console.error('Save', e)
      toast('Could not save on this device. Check the available storage space.', 8000)
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

  // ---------- Screen structure ----------

  const stage = h('div', { class: 'stage' })
  const title = h('div', { class: 'editor-title' }, node.name)
  const undoBtn = iconButton(icons.undo, 'Undo', () => doUndo())
  const redoBtn = iconButton(icons.redo, 'Redo', () => doRedo())
  const toolButtons = new Map<ToolKind, HTMLButtonElement>()
  const quick = h('div', { class: 'quick' })
  const pageLabel = h('button', { class: 'page-pill', type: 'button', title: 'Pages', onClick: () => togglePanel() })
  const panel = h('aside', { class: 'pages-panel', hidden: true })

  const toolbar = h(
    'header',
    { class: 'toolbar' },
    iconButton(icons.back, 'Back to library', () => void close()),
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
    iconButton(icons.zoomOut, 'Zoom out', () => canvas.zoomBy(1 / 1.25), 'small'),
    iconButton(icons.zoomIn, 'Zoom in', () => canvas.zoomBy(1.25), 'small'),
    h('button', { class: 'page-pill', type: 'button', title: 'Fit to width', onClick: () => canvas.zoomBy('fit') }, 'Fit'),
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

  // ---------- Tools ----------

  function refreshButtons(): void {
    undoBtn.disabled = undo.length === 0
    redoBtn.disabled = redo.length === 0
    for (const [kind, b] of toolButtons) {
      b.classList.toggle('active', kind === tool.kind)
      const dot = b.querySelector<HTMLElement>('.tool-dot')!
      dot.style.background = kind === 'pen' || kind === 'line' ? tool.pen.color : kind === 'pencil' ? tool.pencil.color : kind === 'highlighter' ? tool.highlighter.color : 'transparent'
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
    // Second tap on the active tool: its settings.
    showPopover(button, toolPanel(kind))
  }

  function swatches(colors: string[], current: string, pick: (c: string) => void): HTMLElement {
    const custom = h('input', { type: 'color', class: 'swatch custom', title: 'Other colour', value: current, onInput: () => pick(custom.value) })
    return h(
      'div',
      { class: 'swatches' },
      ...colors.map((c) =>
        h('button', { type: 'button', class: `swatch ${c === current ? 'selected' : ''}`, style: `background:${c}`, title: c, 'aria-label': `Colour ${c}`, onClick: () => pick(c) }),
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
          ['stroke', 'Whole stroke'],
          ['partial', 'Precise'],
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
          slider('Size', tool.eraser.size, 3, 40, 1, (v) => {
            tool.eraser.size = v
            saveTool()
          }),
        ]
      }
      const t = kind === 'highlighter' ? tool.highlighter : kind === 'pencil' ? tool.pencil : tool.pen
      const hl = kind === 'highlighter'
      return [
        swatches(hl ? HL_COLORS : PEN_COLORS, t.color, (c) => {
          t.color = c
          rebuild()
        }),
        slider('Width', t.width, hl ? 4 : 0.4, hl ? 30 : kind === 'pencil' ? 6 : 5, hl ? 1 : 0.1, (v) => {
          t.width = v
          saveTool()
        }),
        ...(kind === 'pen'
          ? [
              h(
                'label',
                { class: 'check' },
                h('input', {
                  type: 'checkbox',
                  checked: tool.scribbleErase,
                  onChange: (e: Event) => {
                    tool.scribbleErase = (e.target as HTMLInputElement).checked
                    saveTool()
                  },
                }),
                h('span', {}, 'Scribble over ink to erase it'),
              ),
              h(
                'label',
                { class: 'check' },
                h('input', {
                  type: 'checkbox',
                  checked: tool.shapeHold,
                  onChange: (e: Event) => {
                    tool.shapeHold = (e.target as HTMLInputElement).checked
                    saveTool()
                  },
                }),
                h('span', {}, 'Hold at the end of a stroke for a clean shape'),
              ),
            ]
          : []),
      ]
    }
    box.append(...content())
    return box
  }

  /** Direct access to the current colours and widths (wide enough screens). */
  function renderQuick(): void {
    if (tool.kind === 'eraser') {
      quick.replaceChildren(
        ...ERASER_SIZES.map((s) =>
          h('button', { type: 'button', class: `width ${tool.eraser.size === s ? 'selected' : ''}`, title: `Eraser ${s} pt`, onClick: () => ((tool.eraser.size = s), saveTool()) }, h('span', { class: 'ring', style: `width:${6 + s / 2}px;height:${6 + s / 2}px` })),
        ),
      )
      return
    }
    const hl = tool.kind === 'highlighter'
    const pencil = tool.kind === 'pencil'
    const t = hl ? tool.highlighter : pencil ? tool.pencil : tool.pen
    const colors = (hl ? HL_COLORS : PEN_COLORS.filter((_, i) => [0, 2, 6, 4].includes(i))).slice(0, 4)
    if (!colors.includes(t.color)) colors[colors.length - 1] = t.color
    quick.replaceChildren(
      ...colors.map((c) => h('button', { type: 'button', class: `swatch ${c === t.color ? 'selected' : ''}`, style: `background:${c}`, 'aria-label': `Colour ${c}`, onClick: () => ((t.color = c), saveTool()) })),
      h('span', { class: 'sep' }),
      ...(hl ? HL_WIDTHS : pencil ? PENCIL_WIDTHS : PEN_WIDTHS).map((w) =>
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
    if (!(await confirmDialog('Delete page', `Page ${index + 1} and everything written on it will be deleted. This cannot be undone.`, 'Delete', true))) return
    pages.splice(index, 1)
    const put: Page[] = []
    if (!pages.length) {
      // A notebook always keeps at least one page.
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
      h('div', { class: 'panel-head' }, h('strong', {}, `Pages (${pages.length})`), iconButton(icons.close, 'Close', () => togglePanel(), 'small')),
      h('button', { class: 'btn wide', type: 'button', onClick: () => addPage(canvas.currentPageIndex()) }, `Add a page after page ${current + 1}`),
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
              { 'aria-label': `Background of page ${i + 1}`, onChange: (e: Event) => setBackground(i, (e.target as HTMLSelectElement).value as Background) },
              ...BACKGROUNDS.map((b) => h('option', { value: b.id, selected: b.id === p.bg }, b.label)),
            ),
            iconButton(icons.up, 'Move up', () => movePage(i, -1), 'small'),
            iconButton(icons.down, 'Move down', () => movePage(i, 1), 'small'),
            iconButton(icons.copy, 'Duplicate', () => void duplicatePage(i), 'small'),
            iconButton(icons.trash, 'Delete', () => void deletePage(i), 'small danger'),
          ),
        ),
      ),
    )
  }

  // ---------- Keyboard, closing ----------

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
