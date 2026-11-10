'use strict'

/* 把 icon.html 里的 SVG 按每个尺寸单独栅格化，避免缩放发虚。
   走 canvas 导出而不是窗口截图：截图会把透明背景压成白色。 */

const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const SIZES = [256, 128, 64, 48, 32, 24, 16]

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const dir = path.join(__dirname, '.iconset')
  fs.mkdirSync(dir, { recursive: true })

  const win = new BrowserWindow({
    width: 260,
    height: 260,
    useContentSize: true,
    x: -3000,
    y: -3000,
    show: false,
    frame: false,
    transparent: true,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: false }
  })
  win.setMenu(null)
  await win.loadFile(path.join(__dirname, 'icon.html'))


  for (const size of SIZES) {
    const dataUrl = await win.webContents.executeJavaScript('window.renderIcon(' + size + ')')
    const b64 = String(dataUrl).split(',')[1]
    if (!b64) throw new Error(size + 'px 导出失败')
    const buf = Buffer.from(b64, 'base64')
    fs.writeFileSync(path.join(dir, size + '.png'), buf)
    console.log('rendered', size, buf.length, 'bytes')
  }

  win.destroy()
  app.quit()
}).catch((e) => {
  console.error(e)
  app.exit(1)
})
