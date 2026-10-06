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

/** Un « appareil » : stockage vierge, écran tactile, faux services Microsoft. */
async function device(width = 1280, height = 800): Promise<{ ctx: BrowserContext; page: Page; cdp: CDPSession; errors: string[] }> {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block', locale: 'fr-FR' })
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

/** Trace un trait au stylet (avec pression), comme le ferait un S Pen. */
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
  // Fin lente : pas d'élan, pour une position finale reproductible.
  await new Promise((r) => setTimeout(r, 150))
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

/** Une ligne d'écriture cursive factice. */
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

describe('Plume dans le navigateur', () => {
  let tablet: Awaited<ReturnType<typeof device>>

  it('démarre, se connecte à OneDrive et crée le dossier Plume', async () => {
    tablet = await device()
    const { page } = tablet
    await page.getByText('Aucune note pour le moment').waitFor()
    expect(await chip(page)).toBe('signedOut')
    await shot(page, '01-bibliotheque-vide')
    await page.locator('.sync-chip').click()
    await page.getByRole('button', { name: 'Se connecter à OneDrive' }).click()
    await page.waitForFunction(() => document.querySelector('.sync-chip')?.getAttribute('data-state') === 'ok')
    expect(logins).toBe(1)
    expect(page.url()).not.toContain('code=')
    expect(drive.tree()).toEqual(['Plume/'])
  })

  it('crée un dossier puis un bloc-notes, visibles aussitôt dans OneDrive', async () => {
    const { page } = tablet
    await page.getByRole('button', { name: 'Dossier', exact: true }).click()
    await page.getByLabel('Nom du dossier').fill('Maths')
    await page.getByRole('button', { name: 'Créer' }).click()
    await page.locator('.card.folder', { hasText: 'Maths' }).click()
    await page.locator('.crumbs .current', { hasText: 'Maths' }).waitFor()
    await page.getByRole('button', { name: 'Bloc-notes', exact: true }).click()
    await page.getByLabel('Nom').fill('Analyse : chapitre 1')
    await page.getByRole('radio', { name: 'Seyès' }).click()
    await shot(page, '02-nouveau-bloc-notes')
    await page.getByRole('button', { name: 'Créer' }).click()
    await page.locator('canvas.ink').waitFor()
    await expect.poll(() => drive.tree(), { timeout: 10_000 }).toEqual(['Plume/', 'Plume/Maths/', 'Plume/Maths/Analyse - chapitre 1.pdf'])
  })

  it('écrit au stylet, surligne, trace un trait droit, gomme, annule et rétablit', async () => {
    const { page, cdp } = tablet
    for (let l = 0; l < 4; l++) await pen(cdp, scribble(330, 150 + l * 34, 420 - l * 60, l))
    expect(await strokeCount(page)).toBe(4)

    await page.getByRole('button', { name: 'Surligneur' }).click()
    await pen(cdp, [[330, 150], [520, 152], [740, 150]])
    await page.getByRole('button', { name: 'Trait droit' }).click()
    await pen(cdp, [[330, 300], [500, 330], [760, 300]])
    await settle(page)
    expect(await strokeCount(page)).toBe(6)
    await shot(page, '03-ecriture')

    // Gomme « trait entier » : un passage sur la 4e ligne la supprime.
    await page.getByRole('button', { name: 'Gomme', exact: true }).click()
    await pen(cdp, [[400, 250], [400, 268]])
    await settle(page)
    expect(await strokeCount(page)).toBe(5)

    // Gomme précise : coupe la 2e ligne en deux morceaux.
    await page.getByRole('button', { name: 'Gomme', exact: true }).click()
    await page.getByRole('button', { name: 'Précise' }).click()
    await page.keyboard.press('Escape')
    await page.locator('canvas.ink').click({ position: { x: 5, y: 5 } })
    await page.getByTitle('Gomme 6 pt').click()
    await pen(cdp, [[500, 180], [500, 200]])
    await settle(page)
    expect(await strokeCount(page)).toBe(6)

    await page.getByRole('button', { name: 'Annuler' }).click()
    await settle(page)
    expect(await strokeCount(page)).toBe(5)
    await page.getByRole('button', { name: 'Annuler' }).click()
    await settle(page)
    expect(await strokeCount(page)).toBe(6)
    await page.getByRole('button', { name: 'Rétablir' }).click()
    await settle(page)
    expect(await strokeCount(page)).toBe(5)
    await page.getByRole('button', { name: 'Stylo', exact: true }).click()
  })

  it('ignore la paume posée pendant que le stylet est là, mais défile au doigt sinon', async () => {
    const { page, cdp } = tablet
    await penHover(cdp, 600, 500)
    const before = await stage(page)
    await fingerDrag(cdp, [800, 600], [800, 300])
    await settle(page)
    expect((await stage(page)).equals(before)).toBe(true)

    // Paume posée en plein tracé : le trait continue, la page ne bouge pas.
    await pen(cdp, scribble(330, 420, 100), { lift: false })
    await fingerDrag(cdp, [900, 650], [900, 400], 45)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 430, y: 420, button: 'left', buttons: 0, pointerType: 'pen' })
    await settle(page)
    expect(await strokeCount(page)).toBe(6)
    const written = await stage(page)

    // Stylet éloigné : le doigt fait défiler.
    await page.waitForTimeout(800)
    await fingerDrag(cdp, [800, 600], [800, 300])
    await settle(page)
    expect((await stage(page)).equals(written)).toBe(false)
    await shot(page, '04-apres-defilement')
    await fingerDrag(cdp, [800, 300], [800, 700])
    await settle(page)
  })

  it('gère les pages : ajout, fond, duplication, déplacement, suppression', async () => {
    const { page } = tablet
    await page.getByRole('button', { name: 'Pages' }).first().click()
    await page.getByRole('button', { name: /Ajouter une page après/ }).click()
    await expect.poll(() => page.locator('.page-list li').count()).toBe(2)
    await page.getByLabel('Fond de la page 2').selectOption('dots')
    await page.locator('.page-list li').nth(0).getByRole('button', { name: 'Dupliquer' }).click()
    await expect.poll(() => page.locator('.page-list li').count()).toBe(3)
    await expect.poll(() => strokeCount(page)).toBe(12)
    await page.locator('.page-list li').nth(2).getByRole('button', { name: 'Monter' }).click()
    await shot(page, '05-pages')
    await page.locator('.page-list li').nth(2).getByRole('button', { name: 'Supprimer' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Supprimer' }).click()
    await expect.poll(() => page.locator('.page-list li').count()).toBe(2)
    await expect.poll(() => strokeCount(page)).toBe(6)
    await page.locator('.pages-panel').getByRole('button', { name: 'Fermer' }).click()
  })

  it('envoie le PDF à la fermeture du bloc-notes ; le PDF contient chaque trait', async () => {
    const { page } = tablet
    await page.getByRole('button', { name: 'Retour à la bibliothèque' }).click()
    await page.locator('.card.notebook').waitFor()
    await expect.poll(() => remoteStrokes('Plume/Maths/Analyse - chapitre 1.pdf'), { timeout: 15_000 }).toBe(6)
    await expect.poll(() => chip(page)).toBe('ok')
    writeFileSync(`${OUT}export.pdf`, drive.find('Plume/Maths/Analyse - chapitre 1.pdf')!.content!)
    const data = await extractPlumeData(drive.find('Plume/Maths/Analyse - chapitre 1.pdf')!.content!)
    expect(data!.pages.map((p) => p.bg)).toEqual(['seyes', 'dots'])
    await shot(page, '06-bibliotheque')
  })

  it('retrouve tout après un redémarrage, et reste utilisable hors ligne', async () => {
    const { page, cdp, ctx } = tablet
    await page.reload()
    await page.locator('.card.notebook').click()
    await page.locator('canvas.ink').waitFor()
    await settle(page, 600)
    await shot(page, '07-apres-redemarrage')
    expect(await strokeCount(page)).toBe(6)

    drive.online = false
    await ctx.setOffline(true)
    await pen(cdp, scribble(330, 480, 300, 5))
    await settle(page, 1200)
    expect(await strokeCount(page)).toBe(7)
    expect(await chip(page)).toBe('offline')
    await page.reload().catch(() => {}) // hors ligne sans service worker : le rechargement échoue, les données restent
    drive.online = true
    await ctx.setOffline(false)
    await page.goto(url)
    await expect.poll(() => remoteStrokes('Plume/Maths/Analyse - chapitre 1.pdf'), { timeout: 15_000 }).toBe(7)
  })

  it('un second appareil retrouve le même contenu, modifiable', async () => {
    const pc = await device(1600, 900)
    const { page } = pc
    await page.locator('.sync-chip').click()
    await page.getByRole('button', { name: 'Se connecter à OneDrive' }).click()
    await page.locator('.card.folder', { hasText: 'Maths' }).click()
    await page.locator('.card.notebook', { hasText: '2 pages' }).click()
    await page.locator('canvas.ink').waitFor()
    await settle(page, 600)
    expect(await strokeCount(page)).toBe(7)
    await shot(page, '08-second-appareil')
    // À la souris, sur PC.
    await page.mouse.move(700, 600)
    await page.mouse.down()
    await page.mouse.move(800, 640, { steps: 12 })
    await page.mouse.up()
    await page.getByRole('button', { name: 'Retour à la bibliothèque' }).click()
    await expect.poll(() => remoteStrokes('Plume/Maths/Analyse - chapitre 1.pdf'), { timeout: 15_000 }).toBe(8)
    expect(drive.tree()).toEqual(['Plume/', 'Plume/Maths/', 'Plume/Maths/Analyse - chapitre 1.pdf'])
    expect(pc.errors).toEqual([])
    await pc.ctx.close()

    // De retour sur la tablette : la version du PC arrive toute seule.
    await tablet.page.reload()
    await expect.poll(() => strokeCount(tablet.page), { timeout: 15_000 }).toBe(8)
    expect(tablet.errors).toEqual([])
  })

  it('une fois installée, s’ouvre et fonctionne sans aucun réseau', async () => {
    const ctx = await browser.newContext({ viewport: { width: 800, height: 1280 }, deviceScaleFactor: 2, hasTouch: true, locale: 'fr-FR' })
    const page = await ctx.newPage()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(String(e)))
    await page.goto(url)
    await page.evaluate(() => navigator.serviceWorker.ready)
    await page.waitForFunction(() => !!navigator.serviceWorker.controller)
    await ctx.setOffline(true)
    await page.reload()
    await page.getByRole('button', { name: 'Bloc-notes', exact: true }).click()
    await page.getByRole('button', { name: 'Créer' }).click()
    await page.locator('canvas.ink').waitFor()
    const cdp = await ctx.newCDPSession(page)
    await pen(cdp, scribble(150, 300, 400))
    await settle(page)
    expect(await strokeCount(page)).toBe(1)
    await shot(page, '09-hors-ligne-portrait')
    await page.reload()
    await page.locator('canvas.ink').waitFor()
    expect(await strokeCount(page)).toBe(1)
    expect(errors).toEqual([])
    await ctx.close()
  })

  it('reste utilisable sur un écran de téléphone', async () => {
    const phone = await device(400, 800)
    const { page } = phone
    await page.getByRole('button', { name: 'Bloc-notes', exact: true }).click()
    await shot(page, '10-telephone-dialogue')
    await page.getByRole('button', { name: 'Créer' }).click()
    await page.locator('canvas.ink').waitFor()
    await page.getByRole('button', { name: 'Stylo', exact: true }).click()
    await shot(page, '11-telephone-editeur')
    // Aucun bouton de la barre d'outils ne déborde de l'écran.
    const overflow = await page.evaluate(() => [...document.querySelectorAll('.toolbar > *, .toolbar .tools > *')].filter((el) => el.getBoundingClientRect().right > innerWidth + 0.5 && getComputedStyle(el).display !== 'none').length)
    expect(overflow).toBe(0)
    await phone.ctx.close()
  })
})
