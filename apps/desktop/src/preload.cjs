'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aiw', {
  request: (method, pathAndQuery, body) => ipcRenderer.invoke('core:request', method, pathAndQuery, body),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
});
