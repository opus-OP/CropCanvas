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

  return {
    zoneAspectNorm,
    zoneSrcRect,
    fitRectToAspect,
    reshapeToAspect,
    resizeWithAspect,
  };
});