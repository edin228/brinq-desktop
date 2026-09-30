// Renders the production strip (markup, CSS and script) with a stub bridge,
// in the states drawn on the Paper page "Desktop · Tab header bar".
//   ?state=home-hover|client|refreshing|many|failed|stress&theme=dark|light
const params = new URLSearchParams(location.search)
const client = (id, label, extra = {}) => ({ id, home: false, label, kind: 'client', loading: false, failed: null, ...extra })
const home = { id: 1, home: true, label: 'Brinq', kind: 'page', loading: false, failed: null }
const three = [
  client(2, 'Law Office of Torres & Brenner'),
  client(3, 'Topknot Hospitality Group, LLC'),
  client(4, 'New Life Church & Literary Foundation'),
]
const eight = [
  client(2, 'Law Office of Torres & Brenner'), client(5, 'VBH LLC'), client(6, 'Golden Nail Service LLC'),
  client(7, 'Jamie Adams'), client(8, 'Stephen L. Cawelti, APC'), client(9, 'Nudibranch LLC'),
  client(3, 'Topknot Hospitality Group, LLC'), client(4, 'New Life Church & Literary Foundation'),
]
const stress = Array.from({ length: 24 }, (_, index) => {
  const labels = ['Client', 'Client 1234', 'The Extremely Long Legal Name of a Holding Company That Keeps Going, Incorporated', 'Brinq']
  return client(10 + index, labels[index % labels.length], { kind: index % 5 === 4 ? 'email' : index % 7 === 6 ? 'page' : 'client' })
})
const states = {
  'home-hover': { selectedId: 1, tabs: [home, ...three] },
  client: { selectedId: 3, tabs: [home, ...three] },
  refreshing: { selectedId: 3, tabs: [home, three[0], { ...three[1], loading: true }, three[2]] },
  many: { selectedId: 3, tabs: [home, ...eight] },
  failed: { selectedId: 3, tabs: [home, three[0], { ...three[1], failed: 'load' }, three[2]] },
  stress: { selectedId: 33, tabs: [home, ...stress] },
}
const state = { platform: 'win32', theme: params.get('theme') === 'light' ? 'light' : 'dark', ...(states[params.get('state')] || states['home-hover']) }

const html = await (await fetch('/src/shell/shell.html')).text()
const shell = new DOMParser().parseFromString(html, 'text/html')
document.body.replaceWith(document.importNode(shell.body, true))
// Reserve the native window buttons' width, as the Windows overlay does.
document.documentElement.style.setProperty('--controls-right', '138px')
const calls = []
window.__calls = calls
window.brinqTabs = {
  onState(callback) { callback(state); return () => {} },
  select: (id, focus) => calls.push(['select', id, focus]),
  close: (id) => calls.push(['close', id]),
  retry: (id) => calls.push(['retry', id]),
  newTab: () => calls.push(['new']),
  home: (focus) => calls.push(['home', focus]),
  reload: () => calls.push(['reload']),
}
const script = document.createElement('script')
script.src = '/src/shell/shell.js'
document.head.append(script)
