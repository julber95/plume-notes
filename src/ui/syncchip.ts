// Indicateur d'état de la synchronisation OneDrive.

import type { SyncEngine, SyncState } from '../sync/engine'
import { button, h, icons, showPopover } from './dom'

const STATES: Record<SyncState, { label: string; icon: string; detail: string }> = {
  disabled: { label: 'Local seulement', icon: icons.cloudOff, detail: "OneDrive n'est pas encore configuré : vos notes sont enregistrées sur cet appareil uniquement." },
  signedOut: { label: 'Connexion requise', icon: icons.cloudAlert, detail: 'Connectez-vous à OneDrive pour synchroniser. Vos notes restent enregistrées sur cet appareil en attendant.' },
  offline: { label: 'Hors ligne', icon: icons.cloudOff, detail: 'Pas de réseau. Vos notes sont enregistrées sur cet appareil et partiront vers OneDrive au retour de la connexion.' },
  syncing: { label: 'Synchronisation…', icon: icons.cloudUp, detail: 'Envoi vers OneDrive en cours.' },
  pending: { label: 'En attente', icon: icons.cloudUp, detail: 'Des modifications enregistrées sur cet appareil attendent leur envoi vers OneDrive.' },
  ok: { label: 'À jour', icon: icons.cloudOk, detail: 'Tout est enregistré dans OneDrive.' },
  error: { label: 'Erreur', icon: icons.cloudAlert, detail: "La dernière synchronisation a échoué. Vos notes restent enregistrées sur cet appareil." },
}

function ago(t?: number): string {
  if (!t) return 'jamais'
  const min = Math.round((Date.now() - t) / 60000)
  if (min < 1) return "à l'instant"
  if (min < 60) return `il y a ${min} min`
  return new Date(t).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export function createSyncChip(engine: SyncEngine, actions: { login(): void }, compact = false): HTMLElement {
  const icon = h('span', { class: 'chip-icon' })
  const label = h('span', { class: 'chip-label' })
  const chip = h('button', { class: `sync-chip ${compact ? 'compact' : ''}`, type: 'button', onClick: () => showPopover(chip, details()) }, icon, label)

  const update = () => {
    const s = STATES[engine.status.state]
    chip.dataset.state = engine.status.state
    chip.title = `OneDrive : ${s.label}`
    icon.innerHTML = s.icon
    label.textContent = s.label
  }

  const details = (): HTMLElement => {
    const st = engine.status
    const s = STATES[st.state]
    return h(
      'div',
      { class: 'popover sync-details' },
      h('strong', {}, `OneDrive : ${s.label}`),
      h('p', {}, s.detail),
      st.state === 'error' && st.message ? h('p', { class: 'error-text' }, st.message) : null,
      st.state !== 'disabled' ? h('p', { class: 'muted' }, `Dernière synchronisation : ${ago(st.lastSync)}`) : null,
      st.state === 'signedOut' ? button('Se connecter à OneDrive', actions.login, 'primary wide') : null,
      st.state !== 'disabled' && st.state !== 'signedOut' ? button('Synchroniser maintenant', () => void engine.sync(), 'primary wide') : null,
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
