'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aiw', {
  request: (method, pathAndQuery, body) => ipcRenderer.invoke('core:request', method, pathAndQuery, body),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  workspace: {
    load: () => ipcRenderer.invoke('workspace:load'),
    save: (w) => ipcRenderer.invoke('workspace:save', w),
  },
  term: {
    list: () => ipcRenderer.invoke('term:list'),
    open: (projectId, cols, rows) => ipcRenderer.invoke('term:open', projectId, cols, rows),
    attach: (id) => ipcRenderer.invoke('term:attach', id),
    kill: (id) => ipcRenderer.invoke('term:kill', id),
    input: (id, data) => ipcRenderer.send('term:input', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('term:resize', id, cols, rows),
    onData: (cb) => ipcRenderer.on('term:data', (_e, id, data) => cb(id, data)),
    onExit: (cb) => ipcRenderer.on('term:exit', (_e, id, code) => cb(id, code)),
    onClosed: (cb) => ipcRenderer.on('term:closed', (_e, id) => cb(id)),
  },
});
