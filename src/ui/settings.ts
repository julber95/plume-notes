import { kvGet, kvSet } from '../db'
import { ONEDRIVE_FOLDER } from '../config'
import type { Auth } from '../sync/auth'
import { button, dialogButtons, h, openDialog } from './dom'
import { darkPagesChosen, setTheme, themeChoice, type ThemeChoice } from './theme'

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
  const account = h('p', { class: 'muted' }, state === 'ready' ? 'Signed in.' : '')
  if (state === 'ready') {
    deps
      .owner()
      .then((name) => name && (account.textContent = `Signed in to the OneDrive of ${name}.`))
      .catch(() => {})
  }

  await openDialog<true>('Settings', (d) => {
    const input = h('input', { type: 'number', min: 1, max: 60, step: 1, value: minutes, inputMode: 'numeric' })
    let theme = themeChoice()
    const themes = h('div', { class: 'segmented' })
    const pages = h('input', { type: 'checkbox', checked: darkPagesChosen() })
    const drawThemes = () =>
      themes.replaceChildren(
        ...([['auto', 'Automatic'], ['light', 'Light'], ['dark', 'Dark']] as [ThemeChoice, string][]).map(([id, label]) =>
          h('button', { type: 'button', class: id === theme ? 'selected' : '', onClick: () => ((theme = id), drawThemes(), setTheme(theme, pages.checked)) }, label),
        ),
      )
    drawThemes()
    pages.addEventListener('change', () => setTheme(theme, pages.checked))
    const save = () => {
      const v = Math.min(60, Math.max(1, Math.round(Number(input.value) || DEFAULT_EXPORT_MINUTES)))
      void kvSet('exportMinutes', v).then(deps.changed)
      d.close(true)
    }
    return [
      h('section', { class: 'settings-section' },
        h('h3', {}, 'Automatic export'),
        h('label', { class: 'field inline' }, h('span', {}, 'Send the PDF to OneDrive every'), input, h('span', {}, 'minutes')),
        h('p', { class: 'muted' }, 'While you are writing. The PDF is also sent when you close a notebook or leave the application.'),
      ),
      h('section', { class: 'settings-section' },
        h('h3', {}, 'Appearance'),
        themes,
        h('label', { class: 'check' }, pages, h('span', {}, 'Dark pages too, with the dark appearance')),
        h('p', { class: 'muted' }, 'Automatic follows the setting of the device. Dark pages only change what you see while writing: the PDF stays black on white.'),
      ),
      h('section', { class: 'settings-section' },
        h('h3', {}, 'OneDrive'),
        state === 'disabled'
          ? h('p', { class: 'muted' }, 'Sync is not set up yet (see the guide, step 2). In the meantime, your notes are saved on this device only.')
          : h('p', { class: 'muted' }, `Your notes are stored in the "${ONEDRIVE_FOLDER}" folder of your OneDrive.`),
        account,
        state === 'signedOut' ? button('Sign in to OneDrive', deps.login, 'primary') : null,
        state === 'ready' ? button('Sign out', () => (deps.logout(), d.close(true))) : null,
      ),
      h('section', { class: 'settings-section' },
        h('h3', {}, 'This device'),
        h('p', { class: 'muted' },
          persisted
            ? 'Local storage is protected: the browser will not delete your notes to free up space.'
            : 'Every stroke is saved on this device as soon as it is drawn. Install Plume on the home screen so that this storage is durably protected.'),
        h('p', { class: 'muted' }, `Plume ${__APP_VERSION__}`),
      ),
      dialogButtons(button('Cancel', () => d.close(null)), button('Save', save, 'primary')),
    ]
  }, 'settings')
}
