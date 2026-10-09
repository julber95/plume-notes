// Small interface helpers: element creation, dialogs, messages.

type Child = Node | string | null | undefined | false

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'class') el.className = String(v)
    else if (k === 'html') el.innerHTML = String(v)
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener)
    else if (k in el && k !== 'list') (el as unknown as Record<string, unknown>)[k] = v
    else el.setAttribute(k, String(v))
  }
  for (const c of children.flat()) if (c) el.append(c)
  return el
}

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`

export const icons = {
  back: svg('<path d="M15 5l-7 7 7 7"/>'),
  pen: svg('<path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 013 3L8 19l-4 1z"/><path d="M14.5 6.5l3 3"/>'),
  pencil: svg('<path d="M5 19l1.2-4.6L15.8 4.8a1.6 1.6 0 012.3 0l1.1 1.1a1.6 1.6 0 010 2.3L9.6 17.8 5 19z"/><path d="M6.2 14.4l3.4 3.4"/><path d="M14.2 6.4l3.4 3.4"/><path d="M5 19l1.6-.4-1.2-1.2z" fill="currentColor"/>'),
  highlighter: svg('<path d="M9 14l-3 3v3h3l3-3"/><path d="M8.5 13.5l7.8-8.3a1.8 1.8 0 012.6 0l.9.9a1.8 1.8 0 010 2.6l-8.3 7.8z"/><path d="M4 21h9"/>'),
  eraser: svg('<path d="M7.5 19.5l-3.6-3.6a1.8 1.8 0 010-2.5l8.5-8.5a1.8 1.8 0 012.5 0l4.3 4.3a1.8 1.8 0 010 2.5l-7.8 7.8z"/><path d="M9 9.5l6.5 6.5"/><path d="M7.5 19.5H20"/>'),
  line: svg('<path d="M5 19L19 5"/><circle cx="5" cy="19" r="1.6" fill="currentColor"/><circle cx="19" cy="5" r="1.6" fill="currentColor"/>'),
  lasso: svg('<path d="M12 4.5c-4.4 0-8 2.5-8 5.6 0 2 1.5 3.7 3.8 4.7" stroke-dasharray="2.6 2.4"/><path d="M12 4.5c4.4 0 8 2.5 8 5.6s-3.6 5.6-8 5.6c-.9 0-1.8-.1-2.6-.3" stroke-dasharray="2.6 2.4"/><circle cx="8.3" cy="15.6" r="1.7"/><path d="M8.6 17.3c.3 1.6-.4 2.8-2 3.4"/>'),
  cut: svg('<circle cx="7" cy="17.5" r="2.4"/><circle cx="17" cy="17.5" r="2.4"/><path d="M8.6 15.7L17.5 4M15.4 15.7L6.5 4"/>'),
  duplicate: svg('<rect x="8" y="8" width="11" height="12" rx="1.5"/><path d="M5 16V5.5A1.5 1.5 0 016.5 4H15"/><path d="M13.5 11.5v5M11 14h5"/>'),
  paste: svg('<rect x="6" y="5" width="12" height="15" rx="1.5"/><path d="M9.5 5V4a1 1 0 011-1h3a1 1 0 011 1v1"/><path d="M9.5 11h5M9.5 14.5h5"/>'),
  image: svg('<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.6"/><path d="M4 17l4.5-4.5 3.5 3.5 3-3 5 5"/>'),
  sidebar: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9.5 4.5v15"/><path d="M5.8 8h1.6M5.8 11h1.6M5.8 14h1.6"/>'),
  importFile: svg('<path d="M12 4v10M8 10.5l4 4 4-4"/><path d="M5 15.5V18a2 2 0 002 2h10a2 2 0 002-2v-2.5"/>'),
  star: svg('<path d="M12 4.2l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.6-4.8 2.6.9-5.4-3.9-3.8 5.4-.8z"/>'),
  search: svg('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.3-4.3"/>'),
  bookmark: svg('<path d="M7 4.5h10a1 1 0 011 1V20l-6-4-6 4V5.5a1 1 0 011-1z"/>'),
  grip: svg('<circle cx="9" cy="7" r="1.2" fill="currentColor"/><circle cx="15" cy="7" r="1.2" fill="currentColor"/><circle cx="9" cy="12" r="1.2" fill="currentColor"/><circle cx="15" cy="12" r="1.2" fill="currentColor"/><circle cx="9" cy="17" r="1.2" fill="currentColor"/><circle cx="15" cy="17" r="1.2" fill="currentColor"/>'),
  insert: svg('<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8.5v7M8.5 12h7"/>'),
  axes: svg('<path d="M6 19V5M4 7l2-2 2 2"/><path d="M5 18h14M17 16l2 2-2 2"/><path d="M8 15c3-1 4-6 8-8"/>'),
  rotate: svg('<path d="M19 12a7 7 0 11-2.3-5.2"/><path d="M19.5 4.5v4h-4"/>'),
  crop: svg('<path d="M7 3v14h14"/><path d="M3 7h14v14"/>'),
  undo: svg('<path d="M8 8H15a5 5 0 010 10H9"/><path d="M11 5L8 8l3 3"/>'),
  redo: svg('<path d="M16 8H9a5 5 0 000 10h6"/><path d="M13 5l3 3-3 3"/>'),
  pages: svg('<rect x="7" y="3.5" width="12" height="15" rx="1.5"/><path d="M5 7v12.5a1 1 0 001 1h10"/>'),
  folder: svg('<path d="M3.5 7a2 2 0 012-2h4l2 2.2h7a2 2 0 012 2V17a2 2 0 01-2 2h-13a2 2 0 01-2-2z"/>'),
  folderPlus: svg('<path d="M3.5 7a2 2 0 012-2h4l2 2.2h7a2 2 0 012 2V17a2 2 0 01-2 2h-13a2 2 0 01-2-2z"/><path d="M12 10.5v5M9.5 13h5"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  more: svg('<circle cx="12" cy="5.5" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="18.5" r="1.3" fill="currentColor"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  up: svg('<path d="M6 14l6-6 6 6"/>'),
  down: svg('<path d="M6 10l6 6 6-6"/>'),
  copy: svg('<rect x="8" y="8" width="11" height="12" rx="1.5"/><path d="M5 16V5.5A1.5 1.5 0 016.5 4H15"/>'),
  trash: svg('<path d="M5 7h14M10 7V4.5h4V7M7 7l.8 12a1 1 0 001 1h6.4a1 1 0 001-1L17 7"/>'),
  zoomIn: svg('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.3-4.3M11 8.5v5M8.5 11h5"/>'),
  zoomOut: svg('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.3-4.3M8.5 11h5"/>'),
  cloud: svg('<path d="M7 18.5a4 4 0 01-.6-7.95 5.5 5.5 0 0110.7-1.1A4.5 4.5 0 0117 18.5z"/>'),
  cloudOk: svg('<path d="M7 18.5a4 4 0 01-.6-7.95 5.5 5.5 0 0110.7-1.1A4.5 4.5 0 0117 18.5z"/><path d="M9.3 13.2l2 2 3.5-3.7"/>'),
  cloudOff: svg('<path d="M7 18.5a4 4 0 01-.6-7.95 5.5 5.5 0 0110.7-1.1A4.5 4.5 0 0117 18.5z"/><path d="M4 4l16 17"/>'),
  cloudUp: svg('<path d="M7 18.5a4 4 0 01-.6-7.95 5.5 5.5 0 0110.7-1.1A4.5 4.5 0 0117 18.5z"/><path d="M12 16.5v-5M9.8 13.5l2.2-2.2 2.2 2.2"/>'),
  cloudAlert: svg('<path d="M7 18.5a4 4 0 01-.6-7.95 5.5 5.5 0 0110.7-1.1A4.5 4.5 0 0117 18.5z"/><path d="M12 10.5v3.5"/><circle cx="12" cy="16.2" r=".6" fill="currentColor"/>'),
}

export function iconButton(icon: string, label: string, onClick: (e: MouseEvent) => void, cls = ''): HTMLButtonElement {
  return h('button', { class: `icon-btn ${cls}`, type: 'button', title: label, 'aria-label': label, html: icon, onClick })
}

// ---------- Brief messages ----------

let toastHost: HTMLElement | null = null

export function toast(text: string, ms = 3500): void {
  toastHost ??= document.body.appendChild(h('div', { class: 'toasts' }))
  const el = h('div', { class: 'toast', role: 'status' }, text)
  toastHost.append(el)
  setTimeout(() => el.remove(), ms)
}

// ---------- Dialogs ----------

export interface DialogHandle<T> {
  close(value: T | null): void
  root: HTMLDialogElement
}

/** Opens a modal dialog; the promise yields the chosen value, or null if cancelled. */
export function openDialog<T>(title: string, build: (d: DialogHandle<T>) => Child | Child[], cls = ''): Promise<T | null> {
  return new Promise((resolve) => {
    let result: T | null = null
    const root = h('dialog', { class: `dialog ${cls}` })
    const handle: DialogHandle<T> = {
      root,
      close(value) {
        result = value
        root.close()
      },
    }
    const content = build(handle)
    root.append(h('h2', {}, title), ...(Array.isArray(content) ? content : [content]).filter(Boolean) as Node[])
    root.addEventListener('close', () => {
      root.remove()
      resolve(result)
    })
    root.addEventListener('click', (e) => {
      if (e.target === root) root.close()
    })
    document.body.append(root)
    root.showModal()
  })
}

export function dialogButtons(...buttons: HTMLElement[]): HTMLElement {
  return h('div', { class: 'dialog-actions' }, ...buttons)
}

export function button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  return h('button', { class: `btn ${cls}`, type: 'button', onClick }, label)
}

export function promptDialog(title: string, label: string, value = '', okLabel = 'OK'): Promise<string | null> {
  return openDialog<string>(title, (d) => {
    const input = h('input', { type: 'text', value, maxLength: 120, autocomplete: 'off', enterKeyHint: 'done' })
    const submit = () => {
      const v = input.value.trim()
      if (v) d.close(v)
    }
    const form = h(
      'form',
      {
        onSubmit: (e: Event) => {
          e.preventDefault()
          submit()
        },
      },
      h('label', { class: 'field' }, h('span', {}, label), input),
      dialogButtons(button('Cancel', () => d.close(null)), h('button', { class: 'btn primary', type: 'submit' }, okLabel)),
    )
    setTimeout(() => {
      input.focus()
      input.select()
    })
    return form
  })
}

export async function confirmDialog(title: string, text: string, okLabel: string, danger = false): Promise<boolean> {
  const r = await openDialog<boolean>(title, (d) => [
    h('p', { class: 'dialog-text' }, text),
    dialogButtons(button('Cancel', () => d.close(null)), button(okLabel, () => d.close(true), danger ? 'danger' : 'primary')),
  ])
  return r === true
}

// ---------- Context menus ----------

export interface MenuItem {
  label: string
  icon?: string
  danger?: boolean
  action(): void
}

export function openMenu(anchor: HTMLElement, items: MenuItem[]): void {
  closePopovers()
  const menu = h(
    'div',
    { class: 'menu popover', role: 'menu' },
    ...items.map((it) =>
      h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          class: it.danger ? 'danger' : '',
          onClick: () => {
            closePopovers()
            it.action()
          },
        },
        it.icon ? h('span', { class: 'menu-icon', html: it.icon }) : null,
        it.label,
      ),
    ),
  )
  showPopover(anchor, menu)
}

let openPopover: HTMLElement | null = null
let popoverAnchor: HTMLElement | null = null

export function closePopovers(): void {
  openPopover?.remove()
  openPopover = null
  popoverAnchor = null
}

/** Shows `panel` below `anchor`; a second call on the same anchor closes it. */
export function showPopover(anchor: HTMLElement, panel: HTMLElement): boolean {
  if (popoverAnchor === anchor) {
    closePopovers()
    return false
  }
  closePopovers()
  document.body.append(panel)
  const a = anchor.getBoundingClientRect()
  const p = panel.getBoundingClientRect()
  const left = Math.max(8, Math.min(window.innerWidth - p.width - 8, a.left + a.width / 2 - p.width / 2))
  const below = a.bottom + 6
  const top = below + p.height > window.innerHeight - 8 ? Math.max(8, a.top - p.height - 6) : below
  panel.style.left = `${left}px`
  panel.style.top = `${top}px`
  openPopover = panel
  popoverAnchor = anchor
  return true
}

document.addEventListener(
  'pointerdown',
  (e) => {
    if (!openPopover) return
    const t = e.target as Node
    if (openPopover.contains(t) || popoverAnchor?.contains(t)) return
    closePopovers()
  },
  true,
)
