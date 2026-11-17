"""Clip-saved sound and desktop notification."""

from __future__ import annotations

import subprocess
import wave
from pathlib import Path

import numpy as np

from .config import CACHE_DIR

SOUNDS = CACHE_DIR / "sounds"
RATE = 48000


def _tone(notes: list[tuple[float, float]], path: Path) -> Path:
    """Soft two-note chime made from sine waves with a quick fade."""
    if path.exists():
        return path
    parts = []
    for freq, length in notes:
        t = np.arange(int(RATE * length)) / RATE
        env = np.minimum(1, t / 0.006) * np.exp(-t * 9)
        wavef = np.sin(2 * np.pi * freq * t) + 0.25 * np.sin(2 * np.pi * freq * 2 * t)
        parts.append(wavef * env)
    sig = np.concatenate(parts) * 0.35
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes((sig * 32767).astype(np.int16).tobytes())
    return path


def saved_sound() -> Path:
    return _tone([(880, 0.09), (1318.5, 0.32)], SOUNDS / "saved.wav")


def error_sound() -> Path:
    return _tone([(392, 0.12), (311, 0.3)], SOUNDS / "error.wav")


def heard_sound() -> Path:
    return _tone([(1046.5, 0.12)], SOUNDS / "heard.wav")


class Feedback:
    def __init__(self, config):
        self.config = config

    def _play(self, path: Path) -> None:
        f = self.config["feedback"]
        if not f["sound"]:
            return
        vol = int(max(0.0, min(1.0, float(f["volume"]))) * 65536)
        subprocess.Popen(["paplay", f"--volume={vol}", str(path)],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def _notify(self, title: str, body: str, icon: str = "camera-video", urgency: str = "low") -> None:
        if not self.config["feedback"]["notification"]:
            return
        subprocess.Popen(["notify-send", "-a", "Clipdeck", "-u", urgency, "-i", icon,
                          "-h", "string:x-canonical-private-synchronous:clipdeck", title, body],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def saved(self, clip: dict, thumb: Path | None = None) -> None:
        self._play(saved_sound())
        secs = round(clip["duration"])
        how = {"voice": "Voice clip", "hype": "Auto clip", "phone": "Clipped from phone"}.get(clip["source"], "Clip saved")
        self._notify(how, f"{clip['game']} · {secs}s", icon=str(thumb) if thumb and thumb.exists() else "camera-video")

    def heard(self) -> None:
        self._play(heard_sound())

    def failed(self, why: str) -> None:
        self._play(error_sound())
        self._notify("Couldn't save clip", why, icon="dialog-error", urgency="normal")
