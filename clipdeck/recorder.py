"""Runs GPU Screen Recorder in replay mode and saves clips from its buffer.

Encoding: GPU by default (falls back to CPU x264 if the card can't encode), or CPU when
the "encoder" setting says so. Polaris cards (RX 470/480/570/580/590) are always CPU:
the RX 570's encoder (VCE) hung and reset the GPU on 2026-11-16 and took the whole
desktop down, so on a PC with one of those no setting can turn GPU encoding on.
"""

from __future__ import annotations

import collections
import logging
import os
import signal
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

log = logging.getLogger("clipdeck.recorder")

FLATPAK_ID = "com.dec05eba.gpu_screen_recorder"
GSR = ["flatpak", "run", f"--command=gpu-screen-recorder", FLATPAK_ID]
GSR_COMM = "gpu-screen-reco"  # /proc comm is cut to 15 characters
# AMD Polaris (RX 470/480/570/580/590 and their Pro versions), by PCI device id.
BLOCKED_GPUS = {("0x1002", d) for d in ("0x67df", "0x67ef", "0x67ff", "0x6fdf", "0x67c0", "0x67c4",
                                        "0x67c7", "0x67e0", "0x67e3", "0x67e8", "0x67eb", "0x699f")}


def blocked_gpu() -> str | None:
    """The PCI id of a GPU whose encoder must never be used, if this PC has one."""
    for dev in Path("/sys/class/drm").glob("card[0-9]*/device"):
        try:
            ids = ((dev / "vendor").read_text().strip(), (dev / "device").read_text().strip())
        except OSError:
            continue
        if ids in BLOCKED_GPUS:
            return ":".join(i[2:] for i in ids)
    return None


def pick_monitor(wanted: str) -> str:
    """The monitor to capture: the saved one if it's connected, otherwise the first one.

    An empty setting (new installs) means "the first monitor"."""
    try:
        out = subprocess.run(GSR + ["--list-capture-options"], capture_output=True, text=True, timeout=20).stdout
    except (OSError, subprocess.TimeoutExpired):
        return wanted or "screen"
    names = [line.split("|", 1)[0].strip() for line in out.splitlines() if "|" in line]
    if wanted and wanted in names:
        return wanted
    if names:
        if wanted:
            log.warning("monitor %s isn't connected; using %s", wanted, names[0])
        return names[0]
    return wanted or "screen"


def encoder_for(setting: str) -> tuple[str, str]:
    """(encoder, why) for the recorder: "gpu" or "cpu"."""
    bad = blocked_gpu()
    if bad:
        return "cpu", f"This graphics card ({bad}, AMD Polaris) froze a PC while encoding, so Clipdeck always uses the CPU on it."
    if setting == "cpu":
        return "cpu", "Set to CPU in Settings."
    return "gpu", "Graphics card, with CPU as a fallback if the card can't encode."


QUALITIES = {"low": "medium", "medium": "high", "high": "very_high", "very_high": "ultra"}


@dataclass
class SaveRequest:
    source: str = "hotkey"  # hotkey | voice | hype | phone | web
    seconds: float | None = None  # trim to the last N seconds; None = whole buffer
    game: str = "Desktop"
    steam_appid: str | None = None
    at: float = field(default_factory=time.time)


def list_options() -> dict:
    """Monitors and audio devices GPU Screen Recorder can use."""

    def run(flag: str) -> list[tuple[str, str]]:
        try:
            out = subprocess.run(GSR + [flag], capture_output=True, text=True, timeout=20).stdout
        except (OSError, subprocess.TimeoutExpired):
            return []
        rows = []
        for line in out.splitlines():
            if "|" in line:
                a, b = line.split("|", 1)
                rows.append((a.strip(), b.strip()))
        return rows

    monitors = [{"id": a, "label": f"{a} ({b})"} for a, b in run("--list-capture-options") if a not in ("region", "portal", "focused")]
    audio = [{"id": a, "label": b} for a, b in run("--list-audio-devices")]
    return {
        "monitors": monitors,
        "outputs": [d for d in audio if d["id"] == "default_output" or d["id"].endswith(".monitor")],
        "inputs": [d for d in audio if d["id"] == "default_input" or (d["id"].startswith(("alsa_input", "bluez_input")) )],
    }


def _children(pid: int) -> list[int]:
    kids: dict[int, list[int]] = collections.defaultdict(list)
    for p in os.listdir("/proc"):
        if not p.isdigit():
            continue
        try:
            stat = Path(f"/proc/{p}/stat").read_text()
            ppid = int(stat.rsplit(")", 1)[1].split()[1])
        except (OSError, ValueError, IndexError):
            continue
        kids[ppid].append(int(p))
    out, todo = [], [pid]
    while todo:
        for c in kids.get(todo.pop(), []):
            out.append(c)
            todo.append(c)
    return out


def _comm(pid: int) -> str:
    try:
        return Path(f"/proc/{pid}/comm").read_text().strip()
    except OSError:
        return ""


class Recorder:
    def __init__(self, config, on_saved):
        self.config = config
        self.on_saved = on_saved  # fn(path: Path, request: SaveRequest)
        self.proc: subprocess.Popen | None = None
        self.state = "stopped"  # stopped | starting | recording | paused | error
        self.error = ""
        self.started_at = 0.0
        self.log_tail: collections.deque[str] = collections.deque(maxlen=60)
        self._pending: collections.deque[SaveRequest] = collections.deque()
        # Full-session recording (a normal video made alongside the replay buffer).
        self.session: SaveRequest | None = None
        self.session_started = 0.0
        self._lock = threading.RLock()
        self._want = False
        self._fails = 0
        self._watch = threading.Thread(target=self._watchdog, daemon=True)
        self._watch.start()

    # paths ---------------------------------------------------------------

    @property
    def incoming(self) -> Path:
        p = self.config.clips_dir / ".incoming"
        p.mkdir(parents=True, exist_ok=True)
        return p

    def command(self) -> list[str]:
        r = self.config["recorder"]
        enc, _ = encoder_for(r.get("encoder", "gpu"))
        cmd = GSR + [
            "-w", pick_monitor(r["monitor"]),
            "-encoder", enc, "-k", "h264",
            "-f", str(int(r["fps"])), "-fm", "cfr",
            "-q", QUALITIES.get(r["quality"], "very_high"),
            "-r", str(int(r["replay_seconds"])),
            "-replay-storage", r["replay_storage"],
            "-c", "mp4", "-ac", "aac",
            "-cursor", "yes" if r["show_cursor"] else "no",
            "-o", str(self.incoming),
            "-ro", str(self.incoming / "sessions"),
        ]
        if enc == "gpu":
            cmd += ["-fallback-cpu-encoding", "yes"]
        if r["resolution"] and r["resolution"] != "native":
            cmd += ["-s", r["resolution"]]
        # Separate tracks so the mic can be muted or turned down later.
        if r["record_game_audio"]:
            cmd += ["-a", r["game_audio_device"]]
        if r["record_mic"]:
            cmd += ["-a", r["mic_device"]]
        return ["nice", "-n", str(int(r["nice"]))] + cmd

    # control ---------------------------------------------------------------

    def start(self) -> None:
        with self._lock:
            self._want = True
            self._fails = 0
            self._spawn()

    def stop(self) -> None:
        with self._lock:
            self._want = False
            self._kill()
            self.state = "stopped"

    def restart(self) -> None:
        with self._lock:
            if self.state == "error":
                # After repeated crashes it gave up; a restart (or a settings change) means "try again".
                self._want = True
                self._fails = 0
            self._kill()
            if self._want:
                self._spawn()

    def _reap_orphans(self) -> None:
        """Stop recorders left behind by an earlier Clipdeck that was killed.

        The flatpak runs the recorder in its own scope, so it survives the
        service being killed. Two recorders double the CPU and RAM use.
        """
        mine = set(_children(self.proc.pid)) if self.proc and self.proc.poll() is None else set()
        target = str(self.incoming)
        found = []
        for pid in os.listdir("/proc"):
            if not pid.isdigit() or int(pid) in mine or _comm(int(pid)) != GSR_COMM:
                continue
            try:
                cmd = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
            except OSError:
                continue
            if target in cmd:
                found.append(int(pid))
        for pid in found:
            log.warning("stopping leftover recorder %s", pid)
            try:
                os.kill(pid, signal.SIGINT)
            except ProcessLookupError:
                pass
        for _ in range(30):
            if not any(Path(f"/proc/{p}").exists() for p in found):
                return
            time.sleep(0.1)
        for pid in found:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def _spawn(self) -> None:
        if self.proc and self.proc.poll() is None:
            return
        self._reap_orphans()
        self.session = None  # a restart ends any full recording
        cmd = self.command()
        log.info("starting: %s", " ".join(cmd))
        self.state = "starting"
        self.error = ""
        self.proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            bufsize=1, start_new_session=True,
        )
        self.started_at = time.time()
        threading.Thread(target=self._read, args=(self.proc,), daemon=True).start()

    def _gsr_pid(self) -> int | None:
        if not self.proc or self.proc.poll() is not None:
            return None
        for pid in _children(self.proc.pid):
            if _comm(pid) == GSR_COMM:
                return pid
        return None

    def _kill(self) -> None:
        p = self.proc
        if not p or p.poll() is not None:
            return
        pid = self._gsr_pid()
        try:
            if pid:
                os.kill(pid, signal.SIGINT)
            else:
                os.killpg(p.pid, signal.SIGINT)
            p.wait(timeout=8)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        self.proc = None

    def toggle_session(self, req: SaveRequest) -> bool | None:
        """Start or stop a full recording. Returns True if started, False if stopped, None if not possible."""
        with self._lock:
            pid = self._gsr_pid()
            if self.state != "recording" or not pid:
                return None
            os.kill(pid, signal.SIGRTMIN)
            if self.session is None:
                self.session = req
                self.session_started = time.time()
                return True
            return False

    def save(self, req: SaveRequest) -> bool:
        """Ask GPU Screen Recorder to write out the buffer. False if not recording."""
        with self._lock:
            pid = self._gsr_pid()
            if self.state != "recording" or not pid:
                return False
            self._pending.append(req)
            os.kill(pid, signal.SIGUSR1)
            return True

    # background ------------------------------------------------------------

    def _read(self, proc: subprocess.Popen) -> None:
        assert proc.stdout
        for line in proc.stdout:
            line = line.rstrip()
            if not line:
                continue
            self.log_tail.append(line)
            if self.state == "starting" and ("update fps" in line or "libx264" in line):
                self.state = "recording"
                self._fails = 0
            if line.endswith(".mp4") and line.startswith("/"):
                path = Path(line)
                if path.name.startswith("Video_") or "/sessions/" in line:
                    # A finished full recording, not a replay save.
                    req = self.session or SaveRequest(source="record")
                    req.source = "record"
                    req.seconds = None
                    self.session = None
                else:
                    req = self._pending.popleft() if self._pending else SaveRequest()
                threading.Thread(target=self._deliver, args=(path, req), daemon=True).start()

    def _deliver(self, path: Path, req: SaveRequest) -> None:
        for _ in range(50):  # the file may still be finishing
            if path.exists() and path.stat().st_size > 0:
                break
            time.sleep(0.1)
        try:
            self.on_saved(path, req)
        except Exception:  # keep recording even if processing a clip fails
            log.exception("processing %s failed", path)

    def _watchdog(self) -> None:
        while True:
            time.sleep(2)
            with self._lock:
                p = self.proc
                if not self._want or not p or p.poll() is None:
                    continue
                code = p.returncode
                self.proc = None
                self._fails += 1
                tail = " / ".join(list(self.log_tail)[-3:])
                log.warning("recorder exited (%s): %s", code, tail)
                if self._fails >= 4:
                    self.state = "error"
                    self.error = f"GPU Screen Recorder keeps stopping (exit {code}). {tail}"
                    self._want = False
                    continue
                self.state = "starting"
            time.sleep(min(30, 2 ** self._fails))
            with self._lock:
                if self._want:
                    self._spawn()

    def status(self) -> dict:
        return {
            "state": self.state,
            "error": self.error,
            "since": self.started_at if self.state == "recording" else None,
            "session_since": self.session_started if self.session else None,
            "buffer_seconds": self.config["recorder"]["replay_seconds"],
            "encoder": dict(zip(("used", "why"), encoder_for(self.config["recorder"].get("encoder", "gpu")))),
            "encoder_locked": blocked_gpu() is not None,
            "log": list(self.log_tail)[-12:],
        }
