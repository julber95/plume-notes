import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright'
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
    await page.getByLabel('Name').fill('Calculus : chapter 1')
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
    const overflow = await page.evaluate(() => [...document.querySelectorAll('.toolbar > *, .toolbar .tools > *')].filter((el) => el.getBoundingClientRect().right > innerWidth + 0.5 && getComputedStyle(el).display !== 'none').length)
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
})

