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

/** Simulates a fresh device (or a reinstall): empty local storage. */
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

describe('OneDrive sync', () => {
  it('mirrors folders and notebooks in OneDrive/Plume, each notebook as a PDF', async () => {
    const maths = await createFolder(ROOT, 'Maths')
    const calculus = await createFolder(maths.id, 'Calculus')
    const nb = await createNotebook(calculus.id, 'Chapter 1', 'grid', 'portrait')
    await createNotebook(ROOT, 'Draft', 'blank', 'landscape')
    await write(nb, 5)
    await engine.sync()
    expect(engine.status.state).toBe('ok')
    expect(drive.tree()).toEqual(['Plume/', 'Plume/Draft.pdf', 'Plume/Maths/', 'Plume/Maths/Calculus/', 'Plume/Maths/Calculus/Chapter 1.pdf'])
    const pdf = drive.find('Plume/Maths/Calculus/Chapter 1.pdf')!.content!
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe('%PDF-')
    expect(await remoteStrokes('Plume/Maths/Calculus/Chapter 1.pdf')).toBe(5)
  })

  it('applies renames, moves and deletions', async () => {
    const a = await createFolder(ROOT, 'A')
    const b = await createFolder(ROOT, 'B')
    const nb = await createNotebook(a.id, 'Course', 'lined', 'portrait')
    await engine.sync()
    await renameNode(nb.id, 'Monday course')
    await moveNode(nb.id, b.id)
    await renameNode(a.id, 'Archives')
    await engine.sync()
    expect(drive.tree()).toEqual(['Plume/', 'Plume/Archives/', 'Plume/B/', 'Plume/B/Monday course.pdf'])
    await deleteNode(b.id)
    await engine.sync()
    expect(drive.tree()).toEqual(['Plume/', 'Plume/Archives/'])
    expect(await local()).toEqual(['Archives/'])
    expect((await allNodes()).length).toBe(1)
  })

  it('offline: everything is kept pending then sent when the network is back', async () => {
    drive.online = false
    const f = await createFolder(ROOT, 'Physics')
    const nb = await createNotebook(f.id, 'Tutorial 3', 'seyes', 'portrait')
    await write(nb, 3)
    await engine.sync()
    expect(engine.status.state).toBe('offline')
    expect(drive.tree()).toEqual([])
    expect(await strokeCount(nb)).toBe(3)
    drive.online = true
    await engine.sync()
    expect(engine.status.state).toBe('ok')
    expect(drive.tree()).toEqual(['Plume/', 'Plume/Physics/', 'Plume/Physics/Tutorial 3.pdf'])
    expect(await remoteStrokes('Plume/Physics/Tutorial 3.pdf')).toBe(3)
  })

  it('a network cut in the middle of an upload loses nothing and resumes afterwards', async () => {
    const nb = await createNotebook(ROOT, 'Course', 'grid', 'portrait')
    await write(nb, 2)
    drive.beforeNextPut = () => (drive.online = false)
    await engine.sync()
    expect(engine.status.state).toBe('offline')
    expect(await strokeCount(nb)).toBe(2)
    drive.online = true
    await engine.sync()
    expect(await remoteStrokes('Plume/Course.pdf')).toBe(2)
  })

  it('only re-uploads a PDF if it changed', async () => {
    const nb = await createNotebook(ROOT, 'Course', 'grid', 'portrait')
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
    expect(await remoteStrokes('Plume/Course.pdf')).toBe(2)
    expect(engine.status.state).toBe('ok')
  })

  it('another device gets the whole tree and editable notes', async () => {
    const f = await createFolder(ROOT, 'Chemistry')
    const nb = await createNotebook(f.id, 'Course 1', 'dots', 'landscape')
    await write(nb, 12)
    await engine.sync()
    await freshDevice()
    expect(await local()).toEqual([])
    await engine.sync()
    expect(await local()).toEqual(['Chemistry/', 'Chemistry/Course 1.pdf'])
    const copy = await byName('Course 1')
    expect(await strokeCount(copy)).toBe(12)
    expect([copy.bg, copy.orient, copy.needsDownload]).toEqual(['dots', 'landscape', false])
    // Writing continues on the second device: the PDF is updated, not duplicated.
    await write(copy, 1)
    await engine.sync()
    expect(drive.tree()).toEqual(['Plume/', 'Plume/Chemistry/', 'Plume/Chemistry/Course 1.pdf'])
    expect(await remoteStrokes('Plume/Chemistry/Course 1.pdf')).toBe(13)
    expect((await engine.notices()).length).toBe(0)
  })

  it('applies here the changes made in OneDrive (rename, move, delete)', async () => {
    const a = await createFolder(ROOT, 'A')
    await createFolder(ROOT, 'B')
    const nb = await createNotebook(a.id, 'Course', 'grid', 'portrait')
    await createNotebook(a.id, 'Old', 'grid', 'portrait')
    await write(nb, 4)
    await engine.sync()
    drive.rename(drive.find('Plume/A/Course.pdf')!, 'Algebra.pdf')
    drive.move(drive.find('Plume/A/Algebra.pdf')!, drive.find('Plume/B')!)
    drive.delete(drive.find('Plume/A')!)
    drive.add(drive.find('Plume')!.id, 'New')
    await engine.sync()
    expect(await local()).toEqual(['B/', 'B/Algebra.pdf', 'New/'])
    expect(await strokeCount(await byName('Algebra'))).toBe(4)
    expect(drive.calls.filter((c) => c.startsWith('PUT')).length).toBe(2)
    expect((await engine.notices()).length).toBe(0)
  })

  it('also works without change tracking (full folder traversal)', async () => {
    drive.deltaSupported = false
    const a = await createFolder(ROOT, 'A')
    await createNotebook(a.id, 'Course', 'grid', 'portrait')
    await engine.sync()
    drive.delete(drive.find('Plume/A/Course.pdf')!)
    drive.add(drive.find('Plume/A')!.id, 'Subfolder')
    await engine.sync()
    expect(await local()).toEqual(['A/', 'A/Subfolder/'])
  })

  it('conflict: modified here and elsewhere, both versions are kept', async () => {
    const nb = await createNotebook(ROOT, 'Course', 'grid', 'portrait')
    await write(nb, 2)
    await engine.sync()
    // Elsewhere: a version with 7 strokes replaces the file.
    const other = await buildNotebookPdf({
      name: 'Course',
      bg: 'grid',
      orient: 'portrait',
      pages: [{ id: 'x', bg: 'grid', orient: 'portrait', rev: 0, strokes: Array.from({ length: 7 }, (_, i) => letter('x', 50 + i * 20, 80, i, rand)) }],
    })
    drive.replace(drive.find('Plume/Course.pdf')!, other)
    // Here, unaware of it: 1 stroke is added.
    await write(nb, 1)
    await engine.sync()
    expect(engine.status.state).toBe('ok')
    const names = await local()
    expect(names.length).toBe(2)
    expect(names[1]).toBe('Course.pdf')
    expect(names[0]).toMatch(/^Course \(conflict \d{4}-\d\d-\d\d \d\dh\d\d\)\.pdf$/)
    expect(await strokeCount(await byName('Course'))).toBe(7)
    const mine = (await allNodes()).find((n) => n.name.includes('conflict'))!
    expect(mine.id).toBe(nb.id)
    expect(await strokeCount(mine)).toBe(3)
    expect(await remoteStrokes('Plume/Course.pdf')).toBe(7)
    expect(await remoteStrokes(`Plume/${names[0]}`)).toBe(3)
    const notices = await engine.notices()
    expect(notices.length).toBe(1)
    expect(notices[0].text).toContain('two places')
  })

  it('conflict detected at upload time (the file changes just before)', async () => {
    const nb = await createNotebook(ROOT, 'Course', 'grid', 'portrait')
    await engine.sync()
    await write(nb, 1)
    const strokes = Array.from({ length: 5 }, (_, i) => letter('x', 50 + i * 20, 80, i, rand))
    const other = await buildNotebookPdf({ name: 'Course', bg: 'grid', orient: 'portrait', pages: [{ id: 'x', bg: 'grid', orient: 'portrait', rev: 0, strokes }] })
    drive.beforeNextPut = () => drive.replace(drive.find('Plume/Course.pdf')!, other)
    await engine.sync()
    expect((await local()).length).toBe(2)
    expect(await remoteStrokes('Plume/Course.pdf')).toBe(5)
    expect(await strokeCount(await byName('Course'))).toBe(5)
    expect(await strokeCount(await getNodeByKept(nb.id))).toBe(1)
    expect(drive.tree().length).toBe(3)
  })

  it('a plain rename in OneDrive does not create a false conflict', async () => {
    const nb = await createNotebook(ROOT, 'Course', 'grid', 'portrait')
    await engine.sync()
    await write(nb, 1)
    drive.beforeNextPut = () => drive.rename(drive.find('Plume/Course.pdf')!, 'Course renamed.pdf')
    await engine.sync()
    expect(await local()).toEqual(['Course renamed.pdf'])
    expect(await remoteStrokes('Plume/Course renamed.pdf')).toBe(1)
    expect((await engine.notices()).length).toBe(0)
  })

  it('deleted in OneDrive but modified here: kept and uploaded again', async () => {
    const f = await createFolder(ROOT, 'Folder')
    const nb = await createNotebook(f.id, 'Course', 'grid', 'portrait')
    const quiet = await createNotebook(f.id, 'Quiet', 'grid', 'portrait')
    await engine.sync()
    await write(nb, 2)
    drive.delete(drive.find('Plume/Folder')!)
    await engine.sync()
    expect(await local()).toEqual(['Folder/', 'Folder/Course.pdf'])
    expect(drive.tree()).toEqual(['Plume/', 'Plume/Folder/', 'Plume/Folder/Course.pdf'])
    expect(await remoteStrokes('Plume/Folder/Course.pdf')).toBe(2)
    expect(await getPages(quiet.id)).toEqual([])
    expect((await engine.notices()).length).toBe(1)
  })

  it('Plume folder deleted from OneDrive: nothing is erased here, everything is uploaded again', async () => {
    const f = await createFolder(ROOT, 'Maths')
    const nb = await createNotebook(f.id, 'Course', 'grid', 'portrait')
    await write(nb, 3)
    await engine.sync()
    drive.delete(drive.find('Plume')!)
    await engine.sync()
    expect(await local()).toEqual(['Maths/', 'Maths/Course.pdf'])
    expect(await strokeCount(nb)).toBe(3)
    expect(drive.tree()).toEqual(['Plume/', 'Plume/Maths/', 'Plume/Maths/Course.pdf'])
  })

  it('a foreign PDF with the same name is never overwritten', async () => {
    await engine.sync()
    drive.add(drive.find('Plume')!.id, 'Course.pdf', new TextEncoder().encode('%PDF-1.4 not a Plume file'))
    const nb = await createNotebook(ROOT, 'Course', 'grid', 'portrait')
    await write(nb, 1)
    await engine.sync()
    expect(drive.tree()).toEqual(['Plume/', 'Plume/Course (2).pdf', 'Plume/Course.pdf'])
    expect(new TextDecoder().decode(drive.find('Plume/Course.pdf')!.content!)).toContain('not a Plume file')
    expect((await byName('Course')).foreign).toBe(true)
    expect(await remoteStrokes('Plume/Course (2).pdf')).toBe(1)
  })

  it('a folder with the same name already on OneDrive is reused', async () => {
    await engine.sync()
    drive.add(drive.find('Plume')!.id, 'Maths')
    await freshDevice()
    const f = await createFolder(ROOT, 'Maths')
    await createNotebook(f.id, 'Course', 'grid', 'portrait')
    await engine.sync()
    expect(drive.tree()).toEqual(['Plume/', 'Plume/Maths/', 'Plume/Maths/Course.pdf'])
    expect(await local()).toEqual(['Maths/', 'Maths/Course.pdf'])
  })

  it('notebook open and unmodified: the newer OneDrive version replaces it', async () => {
    const nb = await createNotebook(ROOT, 'Course', 'grid', 'portrait')
    await engine.sync()
    openId = nb.id
    const replaced: string[] = []
    engine.subscribe((e) => e.type === 'replaced' && replaced.push(e.notebookId))
    const other = await buildNotebookPdf({ name: 'Course', bg: 'lined', orient: 'portrait', pages: [{ id: 'x', bg: 'lined', orient: 'portrait', rev: 0, strokes: [letter('x', 100, 100, 0, rand)] }] })
    drive.replace(drive.find('Plume/Course.pdf')!, other)
    await engine.sync()
    expect(replaced).toEqual([nb.id])
    expect(await strokeCount(nb)).toBe(1)
    expect((await getPages(nb.id))[0].bg).toBe('lined')
  })

  it('reports a required sign-in or a missing configuration', async () => {
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

describe('local storage', () => {
  it('every saved stroke survives an abrupt stop of the application', async () => {
    const nb = await createNotebook(ROOT, 'Course', 'grid', 'portrait')
    await write(nb, 4)
    await closeDb() // the application is killed; the browser storage persists
    expect(await strokeCount(nb)).toBe(4)
    const again = (await allNodes())[0]
    expect([again.rev, again.uploadedRev]).toEqual([4, -1])
  })
})
