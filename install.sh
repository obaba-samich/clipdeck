#!/usr/bin/env bash
# Sets up Clipdeck for this user: Python env, web app, voice model, `clipdeck` command,
# auto-start service, app launcher entry and the default F8 hotkey.
# Run it again to update after downloading a new version.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$PWD"
MODEL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/clipdeck/models"
MODEL=vosk-model-small-en-us-0.15
GSR=com.dec05eba.gpu_screen_recorder

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m  %s\n' "$*"; }
die() { printf '\033[31mx\033[0m  %s\n' "$*" >&2; exit 1; }

# ---- what this PC needs -------------------------------------------------------

[ "$(id -u)" -ne 0 ] || die "Run this as your normal user, not with sudo."
command -v systemctl >/dev/null || die "Clipdeck needs systemd."

missing=()
need() { command -v "$1" >/dev/null || missing+=("$2"); }
need python3 python3
need ffmpeg ffmpeg
need ffprobe ffmpeg
need pw-record pipewire-bin
need paplay pulseaudio-utils
need notify-send libnotify-bin
need curl curl
need unzip unzip
need flatpak flatpak
command -v python3 >/dev/null && { python3 -c 'import ensurepip, venv' 2>/dev/null || missing+=(python3-venv); }
# A download from the Releases page comes with the web app built; a git clone needs Node to build it.
PREBUILT=0
[ -f clipdeck/static/index.html ] && [ -f clipdeck/assets/tray-idle-22.rgba ] && PREBUILT=1
[ "$PREBUILT" = 1 ] || { need node nodejs; need npm npm; }

if [ ${#missing[@]} -gt 0 ]; then
  pkgs="$(printf '%s\n' "${missing[@]}" | sort -u | tr '\n' ' ')"
  echo "Some things Clipdeck needs aren't installed: $pkgs" >&2
  command -v apt >/dev/null && echo "Install them with:  sudo apt install $pkgs" >&2
  exit 1
fi
python3 -c 'import sys; sys.exit(sys.version_info < (3, 11))' || die "Clipdeck needs Python 3.11 or newer."

if ! flatpak info "$GSR" >/dev/null 2>&1; then
  echo "Clipdeck records with GPU Screen Recorder, which isn't installed. Install it with:" >&2
  echo "  flatpak install --user flathub $GSR" >&2
  echo "(If flathub is missing: flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo)" >&2
  exit 1
fi

# Optional: Clipdeck's own window. Without it the library opens in a browser window instead.
if ! /usr/bin/python3 -c "import gi; gi.require_version('Gtk','4.0'); gi.require_version('Adw','1'); gi.require_version('WebKit','6.0')" 2>/dev/null; then
  warn "Clipdeck will open in your browser. For its own window: sudo apt install python3-gi gir1.2-adw-1 gir1.2-webkit-6.0"
fi

# ---- install ------------------------------------------------------------------

say "Python environment"
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -r requirements.txt

if [ "$PREBUILT" = 1 ]; then
  say "Web app (already built)"
else
  say "Web app"
  (cd web && npm ci --silent && npm run build --silent)
fi

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
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) warn "~/.local/bin isn't on your PATH; log out and back in, or run ~/.local/bin/clipdeck." ;; esac

say "App launcher and icons"
icons="$HOME/.local/share/icons/hicolor"
mkdir -p "$icons/scalable/apps" "$icons/192x192/apps" "$icons/512x512/apps" "$HOME/.local/share/applications"
cp web/public/icons/icon.svg "$icons/scalable/apps/clipdeck.svg"
cp web/public/icons/icon-192.png "$icons/192x192/apps/clipdeck.png"
cp web/public/icons/icon-512.png "$icons/512x512/apps/clipdeck.png"
# Tray icons by name (normal, recording, off), so the panel can load them from the icon theme.
for v in idle rec off; do
  for s in 22 32 64; do
    mkdir -p "$icons/${s}x${s}/apps"
    cp "clipdeck/assets/tray-$v-$s.png" "$icons/${s}x${s}/apps/clipdeck-tray-$v.png"
  done
done
# Older names of the launcher entry.
rm -f "$HOME/.local/share/applications/clipdeck.desktop" "$HOME/.local/share/applications/com.pizza.Clipdeck.desktop"
sed "s#@LAUNCHER@#$HOME/.local/bin/clipdeck#g" desktop/io.github.obaba_samich.Clipdeck.desktop > "$HOME/.local/share/applications/io.github.obaba_samich.Clipdeck.desktop"
command -v update-desktop-database >/dev/null && update-desktop-database -q "$HOME/.local/share/applications" || true
gtk-update-icon-cache -q "$icons" 2>/dev/null || true

say "Auto-start service"
mkdir -p "$HOME/.config/systemd/user"
sed "s#%h/projects/clipdeck#$ROOT#g" systemd/clipdeck.service > "$HOME/.config/systemd/user/clipdeck.service"
systemctl --user daemon-reload
systemctl --user enable clipdeck.service >/dev/null 2>&1
systemctl --user restart clipdeck.service

say "Hotkeys"
.venv/bin/python - <<'PY' || true
from clipdeck.config import Config
from clipdeck import hotkeys
try:
    print("Set:", ", ".join(hotkeys.apply(Config()["hotkeys"])) or "none")
except hotkeys.Unsupported as e:
    print(e)
PY

case "${XDG_CURRENT_DESKTOP:-}" in
  *GNOME*) warn "On GNOME the tray icon needs the AppIndicator extension (Ubuntu has it already)." ;;
esac

say "Done"
echo "Clipdeck is running and in your app launcher. Press F8 to save a clip."
echo "Library: http://localhost:7878"
