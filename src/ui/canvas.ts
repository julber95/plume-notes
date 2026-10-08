// Writing engine: page display, scrolling, zoom and stylus drawing.
//
// Two surfaces: `back` holds the pages as saved; `front` (visible) is a copy
// of `back` on which the stroke in progress is drawn. While writing, only
// the stroke in progress is recomputed on each frame.

import { backgroundSpec, type BgSpec } from '../backgrounds'
import { centerline, eraseFromStroke, isScribble, penOutline, pencilOutline, highlightRgb, scribbleTargets, strokeBBox, strokeHit, type BBox } from '../geometry'
import { GRAIN_TILE, grainSpecks, pencilAlpha, pencilLevel } from '../grain'
import { pageSize, uid, type Page, type Stroke } from '../model'
import { recognizeShape } from '../shapes'

export type ToolKind = 'pen' | 'pencil' | 'highlighter' | 'eraser' | 'line' | 'lasso'

export interface ToolState {
  kind: ToolKind
  pen: { color: string; width: number }
  /** Scribbling over existing ink with the pen erases it. */
  scribbleErase: boolean
  /** Holding the pen still at the end of a stroke turns it into a clean shape. */
  shapeHold: boolean
  pencil: { color: string; width: number }
  highlighter: { color: string; width: number }
  eraser: { mode: 'stroke' | 'partial'; size: number }
}

export interface StrokeChange {
  added: Stroke[]
  removed: Stroke[]
}

export interface InkHost {
  loadStrokes(pageId: string): Promise<Stroke[]>
  /** The user added or erased strokes. */
  onChange(change: StrokeChange): void
  onViewChange(pageIndex: number): void
  onAddPage(): void
  /**
   * Where the selection is on screen (CSS pixels, relative to the canvas), or
   * null when nothing is selected or the selection is being dragged.
   */
  onSelection(rect: { x: number; y: number; w: number; h: number } | null): void
  /** A tap with the selection tool, at this screen position. */
  onLassoTap(x: number, y: number, canPaste: boolean): void
}

interface RStroke extends Stroke {
  bbox: BBox
  path?: Path2D
  /** Pencil only: opacity step, from the pressure of the stroke. */
  level?: number
}

interface PageView {
  page: Page
  x: number
  y: number
  w: number
  h: number
  strokes: RStroke[] | null
  loading: boolean
  bg?: BgSpec
  hasPaths: boolean
  /** Image of the whole page, used while scrolling and zooming. */
  cache?: HTMLCanvasElement
  cacheScale: number
  cacheValid: boolean
}

type Action =
  | { type: 'draw'; pointerId: number; pv: PageView; kind: 'pen' | 'pencil' | 'highlighter' | 'line'; pts: number[]; tail: number[]; predicted: number[]; raw: boolean; shape: number[] | null; resize: { base: number[]; cx: number; cy: number; reach: number; active: boolean } | null; holdX: number; holdY: number; holdTimer: number }
  | { type: 'erase'; pointerId: number; lastX: number; lastY: number; removed: Map<string, Stroke>; added: Map<string, RStroke> }
  | { type: 'pan'; pointerId: number; lastX: number; lastY: number }
  | { type: 'tapAdd'; pointerId: number }
  | { type: 'lasso'; pointerId: number; pv: PageView; pts: number[]; startX: number; startY: number }
  | { type: 'transform'; pointerId: number; mode: 'move' | 'scale'; startX: number; startY: number; reach: number; moved: boolean }

const GAP = 14
const ADD_ZONE = 64
const PAPER_BG = '#e7e9ed'
const MAX_ZOOM = 8
const SELECT_COLOR = '#2b4c8c'
/** Maximum size of a page's cached image (pixels). */
const CACHE_PIXELS = 5e6
/** How long the pen must stay still at the end of a stroke to ask for a clean shape (ms). */
const HOLD_MS = 450
/** Smallest stroke (diagonal, in points; about 6 mm) that can become a shape. */
const MIN_SHAPE_SIZE = 18

/** Performance measurements, enabled by localStorage['plume.debug'] = '1'. */
const DEBUG = (() => {
  try {
    return localStorage.getItem('plume.debug') === '1'
  } catch {
    return false
  }
})()

/** Strokes copied or cut with the selection tool (kept while the application is open). */
let clipboard: Stroke[] = []

function plain(s: RStroke): Stroke {
  return { id: s.id, pageId: s.pageId, seq: s.seq, tool: s.tool, color: s.color, width: s.width, pts: s.pts }
}

function unionBox(a: BBox, b: BBox): BBox {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]
}

/** Is the point inside the polygon (flat x, y list)? */
function insidePolygon(x: number, y: number, poly: number[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i]
    const yi = poly[i + 1]
    const xj = poly[j]
    const yj = poly[j + 1]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Share of a stroke that lies inside the polygon. */
function shareInside(s: Stroke, poly: number[]): number {
  const p = s.pts
  let total = 0
  let inside = 0
  const visit = (x: number, y: number) => {
    total++
    if (insidePolygon(x, y, poly)) inside++
  }
  visit(p[0], p[1])
  for (let i = 3; i < p.length; i += 3) {
    // A straight line only stores its two ends: sample along it.
    const steps = Math.max(1, Math.ceil(Math.hypot(p[i] - p[i - 3], p[i + 1] - p[i - 2]) / 2))
    for (let k = 1; k <= steps; k++) visit(p[i - 3] + ((p[i] - p[i - 3]) * k) / steps, p[i - 2] + ((p[i + 1] - p[i - 2]) * k) / steps)
  }
  return inside / total
}

function toR(s: Stroke): RStroke {
  return { ...s, bbox: strokeBBox(s), level: s.tool === 'pencil' ? pencilLevel(s.pts) : undefined }
}

/** Rounded pen outline: curves through the midpoints of the polygon's sides. */
function roundedOutline(p: Path2D, flat: number[]): void {
  const n = flat.length / 2
  if (n < 3) return
  p.moveTo((flat[2 * n - 2] + flat[0]) / 2, (flat[2 * n - 1] + flat[1]) / 2)
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    p.quadraticCurveTo(flat[2 * i], flat[2 * i + 1], (flat[2 * i] + flat[2 * j]) / 2, (flat[2 * i + 1] + flat[2 * j + 1]) / 2)
  }
  p.closePath()
}

function strokePath(tool: Stroke['tool'], pts: ArrayLike<number>, width: number, complete: boolean): Path2D {
  const p = new Path2D()
  if (tool === 'pen' || tool === 'pencil') {
    roundedOutline(p, tool === 'pencil' ? pencilOutline(pts, width) : penOutline(pts, width, complete))
    return p
  }
  const flat = centerline(pts)
  if (flat.length < 2) return p
  p.moveTo(flat[0], flat[1])
  for (let i = 2; i < flat.length; i += 2) p.lineTo(flat[i], flat[i + 1])
  if (flat.length === 2) p.lineTo(flat[0] + 0.01, flat[1])
  return p
}

const grainCache = new Map<string, CanvasPattern>()

/** Pencil grain in the given colour, sharp at the given scale (pixels per point). */
function grainPattern(ctx: CanvasRenderingContext2D, color: string, scale: number): CanvasPattern | string {
  const size = Math.round(GRAIN_TILE * Math.max(1, Math.min(16, Math.round(scale * 2) / 2)))
  const key = `${color}@${size}`
  let pattern = grainCache.get(key)
  if (!pattern) {
    const tile = document.createElement('canvas')
    tile.width = tile.height = size
    const t = tile.getContext('2d')!
    const k = size / GRAIN_TILE
    t.fillStyle = color
    const specks = grainSpecks()
    for (let i = 0; i < specks.length; i += 4) t.fillRect(specks[i] * k, specks[i + 1] * k, specks[i + 2] * k, specks[i + 3] * k)
    const made = ctx.createPattern(tile, 'repeat')
    if (!made) return color
    // The tile always covers the same area of the page, whatever the zoom.
    made.setTransform(new DOMMatrix().scale(GRAIN_TILE / size))
    if (grainCache.size > 60) grainCache.clear()
    grainCache.set(key, made)
    pattern = made
  }
  return pattern
}

function buildPath(s: RStroke): Path2D {
  return strokePath(s.tool, s.pts, s.width, true)
}

export class InkCanvas {
  readonly front: HTMLCanvasElement
  private fctx: CanvasRenderingContext2D
  private back: HTMLCanvasElement
  private bctx: CanvasRenderingContext2D
  private dpr = 1
  private cssW = 0
  private cssH = 0

  private zoom = 1
  private tx = 0
  private ty = 0
  private autoFit = true
  private pages: PageView[] = []
  private contentW = 0
  private contentH = 0

  tool: ToolState
  private action: Action | null = null
  private frame = 0
  private sceneDirty = true
  /** Scroll or zoom in progress: cached images are displayed. */
  private moving = false
  /** Area of a page to redraw (eraser, highlighter, undo), rather than the whole screen. */
  private dirty: { pv: PageView; box: BBox } | null = null
  /** Screen area (device pixels) covered by the stroke in progress at its last drawing. */
  private liveBox: BBox | null = null
  /**
   * Strokes selected with the lasso (page coordinates): `loop` is the outline
   * drawn by hand around them, `box` the area the strokes cover and `frame`
   * the area covered by the loop and the strokes together.
   */
  private selection: { pv: PageView; ids: Set<string>; box: BBox; loop: number[]; frame: BBox } | null = null
  /** Move or resize in progress: p' = anchor + (p - anchor) * k + (dx, dy). */
  private xform: { dx: number; dy: number; k: number; ax: number; ay: number } | null = null
  /** Selected strokes while they are being dragged: drawn on top, not with the page. */
  private hidden: Set<string> | null = null
  private pasteTarget: { pv: PageView; x: number; y: number } | null = null
  private reported = ''
  /** When the stroke in progress was last drawn, and how long that took (ms). */
  private liveAt = 0
  private liveCost = 0
  private settleTimer = 0
  private idleTimer = 0
  private lastSeq = 0
  private lastPageIndex = -1

  // Palm rejection and touch gestures
  private penAt = -1e9
  private penAway = true
  private touches = new Map<number, { x: number; y: number }>()
  private gesture: { tx: number; ty: number; zoom: number; start: number; moved: number } | null = null
  private velocity = { x: 0, y: 0, t: 0 }
  private inertia = 0
  private hover: { x: number; y: number } | null = null
  private observer: ResizeObserver
  private destroyed = false

  constructor(
    private container: HTMLElement,
    private host: InkHost,
    tool: ToolState,
  ) {
    this.tool = tool
    this.front = document.createElement('canvas')
    this.front.className = 'ink'
    this.back = document.createElement('canvas')
    // `desynchronized` asks the browser for the shortest display path (lower
    // latency with a stylus), when the device allows it.
    this.fctx = this.front.getContext('2d', { alpha: false, desynchronized: true })!
    this.bctx = this.back.getContext('2d', { alpha: false })!
    container.appendChild(this.front)

    const f = this.front
    f.addEventListener('pointerdown', this.onDown)
    f.addEventListener('pointermove', this.onMove)
    // Raw stylus positions, delivered as soon as they arrive instead of once per
    // screen frame (not available in every browser).
    f.addEventListener('pointerrawupdate', this.onRaw as EventListener)
    f.addEventListener('pointerup', this.onUp)
    f.addEventListener('pointercancel', this.onCancel)
    f.addEventListener('pointerleave', this.onLeave)
    f.addEventListener('wheel', this.onWheel, { passive: false })
    f.addEventListener('contextmenu', (e) => e.preventDefault())
    // Prevents the browser from handling gestures itself (scroll, zoom).
    f.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false })

    this.observer = new ResizeObserver(() => this.resize())
    this.observer.observe(container)
    this.resize()
  }

  destroy(): void {
    this.destroyed = true
    this.observer.disconnect()
    cancelAnimationFrame(this.frame)
    cancelAnimationFrame(this.inertia)
    clearTimeout(this.settleTimer)
    clearTimeout(this.idleTimer)
    this.front.remove()
  }

  // ---------- Pages and layout ----------

  /** Replaces the list of pages (strokes already loaded are kept). */
  setPages(pages: Page[], reload = false): void {
    this.clearSelection()
    const old = new Map(this.pages.map((p) => [p.page.id, p]))
    let y = GAP
    let maxW = 0
    this.pages = pages.map((page) => {
      const { w, h } = pageSize(page.orient)
      const prev = reload ? undefined : old.get(page.id)
      const pv: PageView = {
        page,
        x: -w / 2,
        y,
        w,
        h,
        strokes: prev?.strokes ?? null,
        loading: false,
        bg: prev && prev.page.bg === page.bg && prev.w === w ? prev.bg : undefined,
        hasPaths: prev?.hasPaths ?? false,
        cache: prev?.cache,
        cacheScale: prev?.cacheScale ?? 0,
        cacheValid: !!prev?.cacheValid && prev.page.bg === page.bg && prev.w === w,
      }
      y += h + GAP
      maxW = Math.max(maxW, w)
      return pv
    })
    this.contentW = maxW
    this.contentH = y + ADD_ZONE + GAP
    if (this.autoFit && this.cssW) this.fit()
    this.clamp()
    this.invalidate()
  }

  private fitZoom(): number {
    const margin = this.cssW < 700 ? 6 : 18
    return Math.max(0.2, (this.cssW - 2 * margin) / (this.contentW || 595))
  }

  private fit(): void {
    const centerY = this.cssH ? (this.cssH / 2 - this.ty) / this.zoom : 0
    this.zoom = Math.min(this.fitZoom(), 2.4)
    this.ty = this.lastPageIndex < 0 ? 0 : this.cssH / 2 - centerY * this.zoom
  }

  private resize(): void {
    const r = this.container.getBoundingClientRect()
    if (!r.width || !r.height) return
    const first = this.cssW === 0
    this.cssW = r.width
    this.cssH = r.height
    this.dpr = Math.min(window.devicePixelRatio || 1, 3)
    for (const c of [this.front, this.back]) {
      c.width = Math.round(r.width * this.dpr)
      c.height = Math.round(r.height * this.dpr)
    }
    this.front.style.width = `${r.width}px`
    this.front.style.height = `${r.height}px`
    if (first || this.autoFit) this.fit()
    this.clamp()
    this.invalidate()
  }

  private clamp(): void {
    const m = 8
    const cw = this.contentW * this.zoom
    if (cw + 2 * m <= this.cssW) this.tx = this.cssW / 2
    else this.tx = Math.min(cw / 2 + m, Math.max(this.cssW - cw / 2 - m, this.tx))
    const ch = this.contentH * this.zoom
    if (ch <= this.cssH) this.ty = 0
    else this.ty = Math.min(0, Math.max(this.cssH - ch, this.ty))
  }

  private pageAt(wx: number, wy: number): PageView | null {
    for (const pv of this.pages) {
      if (wy < pv.y) return null
      if (wy <= pv.y + pv.h) return wx >= pv.x && wx <= pv.x + pv.w ? pv : null
    }
    return null
  }

  private inAddZone(wy: number): boolean {
    const last = this.pages[this.pages.length - 1]
    return !!last && wy > last.y + last.h + GAP / 2 && wy < last.y + last.h + GAP + ADD_ZONE
  }

  scrollToPage(index: number): void {
    const pv = this.pages[index]
    if (!pv) return
    this.ty = -(pv.y - GAP / 2) * this.zoom
    this.clamp()
    this.invalidate()
  }

  currentPageIndex(): number {
    const cy = (this.cssH / 2 - this.ty) / this.zoom
    let best = 0
    for (let i = 0; i < this.pages.length; i++) if (this.pages[i].y <= cy) best = i
    return best
  }

  /** Applies a change coming from elsewhere (undo, redo). */
  applyChange(added: Stroke[], removed: Stroke[]): void {
    this.clearSelection()
    for (const s of removed) {
      const pv = this.pages.find((p) => p.page.id === s.pageId)
      if (!pv?.strokes) continue
      pv.strokes = pv.strokes.filter((o) => o.id !== s.id)
      this.markDirty(pv, strokeBBox(s))
    }
    for (const s of added) {
      const pv = this.pages.find((p) => p.page.id === s.pageId)
      if (!pv?.strokes) continue
      const rs = toR(s)
      pv.strokes.push(rs)
      pv.strokes.sort((a, b) => a.seq - b.seq)
      this.markDirty(pv, rs.bbox)
    }
  }

  private ensureLoaded(pv: PageView): void {
    if (pv.strokes || pv.loading) return
    pv.loading = true
    this.host
      .loadStrokes(pv.page.id)
      .then((list) => {
        pv.strokes = list.map(toR)
        pv.cacheValid = false
        for (const s of list) if (s.seq > this.lastSeq) this.lastSeq = s.seq
        this.invalidate()
      })
      .catch((e) => console.error('Page load', e))
      .finally(() => (pv.loading = false))
  }

  // ---------- Rendering ----------

  private invalidate(): void {
    this.sceneDirty = true
    this.schedule()
  }

  private schedule(): void {
    if (this.frame || this.destroyed) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      const t0 = DEBUG ? performance.now() : 0
      const scene = this.sceneDirty
      if (scene) {
        this.sceneDirty = false
        this.dirty = null
        this.renderScene()
      } else if (this.dirty) {
        this.renderRegion(this.dirty.pv, this.dirty.box)
        this.dirty = null
      } else if (this.canDrawLiveOnly()) {
        // Only the stroke in progress changed: no need to repaint the screen.
        return this.drawLiveNow()
      }
      this.present()
      if (DEBUG) performance.measure(scene ? 'plume-scene' : 'plume-live', { start: t0 })
    })
  }

  private pageTransform(ctx: CanvasRenderingContext2D, pv: PageView): void {
    const s = this.zoom * this.dpr
    ctx.setTransform(s, 0, 0, s, (this.tx + pv.x * this.zoom) * this.dpr, (this.ty + pv.y * this.zoom) * this.dpr)
  }

  /** Signals that the view moved; crisp rendering returns as soon as it stops. */
  private moved(): void {
    this.moving = true
    clearTimeout(this.settleTimer)
    const settle = () => {
      // No full render in the middle of a stroke: wait until it is finished.
      if (this.action?.type === 'draw') {
        this.settleTimer = window.setTimeout(settle, 140)
        return
      }
      this.moving = false
      this.invalidate()
    }
    this.settleTimer = window.setTimeout(settle, 140)
    this.invalidate()
  }

  /** Requests a redraw of only the `box` area of the page. */
  private markDirty(pv: PageView, box: BBox): void {
    pv.cacheValid = false
    if (this.sceneDirty) return
    if (this.moving || (this.dirty && this.dirty.pv !== pv)) {
      this.sceneDirty = true
    } else if (this.dirty) {
      const d = this.dirty.box
      this.dirty.box = [Math.min(d[0], box[0]), Math.min(d[1], box[1]), Math.max(d[2], box[2]), Math.max(d[3], box[3])]
    } else {
      this.dirty = { pv, box }
    }
    this.schedule()
  }

  private renderRegion(pv: PageView, box: BBox): void {
    const ctx = this.bctx
    // The redrawn area is rounded outwards to whole screen pixels. Otherwise
    // the pixels straddling its edge get painted twice at partial strength and
    // a faint outline of the area shows through ink and highlighter.
    const s = this.zoom * this.dpr
    const ox = (this.tx + pv.x * this.zoom) * this.dpr
    const oy = (this.ty + pv.y * this.zoom) * this.dpr
    const px0 = Math.floor(Math.max(0, box[0]) * s + ox) - 2
    const py0 = Math.floor(Math.max(0, box[1]) * s + oy) - 2
    const px1 = Math.ceil(Math.min(pv.w, box[2]) * s + ox) + 2
    const py1 = Math.ceil(Math.min(pv.h, box[3]) * s + oy) + 2
    if (px1 <= px0 || py1 <= py0) return
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.beginPath()
    ctx.rect(px0, py0, px1 - px0, py1 - py0)
    ctx.clip()
    // Outside the page (its shadow and the grey around it) is repainted too.
    ctx.fillStyle = PAPER_BG
    ctx.fillRect(px0, py0, px1 - px0, py1 - py0)
    this.pageTransform(ctx, pv)
    ctx.fillStyle = 'rgba(20, 30, 50, 0.10)'
    ctx.fillRect(-0.5, 0, pv.w + 1, pv.h + 1.2)
    this.drawPage(ctx, pv, s, Infinity, [(px0 - ox) / s, (py0 - oy) / s, (px1 - ox) / s, (py1 - oy) / s])
    ctx.restore()
  }

  /**
   * Draws the content of a page (background and strokes) in page coordinates.
   * Returns false if the allotted time was not enough to prepare everything.
   */
  private drawPage(ctx: CanvasRenderingContext2D, pv: PageView, pixelScale: number, deadline: number, clip?: BBox): boolean {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, pv.w, pv.h)
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, pv.w, pv.h)
    ctx.clip()
    this.drawBackground(ctx, pv, pixelScale)
    let complete = true
    if (pv.strokes) {
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      for (const pass of [0, 1]) {
        for (const s of pv.strokes) {
          if ((s.tool === 'highlighter') !== (pass === 0)) continue
          if (this.hidden?.has(s.id)) continue
          const b = s.bbox
          if (clip && (b[2] < clip[0] || b[0] > clip[2] || b[3] < clip[1] || b[1] > clip[3])) continue
          if (!s.path) {
            if (performance.now() > deadline) {
              complete = false
              continue
            }
            s.path = buildPath(s)
            pv.hasPaths = true
          }
          this.paint(ctx, s, s.path)
        }
      }
    }
    ctx.restore()
    return complete
  }

  private cacheScaleFor(pv: PageView): number {
    return Math.min(this.zoom * this.dpr, Math.sqrt(CACHE_PIXELS / (pv.w * pv.h)))
  }

  /** Prepares the cached image of a page. Returns false if it is not ready. */
  private buildCache(pv: PageView, deadline: number): boolean {
    if (!pv.strokes) return false
    const scale = this.cacheScaleFor(pv)
    const c = (pv.cache ??= document.createElement('canvas'))
    const w = Math.round(pv.w * scale)
    const h = Math.round(pv.h * scale)
    if (c.width !== w || c.height !== h) {
      c.width = w
      c.height = h
    }
    const ctx = c.getContext('2d', { alpha: false })!
    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    pv.cacheValid = this.drawPage(ctx, pv, scale, deadline)
    pv.cacheScale = scale
    return pv.cacheValid
  }

  /** When idle: prepares the images of visible and neighbouring pages, one at a time. */
  private prepareCaches(): void {
    clearTimeout(this.idleTimer)
    this.idleTimer = window.setTimeout(() => {
      if (this.moving || this.action || this.destroyed) return
      const top = -this.ty / this.zoom
      const bottom = (this.cssH - this.ty) / this.zoom
      for (const pv of this.pages) {
        if (!pv.strokes || pv.y + pv.h < top - pv.h || pv.y > bottom + pv.h) continue
        const wanted = this.cacheScaleFor(pv)
        if (pv.cacheValid && pv.cacheScale >= wanted * 0.8 && pv.cacheScale <= wanted * 2) continue
        this.buildCache(pv, performance.now() + 14)
        return this.prepareCaches()
      }
    }, 60)
  }

  private renderScene(): void {
    const ctx = this.bctx
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = PAPER_BG
    ctx.fillRect(0, 0, this.back.width, this.back.height)
    const top = -this.ty / this.zoom
    const bottom = (this.cssH - this.ty) / this.zoom
    const left = -this.tx / this.zoom
    const right = (this.cssW - this.tx) / this.zoom
    // Outline computation is spread over several frames if a very full page
    // comes on screen, so that scrolling is never blocked.
    const deadline = performance.now() + 12
    let incomplete = false

    for (let i = 0; i < this.pages.length; i++) {
      const pv = this.pages[i]
      const visible = pv.y + pv.h >= top && pv.y <= bottom
      const near = pv.y + pv.h >= top - 2 * pv.h && pv.y <= bottom + 2 * pv.h
      if (near) this.ensureLoaded(pv)
      else {
        // Frees the memory of far-away pages.
        if (pv.hasPaths && pv.strokes) {
          for (const s of pv.strokes) s.path = undefined
          pv.hasPaths = false
        }
        pv.cache = undefined
        pv.cacheValid = false
      }
      if (!visible) continue

      this.pageTransform(ctx, pv)
      ctx.fillStyle = 'rgba(20, 30, 50, 0.10)'
      ctx.fillRect(-0.5, 0, pv.w + 1, pv.h + 1.2)
      if (this.moving && (pv.cacheValid || this.buildCache(pv, deadline))) {
        ctx.drawImage(pv.cache!, 0, 0, pv.w, pv.h)
      } else if (!this.drawPage(ctx, pv, this.zoom * this.dpr, deadline, [left - pv.x, top - pv.y, right - pv.x, bottom - pv.y])) {
        incomplete = true
      }
    }

    const last = this.pages[this.pages.length - 1]
    if (last && last.y + last.h + GAP < bottom) this.drawAddZone(ctx, last)
    if (incomplete) this.invalidate()
    else if (!this.moving) this.prepareCaches()

    const idx = this.currentPageIndex()
    if (idx !== this.lastPageIndex) {
      this.lastPageIndex = idx
      this.host.onViewChange(idx)
    }
  }

  private paint(ctx: CanvasRenderingContext2D, s: Pick<RStroke, 'tool' | 'color' | 'width' | 'level'>, path: Path2D): void {
    if (s.tool === 'pen') {
      ctx.fillStyle = s.color
      ctx.fill(path)
      return
    }
    if (s.tool === 'pencil') {
      const alpha = pencilAlpha(s.level ?? 3)
      ctx.globalAlpha = alpha.base
      ctx.fillStyle = s.color
      ctx.fill(path)
      ctx.globalAlpha = alpha.grain
      ctx.fillStyle = grainPattern(ctx, s.color, ctx.getTransform().a)
      ctx.fill(path)
      ctx.globalAlpha = 1
      return
    }
    ctx.strokeStyle = s.color
    ctx.lineWidth = s.width
    if (s.tool === 'highlighter') {
      // Opaque, keeping the darker of paper and highlight: see highlightRgb.
      const [r, g, b] = highlightRgb(s.color)
      ctx.strokeStyle = `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`
      ctx.globalCompositeOperation = 'darken'
      ctx.stroke(path)
      ctx.globalCompositeOperation = 'source-over'
    } else {
      ctx.stroke(path)
    }
  }

  private drawBackground(ctx: CanvasRenderingContext2D, pv: PageView, pixelScale: number): void {
    const spec = (pv.bg ??= backgroundSpec(pv.page.bg, pv.w, pv.h))
    ctx.lineCap = 'butt'
    for (const g of spec.lines) {
      ctx.strokeStyle = g.color
      // Never thinner than half a screen pixel, otherwise the background vanishes.
      ctx.lineWidth = Math.max(g.width, 0.6 / pixelScale)
      ctx.beginPath()
      for (let i = 0; i < g.segs.length; i += 4) {
        ctx.moveTo(g.segs[i], g.segs[i + 1])
        ctx.lineTo(g.segs[i + 2], g.segs[i + 3])
      }
      ctx.stroke()
    }
    const d = spec.dots
    if (d) {
      // A dashed line with zero-length dashes and round caps draws a row of dots.
      ctx.strokeStyle = d.color
      ctx.lineWidth = Math.max(d.radius * 2, 1.4 / pixelScale)
      ctx.lineCap = 'round'
      ctx.setLineDash([0, d.step])
      ctx.beginPath()
      for (let j = 0; j < d.ny; j++) {
        const y = d.y0 + j * d.step
        ctx.moveTo(d.x0, y)
        ctx.lineTo(d.x0 + (d.nx - 1) * d.step + 0.01, y)
      }
      ctx.stroke()
      ctx.setLineDash([])
    }
  }

  private drawAddZone(ctx: CanvasRenderingContext2D, last: PageView): void {
    const s = this.zoom * this.dpr
    ctx.setTransform(s, 0, 0, s, this.tx * this.dpr, (this.ty + (last.y + last.h + GAP) * this.zoom) * this.dpr)
    const w = Math.min(last.w, 260)
    ctx.strokeStyle = '#9aa3b2'
    ctx.lineWidth = 1 / this.zoom
    ctx.setLineDash([5 / this.zoom, 4 / this.zoom])
    ctx.beginPath()
    ctx.roundRect(-w / 2, 6, w, ADD_ZONE - 18, 8)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = '#5d6676'
    ctx.font = '500 13px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('+  Add a page', 0, 6 + (ADD_ZONE - 18) / 2)
  }

  /** Copies `back` to the screen then draws what is provisional. */
  private present(): void {
    const ctx = this.fctx
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.drawImage(this.back, 0, 0)
    const a = this.action
    this.liveBox = a?.type === 'draw' ? this.paintLive(a) : null
    const showEraser = a?.type === 'erase' || (this.tool.kind === 'eraser' && this.hover && !a)
    const at = a?.type === 'erase' ? { x: a.lastX, y: a.lastY } : this.hover
    if (showEraser && at) {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
      ctx.beginPath()
      ctx.arc(at.x * this.zoom + this.tx, at.y * this.zoom + this.ty, (this.tool.eraser.size / 2) * this.zoom, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(255, 255, 255, 0.6)'
      ctx.fill()
      ctx.strokeStyle = 'rgba(60, 70, 90, 0.7)'
      ctx.lineWidth = 1
      ctx.stroke()
    }
    this.drawSelection(ctx)
  }

  // ---------- Selection (lasso) ----------

  /** Draws the lasso being traced, the selected strokes being dragged, and the loop around the selection. */
  private drawSelection(ctx: CanvasRenderingContext2D): void {
    const a = this.action
    const dash = [5 / this.zoom, 4 / this.zoom]
    if (a?.type === 'lasso' && a.pts.length >= 4) {
      // Only the line drawn by hand: it closes by itself when the pen lifts.
      this.pageTransform(ctx, a.pv)
      ctx.beginPath()
      ctx.moveTo(a.pts[0], a.pts[1])
      for (let i = 2; i < a.pts.length; i += 2) ctx.lineTo(a.pts[i], a.pts[i + 1])
      ctx.setLineDash(dash)
      ctx.lineJoin = 'round'
      ctx.strokeStyle = SELECT_COLOR
      ctx.lineWidth = 1.4 / this.zoom
      ctx.stroke()
      ctx.setLineDash([])
    }
    const sel = this.selection
    let rect: { x: number; y: number; w: number; h: number } | null = null
    if (sel) {
      const t = this.xform ?? { dx: 0, dy: 0, k: 1, ax: 0, ay: 0 }
      const mx = (x: number) => t.ax + (x - t.ax) * t.k + t.dx
      const my = (y: number) => t.ay + (y - t.ay) * t.k + t.dy
      this.pageTransform(ctx, sel.pv)
      if (this.hidden && sel.pv.strokes) {
        // Strokes being moved or resized: the same drawing, shifted and scaled.
        ctx.save()
        ctx.beginPath()
        ctx.rect(0, 0, sel.pv.w, sel.pv.h)
        ctx.clip()
        ctx.translate(t.ax + t.dx, t.ay + t.dy)
        ctx.scale(t.k, t.k)
        ctx.translate(-t.ax, -t.ay)
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        for (const pass of [0, 1]) {
          for (const s of sel.pv.strokes) {
            if (!this.hidden.has(s.id) || (s.tool === 'highlighter') !== (pass === 0)) continue
            this.paint(ctx, s, (s.path ??= buildPath(s)))
          }
        }
        ctx.restore()
      }
      // The loop drawn by hand stays around the selection and follows it.
      ctx.beginPath()
      ctx.moveTo(mx(sel.loop[0]), my(sel.loop[1]))
      for (let i = 2; i < sel.loop.length; i += 2) ctx.lineTo(mx(sel.loop[i]), my(sel.loop[i + 1]))
      ctx.closePath()
      ctx.fillStyle = 'rgba(43, 76, 140, 0.05)'
      ctx.fill()
      ctx.setLineDash(dash)
      ctx.lineJoin = 'round'
      ctx.strokeStyle = SELECT_COLOR
      ctx.lineWidth = 1.4 / this.zoom
      ctx.stroke()
      ctx.setLineDash([])
      // Resize handle, at the bottom-right of the loop.
      const hx = mx(sel.frame[2])
      const hy = my(sel.frame[3])
      ctx.beginPath()
      ctx.arc(hx, hy, 6.5 / this.zoom, 0, Math.PI * 2)
      ctx.fillStyle = SELECT_COLOR
      ctx.fill()
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1.6 / this.zoom
      ctx.stroke()
      ctx.beginPath()
      const q = 2.6 / this.zoom
      ctx.moveTo(hx - q, hy - q)
      ctx.lineTo(hx + q, hy + q)
      ctx.stroke()
      if (!this.xform) {
        const f = sel.frame
        rect = { x: this.tx + (sel.pv.x + f[0]) * this.zoom, y: this.ty + (sel.pv.y + f[1]) * this.zoom, w: (f[2] - f[0]) * this.zoom, h: (f[3] - f[1]) * this.zoom }
      }
    }
    const key = rect ? `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.w)},${Math.round(rect.h)}` : ''
    if (key !== this.reported) {
      this.reported = key
      this.host.onSelection(rect)
    }
  }

  private lassoDown(e: PointerEvent, w: { x: number; y: number }): void {
    const sel = this.selection
    if (sel) {
      const x = w.x - sel.pv.x
      const y = w.y - sel.pv.y
      const f = sel.frame
      // The handle resizes the selection, keeping its top-left in place.
      if (Math.hypot(x - f[2], y - f[3]) <= 20 / this.zoom) {
        this.beginTransform(e, 'scale', x, y, f[0], f[1], Math.max(1, Math.hypot(x - f[0], y - f[1])))
        return
      }
      // Anywhere inside the loop (or on a selected stroke) moves it.
      if (insidePolygon(x, y, sel.loop) || (x >= sel.box[0] && x <= sel.box[2] && y >= sel.box[1] && y <= sel.box[3])) {
        this.beginTransform(e, 'move', x, y, 0, 0, 1)
        return
      }
      this.clearSelection()
    }
    const pv = this.pageAt(w.x, w.y)
    if (!pv?.strokes) return
    this.action = { type: 'lasso', pointerId: e.pointerId, pv, pts: [w.x - pv.x, w.y - pv.y], startX: e.clientX, startY: e.clientY }
  }

  private beginTransform(e: PointerEvent, mode: 'move' | 'scale', x: number, y: number, ax: number, ay: number, reach: number): void {
    const sel = this.selection!
    this.action = { type: 'transform', pointerId: e.pointerId, mode, startX: x, startY: y, reach, moved: false }
    this.xform = { dx: 0, dy: 0, k: 1, ax, ay }
    this.hidden = new Set(sel.ids)
    this.markDirty(sel.pv, sel.box)
  }

  private finishLasso(a: Extract<Action, { type: 'lasso' }>, e: PointerEvent): void {
    if (Math.hypot(e.clientX - a.startX, e.clientY - a.startY) < 8 && a.pts.length < 16) {
      // A simple tap: offer to paste here.
      const w = this.world(e)
      const r = this.front.getBoundingClientRect()
      this.pasteTarget = { pv: a.pv, x: w.x - a.pv.x, y: w.y - a.pv.y }
      this.host.onLassoTap(e.clientX - r.left, e.clientY - r.top, clipboard.length > 0)
      return
    }
    const picked = (a.pv.strokes ?? []).filter((s) => shareInside(s, a.pts) >= 0.6)
    if (picked.length) this.select(a.pv, picked, a.pts)
  }

  /**
   * Selects strokes. `loop` is the outline to show around them; without one
   * (a pasted selection), a rounded frame is used.
   */
  private select(pv: PageView, strokes: RStroke[], loop?: number[]): void {
    let box = strokes[0].bbox
    for (const s of strokes) box = unionBox(box, s.bbox)
    if (!loop) {
      const m = 5
      const r = 6
      const [x0, y0, x1, y1] = [box[0] - m, box[1] - m, box[2] + m, box[3] + m]
      loop = []
      for (const [cx, cy, from] of [[x1 - r, y0 + r, -90], [x1 - r, y1 - r, 0], [x0 + r, y1 - r, 90], [x0 + r, y0 + r, 180]]) {
        for (let i = 0; i <= 6; i++) {
          const angle = ((from + i * 15) * Math.PI) / 180
          loop.push(cx + r * Math.cos(angle), cy + r * Math.sin(angle))
        }
      }
    }
    let frame = box
    for (let i = 0; i < loop.length; i += 2) frame = unionBox(frame, [loop[i], loop[i + 1], loop[i], loop[i + 1]])
    this.selection = { pv, ids: new Set(strokes.map((s) => s.id)), box, loop, frame }
    this.schedule()
  }

  private selected(): RStroke[] {
    const sel = this.selection
    return sel?.pv.strokes?.filter((s) => sel.ids.has(s.id)) ?? []
  }

  /** Replaces each selected stroke by its modified copy, as one undoable change. */
  private replaceSelected(change: (s: RStroke) => Stroke, loop?: number[]): void {
    const sel = this.selection
    if (!sel?.pv.strokes) return
    const olds: Stroke[] = []
    const news: RStroke[] = []
    let dirty = sel.box
    sel.pv.strokes = sel.pv.strokes.map((s) => {
      if (!sel.ids.has(s.id)) return s
      const next = toR({ ...change(s), id: uid() })
      olds.push(plain(s))
      news.push(next)
      dirty = unionBox(dirty, next.bbox)
      return next
    })
    if (!news.length) return
    this.select(sel.pv, news, loop ?? sel.loop)
    this.markDirty(sel.pv, dirty)
    this.host.onChange({ added: news.map(plain), removed: olds })
  }

  private finishTransform(apply: boolean): void {
    const sel = this.selection
    const t = this.xform
    this.xform = null
    this.hidden = null
    if (!sel || !t) return
    if (!apply) return this.markDirty(sel.pv, sel.box)
    this.replaceSelected((s) => {
      const pts = Float32Array.from(s.pts)
      for (let i = 0; i < pts.length; i += 3) {
        pts[i] = t.ax + (pts[i] - t.ax) * t.k + t.dx
        pts[i + 1] = t.ay + (pts[i + 1] - t.ay) * t.k + t.dy
      }
      return { ...plain(s), width: s.width * t.k, pts }
    }, sel.loop.map((v, i) => (i % 2 === 0 ? t.ax + (v - t.ax) * t.k + t.dx : t.ay + (v - t.ay) * t.k + t.dy)))
  }

  clearSelection(): void {
    const sel = this.selection
    if (!sel) return
    this.selection = null
    if (this.hidden) {
      this.hidden = null
      this.xform = null
      this.markDirty(sel.pv, sel.box)
    }
    this.schedule()
  }

  hasSelection(): boolean {
    return !!this.selection
  }

  recolorSelection(color: string): void {
    this.replaceSelected((s) => ({ ...plain(s), color }))
  }

  deleteSelection(): void {
    const sel = this.selection
    const gone = this.selected()
    if (!sel || !gone.length) return
    sel.pv.strokes = sel.pv.strokes!.filter((s) => !sel.ids.has(s.id))
    this.selection = null
    this.markDirty(sel.pv, sel.box)
    this.host.onChange({ added: [], removed: gone.map(plain) })
  }

  copySelection(): void {
    const picked = this.selected()
    if (picked.length) clipboard = picked.map((s) => ({ ...plain(s), pts: Float32Array.from(s.pts) }))
  }

  cutSelection(): void {
    this.copySelection()
    this.deleteSelection()
  }

  /** Adds copies of `strokes` to a page, shifted by (dx, dy), and selects them. */
  private addCopies(pv: PageView, strokes: Stroke[], dx: number, dy: number, loop?: number[]): void {
    if (!pv.strokes || !strokes.length) return
    const copies = strokes.map((s) => {
      const pts = Float32Array.from(s.pts)
      for (let i = 0; i < pts.length; i += 3) {
        pts[i] += dx
        pts[i + 1] += dy
      }
      this.lastSeq = Math.max(this.lastSeq + 1, Date.now())
      return toR({ ...s, id: uid(), pageId: pv.page.id, seq: this.lastSeq, pts })
    })
    pv.strokes.push(...copies)
    this.select(pv, copies, loop)
    this.markDirty(pv, this.selection!.box)
    this.host.onChange({ added: copies.map(plain), removed: [] })
  }

  duplicateSelection(): void {
    const sel = this.selection
    if (sel) this.addCopies(sel.pv, this.selected().map(plain), 14, 14, sel.loop.map((v) => v + 14))
  }

  /** Pastes the copied strokes, centred on the last tap made with the selection tool. */
  paste(): void {
    const target = this.pasteTarget
    if (!target || !clipboard.length) return
    let box = strokeBBox(clipboard[0])
    for (const s of clipboard) box = unionBox(box, strokeBBox(s))
    this.addCopies(target.pv, clipboard, target.x - (box[0] + box[2]) / 2, target.y - (box[1] + box[3]) / 2)
  }

  /** Colour and width of the tool that draws strokes of this kind. */
  private settingsFor(kind: 'pen' | 'pencil' | 'highlighter' | 'line'): { color: string; width: number } {
    return kind === 'highlighter' ? this.tool.highlighter : kind === 'pencil' ? this.tool.pencil : this.tool.pen
  }

  /** Draws the stroke in progress on the screen; returns the area it covers (device pixels). */
  private paintLive(a: Extract<Action, { type: 'draw' }>): BBox {
    const ctx = this.fctx
    const tool = this.settingsFor(a.kind)
    const kind = a.shape ? 'line' : a.kind
    const pts = a.shape ?? (a.kind === 'line' ? a.pts.slice(0, 3).concat(a.tail) : a.pts.concat(a.tail, a.predicted))
    const path = strokePath(kind, pts, tool.width, false)
    this.pageTransform(ctx, a.pv)
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, a.pv.w, a.pv.h)
    ctx.clip()
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    this.paint(ctx, { tool: kind, color: tool.color, width: tool.width, level: kind === 'pencil' ? pencilLevel(pts) : undefined }, path)
    ctx.restore()

    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (let i = 0; i < pts.length; i += 3) {
      if (pts[i] < x0) x0 = pts[i]
      if (pts[i] > x1) x1 = pts[i]
      if (pts[i + 1] < y0) y0 = pts[i + 1]
      if (pts[i + 1] > y1) y1 = pts[i + 1]
    }
    const s = this.zoom * this.dpr
    const pad = tool.width * s + 3
    const ox = (this.tx + a.pv.x * this.zoom) * this.dpr
    const oy = (this.ty + a.pv.y * this.zoom) * this.dpr
    return [Math.floor(x0 * s + ox - pad), Math.floor(y0 * s + oy - pad), Math.ceil(x1 * s + ox + pad), Math.ceil(y1 * s + oy + pad)]
  }

  /** Can the stroke in progress be redrawn alone, without touching the rest of the screen? */
  private canDrawLiveOnly(): boolean {
    return this.action?.type === 'draw' && !this.sceneDirty && !this.dirty && !!this.liveBox
  }

  /**
   * Fast path while writing: redraws the stroke in progress immediately,
   * without waiting for the next frame. If the device cannot keep up with one
   * drawing per stylus event, falls back to one drawing per frame so that
   * work never piles up.
   */
  private drawLive(): void {
    if (!this.canDrawLiveOnly() || this.frame) return this.schedule()
    if (performance.now() - this.liveAt < Math.max(1.5, this.liveCost * 3)) return this.schedule()
    this.drawLiveNow()
  }

  /** Redraws only the small screen area covered by the stroke in progress. */
  private drawLiveNow(): void {
    const a = this.action
    if (a?.type !== 'draw' || !this.liveBox) return
    const t0 = performance.now()
    const b = this.liveBox
    const x = Math.max(0, b[0])
    const y = Math.max(0, b[1])
    const w = Math.min(this.back.width, b[2]) - x
    const h = Math.min(this.back.height, b[3]) - y
    const ctx = this.fctx
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    if (w > 0 && h > 0) ctx.drawImage(this.back, x, y, w, h, x, y, w, h)
    this.liveBox = this.paintLive(a)
    this.liveAt = performance.now()
    this.liveCost = this.liveCost * 0.7 + (this.liveAt - t0) * 0.3
    if (DEBUG) performance.measure('plume-live', { start: t0 })
  }

  private addDrawPoints(a: Extract<Action, { type: 'draw' }>, e: PointerEvent): void {
    if (a.shape) {
      // The stroke has become a shape and no longer follows the pen. A closed
      // shape can still be resized: moving away from its centre enlarges it,
      // moving towards the centre shrinks it.
      const r = a.resize
      if (r) {
        const w = this.world(e)
        // The small tremor of a pen held still must not make the shape quiver.
        if (!r.active && Math.hypot(w.x - a.holdX, w.y - a.holdY) < 6 / this.zoom) return
        r.active = true
        const k = Math.max(0.1, Math.hypot(w.x - a.pv.x - r.cx, w.y - a.pv.y - r.cy) / r.reach)
        for (let i = 0; i < r.base.length; i += 3) {
          a.shape[i] = r.cx + (r.base[i] - r.cx) * k
          a.shape[i + 1] = r.cy + (r.base[i + 1] - r.cy) * k
        }
      }
      return
    }
    const events = e.getCoalescedEvents?.() ?? []
    if (!events.length) events.push(e)
    if (a.kind === 'pen' && this.tool.shapeHold) {
      // The pen counts as still while it stays within a few screen pixels.
      const w = this.world(e)
      if (!a.holdTimer || Math.hypot(w.x - a.holdX, w.y - a.holdY) > 3 / this.zoom) {
        a.holdX = w.x
        a.holdY = w.y
        clearTimeout(a.holdTimer)
        a.holdTimer = window.setTimeout(() => this.snapToShape(a), HOLD_MS)
      }
    }
    const mouse = e.pointerType === 'mouse'
    // Keep roughly one point every 2/3 of a screen pixel: dense enough for
    // round curves, even on small letters.
    const minDist = Math.min(0.25, 0.65 / this.zoom)
    for (const ev of events) {
      const w = this.world(ev)
      const x = w.x - a.pv.x
      const y = w.y - a.pv.y
      const p = mouse ? 0.5 : ev.pressure || 0.5
      const n = a.pts.length
      if (a.kind !== 'line' && Math.hypot(x - a.pts[n - 3], y - a.pts[n - 2]) >= minDist) {
        a.pts.push(x, y, p)
        a.tail = []
      } else {
        // Too close to the last point (or straight line): just a provisional end.
        a.tail = [x, y, p]
      }
    }
  }

  /** The pen has been held still at the end of the stroke: replace it with its clean shape. */
  private snapToShape(a: Extract<Action, { type: 'draw' }>): void {
    if (this.action !== a || a.shape) return
    // Small strokes are handwriting: a pause at the end of a letter must not
    // turn it into a shape.
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (let i = 0; i < a.pts.length; i += 3) {
      x0 = Math.min(x0, a.pts[i])
      x1 = Math.max(x1, a.pts[i])
      y0 = Math.min(y0, a.pts[i + 1])
      y1 = Math.max(y1, a.pts[i + 1])
    }
    if (Math.hypot(x1 - x0, y1 - y0) < MIN_SHAPE_SIZE) return
    const shape = recognizeShape(a.pts.concat(a.tail))
    if (!shape) return
    a.shape = []
    for (let i = 0; i < shape.points.length; i += 2) a.shape.push(shape.points[i], shape.points[i + 1], 0.5)
    if (shape.kind === 'rectangle' || shape.kind === 'quad' || shape.kind === 'triangle' || shape.kind === 'ellipse') {
      // Centre of the shape, and how far from it the pen is right now.
      let sx0 = Infinity
      let sy0 = Infinity
      let sx1 = -Infinity
      let sy1 = -Infinity
      for (let i = 0; i < a.shape.length; i += 3) {
        sx0 = Math.min(sx0, a.shape[i])
        sx1 = Math.max(sx1, a.shape[i])
        sy0 = Math.min(sy0, a.shape[i + 1])
        sy1 = Math.max(sy1, a.shape[i + 1])
      }
      const cx = (sx0 + sx1) / 2
      const cy = (sy0 + sy1) / 2
      const reach = Math.hypot(a.holdX - a.pv.x - cx, a.holdY - a.pv.y - cy)
      if (reach > 4) a.resize = { base: a.shape.slice(), cx, cy, reach, active: false }
    }
    a.predicted = []
    navigator.vibrate?.(12)
    this.drawLive()
  }

  private onRaw = (e: PointerEvent): void => {
    const a = this.action
    if (a?.type !== 'draw' || a.pointerId !== e.pointerId) return
    a.raw = true
    this.addDrawPoints(a, e)
    a.predicted = []
    this.drawLive()
  }

  // ---------- Input: stylus and mouse ----------

  private world(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.front.getBoundingClientRect()
    return { x: (e.clientX - r.left - this.tx) / this.zoom, y: (e.clientY - r.top - this.ty) / this.zoom }
  }

  private onDown = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') return this.touchDown(e)
    if (e.pointerType === 'pen') {
      this.penAt = performance.now()
      this.penAway = false
    }
    if (this.action) return
    const mouse = e.pointerType === 'mouse'
    if (mouse && e.button === 1) {
      e.preventDefault()
      this.front.setPointerCapture(e.pointerId)
      this.action = { type: 'pan', pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY }
      return
    }
    // Side button or eraser end of the stylus: temporary eraser.
    const penEraser = !mouse && (e.button === 5 || e.button === 2 || (e.buttons & 34) !== 0)
    if (e.button !== 0 && !penEraser) return
    e.preventDefault()
    this.cancelTouch(true)
    this.stopInertia()
    this.front.setPointerCapture(e.pointerId)
    const w = this.world(e)
    const kind = penEraser ? 'eraser' : this.tool.kind
    if (kind === 'lasso') return this.lassoDown(e, w)
    this.clearSelection()
    if (kind === 'eraser') {
      this.action = { type: 'erase', pointerId: e.pointerId, lastX: w.x, lastY: w.y, removed: new Map(), added: new Map() }
      this.eraseAt(w.x, w.y)
      this.schedule()
      return
    }
    const pv = this.pageAt(w.x, w.y)
    if (!pv) {
      if (this.inAddZone(w.y)) this.action = { type: 'tapAdd', pointerId: e.pointerId }
      return
    }
    if (!pv.strokes) return
    const p = mouse ? 0.5 : e.pressure || 0.5
    this.action = { type: 'draw', pointerId: e.pointerId, pv, kind, pts: [w.x - pv.x, w.y - pv.y, p], tail: [], predicted: [], raw: false, shape: null, resize: null, holdX: w.x, holdY: w.y, holdTimer: 0 }
    this.schedule()
  }

  private onMove = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') return this.touchMove(e)
    if (e.pointerType === 'pen') {
      this.penAt = performance.now()
      this.penAway = false
    }
    const a = this.action
    if (!a || a.pointerId !== e.pointerId) {
      if (this.tool.kind === 'eraser') {
        this.hover = this.world(e)
        this.schedule()
      }
      return
    }
    if (a.type === 'pan') {
      this.tx += e.clientX - a.lastX
      this.ty += e.clientY - a.lastY
      a.lastX = e.clientX
      a.lastY = e.clientY
      this.clamp()
      this.moved()
      return
    }
    if (a.type === 'tapAdd') return
    if (a.type === 'lasso') {
      const w = this.world(e)
      const x = w.x - a.pv.x
      const y = w.y - a.pv.y
      const n = a.pts.length
      if (Math.hypot(x - a.pts[n - 2], y - a.pts[n - 1]) > 1.5 / this.zoom) a.pts.push(x, y)
      this.schedule()
      return
    }
    if (a.type === 'transform') {
      const sel = this.selection
      const t = this.xform
      if (!sel || !t) return
      const w = this.world(e)
      const x = w.x - sel.pv.x
      const y = w.y - sel.pv.y
      if (a.mode === 'move') {
        t.dx = x - a.startX
        t.dy = y - a.startY
      } else {
        t.k = Math.min(20, Math.max(0.05, Math.hypot(x - t.ax, y - t.ay) / a.reach))
      }
      a.moved = true
      this.schedule()
      return
    }
    const events = e.getCoalescedEvents?.() ?? []
    if (!events.length) events.push(e)
    if (a.type === 'erase') {
      for (const ev of events) {
        const w = this.world(ev)
        const step = Math.max(0.5, this.tool.eraser.size / 3)
        const n = Math.ceil(Math.hypot(w.x - a.lastX, w.y - a.lastY) / step)
        for (let k = 1; k <= n; k++) this.eraseAt(a.lastX + ((w.x - a.lastX) * k) / n, a.lastY + ((w.y - a.lastY) * k) / n)
        a.lastX = w.x
        a.lastY = w.y
      }
      this.schedule()
      return
    }
    // When raw updates are available the points were already recorded there.
    if (!a.raw) this.addDrawPoints(a, e)
    a.predicted = []
    if (a.kind !== 'line' && !a.shape) {
      const mouse = e.pointerType === 'mouse'
      for (const ev of e.getPredictedEvents?.() ?? []) {
        const w = this.world(ev)
        a.predicted.push(w.x - a.pv.x, w.y - a.pv.y, mouse ? 0.5 : ev.pressure || 0.5)
      }
    }
    this.drawLive()
  }

  private onUp = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') return this.touchUp(e, false)
    const a = this.action
    if (!a || a.pointerId !== e.pointerId) return
    this.action = null
    if (a.type === 'tapAdd') {
      if (this.inAddZone(this.world(e).y)) this.host.onAddPage()
    } else if (a.type === 'draw') {
      this.commitStroke(a)
    } else if (a.type === 'erase') {
      if (a.removed.size || a.added.size) {
        this.host.onChange({ added: [...a.added.values()].map(({ bbox: _b, path: _p, ...s }) => s), removed: [...a.removed.values()] })
      }
    } else if (a.type === 'lasso') {
      this.finishLasso(a, e)
    } else if (a.type === 'transform') {
      this.finishTransform(a.moved)
    }
    this.schedule()
  }

  private onCancel = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') return this.touchUp(e, true)
    const a = this.action
    if (!a || a.pointerId !== e.pointerId) return
    this.action = null
    if (a.type === 'transform') this.finishTransform(false)
    if (a.type === 'draw' && a.pts.length > 3) {
      // The system interrupted the gesture: keep what was written.
      this.commitStroke(a)
    } else if (a.type === 'erase' && (a.removed.size || a.added.size)) {
      this.host.onChange({ added: [...a.added.values()].map(({ bbox: _b, path: _p, ...s }) => s), removed: [...a.removed.values()] })
    }
    this.schedule()
  }

  private onLeave = (e: PointerEvent): void => {
    if (e.pointerType === 'pen') this.penAway = true
    if (e.pointerType !== 'touch' && this.hover) {
      this.hover = null
      this.schedule()
    }
  }

  private commitStroke(a: Extract<Action, { type: 'draw' }>): void {
    clearTimeout(a.holdTimer)
    if (a.shape) {
      // Shapes are stored like the straight-line tool: a constant-width outline.
      a.kind = 'line'
      a.pts = a.shape
      a.tail = []
    }
    const pts = a.kind === 'line' && !a.shape ? a.pts.slice(0, 3) : a.pts
    if (a.tail.length) pts.push(...a.tail)
    if (a.kind === 'line' && pts.length < 6) return
    const tool = this.settingsFor(a.kind)
    this.lastSeq = Math.max(this.lastSeq + 1, Date.now())
    const stroke: Stroke = { id: uid(), pageId: a.pv.page.id, seq: this.lastSeq, tool: a.kind, color: tool.color, width: tool.width, pts: Float32Array.from(pts) }
    const rs = toR(stroke)
    if ((a.kind === 'pen' || a.kind === 'pencil') && this.tool.scribbleErase && isScribble(stroke.pts)) {
      const targets = scribbleTargets(stroke, a.pv.strokes!)
      if (targets.length) {
        // A scribble over existing ink: erase what it covers, and do not keep it.
        const gone = new Set(targets.map((t) => t.id))
        a.pv.strokes = a.pv.strokes!.filter((s) => !gone.has(s.id))
        let box = rs.bbox
        for (const t of targets) box = [Math.min(box[0], t.bbox[0]), Math.min(box[1], t.bbox[1]), Math.max(box[2], t.bbox[2]), Math.max(box[3], t.bbox[3])]
        this.markDirty(a.pv, box)
        this.host.onChange({ added: [], removed: targets.map(({ bbox: _b, path: _p, ...s }) => s) })
        return
      }
    }
    a.pv.strokes!.push(rs)
    if (a.kind === 'highlighter') {
      // The highlighter goes under the ink: the touched area is redrawn.
      this.markDirty(a.pv, rs.bbox)
    } else if (!this.sceneDirty) {
      // Ink: added directly on top, without redrawing anything else.
      const ctx = this.bctx
      this.pageTransform(ctx, a.pv)
      ctx.save()
      ctx.beginPath()
      ctx.rect(0, 0, a.pv.w, a.pv.h)
      ctx.clip()
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      rs.path = buildPath(rs)
      a.pv.hasPaths = true
      this.paint(ctx, rs, rs.path)
      ctx.restore()
    }
    const cache = a.pv.cacheValid && a.kind !== 'highlighter' ? a.pv.cache?.getContext('2d', { alpha: false }) : null
    if (cache) {
      cache.setTransform(a.pv.cacheScale, 0, 0, a.pv.cacheScale, 0, 0)
      cache.lineCap = 'round'
      cache.lineJoin = 'round'
      this.paint(cache, rs, (rs.path ??= buildPath(rs)))
    } else {
      a.pv.cacheValid = false
    }
    this.host.onChange({ added: [stroke], removed: [] })
  }

  private eraseAt(wx: number, wy: number): void {
    const a = this.action
    if (a?.type !== 'erase') return
    const pv = this.pageAt(wx, wy)
    if (!pv?.strokes) return
    const x = wx - pv.x
    const y = wy - pv.y
    const r = this.tool.eraser.size / 2
    let changed: BBox | null = null
    const next: RStroke[] = []
    for (const s of pv.strokes) {
      const b = s.bbox
      if (x + r < b[0] || x - r > b[2] || y + r < b[1] || y - r > b[3]) {
        next.push(s)
        continue
      }
      let pieces: Float32Array[] | null
      if (this.tool.eraser.mode === 'stroke') pieces = strokeHit(s, x, y, r) ? [] : null
      else pieces = eraseFromStroke(s, x, y, r)
      if (!pieces) {
        next.push(s)
        continue
      }
      changed = changed ? [Math.min(changed[0], b[0]), Math.min(changed[1], b[1]), Math.max(changed[2], b[2]), Math.max(changed[3], b[3])] : [b[0], b[1], b[2], b[3]]
      // A piece created during this same gesture was never saved.
      if (!a.added.delete(s.id)) a.removed.set(s.id, { id: s.id, pageId: s.pageId, seq: s.seq, tool: s.tool, color: s.color, width: s.width, pts: s.pts })
      for (const pts of pieces) {
        const piece = toR({ id: uid(), pageId: s.pageId, seq: s.seq, tool: s.tool, color: s.color, width: s.width, pts })
        a.added.set(piece.id, piece)
        next.push(piece)
      }
    }
    if (changed) {
      pv.strokes = next
      this.markDirty(pv, changed)
    }
  }

  // ---------- Input: fingers (scroll and zoom) ----------

  private touchDown(e: PointerEvent): void {
    // Palm: stylus writing or nearby, or very wide contact.
    if (this.action) return
    if (!this.penAway && performance.now() - this.penAt < 700) return
    if (e.width > 70 || e.height > 70) return
    this.stopInertia()
    if (this.touches.size === 0) this.gesture = { tx: this.tx, ty: this.ty, zoom: this.zoom, start: performance.now(), moved: 0 }
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
    this.velocity = { x: 0, y: 0, t: performance.now() }
    try {
      this.front.setPointerCapture(e.pointerId)
    } catch {
      // pointer already released
    }
  }

  private touchMove(e: PointerEvent): void {
    const prev = this.touches.get(e.pointerId)
    if (!prev || !this.gesture) return
    const r = this.front.getBoundingClientRect()
    if (this.touches.size === 1) {
      const dx = e.clientX - prev.x
      const dy = e.clientY - prev.y
      this.tx += dx
      this.ty += dy
      this.gesture.moved += Math.abs(dx) + Math.abs(dy)
      const now = performance.now()
      const dt = Math.max(1, now - this.velocity.t)
      // Smoothed velocity, for the momentum on release.
      this.velocity = { x: 0.7 * (dx / dt) + 0.3 * this.velocity.x, y: 0.7 * (dy / dt) + 0.3 * this.velocity.y, t: now }
    } else {
      const other = [...this.touches.entries()].find(([id]) => id !== e.pointerId)![1]
      const d0 = Math.hypot(prev.x - other.x, prev.y - other.y)
      const d1 = Math.hypot(e.clientX - other.x, e.clientY - other.y)
      const mx0 = (prev.x + other.x) / 2 - r.left
      const my0 = (prev.y + other.y) / 2 - r.top
      const mx1 = (e.clientX + other.x) / 2 - r.left
      const my1 = (e.clientY + other.y) / 2 - r.top
      if (d0 > 0) this.zoomAt(mx0, my0, d1 / d0)
      this.tx += mx1 - mx0
      this.ty += my1 - my0
      this.gesture.moved += 100
    }
    prev.x = e.clientX
    prev.y = e.clientY
    this.clamp()
    this.moved()
  }

  private touchUp(e: PointerEvent, cancelled: boolean): void {
    if (!this.touches.delete(e.pointerId)) return
    const g = this.gesture
    if (this.touches.size > 0 || !g) {
      this.velocity = { x: 0, y: 0, t: performance.now() }
      return
    }
    this.gesture = null
    if (cancelled) return
    const now = performance.now()
    if (g.moved < 8 && now - g.start < 350) {
      if (this.inAddZone(this.world(e).y)) this.host.onAddPage()
      return
    }
    if (now - this.velocity.t < 80 && Math.hypot(this.velocity.x, this.velocity.y) > 0.15) this.startInertia()
  }

  /** Abandons the touch gesture in progress (the stylus just touched down). */
  private cancelTouch(restore: boolean): void {
    const g = this.gesture
    if (!g) return
    // A scroll that had only just started was caused by the palm: cancel it.
    if (restore && performance.now() - g.start < 500) {
      this.tx = g.tx
      this.ty = g.ty
      this.zoom = g.zoom
      this.sceneDirty = true
    }
    this.touches.clear()
    this.gesture = null
  }

  private startInertia(): void {
    let last = performance.now()
    const step = (now: number) => {
      const dt = Math.min(40, now - last)
      last = now
      this.tx += this.velocity.x * dt
      this.ty += this.velocity.y * dt
      const decay = Math.pow(0.996, dt)
      this.velocity.x *= decay
      this.velocity.y *= decay
      const before = this.ty
      this.clamp()
      this.moved()
      if (Math.hypot(this.velocity.x, this.velocity.y) < 0.02 || (this.ty !== before && Math.abs(this.velocity.x) < 0.02)) {
        this.inertia = 0
        return
      }
      this.inertia = requestAnimationFrame(step)
    }
    this.inertia = requestAnimationFrame(step)
  }

  private stopInertia(): void {
    cancelAnimationFrame(this.inertia)
    this.inertia = 0
  }

  private zoomAt(sx: number, sy: number, factor: number): void {
    const min = Math.min(this.fitZoom(), 1) * 0.5
    const next = Math.min(MAX_ZOOM, Math.max(min, this.zoom * factor))
    const k = next / this.zoom
    this.tx = sx - (sx - this.tx) * k
    this.ty = sy - (sy - this.ty) * k
    this.zoom = next
    this.autoFit = false
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    this.stopInertia()
    const unit = e.deltaMode === 1 ? 32 : 1
    if (e.ctrlKey || e.metaKey) {
      const r = this.front.getBoundingClientRect()
      this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * unit * 0.01))
    } else if (e.shiftKey) {
      this.tx -= e.deltaY * unit
    } else {
      this.tx -= e.deltaX * unit
      this.ty -= e.deltaY * unit
    }
    this.clamp()
    this.moved()
  }

  /** Zoom from buttons: multiplicative factor, or 'fit' to fit the width. */
  zoomBy(factor: number | 'fit'): void {
    if (factor === 'fit') {
      this.autoFit = true
      this.fit()
    } else {
      this.zoomAt(this.cssW / 2, this.cssH / 2, factor)
    }
    this.clamp()
    this.invalidate()
  }
}
