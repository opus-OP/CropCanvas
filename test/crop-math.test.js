"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { zoneSrcRect, zoneAspectNorm, fitRectToAspect, reshapeToAspect, resizeWithAspect, scaleZones, centerCropForAspect, fitOutRect, placeNewZoneRect, zoneKeys, sortKeys, interpCropN, keysAreStatic } =
  require("../renderer/shared-crop");

const approx = (a, b, eps = 0.02) => Math.abs(a - b) < eps;

const VW = 1920;
const VH = 1080;
// пиксельные аспекты = (w*VW)/(h*VH)
const pixelAspect = (c) => (c.w * VW) / (c.h * VH);

// ---------- zoneAspectNorm ----------

test("zoneAspectNorm: квадратная зона из 16:9 исходника = 0.5625 (норм.)", () => {
  assert.ok(approx(zoneAspectNorm({ w: 1080, h: 1080 }, VW, VH), 0.5625));
});

test("zoneAspectNorm: зона 16:9 из 16:9 исходника = 1 (норм.)", () => {
  assert.ok(approx(zoneAspectNorm({ w: 1080, h: 608 }, VW, VH), 1.0, 0.01));
});

// ---------- reshapeToAspect (переформатирование при загрузке) ----------

test("reshapeToAspect: широкий кроп приводится к квадрату, пиксельный аспект == 1", () => {
  const r = reshapeToAspect({ x: 0, y: 0, w: 1, h: 0.5625 }, zoneAspectNorm({ w: 1080, h: 1080 }, VW, VH));
  assert.ok(approx(pixelAspect(r), 1), "пиксельный аспект квадрата");
  assert.ok(r.w > 0 && r.h > 0);
  assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 1.0001 && r.y + r.h <= 1.0001, "в кадре");
});

test("reshapeToAspect: уже корректная форма не меняется", () => {
  const aspect = zoneAspectNorm({ w: 1080, h: 1080 }, VW, VH); // 0.5625
  const crop = { x: 0.12, y: 0, w: 0.5625, h: 1 };
  const r = reshapeToAspect(crop, aspect);
  assert.ok(approx(pixelAspect(r), 1), "квадрат остаётся квадратом");
  assert.ok(Math.abs(r.x - 0.12) < 0.01 && Math.abs(r.y - 0) < 0.01, "позиция сохранена");
});

test("reshapeToAspect: узкий/высокий кроп расширяется до нужного аспекта", () => {
  const aspect = zoneAspectNorm({ w: 540, h: 1380 }, VW, VH); // 0.22014
  const r = reshapeToAspect({ x: 0, y: 0.1, w: 0.2, h: 1 }, aspect);
  assert.ok(approx(pixelAspect(r), 540 / 1380, 0.01), "пиксельный аспект == 540:1380");
  assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 1.0001 && r.y + r.h <= 1.0001, "в кадре");
});

// ---------- fitRectToAspect ----------

test("fitRectToAspect: возвращает rect внутри кадра с заданным норм. аспектом", () => {
  const r = fitRectToAspect({ x: 0.95, y: 0.95, w: 0.4, h: 0.5 }, 0.5625, 0.02);
  assert.ok(approx(r.w / r.h, 0.5625, 0.001), "аспект сохранён");
  assert.ok(r.x >= 0 && r.x + r.w <= 1.0001, "по x в кадре");
  assert.ok(r.y >= 0 && r.y + r.h <= 1.0001, "по y в кадре");
});

test("fitRectToAspect: учитывает минимальную ширину", () => {
  const r = fitRectToAspect({ x: 0, y: 0, w: 0.001, h: 0.001 }, 0.5625, 0.05);
  assert.ok(r.w >= 0.05, "не меньше minW");
});

// ---------- resizeWithAspect (ресайз с фиксированным аспектом) ----------

test("resizeWithAspect: правый край тянет квадрат, пиксельный аспект == 1", () => {
  const aspect = zoneAspectNorm({ w: 1080, h: 1080 }, VW, VH);
  const start = { x: 0.2, y: 0.22, w: 0.4, h: 0.7111 };
  const r = resizeWithAspect(start, { x: 1, y: 0 }, 0.1, 0.0, aspect, 0.02);
  assert.ok(approx(pixelAspect(r), 1, 0.02), "результат — пиксельный квадрат");
  assert.ok(r.x + r.w <= 1.0001 && r.y + r.h <= 1.0001, "в кадре");
  assert.ok(r.w > start.w, "ширина выросла после drag вправо");
});

test("resizeWithAspect: верхний край тянет вниз не ломая нижнюю границу", () => {
  const aspect = zoneAspectNorm({ w: 1080, h: 1080 }, VW, VH);
  const start = { x: 0.3, y: 0.1, w: 0.4, h: 0.7111 };
  const r = resizeWithAspect(start, { x: 0, y: -1 }, 0.0, 0.15, aspect, 0.02);
  assert.ok(approx(pixelAspect(r), 1, 0.02), "пиксельный квадрат");
  assert.ok(approx(r.h, 0.7111 - 0.15, 0.02), "высота уменьшилась как надо");
  assert.ok(approx(r.y + r.h, start.y + start.h, 0.02), "нижняя граница зафиксирована");
});

test("resizeWithAspect: тянем за любой угол — аспект всегда сохраняется", () => {
  const aspect = 0.5625;
  const start = { x: 0.25, y: 0.25, w: 0.5, h: 0.8889 };
  ["nw", "ne", "se", "sw"].forEach((h) => {
    const hints = { nw: { x: -1, y: -1 }, ne: { x: 1, y: -1 }, se: { x: 1, y: 1 }, sw: { x: -1, y: 1 } };
    const r = resizeWithAspect(start, hints[h], 0.12, 0.05, aspect, 0.02);
    assert.ok(approx(r.w / r.h, aspect, 0.01), `угол ${h}: норм. аспект`);
    assert.ok(r.x >= -0.001 && r.y >= -0.001 && r.x + r.w <= 1.001 && r.y + r.h <= 1.001, `угол ${h}: в кадре`);
  });
});

// ---------- zoneSrcRect ----------

test("zoneSrcRect: идеальные пропорции совпадают (без лишнего кропа)", () => {
  // source 16:9, crop = весь кадр, out = 1080x1920 (9:16)
  const r = zoneSrcRect(
    { x: 0, y: 0, w: 1, h: 0.5625 }, // 16:9
    1920, 1080,
    { w: 1080, h: 1920 }
  );
  // scale = max(1080/1920, 1920/1080) = 1.777...; cw=1080/s=607.5; chh=1920/s=1080
  assert.ok(r.sw > 0 && r.sh > 0);
  assert.ok(r.sw < 1920, "source rect не шире исходника");
  assert.ok(r.sh <= 1081, "source rect по высоте = исходник");
  assert.ok(r.sx >= 0, "sx >= 0");
  assert.ok(r.sy >= -0.1, "sy ~ 0");
});

test("zoneSrcRect: source rect шире, чем нужно для tall out -> горизонтально обрезается по центру", () => {
  const crop = { x: 0, y: 0, w: 1, h: 1 };
  const out = { w: 100, h: 400 }; // очень вытянутый вертикально
  const r = zoneSrcRect(crop, 800, 600, out);
  // scale = max(100/800, 400/600) = 0.666...
  // cw = 100 / 0.666... = 150; chh = 400 / 0.666 = 600
  assert.ok(r.sw <= 801, "не шире исходника");
  assert.ok(r.sh <= 601, "не выше исходника");
  assert.ok(r.sx >= -0.01, "sx >= 0");
  assert.ok(r.sy <= 0.01, "sy ~ 0 (source высота совпадает)");
});

test("zoneSrcRect: маленький crop, большой out -> масштабирование вверх", () => {
  const crop = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
  const out = { w: 2000, h: 2000 };
  const r = zoneSrcRect(crop, 1000, 1000, out);
  // crop region = 500x500; scale = max(2000/500,2000/500)=4; cw=ch=500; src area = 500x500 centered
  assert.ok(r.sw >= 499 && r.sw <= 501, "sw ~ 500");
  assert.ok(r.sh >= 499 && r.sh <= 501, "sh ~ 500");
  assert.ok(r.sx >= 249 && r.sx <= 251, "sx centered");
});

test("zoneSrcRect: полный кадр 1:1 -> возвращает весь кадр", () => {
  const r = zoneSrcRect(
    { x: 0, y: 0, w: 1, h: 1 },
    1000,
    1000,
    { w: 500, h: 500 }
  );
  assert.ok(r.sx >= -0.01 && r.sx <= 0.01);
  assert.ok(r.sy >= -0.01 && r.sy <= 0.01);
  assert.ok(r.sw >= 999 && r.sw <= 1001);
  assert.ok(r.sh >= 999 && r.sh <= 1001);
});

test("zoneSrcRect: source rect offsets -> dest rect совпадает по размеру out", () => {
  const crop = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
  const out = { w: 300, h: 600 };
  const r = zoneSrcRect(crop, 1600, 900, out);
  const expectedScale = Math.max(out.w / r.sw, out.h / r.sh);
  const destW = Math.round(r.sw * expectedScale);
  const destH = Math.round(r.sh * expectedScale);
  // после масштабирования и центрированного кропа в out
  assert.ok(
    Math.abs(destW - out.w) <= 2 || Math.abs(destH - out.h) <= 2,
    "хотя бы одна ось совпадает после cover"
  );
});

// ---------- scaleZones ----------

test("scaleZones: 1080x1920 -> 720x1280 пропорционально уменьшает out", () => {
  const zones = [
    { id: "a", out: { x: 0, y: 0, w: 1080, h: 232 } },
    { id: "b", out: { x: 0, y: 232, w: 1080, h: 608 } },
    { id: "c", out: { x: 0, y: 840, w: 1080, h: 1080 } },
  ];
  const r = scaleZones(zones, 1080, 1920, 720, 1280);
  assert.strictEqual(r.length, 3);
  const last = r[2];
  assert.strictEqual(last.out.x, 0);
  assert.strictEqual(last.out.y, 560);
  assert.strictEqual(last.out.w, 720);
  assert.strictEqual(last.out.h, 720, "заполняет весь холст по высоте");
  assert.ok(r.every((z) => z.out.x >= 0 && z.out.y >= 0 && z.out.x + z.out.w <= 720 && z.out.y + z.out.h <= 1280));
});

test("scaleZones: 1080x1920 -> 1080x1080 ограничивает зоны в рамки холста", () => {
  const zones = [{ id: "a", out: { x: 0, y: 0, w: 1080, h: 1920 } }];
  const r = scaleZones(zones, 1080, 1920, 1080, 1080);
  assert.strictEqual(r[0].out.w, 1080);
  assert.ok(r[0].out.h <= 1080, "высота клампится к 1080");
  assert.strictEqual(r[0].out.x, 0);
  assert.strictEqual(r[0].out.y, 0);
});

// ---------- centerCropForAspect (дефолтный кроп новой зоны) ----------

test("centerCropForAspect: квадрат из 16:9 исходника — максимальный центрированный", () => {
  const r = centerCropForAspect(zoneAspectNorm({ w: 1080, h: 1080 }, 1920, 1080)); // 0.5625
  assert.ok(approx(r.w / r.h, 0.5625, 0.001), "норм. аспект сохранён");
  assert.ok(r.h >= 0.999 && r.h <= 1, "заполняет высоту кадра");
  assert.ok(approx(r.x, (1 - r.w) / 2, 0.001), "по центру по горизонтали");
  assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 1.0001 && r.y + r.h <= 1.0001, "в кадре");
});

test("centerCropForAspect: вертикальная зона 9:16 центрируется по обеим осям", () => {
  const aspect = zoneAspectNorm({ w: 540, h: 1380 }, 1280, 720); // (540/1380)*(720/1280)
  const r = centerCropForAspect(aspect);
  assert.ok(approx(r.w / r.h, aspect, 0.001), "норм. аспект");
  assert.ok(approx(r.x, (1 - r.w) / 2, 0.001) && approx(r.y, (1 - r.h) / 2, 0.001), "центрирован");
  assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 1.0001 && r.y + r.h <= 1.0001, "в кадре");
});

// ---------- fitOutRect (кламп out в холст) ----------

test("fitOutRect: координаты за краями поджимаются в холст, размерно сохраняется", () => {
  const r = fitOutRect({ x: -50, y: 2500, w: 1200, h: 300 }, 1080, 1920, 16, 16);
  assert.strictEqual(r.x, 0);
  assert.strictEqual(r.y, 1620);
  assert.strictEqual(r.w, 1080);
  assert.strictEqual(r.h, 300);
});

test("fitOutRect: размер меньше минимума расширяется до минимума", () => {
  const r = fitOutRect({ x: 0, y: 0, w: 2, h: 2 }, 1080, 1920, 16, 16);
  assert.ok(r.w >= 16 && r.h >= 16, "не меньше минимума");
});

test("fitOutRect: производит целые пиксели", () => {
  const r = fitOutRect({ x: 12.6, y: 33.3, w: 500.9, h: 700.1 }, 1080, 1920, 16, 16);
  assert.ok(Number.isInteger(r.x) && Number.isInteger(r.y) && Number.isInteger(r.w) && Number.isInteger(r.h));
});

// ---------- placeNewZoneRect (дефолтная раскладка новой зоны) ----------

test("placeNewZoneRect: зона помещается в холст и занимает пол-холста", () => {
  const r = placeNewZoneRect(1080, 1920, 0);
  assert.strictEqual(r.w, 540);
  assert.strictEqual(r.h, 960);
  assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 1080 && r.y + r.h <= 1920, "в холсте");
});

test("placeNewZoneRect: последовательные зоны не совпадают позициями (каскад)", () => {
  const a = placeNewZoneRect(1080, 1920, 0);
  const b = placeNewZoneRect(1080, 1920, 1);
  const c = placeNewZoneRect(1080, 1920, 2);
  assert.notDeepStrictEqual(a, b);
  assert.notDeepStrictEqual(b, c);
});

// ---------- zoneKeys / sortKeys ----------

test("zoneKeys: старая зона без keys мигрирует в 2 идентичных ключа", () => {
  const z = { crop: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } };
  const keys = zoneKeys(z);
  assert.strictEqual(keys.length, 2);
  assert.strictEqual(keys[0].t, 0);
  assert.strictEqual(keys[1].t, 1e9);
  assert.deepStrictEqual(keys[0].crop, keys[1].crop);
  assert.deepStrictEqual(keys[0].crop, z.crop);
});

test("zoneKeys: сортировка по t и схлопывание одинаковых t (оставляем первый)", () => {
  const z = { keys: [{ t: 5, crop: { x: 0, y: 0, w: 1, h: 1 } }, { t: 1, crop: { x: 0, y: 0, w: 1, h: 1 } }, { t: 1, crop: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } }] };
  const keys = zoneKeys(z);
  assert.strictEqual(keys.length, 2);
  assert.strictEqual(keys[0].t, 1);
  assert.strictEqual(keys[0].crop.x, 0); // первый из двух с t=1
  assert.strictEqual(keys[1].t, 5);
});

// ---------- interpCropN ----------

test("interpCropN: 2 ключа — линейная интерполяция x,y,w,h", () => {
  const keys = [
    { t: 0, crop: { x: 0, y: 0, w: 0.5, h: 0.5 } },
    { t: 10, crop: { x: 0.5, y: 1, w: 1, h: 1 } },
  ];
  assert.deepStrictEqual(interpCropN(keys, 5), { x: 0.25, y: 0.5, w: 0.75, h: 0.75 });
});

test("interpCropN: до первого ключа и после последнего — значение крайнего", () => {
  const keys = [
    { t: 2, crop: { x: 0, y: 0, w: 0.2, h: 0.2 } },
    { t: 8, crop: { x: 0.8, y: 0.8, w: 0.2, h: 0.2 } },
  ];
  assert.deepStrictEqual(interpCropN(keys, 0), keys[0].crop);
  assert.deepStrictEqual(interpCropN(keys, 10), keys[1].crop);
});

test("interpCropN: 3 ключа — кусочно-линейно", () => {
  const keys = [
    { t: 0, crop: { x: 0, y: 0, w: 0.2, h: 0.2 } },
    { t: 5, crop: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } },
    { t: 10, crop: { x: 1, y: 1, w: 1, h: 1 } },
  ];
  assert.deepStrictEqual(interpCropN(keys, 0), keys[0].crop);
  assert.deepStrictEqual(interpCropN(keys, 5), keys[1].crop);
  assert.deepStrictEqual(interpCropN(keys, 10), keys[2].crop);
  const mid = interpCropN(keys, 2.5);
  assert.ok(approx(mid.x, 0.25), "сегмент 0–5: x");
  assert.ok(approx(mid.w, 0.35), "сегмент 0–5: w");
  assert.ok(approx(interpCropN(keys, 7.5).x, 0.75), "сегмент 5–10: x");
});

// ---------- keysAreStatic ----------

test("keysAreStatic: true когда все ключи совпадают по значениям", () => {
  assert.ok(keysAreStatic([{ t: 0, crop: { x: 0.1, y: 0, w: 1, h: 1 } }, { t: 10, crop: { x: 0.1, y: 0, w: 1, h: 1 } }]));
  assert.ok(!keysAreStatic([{ t: 0, crop: { x: 0, y: 0, w: 0.5, h: 0.5 } }, { t: 10, crop: { x: 0.5, y: 0.5, w: 1, h: 1 } }]));
});