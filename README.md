# CropCanvas — Shorts template builder

English | [Русский](./README.ru.md)

Desktop app (Electron) for building shorts from one source video using reusable
crop templates. Draw crop zones on the source video, the output preview mirrors the
exact ffmpeg filter chain, and one click renders a 1080×1920 H.264+AAC `.mp4`.

UI is bilingual **EN/RU** — switch with the 🌐 button in the toolbar; defaults to
your system locale.

## Features

- Crop-zone templates (Tabs **Template 1 / Template 2**), zones defined in `config/*.json`
- Live output preview on a 1080×1920 canvas that matches the render pipeline
- Drag / resize zones with aspect preserved
- Automatic crop reshaping to zone aspect on load/switch
- Rendering via **bundled** `ffmpeg`/`ffprobe` (`ffmpeg-static`, `ffprobe-static`) —
  no system install required; falls back to system binaries if present
- Optional overlay (`assets/overlay.png`) and top-center watermark (`assets/tw.png`)

## Requirements

- Node.js 18+ (LTS recommended) — https://nodejs.org
- ffmpeg is **optional**: the app bundles static binaries. If you prefer your
  system build, keep `ffmpeg`/`ffprobe` in `PATH` and uninstall `ffmpeg-static`
  `ffprobe-static`.

## Run

```bash
npm install
./run.sh        # Linux/macOS/Windows(git-bash) — detects Wayland on Linux
# or
npm start       # plain electron
```

Linux notes:
- Wayland flags are added automatically when a Wayland session is detected.
  Override with `WAYLAND=0 ./run.sh`; GPU workarounds off: `GPU_FLAGS=0 ./run.sh`.

## Test

```bash
npm test
```

Integration render test uses the bundled ffmpeg and needs no system install.

## Project layout

```
main.js                 Electron main: dialogs, IPC, render pipeline
preload.js              contextBridge API
renderer/               UI (index.html, style.css, app.js, shared-crop.js, i18n.js)
lib/ffmpeg-graph.js     ffprobe probe + ffmpeg filter graph builder
lib/ffmpeg-path.js      resolve bundled system / static binaries
config/template*.json   crop zones (RU + EN labels)
assets/                 overlay.png, tw.png
scripts/gen-overlay.py  regenerate the transparent overlay canvas
test/                   unit + integration tests
```

## License

MIT