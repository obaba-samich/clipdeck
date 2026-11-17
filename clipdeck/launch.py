"""Opens the library in Clipdeck's own desktop window (window.py, GTK + WebKit).

Falls back to a Chrome --app window, then the default browser, if GTK/WebKit
aren't installed.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

WINDOW = Path(__file__).with_name("window.py")
SYSTEM_PY = "/usr/bin/python3"

_BROWSERS = ("google-chrome", "chromium", "chromium-browser", "brave-browser", "microsoft-edge")


def _has_flatpak(app: str) -> bool:
    return bool(shutil.which("flatpak")) and subprocess.run(
        ["flatpak", "info", app], capture_output=True).returncode == 0


def _native_ok() -> bool:
    return subprocess.run(
        [SYSTEM_PY, "-c", "import gi; gi.require_version('Gtk','4.0'); gi.require_version('Adw','1'); "
                          "gi.require_version('WebKit','6.0'); from gi.repository import Gtk, Adw, WebKit"],
        capture_output=True).returncode == 0


def open_window(url: str) -> None:
    if _native_ok():
        # Only one window: a second launch hands the URL to the open one (GApplication).
        cmd = [SYSTEM_PY, str(WINDOW), url]
    elif _has_flatpak("com.google.Chrome"):
        cmd = ["flatpak", "run", "com.google.Chrome", f"--app={url}"]
    elif b := next((b for b in _BROWSERS if shutil.which(b)), None):
        cmd = [b, f"--app={url}"]
    else:
        cmd = ["xdg-open", url]
    subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
