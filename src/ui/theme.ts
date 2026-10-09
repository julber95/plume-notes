// Light and dark appearance. The choice is kept on the device and applied
// before the first screen is drawn.

export type ThemeChoice = 'auto' | 'light' | 'dark'

const THEME_KEY = 'plume.theme'
const PAGES_KEY = 'plume.darkPages'
const system = window.matchMedia('(prefers-color-scheme: dark)')

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function themeChoice(): ThemeChoice {
  const v = read(THEME_KEY)
  return v === 'light' || v === 'dark' ? v : 'auto'
}

export function darkPagesChosen(): boolean {
  return read(PAGES_KEY) === '1'
}

export function isDark(): boolean {
  const choice = themeChoice()
  return choice === 'dark' || (choice === 'auto' && system.matches)
}

/** Are the pages themselves shown dark (white ink on a dark page)? Only with the dark appearance. */
export function darkPages(): boolean {
  return isDark() && darkPagesChosen()
}

/**
 * Colour drawn around the pages. With dark pages the whole writing surface is
 * shown inverted, so it is drawn light to end up dark.
 */
export function backdrop(): string {
  return isDark() && !darkPages() ? '#22262d' : '#e7e9ed'
}

export function applyTheme(): void {
  const root = document.documentElement
  root.dataset.theme = isDark() ? 'dark' : 'light'
  root.classList.toggle('dark-pages', darkPages())
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', isDark() ? '#15181d' : '#f4f5f7')
  window.dispatchEvent(new Event('plume:theme'))
}

export function setTheme(choice: ThemeChoice, pages: boolean): void {
  try {
    localStorage.setItem(THEME_KEY, choice)
    localStorage.setItem(PAGES_KEY, pages ? '1' : '0')
  } catch {
    // storage unavailable: the choice lasts until the application is closed
  }
  applyTheme()
}

system.addEventListener('change', applyTheme)
