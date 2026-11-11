'use strict'

/* ============================================================
   Mbots 渲染层
   账号行按 id 做差量更新，不整表重建，减少无谓的 DOM 与重排开销
   ============================================================ */

const $ = (id) => document.getElementById(id)

const listEl = $('acct-list')
const ctxEl = $('ctxmenu')
const countEl = $('acct-count')
const memText = $('mem-text')
const memDot = $('mem-dot')

const pill = $('pill')
const pillAv = $('pill-av')
const pillName = $('pill-name')

const paletteEl = $('palette')
const pInput = $('p-input')
const pList = $('p-list')

const settingsEl = $('settings')

// 蓝调族头像：与 muse 品牌蓝同色系，靠明度和色相微差区分账号
const GRADIENTS = [
  ['#4c79ad', '#2b4362'],
  ['#3f7d94', '#244a58'],
  ['#5a6aa0', '#333c60'],
  ['#3d86a2', '#22505f'],
  ['#5b7fb2', '#324763'],
  ['#46718a', '#274352']
]

let stateNow = { active: null, accounts: [], awake: 0 }
let settingsNow = null
let rows = new Map()
let lastIds = ''
let editingId = null
let paletteOpen = false
let settingsOpen = false

/* ---------------- 工具 ---------------- */
function initialOf (name) {
  const s = String(name || '').trim()
  if (!s) return '?'
  const m = s.match(/^(?:账号|account|acct|acc)\s*([0-9]+)$/i)
  if (m) return m[1]
  const ch = Array.from(s)[0]
  return /[a-zA-Z]/.test(ch) ? ch.toUpperCase() : ch
}

function gradOf (i) {
  const g = GRADIENTS[i % GRADIENTS.length]
  return 'linear-gradient(150deg,' + g[0] + ' 0%,' + g[1] + ' 100%)'
}

function hostOf (url) {
  if (!url) return ''
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function statusOf (acc) {
  if (acc.loading) return 'loading'
  if (acc.needsLogin) return 'warn'
  if (acc.asleep) return ''
  if (acc.url) return 'ok'
  return ''
}

function subOf (acc) {
  if (acc.loading) return '加载中…'
  if (acc.needsLogin) return '需要登录'
  return ''
}

function setText (el, txt) {
  if (el && el.textContent !== txt) el.textContent = txt
}

function fmtBytes (b) {
  if (!b) return '0 B'
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB'
  if (b < 1024 * 1024 * 1024) return (b / 1048576).toFixed(1) + ' MB'
  return (b / 1073741824).toFixed(2) + ' GB'
}

/* ---------------- 账号行 ---------------- */
function buildRow (acc) {
  const el = document.createElement('div')
  el.className = 'acct'
  el.dataset.id = acc.id
  el.setAttribute('role', 'listitem')

  const av = document.createElement('div')
  av.className = 'av'
  const avText = document.createElement('span')
  av.appendChild(avText)
  const dot = document.createElement('i')
  av.appendChild(dot)

  const meta = document.createElement('div')
  meta.className = 'meta'
  const nm = document.createElement('div')
  nm.className = 'nm'
  const sub = document.createElement('div')
  sub.className = 'sub'
  meta.appendChild(nm)
  meta.appendChild(sub)

  const idx = document.createElement('span')
  idx.className = 'idx'

  el.appendChild(av)
  el.appendChild(meta)
  el.appendChild(idx)

  return { el, av, avText, dot, nm, sub, idx }
}

function paintRow (row, acc, index, isActive) {
  row.el.classList.toggle('active', isActive)
  row.dot.className = statusOf(acc)
  setText(row.nm, acc.name)
  setText(row.sub, subOf(acc))
  setText(row.idx, String(index + 1).padStart(2, '0'))
  row.sub.classList.toggle('warn', !!acc.needsLogin)
  row.sub.classList.toggle('asleep', !!acc.asleep && !acc.needsLogin)
  const tip = acc.name + (acc.url ? '\n' + acc.url : '\n未加载')
  if (row.el.title !== tip) row.el.title = tip
}

function render (state) {
  stateNow = state
  if (editingId) return

  setText(countEl, String(state.accounts.length))

  const ids = state.accounts.map((a) => a.id).join(',')
  if (ids !== lastIds) {
    listEl.textContent = ''
    rows = new Map()
    for (const acc of state.accounts) {
      const row = buildRow(acc)
      rows.set(acc.id, row)
      listEl.appendChild(row.el)
    }
    lastIds = ids
  }

  state.accounts.forEach((acc, i) => {
    const row = rows.get(acc.id)
    if (row) paintRow(row, acc, i, acc.id === state.active)
  })

  paintPill(state)
}

function paintPill (state) {
  const idx = state.accounts.findIndex((a) => a.id === state.active)
  const acc = idx >= 0 ? state.accounts[idx] : null
  if (!acc) {
    setText(pillName, '—')
    pill.title = ''
    return
  }
  pillAv.className = 'pill-av ' + (statusOf(acc) || '')
  setText(pillAv, '')
  setText(pillName, acc.name)

  // 副标题去掉后，把运行状态放到 tooltip，信息不丢但不占版面
  const hint = acc.loading ? '加载中…' : acc.needsLogin ? '需要登录' : hostOf(acc.url) || 'muse.ai'
  pill.title = acc.name + ' · ' + hint
}

/* ---------------- 内存读数 ---------------- */
window.mbots.onMetrics((m) => {
  const parts = [m.mb + ' MB']
  if (typeof m.awake === 'number' && typeof m.total === 'number') {
    parts.push(m.awake + '/' + m.total)
  }
  setText(memText, parts.join(' · '))
  memDot.classList.toggle('hot', m.mb > 1200)
  memDot.classList.toggle('cold', m.awake === 0)
})

/* ============================================================
   设置
   ============================================================ */
function resolvedTheme (s) {
  if (s && (s.theme === 'light' || s.theme === 'dark')) return s.theme
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applySettings (s) {
  settingsNow = s
  document.body.dataset.theme = resolvedTheme(s)
  document.body.dataset.accent = s.accent
  document.body.dataset.size = s.fontSize
  document.body.dataset.compact = s.compact ? '1' : '0'
  document.body.classList.toggle('no-motion', !s.motion)
  paintSettingControls(s)
}

function paintSettingControls (s) {
  // 分段控件 & 色板
  document.querySelectorAll('[data-setting]').forEach((group) => {
    const key = group.dataset.setting
    if (group.classList.contains('switch')) {
      group.classList.toggle('on', !!s[key])
      return
    }
    const val = String(s[key])
    group.querySelectorAll('button[data-value]').forEach((b) => {
      b.classList.toggle('on', b.dataset.value === val)
    })
  })
}

function bindSettings () {
  document.querySelectorAll('[data-setting]').forEach((group) => {
    const key = group.dataset.setting

    if (group.classList.contains('switch')) {
      group.addEventListener('click', () => {
        const next = !settingsNow[key]
        applySettings({ ...settingsNow, [key]: next })
        window.mbots.setSettings({ [key]: next })
      })
      return
    }

    group.querySelectorAll('button[data-value]').forEach((b) => {
      b.addEventListener('click', () => {
        let v = b.dataset.value
        if (key === 'sleepMin') v = Number(v)
        applySettings({ ...settingsNow, [key]: v })
        window.mbots.setSettings({ [key]: v })
      })
    })
  })

  $('btn-clear-cache').addEventListener('click', async (e) => {
    const btn = e.currentTarget
    btn.textContent = '清理中…'
    btn.disabled = true
    await window.mbots.clearCache()
    await refreshCacheSize()
    btn.textContent = '已清理'
    setTimeout(() => { btn.textContent = '清理'; btn.disabled = false }, 1200)
  })

  $('btn-sleep-all').addEventListener('click', async (e) => {
    const btn = e.currentTarget
    btn.textContent = '执行中…'
    await window.mbots.sleepBackground()
    btn.textContent = '已休眠'
    setTimeout(() => { btn.textContent = '执行' }, 1200)
  })

  $('btn-settings-close').addEventListener('click', closeSettings)
  settingsEl.querySelector('.s-backdrop').addEventListener('click', closeSettings)
}

async function refreshCacheSize () {
  const el = $('cache-size')
  try {
    const b = await window.mbots.cacheSize()
    setText(el, b ? '占用 ' + fmtBytes(b) + '，可安全清理' : '暂无缓存')
  } catch {
    setText(el, '统计失败')
  }
}

async function openSettings () {
  if (settingsOpen) return
  settingsOpen = true
  settingsEl.classList.remove('hidden')
  await window.mbots.overlay(true)
  refreshCacheSize()
}

async function closeSettings () {
  if (!settingsOpen) return
  settingsOpen = false
  settingsEl.classList.add('hidden')
  if (!paletteOpen) await window.mbots.overlay(false)
}

/* ---------------- 交互 ---------------- */
listEl.addEventListener('click', (e) => {
  const item = e.target.closest('.acct')
  if (!item || editingId) return
  if (item.dataset.id !== stateNow.active) window.mbots.switch(item.dataset.id)
})

listEl.addEventListener('dblclick', (e) => {
  const item = e.target.closest('.acct')
  if (!item) return
  const acc = stateNow.accounts.find((a) => a.id === item.dataset.id)
  if (acc) startRename(acc.id, acc.name)
})

listEl.addEventListener('contextmenu', (e) => {
  const item = e.target.closest('.acct')
  if (!item) return
  e.preventDefault()
  showMenu(e.clientX, e.clientY, item.dataset.id)
})

$('btn-add').addEventListener('click', () => window.mbots.add())
$('btn-reload').addEventListener('click', () => window.mbots.reload())
$('btn-home').addEventListener('click', () => window.mbots.home())
$('btn-settings').addEventListener('click', () => openSettings())
$('btn-palette').addEventListener('click', () => openPalette())

$('titlebar').addEventListener('dblclick', (e) => {
  if (e.target.closest('button')) return
  window.mbots.maxToggle()
})

/* ---------------- 窗口按钮 ---------------- */
const closeMenuEl = $('close-menu')
let closeMenuOpen = false

async function openCloseMenu () {
  if (closeMenuOpen) return
  closeMenuOpen = true
  // WebContentsView 永远盖在 DOM 之上，弹菜单前先把它藏起来
  await window.mbots.overlay(true)
  closeMenuEl.classList.remove('hidden')
}

async function closeCloseMenu () {
  if (!closeMenuOpen) return
  closeMenuOpen = false
  closeMenuEl.classList.add('hidden')
  if (!settingsOpen && !paletteOpen) await window.mbots.overlay(false)
}

$('btn-min').addEventListener('click', () => window.mbots.minimize())
$('btn-max').addEventListener('click', () => window.mbots.maxToggle())

$('btn-close').addEventListener('click', async () => {
  const act = (settingsNow && settingsNow.closeAction) || 'ask'
  if (act === 'ask') openCloseMenu()
  else await window.mbots.close(act)
})

closeMenuEl.querySelectorAll('.cm-item').forEach((b) => {
  b.addEventListener('click', async () => {
    const act = b.dataset.act
    await closeCloseMenu()
    await window.mbots.close(act)
  })
})

document.addEventListener('mousedown', (e) => {
  if (!closeMenuOpen) return
  if (e.target.closest('#close-menu') || e.target.closest('#btn-close')) return
  closeCloseMenu()
})

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (settingsNow && settingsNow.theme === 'system') {
    document.body.dataset.theme = resolvedTheme(settingsNow)
  }
})

/* ---------------- 重命名 ---------------- */
function startRename (id, name) {
  const row = rows.get(id)
  if (!row) return

  editingId = id
  let done = false

  const input = document.createElement('input')
  input.className = 'rename-input'
  input.value = name
  input.maxLength = 24
  row.nm.replaceWith(input)
  input.focus()
  input.select()

  const finish = async (save) => {
    if (done) return
    done = true
    const val = input.value.trim()
    input.replaceWith(row.nm)
    editingId = null
    if (save && val && val !== name) await window.mbots.rename(id, val)
    render(stateNow)
  }

  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation()
    if (ev.key === 'Enter') { ev.preventDefault(); finish(true) }
    else if (ev.key === 'Escape') { ev.preventDefault(); finish(false) }
  })
  input.addEventListener('blur', () => finish(true))
}

/* ---------------- 右键菜单 ---------------- */
function menuItem (label, hint, fn, danger) {
  const el = document.createElement('div')
  el.className = 'ctx-item' + (danger ? ' danger' : '')
  const a = document.createElement('span')
  a.textContent = label
  el.appendChild(a)
  if (hint) {
    const h = document.createElement('span')
    h.className = 'hint'
    h.textContent = hint
    el.appendChild(h)
  }
  el.addEventListener('click', () => { hideMenu(); fn() })
  return el
}

function showMenu (x, y, id) {
  const acc = stateNow.accounts.find((a) => a.id === id)
  if (!acc) return
  const isActive = id === stateNow.active

  ctxEl.textContent = ''
  ctxEl.appendChild(menuItem('重命名', '双击', () => startRename(id, acc.name)))
  ctxEl.appendChild(menuItem('刷新页面', 'Ctrl R', () => { if (isActive) window.mbots.reload() }))
  ctxEl.appendChild(menuItem('回到首页', '', () => { if (isActive) window.mbots.home() }))
  if (!isActive && !acc.asleep) {
    ctxEl.appendChild(menuItem('休眠此账号', '', () => window.mbots.sleep(id)))
  }

  if (stateNow.accounts.length > 1) {
    const sep = document.createElement('div')
    sep.className = 'ctx-sep'
    ctxEl.appendChild(sep)
    ctxEl.appendChild(menuItem('删除账号', '', async () => {
      const ok = confirm('删除「' + acc.name + '」？\n该账号的登录状态会被清除，不可恢复。')
      if (!ok) return
      const r = await window.mbots.remove(id)
      if (r && r.ok === false) alert(r.error)
    }, true))
  }

  ctxEl.classList.remove('hidden')
  const rect = ctxEl.getBoundingClientRect()
  ctxEl.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px'
  ctxEl.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px'
}

function hideMenu () {
  ctxEl.classList.add('hidden')
}

document.addEventListener('click', (e) => {
  if (!ctxEl.contains(e.target)) hideMenu()
})

/* ============================================================
   命令面板
   ============================================================ */
let pIndex = 0
let pItems = []

const ICONS = {
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  reload: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4.6V10h-5.4"/>',
  home: '<path d="M3.5 10.5 12 3.6l8.5 6.9"/><path d="M5.5 9.6V19h13V9.6"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.11a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.58 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.11A1.7 1.7 0 0 0 4.67 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.11a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.11a1.7 1.7 0 0 0-1.49 1z"/>'
}

function iconBox (path, color) {
  return '<span class="p-av" style="background:' + color + '">' +
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#dfe4ee" stroke-width="1.9" ' +
    'stroke-linecap="round" stroke-linejoin="round">' + path + '</svg></span>'
}

function buildItems (q) {
  const items = []
  stateNow.accounts.forEach((acc, i) => {
    items.push({
      kind: 'acct',
      label: acc.name,
      hint: acc.id === stateNow.active ? '当前' : (acc.asleep ? '休眠中' : ''),
      av: { text: initialOf(acc.name), grad: gradOf(i) },
      run: () => window.mbots.switch(acc.id)
    })
  })

  items.push({
    kind: 'cmd', section: '操作', label: '新建账号', hint: 'Ctrl T',
    icon: iconBox(ICONS.plus, 'rgba(255,255,255,.07)'),
    run: () => window.mbots.add()
  })
  items.push({
    kind: 'cmd', label: '刷新当前账号', hint: 'Ctrl R',
    icon: iconBox(ICONS.reload, 'rgba(255,255,255,.07)'),
    run: () => window.mbots.reload()
  })
  items.push({
    kind: 'cmd', label: '回到 muse.ai 首页',
    icon: iconBox(ICONS.home, 'rgba(255,255,255,.07)'),
    run: () => window.mbots.home()
  })
  items.push({
    kind: 'cmd', label: '休眠所有后台账号', hint: '省内存',
    icon: iconBox(ICONS.moon, 'rgba(255,255,255,.07)'),
    run: () => window.mbots.sleepBackground()
  })
  items.push({
    kind: 'cmd', label: '打开设置', hint: 'Ctrl ,',
    icon: iconBox(ICONS.gear, 'rgba(255,255,255,.07)'),
    run: () => openSettings()
  })

  const kw = q.trim().toLowerCase()
  if (!kw) return items
  return items.filter((it) => it.label.toLowerCase().includes(kw))
}

function paintPalette () {
  pList.textContent = ''
  if (!pItems.length) {
    const empty = document.createElement('div')
    empty.className = 'p-empty'
    empty.textContent = '没有匹配项'
    pList.appendChild(empty)
    return
  }

  pItems.forEach((it, i) => {
    if (it.section) {
      const sec = document.createElement('div')
      sec.className = 'p-sec'
      sec.textContent = it.section
      pList.appendChild(sec)
    }
    const el = document.createElement('div')
    el.className = 'p-item' + (i === pIndex ? ' on' : '')

    if (it.av) {
      const av = document.createElement('span')
      av.className = 'p-av'
      av.style.background = it.av.grad
      av.textContent = it.av.text
      el.appendChild(av)
    } else if (it.icon) {
      el.insertAdjacentHTML('beforeend', it.icon)
    }

    const t = document.createElement('span')
    t.className = 'p-title'
    t.textContent = it.label
    el.appendChild(t)

    if (it.hint) {
      const h = document.createElement('span')
      h.className = 'p-hint'
      h.textContent = it.hint
      el.appendChild(h)
    }

    el.addEventListener('mouseenter', () => { pIndex = i; paintPalette() })
    el.addEventListener('click', () => runPalette(i))
    pList.appendChild(el)
  })
}

async function openPalette () {
  if (paletteOpen) { pInput.select(); return }
  if (settingsOpen) await closeSettings()
  paletteOpen = true
  pIndex = 0
  pItems = buildItems('')
  pInput.value = ''
  paletteEl.classList.remove('hidden')
  await window.mbots.overlay(true)
  pInput.focus()
  paintPalette()
}

async function closePalette () {
  if (!paletteOpen) return
  paletteOpen = false
  paletteEl.classList.add('hidden')
  if (!settingsOpen) await window.mbots.overlay(false)
}

async function runPalette (i) {
  const it = pItems[i]
  if (!it) return
  await closePalette()
  it.run()
}

pInput.addEventListener('input', () => {
  pItems = buildItems(pInput.value)
  pIndex = 0
  paintPalette()
})

paletteEl.addEventListener('click', (e) => {
  if (!e.target.closest('.p-box')) closePalette()
})

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey

  if (e.key === 'Escape' && closeMenuOpen) {
    e.preventDefault()
    closeCloseMenu()
    return
  }

  if (mod && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    openPalette()
    return
  }

  if (mod && e.key === ',') {
    e.preventDefault()
    openSettings()
    return
  }

  if (settingsOpen) {
    if (e.key === 'Escape') { e.preventDefault(); closeSettings() }
    return
  }

  if (!paletteOpen) {
    if (e.key === 'Escape') hideMenu()
    return
  }

  if (e.key === 'ArrowDown') {
    e.preventDefault()
    pIndex = Math.min(pIndex + 1, pItems.length - 1)
    paintPalette()
    scrollSelected()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    pIndex = Math.max(pIndex - 1, 0)
    paintPalette()
    scrollSelected()
  } else if (e.key === 'Enter') {
    e.preventDefault()
    runPalette(pIndex)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    closePalette()
  }
})

function scrollSelected () {
  const on = pList.querySelector('.p-item.on')
  if (on) on.scrollIntoView({ block: 'nearest' })
}

/* ---------------- 启动 ---------------- */
window.mbots.onState(render)
window.mbots.onWinFocus((focused) => {
  document.body.classList.toggle('blurred', !focused)
})
window.mbots.onOpenPalette(() => openPalette())
window.mbots.onOpenSettings(() => openSettings())
window.mbots.onAskClose(() => openCloseMenu())
window.mbots.onThemeChanged((t) => {
  if (t && t.theme) document.body.dataset.theme = t.theme
})
window.mbots.onWinState((s) => {
  document.body.classList.toggle('maximized', !!(s && s.maximized))
})

window.mbots.winState().then((s) => {
  document.body.classList.toggle('maximized', !!(s && s.maximized))
}).catch(() => {})

bindSettings()

Promise.all([window.mbots.getState(), window.mbots.getSettings()]).then(([s, cfg]) => {
  if (cfg && cfg.settings) applySettings(cfg.settings)
  if (cfg) {
    setText($('about-ver'), 'v' + cfg.version)
    setText($('about-core'), 'Electron ' + cfg.electron)
  }
  render(s)
})
