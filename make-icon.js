'use strict'

/* 把 .iconset 下的多尺寸 PNG 打包成单个 ICO（PNG 压缩条目，Vista 及以上原生支持） */

const fs = require('node:fs')
const path = require('node:path')

const SIZES = [16, 24, 32, 48, 64, 128, 256]
const dir = path.join(__dirname, '.iconset')
const out = path.join(__dirname, 'app.ico')

const images = SIZES.map((s) => {
  const file = path.join(dir, s + '.png')
  return { size: s, data: fs.readFileSync(file) }
})

const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // type = icon
header.writeUInt16LE(images.length, 4)

const entries = []
let offset = 6 + images.length * 16

for (const img of images) {
  const e = Buffer.alloc(16)
  e.writeUInt8(img.size >= 256 ? 0 : img.size, 0) // width (0 = 256)
  e.writeUInt8(img.size >= 256 ? 0 : img.size, 1) // height
  e.writeUInt8(0, 2) // palette
  e.writeUInt8(0, 3) // reserved
  e.writeUInt16LE(1, 4) // planes
  e.writeUInt16LE(32, 6) // bpp
  e.writeUInt32LE(img.data.length, 8)
  e.writeUInt32LE(offset, 12)
  entries.push(e)
  offset += img.data.length
}

fs.writeFileSync(out, Buffer.concat([header, ...entries, ...images.map((i) => i.data)]))
console.log('已生成', out, fs.statSync(out).size, '字节，含', images.length, '个尺寸')
