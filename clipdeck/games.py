"""Works out which game is running, so clips get tagged and sorted into folders."""

from __future__ import annotations

import os
import re
import time
from pathlib import Path

STEAM_ROOTS = [
    Path.home() / ".steam/steam",
    Path.home() / ".local/share/Steam",
    Path.home() / ".var/app/com.valvesoftware.Steam/.local/share/Steam",
]

# Non-Steam games, matched against a process's command line.
KNOWN = [
    (re.compile(r"sober|org\.vinegarhq\.Sober|RobloxPlayerBeta", re.I), "Roblox"),
    (re.compile(r"net\.minecraft|minecraft-launcher|PrismLauncher.*java|MultiMC.*java", re.I), "Minecraft"),
    (re.compile(r"RobloxStudioBeta", re.I), "Roblox Studio"),
    (re.compile(r"osu!|osu-lazer|osu\.AppImage", re.I), "osu!"),
    (re.compile(r"lutris-wrapper: (.+)", re.I), None),  # name taken from the match
]

# Steam's own tools that also run under a reaper but aren't games.
STEAM_TOOLS = {"228980", "1070560", "1391110", "1628350", "1493710", "2180100", "961940", "1161040", "1887720", "2348590", "2805730", "3658110"}

_TOOL_NAME = re.compile(r"^(Proton|Steam Linux Runtime|Steamworks)", re.I)
_APPID = re.compile(r"AppId=(\d+)")
_NAME = re.compile(r'"name"\s+"([^"]+)"')


def _cmdlines():
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            raw = Path(f"/proc/{pid}/cmdline").read_bytes()
        except OSError:
            continue
        if raw:
            yield raw.replace(b"\0", b" ").decode(errors="replace")


def steam_name(appid: str) -> str | None:
    for root in STEAM_ROOTS:
        for lib in _steam_libraries(root):
            f = lib / f"appmanifest_{appid}.acf"
            if f.exists():
                m = _NAME.search(f.read_text(errors="replace"))
                if m:
                    return m.group(1)
    return None


def _steam_libraries(root: Path) -> list[Path]:
    libs = [root / "steamapps"]
    vdf = root / "steamapps/libraryfolders.vdf"
    if vdf.exists():
        for m in re.finditer(r'"path"\s+"([^"]+)"', vdf.read_text(errors="replace")):
            libs.append(Path(m.group(1)) / "steamapps")
    return [p for p in dict.fromkeys(libs) if p.exists()]


def steam_cover(appid: str) -> Path | None:
    """Steam's cached artwork for a game, if it's on disk."""
    for root in STEAM_ROOTS:
        cache = root / "appcache/librarycache"
        for p in (cache / appid / "library_600x900.jpg", cache / f"{appid}_library_600x900.jpg",
                  cache / appid / "header.jpg", cache / f"{appid}_header.jpg"):
            if p.exists():
                return p
        d = cache / appid
        if d.is_dir():
            for p in sorted(d.rglob("*.jpg")):
                if "600x900" in p.name or "header" in p.name:
                    return p
    return None


def steam_hero(appid: str) -> Path | None:
    for root in STEAM_ROOTS:
        cache = root / "appcache/librarycache"
        for p in (cache / appid / "library_hero.jpg", cache / f"{appid}_library_hero.jpg"):
            if p.exists():
                return p
        d = cache / appid
        if d.is_dir():
            for p in d.rglob("library_hero*.jpg"):
                return p
    return None


class GameDetector:
    """Cached lookup; scanning /proc every call would be wasteful."""

    def __init__(self, ttl: float = 3.0):
        self.ttl = ttl
        self._at = 0.0
        self._cur: tuple[str, str | None] = ("Desktop", None)

    def current(self) -> tuple[str, str | None]:
        """(game name, steam appid or None). 'Desktop' when nothing is running."""
        now = time.monotonic()
        if now - self._at < self.ttl:
            return self._cur
        self._at = now
        self._cur = self._scan()
        return self._cur

    def _scan(self) -> tuple[str, str | None]:
        steam = None
        other = None
        for cmd in _cmdlines():
            if "SteamLaunch" in cmd or "reaper" in cmd:
                m = _APPID.search(cmd)
                if m and m.group(1) not in STEAM_TOOLS:
                    steam = m.group(1)
                    break
            if other is None:
                for rx, name in KNOWN:
                    m = rx.search(cmd)
                    if m:
                        other = name or m.group(1).strip()
                        break
        if steam:
            name = steam_name(steam) or f"Steam {steam}"
            if not _TOOL_NAME.search(name):
                return (name, steam)
        if other:
            return (other, None)
        return ("Desktop", None)

    def gaming(self) -> bool:
        return self.current()[0] != "Desktop"


def safe_folder(name: str) -> str:
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "", name).strip(" .")
    return name or "Desktop"
