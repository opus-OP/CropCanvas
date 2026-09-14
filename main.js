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
const CropMath = require("./renderer/shared-crop");

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

  let pbuf = "";
  proc.stdout.on("data", (chunk) => {
    pbuf += chunk.toString();
    const lines = pbuf.split("\n");
    pbuf = lines.pop();
    for (const line of lines) {
      if (line.startsWith("out_time_us=")) {
        const usec = parseInt(line.slice("out_time_us=".length), 10);
        if (video.duration && Number.isFinite(usec)) {
          const t = usec / 1e6;
          const pct = Math.min(100, Math.round((t / video.duration) * 100));
          if (pct !== lastProgress) {
            lastProgress = pct;
            cb({ ok: null, progress: pct });
          }
        }
      }
    }
  });

  proc.stderr.on("data", (chunk) => {
    buf += chunk.toString();
    if (buf.length > 65536) buf = buf.slice(-32768);
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
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      migrateTemplate(raw, file);
      out[id] = raw;
      out[id].id = id;
    } catch (e) {
      out[id] = { error: String(e), id };
    }
  }
  return out;
});

// Лёгкая миграция шаблона в актуальный формат на чтение: версия + ключи для зон.
function migrateTemplate(t, filePath) {
  if (t && typeof t === "object") {
    t.version = t.version || 1;
    if (t.version === 1 && Array.isArray(t.zones)) {
      const cw = (t.canvas && t.canvas.width) || 1080;
      const ch = (t.canvas && t.canvas.height) || 1920;
      let changed = false;
      t.zones.forEach((z) => {
        if (!z) return;
        const keys = sanitizeKeys(z.keys, z.crop, cw, ch);
        if (!Array.isArray(z.keys) || z.keys.length !== keys.length) changed = true;
        z.keys = keys;
      });
      if (changed && filePath) {
        t.version = 2;
        try {
          writeTemplate(filePath, t);
        } catch (_) {
          /* не критично, сохранится при следующем save */
        }
      } else {
        t.version = 2;
      }
    }
  }
  return t;
}

function sanitizeCrop(c) {
  return {
    x: clampVal(c && c.x, 0, 1),
    y: clampVal(c && c.y, 0, 1),
    w: clampVal(c && c.w, 0.01, 1),
    h: clampVal(c && c.h, 0.01, 1),
  };
}

// Валидация списка ключей: сортировка по t, схлопывание одинаковых t,
// минимум 2 ключа (уникальный пресет из базового кропа, статично).
function sanitizeKeys(keys, baseCrop, cw, ch) {
  const def = sanitizeCrop(baseCrop);
  if (def.w === 0.01 && def.h === 0.01) def.w = def.h = 0.5; // вырожденный кроп
  def.w = Math.min(1, def.w);
  def.h = Math.min(1, def.h);
  let arr = (Array.isArray(keys) ? keys : []).map((k) => ({
    t: clampVal(k && k.t, 0, 1e9),
    crop: sanitizeCrop(k && k.crop),
  }));
  arr.sort((a, b) => a.t - b.t);
  arr = arr.filter((k, i) => {
    if (i === 0) return true;
    return Math.abs(k.t - arr[i - 1].t) > 1e-9;
  });
  if (arr.length === 0) {
    arr = [
      { t: 0, crop: { ...def } },
      { t: 1e9, crop: { ...def } },
    ];
  } else if (arr.length === 1) {
    arr.push({ t: 1e9, crop: { ...arr[0].crop } });
  }
  return arr;
}

function sanitizeTemplateData(template, cw, ch) {
  const zones = Array.isArray(template.zones) ? template.zones : [];
  return {
    version: 2,
    name: typeof template.name === "string" && template.name.trim() ? template.name.trim() : "Template",
    nameEn: typeof template.nameEn === "string" && template.nameEn.trim() ? template.nameEn.trim() : template.name || "Template",
    canvas: { width: cw, height: ch },
    zones: zones.map((z) => {
      const color = z && /^#[0-9a-fA-F]{3,8}$/.test(String(z.color || "")) ? z.color : "#9147ff";
      const out = CropMath.fitOutRect(
        { x: +(z.out && z.out.x) || 0, y: +(z.out && z.out.y) || 0, w: +(z.out && z.out.w) || 0, h: +(z.out && z.out.h) || 0 },
        cw, ch, 16, 16
      );
      const crop = sanitizeCrop(z && z.crop);
      return {
        id: String(z.id || "zone"),
        label: String(z.label || z.id || "Zone"),
        labelEn: String(z.labelEn || z.label || z.id || "Zone"),
        color,
        out,
        crop,
        keys: sanitizeKeys(z && z.keys, crop, cw, ch),
      };
    }),
  };
}

function clampVal(v, lo, hi) {
  if (typeof v !== "number" || !Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

ipcMain.handle("config:save-template", (_evt, { id, template }) => {
  const file = templatePath(id);
  if (!file || !fs.existsSync(file)) return { ok: false, error: "unknown template" };
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    /* keep defaults */
  }
  const cw = current.canvas && current.canvas.width || 1080;
  const ch = current.canvas && current.canvas.height || 1920;
  const merged = sanitizeTemplateData(template || {}, cw, ch);
  try {
    writeTemplate(file, merged);
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