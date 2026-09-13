#!/usr/bin/env python3
"""Генерирует оверлей assets/overlay.png (1080x1920, RGBA).

Прозрачный холст: tw.png и прочие элементы рисуются отдельными слоями
в пайплайне рендера (см. lib/ffmpeg-graph.js)."""
from PIL import Image

W, H = 1080, 1920
OUT = "/home/opus/prog/crop/assets/overlay.png"

img = Image.new("RGBA", (W, H), (0, 0, 0, 0))

img.save(OUT)
print("ok ->", OUT)