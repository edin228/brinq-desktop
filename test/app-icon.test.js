const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const { buildIcons, ICO_SIZES } = require('../scripts/build-icons')

const ASSETS = path.join(__dirname, '..', 'assets')
const icons = buildIcons()

function decodePng(buffer) {
  let offset = 8
  let width
  let height
  const data = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const body = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') [width, height] = [body.readUInt32BE(0), body.readUInt32BE(4)]
    if (type === 'IDAT') data.push(body)
    offset += 12 + length
  }
  const raw = zlib.inflateSync(Buffer.concat(data))
  const stride = width * 4
  const rgba = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * (stride + 1)], 0, 'build-icons writes unfiltered rows')
    raw.copy(rgba, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1))
  }
  return { width, height, alpha: (x, y) => rgba[(y * width + x) * 4 + 3] }
}

function icoFrames(buffer) {
  return Array.from({ length: buffer.readUInt16LE(4) }, (_, i) => {
    const entry = 6 + 16 * i
    const size = buffer[entry] || 256
    const image = buffer.subarray(buffer.readUInt32LE(entry + 12), buffer.readUInt32LE(entry + 12) + buffer.readUInt32LE(entry + 8))
    if (image.readUInt32BE(0) === 0x89504e47) return { size, png: true, ...decodePng(image) }
    return { size, png: false, alpha: (x, y) => image[40 + ((size - 1 - y) * size + x) * 4 + 3] }
  })
}

function opaqueRows(frame) {
  const rows = []
  for (let y = 0; y < frame.size; y++) {
    for (let x = 0; x < frame.size; x++) if (frame.alpha(x, y) >= 128) { rows.push(y); break }
  }
  return rows
}

test('tracked icons match what scripts/build-icons.js generates from assets/icon.svg', () => {
  for (const [name, data] of Object.entries(icons)) {
    assert.ok(data.equals(fs.readFileSync(path.join(ASSETS, name))), `${name} is stale; run node scripts/build-icons.js`)
  }
})

test('the Windows icon carries a bare owl frame for every shell size', () => {
  const frames = icoFrames(icons['icon.ico'])
  assert.deepEqual(frames.map((frame) => frame.size), ICO_SIZES)
  assert.deepEqual(frames.filter((frame) => frame.png).map((frame) => frame.size), [256])
  for (const frame of frames) {
    const last = frame.size - 1
    for (const [x, y] of [[0, 0], [last, 0], [0, last], [last, last]]) {
      assert.equal(frame.alpha(x, y), 0, `${frame.size} px frame has no tile behind the owl`)
    }
    const rows = opaqueRows(frame)
    assert.ok(rows.length / frame.size >= 0.85, `${frame.size} px owl fills ${rows.length} of ${frame.size} rows`)
  }
})

test('the macOS icon keeps the pre-Tahoe safe area around an opaque plate', () => {
  const mac = decodePng(icons['icon-mac.png'])
  assert.deepEqual([mac.width, mac.height], [1024, 1024])
  assert.equal(mac.alpha(0, 0), 0)
  assert.equal(mac.alpha(512, 60), 0, 'nothing is drawn above the 100 px inset')
  assert.equal(mac.alpha(512, 512), 255)
  assert.equal(mac.alpha(120, 512), 255, 'the plate starts at the 100 px inset')
})
