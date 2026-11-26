#!/usr/bin/env bash
# Removes Clipdeck from this user: service, hotkeys, `clipdeck` command, launcher entry, icons.
# Your clips, settings and the GPU Screen Recorder flatpak are kept; the paths are printed at the end.
set -uo pipefail
cd "$(dirname "$0")"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }

say "Stopping Clipdeck"
pkill -f "clipdeck/window.py" 2>/dev/null
systemctl --user disable --now clipdeck.service 2>/dev/null
rm -f "$HOME/.config/systemd/user/clipdeck.service"
systemctl --user daemon-reload

say "Removing hotkeys"
if [ -x .venv/bin/python ]; then
  .venv/bin/python -c "from clipdeck import hotkeys
try: hotkeys.apply({})
except Exception as e: print('Remove the Clipdeck shortcuts in your keyboard settings by hand:', e)"
fi

say "Removing the command, launcher entry and icons"
rm -f "$HOME/.local/bin/clipdeck" \
      "$HOME/.local/share/applications/io.github.obaba_samich.Clipdeck.desktop" \
      "$HOME/.local/share/applications/com.pizza.Clipdeck.desktop"
find "$HOME/.local/share/icons/hicolor" \( -name 'clipdeck.png' -o -name 'clipdeck.svg' -o -name 'clipdeck-tray-*.png' \) -delete 2>/dev/null
command -v update-desktop-database >/dev/null && update-desktop-database -q "$HOME/.local/share/applications" || true

say "Done"
clips="$(python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.config/clipdeck/config.json')))['clips_dir'])" 2>/dev/null || echo "$HOME/Videos/Clipdeck")"
echo "Kept (delete them yourself if you want):"
echo "  Clips:     $clips"
echo "  Settings:  ~/.config/clipdeck"
echo "  Database:  ~/.local/share/clipdeck"
echo "  Cache:     ~/.cache/clipdeck"
echo "  This folder: $PWD"
