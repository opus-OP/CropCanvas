"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const { ffprobePath } = require("./ffmpeg-path");

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

// ---------- ffmpeg filter graph ----------

function buildFilterGraph({ vw, vh, fps, duration, canvasW, canvasH, zones, twOverlay }) {
  const n = zones.length;
  const parts = [];

  parts.push(`[0:v]split=${n}${zones.map((_, i) => `[s${i}]`).join("")}`);

  zones.forEach((z, i) => {
    const c = cropPixelValues(z.crop, vw, vh);
    parts.push(
      `[s${i}]crop=${c.w}:${c.h}:${c.x}:${c.y},` +
        `scale=${z.out.w}:${z.out.h}:force_original_aspect_ratio=increase,` +
        `crop=${z.out.w}:${z.out.h}[z${i}]`
    );
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

function buildRenderArgs({ videoPath, overlayPath, twPath, outPath, probe, zones }) {
  const canvas = canvasSize(zones);
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
    outPath,
  ];
}

module.exports = {
  probeVideo,
  canvasSize,
  cropPixelValues,
  buildFilterGraph,
  buildRenderArgs,
};