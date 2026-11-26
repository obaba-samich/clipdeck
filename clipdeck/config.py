"""Settings, stored as JSON in ~/.config/clipdeck/config.json."""

from __future__ import annotations

import copy
import json
import os
import secrets
import threading
from pathlib import Path

HOME = Path.home()
CONFIG_DIR = Path(os.environ.get("XDG_CONFIG_HOME", HOME / ".config")) / "clipdeck"
DATA_DIR = Path(os.environ.get("XDG_DATA_HOME", HOME / ".local/share")) / "clipdeck"
CACHE_DIR = Path(os.environ.get("XDG_CACHE_HOME", HOME / ".cache")) / "clipdeck"
CONFIG_FILE = CONFIG_DIR / "config.json"
MODEL_DIR = DATA_DIR / "models"

DEFAULTS: dict = {
    "clips_dir": str(HOME / "Videos" / "Clipdeck"),
    "recorder": {
        "enabled": True,
        # Seconds kept in the replay buffer. A clip saves the last N seconds.
        "replay_seconds": 30,  # also the clip length: every clip saves the whole buffer
        # "gpu" (falls back to CPU if the card can't encode) or "cpu". Polaris cards
        # (RX 570 etc.) are always CPU whatever this says; see recorder.encoder_for.
        "encoder": "gpu",
        "monitor": "DP-1",
        "fps": 60,
        # very_high | high | medium | low  (x264 constant quality)
        "quality": "high",
        # "native" or WxH, e.g. "1280x720"
        "resolution": "native",
        "record_game_audio": True,
        "record_mic": True,
        "game_audio_device": "default_output",
        "mic_device": "default_input",
        # ram keeps the buffer in memory, disk writes it to the clips folder.
        "replay_storage": "ram",
        "only_while_gaming": False,
        "show_cursor": True,
        "nice": 5,
    },
    "voice": {
        "enabled": True,
        "phrase": "clip that",
        # 0..1, how sure the recogniser must be before clipping.
        "confidence": 0.75,
        "mic_device": "",  # empty = system default mic
    },
    "hype": {
        # Clips automatically when the mic gets very loud (yelling, cheering).
        "enabled": False,
        "threshold_db": -12.0,
        "min_ms": 350,
        "cooldown_s": 30,
    },
    "feedback": {
        "sound": True,
        "notification": True,
        "volume": 0.6,
    },
    "storage": {
        "max_gb": 0,  # 0 = no limit
        "auto_clean": False,  # when over the limit, move oldest non-favourites to trash
        "trash_days": 30,
    },
    "hotkeys": {
        "clip": "F8",
        "record": "",  # start/stop a full recording
    },
    "server": {
        "port": 7878,
        "lan": True,
        "passcode": "",
        "secret": "",
    },
    "share": {
        "discord_webhook": "",
    },
}


def _merge(base: dict, override: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


class Config:
    def __init__(self, path: Path = CONFIG_FILE):
        self.path = path
        self._lock = threading.Lock()
        self._listeners: list = []
        self.data = self._load()

    def _load(self) -> dict:
        data = DEFAULTS
        if self.path.exists():
            try:
                data = _merge(DEFAULTS, json.loads(self.path.read_text()))
            except (OSError, json.JSONDecodeError):
                data = copy.deepcopy(DEFAULTS)
        data = copy.deepcopy(data)
        changed = False
        if not data["server"]["passcode"]:
            data["server"]["passcode"] = f"{secrets.randbelow(10**6):06d}"
            changed = True
        if not data["server"]["secret"]:
            data["server"]["secret"] = secrets.token_hex(32)
            changed = True
        # Clip length used to be a second setting under the buffer length, which confused it
        # (buffer at 60 s still saved 30 s clips). Now a clip is always the whole buffer.
        if data["recorder"].pop("default_clip_seconds", None) is not None:
            changed = True
        for gone in ("clip_long",):
            if data["hotkeys"].pop(gone, None) is not None:
                changed = True
        if changed or not self.path.exists():
            self._write(data)
        return data

    def _write(self, data: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2))
        tmp.replace(self.path)

    def __getitem__(self, key):
        return self.data[key]

    @property
    def clips_dir(self) -> Path:
        return Path(self.data["clips_dir"]).expanduser()

    def public(self) -> dict:
        """Settings as shown to the web UI (no secret)."""
        d = copy.deepcopy(self.data)
        d["server"].pop("secret", None)
        return d

    def update(self, patch: dict) -> dict:
        with self._lock:
            patch = copy.deepcopy(patch)
            patch.get("server", {}).pop("secret", None)
            old = self.data
            self.data = _merge(self.data, patch)
            self._write(self.data)
        for fn in self._listeners:
            fn(old, self.data)
        return self.public()

    def on_change(self, fn) -> None:
        self._listeners.append(fn)
