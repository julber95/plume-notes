import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { allNodes, applyStrokeChange, closeDb, getPages, getStrokes } from '../src/db'
import { createFolder, createNotebook, deleteNode, moveNode, renameNode } from '../src/library'
import { ROOT, type LibNode } from '../src/model'
import { buildNotebookPdf } from '../src/pdf/build'
import { extractPlumeData } from '../src/pdf/extract'
import { buildFromDb } from '../src/pdf/fromDb'
import { SyncEngine } from '../src/sync/engine'
import { GraphClient } from '../src/sync/graph'
import { FakeDrive } from './fakeGraph'
import { letter, rng } from './helpers'

let drive: FakeDrive
let engine: SyncEngine
let auth: 'disabled' | 'signedOut' | 'ready'
let openId: string | null
const rand = rng(7)

/** Simule un appareil vierge (ou une réinstallation) : stockage local vide. */
async function freshDevice(): Promise<void> {
  await closeDb()
  globalThis.indexedDB = new IDBFactory()
  engine = new SyncEngine({
    authState: () => auth,
    graph: () => new GraphClient(async () => 'TOKEN', drive.fetch),
    isOnline: () => drive.online,
    buildPdf: buildFromDb,
    extract: extractPlumeData,
    openNotebookId: () => openId,
  })
}

beforeEach(async () => {
  drive = new FakeDrive()
  auth = 'ready'
  openId = null
  await freshDevice()
})

async function write(nb: LibNode, count = 1): Promise<void> {
  const [page] = await getPages(nb.id)
  for (let i = 0; i < count; i++) await applyStrokeChange(nb.id, page.id, [letter(page.id, 100 + rand() * 300, 100 + rand() * 500, Date.now() + i, rand)], [])
}

async function local(): Promise<string[]> {
  const nodes = (await allNodes()).filter((n) => !n.deleted)
  const path = (n: LibNode): string => (n.parentId === ROOT ? '' : path(nodes.find((p) => p.id === n.parentId)!) + '/') + n.name
  return nodes.map((n) => path(n) + (n.kind === 'folder' ? '/' : '.pdf')).sort()
}

async function strokeCount(nb: LibNode): Promise<number> {
  let n = 0
  for (const p of await getPages(nb.id)) n += (await getStrokes(p.id)).length
  return n
}

async function remoteStrokes(path: string): Promise<number> {
  const data = await extractPlumeData(drive.find(path)!.content!)
  return data!.pages.reduce((n, p) => n + p.strokes.length, 0)
}

const byName = async (name: string) => (await allNodes()).find((n) => n.name === name && !n.deleted)!

describe('synchronisation OneDrive', () => {
  it('reproduit dossiers et blocs-notes dans OneDrive/Plume, chaque bloc-notes en PDF', async () => {
    const maths = await createFolder(ROOT, 'Maths')
    const analyse = await createFolder(maths.id, 'Analyse')
    const nb = await createNotebook(analyse.id, 'Chapitre 1', 'grid', 'portrait')
    await createNotebook(ROOT, 'Brouillon', 'blank', 'landscape')
    await write(nb, 5)
    await engine.sync()
    expect(engine.status.state).toBe('ok')
    expect(drive.tree()).toEqual(['Plume/', 'Plume/Brouillon.pdf', 'Plume/Maths/', 'Plume/Maths/Analyse/', 'Plume/Maths/Analyse/Chapitre 1.pdf'])
    const pdf = drive.find('Plume/Maths/Analyse/Chapitre 1.pdf')!.content!
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe('%PDF-')
    expect(await remoteStrokes('Plume/Maths/Analyse/Chapitre 1.pdf')).toBe(5)
  })

  it('reporte renommages, déplacements et suppressions', async () => {
    const a = await createFolder(ROOT, 'A')
    const b = await createFolder(ROOT, 'B')
    const nb = await createNotebook(a.id, 'Cours', 'lined', 'portrait')
    await engine.sync()
    await renameNode(nb.id, 'Cours de lundi')
    await moveNode(nb.id, b.id)
    await renameNode(a.id, 'Archives')
    await engine.sync()
    expect(drive.tree()).toEqual(['Plume/', 'Plume/Archives/', 'Plume/B/', 'Plume/B/Cours de lundi.pdf'])
    await deleteNode(b.id)
    await engine.sync()
    expect(drive.tree()).toEqual(['Plume/', 'Plume/Archives/'])
    expect(await local()).toEqual(['Archives/'])
    expect((await allNodes()).length).toBe(1)
  })

  it('hors ligne : tout est gardé en attente puis envoyé au retour du réseau', async () => {
    drive.online = false
    const f = await createFolder(ROOT, 'Physique')
    const nb = await createNotebook(f.id, 'TD 3', 'seyes', 'portrait')
    await write(nb, 3)
    await engine.sync()
    expect(engine.status.state).toBe('offline')
    expect(drive.tree()).toEqual([])
    expect(await strokeCount(nb)).toBe(3)
    drive.online = true
    await engine.sync()
    expect(engine.status.state).toBe('ok')
    expect(drive.tree()).toEqual(['Plume/', 'Plume/Physique/', 'Plume/Physique/TD 3.pdf'])
    expect(await remoteStrokes('Plume/Physique/TD 3.pdf')).toBe(3)
  })

  it('une coupure réseau en plein envoi ne perd rien et reprend ensuite', async () => {
    const nb = await createNotebook(ROOT, 'Cours', 'grid', 'portrait')
    await write(nb, 2)
    drive.beforeNextPut = () => (drive.online = false)
    await engine.sync()
    expect(engine.status.state).toBe('offline')
    expect(await strokeCount(nb)).toBe(2)
    drive.online = true
    await engine.sync()
    expect(await remoteStrokes('Plume/Cours.pdf')).toBe(2)
  })

  it('ne renvoie un PDF que s’il a changé', async () => {
    const nb = await createNotebook(ROOT, 'Cours', 'grid', 'portrait')
    await engine.sync()
    const puts = () => drive.calls.filter((c) => c.startsWith('PUT')).length
    expect(puts()).toBe(1)
    await engine.sync()
    expect(puts()).toBe(1)
    await write(nb, 2)
    await engine.refresh()
    expect(engine.status.state).toBe('pending')
    await engine.sync()
    expect(puts()).toBe(2)
    expect(await remoteStrokes('Plume/Cours.pdf')).toBe(2)
    expect(engine.status.state).toBe('ok')
  })

  it('un autre appareil retrouve toute l’arborescence et des notes modifiables', async () => {
    const f = await createFolder(ROOT, 'Chimie')
    const nb = await createNotebook(f.id, 'Cours 1', 'dots', 'landscape')
    await write(nb, 12)
    await engine.sync()
    await freshDevice()
    expect(await local()).toEqual([])
    await engine.sync()
    expect(await local()).toEqual(['Chimie/', 'Chimie/Cours 1.pdf'])
    const copy = await byName('Cours 1')
    expect(await strokeCount(copy)).toBe(12)
    expect([copy.bg, copy.orient, copy.needsDownload]).toEqual(['dots', 'landscape', false])
    // On continue à écrire sur le second appareil : le PDF est mis à jour, pas dupliqué.
    await write(copy, 1)
    await engine.sync()
    expect(drive.tree()).toEqual(['Plume/', 'Plume/Chimie/', 'Plume/Chimie/Cours 1.pdf'])
    expect(await remoteStrokes('Plume/Chimie/Cours 1.pdf')).toBe(13)
    expect((await engine.notices()).length).toBe(0)
  })

  it('applique ici les changements faits dans OneDrive (renommer, déplacer, supprimer)', async () => {
    const a = await createFolder(ROOT, 'A')
    await createFolder(ROOT, 'B')
    const nb = await createNotebook(a.id, 'Cours', 'grid', 'portrait')
    await createNotebook(a.id, 'Vieux', 'grid', 'portrait')
    await write(nb, 4)
    await engine.sync()
    drive.rename(drive.find('Plume/A/Cours.pdf')!, 'Algèbre.pdf')
    drive.move(drive.find('Plume/A/Algèbre.pdf')!, drive.find('Plume/B')!)
    drive.delete(drive.find('Plume/A')!)
    drive.add(drive.find('Plume')!.id, 'Nouveau')
    await engine.sync()
    expect(await local()).toEqual(['B/', 'B/Algèbre.pdf', 'Nouveau/'])
    expect(await strokeCount(await byName('Algèbre'))).toBe(4)
    expect(drive.calls.filter((c) => c.startsWith('PUT')).length).toBe(2)
    expect((await engine.notices()).length).toBe(0)
  })

  it('fonctionne aussi sans suivi des changements (parcours complet du dossier)', async () => {
    drive.deltaSupported = false
    const a = await createFolder(ROOT, 'A')
    await createNotebook(a.id, 'Cours', 'grid', 'portrait')
    await engine.sync()
    drive.delete(drive.find('Plume/A/Cours.pdf')!)
    drive.add(drive.find('Plume/A')!.id, 'Sous-dossier')
    await engine.sync()
    expect(await local()).toEqual(['A/', 'A/Sous-dossier/'])
  })

  it('conflit : modifié ici et ailleurs, les deux versions sont conservées', async () => {
    const nb = await createNotebook(ROOT, 'Cours', 'grid', 'portrait')
    await write(nb, 2)
    await engine.sync()
    // Ailleurs : une version à 7 traits remplace le fichier.
    const other = await buildNotebookPdf({
      name: 'Cours',
      bg: 'grid',
      orient: 'portrait',
      pages: [{ id: 'x', bg: 'grid', orient: 'portrait', rev: 0, strokes: Array.from({ length: 7 }, (_, i) => letter('x', 50 + i * 20, 80, i, rand)) }],
    })
    drive.replace(drive.find('Plume/Cours.pdf')!, other)
    // Ici, sans le savoir : on ajoute 1 trait.
    await write(nb, 1)
    await engine.sync()
    expect(engine.status.state).toBe('ok')
    const names = await local()
    expect(names.length).toBe(2)
    expect(names[1]).toBe('Cours.pdf')
    expect(names[0]).toMatch(/^Cours \(conflit \d{4}-\d\d-\d\d \d\dh\d\d\)\.pdf$/)
    expect(await strokeCount(await byName('Cours'))).toBe(7)
    const mine = (await allNodes()).find((n) => n.name.includes('conflit'))!
    expect(mine.id).toBe(nb.id)
    expect(await strokeCount(mine)).toBe(3)
    expect(await remoteStrokes('Plume/Cours.pdf')).toBe(7)
    expect(await remoteStrokes(`Plume/${names[0]}`)).toBe(3)
    const notices = await engine.notices()
    expect(notices.length).toBe(1)
    expect(notices[0].text).toContain('deux endroits')
  })

  it('conflit détecté au moment de l’envoi (le fichier change juste avant)', async () => {
    const nb = await createNotebook(ROOT, 'Cours', 'grid', 'portrait')
    await engine.sync()
    await write(nb, 1)
    const strokes = Array.from({ length: 5 }, (_, i) => letter('x', 50 + i * 20, 80, i, rand))
    const other = await buildNotebookPdf({ name: 'Cours', bg: 'grid', orient: 'portrait', pages: [{ id: 'x', bg: 'grid', orient: 'portrait', rev: 0, strokes }] })
    drive.beforeNextPut = () => drive.replace(drive.find('Plume/Cours.pdf')!, other)
    await engine.sync()
    expect((await local()).length).toBe(2)
    expect(await remoteStrokes('Plume/Cours.pdf')).toBe(5)
    expect(await strokeCount(await byName('Cours'))).toBe(5)
    expect(await strokeCount(await getNodeByKept(nb.id))).toBe(1)
    expect(drive.tree().length).toBe(3)
  })

  it('un simple renommage dans OneDrive ne crée pas de faux conflit', async () => {
    const nb = await createNotebook(ROOT, 'Cours', 'grid', 'portrait')
    await engine.sync()
    await write(nb, 1)
    drive.beforeNextPut = () => drive.rename(drive.find('Plume/Cours.pdf')!, 'Cours renommé.pdf')
    await engine.sync()
    expect(await local()).toEqual(['Cours renommé.pdf'])
    expect(await remoteStrokes('Plume/Cours renommé.pdf')).toBe(1)
    expect((await engine.notices()).length).toBe(0)
  })

  it('supprimé dans OneDrive mais modifié ici : conservé et renvoyé', async () => {
    const f = await createFolder(ROOT, 'Dossier')
    const nb = await createNotebook(f.id, 'Cours', 'grid', 'portrait')
    const calme = await createNotebook(f.id, 'Calme', 'grid', 'portrait')
    await engine.sync()
    await write(nb, 2)
    drive.delete(drive.find('Plume/Dossier')!)
    await engine.sync()
    expect(await local()).toEqual(['Dossier/', 'Dossier/Cours.pdf'])
    expect(drive.tree()).toEqual(['Plume/', 'Plume/Dossier/', 'Plume/Dossier/Cours.pdf'])
    expect(await remoteStrokes('Plume/Dossier/Cours.pdf')).toBe(2)
    expect(await getPages(calme.id)).toEqual([])
    expect((await engine.notices()).length).toBe(1)
  })

  it('dossier Plume supprimé de OneDrive : rien n’est effacé ici, tout est renvoyé', async () => {
    const f = await createFolder(ROOT, 'Maths')
    const nb = await createNotebook(f.id, 'Cours', 'grid', 'portrait')
    await write(nb, 3)
    await engine.sync()
    drive.delete(drive.find('Plume')!)
    await engine.sync()
    expect(await local()).toEqual(['Maths/', 'Maths/Cours.pdf'])
    expect(await strokeCount(nb)).toBe(3)
    expect(drive.tree()).toEqual(['Plume/', 'Plume/Maths/', 'Plume/Maths/Cours.pdf'])
  })

  it('un PDF étranger du même nom n’est jamais écrasé', async () => {
    await engine.sync()
    drive.add(drive.find('Plume')!.id, 'Cours.pdf', new TextEncoder().encode('%PDF-1.4 pas un fichier Plume'))
    const nb = await createNotebook(ROOT, 'Cours', 'grid', 'portrait')
    await write(nb, 1)
    await engine.sync()
    expect(drive.tree()).toEqual(['Plume/', 'Plume/Cours (2).pdf', 'Plume/Cours.pdf'])
    expect(new TextDecoder().decode(drive.find('Plume/Cours.pdf')!.content!)).toContain('pas un fichier Plume')
    expect((await byName('Cours')).foreign).toBe(true)
    expect(await remoteStrokes('Plume/Cours (2).pdf')).toBe(1)
  })

  it('un dossier du même nom déjà présent sur OneDrive est réutilisé', async () => {
    await engine.sync()
    drive.add(drive.find('Plume')!.id, 'Maths')
    await freshDevice()
    const f = await createFolder(ROOT, 'Maths')
    await createNotebook(f.id, 'Cours', 'grid', 'portrait')
    await engine.sync()
    expect(drive.tree()).toEqual(['Plume/', 'Plume/Maths/', 'Plume/Maths/Cours.pdf'])
    expect(await local()).toEqual(['Maths/', 'Maths/Cours.pdf'])
  })

  it('bloc-notes ouvert et non modifié : la version plus récente de OneDrive le remplace', async () => {
    const nb = await createNotebook(ROOT, 'Cours', 'grid', 'portrait')
    await engine.sync()
    openId = nb.id
    const replaced: string[] = []
    engine.subscribe((e) => e.type === 'replaced' && replaced.push(e.notebookId))
    const other = await buildNotebookPdf({ name: 'Cours', bg: 'lined', orient: 'portrait', pages: [{ id: 'x', bg: 'lined', orient: 'portrait', rev: 0, strokes: [letter('x', 100, 100, 0, rand)] }] })
    drive.replace(drive.find('Plume/Cours.pdf')!, other)
    await engine.sync()
    expect(replaced).toEqual([nb.id])
    expect(await strokeCount(nb)).toBe(1)
    expect((await getPages(nb.id))[0].bg).toBe('lined')
  })

  it('signale une connexion requise ou une configuration absente', async () => {
    auth = 'disabled'
    await engine.sync()
    expect(engine.status.state).toBe('disabled')
    auth = 'signedOut'
    await engine.sync()
    expect(engine.status.state).toBe('signedOut')
    expect(drive.calls).toEqual([])
  })
})

async function getNodeByKept(id: string): Promise<LibNode> {
  return (await allNodes()).find((n) => n.id === id)!
}

describe('stockage local', () => {
  it('chaque trait enregistré survit à un arrêt brutal de l’application', async () => {
    const nb = await createNotebook(ROOT, 'Cours', 'grid', 'portrait')
    await write(nb, 4)
    await closeDb() // l'application est tuée ; le stockage du navigateur, lui, persiste
    expect(await strokeCount(nb)).toBe(4)
    const again = (await allNodes())[0]
    expect([again.rev, again.uploadedRev]).toEqual([4, -1])
  })
})
