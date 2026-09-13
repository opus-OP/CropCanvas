#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# UI language for script messages: RU if LANG starts with ru, EN otherwise
if [[ "${LANG:-}" == ru* ]]; then
  MSG_NODE="nodejs не установлен. Установите Node.js LTS с https://nodejs.org"
  MSG_FFMPEG="ffmpeg/ffprobe не найдены — будет использован встроенный бинарник из npm-пакета"
  MSG_DEPS="node_modules не найдено — выполняю npm install..."
  MSG_UNSUPPORTED="Неподдерживаемая платформа: "
else
  MSG_NODE="nodejs is not installed. Install Node.js LTS from https://nodejs.org"
  MSG_FFMPEG="ffmpeg/ffprobe not found — will fall back to the bundled npm binary"
  MSG_DEPS="node_modules missing — running npm install..."
  MSG_UNSUPPORTED="Unsupported platform: "
fi

case "$(uname -s)" in
  Linux) PLATFORM="linux" ;;
  Darwin) PLATFORM="darwin" ;;
  MINGW*|MSYS*|CYGWIN*) PLATFORM="win32" ;;
  *)
    echo "${MSG_UNSUPPORTED}$(uname -s)" >&2
    exit 1
    ;;
esac

if ! command -v node >/dev/null 2>&1; then
  echo "$MSG_NODE" >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "$MSG_DEPS"
  npm install
fi

ELECTRON_FLAGS=()

# Wayland-specific workarounds only on Linux.
if [ "$PLATFORM" = "linux" ]; then
  # Disable GPU-flag workarounds via: GPU_FLAGS=0 ./run.sh
  if [[ "${GPU_FLAGS:-1}" != "0" ]]; then
    ELECTRON_FLAGS+=(--disable-gpu-memory-buffer-video-frames --disable-features=VaapiVideoDecoder --disable-gpu-video-decode)
  fi
  # Wayland flags only when a Wayland session is detected; override via WAYLAND=0 ./run.sh
  if [[ "${WAYLAND:-1}" != "0" ]] && [[ "${XDG_SESSION_TYPE:-}" == wayland || "${DESKTOP_SESSION:-}" == *wayland* ]]; then
    ELECTRON_FLAGS+=(--ozone-platform=wayland --enable-features=UseOzonePlatform)
  fi
fi

exec npx electron . "${ELECTRON_FLAGS[@]}" "$@"