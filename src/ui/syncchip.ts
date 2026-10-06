// OneDrive sync status indicator.

import type { SyncEngine, SyncState } from '../sync/engine'
import { button, h, icons, showPopover } from './dom'

const STATES: Record<SyncState, { label: string; icon: string; detail: string }> = {
  disabled: { label: 'Local only', icon: icons.cloudOff, detail: 'OneDrive is not set up yet: your notes are saved on this device only.' },
  signedOut: { label: 'Sign-in required', icon: icons.cloudAlert, detail: 'Sign in to OneDrive to sync. Your notes stay saved on this device in the meantime.' },
  offline: { label: 'Offline', icon: icons.cloudOff, detail: 'No network. Your notes are saved on this device and will be sent to OneDrive when the connection is back.' },
  syncing: { label: 'Syncing…', icon: icons.cloudUp, detail: 'Sending to OneDrive.' },
  pending: { label: 'Pending', icon: icons.cloudUp, detail: 'Changes saved on this device are waiting to be sent to OneDrive.' },
  ok: { label: 'Up to date', icon: icons.cloudOk, detail: 'Everything is saved in OneDrive.' },
  error: { label: 'Error', icon: icons.cloudAlert, detail: 'The last sync failed. Your notes stay saved on this device.' },
}

function ago(t?: number): string {
  if (!t) return 'never'
  const min = Math.round((Date.now() - t) / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  return new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export function createSyncChip(engine: SyncEngine, actions: { login(): void }, compact = false): HTMLElement {
  const icon = h('span', { class: 'chip-icon' })
  const label = h('span', { class: 'chip-label' })
  const chip = h('button', { class: `sync-chip ${compact ? 'compact' : ''}`, type: 'button', onClick: () => showPopover(chip, details()) }, icon, label)

  const update = () => {
    const s = STATES[engine.status.state]
    chip.dataset.state = engine.status.state
    chip.title = `OneDrive: ${s.label}`
    icon.innerHTML = s.icon
    label.textContent = s.label
  }

  const details = (): HTMLElement => {
    const st = engine.status
    const s = STATES[st.state]
    return h(
      'div',
      { class: 'popover sync-details' },
      h('strong', {}, `OneDrive: ${s.label}`),
      h('p', {}, s.detail),
      st.state === 'error' && st.message ? h('p', { class: 'error-text' }, st.message) : null,
      st.state !== 'disabled' ? h('p', { class: 'muted' }, `Last sync: ${ago(st.lastSync)}`) : null,
      st.state === 'signedOut' ? button('Sign in to OneDrive', actions.login, 'primary wide') : null,
      st.state !== 'disabled' && st.state !== 'signedOut' ? button('Sync now', () => void engine.sync(), 'primary wide') : null,
    )
  }

  const off = engine.subscribe((e) => {
    if (e.type !== 'status') return
    if (!chip.isConnected) return off()
    update()
  })
  update()
  return chip
}
