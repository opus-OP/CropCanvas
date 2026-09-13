"use strict";

// ---------- helpers ----------

const $ = (sel) => document.querySelector(sel);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const VIDEO_FILE_PREFIX = "file://";

// ---------- DOM refs ----------

const video = $("#sourceVideo");
const stage = $("#sourceStage");
const rectLayer = $("#rectLayer");
const outCanvas = $("#outputCanvas");
const outCtx = outCanvas.getContext("2d");
const timeline = $("#timeline");
const btnPlay = $("#btnPlay");
const timeLabel = $("#timeLabel");
const btnLoadVideo = $("#btnLoadVideo");
const btnRender = $("#btnRender");
const templateTabs = $("#templateTabs");
const zoneLegend = $("#zoneLegend");
const videoInfo = $("#videoInfo");
const renderStatus = $("#renderStatus");
const progressFill = $("#progressFill");
const progressText = $("#progressText");
const resSelect = $("#resSelect");
const btnNewTemplate = $("#btnNewTemplate");
const btnDupTemplate = $("#btnDupTemplate");
const btnDelTemplate = $("#btnDelTemplate");
const modal = $("#modal");
const modalTitle = $("#modalTitle");
const modalInput = $("#modalInput");
const modalOk = $("#modalOk");
const modalCancel = $("#modalCancel");

const RES_PRESETS = [
  { label: "1080×1920", w: 1080, h: 1920 },
  { label: "720×1280", w: 720, h: 1280 },
  { label: "2160×3840", w: 2160, h: 3840 },
  { label: "1080×1080", w: 1080, h: 1080 },
  { label: "1920×1080", w: 1920, h: 1080 },
];
const MIN_PX = 16;
const HANDLE_HINTS = {
  nw: { x: -1, y: -1 },
  n: { x: 0, y: -1 },
  ne: { x: 1, y: -1 },
  e: { x: 1, y: 0 },
  se: { x: 1, y: 1 },
  s: { x: 0, y: 1 },
  sw: { x: -1, y: 1 },
  w: { x: -1, y: 0 },
};

// ---------- state ----------

const state = {
  videoPath: null,
  probe: null,
  templates: {},
  currentId: null,
  res: { w: 1080, h: 1920 },
  rects: new Map(), // zoneId -> { el, handles:Set }
  overlay: null,
  tw: null,
};

let rafId = null;
let saveTimer = null;

// ---------- video display metrics (letterbox mapping) ----------

function metrics() {
  const vw = video.videoWidth || 1;
  const vh = video.videoHeight || 1;
  const elW = stage.clientWidth;
  const elH = stage.clientHeight;
  const scale = Math.min(elW / vw, elH / vh);
  return {
    vw,
    vh,
    scale,
    offX: (elW - vw * scale) / 2,
    offY: (elH - vh * scale) / 2,
  };
}

// ---------- templates / tabs ----------

async function initTabs() {
  const cfgs = await window.api.listConfigs();
  state.templates = cfgs;
  templateTabs.innerHTML = "";
  Object.keys(cfgs).forEach((id) => {
    const t = cfgs[id];
    if (!t || t.error) return;
    const btn = document.createElement("button");
    btn.textContent = window.I18n.locName(t) || id;
    btn.dataset.id = id;
    btn.addEventListener("click", () => switchTemplate(id));
    templateTabs.appendChild(btn);
  });
  if (!state.currentId && Object.keys(cfgs).length) {
    switchTemplate(Object.keys(cfgs)[0]);
  }
}

function currentTemplate() {
  return state.templates[state.currentId];
}

function currentCanvas() {
  const t = currentTemplate();
  return t && t.canvas ? t.canvas : { width: 1080, height: 1920 };
}

function scaledZones() {
  const t = currentTemplate();
  const c = currentCanvas();
  return window.CropMath.scaleZones(t.zones, c.width, c.height, state.res.w, state.res.h);
}

function switchTemplate(id) {
  if (!state.templates[id]) return;
  saveConfigNow();
  state.currentId = id;
  // кропы всегда приводим к аспекту своих зон (квадрат для 1:1, 16:9 для 16:9 и т.д.)
  shapeCropsToZoneAspect();
  templateTabs.querySelectorAll("button").forEach((b) => {
    b.classList.toggle("active", b.dataset.id === id);
  });
  rebuildRectLayer();
  buildLegend();
  redraw();
  updateRenderEnabled();
}

function shapeCropsToZoneAspect() {
  const t = currentTemplate();
  if (!t) return;
  const vw = video.videoWidth || 1920;
  const vh = video.videoHeight || 1080;
  t.zones.forEach((z) => {
    const aspect = window.CropMath.zoneAspectNorm(z.out, vw, vh);
    z.crop = window.CropMath.reshapeToAspect(z.crop, aspect);
  });
}

function buildLegend() {
  const t = currentTemplate();
  if (!t) return;
  zoneLegend.innerHTML = "";
  t.zones.forEach((z) => {
    const tag = document.createElement("span");
    tag.className = "tag";
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = z.color;
    tag.appendChild(sw);
    tag.appendChild(document.createTextNode(window.I18n.locLabel(z) || z.id));
    zoneLegend.appendChild(tag);
  });
}

// ---------- rect layer ----------

function rebuildRectLayer() {
  rectLayer.innerHTML = "";
  state.rects.clear();
  const t = currentTemplate();
  if (!t) return;
  t.zones.forEach((z) => {
    const el = document.createElement("div");
    el.className = "cropRect";
    el.style.setProperty("--rcolor", z.color);

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = window.I18n.locLabel(z) || z.id;
    el.appendChild(label);

    Object.keys(HANDLE_HINTS).forEach((h) => {
      const hd = document.createElement("div");
      hd.className = "handle";
      hd.dataset.h = h;
      el.appendChild(hd);
    });

    el.addEventListener("pointerdown", (e) => {
      if (e.target.classList.contains("handle")) return;
      beginInteraction(e, z, null);
    });
    el.querySelectorAll(".handle").forEach((hd) => {
      hd.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        beginInteraction(e, z, hd.dataset.h);
      });
    });

    rectLayer.appendChild(el);
    state.rects.set(z.id, el);
    positionRect(z);
  });
}

function positionRect(z) {
  const el = state.rects.get(z.id);
  if (!el) return;
  const m = metrics();
  const px = (n) => m.offX + n * m.vw * m.scale;
  const py = (n) => m.offY + n * m.vh * m.scale;
  el.style.left = px(z.crop.x) + "px";
  el.style.top = py(z.crop.y) + "px";
  el.style.width = px(z.crop.w) - m.offX + "px";
  el.style.height = py(z.crop.h) - m.offY + "px";
}

function repositionAll() {
  const t = currentTemplate();
  if (!t) return;
  t.zones.forEach(positionRect);
}

// ---------- drag & resize ----------

function beginInteraction(e, zone, handleName) {
  if (!video.videoWidth) return;
  e.preventDefault();
  const start = { ...zone.crop };
  const m = metrics();
  const px0 = e.clientX;
  const py0 = e.clientY;
  const target = e.target.closest(".cropRect");
  target.setPointerCapture(e.pointerId);
  target.classList.add("dragging");

  const MIN_W = MIN_PX / m.scale / m.vw;
  const aspectNorm = window.CropMath.zoneAspectNorm(zone.out, m.vw, m.vh);

  const onMove = (ev) => {
    const dnx = (ev.clientX - px0) / (m.scale * m.vw);
    const dny = (ev.clientY - py0) / (m.scale * m.vh);
    let c;

    if (!handleName) {
      c = {
        x: clamp(start.x + dnx, 0, 1 - start.w),
        y: clamp(start.y + dny, 0, 1 - start.h),
        w: start.w,
        h: start.h,
      };
    } else {
      c = window.CropMath.resizeWithAspect(
        start,
        HANDLE_HINTS[handleName],
        dnx,
        dny,
        aspectNorm,
        MIN_W
      );
    }

    Object.assign(zone.crop, {
      x: +c.x.toFixed(4),
      y: +c.y.toFixed(4),
      w: +c.w.toFixed(4),
      h: +c.h.toFixed(4),
    });
    positionRect(zone);
    redraw();
    scheduleSave();
  };

  const onUp = () => {
    target.classList.remove("dragging");
    target.releasePointerCapture(e.pointerId);
    removeEventListener("pointermove", onMove);
    removeEventListener("pointerup", onUp);
    saveConfigNow();
  };

  addEventListener("pointermove", onMove);
  addEventListener("pointerup", onUp);
}

// ---------- persistence ----------

function sanitizeZonesForSave(t) {
  return t.zones.map((z) => ({
    id: z.id,
    label: z.label,
    labelEn: z.labelEn,
    color: z.color,
    out: z.out,
    crop: {
      x: clamp(z.crop.x, 0, 1),
      y: clamp(z.crop.y, 0, 1),
      w: clamp(z.crop.w, 0.01, 1),
      h: clamp(z.crop.h, 0.01, 1),
    },
  }));
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveConfigNow, 600);
}

function saveConfigNow() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const t = currentTemplate();
  if (!t) return;
  window.api.saveConfig(state.currentId, sanitizeZonesForSave(t));
}

// ---------- output preview ----------
// zoneSrcRect: общая математика с render-графом (см. shared-crop.js / lib/ffmpeg-graph.js)

function drawOutput() {
  outCtx.fillStyle = "#000";
  outCtx.fillRect(0, 0, state.res.w, state.res.h);
  const t = currentTemplate();
  if (!t) return;

  const videoReady = video.videoWidth > 0 && video.readyState >= 2;
  const zones = scaledZones();

  zones.forEach((z) => {
    const { x, y, w, h } = z.out;
    outCtx.fillStyle = z.color;
    outCtx.globalAlpha = 0.12;
    outCtx.fillRect(x, y, w, h);
    outCtx.globalAlpha = 1;
    outCtx.strokeStyle = z.color;
    outCtx.lineWidth = 2;
    outCtx.strokeRect(x + 1, y + 1, w - 2, h - 2);

    if (videoReady) {
      const src = window.CropMath.zoneSrcRect(z.crop, video.videoWidth, video.videoHeight, z.out);
      try {
        outCtx.drawImage(video, src.sx, src.sy, src.sw, src.sh, x, y, w, h);
        outCtx.globalAlpha = 0.12;
        outCtx.fillStyle = z.color;
        outCtx.fillRect(x, y, w, h);
        outCtx.globalAlpha = 1;
      } catch (_) {
        /* frame not ready yet */
      }
    }

    outCtx.fillStyle = "#fff";
    outCtx.font = "600 22px system-ui, sans-serif";
    outCtx.fillText(window.I18n.locLabel(z) || z.id, x + 8, y + 26);
  });

  if (state.tw && state.tw.complete && state.tw.naturalWidth > 0) {
    const w = state.res.w / 2;
    const h = state.tw.naturalHeight * (w / state.tw.naturalWidth);
    outCtx.drawImage(state.tw, (state.res.w - w) / 2, 0, w, h);
  }

  if (state.overlay && state.overlay.complete && state.overlay.naturalWidth > 0) {
    outCtx.drawImage(state.overlay, 0, 0, state.res.w, state.res.h);
  }
}

function redraw() {
  drawOutput();
}

function startLoop() {
  if (rafId) return;
  const loop = () => {
    drawOutput();
    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);
}

function stopLoop() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

video.addEventListener("play", startLoop);
video.addEventListener("pause", () => {
  stopLoop();
  redraw();
});

// ---------- video loading / playback ----------

async function loadVideo() {
  const p = await window.api.openVideo();
  if (!p) return;
  const probe = await window.api.probeVideo(p);
  if (probe.error) {
    alert(window.I18n.i18n("readVideoError") + probe.error);
    return;
  }
  state.videoPath = p;
  state.probe = probe;
  video.src = VIDEO_FILE_PREFIX + encodeURI(p);
}

video.addEventListener("loadedmetadata", () => {
  shapeCropsToZoneAspect();
  rebuildRectLayer();
  timeline.disabled = false;
  timeline.max = 1000;
  timeline.value = 0;
  const d = video.duration || 0;
  timeLabel.textContent = "0:00 / " + fmtTime(d);
  videoInfo.textContent = shortName(state.videoPath) +
    ` · ${video.videoWidth}×${video.videoHeight}` +
    (state.probe && state.probe.fps ? ` · ${fpsLabel(state.probe.fps)} fps` : "");
  updateRenderEnabled();
  seedFirstFrame();
});

function seedFirstFrame() {
  if (!video.videoWidth) return;
  video.muted = true;
  const done = () => {
    video.removeEventListener("seeked", done);
    if (video.paused) {
      video.muted = false;
      redraw();
    }
  };
  video.addEventListener("seeked", done);
  try {
    video.currentTime = 0.01;
    video.play().catch(() => redraw());
  } catch (_) {
    redraw();
  }
}

video.addEventListener("loadeddata", redraw);

function fmtTime(sec) {
  if (!isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + ":" + String(s).padStart(2, "0");
}

function fpsLabel(fps) {
  const parts = fps.split("/");
  const n = parseFloat(parts[0]);
  const d = parts[1] ? parseFloat(parts[1]) : 1;
  return n && d ? (n / d).toFixed(2).replace(/\.?0+$/, "") : fps;
}

function shortName(p) {
  const parts = p.split("/");
  return parts[parts.length - 1];
}

// playback controls

btnPlay.addEventListener("click", () => {
  if (video.paused) {
    video.play().catch(() => {});
  } else {
    video.pause();
  }
});

video.addEventListener("play", () => (btnPlay.textContent = "⏸"));
video.addEventListener("pause", () => (btnPlay.textContent = "▶"));

video.addEventListener("timeupdate", () => {
  if (video.duration) {
    timeline.value = (video.currentTime / video.duration) * 1000;
    timeLabel.textContent = fmtTime(video.currentTime) + " / " + fmtTime(video.duration);
  }
});

timeline.addEventListener("input", () => {
  if (video.duration) video.currentTime = (timeline.value / 1000) * video.duration;
});

// ---------- render ----------

function updateRenderEnabled() {
  const t = currentTemplate();
  btnRender.disabled = !(state.videoPath && t && t.zones && t.zones.length > 0);
}

btnRender.addEventListener("click", startRender);

async function startRender() {
  const dir = await window.api.selectOutputDir();
  if (!dir) return;

  btnRender.disabled = true;
  renderStatus.hidden = false;
  progressFill.style.width = "0%";
  progressText.textContent = window.I18n.i18n("renderBusy");

  const payload = {
    videoPath: state.videoPath,
    templateId: state.currentId,
    zones: scaledZones(),
    resolution: state.res,
    outputDir: dir,
  };

  try {
    await window.api.renderStart(payload);
  } catch (e) {
    finishRender(false, String(e));
  }
}

window.api.onRenderProgress(({ progress }) => {
  progressFill.style.width = progress + "%";
  progressText.textContent = window.I18n.i18n("renderProgress") + progress + "%";
});

window.api.onRenderDone((res) => {
  finishRender(res.ok, res.ok ? res.outPath : (res.error || "ffmpeg failed"));
});

function finishRender(ok, msg) {
  updateRenderEnabled();
  if (ok) {
    progressFill.style.background = "var(--ok)";
    progressText.textContent = window.I18n.i18n("renderDone") + msg;
  } else {
    progressFill.style.background = "var(--err)";
    progressText.textContent = window.I18n.i18n("renderError") + msg;
  }
}

// ---------- overlay image ----------

function loadOverlay() {
  const img = new Image();
  img.onload = () => redraw();
  img.src = "../assets/overlay.png";
  state.overlay = img;

  const tw = new Image();
  tw.onload = () => redraw();
  tw.src = "../assets/tw.png";
  state.tw = tw;
}

// ---------- resolution ----------

function initResolution() {
  RES_PRESETS.forEach((p, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = p.label;
    resSelect.appendChild(opt);
  });
  const saved = localStorage.getItem("res");
  let idx = 0;
  if (saved) {
    const m = /^(\d+)x(\d+)$/.exec(saved);
    if (m) {
      const found = RES_PRESETS.findIndex((p) => p.w === +m[1] && p.h === +m[2]);
      if (found >= 0) idx = found;
    }
  }
  resSelect.value = String(idx);
  const p = RES_PRESETS[idx];
  state.res = { w: p.w, h: p.h };
  applyResolution();
}

resSelect.addEventListener("change", () => {
  const p = RES_PRESETS[Number(resSelect.value)];
  state.res = { w: p.w, h: p.h };
  localStorage.setItem("res", p.w + "x" + p.h);
  applyResolution();
});

function applyResolution() {
  outCanvas.width = state.res.w;
  outCanvas.height = state.res.h;
  outCanvas.style.aspectRatio = state.res.w + " / " + state.res.h;
  redraw();
  updateRenderEnabled();
}

// ---------- template actions ----------

function askName(title) {
  return new Promise((resolve) => {
    modalTitle.textContent = title;
    modalInput.value = "";
    modal.hidden = false;
    modalInput.focus();
    const done = (val) => {
      modal.hidden = true;
      modalOk.removeEventListener("click", onOk);
      modalCancel.removeEventListener("click", onCancel);
      modalInput.removeEventListener("keydown", onKey);
      resolve(val);
    };
    const onOk = () => done(modalInput.value.trim() || null);
    const onCancel = () => done(null);
    const onKey = (e) => {
      if (e.key === "Enter") done(modalInput.value.trim() || null);
      if (e.key === "Escape") done(null);
    };
    modalOk.addEventListener("click", onOk);
    modalCancel.addEventListener("click", onCancel);
    modalInput.addEventListener("keydown", onKey);
  });
}

async function reloadAndSwitch(newId) {
  await initTabs();
  if (newId && state.templates[newId]) switchTemplate(newId);
  updateRenderEnabled();
}

btnNewTemplate.addEventListener("click", async () => {
  const name = await askName(window.I18n.i18n("modalTitle"));
  if (!name) return;
  const res = await window.api.createTemplate(name);
  if (res.ok) await reloadAndSwitch(res.id);
});

btnDupTemplate.addEventListener("click", async () => {
  if (!state.currentId) return;
  const res = await window.api.duplicateTemplate(state.currentId);
  if (res.ok) await reloadAndSwitch(res.id);
});

btnDelTemplate.addEventListener("click", async () => {
  if (!state.currentId) return;
  const t = currentTemplate();
  const label = t ? window.I18n.locName(t) : state.currentId;
  if (!window.confirm(window.I18n.i18n("deleteConfirm") + label + "?")) return;
  const res = await window.api.deleteTemplate(state.currentId);
  if (res.ok) {
    state.currentId = null;
    await reloadAndSwitch(null);
  }
});

// ---------- init ----------

new ResizeObserver(() => {
  repositionAll();
  redraw();
}).observe(stage);

btnLoadVideo.addEventListener("click", loadVideo);

(async function init() {
  window.I18n.initI18n();
  initResolution();
  await initTabs();
  loadOverlay();
})();

document.addEventListener("langchange", () => {
  initTabs();
  if (state.currentId) {
    rebuildRectLayer();
    buildLegend();
    redraw();
  }
  updateRenderEnabled();
});