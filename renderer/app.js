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
const canvasWrap = $("#canvasWrap");
const outRectLayer = $("#outRectLayer");
const zonePanel = $("#zonePanel");
const zoneList = $("#zoneList");
const zoneProps = $("#zoneProps");
const tplName = $("#tplName");
const tplNameEn = $("#tplNameEn");
const btnAddZone = $("#btnAddZone");
const zoneLabel = $("#zoneLabel");
const zoneLabelEn = $("#zoneLabelEn");
const zoneColor = $("#zoneColor");
const zoneOx = $("#zoneOx");
const zoneOy = $("#zoneOy");
const zoneOw = $("#zoneOw");
const zoneOh = $("#zoneOh");
const btnZoneUp = $("#btnZoneUp");
const btnZoneDown = $("#btnZoneDown");
const btnDelZone = $("#btnDelZone");
const timeline = $("#timeline");
const btnPlay = $("#btnPlay");
const timeLabel = $("#timeLabel");
const keyTrack = $("#keyTrack");
const keyTrackWrap = $("#keyTrackWrap");
const keyTrackPlayhead = $("#keyTrackPlayhead");
const btnDelKey = $("#btnDelKey");
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
const MIN_OUT = 16;
const ZONE_PALETTE = ["#9147ff", "#4ade80", "#f87171", "#38bdf8", "#fbbf24", "#f472b6", "#34d399", "#fb923c"];
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
  currentZoneId: null,
  selKeyT: null, // выбранный ключевой кадр (t) текущей зоны
  res: { w: 1080, h: 1920 },
  rects: new Map(), // zoneId -> { el, handles:Set }
  outRects: new Map(), // zoneId -> el (editor layout layer)
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

// ---------- keyframe helpers ----------

function trackDuration() {
  const d = video.duration;
  if (d && isFinite(d) && d > 0) return d;
  const p = state.probe && state.probe.duration;
  return p && isFinite(p) && p > 0 ? p : 1;
}

// Кроп зоны на момент времени t (линейная интерполяция ключей).
function cropAtTime(z, t) {
  return window.CropMath.interpCropN(z.keys, t);
}

// Убедиться, что у всех ключей зоны кроп приведён к аспекту out (после
// изменения раскладки на выходе).
function reshapeZoneKeysToAspect(z) {
  const aspect = window.CropMath.zoneAspectNorm(z.out, video.videoWidth || 1920, video.videoHeight || 1080);
  z.keys = window.CropMath.zoneKeys(z).map((k) => ({
    t: k.t,
    crop: window.CropMath.reshapeToAspect(k.crop, aspect),
  }));
  if (z.keys.length) z.crop = { ...z.keys[0].crop };
}

// Целевой ключ для правки прямоугольника на исходнике в момент t: выбранный
// ключ (если его время == t), иначе существующий ключ в t, иначе новый ключ.
function editTargetKey(z, t) {
  let ks = window.CropMath.zoneKeys(z);
  const time = Math.min(Math.max(0, t), trackDuration());
  if (state.selKeyT != null && ks.some((k) => Math.abs(k.t - state.selKeyT) < 1e-6)) {
    const hit = ks.find((k) => Math.abs(k.t - state.selKeyT) < 1e-6);
    return { key: hit, created: false };
  }
  let hit = ks.find((k) => Math.abs(k.t - time) < 0.02);
  if (!hit) {
    const crop = cropAtTime(z, time);
    hit = { t: time, crop };
    ks = window.CropMath.sortKeys(ks.concat(hit));
    z.keys = ks;
    hit = ks.find((k) => Math.abs(k.t - time) < 0.02);
  }
  state.selKeyT = hit.t;
  return { key: hit, created: true };
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
  state.currentZoneId = null;
  state.selKeyT = null;
  // кропы всегда приводим к аспекту своих зон (квадрат для 1:1, 16:9 для 16:9 и т.д.)
  shapeCropsToZoneAspect();
  templateTabs.querySelectorAll("button").forEach((b) => {
    b.classList.toggle("active", b.dataset.id === id);
  });
  rebuildTemplateUI();
}

function rebuildTemplateUI() {
  rebuildRectLayer();
  rebuildOutLayer();
  buildZoneList();
  buildLegend();
  buildKeyTrack();
  updateTemplateNameInputs();
  updateZoneProps();
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
    z.keys = window.CropMath.zoneKeys(z).map((k) => ({
      t: k.t,
      crop: window.CropMath.reshapeToAspect(k.crop, aspect),
    }));
    if (z.keys.length) z.crop = { ...z.keys[0].crop };
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
  applySelection();
}

function positionRect(z) {
  const el = state.rects.get(z.id);
  if (!el) return;
  const m = metrics();
  const c = cropAtTime(z, video.currentTime);
  const px = (n) => m.offX + n * m.vw * m.scale;
  const py = (n) => m.offY + n * m.vh * m.scale;
  el.style.left = px(c.x) + "px";
  el.style.top = py(c.y) + "px";
  el.style.width = px(c.x + c.w) - m.offX + "px";
  el.style.height = py(c.y + c.h) - m.offY + "px";
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
  const tk = editTargetKey(zone, video.currentTime);
  const edit = tk.key.crop;
  buildKeyTrack();
  const start = { ...edit };
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

    Object.assign(edit, {
      x: +c.x.toFixed(4),
      y: +c.y.toFixed(4),
      w: +c.w.toFixed(4),
      h: +c.h.toFixed(4),
    });
    zone.crop = { ...edit };
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

// ---------- output layout editor (out rects) ----------

function currentCanvasSize() {
  const c = currentCanvas();
  return { w: c.width || 1080, h: c.height || 1920 };
}

function layoutOutStage() {
  if (!canvasWrap || !outRectLayer) return;
  const wrapRect = canvasWrap.getBoundingClientRect();
  const cRect = outCanvas.getBoundingClientRect();
  outRectLayer.style.left = cRect.left - wrapRect.left + "px";
  outRectLayer.style.top = cRect.top - wrapRect.top + "px";
  outRectLayer.style.width = cRect.width + "px";
  outRectLayer.style.height = cRect.height + "px";
  positionOutRects();
}

function positionOutRect(z) {
  const el = state.outRects.get(z.id);
  if (!el) return;
  const c = currentCanvasSize();
  const sc = window.CropMath.scaleZones([z], c.w, c.h, state.res.w, state.res.h)[0];
  const r = outRectLayer.getBoundingClientRect();
  const wFrac = sc.out.w / state.res.w;
  const hFrac = sc.out.h / state.res.h;
  el.style.left = (sc.out.x / state.res.w) * r.width + "px";
  el.style.top = (sc.out.y / state.res.h) * r.height + "px";
  el.style.width = wFrac * r.width + "px";
  el.style.height = hFrac * r.height + "px";
}

function positionOutRects() {
  const t = currentTemplate();
  if (!t) return;
  t.zones.forEach(positionOutRect);
}

function rebuildOutLayer() {
  outRectLayer.innerHTML = "";
  state.outRects.clear();
  const t = currentTemplate();
  if (!t) return;
  t.zones.forEach((z, i) => {
    const el = document.createElement("div");
    el.className = "outRect";
    el.style.setProperty("--rcolor", z.color);

    const label = document.createElement("span");
    label.className = "out-label";
    label.textContent = String(i + 1);
    el.appendChild(label);

    Object.keys(HANDLE_HINTS).forEach((h) => {
      const hd = document.createElement("div");
      hd.className = "handle";
      hd.dataset.h = h;
      el.appendChild(hd);
    });

    el.addEventListener("pointerdown", (e) => {
      if (e.target.classList.contains("handle")) return;
      beginOutInteraction(e, z, null);
    });
    el.querySelectorAll(".handle").forEach((hd) => {
      hd.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        beginOutInteraction(e, z, hd.dataset.h);
      });
    });

    outRectLayer.appendChild(el);
    state.outRects.set(z.id, el);
    positionOutRect(z);
  });
  applySelection();
}

outRectLayer.addEventListener("pointerdown", (e) => {
  if (!e.target.closest(".outRect")) selectZone(null);
});

function beginOutInteraction(e, zone, handleName) {
  const t = currentTemplate();
  if (!t) return;
  e.preventDefault();
  selectZone(zone.id);
  const target = e.target.closest(".outRect");
  target.setPointerCapture(e.pointerId);
  target.classList.add("dragging");

  const start = { ...zone.out };
  const c = currentCanvasSize();
  const px0 = e.clientX;
  const py0 = e.clientY;
  const toBase = (dx, dy) => {
    const r = outRectLayer.getBoundingClientRect();
    return { x: (dx / r.width) * c.w, y: (dy / r.height) * c.h };
  };

  const onMove = (ev) => {
    const d = toBase(ev.clientX - px0, ev.clientY - py0);
    let next;
    if (!handleName) {
      next = { x: start.x + d.x, y: start.y + d.y, w: start.w, h: start.h };
    } else {
      const hx = HANDLE_HINTS[handleName].x;
      const hy = HANDLE_HINTS[handleName].y;
      next = { ...start };
      if (hx === -1) { next.x = start.x + d.x; next.w = start.w - d.x; }
      else if (hx === 1) { next.w = start.w + d.x; }
      if (hy === -1) { next.y = start.y + d.y; next.h = start.h - d.y; }
      else if (hy === 1) { next.h = start.h + d.y; }
    }
    Object.assign(zone.out, window.CropMath.fitOutRect(next, c.w, c.h, MIN_OUT, MIN_OUT));
    positionOutRects();
    redraw();
    updateZoneProps();
    scheduleSave();
  };

  const onUp = () => {
    target.classList.remove("dragging");
    target.releasePointerCapture(e.pointerId);
    removeEventListener("pointermove", onMove);
    removeEventListener("pointerup", onUp);
    if (video.videoWidth) {
      reshapeZoneKeysToAspect(zone);
      positionRect(zone);
      redraw();
    }
    saveConfigNow();
  };

  addEventListener("pointermove", onMove);
  addEventListener("pointerup", onUp);
}

// ---------- zone selection & properties ----------

function selectedZone() {
  const t = currentTemplate();
  return (t && t.zones.find((z) => z.id === state.currentZoneId)) || null;
}

function zoneIndex() {
  const t = currentTemplate();
  return t ? t.zones.findIndex((z) => z.id === state.currentZoneId) : -1;
}

function selectZone(id) {
  state.currentZoneId = id;
  state.selKeyT = null;
  applySelection();
  updateZoneProps();
  buildKeyTrack();
}

function applySelection() {
  const sel = state.currentZoneId;
  state.rects.forEach((el, id) => el.classList.toggle("selected", id === sel));
  state.outRects.forEach((el, id) => el.classList.toggle("selected", id === sel));
  zoneList.querySelectorAll(".zoneTag").forEach((el) => {
    el.classList.toggle("active", el.dataset.id === sel);
  });
}

// ---------- keyframe track (по хронометражу) ----------

function buildKeyTrack() {
  const t = currentTemplate();
  keyTrack.innerHTML = "";
  btnDelKey.hidden = !(state.selKeyT != null);
  if (!t) return;
  const dur = trackDuration();
  t.zones.forEach((z) => {
    const color = z.color || "#9147ff";
    window.CropMath.zoneKeys(z).forEach((k) => {
      const el = document.createElement("div");
      el.className = "keyMarker";
      el.style.setProperty("--rcolor", color);
      el.style.background = color;
      const selected = state.currentZoneId === z.id && state.selKeyT != null && Math.abs(k.t - state.selKeyT) < 1e-6;
      if (selected) el.classList.add("selected");
      el.dataset.zone = z.id;
      el.dataset.t = String(k.t);
      el.title = k.t >= 1e8 ? "\u221E" : fmtTime(k.t);
      el.style.left = (Math.min(k.t, dur) / dur) * 100 + "%";
      el.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        selectKey(z, k);
        beginKeyDrag(e, z, k);
      });
      keyTrack.appendChild(el);
    });
  });
  updateKeyPlayhead();
}

function selectKey(z, k) {
  state.currentZoneId = z.id;
  state.selKeyT = k.t;
  applySelection();
  updateZoneProps();
  buildKeyTrack();
  const dur = trackDuration();
  if (video.duration) video.currentTime = Math.min(k.t, Math.max(0, dur - 0.001));
  timeline.value = video.duration ? (video.currentTime / video.duration) * 1000 : 0;
  redraw();
}

function beginKeyDrag(e, zone, keyRef) {
  const wrap = keyTrackWrap;
  const startX = e.clientX;
  const startT = keyRef.t;
  const dur = trackDuration();
  const onMove = (ev) => {
    const rect = wrap.getBoundingClientRect();
    const t = clamp(startT + ((ev.clientX - startX) / Math.max(1, rect.width)) * dur, 0, 1e9);
    keyRef.t = t;
    state.selKeyT = t;
    zone.keys = window.CropMath.sortKeys(zone.keys);
    buildKeyTrack();
    scheduleSave();
  };
  const onUp = () => {
    removeEventListener("pointermove", onMove);
    removeEventListener("pointerup", onUp);
    buildKeyTrack();
    saveConfigNow();
  };
  addEventListener("pointermove", onMove);
  addEventListener("pointerup", onUp);
}

keyTrack.addEventListener("pointerdown", (e) => {
  if (e.target.classList.contains("keyMarker")) return;
  const z = selectedZone();
  if (!z) return;
  const rect = keyTrackWrap.getBoundingClientRect();
  const t = clamp(((e.clientX - rect.left) / Math.max(1, rect.width)) * trackDuration(), 0, trackDuration());
  addKeyAt(z, t);
});

async function addKeyAt(z, t) {
  const time = clamp(t, 0, trackDuration());
  const crop = cropAtTime(z, time);
  z.keys = window.CropMath.sortKeys((window.CropMath.zoneKeys(z)).concat({ t: time, crop }));
  state.selKeyT = time;
  buildKeyTrack();
  redraw();
  scheduleSave();
}

async function removeKey() {
  const z = selectedZone();
  if (!z || state.selKeyT == null) return;
  let ks = window.CropMath.sortKeys(z.keys);
  ks = ks.filter((k) => Math.abs(k.t - state.selKeyT) >= 1e-6);
  if (ks.length === 0) {
    const c = z.crop && z.crop.w > 0 ? z.crop : { x: 0, y: 0, w: 1, h: 1 };
    ks = [{ t: 0, crop: { ...c } }, { t: 1e9, crop: { ...c } }];
  } else if (ks.length === 1) {
    ks = [{ t: 0, crop: { ...ks[0].crop } }, { t: 1e9, crop: { ...ks[0].crop } }];
  }
  z.keys = ks;
  state.selKeyT = null;
  buildKeyTrack();
  redraw();
  scheduleSave();
}

btnDelKey.addEventListener("click", removeKey);

document.addEventListener("keydown", (e) => {
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (state.selKeyT == null) return;
  if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    removeKey();
  }
});

function updateKeyPlayhead() {
  const dur = trackDuration();
  keyTrackPlayhead.style.left = (clamp(video.currentTime || 0, 0, dur) / dur) * 100 + "%";
}

function updateZoneProps() {
  const z = selectedZone();
  if (!z) {
    zoneProps.hidden = true;
    return;
  }
  zoneProps.hidden = false;
  zoneLabel.value = z.label || "";
  zoneLabelEn.value = z.labelEn || "";
  zoneColor.value = /^#[0-9a-fA-F]{6}$/.test(z.color || "") ? z.color : "#9147ff";
  zoneOx.value = z.out.x;
  zoneOy.value = z.out.y;
  zoneOw.value = z.out.w;
  zoneOh.value = z.out.h;
  const t = currentTemplate();
  const idx = zoneIndex();
  btnZoneUp.disabled = idx <= 0;
  btnZoneDown.disabled = !t || idx >= t.zones.length - 1;
}

// ---------- zone list ----------

function buildZoneList() {
  const t = currentTemplate();
  zoneList.innerHTML = "";
  if (!t) return;
  t.zones.forEach((z, i) => {
    const tag = document.createElement("span");
    tag.className = "zoneTag";
    tag.dataset.id = z.id;
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = z.color;
    tag.appendChild(sw);
    tag.appendChild(document.createTextNode(String(i + 1) + ". " + (window.I18n.locLabel(z) || z.id)));
    tag.addEventListener("click", () => selectZone(z.id));
    zoneList.appendChild(tag);
  });
  applySelection();
}

function updateRectLabels() {
  const t = currentTemplate();
  if (!t) return;
  t.zones.forEach((z) => {
    const el = state.rects.get(z.id);
    const ol = state.outRects.get(z.id);
    const label = window.I18n.locLabel(z) || z.id;
    if (el) {
      const l = el.querySelector(".label");
      if (l) l.textContent = label;
    }
    if (ol && ol.querySelector(".out-label")) {
      const idx = t.zones.findIndex((v) => v.id === z.id);
      ol.querySelector(".out-label").textContent = String(idx + 1);
    }
  });
}

function uniqueZoneId(t, base) {
  let n = 1;
  let id;
  do {
    id = base + "_" + n;
    n++;
  } while (t.zones.some((z) => z.id === id));
  return id;
}

function cropForOut(out) {
  if (!video.videoWidth) return { x: 0, y: 0, w: 1, h: 1 };
  const aspect = window.CropMath.zoneAspectNorm(out, video.videoWidth, video.videoHeight);
  return window.CropMath.centerCropForAspect(aspect);
}

// ---------- zone CRUD ----------

async function addZone() {
  const t = currentTemplate();
  if (!t) return;
  const c = currentCanvasSize();
  const idx = t.zones.length;
  const out = window.CropMath.placeNewZoneRect(c.w, c.h, idx);
  const n = idx + 1;
  const crop = cropForOut(out);
  t.zones.push({
    id: uniqueZoneId(t, "zone"),
    label: "\u0417\u043E\u043D\u0430 " + n,
    labelEn: "Zone " + n,
    color: ZONE_PALETTE[idx % ZONE_PALETTE.length],
    out,
    crop,
    keys: [
      { t: 0, crop: { ...crop } },
      { t: 1e9, crop: { ...crop } },
    ],
  });
  rebuildRectLayer();
  rebuildOutLayer();
  buildZoneList();
  buildLegend();
  selectZone(t.zones[t.zones.length - 1].id);
  redraw();
  updateRenderEnabled();
  await saveConfigNow();
}

async function deleteZone() {
  const t = currentTemplate();
  const z = selectedZone();
  if (!t || !z) return;
  if (!window.confirm(window.I18n.i18n("confirmDeleteZone") + (window.I18n.locLabel(z) || z.id) + "?")) return;
  t.zones = t.zones.filter((v) => v.id !== z.id);
  state.currentZoneId = null;
  rebuildTemplateUI();
  await saveConfigNow();
}

async function moveZone(dir) {
  const t = currentTemplate();
  const idx = zoneIndex();
  if (!t || idx < 0) return;
  const j = idx + dir;
  if (j < 0 || j >= t.zones.length) return;
  const arr = t.zones;
  const moved = arr[idx];
  arr[idx] = arr[j];
  arr[j] = moved;
  state.currentZoneId = moved.id;
  rebuildTemplateUI();
  updateZoneProps();
  await saveConfigNow();
}

function applyOutToZone(z, val) {
  const c = currentCanvasSize();
  Object.assign(z.out, window.CropMath.fitOutRect(val, c.w, c.h, MIN_OUT, MIN_OUT));
  positionOutRects();
  if (video.videoWidth) {
    const aspect = window.CropMath.zoneAspectNorm(z.out, video.videoWidth, video.videoHeight);
    z.crop = window.CropMath.reshapeToAspect(z.crop, aspect);
    positionRect(z);
  }
  redraw();
  updateZoneProps();
  saveConfigNow();
}

btnAddZone.addEventListener("click", addZone);
btnDelZone.addEventListener("click", deleteZone);
btnZoneUp.addEventListener("click", () => moveZone(-1));
btnZoneDown.addEventListener("click", () => moveZone(1));

zoneLabel.addEventListener("input", () => {
  const z = selectedZone();
  if (!z) return;
  z.label = zoneLabel.value;
  updateRectLabels();
  buildZoneList();
  buildLegend();
  redraw();
  scheduleSave();
});

zoneLabelEn.addEventListener("input", () => {
  const z = selectedZone();
  if (!z) return;
  z.labelEn = zoneLabelEn.value;
  updateRectLabels();
  buildZoneList();
  buildLegend();
  redraw();
  scheduleSave();
});

zoneColor.addEventListener("input", () => {
  const z = selectedZone();
  if (!z) return;
  z.color = zoneColor.value;
  stColor(z);
  buildZoneList();
  buildLegend();
  redraw();
  scheduleSave();
});

function stColor(z) {
  const cropEl = state.rects.get(z.id);
  const outEl = state.outRects.get(z.id);
  if (cropEl) cropEl.style.setProperty("--rcolor", z.color);
  if (outEl) outEl.style.setProperty("--rcolor", z.color);
}

[zoneOx, zoneOy, zoneOw, zoneOh].forEach((input) => {
  input.addEventListener("change", () => {
    const z = selectedZone();
    if (!z) return;
    applyOutToZone(z, {
      x: +zoneOx.value || 0,
      y: +zoneOy.value || 0,
      w: +zoneOw.value || MIN_OUT,
      h: +zoneOh.value || MIN_OUT,
    });
  });
});

// ---------- template name editing ----------

function updateTemplateNameInputs() {
  const t = currentTemplate();
  tplName.value = t && t.name ? t.name : "";
  tplNameEn.value = t && t.nameEn ? t.nameEn : "";
}

function updateTabLabel(id, label) {
  const btn = templateTabs.querySelector('button[data-id="' + id + '"]');
  if (btn) btn.textContent = label;
}

tplName.addEventListener("input", () => {
  const t = currentTemplate();
  if (!t) return;
  t.name = tplName.value;
  updateTabLabel(state.currentId, window.I18n.locName(t) || state.currentId);
  scheduleSave();
});

tplNameEn.addEventListener("input", () => {
  const t = currentTemplate();
  if (!t) return;
  t.nameEn = tplNameEn.value;
  updateTabLabel(state.currentId, window.I18n.locName(t) || state.currentId);
  scheduleSave();
});

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
    keys: window.CropMath.sortKeys(z.keys).map((k) => ({
      t: k.t,
      crop: {
        x: clamp(k.crop.x, 0, 1),
        y: clamp(k.crop.y, 0, 1),
        w: clamp(k.crop.w, 0.01, 1),
        h: clamp(k.crop.h, 0.01, 1),
      },
    })),
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
  if (!t) return Promise.resolve();
  return window.api.saveTemplate(state.currentId, {
    name: t.name,
    nameEn: t.nameEn,
    canvas: t.canvas || { width: 1080, height: 1920 },
    zones: sanitizeZonesForSave(t),
  });
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
      const src = window.CropMath.zoneSrcRect(cropAtTime(z, video.currentTime), video.videoWidth, video.videoHeight, z.out);
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
    repositionAll();
    updateKeyPlayhead();
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
  buildKeyTrack();
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
  updateKeyPlayhead();
});

timeline.addEventListener("input", () => {
  if (video.duration) video.currentTime = (timeline.value / 1000) * video.duration;
  repositionAll();
  updateKeyPlayhead();
  redraw();
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
  layoutOutStage();
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
  if (!state.currentId) {
    state.currentZoneId = null;
    state.selKeyT = null;
    rebuildRectLayer();
    rebuildOutLayer();
    buildZoneList();
    buildLegend();
    buildKeyTrack();
    updateTemplateNameInputs();
    updateZoneProps();
    redraw();
  }
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
  layoutOutStage();
  redraw();
}).observe(canvasWrap);

new ResizeObserver(() => {
  repositionAll();
  redraw();
}).observe(stage);

btnLoadVideo.addEventListener("click", loadVideo);

(async function init() {
  window.I18n.initI18n();
  initResolution();
  await initTabs();
  layoutOutStage();
  buildKeyTrack();
  loadOverlay();
})();

document.addEventListener("langchange", () => {
  initTabs();
  if (state.currentId) {
    rebuildRectLayer();
    rebuildOutLayer();
    buildZoneList();
    buildLegend();
    buildKeyTrack();
    updateTemplateNameInputs();
    updateZoneProps();
    redraw();
  }
  templateTabs.querySelectorAll("button").forEach((b) => {
    b.classList.toggle("active", b.dataset.id === state.currentId);
  });
  updateRenderEnabled();
});