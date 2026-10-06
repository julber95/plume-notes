import './styles.css'
import { registerSW } from 'virtual:pwa-register'
import { getNode } from './db'
import { ROOT, type LibNode } from './model'
import { buildPdf, extractData } from './pdf/client'
import { createAuth } from './sync/auth'
import { SyncEngine } from './sync/engine'
import { GraphClient } from './sync/graph'
import { toast } from './ui/dom'
import { openEditor, type EditorHandle } from './ui/editor'
import { notOpenable, renderLibrary } from './ui/library'
import { exportMinutes, openSettings } from './ui/settings'
import { createSyncChip } from './ui/syncchip'

const app = document.getElementById('app')!
const auth = createAuth()
const graph = new GraphClient(() => auth.getToken())
let editor: EditorHandle | null = null
let libraryFolder: string | null = null

const engine = new SyncEngine({
  authState: () => auth.state,
  graph: () => graph,
  isOnline: () => navigator.onLine,
  buildPdf,
  extract: extractData,
  openNotebookId: () => editor?.notebookId ?? null,
})

const RETURN_KEY = 'plume.returnHash'

function login(): void {
  sessionStorage.setItem(RETURN_KEY, location.hash)
  void auth.login()
}

// ---------- Navigation (l'adresse reflète l'écran affiché) ----------

function parseRoute(): { view: 'folder' | 'notebook'; id: string } {
  const m = /^#\/(f|n)\/([\w-]+)$/.exec(location.hash)
  if (!m) return { view: 'folder', id: ROOT }
  return { view: m[1] === 'n' ? 'notebook' : 'folder', id: m[2] }
}

const folderHash = (id: string) => (id === ROOT ? '#/' : `#/f/${id}`)

let routing = Promise.resolve()

function route(): Promise<void> {
  routing = routing.then(show, show)
  return routing
}

async function show(): Promise<void> {
  const r = parseRoute()
  if (editor) {
    if (r.view === 'notebook' && r.id === editor.notebookId) return
    await editor.flush()
    editor.destroy()
    editor = null
    void engine.sync()
  }
  libraryFolder = null
  if (r.view === 'notebook') {
    const node = await getNode(r.id)
    if (!node || node.deleted || node.kind !== 'notebook' || notOpenable(node)) {
      location.replace(folderHash(node && !node.deleted ? node.parentId : ROOT))
      return
    }
    editor = await openEditor(app, r.id, {
      syncChip: createSyncChip(engine, { login }, true),
      onSaved: scheduleRefresh,
      onClose: () => location.replace(folderHash(node.parentId)),
    })
    if (editor) return
  }
  libraryFolder = r.id
  await renderLibrary(app, r.id, {
    engine,
    syncChip: createSyncChip(engine, { login }),
    open: (n: LibNode) => (location.hash = n.kind === 'folder' ? folderHash(n.id) : `#/n/${n.id}`),
    goTo: (id) => (location.hash = folderHash(id)),
    openSettings: () =>
      void openSettings({
        auth,
        owner: () => graph.owner(),
        login,
        logout: () => {
          auth.logout()
          void engine.refresh()
        },
        changed: armAutoExport,
      }),
    changed: () => {
      void route()
      syncSoon()
    },
    synced: () => auth.state === 'ready',
  })
}

// ---------- Déclencheurs de synchronisation ----------

let refreshTimer = 0
/** Met à jour l'indicateur « en attente » peu après une modification. */
function scheduleRefresh(): void {
  if (refreshTimer) return
  refreshTimer = window.setTimeout(() => {
    refreshTimer = 0
    void engine.refresh()
  }, 800)
}

let soonTimer = 0
/** Synchronise peu après un changement dans la bibliothèque. */
function syncSoon(): void {
  clearTimeout(soonTimer)
  soonTimer = window.setTimeout(() => void engine.sync(), 1500)
}

let autoTimer = 0
/** Export automatique toutes les X minutes. */
async function armAutoExport(): Promise<void> {
  clearInterval(autoTimer)
  const minutes = await exportMinutes()
  autoTimer = window.setInterval(() => {
    if (document.visibilityState === 'visible') void engine.sync()
  }, minutes * 60_000)
}

engine.subscribe((e) => {
  if ((e.type === 'library' || e.type === 'notices') && libraryFolder !== null && !document.querySelector('dialog[open]')) void route()
  if (e.type === 'replaced' && editor?.notebookId === e.notebookId) {
    void editor.reload()
    toast('Ce bloc-notes a été mis à jour depuis OneDrive.')
  }
})

window.addEventListener('hashchange', () => void route())
window.addEventListener('online', () => void engine.sync())
window.addEventListener('offline', () => void engine.refresh())
document.addEventListener('visibilitychange', () => {
  // En quittant l'application : on envoie ce qui est en attente. Au retour : on
  // vérifie s'il y a du nouveau sur OneDrive.
  if (document.visibilityState === 'hidden') void editor?.flush().then(() => engine.sync())
  else void engine.sync()
})
window.addEventListener('pagehide', () => void engine.sync())

async function start(): Promise<void> {
  registerSW({ immediate: true })
  // Demande au navigateur de ne jamais effacer les notes pour libérer de la place.
  void navigator.storage?.persist?.().catch(() => {})

  const redirect = await auth.handleRedirect(new URLSearchParams(location.search))
  if (redirect.handled) {
    history.replaceState(null, '', location.pathname + (sessionStorage.getItem(RETURN_KEY) ?? ''))
    sessionStorage.removeItem(RETURN_KEY)
    if (redirect.error) toast(redirect.error, 8000)
  } else if (auth.canTrySilentLogin() && navigator.onLine && parseRoute().view === 'folder') {
    // Session Microsoft expirée : reconnexion sans intervention si possible.
    sessionStorage.setItem(RETURN_KEY, location.hash)
    await auth.silentLogin()
    return
  }
  auth.onChange = () => void engine.refresh()
  await route()
  void armAutoExport()
  void engine.sync()
}

void start()
