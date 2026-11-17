"""Listens to the mic for the voice command ("clip that") and for loud moments.

Speech recognition is Vosk, running fully offline with a grammar limited to
the trigger phrases, which keeps CPU use and false triggers low. One mic
stream feeds both features.
"""

from __future__ import annotations

import json
import logging
import subprocess
import threading
import time
from pathlib import Path

import numpy as np

from .config import MODEL_DIR

log = logging.getLogger("clipdeck.listener")

RATE = 16000
CHUNK = 1600  # 100 ms of 16-bit mono
MODEL_NAME = "vosk-model-small-en-us-0.15"


def model_path() -> Path:
    return MODEL_DIR / MODEL_NAME


def phrases(text: str) -> list[str]:
    return [p.strip().lower() for p in text.split(",") if p.strip()]


class Listener:
    def __init__(self, config, on_voice, on_hype, on_level=None):
        self.config = config
        self.on_voice = on_voice
        self.on_hype = on_hype
        self.on_level = on_level
        self.proc: subprocess.Popen | None = None
        self.thread: threading.Thread | None = None
        self.state = "off"  # off | listening | error
        self.error = ""
        self.level_db = -90.0
        self.last_heard = ""
        self._stop = threading.Event()
        self._model = None

    def wanted(self) -> bool:
        return bool(self.config["voice"]["enabled"] or self.config["hype"]["enabled"])

    def start(self) -> None:
        self.stop()
        if not self.wanted():
            return
        self._stop.clear()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        if self.thread:
            self.thread.join(timeout=3)
        self.proc = None
        self.thread = None
        self.state = "off"

    def _recognizer(self):
        v = self.config["voice"]
        if not v["enabled"]:
            return None
        mp = model_path()
        if not mp.exists():
            raise RuntimeError(f"Voice model missing: {mp}. Run ./install.sh to download it.")
        import vosk

        vosk.SetLogLevel(-1)
        if self._model is None:
            self._model = vosk.Model(str(mp))
        words = phrases(v["phrase"]) or ["clip that"]
        rec = vosk.KaldiRecognizer(self._model, RATE, json.dumps(words + ["[unk]"]))
        rec.SetWords(True)
        return rec

    def _mic_cmd(self) -> list[str]:
        cmd = ["pw-record", "--rate", str(RATE), "--channels", "1", "--format", "s16", "--latency", "100ms"]
        dev = self.config["voice"]["mic_device"] or self.config["recorder"]["mic_device"]
        if dev and dev != "default_input":
            cmd += ["--target", dev]
        return cmd + ["-"]

    def _run(self) -> None:
        backoff = 1
        while not self._stop.is_set():
            try:
                self._listen()
                backoff = 1
            except Exception as e:  # keep trying; mics come and go
                log.warning("listener: %s", e)
                self.state = "error"
                self.error = str(e)
                if "model missing" in str(e):
                    return
            if self._stop.wait(backoff):
                return
            backoff = min(backoff * 2, 30)

    def _listen(self) -> None:
        rec = self._recognizer()
        self.proc = subprocess.Popen(self._mic_cmd(), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.state = "listening"
        self.error = ""
        loud_ms = 0
        last_hype = 0.0
        last_voice = 0.0
        stdout = self.proc.stdout
        assert stdout
        while not self._stop.is_set():
            data = stdout.read(CHUNK * 2)
            if not data:
                raise RuntimeError("mic stream ended")
            samples = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768
            rms = float(np.sqrt(np.mean(samples * samples)) + 1e-9)
            self.level_db = float(20 * np.log10(rms))
            if self.on_level:
                self.on_level(self.level_db)

            h = self.config["hype"]
            if h["enabled"]:
                if self.level_db >= float(h["threshold_db"]):
                    loud_ms += 100
                else:
                    loud_ms = max(0, loud_ms - 50)
                now = time.monotonic()
                if loud_ms >= int(h["min_ms"]) and now - last_hype >= float(h["cooldown_s"]):
                    last_hype = now
                    loud_ms = 0
                    self.on_hype()

            if rec is not None and rec.AcceptWaveform(data):
                said = self._match(json.loads(rec.Result()))
                now = time.monotonic()
                if said and now - last_voice > 3:
                    last_voice = now
                    self.last_heard = said
                    self.on_voice(said)

    def _match(self, result: dict) -> str | None:
        text = (result.get("text") or "").strip()
        if not text or text == "[unk]":
            return None
        need = float(self.config["voice"]["confidence"])
        words = result.get("result", [])
        for p in phrases(self.config["voice"]["phrase"]):
            if p in text:
                n = len(p.split())
                confs = [w["conf"] for w in words if w["word"] != "[unk]"][-n:] or [0]
                if min(confs) >= need:
                    return p
        return None

    def status(self) -> dict:
        return {
            "state": self.state,
            "error": self.error,
            "level_db": round(self.level_db, 1),
            "last_heard": self.last_heard,
            "model": model_path().exists(),
        }
