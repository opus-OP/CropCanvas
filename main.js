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

// ---------- template store (scanned config/*.json, ids are file basenames) ----------

function listTemplateFiles() {
  let files;
  try {
    files = fs.readdirSync(CONFIG_DIR);
  } catch (e) {
    console.error("config dir read failed:", e);
    return [];
  }
  return files
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.join(CONFIG_DIR, f));
}

function safeId(id) {
  return id && /^[a-zA-Z0-9_-]+$/.test(id) ? id : null;
}

function templatePath(id) {
  const safe = safeId(id);
  return safe ? path.join(CONFIG_DIR, safe + ".json") : null;
}

function emptyTemplate(name) {
  return {
    name,
    nameEn: name,
    canvas: { width: 1080, height: 1920 },
    zones: [],
  };
}

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
  emptyTemplate: { ru: "В шаблоне нет зон", en: "Template has no zones" },
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

function renderVideo({ videoPath, templateId, zones, outputDir, resolution }, cb) {
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
    canvasW: resolution && resolution.w,
    canvasH: resolution && resolution.h,
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
  for (const file of listTemplateFiles()) {
    const id = path.basename(file, ".json");
    if (!safeId(id)) continue;
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
  const file = templatePath(id);
  if (!file || !fs.existsSync(file)) return { ok: false, error: "unknown template" };
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

function readTemplateJson(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.id = path.basename(file, ".json");
    return data;
  } catch (e) {
    return { error: String(e), id: path.basename(file, ".json") };
  }
}

function writeTemplate(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function uniqueId(base) {
  let id = base;
  let n = 1;
  while (fs.existsSync(templatePath(id))) {
    id = `${base}_${++n}`;
  }
  return id;
}

ipcMain.handle("template:create", (_evt, { name }) => {
  const clean = typeof name === "string" && name.trim() ? name.trim() : null;
  if (!clean) return { ok: false, error: "name required" };
  const id = uniqueId("custom");
  const file = templatePath(id);
  if (!file) return { ok: false, error: "invalid id" };
  try {
    writeTemplate(file, emptyTemplate(clean));
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle("template:duplicate", (_evt, { id }) => {
  const src = templatePath(id);
  if (!src || !fs.existsSync(src)) return { ok: false, error: "unknown template" };
  const srcData = readTemplateJson(src);
  if (srcData.error) return { ok: false, error: srcData.error };
  const newId = uniqueId(`${srcData.id}_copy`);
  const file = templatePath(newId);
  const suffix = uiLang === "ru" ? " (копия)" : " (copy)";
  const copy = { ...srcData, id: newId };
  if (typeof copy.name === "string") copy.name += suffix;
  if (typeof copy.nameEn === "string") copy.nameEn += suffix;
  try {
    writeTemplate(file, copy);
    return { ok: true, id: newId };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle("template:delete", (_evt, { id }) => {
  const file = templatePath(id);
  if (!file || !fs.existsSync(file)) return { ok: false, error: "unknown template" };
  try {
    fs.unlinkSync(file);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle("probe:video", (_evt, filePath) => probeVideo(filePath));

let renderBusy = false;

ipcMain.handle("render:start", (_evt, payload) =>
  new Promise((resolve, reject) => {
const { videoPath, templateId, zones, outputDir, resolution } = payload;
    if (!zones || !zones.length) return reject(new Error(tr("emptyTemplate")));
    renderBusy = true;
    try {
      renderVideo({ videoPath, templateId, zones, outputDir, resolution }, (ev) => {
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