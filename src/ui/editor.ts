// Writing screen: toolbar, pages, undo/redo.

import { applyPageStructure, applyStrokeChange, getAsset, getNode, getPages, getStrokes, kvGet, kvSet } from '../db'
import { buildAxes } from '../axes'
import { BACKGROUNDS, pageSize, uid, type Background, type LibNode, type Orientation, type Page, type Stroke } from '../model'
import { PdfView } from './pdfview'
import { preparePicture } from './pictures'
import { InkCanvas, type InkTool, type SelectionKind, type StrokeChange, type ToolKind, type ToolState } from './canvas'
import { TOOLS_KEY, currentPresets, type SyncedTools } from '../presets'
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
/** The colours offered when one of the three colours of a tool is changed. */
const PALETTE = [
  '#1a1a1a', '#4a4f57', '#8a8f98', '#8a5a2b', '#b45309', '#c62828',
  '#e4572e', '#f2a516', '#e8c21a', '#7cb518', '#15803d', '#0e7490',
  '#0ea5e9', '#1d4ed8', '#4338ca', '#6d28d9', '#a21caf', '#9d174d',
  '#e2558f', '#f29e9e', '#f6c38a', '#a7d99b', '#9ecff2', '#c4b5fd',
]
const HL_PALETTE = ['#ffe14d', '#ffbf6b', '#ff9f8a', '#ffa8d0', '#e0a3ff', '#c9b3ff', '#7fd8ff', '#8ff0e0', '#a8f06e', '#d6f25c', '#d9d9d9', '#f2d3a0']

export type ToolDock = 'top' | 'bottom' | 'left' | 'right'
const DOCK_KEY = 'plume.toolDock'
const DOCKS: [ToolDock, string][] = [
  ['top', 'At the top'],
  ['bottom', 'At the bottom'],
  ['left', 'On the left'],
  ['right', 'On the right'],
]

function storedDock(): ToolDock {
  try {
    const v = localStorage.getItem(DOCK_KEY)
    return DOCKS.some(([d]) => d === v) ? (v as ToolDock) : 'top'
  } catch {
    return 'top'
  }
}

/**
 * The three values a tool keeps at hand. A tool saved before there were any
 * keeps its colour and its width: they take a place among the default ones.
 */
function atHand<T>(saved: T[] | undefined, defaults: T[], current: T, place: (list: T[]) => number): T[] {
  if (Array.isArray(saved) && saved.length === 3) return saved
  const list = [...defaults]
  if (!list.includes(current)) list[place(list)] = current
  return list
}

const nearest = (value: number) => (list: number[]) => list.reduce((best, v, i) => (Math.abs(v - value) < Math.abs(list[best] - value) ? i : best), 0)

const DEFAULT_TOOL: ToolState = {
  kind: 'pen',
  pen: { color: PEN_COLORS[0], width: PEN_WIDTHS[1], colors: [PEN_COLORS[0], PEN_COLORS[2], PEN_COLORS[6]], widths: PEN_WIDTHS },
  pencil: { color: PEN_COLORS[0], width: PENCIL_WIDTHS[1], colors: [PEN_COLORS[0], PEN_COLORS[1], PEN_COLORS[2]], widths: PENCIL_WIDTHS },
  scribbleErase: true,
  shapeHold: true,
  highlighter: { color: HL_COLORS[0], width: HL_WIDTHS[1], colors: HL_COLORS.slice(0, 3), widths: HL_WIDTHS },
  eraser: { mode: 'stroke', size: ERASER_SIZES[1], sizes: ERASER_SIZES },
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
  // The three colours and widths of each tool: those chosen on any device, if they were sent to OneDrive.
  const synced = await kvGet<SyncedTools>(TOOLS_KEY)
  for (const kind of ['pen', 'pencil', 'highlighter'] as const) {
    const t = tool[kind]
    const d = DEFAULT_TOOL[kind]
    const theirs = synced?.presets[kind]
    t.colors = [...(theirs?.colors ?? atHand(saved?.[kind]?.colors, d.colors!, t.color, () => 0))]
    t.widths = [...(theirs?.widths ?? atHand(saved?.[kind]?.widths, d.widths!, t.width, nearest(t.width)))]
    // What is selected is always one of the three.
    if (!t.colors.includes(t.color)) t.color = t.colors[0]
    if (!t.widths.includes(t.width)) t.width = t.widths[nearest(t.width)(t.widths)]
  }
  tool.eraser.sizes = [...(synced?.presets.eraser?.sizes ?? atHand(saved?.eraser?.sizes, ERASER_SIZES, tool.eraser.size, nearest(tool.eraser.size)))]
  if (!tool.eraser.sizes.includes(tool.eraser.size)) tool.eraser.size = tool.eraser.sizes[nearest(tool.eraser.size)(tool.eraser.sizes)]
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
  let dock = storedDock()
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
    h('div', { class: 'spacer' }),
    undoBtn,
    redoBtn,
    iconButton(icons.pages, 'Pages', () => togglePanel()),
    deps.syncChip,
  )
  // The writing tools have a bar of their own, which can be moved to any edge of the page.
  const grip = h('button', { type: 'button', class: 'belt-grip', title: 'Move the toolbar', 'aria-label': 'Move the toolbar', html: icons.grip })
  const belt = h(
    'div',
    { class: 'belt', role: 'toolbar', 'aria-label': 'Writing tools' },
    grip,
    h(
      'div',
      { class: 'tools' },
      ...TOOLS.map((t) => {
        const b = iconButton(t.icon, t.label, () => selectTool(t.kind, b))
        b.append(h('span', { class: 'tool-dot' }))
        toolButtons.set(t.kind, b)
        return b
      }),
      insertButton,
    ),
    quick,
  )
  const corner = h(
    'div',
    { class: 'corner' },
    iconButton(icons.zoomOut, 'Zoom out', () => canvas.zoomBy(1 / 1.25), 'small'),
    iconButton(icons.zoomIn, 'Zoom in', () => canvas.zoomBy(1.25), 'small'),
    h('button', { class: 'page-pill', type: 'button', title: 'Fit to width', onClick: () => canvas.zoomBy('fit') }, 'Fit'),
    pageLabel,
  )
  const dockHint = h('div', { class: 'dock-hint', hidden: true })
  const workspace = h('div', { class: 'workspace' }, belt, h('div', { class: 'editor-body' }, thumbs, stage, corner, selBar, panel, picker), dockHint)
  workspace.dataset.dock = dock
  const view = h('div', { class: 'editor' }, toolbar, workspace)
  root.replaceChildren(view)

  function setDock(to: ToolDock): void {
    dock = to
    workspace.dataset.dock = to
    try {
      localStorage.setItem(DOCK_KEY, to)
    } catch {
      // storage unavailable: the place lasts until the notebook is closed
    }
    closePopovers()
  }

  // Dragging the handle carries the bar to the nearest edge; a tap lists the four places.
  grip.addEventListener('pointerdown', (down) => {
    if (down.button > 0) return
    down.preventDefault()
    grip.setPointerCapture(down.pointerId)
    let target: ToolDock | null = null
    const move = (e: PointerEvent) => {
      const dx = e.clientX - down.clientX
      const dy = e.clientY - down.clientY
      if (!target && Math.hypot(dx, dy) < 12) return
      const box = workspace.getBoundingClientRect()
      const x = (e.clientX - box.left) / box.width
      const y = (e.clientY - box.top) / box.height
      const gaps: [ToolDock, number][] = [['top', y], ['bottom', 1 - y], ['left', x], ['right', 1 - x]]
      target = gaps.reduce((best, g) => (g[1] < best[1] ? g : best))[0]
      belt.classList.add('moving')
      belt.style.translate = `${dx}px ${dy}px`
      dockHint.hidden = false
      dockHint.dataset.dock = target
    }
    const end = (e: PointerEvent) => {
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', end)
      grip.removeEventListener('pointercancel', end)
      belt.classList.remove('moving')
      belt.style.translate = ''
      dockHint.hidden = true
      if (target && e.type === 'pointerup') setDock(target)
      else if (!target && e.type === 'pointerup')
        openMenu(grip, DOCKS.map(([d, label]) => ({ label, icon: d === dock ? icons.check : undefined, action: () => setDock(d) })))
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', end)
    grip.addEventListener('pointercancel', end)
  })

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

  /** One of the three colours, widths or sizes kept at hand was changed: it follows on the other devices. */
  function savePresets(): void {
    void kvSet(TOOLS_KEY, { at: Date.now(), dirty: true, presets: currentPresets(tool) } satisfies SyncedTools)
    saveTool()
  }

  /** Gives the selected colour of a tool another value: the place it holds in the bar takes it. */
  function setColor(t: InkTool, c: string): void {
    const i = Math.max(0, t.colors!.indexOf(t.color))
    t.colors![i] = t.color = c
    savePresets()
  }

  function setWidth(t: InkTool, w: number): void {
    const i = Math.max(0, t.widths!.indexOf(t.width))
    t.widths![i] = t.width = w
    savePresets()
  }

  function setEraserSize(size: number): void {
    const sizes = tool.eraser.sizes!
    sizes[Math.max(0, sizes.indexOf(tool.eraser.size))] = tool.eraser.size = size
    savePresets()
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
        h('button', { type: 'button', class: `swatch ${c === current ? 'selected' : ''}`, style: `--c:${c}`, title: c, 'aria-label': `Colour ${c}`, onClick: () => pick(c) }),
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

  /** Smallest and largest width of a tool, and the step between two values. */
  const widthRange = (kind: ToolKind): [number, number, number] => (kind === 'highlighter' ? [4, 30, 1] : [0.4, kind === 'pencil' ? 6 : 5, 0.1])

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
          slider('Size', tool.eraser.size, 3, 40, 1, setEraserSize),
        ]
      }
      const t = kind === 'highlighter' ? tool.highlighter : kind === 'pencil' ? tool.pencil : tool.pen
      const hl = kind === 'highlighter'
      return [
        swatches(hl ? HL_COLORS : PEN_COLORS, t.color, (c) => {
          setColor(t, c)
          rebuild()
        }),
        slider('Width', t.width, ...widthRange(kind), (v) => setWidth(t, v)),
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
                  h('button', { type: 'button', class: 'swatch', style: `--c:${c}`, title: 'Change colour', 'aria-label': `Recolour ${c}`, onClick: () => canvas.recolorSelection(c) }),
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

  /** Changes one of the three colours: ready-made colours, or any other one. */
  function colorPanel(t: InkTool, hl: boolean): HTMLElement {
    const box = h('div', { class: 'popover preset-panel' })
    const draw = () => {
      const hex = h('input', { type: 'text', class: 'hex', value: t.color, maxLength: 7, autocomplete: 'off', spellcheck: false, 'aria-label': 'Colour code' })
      hex.addEventListener('change', () => {
        const v = hex.value.trim().toLowerCase().replace(/^#?/, '#')
        if (/^#[0-9a-f]{6}$/.test(v)) pick(v)
        else hex.value = t.color
      })
      const free = h('input', { type: 'color', class: 'swatch custom', title: 'Any colour', 'aria-label': 'Any colour', value: t.color, onInput: () => ((t.colors![Math.max(0, t.colors!.indexOf(t.color))] = t.color = free.value), (hex.value = free.value), refreshButtons()), onChange: () => pick(free.value) })
      box.replaceChildren(
        h('strong', {}, 'Colour'),
        h(
          'div',
          { class: 'palette' },
          ...(hl ? HL_PALETTE : PALETTE).map((c) => h('button', { type: 'button', class: `swatch ${c === t.color ? 'selected' : ''}`, style: `--c:${c}`, title: c, 'aria-label': `Use ${c}`, onClick: () => pick(c) })),
        ),
        h('div', { class: 'custom-row' }, h('span', { class: 'muted' }, 'Custom'), free, hex),
      )
    }
    const pick = (c: string) => {
      setColor(t, c)
      draw()
    }
    draw()
    return box
  }

  /** Changes one of the three widths (or eraser sizes), with the stroke it gives. */
  function widthPanel(kind: ToolKind): HTMLElement {
    const eraser = kind === 'eraser'
    const t = kind === 'highlighter' ? tool.highlighter : kind === 'pencil' ? tool.pencil : tool.pen
    const [min, max, step] = eraser ? [3, 40, 1] : widthRange(kind)
    const preview = h('div', { class: 'stroke-preview' })
    const show = (v: number) => {
      // Drawn at the size it has on a page seen at its real size.
      const px = v * (96 / 72)
      preview.innerHTML = eraser
        ? `<svg viewBox="0 0 220 64" aria-hidden="true"><circle cx="110" cy="32" r="${px / 2}" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`
        : `<svg viewBox="0 0 220 64" aria-hidden="true"><path d="M18 40c24-34 44-34 62-8s40 26 60-2 40-22 62 2" fill="none" stroke="${t.color}" stroke-width="${px}" stroke-linecap="${kind === 'highlighter' ? 'butt' : 'round'}" opacity="${kind === 'highlighter' ? 0.55 : 1}"/></svg>`
    }
    show(eraser ? tool.eraser.size : t.width)
    return h(
      'div',
      { class: 'popover preset-panel' },
      h('strong', {}, eraser ? 'Size' : 'Thickness'),
      preview,
      slider(eraser ? 'Size' : 'Width', eraser ? tool.eraser.size : t.width, min, max, step, (v) => {
        if (eraser) setEraserSize(v)
        else setWidth(t, v)
        show(v)
      }),
    )
  }

  /**
   * The three colours and the three widths of the current tool, always in
   * the bar. One tap selects; a tap on the one already selected changes it.
   */
  function renderQuick(): void {
    const key = JSON.stringify([tool.kind, tool.pen, tool.pencil, tool.highlighter, tool.eraser])
    if (quick.dataset.key === key) return
    quick.dataset.key = key
    if (tool.kind === 'lasso') return quick.replaceChildren()
    const preset = (cls: string, selected: boolean, label: string, select: () => void, edit: () => HTMLElement, style: string, content?: HTMLElement) =>
      h(
        'button',
        {
          type: 'button',
          class: `${cls} ${selected ? 'selected' : ''}`,
          title: label,
          'aria-label': label,
          'aria-pressed': String(selected),
          style,
          onClick: () => {
            // A tap on the one already selected opens its setting, or closes it if it is open.
            const open = document.querySelector(`.preset-panel[data-for="${cls}"]`)
            closePopovers()
            if (!selected) return select()
            if (open) return
            const panel = edit()
            panel.dataset.for = cls
            showPopover(quick, panel)
          },
        },
        content,
      )
    if (tool.kind === 'eraser') {
      quick.replaceChildren(
        ...tool.eraser.sizes!.map((s, i) =>
          preset('width', tool.eraser.size === s, `Size ${i + 1}: ${s} pt`, () => ((tool.eraser.size = s), saveTool()), () => widthPanel('eraser'), '', h('span', { class: 'ring', style: `width:${6 + s / 2}px;height:${6 + s / 2}px` })),
        ),
      )
      return
    }
    const kind = tool.kind
    const hl = kind === 'highlighter'
    const t = hl ? tool.highlighter : kind === 'pencil' ? tool.pencil : tool.pen
    quick.replaceChildren(
      ...t.colors!.map((c, i) => preset('swatch', c === t.color, `Colour ${i + 1}: ${c}`, () => ((t.color = c), saveTool()), () => colorPanel(t, hl), `--c:${c}`)),
      h('span', { class: 'sep' }),
      ...t.widths!.map((w, i) =>
        preset('width', t.width === w, `Thickness ${i + 1}: ${w} pt`, () => ((t.width = w), saveTool()), () => widthPanel(kind), '', h('span', { class: 'bar', style: `height:${Math.min(16, hl ? Math.max(3, w / 2) : Math.max(1.5, w * 2.4))}px` })),
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
