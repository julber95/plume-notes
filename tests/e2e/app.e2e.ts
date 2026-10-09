import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { build, preview, type PreviewServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { extractPlumeData } from '../../src/pdf/extract'
import { FakeDrive } from '../fakeGraph'

const OUT = new URL('./output/', import.meta.url).pathname
const DIST = new URL('../../node_modules/.plume-e2e/', import.meta.url).pathname

let server: PreviewServer
let browser: Browser
let url: string
const drive = new FakeDrive()
let logins = 0

beforeAll(async () => {
  mkdirSync(OUT, { recursive: true })
  process.env.VITE_MS_CLIENT_ID = 'test-client'
  await build({ logLevel: 'silent', build: { outDir: DIST, emptyOutDir: true } })
  server = await preview({ logLevel: 'silent', build: { outDir: DIST }, preview: { port: 4317, strictPort: false } })
  url = server.resolvedUrls!.local[0]
  browser = await chromium.launch()
})

afterAll(async () => {
  await browser?.close()
  await new Promise<void>((r) => server?.httpServer.close(() => r()))
})

/** A "device": fresh storage, touch screen, fake Microsoft services. */
async function device(width = 1280, height = 800): Promise<{ ctx: BrowserContext; page: Page; cdp: CDPSession; errors: string[] }> {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block', locale: 'en-GB' })
  await ctx.route('https://login.microsoftonline.com/**', async (route) => {
    const req = route.request()
    const u = new URL(req.url())
    if (u.pathname.endsWith('/authorize')) {
      logins++
      const back = new URL(u.searchParams.get('redirect_uri')!)
      back.searchParams.set('code', 'CODE')
      back.searchParams.set('state', u.searchParams.get('state')!)
      return route.fulfill({ status: 302, headers: { Location: back.href } })
    }
    return route.fulfill({ json: { access_token: 'TOKEN', refresh_token: 'REFRESH', expires_in: 3600 } })
  })
  const graph = async (route: import('playwright').Route) => {
    const req = route.request()
    try {
      const res = await drive.fetch(req.url(), { method: req.method(), headers: req.headers(), body: (req.headers()['content-type'] ?? '').includes('json') ? (req.postData() ?? undefined) : (req.postDataBuffer() ?? undefined) })
      await route.fulfill({ status: res.status, headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'application/octet-stream', 'Access-Control-Allow-Origin': '*' }, body: Buffer.from(await res.arrayBuffer()) })
    } catch {
      await route.abort('internetdisconnected')
    }
  }
  await ctx.route('https://graph.microsoft.com/**', graph)
  await ctx.route('https://download.example/**', graph)
  const page = await ctx.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(m.text()) && errors.push(m.text()))
  const cdp = await ctx.newCDPSession(page)
  await page.goto(url)
  return { ctx, page, cdp, errors }
}

type Pt = [number, number, number?]

/** Draws a stroke with the stylus (with pressure), as an S Pen would. */
async function pen(cdp: CDPSession, pts: Pt[], opts: { lift?: boolean } = {}): Promise<void> {
  const send = (type: string, [x, y, force = 0.5]: Pt, buttons: number) =>
    cdp.send('Input.dispatchMouseEvent', { type: type as 'mouseMoved', x, y, button: buttons || type === 'mouseReleased' ? 'left' : 'none', buttons, clickCount: 1, pointerType: 'pen', force })
  await send('mousePressed', pts[0], 1)
  for (const p of pts.slice(1)) await send('mouseMoved', p, 1)
  if (opts.lift !== false) await send('mouseReleased', pts[pts.length - 1], 0)
}

const penHover = (cdp: CDPSession, x: number, y: number) =>
  cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0, pointerType: 'pen' })

async function fingerDrag(cdp: CDPSession, from: [number, number], to: [number, number], radius = 12): Promise<void> {
  const point = (x: number, y: number) => [{ x, y, id: 1, radiusX: radius, radiusY: radius, force: 0.5 }]
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(...from) })
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(from[0] + ((to[0] - from[0]) * i) / 8, from[1] + ((to[1] - from[1]) * i) / 8) })
    await new Promise((r) => setTimeout(r, 30))
  }
  // Slow ending: no momentum, for a reproducible final position.
  await new Promise((r) => setTimeout(r, 150))
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

/** A line of dummy cursive writing. */
function scribble(x0: number, y0: number, width: number, seed = 0): Pt[] {
  const pts: Pt[] = []
  for (let i = 0; i <= width; i += 2) {
    const t = i / 9 + seed
    pts.push([x0 + i + Math.sin(t * 1.7) * 3, y0 + Math.sin(t) * 9 + Math.cos(t * 2.3) * 4, 0.25 + 0.35 * Math.abs(Math.sin(t * 0.8))])
  }
  return pts
}

const strokeCount = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open('plume')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const req = open.result.transaction('strokes').objectStore('strokes').count()
          req.onsuccess = () => {
            open.result.close()
            resolve(req.result)
          }
        }
      }),
  )

const chip = (page: Page) => page.locator('.sync-chip').getAttribute('data-state')
const shot = (page: Page, name: string) => page.screenshot({ path: `${OUT}${name}.png` })
const stage = (page: Page) => page.locator('canvas.ink').screenshot()
const settle = (page: Page, ms = 250) => page.waitForTimeout(ms)

async function remoteStrokes(path: string): Promise<number> {
  const data = await extractPlumeData(drive.find(path)!.content!)
  return data!.pages.reduce((n, p) => n + p.strokes.length, 0)
}

describe('Plume in the browser', () => {
  let tablet: Awaited<ReturnType<typeof device>>

  it('starts, signs in to OneDrive and creates the Plume folder', async () => {
    tablet = await device()
    const { page } = tablet
    await page.getByText('No notes yet').waitFor()
    expect(await chip(page)).toBe('signedOut')
    await shot(page, '01-empty-library')
    await page.locator('.sync-chip').click()
    await page.getByRole('button', { name: 'Sign in to OneDrive' }).click()
    await page.waitForFunction(() => document.querySelector('.sync-chip')?.getAttribute('data-state') === 'ok')
    expect(logins).toBe(1)
    expect(page.url()).not.toContain('code=')
    expect(drive.tree()).toEqual(['Plume/'])
  })

  it('creates a folder then a notebook, visible right away in OneDrive', async () => {
    const { page } = tablet
    await page.getByRole('button', { name: 'Folder', exact: true }).click()
    await page.getByLabel('Folder name').fill('Maths')
    await page.getByRole('button', { name: 'Create' }).click()
    await page.locator('.card.folder', { hasText: 'Maths' }).click()
    await page.locator('.crumbs .current', { hasText: 'Maths' }).waitFor()
    await page.getByRole('button', { name: 'Notebook', exact: true }).click()
    await page.getByLabel('Name', { exact: true }).fill('Calculus : chapter 1')
    await page.getByRole('radio', { name: 'Seyès' }).click()
    await shot(page, '02-new-notebook')
    await page.getByRole('button', { name: 'Create' }).click()
    await page.locator('canvas.ink').waitFor()
    await expect.poll(() => drive.tree(), { timeout: 10_000 }).toEqual(['Plume/', 'Plume/Maths/', 'Plume/Maths/Calculus - chapter 1.pdf'])
  })

  it('writes with the stylus, highlights, draws a straight line, erases, undoes and redoes', async () => {
    const { page, cdp } = tablet
    for (let l = 0; l < 4; l++) await pen(cdp, scribble(330, 150 + l * 34, 420 - l * 60, l))
    expect(await strokeCount(page)).toBe(4)

    await page.getByRole('button', { name: 'Highlighter' }).click()
    await pen(cdp, [[330, 150], [520, 152], [740, 150]])
    await page.getByRole('button', { name: 'Straight line' }).click()
    await pen(cdp, [[330, 300], [500, 330], [760, 300]])
    await settle(page)
    expect(await strokeCount(page)).toBe(6)
    await shot(page, '03-writing')

    // "Whole stroke" eraser: one pass over the 4th line removes it.
    await page.getByRole('button', { name: 'Eraser', exact: true }).click()
    await pen(cdp, [[400, 250], [400, 268]])
    await settle(page)
    expect(await strokeCount(page)).toBe(5)

    // Precise eraser: cuts the 2nd line into two pieces.
    await page.getByRole('button', { name: 'Eraser', exact: true }).click()
    await page.getByRole('button', { name: 'Precise' }).click()
    await page.keyboard.press('Escape')
    await page.locator('canvas.ink').click({ position: { x: 5, y: 5 } })
    await page.getByTitle('Eraser 6 pt').click()
    await pen(cdp, [[500, 180], [500, 200]])
    await settle(page)
    expect(await strokeCount(page)).toBe(6)

    await page.getByRole('button', { name: 'Undo' }).click()
    await settle(page)
    expect(await strokeCount(page)).toBe(5)
    await page.getByRole('button', { name: 'Undo' }).click()
    await settle(page)
    expect(await strokeCount(page)).toBe(6)
    await page.getByRole('button', { name: 'Redo' }).click()
    await settle(page)
    expect(await strokeCount(page)).toBe(5)
    await page.getByRole('button', { name: 'Pen', exact: true }).click()
  })

  it('ignores a resting palm while the stylus is there, but scrolls with a finger otherwise', async () => {
    const { page, cdp } = tablet
    await penHover(cdp, 600, 500)
    const before = await stage(page)
    await fingerDrag(cdp, [800, 600], [800, 300])
    await settle(page)
    expect((await stage(page)).equals(before)).toBe(true)

    // Palm resting in mid-stroke: the stroke continues, the page does not move.
    await pen(cdp, scribble(330, 420, 100), { lift: false })
    await fingerDrag(cdp, [900, 650], [900, 400], 45)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 430, y: 420, button: 'left', buttons: 0, pointerType: 'pen' })
    await settle(page)
    expect(await strokeCount(page)).toBe(6)
    const written = await stage(page)

    // Stylus away: the finger scrolls.
    await page.waitForTimeout(800)
    await fingerDrag(cdp, [800, 600], [800, 300])
    await settle(page)
    expect((await stage(page)).equals(written)).toBe(false)
    await shot(page, '04-after-scroll')
    await fingerDrag(cdp, [800, 300], [800, 700])
    await settle(page)
  })

  it('manages pages: add, background, duplicate, move, delete', async () => {
    const { page } = tablet
    await page.getByRole('button', { name: 'Pages' }).first().click()
    await page.getByRole('button', { name: /Add a page after/ }).click()
    await expect.poll(() => page.locator('.page-list li').count()).toBe(2)
    await page.getByLabel('Background of page 2').selectOption('dots')
    await page.locator('.page-list li').nth(0).getByRole('button', { name: 'Duplicate' }).click()
    await expect.poll(() => page.locator('.page-list li').count()).toBe(3)
    await expect.poll(() => strokeCount(page)).toBe(12)
    await page.locator('.page-list li').nth(2).getByRole('button', { name: 'Move up' }).click()
    await shot(page, '05-pages')
    await page.locator('.page-list li').nth(2).getByRole('button', { name: 'Delete' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
    await expect.poll(() => page.locator('.page-list li').count()).toBe(2)
    await expect.poll(() => strokeCount(page)).toBe(6)
    await page.locator('.pages-panel').getByRole('button', { name: 'Close' }).click()
  })

  it('sends the PDF when the notebook is closed; the PDF contains every stroke', async () => {
    const { page } = tablet
    await page.getByRole('button', { name: 'Back to library' }).click()
    await page.locator('.card.notebook').waitFor()
    await expect.poll(() => remoteStrokes('Plume/Maths/Calculus - chapter 1.pdf'), { timeout: 15_000 }).toBe(6)
    await expect.poll(() => chip(page)).toBe('ok')
    writeFileSync(`${OUT}export.pdf`, drive.find('Plume/Maths/Calculus - chapter 1.pdf')!.content!)
    const data = await extractPlumeData(drive.find('Plume/Maths/Calculus - chapter 1.pdf')!.content!)
    expect(data!.pages.map((p) => p.bg)).toEqual(['seyes', 'dots'])
    await shot(page, '06-library')
  })

  it('finds everything again after a restart, and stays usable offline', async () => {
    const { page, cdp, ctx } = tablet
    await page.reload()
    await page.locator('.card.notebook').click()
    await page.locator('canvas.ink').waitFor()
    await settle(page, 600)
    await shot(page, '07-after-restart')
    expect(await strokeCount(page)).toBe(6)

    drive.online = false
    await ctx.setOffline(true)
    await pen(cdp, scribble(330, 480, 300, 5))
    await settle(page, 1200)
    expect(await strokeCount(page)).toBe(7)
    expect(await chip(page)).toBe('offline')
    await page.reload().catch(() => {}) // offline without a service worker: the reload fails, the data stays
    drive.online = true
    await ctx.setOffline(false)
    await page.goto(url)
    await expect.poll(() => remoteStrokes('Plume/Maths/Calculus - chapter 1.pdf'), { timeout: 15_000 }).toBe(7)
  })

  it('a second device gets the same content, editable', async () => {
    const pc = await device(1600, 900)
    const { page } = pc
    await page.locator('.sync-chip').click()
    await page.getByRole('button', { name: 'Sign in to OneDrive' }).click()
    await page.locator('.card.folder', { hasText: 'Maths' }).click()
    await page.locator('.card.notebook', { hasText: '2 pages' }).click()
    await page.locator('canvas.ink').waitFor()
    await settle(page, 600)
    expect(await strokeCount(page)).toBe(7)
    await shot(page, '08-second-device')
    // With the mouse, on a PC.
    await page.mouse.move(700, 600)
    await page.mouse.down()
    await page.mouse.move(800, 640, { steps: 12 })
    await page.mouse.up()
    await page.getByRole('button', { name: 'Back to library' }).click()
    await expect.poll(() => remoteStrokes('Plume/Maths/Calculus - chapter 1.pdf'), { timeout: 15_000 }).toBe(8)
    expect(drive.tree()).toEqual(['Plume/', 'Plume/Maths/', 'Plume/Maths/Calculus - chapter 1.pdf'])
    expect(pc.errors).toEqual([])
    await pc.ctx.close()

    // Back on the tablet: the PC version arrives by itself.
    await tablet.page.reload()
    await expect.poll(() => strokeCount(tablet.page), { timeout: 15_000 }).toBe(8)
    expect(tablet.errors).toEqual([])
  })

  it('once installed, opens and works with no network at all', async () => {
    const ctx = await browser.newContext({ viewport: { width: 800, height: 1280 }, deviceScaleFactor: 2, hasTouch: true, locale: 'en-GB' })
    const page = await ctx.newPage()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(String(e)))
    await page.goto(url)
    await page.evaluate(() => navigator.serviceWorker.ready)
    await page.waitForFunction(() => !!navigator.serviceWorker.controller)
    await ctx.setOffline(true)
    await page.reload()
    await page.getByRole('button', { name: 'Notebook', exact: true }).click()
    await page.getByRole('button', { name: 'Create' }).click()
    await page.locator('canvas.ink').waitFor()
    const cdp = await ctx.newCDPSession(page)
    await settle(page) // let the freshly opened page finish loading
    await pen(cdp, scribble(150, 300, 400))
    await settle(page)
    expect(await strokeCount(page)).toBe(1)
    await shot(page, '09-offline-portrait')
    await page.reload()
    await page.locator('canvas.ink').waitFor()
    expect(await strokeCount(page)).toBe(1)
    expect(errors).toEqual([])
    await ctx.close()
  })

  it('stays usable on a phone screen', async () => {
    const phone = await device(400, 800)
    const { page } = phone
    await page.getByRole('button', { name: 'Notebook', exact: true }).click()
    await shot(page, '10-phone-dialog')
    await page.getByRole('button', { name: 'Create' }).click()
    await page.locator('canvas.ink').waitFor()
    await page.getByRole('button', { name: 'Pen', exact: true }).click()
    await shot(page, '11-phone-editor')
    // No toolbar button overflows the screen.
    const overflow = await page.evaluate(() => [...document.querySelectorAll('.toolbar > *')].filter((el) => el.getBoundingClientRect().right > innerWidth + 0.5 && getComputedStyle(el).display !== 'none').length)
    expect(overflow).toBe(0)
    await phone.ctx.close()
  })

  it('erases what a scribble covers, and only treats it as a scribble over ink', async () => {
    const tab = await device()
    const { page, cdp } = tab
    await page.getByRole('button', { name: 'Notebook', exact: true }).click()
    await page.getByRole('button', { name: 'Create' }).click()
    await page.locator('canvas.ink').waitFor()
    await settle(page)
    /** Rubbing back and forth between x0 and x1. */
    const rub = (x0: number, x1: number, y: number): Pt[] => {
      const pts: Pt[] = []
      for (let pass = 0; pass < 6; pass++) for (let i = 0; i <= 25; i++) pts.push([pass % 2 ? x1 - ((x1 - x0) * i) / 25 : x0 + ((x1 - x0) * i) / 25, y + pass * 1.5, 0.4])
      return pts
    }
    // A short "word" of three strokes, and a separate one further down.
    for (let i = 0; i < 3; i++) await pen(cdp, scribble(340 + i * 30, 200, 22, i))
    await pen(cdp, scribble(340, 400, 80))
    await settle(page)
    expect(await strokeCount(page)).toBe(4)

    await pen(cdp, rub(332, 432, 196))
    await settle(page)
    expect(await strokeCount(page)).toBe(1) // the word is gone, the scribble was not kept
    await shot(page, '12-after-scribble')

    await page.getByRole('button', { name: 'Undo' }).click()
    await settle(page)
    expect(await strokeCount(page)).toBe(4)

    // The same gesture on blank paper is ordinary ink.
    await pen(cdp, rub(700, 800, 600))
    await settle(page)
    expect(await strokeCount(page)).toBe(5)

    // Switched off in the pen settings: a scribble over ink is kept as ink.
    await page.getByRole('button', { name: 'Pen', exact: true }).click()
    await page.getByLabel('Scribble over ink to erase it').uncheck()
    await page.locator('.editor-title').click()
    await pen(cdp, rub(332, 432, 196))
    await settle(page)
    expect(await strokeCount(page)).toBe(6)
    expect(tab.errors).toEqual([])
    await tab.ctx.close()
  })

  it('turns a stroke into a clean shape when the pen is held still at the end', async () => {
    const tab = await device()
    const { page, cdp } = tab
    await page.getByRole('button', { name: 'Notebook', exact: true }).click()
    await page.getByRole('button', { name: 'Create' }).click()
    await page.locator('canvas.ink').waitFor()
    await settle(page)
    const strokes = () =>
      page.evaluate(
        () =>
          new Promise<{ tool: string; points: number; xy: number[] }[]>((resolve) => {
            const open = indexedDB.open('plume')
            open.onsuccess = () => {
              const req = open.result.transaction('strokes').objectStore('strokes').getAll()
              req.onsuccess = () => {
                open.result.close()
                const list = (req.result as { tool: string; seq: number; pts: Float32Array }[]).sort((a, b) => a.seq - b.seq)
                resolve(list.map((s) => ({ tool: s.tool, points: s.pts.length / 3, xy: Array.from(s.pts).filter((_, i) => i % 3 !== 2) })))
              }
            }
          }),
      )
    const release = (x: number, y: number) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, pointerType: 'pen' })
    const wobble = (i: number) => Math.sin(i * 1.7) * 2.5
    const along = (from: [number, number], to: [number, number], n = 30): Pt[] =>
      Array.from({ length: n + 1 }, (_, i) => [from[0] + ((to[0] - from[0]) * i) / n + wobble(i), from[1] + ((to[1] - from[1]) * i) / n + wobble(i + 3), 0.4])

    // A wobbly, nearly horizontal line, held at the end: a perfectly straight, level line.
    await pen(cdp, along([340, 200], [640, 206]), { lift: false })
    await page.waitForTimeout(700)
    await shot(page, '13-shape-held')
    await release(640, 206)
    // The same line without holding: ordinary handwriting.
    await pen(cdp, along([340, 300], [640, 306]))
    // A rough rectangle, held at the end.
    await pen(cdp, [...along([340, 400], [600, 404]), ...along([600, 404], [598, 540]), ...along([598, 540], [338, 536]), ...along([338, 536], [341, 402])], { lift: false })
    await page.waitForTimeout(700)
    await release(341, 402)
    // A smaller rectangle, held, then enlarged by moving the pen away from its centre before lifting.
    await pen(cdp, [...along([700, 150], [860, 152], 20), ...along([860, 152], [858, 250], 14), ...along([858, 250], [699, 248], 20), ...along([699, 248], [700, 151], 14)], { lift: false })
    await page.waitForTimeout(700)
    for (let i = 1; i <= 10; i++) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700 - 9.4 * i, y: 150 - 6 * i, button: 'left', buttons: 1, pointerType: 'pen', force: 0.4 })
    await release(606, 90)
    await settle(page)
    await shot(page, '14-shapes')

    const [line, free, rect, big] = await strokes()
    expect([line.tool, line.points]).toEqual(['line', 2])
    expect(line.xy[1]).toBe(line.xy[3]) // level
    expect(free.tool).toBe('pen')
    expect(free.points).toBeGreaterThan(20)
    expect([rect.tool, rect.points]).toEqual(['line', 5])
    expect([rect.xy[1], rect.xy[2]]).toEqual([rect.xy[3], rect.xy[4]]) // top side level, right side upright
    // Drawn 160 px wide against 260 px, then enlarged about 2.2 times: it ends up the wider of the two.
    expect([big.tool, big.points]).toEqual(['line', 5])
    const ratio = (big.xy[2] - big.xy[0]) / (rect.xy[2] - rect.xy[0])
    expect(ratio).toBeGreaterThan(1.2)
    expect(ratio).toBeLessThan(1.5)
    expect(big.xy[1]).toBe(big.xy[3]) // still a clean rectangle
    // Its centre has not moved.
    expect(Math.abs((big.xy[0] + big.xy[2]) / 2 - ((rect.xy[0] + rect.xy[2]) / 2) * (780 / 470))).toBeLessThan(8)

    // The precise eraser cuts a shape without flattening what remains.
    await page.getByRole('button', { name: 'Eraser', exact: true }).click()
    await page.getByRole('button', { name: 'Eraser', exact: true }).click()
    await page.getByRole('button', { name: 'Precise' }).click()
    await page.locator('.editor-title').click()
    await pen(cdp, [[470, 390], [470, 415]])
    await settle(page)
    const after = await strokes()
    expect(after.length).toBe(5)
    expect(after.filter((s) => s.tool === 'line' && s.points > 2).length).toBeGreaterThan(0)
    expect(tab.errors).toEqual([])
    await tab.ctx.close()
  })

  it('has a pencil with a graphite look, kept in the PDF', async () => {
    const tab = await device()
    const { page, cdp } = tab
    await page.getByRole('button', { name: 'Notebook', exact: true }).click()
    await page.getByRole('radio', { name: 'Blank' }).click()
    await page.getByRole('button', { name: 'Create' }).click()
    await page.locator('canvas.ink').waitFor()
    await settle(page)
    for (let l = 0; l < 2; l++) await pen(cdp, scribble(340, 200 + l * 40, 300, l)) // pen, for comparison
    await page.getByRole('button', { name: 'Pencil', exact: true }).click()
    for (let l = 0; l < 2; l++) await pen(cdp, scribble(340, 300 + l * 40, 300, l + 2))
    await page.getByTitle('2.4 pt').click()
    await pen(cdp, scribble(340, 400, 300, 5))
    await settle(page)
    await page.screenshot({ path: `${OUT}15-pencil.png`, clip: { x: 320, y: 170, width: 360, height: 260 } })
    const tools = await page.evaluate(
      () =>
        new Promise<string[]>((resolve) => {
          const open = indexedDB.open('plume')
          open.onsuccess = () => {
            const req = open.result.transaction('strokes').objectStore('strokes').getAll()
            req.onsuccess = () => (open.result.close(), resolve((req.result as { tool: string; seq: number }[]).sort((a, b) => a.seq - b.seq).map((s) => s.tool)))
          }
        }),
    )
    expect(tools).toEqual(['pen', 'pen', 'pencil', 'pencil', 'pencil'])
    expect(tab.errors).toEqual([])
    await tab.ctx.close()
  })

  it('selects with a lasso, then recolours, duplicates, deletes, moves, copies, pastes and resizes', async () => {
    const tab = await device()
    const { page, cdp } = tab
    await page.getByRole('button', { name: 'Notebook', exact: true }).click()
    await page.getByRole('button', { name: 'Create' }).click()
    await page.locator('canvas.ink').waitFor()
    await settle(page)
    const all = () =>
      page.evaluate(
        () =>
          new Promise<{ color: string; width: number; x0: number; y0: number; x1: number; y1: number }[]>((resolve) => {
            const open = indexedDB.open('plume')
            open.onsuccess = () => {
              const req = open.result.transaction('strokes').objectStore('strokes').getAll()
              req.onsuccess = () => {
                open.result.close()
                resolve(
                  (req.result as { color: string; width: number; seq: number; pts: Float32Array }[])
                    .sort((a, b) => a.seq - b.seq)
                    .map((s) => {
                      const xs = Array.from(s.pts).filter((_, i) => i % 3 === 0)
                      const ys = Array.from(s.pts).filter((_, i) => i % 3 === 1)
                      return { color: s.color, width: s.width, x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
                    }),
                )
              }
            }
          }),
      )
    /** Traces a closed loop around a screen rectangle with the pen. */
    const loop = (x0: number, y0: number, x1: number, y1: number): Pt[] => {
      const pts: Pt[] = []
      const side = (ax: number, ay: number, bx: number, by: number) => {
        for (let i = 0; i < 12; i++) pts.push([ax + ((bx - ax) * i) / 12, ay + ((by - ay) * i) / 12, 0.4])
      }
      side(x0, y0, x1, y0)
      side(x1, y0, x1, y1)
      side(x1, y1, x0, y1)
      side(x0, y1, x0, y0)
      return pts
    }
    const drag = (from: [number, number], to: [number, number]): Pt[] => Array.from({ length: 11 }, (_, i) => [from[0] + ((to[0] - from[0]) * i) / 10, from[1] + ((to[1] - from[1]) * i) / 10, 0.4])
    // Page coordinates (points) to screen pixels, for this window size.
    const zoom = (1280 - 36) / 595.28
    const sx = (x: number) => 640 - (595.28 / 2) * zoom + x * zoom
    const sy = (y: number) => 48 + 14 * zoom + y * zoom

    for (let i = 0; i < 3; i++) await pen(cdp, scribble(340 + i * 30, 200, 22, i)) // a "word"
    await pen(cdp, scribble(340, 400, 80)) // something else, further down
    await settle(page)
    const before = await all()

    await page.getByRole('button', { name: 'Select', exact: true }).click()
    await pen(cdp, loop(322, 172, 450, 228))
    await page.locator('.sel-bar').waitFor()
    await shot(page, '16-selection')

    await page.getByRole('button', { name: 'Recolour #c62828' }).click()
    await settle(page)
    expect((await all()).map((s) => s.color)).toEqual(['#c62828', '#c62828', '#c62828', '#1a1a1a'])

    await page.getByRole('button', { name: 'Duplicate' }).click()
    await settle(page)
    expect((await all()).length).toBe(7)
    await page.getByRole('button', { name: 'Delete' }).click() // the copies are what is selected now
    await settle(page)
    expect((await all()).length).toBe(4)
    await expect.poll(() => page.locator('.sel-bar').isHidden()).toBe(true)

    // Select the word again and drag it 100 px right and 60 px down.
    await pen(cdp, loop(322, 172, 450, 228))
    await page.locator('.sel-bar').waitFor()
    await pen(cdp, drag([385, 200], [485, 260]))
    await settle(page)
    const moved = await all()
    expect(moved[0].x0 - before[0].x0).toBeCloseTo(100 / zoom, 0)
    expect(moved[0].y0 - before[0].y0).toBeCloseTo(60 / zoom, 0)
    expect(moved[3].x0).toBeCloseTo(before[3].x0, 3) // the other stroke did not move

    // Copy, tap elsewhere, paste.
    await page.keyboard.press('Control+c')
    await pen(cdp, [[900, 600], [900, 600]])
    await page.getByRole('button', { name: 'Paste' }).click()
    await settle(page)
    const pasted = await all()
    expect(pasted.length).toBe(7)
    const copy = pasted.slice(4)
    expect(copy.map((s) => s.color)).toEqual(['#c62828', '#c62828', '#c62828'])
    const centre = (Math.min(...copy.map((s) => s.x0)) + Math.max(...copy.map((s) => s.x1))) / 2
    expect(sx(centre)).toBeGreaterThan(880)
    expect(sx(centre)).toBeLessThan(920)

    // Resize the pasted copy with the handle at the bottom-right of its outline, to one and a half times its size.
    const w = copy[0].width
    const margin = 5 // the outline of a pasted selection sits 5 pt around the strokes
    const left = Math.min(...copy.map((s) => s.x0)) - w - margin
    const top = Math.min(...copy.map((s) => s.y0)) - w - margin
    const right = Math.max(...copy.map((s) => s.x1)) + w + margin
    const bottom = Math.max(...copy.map((s) => s.y1)) + w + margin
    await pen(cdp, drag([sx(right), sy(bottom)], [sx(left + (right - left) * 1.5), sy(top + (bottom - top) * 1.5)]))
    await settle(page)
    await shot(page, '17-selection-resized')
    const resized = (await all()).slice(4)
    expect(resized[0].width / w).toBeGreaterThan(1.4)
    expect(resized[0].width / w).toBeLessThan(1.6)
    // The top-left of the outline stayed put.
    expect(Math.min(...resized.map((s) => s.x0)) - resized[0].width).toBeCloseTo(left + margin * (resized[0].width / w), 0)

    // Undo brings back the previous size.
    await page.getByRole('button', { name: 'Undo' }).click()
    await settle(page)
    expect((await all()).slice(4)[0].width).toBeCloseTo(w, 5)
    expect(tab.errors).toEqual([])
    await tab.ctx.close()
  })

  it('places a picture on the page, movable and resizable, kept in the PDF and on other devices', async () => {
    const tab = await device()
    const { page, cdp } = tab
    await page.locator('.sync-chip').click()
    await page.getByRole('button', { name: 'Sign in to OneDrive' }).click()
    await page.waitForFunction(() => document.querySelector('.sync-chip')?.getAttribute('data-state') === 'ok')
    await page.getByRole('button', { name: 'Notebook', exact: true }).click()
    await page.getByLabel('Name', { exact: true }).fill('Pictures')
    await page.getByRole('button', { name: 'Create' }).click()
    await page.locator('canvas.ink').waitFor()
    await settle(page)

    // A test picture, made in the browser: a photo-like gradient with a shape on it.
    const jpeg = await page.evaluate(() => {
      const c = document.createElement('canvas')
      c.width = 800
      c.height = 500
      const g = c.getContext('2d')!
      const grad = g.createLinearGradient(0, 0, 800, 500)
      grad.addColorStop(0, '#2b4c8c')
      grad.addColorStop(1, '#f0b429')
      g.fillStyle = grad
      g.fillRect(0, 0, 800, 500)
      g.fillStyle = '#ffffff'
      g.beginPath()
      g.arc(400, 250, 120, 0, 7)
      g.fill()
      return c.toDataURL('image/jpeg', 0.9).split(',')[1]
    })
    writeFileSync(`${OUT}test-picture.jpg`, Buffer.from(jpeg, 'base64'))
    await page.locator('input[type=file]').setInputFiles(`${OUT}test-picture.jpg`)
    await page.locator('.sel-bar').waitFor()

    const elements = (p: Page) =>
      p.evaluate(
        () =>
          new Promise<{ tool: string; bytes: number; box: number[] }[]>((resolve) => {
            const open = indexedDB.open('plume')
            open.onsuccess = () => {
              const tx = open.result.transaction(['nodes', 'strokes'])
              const nodes = tx.objectStore('nodes').getAll()
              const req = tx.objectStore('strokes').getAll()
              req.onsuccess = () => {
                open.result.close()
                // Only this notebook: the device also holds the ones synced from OneDrive.
                const pages = new Set((nodes.result as { name: string; pageIds?: string[] }[]).find((n) => n.name === 'Pictures')?.pageIds)
                const list = (req.result as { tool: string; seq: number; pageId: string; pts: Float32Array; image?: { data: Uint8Array } }[]).filter((s) => pages.has(s.pageId)).sort((a, b) => a.seq - b.seq)
                resolve(list.map((s) => ({ tool: s.tool, bytes: s.image?.data.length ?? 0, box: s.tool === 'image' ? [s.pts[0], s.pts[1], s.pts[3], s.pts[4]] : [] })))
              }
            }
          }),
      )
    const zoom = (1280 - 36) / 595.28
    const sx = (x: number) => 640 - (595.28 / 2) * zoom + x * zoom
    const sy = (y: number) => 48 + 14 * zoom + y * zoom
    const drag = (from: [number, number], to: [number, number]): Pt[] => Array.from({ length: 11 }, (_, i) => [from[0] + ((to[0] - from[0]) * i) / 10, from[1] + ((to[1] - from[1]) * i) / 10, 0.4])

    const [placed] = await elements(page)
    expect(placed.tool).toBe('image')
    expect(placed.bytes).toBeGreaterThan(2000)
    const ratio = (b: number[]) => (b[2] - b[0]) / (b[3] - b[1])
    expect(ratio(placed.box)).toBeCloseTo(800 / 500, 2)
    await shot(page, '18-picture-placed')

    // Move it by dragging its middle, then shrink it with the handle.
    const [x0, y0, x1, y1] = placed.box
    await pen(cdp, drag([sx((x0 + x1) / 2), sy((y0 + y1) / 2)], [sx((x0 + x1) / 2) + 80, sy((y0 + y1) / 2) + 40]))
    await settle(page)
    const [moved] = await elements(page)
    expect(moved.box[0] - x0).toBeCloseTo(80 / zoom, 0)
    const m = 5
    const [a0, b0, a1, b1] = [moved.box[0] - m, moved.box[1] - m, moved.box[2] + m, moved.box[3] + m]
    await pen(cdp, drag([sx(a1), sy(b1)], [sx(a0 + (a1 - a0) * 0.6), sy(b0 + (b1 - b0) * 0.6)]))
    await settle(page)
    const [small] = await elements(page)
    expect((small.box[2] - small.box[0]) / (moved.box[2] - moved.box[0])).toBeCloseTo(0.6, 1)
    expect(ratio(small.box)).toBeCloseTo(800 / 500, 2) // proportions kept

    // Write over the picture: ink goes on top, and the eraser leaves the picture alone.
    await page.getByRole('button', { name: 'Pen', exact: true }).click()
    await pen(cdp, scribble(sx(small.box[0]) + 10, sy((small.box[1] + small.box[3]) / 2), 120))
    await page.getByRole('button', { name: 'Eraser', exact: true }).click()
    await pen(cdp, [[sx(small.box[0]) + 5, sy(small.box[1]) + 5], [sx(small.box[0]) + 30, sy(small.box[1]) + 8]])
    await settle(page)
    expect((await elements(page)).map((e) => e.tool)).toEqual(['image', 'pen'])
    await shot(page, '19-picture-annotated')

    // In the PDF: the picture is there, and comes back as an editable element.
    await page.getByRole('button', { name: 'Back to library' }).click()
    await expect.poll(() => drive.find('Plume/Pictures.pdf')?.content?.length ?? 0, { timeout: 15_000 }).toBeGreaterThan(5000)
    await expect.poll(async () => (await extractPlumeData(drive.find('Plume/Pictures.pdf')!.content!))!.pages[0].strokes.length, { timeout: 15_000 }).toBe(2)
    writeFileSync(`${OUT}pictures.pdf`, drive.find('Plume/Pictures.pdf')!.content!)
    const data = await extractPlumeData(drive.find('Plume/Pictures.pdf')!.content!)
    const kept = data!.pages[0].strokes[0]
    expect(kept.tool).toBe('image')
    expect(kept.image!.data.length).toBe(placed.bytes)
    expect(tab.errors).toEqual([])
    await tab.ctx.close()

    const pc = await device(1600, 900)
    await pc.page.locator('.sync-chip').click()
    await pc.page.getByRole('button', { name: 'Sign in to OneDrive' }).click()
    // Wait until the notebook has been downloaded (its card then shows its page count).
    await pc.page.locator('.card.notebook', { hasText: 'Pictures' }).filter({ hasText: '1 page' }).click()
    await pc.page.locator('canvas.ink').waitFor()
    await settle(pc.page, 800)
    const there = await elements(pc.page)
    expect(there.filter((e) => e.tool === 'image').map((e) => e.bytes)).toEqual([placed.bytes])
    await shot(pc.page, '20-picture-other-device')
    expect(pc.errors).toEqual([])
    await pc.ctx.close()
  })

  it('shows page previews on the left to move around the notebook', async () => {
    const tab = await device()
    const { page, cdp } = tab
    await page.getByRole('button', { name: 'Notebook', exact: true }).click()
    await page.getByRole('button', { name: 'Create' }).click()
    await page.locator('canvas.ink').waitFor()
    await settle(page)
    for (let l = 0; l < 3; l++) await pen(cdp, scribble(340, 200 + l * 40, 300, l))
    // Three more pages, with something written on the last one.
    await page.getByRole('button', { name: 'Pages' }).first().click()
    for (let i = 0; i < 3; i++) await page.getByRole('button', { name: /Add a page after/ }).click()
    await page.locator('.pages-panel').getByRole('button', { name: 'Close' }).click()
    await expect.poll(() => page.locator('.page-pill').last().textContent()).toBe('4 / 4')
    await pen(cdp, scribble(340, 300, 200, 7))
    await settle(page)

    const canvasWidth = async () => (await page.locator('canvas.ink').boundingBox())!.width
    const full = await canvasWidth()
    await page.getByRole('button', { name: 'Page previews' }).click()
    await expect.poll(() => page.locator('.thumb').count()).toBe(4)
    await expect.poll(() => page.locator('.thumb canvas').count(), { timeout: 10_000 }).toBe(4)
    expect(await canvasWidth()).toBeLessThan(full - 100) // the page makes room for the panel
    await expect.poll(() => page.locator('.thumb.current .thumb-number').textContent()).toBe('4')
    await shot(page, '21-page-previews')

    // The previews show what is written: page 1 has ink, page 2 is blank.
    const inked = (index: number) =>
      page.evaluate((i) => {
        const c = document.querySelectorAll<HTMLCanvasElement>('.thumb canvas')[i]
        const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
        let dark = 0
        for (let k = 0; k < d.length; k += 4) if (d[k] < 110 && d[k + 1] < 110 && d[k + 2] < 110) dark++
        return dark
      }, index)
    expect(await inked(0)).toBeGreaterThan(40)
    expect(await inked(1)).toBe(0)

    // A tap on a preview goes to that page.
    await page.getByRole('button', { name: 'Go to page 1' }).click()
    await expect.poll(() => page.locator('.page-pill').last().textContent()).toBe('1 / 4')
    await expect.poll(() => page.locator('.thumb.current .thumb-number').textContent()).toBe('1')

    // Writing on a page updates its preview.
    await page.getByRole('button', { name: 'Go to page 2' }).click()
    await settle(page, 400)
    const box = (await page.locator('canvas.ink').boundingBox())!
    await pen(cdp, scribble(box.x + 200, box.y + 250, 300, 3))
    await expect.poll(() => inked(1), { timeout: 10_000 }).toBeGreaterThan(20)

    // A bookmark on page 2, listed at the top of the panel.
    await page.getByRole('button', { name: 'Actions for page 2' }).click()
    await page.getByRole('menuitem', { name: 'Add a bookmark' }).click()
    await page.getByLabel('Name of the bookmark').fill('Theorem 2')
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await expect.poll(() => page.locator('.bookmark-go .bookmark-name').allTextContents()).toEqual(['Theorem 2'])
    await page.getByRole('button', { name: 'Go to page 4' }).click()
    await expect.poll(() => page.locator('.page-pill').last().textContent()).toBe('4 / 4')
    await page.locator('.bookmark-go').click()
    await expect.poll(() => page.locator('.page-pill').last().textContent()).toBe('2 / 4')

    // Drag the last page to the top with its handle: it becomes page 1, the bookmark follows its page to 3.
    await page.locator('.thumb-grip').nth(3).scrollIntoViewIfNeeded()
    const grip = (await page.locator('.thumb-grip').nth(3).boundingBox())!
    const first = (await page.locator('.thumb').first().boundingBox())!
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
    await page.mouse.down()
    await page.mouse.move(grip.x + grip.width / 2, first.y + 60, { steps: 8 })
    await page.mouse.move(grip.x + grip.width / 2, first.y + 5, { steps: 4 })
    await shot(page, '26-page-drag')
    await page.mouse.up()
    await expect.poll(() => page.locator('.bookmark-go .muted').textContent()).toBe('3')
    await expect.poll(() => page.locator('.thumb.bookmarked .thumb-number').textContent()).toBe('3')
    await expect.poll(() => inked(0), { timeout: 10_000 }).toBeGreaterThan(5) // the page that had ink on page 4

    // The panel stays open the next time, and can be closed.
    await page.reload()
    await page.locator('.thumb').first().waitFor()
    await page.getByRole('button', { name: 'Page previews' }).click()
    await expect.poll(() => page.locator('.thumbs').isHidden()).toBe(true)
    expect(tab.errors).toEqual([])
    await tab.ctx.close()
  })

  it('imports a PDF to write on it, and a picture as a notebook', async () => {
    // A two-page handout with text, as a teacher would give it.
    const source = await PDFDocument.create()
    const font = await source.embedFont(StandardFonts.HelveticaBold)
    for (const title of ['Chapter 1: limits', 'Exercises']) {
      const p = source.addPage([595.28, 841.89])
      p.drawText(title, { x: 60, y: 740, size: 34, font })
      p.drawText('The quick brown fox jumps over the lazy dog.', { x: 60, y: 690, size: 14, font })
    }
    const sourceBytes = await source.save()
    writeFileSync(`${OUT}handout.pdf`, sourceBytes)

    const tab = await device()
    const { page, cdp } = tab
    await page.locator('.sync-chip').click()
    await page.getByRole('button', { name: 'Sign in to OneDrive' }).click()
    await page.waitForFunction(() => document.querySelector('.sync-chip')?.getAttribute('data-state') === 'ok')
    await page.locator('.lib-actions input[type=file]').setInputFiles(`${OUT}handout.pdf`)
    await page.locator('canvas.ink').waitFor()
    await expect.poll(() => page.locator('.page-pill').last().textContent()).toBe('1 / 2')
    await expect.poll(() => page.locator('.editor-title').textContent()).toBe('handout')

    // The page of the PDF is displayed: dark pixels where its title is.
    const titleInk = () =>
      page.evaluate(() => {
        const c = document.querySelector<HTMLCanvasElement>('canvas.ink')!
        const d = c.getContext('2d')!.getImageData(250, 320, 850, 140).data
        let dark = 0
        for (let k = 0; k < d.length; k += 4) if (d[k] < 80 && d[k + 1] < 80 && d[k + 2] < 80) dark++
        return dark
      })
    await expect.poll(titleInk, { timeout: 20_000 }).toBeGreaterThan(2000)

    // Annotate: highlight the title, write under it.
    await page.getByRole('button', { name: 'Highlighter' }).click()
    await pen(cdp, [[150, 265], [300, 266], [520, 265]])
    await page.getByRole('button', { name: 'Pen', exact: true }).click()
    await pen(cdp, scribble(150, 420, 300, 2))
    await settle(page, 500)
    await shot(page, '22-pdf-annotated')

    await page.getByRole('button', { name: 'Back to library' }).click()
    await expect.poll(() => drive.find('Plume/handout.pdf')?.content?.length ?? 0, { timeout: 20_000 }).toBeGreaterThan(1000)
    await expect.poll(async () => (await extractPlumeData(drive.find('Plume/handout.pdf')!.content!))?.pages[0].strokes.length, { timeout: 20_000 }).toBe(2)
    const exported = drive.find('Plume/handout.pdf')!.content!
    writeFileSync(`${OUT}handout-annotated.pdf`, exported)
    const back = (await extractPlumeData(exported))!
    expect(back.pages.map((p) => [!!p.pdf, p.strokes.length])).toEqual([[true, 2], [true, 0]])
    expect((await PDFDocument.load(exported)).getPageCount()).toBe(2)
    expect((await PDFDocument.load(back.asset!)).getPageCount()).toBe(2)

    // A picture imported as a file becomes a notebook of its own.
    await page.locator('.lib-actions input[type=file]').setInputFiles(`${OUT}test-picture.jpg`)
    await page.locator('canvas.ink').waitFor()
    await expect.poll(() => page.locator('.editor-title').textContent()).toBe('test-picture')
    await expect.poll(() => page.locator('.page-pill').last().textContent()).toBe('1 / 1')
    await settle(page, 500)
    await shot(page, '23-picture-as-notebook')
    await page.getByRole('button', { name: 'Back to library' }).click()
    await expect.poll(() => drive.find('Plume/test-picture.pdf')?.content?.length ?? 0, { timeout: 20_000 }).toBeGreaterThan(1000)
    expect(tab.errors).toEqual([])
    await tab.ctx.close()

    // Elsewhere: the annotated PDF opens with its pages and its notes.
    const pc = await device(1600, 900)
    await pc.page.locator('.sync-chip').click()
    await pc.page.getByRole('button', { name: 'Sign in to OneDrive' }).click()
    await pc.page.locator('.card.notebook', { hasText: 'handout' }).filter({ hasText: '2 pages' }).click()
    await pc.page.locator('canvas.ink').waitFor()
    await settle(pc.page, 1500)
    await shot(pc.page, '24-pdf-other-device')
    expect(pc.errors).toEqual([])
    await pc.ctx.close()
  })

  it('finds notes by name, and keeps favourites and recent notebooks at hand', async () => {
    const tab = await device()
    const { page } = tab
    const make = async (name: string) => {
      await page.getByRole('button', { name: 'Notebook', exact: true }).click()
      await page.getByLabel('Name', { exact: true }).fill(name)
      await page.getByRole('button', { name: 'Create' }).click()
      await page.locator('canvas.ink').waitFor()
      await page.getByRole('button', { name: 'Back to library' }).click()
      await page.locator('.lib-actions').waitFor()
    }
    await page.getByRole('button', { name: 'Folder', exact: true }).click()
    await page.getByLabel('Folder name').fill('Physics')
    await page.getByRole('button', { name: 'Create' }).click()
    await page.locator('.card.folder', { hasText: 'Physics' }).click()
    await page.locator('.crumbs .current', { hasText: 'Physics' }).waitFor()
    await make('Optics lecture 3')
    await page.locator('.crumbs button', { hasText: 'Plume' }).click()
    await page.locator('.crumbs .current', { hasText: 'Plume' }).waitFor()
    await make('Algebra homework')
    await make('Optics summary')

    // Recent: the notebooks just opened, most recent first, with where they are.
    const section = (title: string) => page.locator('.lib-section', { hasText: title }).locator('+ .grid .card-name')
    await expect.poll(() => section('Recent').allTextContents()).toEqual(['Optics summary', 'Algebra homework', 'Optics lecture 3'])
    expect(await page.locator('.lib-section', { hasText: 'Recent' }).locator('+ .grid .card-sub').last().textContent()).toContain('Plume › Physics')

    // Search looks everywhere, folders included.
    await page.getByLabel('Search by name').fill('optics')
    await expect.poll(() => page.locator('.listing .card-name').allTextContents()).toEqual(['Optics lecture 3', 'Optics summary'])
    await page.getByLabel('Search by name').fill('phys')
    await expect.poll(() => page.locator('.listing .card-name').allTextContents()).toEqual(['Physics'])
    await page.getByLabel('Search by name').fill('zzz')
    await page.getByText('Nothing is named "zzz".').waitFor()
    await page.getByLabel('Search by name').fill('')

    // Favourites.
    await page.locator('.listing .grid').last().locator('.card', { hasText: 'Algebra homework' }).getByRole('button', { name: /Actions for/ }).click()
    await page.getByRole('menuitem', { name: 'Add to favourites' }).click()
    await expect.poll(() => section('Favourites').allTextContents()).toEqual(['Algebra homework'])
    await shot(page, '25-library-shortcuts')
    await page.reload()
    await expect.poll(() => section('Favourites').allTextContents()).toEqual(['Algebra homework'])
    expect(tab.errors).toEqual([])
    await tab.ctx.close()
  })

  it('has a dark appearance, with dark pages on request', async () => {
    const tab = await device()
    const { page, cdp } = tab
    await page.getByRole('button', { name: 'Notebook', exact: true }).click()
    await page.getByRole('button', { name: 'Create' }).click()
    await page.locator('canvas.ink').waitFor()
    await settle(page)
    await pen(cdp, scribble(340, 200, 300, 1))
    await page.getByRole('button', { name: 'Highlighter' }).click()
    await pen(cdp, [[340, 260], [500, 262], [640, 260]])
    await page.getByRole('button', { name: 'Back to library' }).click()

    const bodyColour = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    expect(await bodyColour()).toBe('rgb(244, 245, 247)')
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Dark', exact: true }).click()
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
    expect(await bodyColour()).toBe('rgb(21, 24, 29)')
    await shot(page, '27-dark-settings')
    await page.getByLabel('Dark pages too, with the dark appearance').check()
    expect(await page.evaluate(() => document.documentElement.classList.contains('dark-pages'))).toBe(true)
    await page.getByRole('button', { name: 'Save' }).click()
    await shot(page, '28-dark-library')

    // Kept after a restart; the page is shown dark, the ink light.
    await page.reload()
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
    await page.locator('.card.notebook').first().click()
    await page.locator('canvas.ink').waitFor()
    await settle(page, 600)
    await shot(page, '29-dark-pages')
    expect(tab.errors).toEqual([])
    await tab.ctx.close()
  })

  it('inserts graduated axes to draw a graph in', async () => {
    const tab = await device()
    const { page, cdp } = tab
    await page.getByRole('button', { name: 'Notebook', exact: true }).click()
    await page.getByRole('radio', { name: 'Blank' }).click()
    await page.getByRole('button', { name: 'Create' }).click()
    await page.locator('canvas.ink').waitFor()
    await settle(page)
    await page.getByRole('button', { name: 'Insert', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Axes for a graph' }).click()
    await page.getByLabel('x from').fill('-2')
    await page.getByLabel('x to').fill('6')
    await page.getByLabel('y from').fill('3')
    await page.getByLabel('y to').fill('1') // the wrong way round
    await page.getByRole('button', { name: 'Insert', exact: true }).last().click()
    await page.getByText('Each axis must go from a smaller number to a larger one.').waitFor()
    await page.getByLabel('y from').fill('-1')
    await page.getByLabel('y to').fill('4')
    await page.getByRole('button', { name: 'Insert', exact: true }).last().click()
    await page.locator('.sel-bar').waitFor() // inserted as one selected group
    const count = await strokeCount(page)
    expect(count).toBeGreaterThan(40)
    // Draw a curve in it with the pen.
    await page.getByRole('button', { name: 'Pen', exact: true }).click()
    await pen(cdp, Array.from({ length: 60 }, (_, i): Pt => [440 + i * 6, 470 - Math.sin(i / 9) * 90, 0.4]))
    await settle(page)
    expect(await strokeCount(page)).toBe(count + 1)
    await page.screenshot({ path: `${OUT}30-axes.png`, clip: { x: 250, y: 150, width: 800, height: 560 } })
    // One undo removes the whole set of axes.
    await page.getByRole('button', { name: 'Undo' }).click()
    await page.getByRole('button', { name: 'Undo' }).click()
    await settle(page)
    expect(await strokeCount(page)).toBe(0)
    expect(tab.errors).toEqual([])
    await tab.ctx.close()
  })

  it('rotates a selection and crops a picture', async () => {
    const tab = await device()
    const { page, cdp } = tab
    await page.getByRole('button', { name: 'Notebook', exact: true }).click()
    await page.getByRole('radio', { name: 'Blank' }).click()
    await page.getByRole('button', { name: 'Create' }).click()
    await page.locator('canvas.ink').waitFor()
    await settle(page)
    const elements = () =>
      page.evaluate(
        () =>
          new Promise<{ tool: string; bytes: number; box: number[] }[]>((resolve) => {
            const open = indexedDB.open('plume')
            open.onsuccess = () => {
              const req = open.result.transaction('strokes').objectStore('strokes').getAll()
              req.onsuccess = () => {
                open.result.close()
                resolve(
                  (req.result as { tool: string; seq: number; pts: Float32Array; image?: { data: Uint8Array } }[])
                    .sort((a, b) => a.seq - b.seq)
                    .map((s) => {
                      const xs = Array.from(s.pts).filter((_, i) => i % 3 === 0)
                      const ys = Array.from(s.pts).filter((_, i) => i % 3 === 1)
                      return { tool: s.tool, bytes: s.image?.data.length ?? 0, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] }
                    }),
                )
              }
            }
          }),
      )
    const zoom = (1280 - 36) / 595.28
    const sx = (x: number) => 640 - (595.28 / 2) * zoom + x * zoom
    const sy = (y: number) => 48 + 14 * zoom + y * zoom
    const size = (b: number[]) => [b[2] - b[0], b[3] - b[1]]

    // A picture, wider than tall: a quarter turn makes it taller than wide, around the same centre.
    await page.locator('.editor-body > input[type=file]').setInputFiles(`${OUT}test-picture.jpg`)
    await page.locator('.sel-bar').waitFor()
    const [before] = await elements()
    await page.getByRole('button', { name: 'Rotate a quarter turn' }).click()
    await expect.poll(async () => size((await elements())[0].box)[1] > size((await elements())[0].box)[0]).toBe(true)
    const [turned] = await elements()
    expect(size(turned.box)[0]).toBeCloseTo(size(before.box)[1], 0)
    expect(size(turned.box)[1]).toBeCloseTo(size(before.box)[0], 0)
    expect((turned.box[0] + turned.box[2]) / 2).toBeCloseTo((before.box[0] + before.box[2]) / 2, 0)
    await shot(page, '31-picture-rotated')

    // Crop: drag over a part in the middle; only that part is kept, where it was.
    await page.getByRole('button', { name: 'Crop', exact: true }).click()
    await page.getByText('Drag over the part to keep').waitFor()
    const mid = sx((turned.box[0] + turned.box[2]) / 2)
    await pen(cdp, [[mid - 60, 300], [mid, 400], [mid + 60, 500]])
    await shot(page, '32-picture-cropping')
    await page.getByRole('button', { name: 'Crop', exact: true }).click()
    await expect.poll(async () => size((await elements())[0].box)[0]).toBeLessThan(size(turned.box)[0] * 0.7)
    const [cropped] = await elements()
    expect(size(cropped.box)[0]).toBeCloseTo(120 / zoom, 0)
    expect(size(cropped.box)[1]).toBeCloseTo(200 / zoom, 0)
    expect(sx(cropped.box[0])).toBeCloseTo(mid - 60, 0)
    expect(sy(cropped.box[1])).toBeCloseTo(300, 0)
    expect(cropped.bytes).toBeLessThan(turned.bytes)
    await shot(page, '33-picture-cropped')

    // Ink turns too: a horizontal stroke becomes vertical.
    await page.getByRole('button', { name: 'Pen', exact: true }).click()
    await pen(cdp, [[700, 600], [800, 601], [900, 600]])
    await page.getByRole('button', { name: 'Select', exact: true }).click()
    await pen(cdp, [[680, 580], [920, 580], [920, 620], [680, 620], [680, 582]])
    await page.locator('.sel-bar').waitFor()
    await page.getByRole('button', { name: 'Rotate a quarter turn' }).click()
    await expect.poll(async () => { const s = (await elements()).find((e) => e.tool === 'pen')!; return size(s.box)[1] > size(s.box)[0] * 5 }).toBe(true)

    // Undo goes back through each step.
    for (let i = 0; i < 2; i++) await page.getByRole('button', { name: 'Undo' }).click()
    await settle(page)
    await page.getByRole('button', { name: 'Undo' }).click()
    await expect.poll(async () => size((await elements())[0].box)[0]).toBeCloseTo(size(turned.box)[0], 0)
    expect(tab.errors).toEqual([])
    await tab.ctx.close()
  })

  it('creates a notebook with a cover, and adds pages of another format', async () => {
    const tab = await device()
    const { page } = tab
    await page.locator('.sync-chip').click()
    await page.getByRole('button', { name: 'Sign in to OneDrive' }).click()
    await page.waitForFunction(() => document.querySelector('.sync-chip')?.getAttribute('data-state') === 'ok')
    await page.getByRole('button', { name: 'Notebook', exact: true }).click()
    await page.getByLabel('Name', { exact: true }).fill('Quantum mechanics')
    await page.getByRole('radio', { name: 'Orbits' }).click()
    await page.getByLabel('Subtitle (optional)').fill('Semester 1 — Prof. Martin')
    await page.getByRole('button', { name: 'Cover colour #0e7490' }).click()
    await page.getByRole('radio', { name: 'Dotted' }).click()
    await shot(page, '34-new-notebook')
    await page.getByRole('button', { name: 'Create' }).click()
    await page.locator('canvas.ink').waitFor()
    await expect.poll(() => page.locator('.page-pill').last().textContent()).toBe('1 / 2') // the cover, then a first page
    await settle(page, 400)
    await shot(page, '35-cover')

    // Quick add keeps the format of the page before; the other way lets one choose.
    await page.getByRole('button', { name: 'Page previews' }).click()
    await page.getByRole('button', { name: 'Actions for page 2' }).click()
    await page.getByRole('menuitem', { name: 'Add a page after' }).click()
    await expect.poll(() => page.locator('.thumb').count()).toBe(3)
    await page.getByRole('button', { name: 'Actions for page 3' }).click()
    await page.getByRole('menuitem', { name: 'Add a page of another format…' }).click()
    await page.getByRole('dialog').getByRole('radio', { name: 'Grid' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Landscape' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Add', exact: true }).click()
    await expect.poll(() => page.locator('.thumb').count()).toBe(4)
    // And an existing page can change format.
    await page.getByRole('button', { name: 'Actions for page 2' }).click()
    await page.getByRole('menuitem', { name: 'Change the format…' }).click()
    await page.getByRole('dialog').getByRole('radio', { name: 'Seyès' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Apply' }).click()
    await expect.poll(() => page.locator('.thumb canvas').count(), { timeout: 10_000 }).toBe(4)
    await shot(page, '36-page-formats')

    await page.getByRole('button', { name: 'Back to library' }).click()
    // In the library, the card of the notebook shows its first page: here, the cover in its colour.
    const card = page.locator('.listing .grid').last().locator('.card.notebook', { hasText: 'Quantum mechanics' })
    await card.locator('.cover img').waitFor({ timeout: 15_000 })
    const tealPixels = () =>
      card.locator('.cover img').evaluate(async (img: HTMLImageElement) => {
        await img.decode()
        const c = document.createElement('canvas')
        c.width = img.naturalWidth
        c.height = img.naturalHeight
        const g = c.getContext('2d')!
        g.drawImage(img, 0, 0)
        const d = g.getImageData(0, 0, c.width, c.height).data
        let n = 0
        for (let k = 0; k < d.length; k += 4) if (d[k] < 90 && d[k + 1] > 90 && d[k + 1] < 170 && d[k + 2] > 110) n++
        return n
      })
    await expect.poll(tealPixels, { timeout: 10_000 }).toBeGreaterThan(60)
    await shot(page, '37-library-first-pages')
    await expect.poll(async () => (await extractPlumeData(drive.find('Plume/Quantum mechanics.pdf')?.content ?? new Uint8Array()))?.pages.length, { timeout: 20_000 }).toBe(4)
    const exported = drive.find('Plume/Quantum mechanics.pdf')!.content!
    writeFileSync(`${OUT}cover.pdf`, exported)
    const data = (await extractPlumeData(exported))!
    expect(data.pages.map((p) => [p.cover?.template ?? null, p.bg, p.orient])).toEqual([
      ['orbits', 'blank', 'portrait'],
      [null, 'seyes', 'portrait'],
      [null, 'dots', 'portrait'],
      [null, 'grid', 'landscape'],
    ])
    expect(data.pages[0].cover).toEqual({ template: 'orbits', title: 'Quantum mechanics', subtitle: 'Semester 1 — Prof. Martin', color: '#0e7490' })
    expect(tab.errors).toEqual([])
    await tab.ctx.close()
  })
})

