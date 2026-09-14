"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const { ffprobePath } = require("./ffmpeg-path");
const CropMath = require("../renderer/shared-crop");

// ---------- probe ----------

function probeVideo(filePath) {
  const args = [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,r_frame_rate,avg_frame_rate",
    "-show_entries", "format=duration",
    "-of", "json",
    filePath,
  ];
  const res = spawnSync(ffprobePath(), args, { encoding: "utf8" });
  if (res.error || res.status !== 0) {
    return { error: res.stderr || "ffprobe failed" };
  }
  try {
    const data = JSON.parse(res.stdout);
    const s = data.streams && data.streams[0];
    const f = data.format;
    if (!s) return { error: "no video stream" };
    const width = parseInt(s.width, 10);
    const height = parseInt(s.height, 10);
    let fps = s.r_frame_rate;
    if (!fps || fps === "0/0") fps = s.avg_frame_rate;
    if (!fps || fps === "0/0") fps = "30";
    const dur = f && f.duration ? parseFloat(f.duration) : null;
    return { width, height, fps, duration: dur };
  } catch (e) {
    return { error: String(e) };
  }
}

// ---------- geometry ----------

function canvasSize(zones) {
  let width = 1080;
  let height = 1920;
  for (const z of zones) {
    if (!z || !z.out) continue;
    if (z.out.x + z.out.w > width) width = z.out.x + z.out.w;
    if (z.out.y + z.out.h > height) height = z.out.y + z.out.h;
  }
  return { width, height };
}

function cropPixelValues(crop, vw, vh) {
  let x = Math.round(crop.x * vw);
  let y = Math.round(crop.y * vh);
  let w = Math.max(2, Math.round(crop.w * vw));
  let h = Math.max(2, Math.round(crop.h * vh));
  x = Math.min(Math.max(0, x), vw - 2);
  y = Math.min(Math.max(0, y), vh - 2);
  w = Math.min(w, vw - x);
  h = Math.min(h, vh - y);
  return { x, y, w, h };
}

// ---------- keyframe (Ken Burns) expressions ----------

function fmtNum(n) {
  if (!Number.isFinite(n)) return "0";
  return String(Math.round(n * 1e6) / 1e6);
}

// Кусочно-линейная интерполяция из значений в узлах ts; tv — переменная времени
// (в ffmpeg доступна как in_time/t). Корректна на стыках (без двойного учёта):
//   до t0 — v0, между — lerp сегмента, после t_{n-1} — v_{n-1}.
function lerpExpr(vals, ts, tv) {
  const n = vals.length;
  if (n === 1) return fmtNum(vals[0]);
  if (n === 2) {
    const d = (vals[1] - vals[0]) / (ts[1] - ts[0]);
    if (Math.abs(d) < 1e-9) return fmtNum(vals[0]);
    const lo = Math.min(vals[0], vals[1]);
    const hi = Math.max(vals[0], vals[1]);
    return `clip(${fmtNum(vals[0])}+(${fmtNum(d)})*(${tv}-${fmtNum(ts[0])}),${fmtNum(lo)},${fmtNum(hi)})`;
  }
  const parts = [`(${fmtNum(vals[0])})*lte(${tv},${fmtNum(ts[0])})`];
  for (let i = 0; i < n - 1; i++) {
    const t0 = ts[i];
    const t1 = ts[i + 1];
    const d = (vals[i + 1] - vals[i]) / (t1 - t0);
    const expr = `(${fmtNum(vals[i])}+(${fmtNum(d)})*(${tv}-${fmtNum(t0)}))*gt(${tv},${fmtNum(t0)})*lte(${tv},${fmtNum(t1)})`;
    parts.push(expr);
  }
  parts.push(`(${fmtNum(vals[n - 1])})*gt(${tv},${fmtNum(ts[n - 1])})`);
  return parts.join("+");
}

function clampInt(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// Цепочка для анимированной зоны: статичный pre-crop до области максимального
// аспекта зоны, затем zoompan (Ken Burns) — pan через x/y, zomm через z.
// Область [x,y,w,h] ключей пересчитывается в локальные координаты pre-crop,
// z = 1 / локальная ширина, x/y — левый верхний угол в пикселях (zoompan tremble).
function buildAnimatedZoneChain(z, keys, vw, vh, fps) {
  const aspect = CropMath.zoneAspectNorm(z.out, vw, vh);
  const P = CropMath.centerCropForAspect(aspect);
  const cw = Math.max(1, Math.round(P.w * vw));
  const ch = Math.max(1, Math.round(P.h * vh));
  const cx = clampInt(Math.round(P.x * vw), 0, Math.max(0, vw - cw));
  const cy = clampInt(Math.round(P.y * vh), 0, Math.max(0, vh - ch));
  const W = cw;
  const H = ch;

  const ts = keys.map((k) => k.t);
  const zvals = keys.map((k) => {
    const lw = Math.max(0.001, k.crop.w / P.w);
    return 1 / lw;
  });
  const xpx = keys.map((k) => Math.round(((k.crop.x - P.x) / P.w) * W));
  const ypx = keys.map((k) => Math.round(((k.crop.y - P.y) / P.h) * H));

  const EZ = lerpExpr(zvals, ts, "in_time");
  const EX = lerpExpr(xpx, ts, "in_time");
  const EY = lerpExpr(ypx, ts, "in_time");

  return `crop=${cw}:${ch}:${cx}:${cy},zoompan=z='${EZ}':x='${EX}':y='${EY}':d=1:s=${z.out.w}x${z.out.h}:fps=${fps}`;
}

// ---------- ffmpeg filter graph ----------

function buildFilterGraph({ vw, vh, fps, duration, canvasW, canvasH, zones, twOverlay }) {
  const n = zones.length;
  const parts = [];

  parts.push(`[0:v]split=${n}${zones.map((_, i) => `[s${i}]`).join("")}`);

  zones.forEach((z, i) => {
    const keys = CropMath.zoneKeys(z);
    let zchain;
    if (CropMath.keysAreStatic(keys)) {
      const c = cropPixelValues(z.crop && z.crop.w > 0 ? z.crop : keys[0].crop, vw, vh);
      zchain =
        `crop=${c.w}:${c.h}:${c.x}:${c.y},` +
        `scale=${z.out.w}:${z.out.h}:force_original_aspect_ratio=increase,` +
        `crop=${z.out.w}:${z.out.h}`;
    } else {
      zchain = buildAnimatedZoneChain(z, keys, vw, vh, fps);
    }
    parts.push(`[s${i}]${zchain}[z${i}]`);
  });

  parts.push(`color=c=black:s=${canvasW}x${canvasH}:r=${fps}:d=${duration}[base]`);

  let prev = "[base]";
  zones.forEach((z, i) => {
    const label = i === zones.length - 1 ? "[lo]" : `[o${i}]`;
    parts.push(`${prev}[z${i}]overlay=${z.out.x}:${z.out.y}${label}`);
    prev = label;
  });

  if (twOverlay) {
    // tw.png: масштаб до ширины холста, центр по горизонтали, прижата к верху
    parts.push(`[2:v]scale=${canvasW / 2}:-2[tw]`);
    parts.push(`${prev}[tw]overlay=(main_w-overlay_w)/2:0[twout]`);
    prev = "[twout]";
  }

  parts.push(`[1:v]scale=${canvasW}:${canvasH}[ovl]`);
  parts.push(`[${prev.slice(1, -1)}][ovl]overlay=0:0[vout]`);

  return parts.join(";");
}

// ---------- full render command ----------

function buildRenderArgs({ videoPath, overlayPath, twPath, outPath, probe, zones, canvasW, canvasH }) {
  const computed = canvasSize(zones);
  const canvas = {
    width: canvasW || computed.width,
    height: canvasH || computed.height,
  };
  const twOverlay = !!twPath && fs.existsSync(twPath);
  const filter = buildFilterGraph({
    vw: probe.width,
    vh: probe.height,
    fps: probe.fps,
    duration: probe.duration || 600,
    canvasW: canvas.width,
    canvasH: canvas.height,
    zones,
    twOverlay,
  });

  const inputs = ["-y", "-i", videoPath, "-i", overlayPath];
  if (twOverlay) inputs.push("-i", twPath);

  return [
    ...inputs,
    "-filter_complex", filter,
    "-map", "[vout]",
    "-map", "0:a?",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-r", probe.fps,
    "-movflags", "+faststart",
    "-shortest",
    "-nostats",
    "-progress", "pipe:1",
    outPath,
  ];
}

module.exports = {
  probeVideo,
  canvasSize,
  cropPixelValues,
  buildFilterGraph,
  buildRenderArgs,
  lerpExpr,
  buildAnimatedZoneChain,
};