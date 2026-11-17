#!/usr/bin/env bash
# Sets up Clipdeck for this user: Python env, web app, voice model,
# `clipdeck` command, auto-start service and the default F8 hotkey.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$PWD"
MODEL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/clipdeck/models"
MODEL=vosk-model-small-en-us-0.15

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }

command -v flatpak >/dev/null && flatpak info com.dec05eba.gpu_screen_recorder >/dev/null 2>&1 || {
  echo "GPU Screen Recorder isn't installed. Run: flatpak install flathub com.dec05eba.gpu_screen_recorder" >&2
  exit 1
}
for c in ffmpeg ffprobe pw-record notify-send paplay node npm; do
  command -v "$c" >/dev/null || { echo "Missing: $c" >&2; exit 1; }
done

say "Python environment"
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -r requirements.txt

say "Web app"
(cd web && npm ci --silent && npm run build --silent)

if [ ! -d "$MODEL_DIR/$MODEL" ]; then
  say "Voice model (about 40 MB)"
  mkdir -p "$MODEL_DIR"
  tmp="$(mktemp -d)"
  curl -fL --progress-bar -o "$tmp/model.zip" "https://alphacephei.com/vosk/models/$MODEL.zip"
  unzip -q "$tmp/model.zip" -d "$MODEL_DIR"
  rm -rf "$tmp"
fi

say "clipdeck command"
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/clipdeck" <<SH
#!/bin/sh
cd "$ROOT" && exec "$ROOT/.venv/bin/python" -m clipdeck "\$@"
SH
chmod +x "$HOME/.local/bin/clipdeck"

say "Auto-start service"
mkdir -p "$HOME/.config/systemd/user"
cp systemd/clipdeck.service "$HOME/.config/systemd/user/clipdeck.service"
sed -i "s#%h/projects/clipdeck#$ROOT#g" "$HOME/.config/systemd/user/clipdeck.service"
systemctl --user daemon-reload
systemctl --user enable --now clipdeck.service
systemctl --user restart clipdeck.service

say "Hotkeys"
.venv/bin/python -c "from clipdeck.config import Config; from clipdeck import hotkeys; print('Set:', ', '.join(hotkeys.apply(Config()['hotkeys'])) or 'none')"

say "Done"
echo "Library:  http://localhost:7878"
"$HOME/.local/bin/clipdeck" passcode 2>/dev/null || echo "Phone:    see Settings → Phone"

say "App launcher"
for s in 64 128 256 512; do
  d="$HOME/.local/share/icons/hicolor/${s}x${s}/apps"; mkdir -p "$d"
  (cd web && node -e "require('sharp')('public/icons/icon.svg',{density:384}).resize($s,$s).png().toFile('$d/clipdeck.png')")
done
# Tray icons by name (normal, recording, off), so the panel can load them from the icon theme.
for v in idle rec off; do
  for s in 22 32 64; do
    d="$HOME/.local/share/icons/hicolor/${s}x${s}/apps"; mkdir -p "$d"
    cp "clipdeck/assets/tray-$v-$s.png" "$d/clipdeck-tray-$v.png"
  done
done
mkdir -p "$HOME/.local/share/icons/hicolor/scalable/apps" "$HOME/.local/share/applications"
cp web/public/icons/icon.svg "$HOME/.local/share/icons/hicolor/scalable/apps/clipdeck.svg"
rm -f "$HOME/.local/share/applications/clipdeck.desktop"  # old name, from before the native window
sed "s#@LAUNCHER@#$HOME/.local/bin/clipdeck#g" desktop/com.pizza.Clipdeck.desktop > "$HOME/.local/share/applications/com.pizza.Clipdeck.desktop"
command -v update-desktop-database >/dev/null && update-desktop-database -q "$HOME/.local/share/applications" || true
gtk-update-icon-cache -q "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
echo "Clipdeck is in your app launcher now."
