// Renders the tab strip from state pushed by the main process. Page titles
// are untrusted: they are only ever written with textContent.
const ICONS = {
  home: '<svg width="16" height="16" viewBox="0 0 24 24"><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  refresh: '<svg width="15" height="15" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>',
  plus: '<svg width="15" height="15" viewBox="0 0 24 24"><path d="M5 12h14"/><path d="M12 5v14"/></svg>',
  close: '<svg width="12" height="12" viewBox="0 0 24 24"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
  client: '<svg width="14" height="14" viewBox="0 0 24 24"><path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/></svg>',
  email: '<svg width="14" height="14" viewBox="0 0 24 24"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>',
  page: '<svg width="14" height="14" viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 4v4"/><path d="M2 8h20"/><path d="M6 4v4"/></svg>',
  spinner: '<svg class="spinner" width="14" height="14" viewBox="0 0 14 14"><circle class="track" cx="7" cy="7" r="5.5"/><path class="arc" d="M7 1.5a5.5 5.5 0 0 1 5.5 5.5"/></svg>',
}

const FAILURES = {
  load: ['This page couldn’t load', 'Check your connection and try again.'],
  crash: ['This tab stopped working', 'Try again to reload the page.'],
}

const bridge = window.brinqTabs
const root = document.documentElement
const homeButton = document.querySelector('.home')
const tabsElement = document.querySelector('.tabs')
const refreshButton = document.querySelector('.refresh')
const newTabButton = document.querySelector('.new-tab')
const panel = document.querySelector('.panel')
const retryButton = panel.querySelector('.retry')
const tabElements = new Map()
let state = { tabs: [], selectedId: 1 }
let focusedId = null

homeButton.innerHTML = ICONS.home
refreshButton.innerHTML = ICONS.refresh
newTabButton.innerHTML = ICONS.plus

function iconHtml(tab) {
  return tab.loading ? ICONS.spinner : ICONS[tab.kind] || ICONS.page
}

function createTab(tab) {
  const wrapper = document.createElement('div')
  wrapper.className = 'tab'
  const select = document.createElement('button')
  select.type = 'button'
  select.className = 'tab-select'
  select.id = `tab-${tab.id}`
  select.setAttribute('role', 'tab')
  const icon = document.createElement('span')
  icon.className = 'tab-icon'
  const label = document.createElement('span')
  label.className = 'tab-label'
  select.append(icon, label)
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'tab-close'
  close.tabIndex = -1
  close.innerHTML = ICONS.close
  close.addEventListener('click', (event) => {
    event.stopPropagation()
    bridge.close(tab.id)
  })
  wrapper.append(select, close)
  // Middle-click closes, like a browser; suppress its autoscroll.
  wrapper.addEventListener('mousedown', (event) => { if (event.button === 1) event.preventDefault() })
  wrapper.addEventListener('auxclick', (event) => {
    if (event.button === 1) { event.preventDefault(); bridge.close(tab.id) }
  })
  select.addEventListener('click', () => {
    // The click that ends a drag only drops the tab.
    if (element.justDragged) { element.justDragged = false; return }
    bridge.select(tab.id, true)
  })
  wrapper.addEventListener('pointerdown', (event) => startDrag(event, tab.id))
  const element = { wrapper, select, icon, label, close, iconKey: null, justDragged: false }
  tabElements.set(tab.id, element)
  return element
}

function updateTab(element, tab, selected) {
  const iconKey = tab.loading ? 'spinner' : tab.kind
  if (element.iconKey !== iconKey) {
    element.icon.innerHTML = iconHtml(tab)
    element.iconKey = iconKey
  }
  if (element.label.textContent !== tab.label) element.label.textContent = tab.label
  element.select.title = tab.label
  element.close.setAttribute('aria-label', `Close ${tab.label}`)
  element.close.title = 'Close tab'
  element.select.setAttribute('aria-selected', String(selected))
  element.wrapper.classList.toggle('selected', selected)
}

// Keyboard order follows the tabs as displayed, including reorders.
function focusable() {
  return [homeButton, ...tabsElement.querySelectorAll('.tab-select')]
}

function idOf(button) {
  return Number(button.id.slice(4))
}

// One tab in the list is tabbable: the focused one, else the selected one.
function updateRovingFocus() {
  const current = focusedId !== null && (focusedId === 1 || tabElements.has(focusedId)) ? focusedId : state.selectedId
  for (const button of focusable()) button.tabIndex = idOf(button) === current ? 0 : -1
}

function render(next) {
  const previousSelected = state.selectedId
  state = next
  // Moving a node blurs it; put keyboard focus back after reordering.
  const focused = document.activeElement
  if (drag && !next.tabs.some((tab) => tab.id === drag.id)) clearDrag()
  root.dataset.theme = next.theme === 'light' ? 'light' : 'dark'
  root.dataset.platform = next.platform || ''
  const home = next.tabs.find((tab) => tab.home)
  homeButton.setAttribute('aria-selected', String(next.selectedId === 1))
  homeButton.title = home && home.label !== 'Brinq' ? `Home: ${home.label}` : 'Home'

  const live = new Set()
  let previous = null
  for (const tab of next.tabs) {
    if (tab.home) continue
    live.add(tab.id)
    const element = tabElements.get(tab.id) || createTab(tab)
    updateTab(element, tab, tab.id === next.selectedId)
    // Move only when out of order so focused nodes are not recreated.
    const expected = previous ? previous.nextSibling : tabsElement.firstChild
    if (expected !== element.wrapper) tabsElement.insertBefore(element.wrapper, expected)
    previous = element.wrapper
  }
  for (const [id, element] of tabElements) {
    if (live.has(id)) continue
    const hadFocus = element.wrapper.contains(document.activeElement)
    element.wrapper.remove()
    tabElements.delete(id)
    if (hadFocus) {
      focusedId = next.selectedId
      ;(tabElements.get(next.selectedId)?.select || homeButton).focus()
    }
  }
  updateRovingFocus()
  if (focused && focused !== document.activeElement && focused.isConnected) focused.focus()

  const selected = next.tabs.find((tab) => tab.id === next.selectedId)
  refreshButton.dataset.loading = String(!!selected?.loading)
  if (next.selectedId !== previousSelected) {
    tabElements.get(next.selectedId)?.wrapper.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  const failure = selected && selected.failed && FAILURES[selected.failed]
  panel.hidden = !failure
  if (failure) {
    panel.querySelector('.panel-title').textContent = failure[0]
    panel.querySelector('.panel-text').textContent = failure[1]
    retryButton.disabled = false
    retryButton.dataset.id = String(selected.id)
  }
}

// Dragging a tab reorders it: the others slide aside and the tab drops into
// the gap. A press that barely moves stays an ordinary click.
const DRAG_THRESHOLD = 5
const TAB_GAP = 2
let drag = null

function startDrag(event, id) {
  if (event.button !== 0 || event.target.closest('.tab-close') || drag) return
  const element = tabElements.get(id)
  const order = [...tabsElement.children]
  drag = {
    id, element, order, pointerId: event.pointerId, startX: event.clientX, moved: false,
    from: order.indexOf(element.wrapper), to: order.indexOf(element.wrapper),
    step: element.wrapper.getBoundingClientRect().width + TAB_GAP,
  }
}

function moveDrag(event) {
  if (!drag || event.pointerId !== drag.pointerId) return
  const dx = event.clientX - drag.startX
  if (!drag.moved && Math.abs(dx) < DRAG_THRESHOLD) return
  if (!drag.moved) {
    drag.moved = true
    tabsElement.classList.add('reordering')
    drag.element.wrapper.classList.add('dragging')
    // Capture only once this is a drag: capturing on press would retarget the
    // click to the wrapper and a plain click would no longer select the tab.
    // A pointer the browser does not track (synthetic input) goes without it.
    try { drag.element.wrapper.setPointerCapture(event.pointerId) } catch {}
  }
  // Keep the tab inside the tray.
  const minDx = -drag.from * drag.step
  const maxDx = (drag.order.length - 1 - drag.from) * drag.step
  const offset = Math.min(Math.max(dx, minDx), maxDx)
  drag.element.wrapper.style.transform = `translateX(${offset}px)`
  drag.to = Math.min(Math.max(Math.round(drag.from + offset / drag.step), 0), drag.order.length - 1)
  drag.order.forEach((wrapper, index) => {
    if (wrapper === drag.element.wrapper) return
    const shift = drag.from < index && index <= drag.to ? -drag.step
      : drag.to <= index && index < drag.from ? drag.step : 0
    wrapper.style.transform = shift ? `translateX(${shift}px)` : ''
  })
}

function clearDrag() {
  const current = drag
  drag = null
  for (const wrapper of current.order) wrapper.style.transform = ''
  tabsElement.classList.remove('reordering')
  current.element.wrapper.classList.remove('dragging')
  return current
}

function endDrag(event, cancelled = false) {
  if (!drag || event.pointerId !== drag.pointerId) return
  const { element, from, to, moved, id } = clearDrag()
  if (!moved) return
  element.justDragged = true
  // A pointer that never produces a click must not swallow the next one.
  setTimeout(() => { element.justDragged = false })
  // The tab may have closed during the drag; never put back a stale copy.
  if (cancelled || from === to || tabElements.get(id) !== element || element.wrapper.parentNode !== tabsElement) return
  // Show the new order at once; main confirms it with the next state.
  const others = [...tabsElement.children].filter((wrapper) => wrapper !== element.wrapper)
  tabsElement.insertBefore(element.wrapper, others[to] || null)
  // Positions count Home as 0.
  bridge.move(id, to + 1)
}

// Listen on the document so a release outside the tray still ends the drag.
document.addEventListener('pointermove', moveDrag)
document.addEventListener('pointerup', (event) => endDrag(event))
document.addEventListener('pointercancel', (event) => endDrag(event, true))

homeButton.addEventListener('click', () => bridge.home(true))
refreshButton.addEventListener('click', () => bridge.reload())
newTabButton.addEventListener('click', () => bridge.newTab())
retryButton.addEventListener('click', () => {
  retryButton.disabled = true
  bridge.retry(Number(retryButton.dataset.id))
})

// Arrow keys move focus within the tab list; Enter/Space selects; Delete closes.
document.querySelector('.tablist').addEventListener('keydown', (event) => {
  const buttons = focusable()
  const index = buttons.indexOf(document.activeElement)
  if (index === -1) return
  let target = null
  if (event.key === 'ArrowRight') target = buttons[(index + 1) % buttons.length]
  else if (event.key === 'ArrowLeft') target = buttons[(index - 1 + buttons.length) % buttons.length]
  else if (event.key === 'Home') target = buttons[0]
  else if (event.key === 'End') target = buttons[buttons.length - 1]
  else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    const id = idOf(buttons[index])
    if (id === 1) bridge.home(false)
    else bridge.select(id, false)
    return
  } else if (event.key === 'Delete' && index > 0) {
    event.preventDefault()
    bridge.close(idOf(buttons[index]))
    return
  }
  if (!target) return
  event.preventDefault()
  focusedId = idOf(target)
  updateRovingFocus()
  target.focus()
  target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
})

document.querySelector('.tablist').addEventListener('focusin', (event) => {
  const button = event.target.closest('[role="tab"]')
  if (button) { focusedId = idOf(button); updateRovingFocus() }
})

bridge.onState(render)
