(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CropMath = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Нормализованный аспект зоны: отношение w/h в *нормализованных* координатах,
  // при котором пиксельный кроп имеет аспект выходной зоны (out.w:out.h).
  //   pixelW : pixelH = (w*vw) : (h*vh) = out.w : out.h  =>  w/h = (out.w/out.h)*(vh/vw)
  function zoneAspectNorm(out, vw, vh) {
    return (out.w / out.h) * (vh / vw);
  }

  // Эквивалент ffmpeg-цепочки для zone:
  //   crop=Wc:Hc:Xc:Yc, scale=OW:OH:force_original_aspect_ratio=increase, crop=OW:OH
  function zoneSrcRect(crop, vw, vh, out) {
    const sx = crop.x * vw;
    const sy = crop.y * vh;
    const sw = crop.w * vw;
    const sh = crop.h * vh;
    const scale = Math.max(out.w / sw, out.h / sh);
    const cw = out.w / scale;
    const chh = out.h / scale;
    return { sx: sx + (sw - cw) / 2, sy: sy + (sh - chh) / 2, sw: cw, sh: chh };
  }

  // Вписать rect {x,y,w,h} с фиксированным аспектом aspect (норм.) в кадр [0..1]^2.
  function fitRectToAspect(c, aspect, minW) {
    const maxW = 1;
    const maxH = 1;
    let { x, y } = c;
    let w = c.w;
    if (!(w >= 0)) w = minW;
    let h = w / aspect;
    if (h > maxH) { h = maxH; w = h * aspect; }
    if (w > maxW) { w = maxW; h = w / aspect; }
    if (x + w > maxW) { w = maxW - x; h = w / aspect; }
    if (y + h > maxH) { h = maxH - y; w = h * aspect; }
    if (w < minW) { w = minW; h = w / aspect; }
    if (x + w > maxW) x = maxW - w;
    if (y + h > maxH) y = maxH - h;
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    return { x: +x.toFixed(4), y: +y.toFixed(4), w: +w.toFixed(4), h: +h.toFixed(4) };
  }

  // Переформатировать произвольный кроп к аспекту зоны, сохраняя центр и
  // подгоняя под кадр. Используется при загрузке конфига/переключении шаблона.
  function reshapeToAspect(crop, aspect) {
    const cx = crop.x + crop.w / 2;
    const cy = crop.y + crop.h / 2;
    let w = Math.max(0.01, crop.w);
    let h = Math.max(0.01, crop.h);
    if (w / h > aspect) {
      h = w / aspect;
    } else {
      w = h * aspect;
    }
    if (w > 1) { w = 1; h = w / aspect; }
    if (h > 1) { h = 1; w = h * aspect; }
    let x = cx - w / 2;
    let y = cy - h / 2;
    if (x < 0) x = 0;
    if (x + w > 1) x = 1 - w;
    if (y < 0) y = 0;
    if (y + h > 1) y = 1 - h;
    return { x: +x.toFixed(4), y: +y.toFixed(4), w: +w.toFixed(4), h: +h.toFixed(4) };
  }

  // Ресайз с фиксированным аспектом. start — исходный кроп, hint — какие края
  // тянут ({x,y} из -1/0/+1), dnx/dny — дельта в норм. координатах, minW — мин. ширина.
  function resizeWithAspect(start, hint, dnx, dny, aspect, minW) {
    const hx = hint.x;
    const hy = hint.y;
    let newW;
    if (hx !== 0) {
      newW = hx > 0 ? start.w + dnx : start.w - dnx;
    } else {
      const newH = hy < 0 ? start.h - dny : start.h + dny;
      newW = newH * aspect;
    }
    const newH = newW / aspect;

    let x;
    if (hx > 0) x = start.x;
    else if (hx < 0) x = start.x + start.w - newW;
    else x = start.x + (start.w - newW) / 2;

    let y;
    if (hy > 0) y = start.y;
    else if (hy < 0) y = start.y + start.h - newH;
    else y = start.y + (start.h - newH) / 2;

    return fitRectToAspect({ x, y, w: newW, h: newH }, aspect, minW);
  }

  // Масштаб out-областей зон из базового холста (fromW/fromH) в целевое
  // разрешение (toW/toH). Используется при смене разрешения/рендере:
  // превью и ffmpeg-граф работают с одинаковыми пиксельными out-координатами.
  function scaleZones(zones, fromW, fromH, toW, toH) {
    const sx = toW / fromW;
    const sy = toH / fromH;
    return zones.map((z) => {
      let w = Math.max(1, Math.round(z.out.w * sx));
      let h = Math.max(1, Math.round(z.out.h * sy));
      if (w > toW) w = toW;
      if (h > toH) h = toH;
      const x = Math.min(Math.max(0, Math.round(z.out.x * sx)), toW - w);
      const y = Math.min(Math.max(0, Math.round(z.out.y * sy)), toH - h);
      return { id: z.id, label: z.label, labelEn: z.labelEn, color: z.color, out: { x, y, w, h }, crop: z.crop, keys: z.keys };
    });
  }

  // Максимальный центрированный кроп под аспект зоны: по сути reshapeToAspect
  // всего кадра. Дефолтный crop для новой зоны при добавлении в редакторе.
  function centerCropForAspect(aspect) {
    return reshapeToAspect({ x: 0, y: 0, w: 1, h: 1 }, aspect);
  }

  // ---------- keyframes (по хронометражу) ----------

  // Сортировка ключей по t, схлопывание соседних с одинаковым t (оставляем первый).
  // Возвращает новый массив; ключ = { t, crop:{x,y,w,h} }.
  function sortKeys(keys) {
    const arr = (Array.isArray(keys) ? keys : []).slice();
    arr.sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0));
    const out = [];
    for (const k of arr) {
      if (!k || !k.crop) continue;
      if (out.length && Math.abs(out[out.length - 1].t - (Number(k.t) || 0)) < 1e-9) continue;
      out.push({ t: Number(k.t) || 0, crop: k.crop });
    }
    return out;
  }

  // Нормализованный список ключей зоны; старые зоны без keys мигрируют в 2
  // идентичных ключа (t=0 и t=1e9) — поведение остаётся статичным.
  function zoneKeys(z) {
    if (!z) return [];
    const keys = sortKeys(z.keys);
    if (keys.length >= 2) return keys;
    const crop = z.crop && z.crop.w > 0 && z.crop.h > 0
      ? z.crop
      : { x: 0, y: 0, w: 1, h: 1 };
    if (keys.length === 1) {
      return [{ t: 0, crop: { ...keys[0].crop } }, { t: 1e9, crop: { ...keys[0].crop } }];
    }
    return [
      { t: 0, crop: { x: crop.x, y: crop.y, w: crop.w, h: crop.h } },
      { t: 1e9, crop: { x: crop.x, y: crop.y, w: crop.w, h: crop.h } },
    ];
  }

  function lerpNum(a, b, f) {
    return a + (b - a) * f;
  }

  // Кусочно-линейная интерполяция кропа по хронометражу. До первого ключа и
  // после последнего — значение крайнего. Используется и в превью, и в рендере
  // (порядок: множитель по t → координаты кадра → аспект зоны сохраняется, т.к.
  // ключи уже приведены к аспекту зоны).
  function interpCropN(keys, t) {
    const ks = zoneKeys({ keys });
    if (!ks.length) return { x: 0, y: 0, w: 1, h: 1 };
    const time = Number.isFinite(t) ? t : 0;
    if (time <= ks[0].t) return { ...ks[0].crop };
    const last = ks[ks.length - 1];
    if (time >= last.t) return { ...last.crop };
    for (let i = 0; i < ks.length - 1; i++) {
      const a = ks[i];
      const b = ks[i + 1];
      if (time < a.t || time > b.t) continue;
      const f = (b.t - a.t) > 1e-9 ? (time - a.t) / (b.t - a.t) : 0;
      return {
        x: +lerpNum(a.crop.x, b.crop.x, f).toFixed(4),
        y: +lerpNum(a.crop.y, b.crop.y, f).toFixed(4),
        w: +lerpNum(a.crop.w, b.crop.w, f).toFixed(4),
        h: +lerpNum(a.crop.h, b.crop.h, f).toFixed(4),
      };
    }
    return { ...last.crop };
  }

  // Все ли ключи зоны одинаковы по значению (т.е. фактически статично).
  function keysAreStatic(keys) {
    const ks = zoneKeys({ keys });
    if (ks.length <= 1) return true;
    const c0 = ks[0].crop;
    return ks.every((k) =>
      Math.abs(k.crop.x - c0.x) < 1e-6 &&
      Math.abs(k.crop.y - c0.y) < 1e-6 &&
      Math.abs(k.crop.w - c0.w) < 1e-6 &&
      Math.abs(k.crop.h - c0.h) < 1e-6
    );
  }

  // Кламп-копия out-области в границы холста canvasW×canvasH с минимальными
  // размерами. Возвращает целочисленные пиксельные координаты базового холста.
  function fitOutRect(r, canvasW, canvasH, minW, minH) {
    const mw = Math.min(minW, canvasW);
    const mh = Math.min(minH, canvasH);
    let w = Math.max(mw, Math.min(Math.round(r.w), canvasW));
    let h = Math.max(mh, Math.min(Math.round(r.h), canvasH));
    let x = Math.round(clampNum(r.x, 0, canvasW - w));
    let y = Math.round(clampNum(r.y, 0, canvasH - h));
    return { x, y, w, h };
  }

  // Дефолтное расположение новой зоны в редакторе раскладки: пол-холста,
  // каскадный сдвиг, чтобы N-я зона не совпадала с предыдущими.
  function placeNewZoneRect(canvasW, canvasH, count) {
    const w = Math.round(canvasW / 2);
    const h = Math.round(canvasH / 2);
    const step = 48;
    const off = 32 + (count % 6) * step;
    return fitOutRect({ x: off, y: off, w, h }, canvasW, canvasH, 80, 80);
  }

  function clampNum(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  return {
    zoneAspectNorm,
    zoneSrcRect,
    fitRectToAspect,
    reshapeToAspect,
    resizeWithAspect,
    scaleZones,
    centerCropForAspect,
    fitOutRect,
    placeNewZoneRect,
    zoneKeys,
    sortKeys,
    interpCropN,
    keysAreStatic,
  };
});