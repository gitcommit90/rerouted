"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("rerouted", {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, cb) => {
    const handler = (_e, ...a) => cb(...a);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
