"""Opens the library in its own app window (Chrome --app), or the default browser."""

from __future__ import annotations

import shutil
import subprocess

_BROWSERS = ("google-chrome", "chromium", "chromium-browser", "brave-browser", "microsoft-edge")


def _has_flatpak(app: str) -> bool:
    return bool(shutil.which("flatpak")) and subprocess.run(
        ["flatpak", "info", app], capture_output=True).returncode == 0


def open_window(url: str) -> None:
    if _has_flatpak("com.google.Chrome"):
        cmd = ["flatpak", "run", "com.google.Chrome", f"--app={url}"]
    elif b := next((b for b in _BROWSERS if shutil.which(b)), None):
        cmd = [b, f"--app={url}"]
    else:
        cmd = ["xdg-open", url]
    subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
