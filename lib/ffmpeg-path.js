"use strict";

const fs = require("fs");

function resolveBin(staticPath, name) {
  if (staticPath) {
    try {
      if (fs.existsSync(staticPath)) return staticPath;
    } catch (_) {
      /* fall through to PATH */
    }
  }
  return name;
}

function ffmpegPath() {
  let p = null;
  try {
    p = require("ffmpeg-static");
  } catch (_) {
    /* not installed */
  }
  return resolveBin(p, "ffmpeg");
}

function ffprobePath() {
  let p = null;
  try {
    p = require("ffprobe-static").path;
  } catch (_) {
    /* not installed */
  }
  return resolveBin(p, "ffprobe");
}

module.exports = { ffmpegPath, ffprobePath };