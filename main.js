"use strict";

const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const {
  probeVideo,
  canvasSize,
  buildRenderArgs,
} = require("./lib/ffmpeg-graph");
const { ffmpegPath } = require("./lib/ffmpeg-path");

const CONFIG_DIR = path.join(__dirname, "config");
const ASSETS_DIR = path.join(__dirname, "assets");
const TEMPLATE_FILES = {
  template1: path.join(CONFIG_DIR, "template1.json"),
  template2: path.join(CONFIG_DIR, "template2.json"),
};

let mainWindow = null;
let uiLang = app.getLocale && app.getLocale().toLowerCase().includes("ru") ? "ru" : "en";

const UI_STRINGS = {
  openVideo: {
    ru: "Выберите исходный видеофайл",
    en: "Choose the source video",
  },
  outputDir: {
    ru: "Куда сохранить готовый ролик",
    en: "Where to save the finished clip",
  },
  videoFilter: { ru: "Видео", en: "Video" },
  allFiles: { ru: "Все файлы", en: "All files" },
  renderBusy: { ru: "Рендер уже идёт", en: "A render is already running" },
};

function tr(key) {
  const entry = UI_STRINGS[key];
  return entry ? (entry[uiLang] || entry.en) : key;
}

ipcMain.on("app:set-locale", (_evt, locale) => {
  uiLang = locale === "ru" ? "ru" : "en";
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1560,
    height: 960,
    backgroundColor: "#141417",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.on("did-finish-load", () => {});
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ---------- ffmpeg render ----------

function renderVideo({ videoPath, templateId, zones, outputDir }, cb) {
  const outFileName = `shorts_${new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19)}.mp4`;
  const outPath = path.join(outputDir, outFileName);

  const video = probeVideo(videoPath);
  if (video.error) {
    cb({ ok: false, error: video.error });
    return;
  }

  const overlayPath = path.join(ASSETS_DIR, "overlay.png");
  const twPath = path.join(ASSETS_DIR, "tw.png");
  const args = buildRenderArgs({
    videoPath,
    overlayPath,
    twPath,
    outPath,
    probe: video,
    zones,
  });

  const proc = spawn(ffmpegPath(), args, { windowsHide: true });

  let buf = "";
  let lastProgress = -1;

  proc.stderr.on("data", (chunk) => {
    buf += chunk.toString();
    if (buf.length > 65536) buf = buf.slice(-32768);
    const m = buf.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (m && video.duration) {
      const t = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
      const pct = Math.min(100, Math.round((t / video.duration) * 100));
      if (pct !== lastProgress) {
        lastProgress = pct;
        cb({ ok: null, progress: pct });
      }
    }
  });

  proc.on("error", (err) => {
    cb({ ok: false, error: String(err) });
  });

  proc.on("close", (code) => {
    if (code === 0) {
      cb({ ok: true, outPath, outFileName });
    } else {
      const tail = buf
        .split("\n")
        .filter((l) => l.trim())
        .slice(-4)
        .join("\n");
      cb({ ok: false, code, error: tail || "ffmpeg exited with error" });
    }
  });
}

// ---------- IPC ----------

ipcMain.handle("dialog:openVideo", async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: tr("openVideo"),
    properties: ["openFile"],
    filters: [
      { name: tr("videoFilter"), extensions: ["mp4", "mov", "mkv", "avi", "webm", "m4v", "flv", "wmv"] },
      { name: tr("allFiles"), extensions: ["*"] },
    ],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle("dialog:selectOutputDir", async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: tr("outputDir"),
    properties: ["openDirectory", "createDirectory"],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle("config:list", () => {
  const out = {};
  for (const [id, file] of Object.entries(TEMPLATE_FILES)) {
    try {
      out[id] = JSON.parse(fs.readFileSync(file, "utf8"));
      out[id].id = id;
    } catch (e) {
      out[id] = { error: String(e), id };
    }
  }
  return out;
});

ipcMain.handle("config:save", (_evt, { id, zones }) => {
  if (!TEMPLATE_FILES[id]) return { ok: false, error: "unknown template" };
  const file = TEMPLATE_FILES[id];
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    /* keep defaults */
  }
  current.zones = zones;
  try {
    fs.writeFileSync(file, JSON.stringify(current, null, 2), "utf8");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle("probe:video", (_evt, filePath) => probeVideo(filePath));

let renderBusy = false;

ipcMain.handle("render:start", (_evt, payload) =>
  new Promise((resolve, reject) => {
    const { videoPath, templateId, zones, outputDir } = payload;
    if (renderBusy) return reject(new Error(tr("renderBusy")));
    renderBusy = true;
    try {
      renderVideo({ videoPath, templateId, zones, outputDir }, (ev) => {
        if (ev.ok === null) {
          send("render:progress", ev);
        } else {
renderBusy = false;
      send("render:done", ev);
        }
      });
      resolve({ started: true });
    } catch (e) {
      renderBusy = false;
      reject(e);
    }
  })
);

// ---------- app lifecycle ----------

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});