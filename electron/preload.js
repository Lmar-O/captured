'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The renderer gets a fixed verb list, never a channel it can name itself.
 * Everything that touches the filesystem stays in the main process.
 */
contextBridge.exposeInMainWorld('captured', {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
  },

  volumes: {
    list: () => ipcRenderer.invoke('volumes:list'),
  },

  chooseFolder: (options) => ipcRenderer.invoke('dialog:chooseFolder', options),

  scan: (source, settings) => ipcRenderer.invoke('scan:run', { source, settings }),

  planPreview: (settings) => ipcRenderer.invoke('plan:preview', { settings }),

  thumbnail: (id) => ipcRenderer.invoke('thumb:get', { id }),

  importer: {
    preflight: (ids, settings) => ipcRenderer.invoke('import:preflight', { ids, settings }),
    run: (ids, settings) => ipcRenderer.invoke('import:run', { ids, settings }),
    cancel: () => ipcRenderer.invoke('import:cancel'),
    onProgress: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('import:progress', listener);
      return () => ipcRenderer.removeListener('import:progress', listener);
    },
  },

  reveal: (target) => ipcRenderer.invoke('shell:reveal', { target }),
  openPath: (target) => ipcRenderer.invoke('shell:openPath', { target }),

  onThemeChange: (handler) => {
    const listener = (_event, mode) => handler(mode);
    ipcRenderer.on('theme:changed', listener);
    return () => ipcRenderer.removeListener('theme:changed', listener);
  },
});
