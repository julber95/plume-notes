import { kvGet, kvSet } from '../db'
import { ONEDRIVE_FOLDER } from '../config'
import type { Auth } from '../sync/auth'
import { button, dialogButtons, h, openDialog } from './dom'

export const DEFAULT_EXPORT_MINUTES = 5

export async function exportMinutes(): Promise<number> {
  return (await kvGet<number>('exportMinutes')) ?? DEFAULT_EXPORT_MINUTES
}

export async function openSettings(deps: { auth: Auth; owner(): Promise<string>; login(): void; logout(): void; changed(): void }): Promise<void> {
  const minutes = await exportMinutes()
  const state = deps.auth.state
  let persisted: boolean | undefined
  try {
    persisted = await navigator.storage?.persisted?.()
  } catch {
    persisted = undefined
  }
  const account = h('p', { class: 'muted' }, state === 'ready' ? 'Connecté.' : '')
  if (state === 'ready') {
    deps
      .owner()
      .then((name) => name && (account.textContent = `Connecté au OneDrive de ${name}.`))
      .catch(() => {})
  }

  await openDialog<true>('Réglages', (d) => {
    const input = h('input', { type: 'number', min: 1, max: 60, step: 1, value: minutes, inputMode: 'numeric' })
    const save = () => {
      const v = Math.min(60, Math.max(1, Math.round(Number(input.value) || DEFAULT_EXPORT_MINUTES)))
      void kvSet('exportMinutes', v).then(deps.changed)
      d.close(true)
    }
    return [
      h('section', { class: 'settings-section' },
        h('h3', {}, 'Export automatique'),
        h('label', { class: 'field inline' }, h('span', {}, 'Envoyer le PDF vers OneDrive toutes les'), input, h('span', {}, 'minutes')),
        h('p', { class: 'muted' }, "Pendant que vous écrivez. Le PDF est aussi envoyé quand vous fermez un bloc-notes ou quittez l'application."),
      ),
      h('section', { class: 'settings-section' },
        h('h3', {}, 'OneDrive'),
        state === 'disabled'
          ? h('p', { class: 'muted' }, `La synchronisation n'est pas encore configurée (voir le guide, étape 1). En attendant, vos notes sont enregistrées sur cet appareil uniquement.`)
          : h('p', { class: 'muted' }, `Vos notes sont rangées dans le dossier « ${ONEDRIVE_FOLDER} » de votre OneDrive.`),
        account,
        state === 'signedOut' ? button('Se connecter à OneDrive', deps.login, 'primary') : null,
        state === 'ready' ? button('Se déconnecter', () => (deps.logout(), d.close(true))) : null,
      ),
      h('section', { class: 'settings-section' },
        h('h3', {}, 'Cet appareil'),
        h('p', { class: 'muted' },
          persisted
            ? 'Le stockage local est protégé : le navigateur ne supprimera pas vos notes pour libérer de la place.'
            : "Chaque trait est enregistré sur cet appareil dès qu'il est tracé. Installez Plume sur l'écran d'accueil pour que ce stockage soit protégé durablement."),
        h('p', { class: 'muted' }, `Plume ${__APP_VERSION__}`),
      ),
      dialogButtons(button('Annuler', () => d.close(null)), button('Enregistrer', save, 'primary')),
    ]
  }, 'settings')
}
