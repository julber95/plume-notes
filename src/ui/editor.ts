// Writing screen: toolbar, pages, undo/redo.

import { applyPageStructure, applyStrokeChange, getAsset, getNode, getPages, getStrokes, kvGet, kvSet } from '../db'
import { buildAxes } from '../axes'
import { BACKGROUNDS, pageSize, uid, type Background, type LibNode, type Orientation, type Page, type Stroke } from '../model'
import { PdfView } from './pdfview'
import { preparePicture } from './pictures'
import { InkCanvas, type SelectionKind, type StrokeChange, type ToolKind, type ToolState } from './canvas'
import { button, closePopovers, confirmDialog, dialogButtons, h, iconButton, icons, openDialog, openMenu, promptDialog, showPopover, toast } from './dom'

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
const PENCIL_WIDTHS = [1, 1.5, 2.4]
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
  { kind: 'lasso', label: 'Select', icon: icons.lasso },
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
      refreshThumb(pageId)
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
  // Left panel: a small preview of each page, to move around the notebook.
  const thumbs = h('nav', { class: 'thumbs', hidden: true, 'aria-label': 'Page previews' })
  // Floating bar of actions for the selection (or "Paste" after a tap).
  const selBar = h('div', { class: 'sel-bar', hidden: true })

  const pdfView = new PdfView(async (asset) => (await getAsset(asset))?.bytes)

  // Picture import: the file chosen is reduced if needed, then placed on the page.
  const picker = h('input', {
    type: 'file',
    accept: 'image/*',
    hidden: true,
    onChange: async () => {
      const file = picker.files?.[0]
      picker.value = ''
      if (!file) return
      try {
        const picture = await preparePicture(file)
        if (!canvas.insertImage(picture.mime, picture.data, picture.width, picture.height)) throw new Error('page not ready')
        // Ready to be moved and resized.
        tool.kind = 'lasso'
        saveTool()
      } catch (e) {
        console.error('Picture import', e)
        toast('This picture could not be added.')
      }
    },
  })

  // "Insert" menu: a picture, or a pair of graduated axes.
  const insertButton: HTMLButtonElement = iconButton(icons.insert, 'Insert', () =>
    openMenu(insertButton, [
      { label: 'Picture', icon: icons.image, action: () => picker.click() },
      { label: 'Axes for a graph', icon: icons.axes, action: () => void insertAxes() },
    ]),
  )

  async function insertAxes(): Promise<void> {
    const last = (await kvGet<{ xMin: number; xMax: number; yMin: number; yMax: number; grid: boolean }>('axes')) ?? { xMin: -5, xMax: 5, yMin: -5, yMax: 5, grid: true }
    const chosen = await openDialog<typeof last>('Axes for a graph', (d) => {
      const field = (value: number, label: string) => h('input', { type: 'number', value, step: 'any', inputMode: 'decimal', 'aria-label': label })
      const xMin = field(last.xMin, 'x from')
      const xMax = field(last.xMax, 'x to')
      const yMin = field(last.yMin, 'y from')
      const yMax = field(last.yMax, 'y to')
      const grid = h('input', { type: 'checkbox', checked: last.grid })
      const problem = h('p', { class: 'error-text', hidden: true }, 'Each axis must go from a smaller number to a larger one.')
      return h(
        'form',
        {
          onSubmit: (e: Event) => {
            e.preventDefault()
            const v = { xMin: Number(xMin.value), xMax: Number(xMax.value), yMin: Number(yMin.value), yMax: Number(yMax.value), grid: grid.checked }
            if (![v.xMin, v.xMax, v.yMin, v.yMax].every(Number.isFinite) || v.xMax <= v.xMin || v.yMax <= v.yMin) problem.hidden = false
            else d.close(v)
          },
        },
        h('div', { class: 'field inline' }, h('span', {}, 'x from'), xMin, h('span', {}, 'to'), xMax),
        h('div', { class: 'field inline' }, h('span', {}, 'y from'), yMin, h('span', {}, 'to'), yMax),
        h('label', { class: 'check' }, grid, h('span', {}, 'Show a grid')),
        problem,
        dialogButtons(button('Cancel', () => d.close(null)), h('button', { class: 'btn primary', type: 'submit' }, 'Insert')),
      )
    })
    if (!chosen) return
    await kvSet('axes', chosen)
    if (!canvas.insertGroup(buildAxes(chosen))) return void toast('The page is not ready yet.')
    // Ready to be moved and resized.
    tool.kind = 'lasso'
    saveTool()
  }

  const toolbar = h(
    'header',
    { class: 'toolbar' },
    iconButton(icons.back, 'Back to library', () => void close()),
    iconButton(icons.sidebar, 'Page previews', () => toggleThumbs()),
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
    insertButton,
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
  const view = h('div', { class: 'editor' }, toolbar, h('div', { class: 'editor-body' }, thumbs, stage, corner, selBar, panel, picker))
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
      onViewChange: (i) => {
        pageLabel.textContent = `${i + 1} / ${pages.length}`
        markCurrentThumb(i)
      },
      onPictureReady: (pageId) => refreshThumb(pageId),
      renderPdf: async (page, scale) => (page.pdf ? pdfView.render(page.pdf.asset, page.pdf.index, pageSize(page).w, scale) : null),
      onAddPage: () => addPage(pages.length - 1),
      onSelection: (rect, kind) => showSelectionBar(rect, kind),
      onLassoTap: (x, y, canPaste) => showPasteBar(x, y, canPaste),
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
    selBar.hidden = true
    if (tool.kind !== kind) {
      tool.kind = kind
      canvas.clearSelection()
      closePopovers()
      saveTool()
      return
    }
    // Second tap on the active tool: its settings (the selection tool has none).
    if (kind !== 'lasso') showPopover(button, toolPanel(kind))
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

  /** Places the floating bar above the given area (below it when there is no room). */
  function placeBar(x: number, y: number, w: number, h: number): void {
    selBar.hidden = false
    const bar = selBar.getBoundingClientRect()
    const area = stage.getBoundingClientRect()
    const left = Math.max(6, Math.min(area.width - bar.width - 6, x + w / 2 - bar.width / 2))
    let top = y - bar.height - 14
    if (top < 6) top = Math.min(area.height - bar.height - 6, y + h + 14)
    // The writing area starts to the right of the page previews when they are open.
    selBar.style.left = `${left + stage.offsetLeft}px`
    selBar.style.top = `${Math.max(6, top)}px`
  }

  function showSelectionBar(rect: { x: number; y: number; w: number; h: number } | null, kind: SelectionKind): void {
    if (!rect) {
      selBar.hidden = true
      return
    }
    if (selBar.dataset.mode !== kind) {
      selBar.dataset.mode = kind
      if (kind === 'crop') {
        selBar.replaceChildren(
          h('span', { class: 'bar-hint' }, 'Drag over the part to keep'),
          button('Cancel', () => canvas.cancelCrop()),
          button('Crop', () => void canvas.applyCrop().catch(() => toast('This picture could not be cropped.')), 'primary'),
        )
      } else {
        selBar.replaceChildren(
          // Colours apply to ink; a picture alone has none to change.
          ...(kind === 'picture'
            ? []
            : [
                ...[PEN_COLORS[0], PEN_COLORS[2], PEN_COLORS[6], PEN_COLORS[4]].map((c) =>
                  h('button', { type: 'button', class: 'swatch', style: `background:${c}`, title: 'Change colour', 'aria-label': `Recolour ${c}`, onClick: () => canvas.recolorSelection(c) }),
                ),
                h('input', { type: 'color', class: 'swatch custom', title: 'Other colour', 'aria-label': 'Recolour, other colour', onChange: (e: Event) => canvas.recolorSelection((e.target as HTMLInputElement).value) }),
                h('span', { class: 'sep' }),
              ]),
          iconButton(icons.rotate, 'Rotate a quarter turn', () => void canvas.rotateSelection().catch(() => toast('This could not be rotated.')), 'small'),
          ...(kind === 'picture' ? [iconButton(icons.crop, 'Crop', () => canvas.startCrop(), 'small')] : []),
          iconButton(icons.duplicate, 'Duplicate', () => canvas.duplicateSelection(), 'small'),
          iconButton(icons.copy, 'Copy', () => (canvas.copySelection(), toast('Copied. Tap the page with the selection tool to paste.')), 'small'),
          iconButton(icons.cut, 'Cut', () => canvas.cutSelection(), 'small'),
          iconButton(icons.trash, 'Delete', () => canvas.deleteSelection(), 'small danger'),
        )
      }
    }
    placeBar(rect.x, rect.y, rect.w, rect.h)
  }

  function showPasteBar(x: number, y: number, canPaste: boolean): void {
    if (!canPaste) {
      selBar.hidden = true
      return
    }
    selBar.dataset.mode = 'paste'
    selBar.replaceChildren(
      h('button', { class: 'btn', type: 'button', onClick: () => ((selBar.hidden = true), canvas.paste()) }, h('span', { class: 'menu-icon', html: icons.paste }), 'Paste'),
    )
    placeBar(x, y, 0, 0)
  }

  /** Direct access to the current colours and widths (wide enough screens). */
  function renderQuick(): void {
    if (tool.kind === 'lasso') return quick.replaceChildren()
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
    if (!thumbs.hidden) renderThumbs()
  }

  /**
   * Adds a page. Without `format`, the quick way: the same background and
   * direction as the page before it.
   */
  function addPage(after: number, format?: { bg: Background; orient: Orientation }): void {
    const ref = pages[after] ?? pages[pages.length - 1]
    // After a cover or a page of an imported PDF, a plain page of the notebook's kind.
    const plain = ref?.pdf || ref?.cover ? undefined : ref?.bg
    const page: Page = { id: uid(), notebookId, bg: format?.bg ?? plain ?? node!.bg ?? 'blank', orient: format?.orient ?? ref?.orient ?? node!.orient ?? 'portrait', rev: 0 }
    pages.splice(after + 1, 0, page)
    void enqueue(() => applyPageStructure(notebookId, { pageIds: pageIds(), putPages: [page] }))
    structureChanged(after + 1)
  }

  /** Lets the user choose a page's background and direction. */
  function formatDialog(title: string, current: { bg: Background; orient: Orientation }, okLabel: string): Promise<{ bg: Background; orient: Orientation } | null> {
    return openDialog<{ bg: Background; orient: Orientation }>(title, (d) => {
      let { bg, orient } = current
      const tiles = h('div', { class: 'bg-tiles', role: 'radiogroup', 'aria-label': 'Page background' })
      const orients = h('div', { class: 'segmented' })
      const draw = () => {
        tiles.replaceChildren(
          ...BACKGROUNDS.map((b) =>
            h('button', { type: 'button', role: 'radio', 'aria-checked': String(b.id === bg), class: `bg-tile ${b.id === bg ? 'selected' : ''}`, onClick: () => ((bg = b.id), draw()) }, h('span', { class: `paper bg-${b.id}` }), b.label),
          ),
        )
        orients.replaceChildren(
          ...(['portrait', 'landscape'] as const).map((o) => h('button', { type: 'button', class: o === orient ? 'selected' : '', onClick: () => ((orient = o), draw()) }, o === 'portrait' ? 'Portrait' : 'Landscape')),
        )
      }
      draw()
      return [
        h('div', { class: 'field' }, h('span', {}, 'Background'), tiles),
        h('div', { class: 'field' }, h('span', {}, 'A4 format'), orients),
        dialogButtons(button('Cancel', () => d.close(null)), button(okLabel, () => d.close({ bg, orient }), 'primary')),
      ]
    })
  }

  async function addPageWithFormat(after: number): Promise<void> {
    const ref = pages[after]
    const format = await formatDialog('Add a page', { bg: (ref?.pdf || ref?.cover ? undefined : ref?.bg) ?? node!.bg ?? 'blank', orient: ref?.orient ?? node!.orient ?? 'portrait' }, 'Add')
    if (format) addPage(after, format)
  }

  async function changeFormat(index: number): Promise<void> {
    const page = pages[index]
    const format = await formatDialog(`Format of page ${index + 1}`, { bg: page.bg, orient: page.orient }, 'Apply')
    if (!format || (format.bg === page.bg && format.orient === page.orient)) return
    pages[index] = { ...page, ...format }
    void enqueue(() => applyPageStructure(notebookId, { pageIds: pageIds(), putPages: [pages[index]] }))
    structureChanged()
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

  // ---------- Page previews ----------

  const THUMB_WIDTH = 96
  /** Previews waiting to be drawn or redrawn, and those currently in view in the panel. */
  const staleThumbs = new Set<string>()
  const visibleThumbs = new Set<string>()
  let thumbTimer = 0
  let drawingThumbs = false
  const thumbWatcher = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const id = (e.target as HTMLElement).dataset.page!
        if (e.isIntersecting) visibleThumbs.add(id)
        else visibleThumbs.delete(id)
      }
      scheduleThumbs(0)
    },
    { root: thumbs, rootMargin: '200px 0px' },
  )

  function toggleThumbs(open = thumbs.hidden === true): void {
    thumbs.hidden = !open
    view.classList.toggle('with-thumbs', open)
    void kvSet('thumbsOpen', open)
    if (open) renderThumbs()
  }

  function renderThumbs(): void {
    thumbWatcher.disconnect()
    visibleThumbs.clear()
    const current = canvas.currentPageIndex()
    const previous = new Map([...thumbs.querySelectorAll<HTMLElement>('.thumb')].map((el) => [el.dataset.page!, el.querySelector('canvas')]))
    const marked = pages.map((p, i) => ({ p, i })).filter(({ p }) => p.bookmark)
    thumbs.replaceChildren(
      ...(marked.length
        ? [
            h(
              'div',
              { class: 'bookmarks' },
              h('strong', {}, 'Bookmarks'),
              ...marked.map(({ p, i }) => h('button', { type: 'button', class: 'bookmark-go', onClick: () => canvas.scrollToPage(i) }, h('span', { class: 'menu-icon', html: icons.bookmark }), h('span', { class: 'bookmark-name' }, p.bookmark!), h('span', { class: 'muted' }, String(i + 1)))),
            ),
          ]
        : []),
      ...pages.map((p, i) => {
        const frame = h('span', { class: `thumb-page ${p.orient === 'landscape' ? 'landscape' : ''}` })
        // Keep the preview already drawn while the fresh one is prepared.
        const kept = previous.get(p.id)
        if (kept) frame.append(kept)
        const more = iconButton(icons.more, `Actions for page ${i + 1}`, () => thumbMenu(i, more), 'small')
        const grip = h('span', { class: 'thumb-grip', title: 'Drag to move the page', 'aria-label': `Move page ${i + 1}`, html: icons.grip, onPointerdown: (e: PointerEvent) => startThumbDrag(e, i) })
        const el = h(
          'div',
          { class: `thumb ${i === current ? 'current' : ''} ${p.bookmark ? 'bookmarked' : ''}`, 'data-page': p.id },
          h('button', { type: 'button', class: 'thumb-go', 'aria-label': `Go to page ${i + 1}`, onClick: () => canvas.scrollToPage(i) }, frame),
          p.bookmark ? h('span', { class: 'thumb-ribbon', title: `Bookmark: ${p.bookmark}`, html: icons.bookmark }) : null,
          h('div', { class: 'thumb-row' }, grip, h('span', { class: 'thumb-number' }, String(i + 1)), more),
        )
        staleThumbs.add(p.id)
        thumbWatcher.observe(el)
        return el
      }),
    )
  }

  function thumbMenu(index: number, anchor: HTMLElement): void {
    const p = pages[index]
    openMenu(anchor, [
      { label: 'Add a page after', icon: icons.plus, action: () => addPage(index) },
      { label: 'Add a page of another format…', icon: icons.pages, action: () => void addPageWithFormat(index) },
      { label: 'Duplicate', icon: icons.copy, action: () => void duplicatePage(index) },
      { label: p.bookmark ? 'Remove the bookmark' : 'Add a bookmark', icon: icons.bookmark, action: () => void toggleBookmark(index) },
      ...(p.pdf || p.cover ? [] : [{ label: 'Change the format…', icon: icons.pages, action: () => void changeFormat(index) }]),
      { label: 'Delete', icon: icons.trash, danger: true, action: () => void deletePage(index) },
    ])
  }

  async function toggleBookmark(index: number): Promise<void> {
    const page = pages[index]
    let name: string | undefined
    if (!page.bookmark) {
      name = (await promptDialog('Add a bookmark', 'Name of the bookmark', `Page ${index + 1}`, 'Add')) ?? undefined
      if (!name) return
    }
    pages[index] = { ...page, bookmark: name }
    void enqueue(() => applyPageStructure(notebookId, { pageIds: pageIds(), putPages: [pages[index]] }))
    structureChanged()
  }

  /** Reordering by dragging the handle of a preview up or down the panel. */
  function startThumbDrag(e: PointerEvent, from: number): void {
    e.preventDefault()
    const grip = e.currentTarget as HTMLElement
    const items = [...thumbs.querySelectorAll<HTMLElement>('.thumb')]
    const dragged = items[from]
    grip.setPointerCapture(e.pointerId)
    dragged.classList.add('dragging')
    let to = from
    const startY = e.clientY
    const move = (ev: PointerEvent) => {
      dragged.style.transform = `translateY(${ev.clientY - startY}px)`
      // The page lands before the first preview whose middle is below the pointer.
      to = items.length - 1
      for (let i = 0; i < items.length; i++) {
        if (i === from) continue
        const r = items[i].getBoundingClientRect()
        if (ev.clientY < r.top + r.height / 2) {
          to = i > from ? i - 1 : i
          break
        }
      }
      items.forEach((el, i) => el.classList.toggle('drop-here', i !== from && (to < from ? i === to : i === to + 1)))
      thumbs.classList.toggle('drop-at-end', to === items.length - 1 && from !== items.length - 1)
      // Scroll the panel when dragging near its edges.
      const box = thumbs.getBoundingClientRect()
      if (ev.clientY < box.top + 40) thumbs.scrollTop -= 12
      else if (ev.clientY > box.bottom - 40) thumbs.scrollTop += 12
    }
    const end = (ev: PointerEvent) => {
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', end)
      grip.removeEventListener('pointercancel', end)
      thumbs.classList.remove('drop-at-end')
      if (ev.type === 'pointerup' && to !== from) movePage(from, to - from)
      else renderThumbs()
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', end)
    grip.addEventListener('pointercancel', end)
  }

  function markCurrentThumb(index: number): void {
    if (thumbs.hidden) return
    thumbs.querySelectorAll('.thumb').forEach((el, i) => {
      el.classList.toggle('current', i === index)
      if (i === index) el.scrollIntoView({ block: 'nearest' })
    })
  }

  /** A page changed: its preview will be redrawn shortly (not at every stroke). */
  function refreshThumb(pageId: string): void {
    staleThumbs.add(pageId)
    if (!thumbs.hidden) scheduleThumbs(700)
  }

  function scheduleThumbs(delay: number): void {
    clearTimeout(thumbTimer)
    thumbTimer = window.setTimeout(() => void drawThumbs(), delay)
  }

  async function drawThumbs(): Promise<void> {
    if (drawingThumbs || thumbs.hidden) return
    drawingThumbs = true
    try {
      for (;;) {
        const id = [...staleThumbs].find((p) => visibleThumbs.has(p))
        if (!id) break
        staleThumbs.delete(id)
        const frame = thumbs.querySelector<HTMLElement>(`.thumb[data-page="${id}"] .thumb-page`)
        const preview = frame && (await canvas.thumbnail(id, THUMB_WIDTH))
        if (frame && preview) frame.replaceChildren(preview)
        // One at a time, leaving the hand free between two previews.
        await new Promise((r) => setTimeout(r, 30))
      }
    } finally {
      drawingThumbs = false
    }
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
      h('button', { class: 'btn wide', type: 'button', onClick: () => void addPageWithFormat(canvas.currentPageIndex()) }, 'Add a page of another format…'),
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
              { 'aria-label': `Background of page ${i + 1}`, disabled: !!(p.pdf || p.cover), title: p.pdf ? 'Page of an imported PDF' : p.cover ? 'Cover page' : undefined, onChange: (e: Event) => setBackground(i, (e.target as HTMLSelectElement).value as Background) },
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
    if (document.querySelector('dialog[open]') || (e.target as HTMLElement).tagName === 'INPUT') return
    const k = e.key.toLowerCase()
    if ((k === 'delete' || k === 'backspace') && canvas.hasSelection()) {
      canvas.deleteSelection()
      return e.preventDefault()
    }
    if (!(e.ctrlKey || e.metaKey)) return
    if (canvas.hasSelection() && 'cxd'.includes(k) && k.length === 1) {
      if (k === 'c') canvas.copySelection()
      else if (k === 'x') canvas.cutSelection()
      else canvas.duplicateSelection()
      return e.preventDefault()
    }
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
  // Page previews: closed at first (they take room from the page), then as left last time.
  void kvGet<boolean>('thumbsOpen').then((open) => open && toggleThumbs(true))

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
      thumbWatcher.disconnect()
      clearTimeout(thumbTimer)
      pdfView.destroy()
      closePopovers()
      canvas.destroy()
    },
  }
}
