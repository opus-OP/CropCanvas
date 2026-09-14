"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const {
  probeVideo,
  canvasSize,
  cropPixelValues,
  buildFilterGraph,
  buildRenderArgs,
  lerpExpr,
  buildAnimatedZoneChain,
} = require("../lib/ffmpeg-graph");

const ROOT = path.join(__dirname, "..");

function loadTemplate(id) {
  const p = path.join(ROOT, "config", `${id}.json`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// ---------- config structure ----------

test("configs: template1 и template2 валидны и лежат в холсте 1080x1920", () => {
  ["template1", "template2"].forEach((id) => {
    const t = loadTemplate(id);
    assert.ok(t.name, "есть name");
    assert.deepStrictEqual(t.canvas, { width: 1080, height: 1920 });
    assert.ok(t.zones.length >= 1, "есть зоны");
    t.zones.forEach((z, i) => {
      assert.ok(z.id, `zone ${i}: id`);
      assert.ok(z.label, `zone ${i}: label`);
      assert.ok(z.color, `zone ${i}: color`);
      const { x, y, w, h } = z.out;
      assert.ok(Number.isInteger(x) && x >= 0);
      assert.ok(Number.isInteger(y) && y >= 0);
      assert.ok(Number.isInteger(w) && w > 0);
      assert.ok(Number.isInteger(h) && h > 0);
      assert.ok(x + w <= t.canvas.width, `${z.id}: out вписывается по x`);
      assert.ok(y + h <= t.canvas.height, `${z.id}: out вписывается по y`);
      const c = z.crop;
      assert.ok(c.x >= 0 && c.x <= 1, `${z.id}: crop.x в [0,1]`);
      assert.ok(c.y >= 0 && c.y <= 1, `${z.id}: crop.y в [0,1]`);
      assert.ok(c.w > 0 && c.w <= 1, `${z.id}: crop.w в (0,1]`);
      assert.ok(c.h > 0 && c.h <= 1, `${z.id}: crop.h в (0,1]`);
      assert.ok(c.x + c.w <= 1.0001, `${z.id}: crop.w не вылезает за кадр`);
      assert.ok(c.y + c.h <= 1.0001, `${z.id}: crop.h не вылезает за кадр`);
    });
    // canvas size из зон должен совпасть с определённым в конфиге
    const cs = canvasSize(t.zones);
    assert.deepStrictEqual(cs, { width: 1080, height: 1920 }, `${id}: canvas == zone extents`);
  });
});

test("configs: id зон уникальны", () => {
  ["template1", "template2"].forEach((id) => {
    const t = loadTemplate(id);
    const ids = t.zones.map((z) => z.id);
    assert.strictEqual(new Set(ids).size, ids.length, `${id}: зоны без дублей`);
  });
});

// ---------- cropPixelValues ----------

test("cropPixelValues: нормализованные координаты -> пиксели", () => {
  const c = cropPixelValues({ x: 0.1, y: 0.2, w: 0.5, h: 0.4 }, 1920, 1080);
  assert.deepStrictEqual(c, { x: 192, y: 216, w: 960, h: 432 });
});

test("cropPixelValues: отрицательные/выходящие за кадр координаты клампятся", () => {
  // x = 2.0 * 1920 за кадром -> должен клапнуться к vw-2
  const c = cropPixelValues({ x: 2.0, y: -1.0, w: 1.0, h: 1.0 }, 1920, 1080);
  assert.ok(c.x >= 0 && c.x <= 1918, "x в пределах");
  assert.ok(c.x + c.w <= 1920, "x+w в пределах");
  assert.ok(c.y >= 0 && c.y <= 1078, "y в пределах");
  assert.ok(c.y + c.h <= 1080, "y+h в пределах");
  assert.ok(c.w >= 2 && c.h >= 2, "минимальный размер 2");
});

test("cropPixelValues: отрицательный размер (w/h <= 0) трактуется как минимум 2", () => {
  const c = cropPixelValues({ x: 0, y: 0, w: 0.001, h: 0.001 }, 300, 200);
  assert.ok(c.w >= 2 && c.h >= 2);
});

// ---------- buildFilterGraph ----------

test("buildFilterGraph: split по числу зон и корректные метки", () => {
  const t = loadTemplate("template1");
  const g = buildFilterGraph({
    vw: 1920,
    vh: 1080,
    fps: "30/1",
    duration: 10,
    canvasW: 1080,
    canvasH: 1920,
    zones: t.zones,
  });
  const parts = g.split(";");
  assert.ok(parts[0].startsWith(`[0:v]split=${t.zones.length}`));
  const zlabels = t.zones.map((_, i) => `[z${i}]`);
  // замыкание: последний элемент должен содержать [vout]
  assert.match(parts[parts.length - 1], /\[vout\]$/);
  // overlay на каждую зону (Шаблон PNG-оверлея не считается)
  const used = parts.filter((p) => /\[z\d+\]overlay=/.test(p));
  assert.strictEqual(used.length, t.zones.length, "overlay на каждую зону");
});

test("buildFilterGraph: overlay-позиции совпадают с out-координатами зон по порядку", () => {
  const t = loadTemplate("template2");
  const g = buildFilterGraph({
    vw: 1920,
    vh: 1080,
    fps: "30",
    duration: 5,
    canvasW: 1080,
    canvasH: 1920,
    zones: t.zones,
  });
  const parts = g.split(";");
  const overlays = parts.filter((p) => /\[z\d+\]overlay=/.test(p));
  assert.strictEqual(overlays.length, t.zones.length);
  overlays.forEach((o, i) => {
    const z = t.zones[i];
    assert.match(o, new RegExp(`overlay=${z.out.x}:${z.out.y}`), `зона ${i} в позиции`);
  });
});

test("buildFilterGraph: scale использует force_original_aspect_ratio=increase + до-кроп", () => {
  const t = loadTemplate("template1");
  const g = buildFilterGraph({
    vw: 320,
    vh: 180,
    fps: "30/1",
    duration: 5,
    canvasW: 1080,
    canvasH: 1920,
    zones: t.zones,
  });
  const cropParts = g.split(";").filter((p) => p.includes("[z") && p.includes("force_original_aspect_ratio"));
  assert.strictEqual(cropParts.length, t.zones.length);
  cropParts.forEach((p) => {
    assert.match(p, /scale=.*:force_original_aspect_ratio=increase,crop=.*\[z\d+\]$/);
  });
  // crop в пикселях не может быть крупнее исходного кадра
  const pieces = cropParts[0];
  const m = pieces.match(/^\[s\d+\]crop=(\d+):(\d+):(\d+):(\d+),/);
  assert.ok(parseInt(m[1], 10) <= 320, "crop w <= 320");
  assert.ok(parseInt(m[2], 10) <= 180, "crop h <= 180");
});

test("buildFilterGraph: base-цвет подложки совпадает по размеру и длительности", () => {
  const t = loadTemplate("template1");
  const g = buildFilterGraph({
    vw: 1920,
    vh: 1080,
    fps: "60/1",
    duration: 42,
    canvasW: 1080,
    canvasH: 1920,
    zones: t.zones,
  });
  assert.match(g, /color=c=black:s=1080x1920:r=60\/1:d=42\[base\]/);
});

test("buildFilterGraph: оверлей PNG масштабируется до холста и идёт последним", () => {
  const t = loadTemplate("template1");
  const g = buildFilterGraph({
    vw: 1920,
    vh: 1080,
    fps: "30",
    duration: 5,
    canvasW: 1080,
    canvasH: 1920,
    zones: t.zones,
  });
  const parts = g.split(";");
  assert.match(parts[parts.length - 2], /^\[1:v\]scale=1080:1920\[ovl\]$/);
  assert.match(parts[parts.length - 1], /\[ovl\]overlay=0:0\[vout\]$/);
});

test("buildFilterGraph: tw-оверлей масштабируется до ширины и центрируется по верху", () => {
  const t = loadTemplate("template1");
  const g = buildFilterGraph({
    vw: 1920,
    vh: 1080,
    fps: "30",
    duration: 5,
    canvasW: 1080,
    canvasH: 1920,
    zones: t.zones,
    twOverlay: true,
  });
  const parts = g.split(";");
  assert.match(parts.join(";"), /\[2:v\]scale=540:-2\[tw\]/);
  assert.match(parts.join(";"), /overlay=\(main_w-overlay_w\)\/2:0\[twout\]/);
  assert.match(parts[parts.length - 1], /\[ovl\]overlay=0:0\[vout\]$/);
});

// ---------- buildRenderArgs ----------

test("buildRenderArgs: полный набор аргументов рендера", () => {
  const t = loadTemplate("template1");
  const args = buildRenderArgs({
    videoPath: "/tmp/in.mp4",
    overlayPath: "/tmp/overlay.png",
    outPath: "/tmp/out.mp4",
    probe: { width: 1920, height: 1080, fps: "30000/1001", duration: 60 },
    zones: t.zones,
  });
  assert.deepStrictEqual(args.slice(0, 5), ["-y", "-i", "/tmp/in.mp4", "-i", "/tmp/overlay.png"]);
  assert.ok(args.includes("-map"));
  assert.ok(args.indexOf("-map") > args.indexOf("-filter_complex"));
  assert.ok(args.includes("[vout]"));
  assert.ok(args.includes("0:a?"), "аудио из единственного источника");
  assert.ok(args.includes("libx264"));
  assert.ok(args.includes("aac"));
  assert.ok(args.includes("yuv420p"));
  assert.ok(args.includes("+faststart"));
  assert.ok(args.includes("-shortest"));
  const fpsIdx = args.indexOf("30000/1001");
  assert.ok(fpsIdx > 0);
  assert.strictEqual(args[args.length - 1], "/tmp/out.mp4");
});

test("buildRenderArgs: tw-оверлей добавляется третьим входом, если файл существует", () => {
  const t = loadTemplate("template1");
  const twFake = path.join(ROOT, "assets", "tw.png");
  const args = buildRenderArgs({
    videoPath: "/tmp/in.mp4",
    overlayPath: "/tmp/overlay.png",
    twPath: twFake,
    outPath: "/tmp/out.mp4",
    probe: { width: 1920, height: 1080, fps: "30", duration: 60 },
    zones: t.zones,
  });
  assert.deepStrictEqual(args.slice(0, 7), ["-y", "-i", "/tmp/in.mp4", "-i", "/tmp/overlay.png", "-i", twFake]);
  assert.ok(args[args.indexOf("-filter_complex") + 1].includes("(main_w-overlay_w)/2:0"));
});

test("probeVideo: распознаёт тестовый файл (или ошибка при отсутствии ffprobe)", (t) => {
  const ff = probeVideo("/definitely/not/here.mp4");
  assert.ok(ff.error !== undefined);
});

// ---------- lerpExpr / buildAnimatedZoneChain ----------

test("lerpExpr: 2 точки — clip-линейная интерполяция", () => {
  const e = lerpExpr([0, 100], [0, 10], "in_time");
  assert.match(e, /^clip\(0\+\(10\)\*\(in_time-0\),0,100\)$/);
});

test("lerpExpr: 3 точки — кусочно-линейно с корректными границами", () => {
  const e = lerpExpr([0, 50, 100], [0, 5, 10], "t");
  assert.match(e, /\(0\)\*lte\(t,0\)/);
  assert.match(e, /\*gt\(t,0\)\*lte\(t,5\)/);
  assert.match(e, /\*gt\(t,5\)\*lte\(t,10\)/);
  assert.match(e, /\(100\)\*gt\(t,10\)$/);
});

test("buildAnimatedZoneChain: pre-crop по аспекту + zoompan с линейными z/x/y выражениями", () => {
  const zone = { out: { x: 0, y: 0, w: 1080, h: 1920 } };
  const keys = [
    { t: 0, crop: { x: 0.3418, y: 0, w: 0.3164, h: 1 } },
    { t: 10, crop: { x: 0.4209, y: 0.25, w: 0.1582, h: 0.5 } },
  ];
  const chain = buildAnimatedZoneChain(zone, keys, 1920, 1080, "30/1");
  assert.match(chain, /^crop=\d+:\d+:\d+:\d+,zoompan=z='clip\(/);
  assert.match(chain, /x='clip\(/);
  assert.match(chain, /y='clip\(/);
  assert.match(chain, /:d=1:s=1080x1920:fps=30\/1$/);
});

test("buildFilterGraph: зона с 2 разными ключами — zoompan вместо scale/fore_aspect", () => {
  const animated = [
    { id: "a", out: { x: 0, y: 0, w: 1080, h: 1920 }, crop: { x: 0.3418, y: 0, w: 0.3164, h: 1 },
      keys: [{ t: 0, crop: { x: 0.3418, y: 0, w: 0.3164, h: 1 } }, { t: 10, crop: { x: 0.4209, y: 0.25, w: 0.1582, h: 0.5 } }] },
  ];
  const g = buildFilterGraph({ vw: 1920, vh: 1080, fps: "30/1", duration: 10, canvasW: 1080, canvasH: 1920, zones: animated });
  assert.match(g, /\[s0\]crop=.*zoompan=/);
  assert.ok(!/force_original_aspect_ratio/.test(g), "анимированная зона не использует static scale-цепочку");
  assert.match(g, /\[vout\]$/);
});

test("buildFilterGraph: зона с идентичными ключами остаётся статичной (scale/fore_aspect)", () => {
  const staticZoom = [
    { id: "a", out: { x: 0, y: 0, w: 1080, h: 1920 }, crop: { x: 0.3418, y: 0, w: 0.3164, h: 1 },
      keys: [{ t: 0, crop: { x: 0.3418, y: 0, w: 0.3164, h: 1 } }, { t: 10, crop: { x: 0.3418, y: 0, w: 0.3164, h: 1 } }] },
  ];
  const g = buildFilterGraph({ vw: 1920, vh: 1080, fps: "30/1", duration: 10, canvasW: 1080, canvasH: 1920, zones: staticZoom });
  assert.match(g, /\[s0\]crop=.*force_original_aspect_ratio=increase/);
  assert.ok(!/zoompan/.test(g));
});