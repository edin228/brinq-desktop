// Pure tab rules for the main window. Electron objects stay in tab-window.js.

const HOME_ID = 1

// Home is permanent at position 1. Tab ids are never reused.
function createTabList() {
  let ids = [HOME_ID]
  let selected = HOME_ID
  let nextId = HOME_ID + 1
  // Remembers each tab's opener only to keep a run of opened tabs in click order.
  const openedFrom = new Map()

  const has = (id) => ids.includes(id)
  const select = (id) => {
    if (!has(id)) return false
    selected = id
    return true
  }
  const step = (delta) => {
    const index = ids.indexOf(selected)
    selected = ids[(index + delta + ids.length) % ids.length]
    return selected
  }

  return {
    ids: () => [...ids],
    has,
    selected: () => selected,
    select,
    // New tabs follow their opener, like a browser; anything else appends.
    add({ afterId = null, select: shouldSelect = false } = {}) {
      const id = nextId++
      const opener = ids.indexOf(afterId)
      if (opener === -1) ids.push(id)
      else {
        // Skip past earlier tabs opened from the same page and their children.
        const descends = (tab) => {
          for (let parent = openedFrom.get(tab); parent !== undefined; parent = openedFrom.get(parent)) {
            if (parent === afterId) return true
          }
          return false
        }
        let index = opener + 1
        while (index < ids.length && descends(ids[index])) index++
        ids.splice(index, 0, id)
      }
      if (afterId !== null) openedFrom.set(id, afterId)
      if (shouldSelect) selected = id
      return id
    },
    // Returns false for Home or unknown ids. Selection moves right, else left.
    remove(id) {
      if (id === HOME_ID || !has(id)) return false
      const index = ids.indexOf(id)
      ids = ids.filter((value) => value !== id)
      openedFrom.delete(id)
      if (selected === id) selected = ids[Math.min(index, ids.length - 1)]
      return true
    },
    next: () => step(1),
    previous: () => step(-1),
    // Ctrl+1..8 pick by position; Ctrl+9 always picks the last tab.
    idAtPosition: (position) => (position === 9 ? ids[ids.length - 1] : ids[position - 1]),
  }
}

function routeOf(url) {
  try { return new URL(url).pathname } catch { return '' }
}

function tabKind(url) {
  const route = routeOf(url)
  if (route === '/clients' || route.startsWith('/clients/')) return 'client'
  if (route.startsWith('/email')) return 'email'
  return 'page'
}

const BRAND = 'brinq'
const FALLBACK = { client: 'Client', email: 'Email', page: 'Brinq' }

// Page titles use "brinq | X", "X | brinq" and "X · Brinq". Remove only a
// boundary brand segment so names such as "A | B Holdings" stay intact.
function tabLabel(title, url) {
  let label = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : ''
  const lower = () => label.toLowerCase()
  for (const separator of [' | ', ' · ']) {
    if (lower().startsWith(`${BRAND}${separator}`)) label = label.slice(BRAND.length + separator.length).trim()
    if (lower().endsWith(`${separator}${BRAND}`)) label = label.slice(0, -(BRAND.length + separator.length)).trim()
  }
  if (!label || lower() === BRAND) return FALLBACK[tabKind(url)]
  return label
}

const FEATURE_TOKENS = new Set(['noopener', 'noreferrer'])

// Only ordinary link or window.open('_blank') opens become tabs. Named or
// sized pop-outs (email) and form posts keep their own window.
function openAsTab({ disposition, frameName = '', features = '', postBody = null }) {
  if (disposition !== 'background-tab' && disposition !== 'foreground-tab') return false
  if (postBody) return false
  if (frameName && frameName !== '_blank') return false
  return features.split(',').map((token) => token.trim().split('=')[0].toLowerCase())
    .every((name) => !name || FEATURE_TOKENS.has(name))
}

// Maps a keyDown to a tab action. Windows/Linux use Ctrl, macOS uses Cmd.
function shortcutAction(input, platform = process.platform) {
  if (!input || input.type !== 'keyDown' || input.isComposing) return null
  const primary = platform === 'darwin' ? input.meta : input.control
  const other = platform === 'darwin' ? input.control : input.meta
  const key = String(input.key || '')
  const code = String(input.code || '')
  const shift = !!input.shift
  const alt = !!input.alt
  // AltGr reports Ctrl+Alt on Windows; never treat it as a shortcut.
  if (alt || other) return null
  const once = (action) => (input.isAutoRepeat ? null : action)

  if (!primary) {
    if (key === 'F5') return shift ? 'reload-hard' : 'reload'
    if (key === 'F12' && !shift) return 'devtools'
    return null
  }
  const lower = key.toLowerCase()
  if (code === 'Tab' || key === 'Tab') return shift ? 'previous' : 'next'
  if (key === 'PageDown' && !shift) return 'next'
  if (key === 'PageUp' && !shift) return 'previous'
  if (lower === 't' && !shift) return once('new')
  if (lower === 'w' && !shift) return once('close')
  if (lower === 'r') return shift ? 'reload-hard' : 'reload'
  if (lower === 'i' && shift) return 'devtools'
  if (/^Digit[1-9]$/.test(code) && !shift) return `select-${code.slice(5)}`
  if (key === '=' || key === '+' || code === 'NumpadAdd') return 'zoom-in'
  if ((key === '-' || code === 'NumpadSubtract') && !shift) return 'zoom-out'
  if ((key === '0' || code === 'Numpad0') && !shift) return 'zoom-reset'
  return null
}

module.exports = { HOME_ID, createTabList, tabKind, tabLabel, openAsTab, shortcutAction }
