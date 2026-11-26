"""Global hotkeys through the desktop's own custom keyboard shortcuts.

Wayland doesn't let apps grab keys themselves, so Clipdeck adds entries to the
desktop's custom shortcuts (the same thing its keyboard settings write):
  - COSMIC: its shortcuts file. Only entries described "Clipdeck: …" are touched,
    and the file is backed up before the first change.
  - GNOME (and Ubuntu's GNOME): gsettings custom keybindings named clipdeck-*.
Other desktops (KDE, …) can't be set up from here; Settings shows the command to
bind by hand instead.
"""

from __future__ import annotations

import ast
import os
import re
import shutil
import subprocess
from pathlib import Path

SHORTCUTS = Path.home() / ".config/cosmic/com.system76.CosmicSettings.Shortcuts/v1/custom"
LAUNCHER = Path.home() / ".local/bin/clipdeck"
TAG = "Clipdeck: "

MOD_NAMES = {"control": "Ctrl", "ctrl": "Ctrl", "shift": "Shift", "alt": "Alt", "super": "Super", "meta": "Super"}
KEY_NAMES = {
    " ": "space", "Space": "space", ",": "comma", ".": "period", "/": "slash", "-": "minus", "=": "equal",
    "ArrowUp": "Up", "ArrowDown": "Down", "ArrowLeft": "Left", "ArrowRight": "Right",
    "PrintScreen": "Print", "Pause": "Pause", "ScrollLock": "Scroll_Lock", "Insert": "Insert",
    "Home": "Home", "End": "End", "PageUp": "Prior", "PageDown": "Next",
}

# One entry: ( modifiers: [...], key: "...", description: Some("...") ): Action(...),
ENTRY = re.compile(r"\(\s*modifiers:\s*\[[^\]]*\],\s*key:\s*\"[^\"]*\",\s*(?:description:\s*(?:Some\(\"(?P<desc>[^\"]*)\"\)|None),\s*)?\)\s*:\s*\w+(?:\((?:\"(?:[^\"\\]|\\.)*\"|[^()])*\))?\s*,?", re.S)


def parse(combo: str) -> tuple[list[str], str] | None:
    parts = [p for p in combo.split("+") if p]
    if not parts:
        return None
    *mods, key = parts
    key = KEY_NAMES.get(key, key)
    if len(key) == 1:
        key = key.lower()
    return [MOD_NAMES.get(m.lower(), m) for m in mods], key


def _entry(combo: str, desc: str, args: str) -> str | None:
    p = parse(combo)
    if not p:
        return None
    mods, key = p
    mods_s = ", ".join(mods)
    cmd = f"{LAUNCHER} {args}".replace("\\", "\\\\").replace('"', '\\"')
    return (f"    (\n        modifiers: [{mods_s}],\n        key: \"{key}\",\n"
            f"        description: Some(\"{TAG}{desc}\"),\n    ): Spawn(\"{cmd}\"),\n")


class Unsupported(Exception):
    pass


ACTIONS = (("clip", "Save clip", "clip"), ("record", "Start/stop recording", "record"))


def desktop() -> str | None:
    """'cosmic', 'gnome', or None when Clipdeck can't set shortcuts on this desktop."""
    env = os.environ.get("XDG_CURRENT_DESKTOP", "").upper()
    if "COSMIC" in env:
        return "cosmic"
    if any(d in env for d in ("GNOME", "UBUNTU", "UNITY")):
        return "gnome"
    if not env and SHORTCUTS.parent.parent.exists():
        return "cosmic"
    return None


def info() -> dict:
    return {"desktop": desktop(), "name": os.environ.get("XDG_CURRENT_DESKTOP", "") or "your desktop",
            "command": f"{LAUNCHER} clip", "record_command": f"{LAUNCHER} record"}


def apply(hotkeys: dict) -> list[str]:
    """Set Clipdeck's shortcuts on this desktop. Returns the combos set."""
    d = desktop()
    if d == "cosmic":
        return _apply_cosmic(hotkeys)
    if d == "gnome":
        return _apply_gnome(hotkeys)
    raise Unsupported(f"Clipdeck can't set shortcuts on {info()['name']}. "
                      f"Add one in your keyboard settings that runs: {LAUNCHER} clip")


# GNOME ------------------------------------------------------------------------

GNOME_SCHEMA = "org.gnome.settings-daemon.plugins.media-keys"
GNOME_BASE = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/"
GNOME_MODS = {"Ctrl": "<Control>", "Shift": "<Shift>", "Alt": "<Alt>", "Super": "<Super>"}


def _gsettings(*args: str) -> str:
    out = subprocess.run(["gsettings", *args], capture_output=True, text=True, timeout=10)
    if out.returncode != 0:
        raise OSError(out.stderr.strip() or "gsettings failed")
    return out.stdout.strip()


def _apply_gnome(hotkeys: dict) -> list[str]:
    raw = _gsettings("get", GNOME_SCHEMA, "custom-keybindings")
    current = [] if raw.startswith("@as") else ast.literal_eval(raw)
    keep = [p for p in current if not p.startswith(GNOME_BASE + "clipdeck-")]
    ours, set_ = [], []
    for name, desc, args in ACTIONS:
        combo = hotkeys.get(name, "")
        path = f"{GNOME_BASE}clipdeck-{name}/"
        p = parse(combo) if combo else None
        if not p:
            continue
        mods, key = p
        schema = f"{GNOME_SCHEMA}.custom-keybinding:{path}"
        _gsettings("set", schema, "name", TAG + desc)
        _gsettings("set", schema, "command", f"{LAUNCHER} {args}")
        _gsettings("set", schema, "binding", "".join(GNOME_MODS.get(m, f"<{m}>") for m in mods) + key)
        ours.append(path)
        set_.append(combo)
    _gsettings("set", GNOME_SCHEMA, "custom-keybindings", str(keep + ours))
    return set_


# COSMIC -----------------------------------------------------------------------

def _apply_cosmic(hotkeys: dict) -> list[str]:
    text = SHORTCUTS.read_text() if SHORTCUTS.exists() else "{\n}"
    backup = SHORTCUTS.with_name("custom.before-clipdeck")
    if SHORTCUTS.exists() and not backup.exists():
        shutil.copy2(SHORTCUTS, backup)

    kept = [m.group(0).strip() for m in ENTRY.finditer(text) if not (m.group("desc") or "").startswith(TAG)]
    ours = []
    set_ = []
    for name, desc, args in ACTIONS:
        combo = hotkeys.get(name, "")
        e = _entry(combo, desc, args) if combo else None
        if e:
            ours.append(e)
            set_.append(combo)

    body = "".join("    " + k.rstrip(",") + ",\n" for k in kept) + "".join(ours)
    SHORTCUTS.parent.mkdir(parents=True, exist_ok=True)
    tmp = SHORTCUTS.with_suffix(".tmp")
    tmp.write_text("{\n" + body + "}")
    tmp.replace(SHORTCUTS)
    return set_
