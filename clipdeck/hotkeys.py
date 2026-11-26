"""Global hotkeys through COSMIC's custom keyboard shortcuts.

Wayland doesn't let apps grab keys themselves, so Clipdeck adds its own
entries to COSMIC's shortcuts file (the same thing Settings → Keyboard →
Custom shortcuts writes). Only entries described "Clipdeck: …" are touched,
and the file is backed up before the first change.
"""

from __future__ import annotations

import re
import shutil
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


def apply(hotkeys: dict) -> list[str]:
    """Write Clipdeck's shortcuts. Returns the combos set."""
    text = SHORTCUTS.read_text() if SHORTCUTS.exists() else "{\n}"
    backup = SHORTCUTS.with_name("custom.before-clipdeck")
    if SHORTCUTS.exists() and not backup.exists():
        shutil.copy2(SHORTCUTS, backup)

    kept = [m.group(0).strip() for m in ENTRY.finditer(text) if not (m.group("desc") or "").startswith(TAG)]
    ours = []
    set_ = []
    for combo, desc, args in ((hotkeys.get("clip", ""), "Save clip", "clip"),
                              (hotkeys.get("record", ""), "Start/stop recording", "record")):
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
