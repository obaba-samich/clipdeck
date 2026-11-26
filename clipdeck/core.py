"""The running app: wires the recorder, mic listener and library together."""

from __future__ import annotations

import logging
import shutil
import threading
import time
from pathlib import Path

from .config import Config
from .db import DB
from .editor import Renderer
from .feedback import Feedback
from .games import GameDetector
from .library import Events, Library
from .listener import Listener
from .recorder import Recorder, SaveRequest
from .tray import Tray

log = logging.getLogger("clipdeck")

RECORDER_KEYS = {"monitor", "fps", "quality", "resolution", "record_game_audio", "record_mic",
                 "game_audio_device", "mic_device", "replay_storage", "replay_seconds", "show_cursor", "nice"}


class Core:
    def __init__(self, config: Config | None = None):
        self.config = config or Config()
        self.db = DB()
        self.events = Events()
        self.library = Library(self.config, self.db, self.events)
        self.feedback = Feedback(self.config)
        self.games = GameDetector()
        self.recorder = Recorder(self.config, self._saved)
        self.listener = Listener(self.config, self._voice, self._hype)
        self.renderer = Renderer(self.db, self.library, self.events, self.db.get_clip)
        self.tray = Tray(self)
        self.feedback.tray = self.tray
        self.config.on_change(self._config_changed)
        self._last_save = 0.0

    def start(self) -> None:
        threading.Thread(target=self.library.scan, daemon=True).start()
        if self.config["recorder"]["enabled"] and not self.config["recorder"]["only_while_gaming"]:
            self.recorder.start()
        self.listener.start()
        self.tray.start()
        threading.Thread(target=self._gaming_loop, daemon=True).start()
        threading.Thread(target=self._alerts_loop, daemon=True).start()
        threading.Thread(target=self._export_alerts, daemon=True).start()

    def stop(self) -> None:
        self.listener.stop()
        self.recorder.stop()

    # clipping ----------------------------------------------------------------

    def clip(self, source: str = "hotkey", seconds: float | None = None) -> dict:
        now = time.monotonic()
        if now - self._last_save < 1.0:
            return {"ok": False, "reason": "Already saving a clip"}
        game, appid = self.games.current()
        if seconds and seconds >= self.config["recorder"]["replay_seconds"]:
            seconds = None  # whole buffer
        req = SaveRequest(source=source, seconds=seconds, game=game, steam_appid=appid)
        if not self.recorder.save(req):
            why = "Replay isn't running" if self.recorder.state != "error" else self.recorder.error
            self.feedback.failed(why)
            return {"ok": False, "reason": why}
        self._last_save = now
        self.feedback.clipping()
        self.events.emit("saving", source=source, game=game)
        return {"ok": True, "game": game}

    def toggle_recording(self, source: str = "web") -> dict:
        game, appid = self.games.current()
        r = self.recorder.toggle_session(SaveRequest(source="record", game=game, steam_appid=appid))
        if r is None:
            why = "Replay isn't running"
            self.feedback.failed(why)
            return {"ok": False, "reason": why}
        self.events.emit("recording", on=r)
        self.feedback.recording(r)
        return {"ok": True, "recording": r}

    def _saved(self, path: Path, req: SaveRequest) -> None:
        try:
            clip = self.library.ingest(path, game=req.game, steam_appid=req.steam_appid,
                                       source=req.source, seconds=req.seconds, created=req.at)
        except Exception as e:
            log.exception("couldn't add %s", path)
            self.feedback.failed(f"The recording couldn't be read ({str(e)[:120]}). The file is kept in {path.parent}.")
            return
        # Thumbnail is made in the background; give it a moment for the notification.
        thumb = self.library.thumb(clip["id"])
        for _ in range(30):
            if thumb.exists():
                break
            time.sleep(0.1)
        self.feedback.saved(clip, thumb)

    def _voice(self, phrase: str) -> None:
        log.info("heard %r", phrase)
        self.events.emit("heard", phrase=phrase)
        self.clip(source="voice")

    def _hype(self) -> None:
        # Wait a few seconds so the reaction itself ends up in the clip.
        log.info("loud moment")
        threading.Timer(4.0, lambda: self.clip(source="hype")).start()

    # background ------------------------------------------------------------

    def _gaming_loop(self) -> None:
        was = None
        while True:
            r = self.config["recorder"]
            gaming = self.games.gaming()
            if r["enabled"] and r["only_while_gaming"]:
                if gaming and self.recorder.state in ("stopped", "error") and was is not True:
                    self.recorder.start()
                elif not gaming and self.recorder.state != "stopped" and was is not False:
                    self.recorder.stop()
                was = gaming
            else:
                was = None
            self.events.emit("game", game=self.games.current()[0])
            time.sleep(5)

    def _alerts_loop(self) -> None:
        """Desktop alerts for things that need attention."""
        last_state = None
        last_disk = 0.0
        while True:
            st = self.recorder.state
            if st == "error" and last_state != "error":
                self.feedback.alert("Replay stopped", self.recorder.error[:200] or "The recorder keeps crashing.")
            last_state = st
            try:
                free = shutil.disk_usage(self.config.clips_dir).free
                if free < 5 * 1024**3 and time.time() - last_disk > 6 * 3600:
                    last_disk = time.time()
                    self.feedback.alert("Clips drive almost full", f"{free / 1024**3:.1f} GB left. Old clips may fail to save.",
                                        action="settings", label="Storage")
            except OSError:
                pass
            time.sleep(10)

    def _export_alerts(self) -> None:
        q = self.events.subscribe()
        while True:
            ev = q.get()
            if ev.get("type") == "render" and ev["job"]["state"] in ("done", "error"):
                self.feedback.exported(ev["job"])

    def _config_changed(self, old: dict, new: dict) -> None:
        o, n = old["recorder"], new["recorder"]
        if (o["enabled"], o["only_while_gaming"]) != (n["enabled"], n["only_while_gaming"]):
            if not n["enabled"]:
                self.recorder.stop()
            elif not n["only_while_gaming"]:
                self.recorder.start()
        elif (any(o[k] != n[k] for k in RECORDER_KEYS) or self.recorder.state == "error") \
                and self.recorder.state != "stopped":
            threading.Thread(target=self.recorder.restart, daemon=True).start()
        if old["voice"] != new["voice"] or old["hype"]["enabled"] != new["hype"]["enabled"] \
                or o["mic_device"] != n["mic_device"]:
            threading.Thread(target=self.listener.start, daemon=True).start()
        if old["clips_dir"] != new["clips_dir"]:
            threading.Thread(target=self.library.scan, daemon=True).start()
            if self.recorder.state != "stopped":  # it writes into <clips_dir>/.incoming
                threading.Thread(target=self.recorder.restart, daemon=True).start()
        self.events.emit("settings")

    def status(self) -> dict:
        game, appid = self.games.current()
        return {
            "recorder": self.recorder.status(),
            "listener": self.listener.status(),
            "game": game,
            "steam_appid": appid,
            "stats": self.db.stats(),
        }
