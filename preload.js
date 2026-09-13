"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  openVideo: () => ipcRenderer.invoke("dialog:openVideo"),
  selectOutputDir: () => ipcRenderer.invoke("dialog:selectOutputDir"),
  listConfigs: () => ipcRenderer.invoke("config:list"),
  saveConfig: (id, zones) => ipcRenderer.invoke("config:save", { id, zones }),
  probeVideo: (filePath) => ipcRenderer.invoke("probe:video", filePath),
  renderStart: (opts) => ipcRenderer.invoke("render:start", opts),
  setLocale: (locale) => ipcRenderer.send("app:set-locale", locale),
  onRenderProgress: (cb) =>
    ipcRenderer.on("render:progress", (_evt, data) => cb(data)),
  onRenderDone: (cb) => ipcRenderer.on("render:done", (_evt, data) => cb(data)),
});