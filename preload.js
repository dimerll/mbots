'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('mbots', {
  getState: () => ipcRenderer.invoke('get-state'),
  onState: (cb) => {
    ipcRenderer.on('state', (_e, s) => cb(s))
  },
  onWinFocus: (cb) => {
    ipcRenderer.on('win-focus', (_e, v) => cb(v))
  },
  onMetrics: (cb) => {
    ipcRenderer.on('metrics', (_e, m) => cb(m))
  },
  onOpenPalette: (cb) => {
    ipcRenderer.on('open-palette', () => cb())
  },
  onOpenSettings: (cb) => {
    ipcRenderer.on('open-settings', () => cb())
  },
  onThemeChanged: (cb) => {
    ipcRenderer.on('theme-changed', (_e, t) => cb(t))
  },
  onAskClose: (cb) => {
    ipcRenderer.on('ask-close', () => cb())
  },
  onWinState: (cb) => {
    ipcRenderer.on('win-state', (_e, s) => cb(s))
  },

  switch: (id) => ipcRenderer.invoke('switch', id),
  add: (name) => ipcRenderer.invoke('add', name),
  rename: (id, name) => ipcRenderer.invoke('rename', id, name),
  remove: (id) => ipcRenderer.invoke('remove', id),
  reload: () => ipcRenderer.invoke('reload'),
  home: () => ipcRenderer.invoke('home'),
  sleep: (id) => ipcRenderer.invoke('sleep', id),
  sleepBackground: () => ipcRenderer.invoke('sleep-background'),
  overlay: (on) => ipcRenderer.invoke('overlay', on),
  maxToggle: () => ipcRenderer.invoke('win-max-toggle'),
  minimize: () => ipcRenderer.invoke('win-minimize'),
  close: (action) => ipcRenderer.invoke('win-close', action),
  winState: () => ipcRenderer.invoke('win-state'),

  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (patch) => ipcRenderer.invoke('set-settings', patch),
  cacheSize: () => ipcRenderer.invoke('cache-size'),
  clearCache: () => ipcRenderer.invoke('clear-cache')
})
