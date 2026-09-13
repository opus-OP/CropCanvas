"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  probeVideo,
  buildRenderArgs,
} = require("../lib/ffmpeg-graph");
const { ffmpegPath, ffprobePath } = require("../lib/ffmpeg-path");

const ROOT = path.join(__dirname, "..");
const OVERLAY = path.join(ROOT, "assets", "overlay.png");
const TW = path.join(ROOT, "assets", "tw.png");

function hasBin(name) {
  if (name.includes("/")) {
    try {
      fs.accessSync(name, fs.constants.X_OK);
      return true;
    } catch (_) {
      return false;
    }
  }
  const r = spawnSync("which", [name], { encoding: "utf8" });
  return r.status === 0;
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function loadZones(id) {
  const p = path.join(ROOT, "config", `${id}.json`);
  return JSON.parse(fs.readFileSync(p, "utf8")).zones;
}

function probeOut(filePath) {
  const r = spawnSync(
    ffprobePath(),
    ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height",
     "-of", "json", filePath],
    { encoding: "utf8" }
  );
  return JSON.parse(r.stdout);
}

test("интеграция: рендер обоих шаблонов через реальный ffmpeg даёт mp4 1080x1920 h264+aac", (t) => {
  if (!hasBin(ffmpegPath()) || !hasBin(ffprobePath())) {
    t.skip("ffmpeg/ffprobe не найдены");
    return;
  }

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "crop-test-"));
  t.after(() => fs.rmSync(workdir, { recursive: true, force: true }));

  const src = path.join(workdir, "src.mp4");
  const s = run(ffmpegPath(), [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    src,
  ]);
  assert.strictEqual(s.code, 0, "генерация исходника: " + s.stderr);

  const probe = probeVideo(src);
  assert.strictEqual(probe.error, undefined, "probe исходника");
  assert.strictEqual(probe.width, 320);
  assert.strictEqual(probe.height, 180);

  for (const id of ["template1", "template2"]) {
    const zones = loadZones(id);
    const outPath = path.join(workdir, `${id}.mp4`);
    const args = buildRenderArgs({
      videoPath: src,
      overlayPath: OVERLAY,
      twPath: TW,
      outPath,
      probe,
      zones,
    });

    const r = run(ffmpegPath(), args);
    assert.strictEqual(r.code, 0, `${id}: ffmpeg выходной код. stderr:\n${r.stderr}`);
    assert.ok(fs.existsSync(outPath), `${id}: файл создан`);
    assert.ok(fs.statSync(outPath).size > 1000, `${id}: файл непустой`);

    const streams = probeOut(outPath).streams || [];
    const v = streams.find((st) => st.codec_type === "video");
    const a = streams.find((st) => st.codec_type === "audio");
    assert.ok(v, `${id}: есть видео-поток`);
    assert.strictEqual(v.codec_name, "h264", `${id}: видеокодек h264`);
    assert.strictEqual(v.width, 1080, `${id}: ширина 1080`);
    assert.strictEqual(v.height, 1920, `${id}: высота 1920`);
    assert.ok(a, `${id}: есть аудио-поток`);
    assert.strictEqual(a.codec_name, "aac", `${id}: аудиокодек aac`);
  }
});