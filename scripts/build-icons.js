// Builds the app icons from assets/icon.svg with no image tooling beyond Node.
//   node scripts/build-icons.js          write the icons into assets/
//   node scripts/build-icons.js --check  exit 1 if any tracked icon differs
//
// Windows, Linux and the tray use the bare gradient owl. Each ICO frame is
// rasterised at its own size so the taskbar (24 px at 100% scaling) gets a
// real 24 px drawing instead of an OS downscale. macOS keeps the classic
// pre-Tahoe safe area: an 824 px plate inset 100 px in a 1024 px canvas.
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const ASSETS = path.join(__dirname, '..', 'assets')
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]

// The path sits in a flipped coordinate space: translate(0 1126) scale(0.1 -0.1).
const toViewBox = ([x, y]) => [0.1 * x, 1126 - 0.1 * y]

function readSource(svg) {
  const d = svg.match(/id="owl-path"[^>]*\sd="([^"]+)"/)[1]
  const stops = [...svg.matchAll(/<stop offset="([\d.]+)" stop-color="#([0-9A-Fa-f]{6})"/g)]
    .map(([, offset, hex]) => ({ offset: Number(offset), rgb: [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) }))
  return { commands: parsePath(d), stops }
}

// Supports the commands the owl uses: M/m, L/l, C/c and Z/z.
function parsePath(d) {
  const tokens = d.match(/[MmLlCcZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/g)
  const commands = []
  let index = 0
  let command = null
  let point = [0, 0]
  let start = [0, 0]
  const number = () => Number(tokens[index++])
  while (index < tokens.length) {
    if (/[A-Za-z]/.test(tokens[index])) command = tokens[index++]
    const relative = command === command.toLowerCase()
    const at = (x, y) => (relative ? [point[0] + x, point[1] + y] : [x, y])
    switch (command.toUpperCase()) {
      case 'M':
        point = start = at(number(), number())
        commands.push({ type: 'M', to: point })
        command = relative ? 'l' : 'L'
        break
      case 'L':
        point = at(number(), number())
        commands.push({ type: 'L', to: point })
        break
      case 'C': {
        const c1 = at(number(), number())
        const c2 = at(number(), number())
        point = at(number(), number())
        commands.push({ type: 'C', c1, c2, to: point })
        break
      }
      case 'Z':
        point = start
        commands.push({ type: 'Z' })
        break
    }
  }
  return commands
}

// Flattens the path into closed polygons after applying `transform`.
function flatten(commands, transform) {
  const polygons = []
  let polygon = null
  let last = null
  for (const command of commands) {
    if (command.type === 'M') {
      polygon = [transform(command.to)]
      polygons.push(polygon)
    } else if (command.type === 'L') {
      polygon.push(transform(command.to))
    } else if (command.type === 'C') {
      const p = [last, command.c1, command.c2, command.to].map(transform)
      const length = Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]) +
        Math.hypot(p[2][0] - p[1][0], p[2][1] - p[1][1]) +
        Math.hypot(p[3][0] - p[2][0], p[3][1] - p[2][1])
      const steps = Math.min(64, Math.max(2, Math.ceil(length / 0.5)))
      for (let step = 1; step <= steps; step++) {
        const t = step / steps
        const u = 1 - t
        polygon.push([0, 1].map((axis) =>
          u * u * u * p[0][axis] + 3 * u * u * t * p[1][axis] + 3 * u * t * t * p[2][axis] + t * t * t * p[3][axis]))
      }
    }
    if (command.to) last = command.to
  }
  return polygons
}

// Non-zero winding coverage with exact horizontal spans and `samples` rows per pixel.
function rasterize(polygons, width, height, samples) {
  const edges = []
  for (const polygon of polygons) {
    for (let i = 0; i < polygon.length; i++) {
      const [x0, y0] = polygon[i]
      const [x1, y1] = polygon[(i + 1) % polygon.length]
      if (y0 === y1) continue
      edges.push(y0 < y1 ? { x0, y0, x1, y1, dir: 1 } : { x0: x1, y0: y1, x1: x0, y1: y0, dir: -1 })
    }
  }
  const coverage = new Float32Array(width * height)
  const weight = 1 / samples
  for (let row = 0; row < height * samples; row++) {
    const y = (row + 0.5) / samples
    const crossings = []
    for (const edge of edges) {
      if (y < edge.y0 || y >= edge.y1) continue
      crossings.push({ x: edge.x0 + ((y - edge.y0) / (edge.y1 - edge.y0)) * (edge.x1 - edge.x0), dir: edge.dir })
    }
    crossings.sort((a, b) => a.x - b.x)
    const offset = Math.floor(y) * width
    let winding = 0
    for (let i = 0; i < crossings.length - 1; i++) {
      winding += crossings[i].dir
      if (winding === 0) continue
      let x = Math.max(0, crossings[i].x)
      const end = Math.min(width, crossings[i + 1].x)
      while (x < end) {
        const next = Math.min(Math.floor(x) + 1, end)
        coverage[offset + Math.floor(x)] += (next - x) * weight
        x = next
      }
    }
  }
  return coverage
}

function gradientAt(stops, t) {
  if (t <= stops[0].offset) return stops[0].rgb
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i].offset) {
      const local = (t - stops[i - 1].offset) / (stops[i].offset - stops[i - 1].offset)
      return stops[i].rgb.map((channel, c) => Math.round(stops[i - 1].rgb[c] + (channel - stops[i - 1].rgb[c]) * local))
    }
  }
  return stops[stops.length - 1].rgb
}

// Straight-alpha source-over onto an RGBA canvas.
function paint(canvas, width, coverage, colorAt, opacity = 1) {
  for (let i = 0; i < coverage.length; i++) {
    const alpha = Math.min(1, coverage[i]) * opacity
    if (alpha <= 0) continue
    const rgb = colorAt(Math.floor(i / width))
    const o = i * 4
    const below = canvas[o + 3] / 255
    const out = alpha + below * (1 - alpha)
    for (let c = 0; c < 3; c++) {
      canvas[o + c] = Math.round((rgb[c] * alpha + canvas[o + c] * below * (1 - alpha)) / out)
    }
    canvas[o + 3] = Math.round(out * 255)
  }
}

function owlBounds(commands) {
  const points = flatten(commands, toViewBox).flat()
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) }
}

// Fits the owl to `height` px with its top at `top`, centred in [boxLeft, boxLeft + boxWidth]
// and nudged 1.2% left so the head, which carries most of the weight, reads as centred.
// `spread` thickens the lines by roughly that many px on each side by taking the
// maximum coverage of copies shifted around a circle.
function drawOwl(canvas, size, source, bounds, { top, height, boxLeft, boxWidth, spread = 0 }) {
  const scale = height / (bounds.bottom - bounds.top)
  const left = boxLeft + (boxWidth - (bounds.right - bounds.left) * scale) / 2 - boxWidth * 0.012
  const samples = size <= 64 ? 16 : size <= 256 ? 8 : 4
  const shifts = spread ? [[0, 0], ...Array.from({ length: 8 }, (_, i) =>
    [spread * Math.cos((i * Math.PI) / 4), spread * Math.sin((i * Math.PI) / 4)])] : [[0, 0]]
  const coverage = new Float32Array(size * size)
  for (const [dx, dy] of shifts) {
    const transform = (point) => {
      const [x, y] = toViewBox(point)
      return [left + dx + (x - bounds.left) * scale, top + dy + (y - bounds.top) * scale]
    }
    rasterize(flatten(source.commands, transform), size, size, samples)
      .forEach((value, i) => { coverage[i] = Math.max(coverage[i], value) })
  }
  paint(canvas, size, coverage, (row) => gradientAt(source.stops, (top + height - (row + 0.5)) / height))
}

// The 16 and 20 px frames (title bar, tray) get a third of a pixel of extra
// weight; at the original weight almost half of their line pixels stay under
// 50% coverage and the head breaks up.
function bareOwl(size, source, bounds) {
  const canvas = new Uint8Array(size * size * 4)
  const margin = size <= 48 ? 1 : Math.round(size * 0.035)
  drawOwl(canvas, size, source, bounds, {
    top: margin, height: size - 2 * margin, boxLeft: 0, boxWidth: size, spread: size <= 20 ? 0.3 : 0,
  })
  return canvas
}

function roundedRect(x, y, width, height, radius) {
  const points = []
  const corners = [[x + width - radius, y + radius, -90], [x + width - radius, y + height - radius, 0],
    [x + radius, y + height - radius, 90], [x + radius, y + radius, 180]]
  for (const [cx, cy, from] of corners) {
    for (let step = 0; step <= 24; step++) {
      const angle = ((from + (step / 24) * 90) * Math.PI) / 180
      points.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)])
    }
  }
  return [points]
}

function boxBlur(values, width, height, radius) {
  const pass = (input, horizontal) => {
    const output = new Float32Array(input.length)
    const span = 2 * radius + 1
    for (let line = 0; line < (horizontal ? height : width); line++) {
      for (let i = 0; i < (horizontal ? width : height); i++) {
        let sum = 0
        for (let k = -radius; k <= radius; k++) {
          const j = Math.min((horizontal ? width : height) - 1, Math.max(0, i + k))
          sum += input[horizontal ? line * width + j : j * width + line]
        }
        output[horizontal ? line * width + i : i * width + line] = sum / span
      }
    }
    return output
  }
  let result = values
  for (let i = 0; i < 3; i++) result = pass(pass(result, true), false)
  return result
}

function macIcon(source, bounds) {
  const size = 1024
  const canvas = new Uint8Array(size * size * 4)
  const plate = roundedRect(100, 100, 824, 824, 185)
  const shadow = boxBlur(rasterize(plate.map((polygon) => polygon.map(([x, y]) => [x, y + 12])), size, size, 4), size, size, 8)
  paint(canvas, size, shadow, () => [0, 0, 0], 0.3)
  paint(canvas, size, rasterize(plate, size, size, 4), (row) => gradientAt(
    [{ offset: 0, rgb: [255, 255, 255] }, { offset: 1, rgb: [238, 240, 246] }], (row - 100) / 824))
  drawOwl(canvas, size, source, bounds, { top: 240, height: 544, boxLeft: 100, boxWidth: 824 })
  return canvas
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function encodePng(size, rgba) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 6
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

// 32-bit BMP frames below 256 px for the widest compatibility; PNG for 256 px.
function encodeIco(frames) {
  const images = frames.map(({ size, rgba }) => {
    if (size === 256) return encodePng(size, rgba)
    const maskRow = Math.ceil(size / 32) * 4
    const bmp = Buffer.alloc(40 + size * size * 4 + maskRow * size)
    bmp.writeUInt32LE(40, 0)
    bmp.writeInt32LE(size, 4)
    bmp.writeInt32LE(size * 2, 8)
    bmp.writeUInt16LE(1, 12)
    bmp.writeUInt16LE(32, 14)
    bmp.writeUInt32LE(size * size * 4 + maskRow * size, 20)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const from = (y * size + x) * 4
        const to = 40 + ((size - 1 - y) * size + x) * 4
        bmp[to] = rgba[from + 2]
        bmp[to + 1] = rgba[from + 1]
        bmp[to + 2] = rgba[from]
        bmp[to + 3] = rgba[from + 3]
      }
    }
    return bmp
  })
  const header = Buffer.alloc(6 + 16 * frames.length)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(frames.length, 4)
  let offset = header.length
  frames.forEach(({ size }, i) => {
    const entry = 6 + 16 * i
    header[entry] = size === 256 ? 0 : size
    header[entry + 1] = size === 256 ? 0 : size
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(images[i].length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += images[i].length
  })
  return Buffer.concat([header, ...images])
}

function buildIcons() {
  const source = readSource(fs.readFileSync(path.join(ASSETS, 'icon.svg'), 'utf8'))
  const bounds = owlBounds(source.commands)
  return {
    'icon.ico': encodeIco(ICO_SIZES.map((size) => ({ size, rgba: bareOwl(size, source, bounds) }))),
    'icon.png': encodePng(1024, bareOwl(1024, source, bounds)),
    'icon-mac.png': encodePng(1024, macIcon(source, bounds)),
    'tray-icon.png': encodePng(22, bareOwl(22, source, bounds)),
  }
}

module.exports = { buildIcons, ICO_SIZES }

if (require.main === module) {
  const icons = buildIcons()
  if (process.argv.includes('--check')) {
    const stale = Object.keys(icons).filter((name) => !icons[name].equals(fs.readFileSync(path.join(ASSETS, name))))
    if (stale.length) {
      console.error(`Out of date: ${stale.join(', ')}. Run node scripts/build-icons.js.`)
      process.exit(1)
    }
  } else {
    for (const [name, data] of Object.entries(icons)) fs.writeFileSync(path.join(ASSETS, name), data)
  }
}
