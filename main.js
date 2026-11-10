'use strict'

const {
  app, BrowserWindow, WebContentsView, ipcMain, shell, session, Tray, Menu,
  nativeImage, screen, nativeTheme
} = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const APP_NAME = 'Mbots'
const HOME_URL = 'https://muse.ai/'
const TITLEBAR_HEIGHT = 52
const SIDEBAR_WIDTH = 276
const DEFAULT_ACCOUNTS = 3

const SLEEP_SWEEP_MS = 20 * 1000
const METRICS_MS = 4000

// ---------- 用户设置 ----------
const DEFAULT_SETTINGS = {
  theme: 'dark',         // light | dark | system（与 muse 一致）
  accent: 'muse',        // muse deep sky indigo emerald rose
  fontSize: 'medium',    // small | medium | large
  compact: false,
  motion: true,
  sleepMin: 5,           // 0 = 永不休眠
  closeAction: 'ask',    // ask | tray | quit —— 点右上角关闭时的行为
  autoLaunch: false
}
let settings = { ...DEFAULT_SETTINGS }
let settingsFile = ''

function loadSettings () {
  settingsFile = path.join(app.getPath('userData'), 'settings.json')
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
    if (raw && typeof raw === 'object') {
      // 旧版本主题（dim/pure/night）统一归到深色
      if (['dim', 'pure', 'night'].includes(raw.theme)) raw.theme = 'dark'
      // 旧的「关闭时退出」开关迁到三选一的 closeAction
      if (!raw.closeAction && Object.prototype.hasOwnProperty.call(raw, 'quitOnClose')) {
        raw.closeAction = raw.quitOnClose === false ? 'tray' : 'ask'
      }
      delete raw.quitOnClose
      settings = { ...DEFAULT_SETTINGS, ...raw }
    }
  } catch { /* 首次运行 */ }
}

function saveSettings () {
  if (!settingsFile) settingsFile = path.join(app.getPath('userData'), 'settings.json')
  try {
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8')
  } catch (e) {
    console.error('保存设置失败:', e.message)
  }
}

// 后台账号闲置多久后休眠（销毁渲染进程，保留 cookie / 地址）
function sleepAfterMs () {
  const m = Number(settings.sleepMin)
  return m > 0 ? m * 60 * 1000 : Infinity
}

// ---------- 数据目录：迁移到 Mbots，同时保住旧的已登录分区 ----------
function setupUserData () {
  const base = app.getPath('appData')
  // 调试用：MBOTS_DATA_DIR 指向独立数据目录，便于与已安装版同时运行
  const target = process.env.MBOTS_DATA_DIR
    ? path.resolve(process.env.MBOTS_DATA_DIR)
    : path.join(base, 'Mbots')
  const legacy = path.join(base, 'muse-switcher')

  if (!process.env.MBOTS_DATA_DIR && !fs.existsSync(target) && fs.existsSync(legacy)) {
    try {
      fs.cpSync(legacy, target, { recursive: true, force: false, errorOnExist: false })
      console.log('[Mbots] 已从旧数据目录迁移:', legacy, '->', target)
    } catch (e) {
      console.error('[Mbots] 迁移失败，继续使用旧目录:', e.message)
      app.setPath('userData', legacy)
      return
    }
  }
  try { fs.mkdirSync(target, { recursive: true }) } catch { /* ignore */ }
  app.setPath('userData', target)
}
setupUserData()

// 这些域名下的弹窗用内部窗口打开，保证登录 cookie 写回同一个隔离分区
const INTERNAL_HOSTS = new Set([
  'muse.ai', 'www.muse.ai',
  'accounts.google.com', 'accounts.youtube.com',
  'www.facebook.com', 'facebook.com', 'web.facebook.com', 'm.facebook.com',
  'login.microsoftonline.com', 'appleid.apple.com',
  'twitter.com', 'x.com'
])

// ---------- 去掉 Electron 标识，避免站点识别为非常规客户端 ----------
const CLEAN_UA = String(app.userAgentFallback || '')
  .replace(/\sElectron\/[\d.]+/i, '')
  .replace(/\smuse-switcher\/[\d.]+/i, '')
  .replace(/\sMbots\/[\d.]+/i, '')
  .replace(/\s{2,}/g, ' ')
  .trim()
app.userAgentFallback = CLEAN_UA

// 少开无用进程 / 少占内存的开关
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling,MediaSessionService')

let win = null
let state = null
let stateFile = ''
let attachedId = null

// id -> { view, lastUsed }
const views = new Map()

let pushTimer = null
let metricsTimer = null
let sweepTimer = null
// 命令面板打开时临时隐藏原生视图，否则 WebContentsView 会盖在 DOM 之上
let overlayOn = false

let tray = null
let isQuitting = false

// ================= 状态持久化 =================
function initStateFile () {
  stateFile = path.join(app.getPath('userData'), 'accounts.json')
}

function loadState () {
  initStateFile()
  let raw = null
  try {
    raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  } catch { /* 首次运行 */ }

  const valid = raw && Array.isArray(raw.accounts) && raw.accounts.length > 0
  if (!valid) {
    raw = { seq: 0, accounts: [], active: null }
    for (let i = 1; i <= DEFAULT_ACCOUNTS; i++) {
      raw.seq += 1
      raw.accounts.push({
        id: 'acc' + raw.seq,
        name: '账号 ' + i,
        partition: 'persist:muse-acc' + raw.seq,
        lastUrl: ''
      })
    }
    raw.active = raw.accounts[0].id
  }
  state = raw
  if (!state.active || !state.accounts.some((a) => a.id === state.active)) {
    state.active = state.accounts[0] ? state.accounts[0].id : null
  }
  saveState()
}

function saveState () {
  if (!stateFile) initStateFile()
  try {
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8')
  } catch (e) {
    console.error('保存账号状态失败:', e.message)
  }
}

// ================= 工具 =================
function hostOf (url) {
  try { return new URL(url).hostname.toLowerCase() } catch { return '' }
}

function looksLikeLogin (url) {
  if (!url) return false
  const u = url.toLowerCase()
  return /(\/login|\/signin|\/signup|\/auth|checkpoint|oauth)/.test(u)
}

function findAccount (id) {
  return state.accounts.find((a) => a.id === id) || null
}

// ================= 视图生命周期 =================
function buildView (acc) {
  const view = new WebContentsView({
    webPreferences: {
      partition: acc.partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // 后台时让 Chromium 主动降频，省 CPU
      backgroundThrottling: true
    }
  })

  const wc = view.webContents
  wc.setUserAgent(CLEAN_UA)
  wc.setVisualZoomLevelLimits(1, 3).catch(() => {})

  wc.setWindowOpenHandler(({ url }) => {
    const h = hostOf(url)
    if (h && INTERNAL_HOSTS.has(h)) {
      const child = new BrowserWindow({
        width: 1000,
        height: 780,
        autoHideMenuBar: true,
        backgroundColor: '#ffffff',
        webPreferences: {
          partition: acc.partition,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true
        }
      })
      child.setMenu(null)
      child.loadURL(url)
      return { action: 'deny' }
    }
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  const bump = () => pushState()
  wc.on('did-start-loading', bump)
  wc.on('did-stop-loading', bump)
  wc.on('did-navigate', (_e, url) => {
    acc.lastUrl = url
    saveState()
    bump()
  })
  wc.on('did-navigate-in-page', (_e, url) => {
    acc.lastUrl = url
    bump()
  })
  wc.on('page-title-updated', (_e, t) => {
    if (acc.id === state.active && win && !win.isDestroyed()) {
      // 页面标题常常已经含账号名（Chat — Sunny），别再拼一遍
      const nm = String(t || '').trim().slice(0, 48)
      const label = nm && !nm.includes(acc.name) ? nm + ' · ' + acc.name : acc.name
      win.setTitle(label + ' — ' + APP_NAME)
    }
    bump()
  })
  wc.on('before-input-event', handleHotkey)
  wc.on('render-process-gone', () => {
    // 渲染进程崩了就当它睡过去，下次进来重新加载
    views.delete(acc.id)
    bump()
  })

  view.setBackgroundColor('#ffffff')
  wc.loadURL(acc.lastUrl && acc.lastUrl.startsWith('http') ? acc.lastUrl : HOME_URL)
  return view
}

function ensureView (acc) {
  const rec = views.get(acc.id)
  if (rec) {
    const wc = rec.view.webContents
    if (wc && !wc.isDestroyed()) return rec
    views.delete(acc.id)
  }
  const view = buildView(acc)
  const fresh = { view, lastUsed: Date.now() }
  views.set(acc.id, fresh)
  return fresh
}

function detachCurrent () {
  if (!win || !attachedId || win.isDestroyed()) return
  const rec = views.get(attachedId)
  if (rec) {
    try { win.contentView.removeChildView(rec.view) } catch { /* 已移除 */ }
  }
  attachedId = null
}

/**
 * 休眠：把渲染进程整个销毁，释放内存。
 * cookie 在 persist: 分区里，lastUrl 在 accounts.json 里，唤醒时直接回到原页面。
 */
function sleepView (id) {
  const rec = views.get(id)
  if (!rec) return false
  if (attachedId === id) detachCurrent()
  try {
    const wc = rec.view.webContents
    if (wc && !wc.isDestroyed()) wc.close()
  } catch { /* ignore */ }
  views.delete(id)
  pushState()
  return true
}

function sleepBackground () {
  let n = 0
  for (const id of Array.from(views.keys())) {
    if (id === state.active) continue
    if (sleepView(id)) n++
  }
  return n
}

function resizeView (view) {
  if (!win || !view || win.isDestroyed()) return
  const [w, h] = win.getContentSize()
  view.setBounds({
    x: SIDEBAR_WIDTH,
    y: TITLEBAR_HEIGHT,
    width: Math.max(0, w - SIDEBAR_WIDTH),
    height: Math.max(0, h - TITLEBAR_HEIGHT)
  })
}

function attach (id) {
  const rec = views.get(id)
  if (!rec || !win) return
  if (attachedId === id) {
    try { rec.view.setVisible(!overlayOn) } catch { /* ignore */ }
    resizeView(rec.view)
    return
  }
  detachCurrent()
  win.contentView.addChildView(rec.view)
  attachedId = id
  try { rec.view.setVisible(!overlayOn) } catch { /* ignore */ }
  resizeView(rec.view)
}

// 命令面板：把当前页面藏起来，露出底下的界面层
function setOverlay (on) {
  overlayOn = !!on
  if (!win || win.isDestroyed()) return false
  const rec = views.get(attachedId)
  if (rec) {
    try { rec.view.setVisible(!overlayOn) } catch { /* ignore */ }
  }
  if (overlayOn) win.webContents.focus()
  else if (rec) {
    const wc = rec.view.webContents
    if (wc && !wc.isDestroyed()) wc.focus()
  }
  return true
}

// ================= 账号操作 =================
function activate (id) {
  if (!win || win.isDestroyed()) return false
  const acc = findAccount(id)
  if (!acc) return false

  const rec = ensureView(acc)
  attach(id)
  rec.lastUsed = Date.now()

  state.active = id
  saveState()
  syncTitle()
  pushState()

  const wc = rec.view.webContents
  if (wc && !wc.isDestroyed()) wc.focus()
  return true
}

function syncTitle () {
  if (!win || win.isDestroyed()) return
  const acc = findAccount(state.active)
  win.setTitle(acc ? acc.name + ' — ' + APP_NAME : APP_NAME)
}

function addAccount (name) {
  state.seq = (state.seq || 0) + 1
  const acc = {
    id: 'acc' + state.seq,
    name: (name && String(name).trim()) || ('账号 ' + (state.accounts.length + 1)),
    partition: 'persist:muse-acc' + state.seq,
    lastUrl: ''
  }
  state.accounts.push(acc)
  saveState()
  activate(acc.id)
  return acc.id
}

function renameAccount (id, name) {
  const acc = findAccount(id)
  if (!acc) return false
  const t = String(name || '').trim()
  if (!t) return false
  acc.name = t.slice(0, 24)
  saveState()
  syncTitle()
  pushState()
  return true
}

async function removeAccount (id) {
  if (state.accounts.length <= 1) return { ok: false, error: '至少要保留一个账号' }
  const acc = findAccount(id)
  if (!acc) return { ok: false, error: '账号不存在' }

  sleepView(id)
  try { await session.fromPartition(acc.partition).clearStorageData() } catch { /* ignore */ }

  state.accounts = state.accounts.filter((a) => a.id !== id)
  if (state.active === id) state.active = state.accounts[0].id
  saveState()

  if (!attachedId) activate(state.active)
  else pushState()
  return { ok: true }
}

// ================= 对外状态 =================
function publicState () {
  const accounts = state.accounts.map((a) => {
    const rec = views.get(a.id)
    const wc = rec ? rec.view.webContents : null
    const alive = !!(wc && !wc.isDestroyed())
    const url = alive ? wc.getURL() : (a.lastUrl || '')
    return {
      id: a.id,
      name: a.name,
      url,
      title: alive ? wc.getTitle() : '',
      loading: alive ? wc.isLoading() : false,
      asleep: !alive,
      needsLogin: looksLikeLogin(url)
    }
  })
  return { active: state.active, accounts, awake: views.size }
}

function pushState () {
  if (!win || win.isDestroyed()) return
  if (pushTimer) return
  pushTimer = setTimeout(() => {
    pushTimer = null
    if (win && !win.isDestroyed()) win.webContents.send('state', publicState())
  }, 120)
}

function startMetrics () {
  if (metricsTimer) return
  metricsTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return
    let kb = 0
    let procs = 0
    try {
      for (const p of app.getAppMetrics()) {
        kb += (p.memory && p.memory.workingSetSize) || 0
        procs++
      }
    } catch { /* ignore */ }
    win.webContents.send('metrics', {
      mb: Math.round(kb / 1024),
      procs,
      awake: views.size,
      total: state.accounts.length
    })
  }, METRICS_MS)
}

function startSweeper () {
  if (sweepTimer) return
  sweepTimer = setInterval(() => {
    const ttl = sleepAfterMs()
    if (!Number.isFinite(ttl)) return
    const now = Date.now()
    for (const [id, rec] of Array.from(views.entries())) {
      if (id === state.active) continue
      if (now - rec.lastUsed >= ttl) sleepView(id)
    }
  }, SLEEP_SWEEP_MS)
}

// ================= 快捷键 =================
function handleHotkey (event, input) {
  if (input.type !== 'keyDown') return
  const mod = input.control || input.meta
  if (!mod || input.alt) return
  const key = String(input.key || '')
  const k = key.toLowerCase()

  if (/^[1-9]$/.test(key)) {
    const acc = state.accounts[Number(key) - 1]
    if (acc) {
      event.preventDefault()
      activate(acc.id)
    }
    return
  }
  if (k === 't') {
    event.preventDefault()
    addAccount()
  } else if (k === 'r') {
    event.preventDefault()
    const rec = views.get(state.active)
    if (rec) rec.view.webContents.reload()
  } else if (k === 'k') {
    event.preventDefault()
    if (win && !win.isDestroyed()) win.webContents.send('open-palette')
  } else if (k === ',') {
    event.preventDefault()
    if (win && !win.isDestroyed()) win.webContents.send('open-settings')
  }
}

// 把窗口提到最前。Windows 有焦点抢占保护，托盘里点回来时单纯 focus() 不生效，
// 短暂置顶一下才可靠。
function bringToFront () {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  // 普通窗口在 Windows 上很难抢过已激活的前台应用，
  // 用较高的置顶层级压一小会儿再撤掉，才稳。
  win.setAlwaysOnTop(true, 'screen-saver')
  win.moveTop()
  win.focus()
  setTimeout(() => {
    if (win && !win.isDestroyed()) win.setAlwaysOnTop(false)
  }, 900)
}

// ================= 托盘 =================
function createTray () {
  if (tray) return
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, 'app.ico'))
    tray = new Tray(img.resize({ width: 16, height: 16 }))
  } catch (e) {
    console.error('创建托盘失败:', e.message)
    return
  }
  tray.setToolTip(APP_NAME)
  tray.on('click', () => bringToFront())
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 Mbots', click: () => bringToFront() },
    { type: 'separator' },
    { label: '全部账号休眠', click: () => sleepBackground() },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit() } }
  ]))
}

// ================= 窗口 =================
const THEME_BG = { dark: '#07090e', light: '#eef1f6' }

// 跟随系统时，用原生主题判定当前该用哪套
function resolvedTheme () {
  if (settings.theme === 'light' || settings.theme === 'dark') return settings.theme
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

// nativeTheme.themeSource 的取值与设置项同名（light/dark/system）。
// 设过去之后，渲染层的 prefers-color-scheme、原生滚动条与右键菜单都会跟着变。
function applyThemeSource () {
  try {
    nativeTheme.themeSource = ['light', 'dark', 'system'].includes(settings.theme)
      ? settings.theme
      : 'dark'
  } catch { /* 旧版不支持 */ }
}

function applyWindowTheme () {
  if (!win || win.isDestroyed()) return
  try { win.setBackgroundColor(THEME_BG[resolvedTheme()] || THEME_BG.dark) } catch { /* ignore */ }
  try {
    win.webContents.send('theme-changed', { pref: settings.theme, theme: resolvedTheme() })
  } catch { /* ignore */ }
}

function createWindow () {
  // 按屏幕可用区域给尺寸，别一上来就超出屏幕被系统压缩
  let w = 1440
  let h = 920
  try {
    const area = screen.getPrimaryDisplay().workAreaSize
    w = Math.min(w, Math.round(area.width * 0.92))
    h = Math.min(h, Math.round(area.height * 0.92))
  } catch { /* ignore */ }

  win = new BrowserWindow({
    width: w,
    height: h,
    minWidth: 1040,
    minHeight: 640,
    backgroundColor: THEME_BG[resolvedTheme()],
    title: APP_NAME,
    icon: path.join(__dirname, 'app.ico'),
    autoHideMenuBar: true,
    show: false,
    // 标题栏完全自绘：原生按钮去掉，换成应用内可跟随主题的按钮
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: true
    }
  })

  win.setMenu(null)
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))

  win.once('ready-to-show', () => {
    if (win && !win.isDestroyed()) bringToFront()
  })

  // 兜底：某些无边框 + 覆盖层组合下 ready-to-show 不触发
  setTimeout(() => {
    if (win && !win.isDestroyed() && !win.isVisible()) bringToFront()
  }, 2500)

  // 调试用：MBOTS_FRONT=1 启动时强制再抢一次前台（外部窗口可能抢焦点）
  if (process.env.MBOTS_FRONT === '1') {
    setTimeout(() => { if (win && !win.isDestroyed()) bringToFront() }, 4500)
  }

  // 调试用：MBOTS_SHOT=<路径> 延迟截图（不受其他窗口遮挡影响）
  if (process.env.MBOTS_SHOT) {
    setTimeout(async () => {
      try {
        if (!win || win.isDestroyed()) return
        if (process.env.MBOTS_EVAL) {
          const r = await win.webContents.executeJavaScript(process.env.MBOTS_EVAL)
          console.log('[Mbots] eval =>', JSON.stringify(r))
        }
        const img = await win.webContents.capturePage()
        fs.writeFileSync(process.env.MBOTS_SHOT, img.toPNG())
        console.log('[Mbots] 截图已保存:', process.env.MBOTS_SHOT)
      } catch (e) {
        console.error('[Mbots] 截图失败:', e.message)
      }
    }, Number(process.env.MBOTS_SHOT_DELAY || 6000))
  }

  const sendFocus = (v) => {
    if (win && !win.isDestroyed()) win.webContents.send('win-focus', v)
  }
  win.on('focus', () => sendFocus(true))
  win.on('blur', () => sendFocus(false))

  // 窗口最小化 / 隐藏：只留当前账号，其余全部休眠
  win.on('minimize', () => sleepBackground())
  win.on('hide', () => sleepBackground())

  const relayout = () => {
    const rec = views.get(attachedId)
    if (rec) resizeView(rec.view)
  }
  const sendWinState = () => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('win-state', { maximized: win.isMaximized() })
    }
  }
  win.on('resize', relayout)
  win.on('maximize', () => { setTimeout(relayout, 30); setTimeout(sendWinState, 40) })
  win.on('unmaximize', () => { setTimeout(relayout, 30); setTimeout(sendWinState, 40) })
  win.on('enter-full-screen', () => setTimeout(relayout, 30))
  win.on('leave-full-screen', () => setTimeout(relayout, 30))

  // 关闭窗口：按设置决定「先问一下 / 直接退出 / 最小化到托盘」
  win.on('close', (e) => {
    if (isQuitting) return
    if (settings.closeAction === 'tray') {
      e.preventDefault()
      win.hide()
      sleepBackground()
      return
    }
    if (settings.closeAction === 'quit') return
    // ask：交回渲染层，在关闭按钮下方弹出选择
    e.preventDefault()
    bringToFront()
    if (win && !win.isDestroyed()) win.webContents.send('ask-close')
  })

  win.on('closed', () => {
    for (const rec of views.values()) {
      try { rec.view.webContents.close() } catch { /* ignore */ }
    }
    views.clear()
    win = null
    attachedId = null
  })

  win.webContents.once('did-finish-load', () => {
    activate(state.active)
    pushState()
    applyWindowTheme()
  })
}

// ================= IPC =================
ipcMain.handle('get-state', () => publicState())
ipcMain.handle('switch', (_e, id) => activate(id))
ipcMain.handle('add', (_e, name) => addAccount(name))
ipcMain.handle('rename', (_e, id, name) => renameAccount(id, name))
ipcMain.handle('remove', (_e, id) => removeAccount(id))

ipcMain.handle('reload', () => {
  const rec = views.get(state.active)
  if (rec) rec.view.webContents.reload()
  return true
})

ipcMain.handle('home', () => {
  const rec = views.get(state.active)
  if (rec) rec.view.webContents.loadURL(HOME_URL)
  return true
})

ipcMain.handle('sleep', (_e, id) => sleepView(id))
ipcMain.handle('sleep-background', () => sleepBackground())
ipcMain.handle('overlay', (_e, on) => setOverlay(on))

// ---------- 设置 ----------
ipcMain.handle('get-settings', () => ({
  settings,
  version: app.getVersion(),
  electron: process.versions.electron
}))

ipcMain.handle('set-settings', (_e, patch) => {
  if (!patch || typeof patch !== 'object') return settings
  const before = { ...settings }
  settings = { ...settings, ...patch }

  // 主题：交给原生主题源，渲染层与原生控件一起换
  if (settings.theme !== before.theme) {
    applyThemeSource()
    applyWindowTheme()
  }

  // 开机自启
  if (settings.autoLaunch !== before.autoLaunch) {
    try {
      app.setLoginItemSettings({
        openAtLogin: !!settings.autoLaunch,
        path: process.execPath,
        args: []
      })
    } catch (e) {
      console.error('设置开机自启失败:', e.message)
    }
  }

  saveSettings()
  return settings
})

// 缓存占用（Chromium 每个分区各自的 Cache）
function allPartitions () {
  return state.accounts.map((a) => a.partition)
}

ipcMain.handle('cache-size', async () => {
  let bytes = 0
  for (const p of allPartitions()) {
    try {
      const s = session.fromPartition(p)
      bytes += await s.getCacheSize()
    } catch { /* ignore */ }
  }
  return bytes
})

ipcMain.handle('clear-cache', async () => {
  let freed = 0
  for (const p of allPartitions()) {
    try {
      const s = session.fromPartition(p)
      await s.clearCache()
      await s.clearStorageData({ storages: ['shadercache', 'cachestorage', 'serviceworkers'] })
    } catch (e) {
      console.error('清理缓存失败:', e.message)
    }
  }
  return { ok: true, freed }
})

ipcMain.handle('win-max-toggle', () => {
  if (!win || win.isDestroyed()) return false
  if (win.isMaximized()) win.unmaximize()
  else win.maximize()
  return win.isMaximized()
})

ipcMain.handle('win-minimize', () => {
  if (!win || win.isDestroyed()) return false
  win.minimize()
  return true
})

// 自绘关闭按钮：tray = 收进托盘，quit = 真退出
ipcMain.handle('win-close', (_e, action) => {
  if (!win || win.isDestroyed()) return 'none'
  const act = ['tray', 'quit'].includes(action) ? action : settings.closeAction
  if (act === 'tray') {
    win.hide()
    sleepBackground()
    return 'tray'
  }
  if (act === 'quit') {
    isQuitting = true
    app.quit()
    return 'quit'
  }
  // ask 模式由渲染层弹菜单，这里只把窗口提上来
  bringToFront()
  return 'ask'
})

ipcMain.handle('win-state', () => ({
  maximized: !!(win && !win.isDestroyed() && win.isMaximized())
}))

// ================= 启动 =================
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => bringToFront())

  app.on('before-quit', () => { isQuitting = true })

  app.whenReady().then(() => {
    loadSettings()
    loadState()
    applyThemeSource()
    // 跟随系统时，系统切换深/浅色要立刻反映到窗口
    nativeTheme.on('updated', () => {
      if (settings.theme === 'system') applyWindowTheme()
    })
    createWindow()
    createTray()
    startMetrics()
    startSweeper()
    // 刻意不在启动时创建所有视图：只有当前账号会真正启动渲染进程
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}
