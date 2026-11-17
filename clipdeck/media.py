"""ffmpeg helpers. Everything runs at the lowest CPU priority with 2 threads,
so clip processing never competes with a game."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

LOW = ["nice", "-n", "19"]
THREADS = ["-threads", "2"]


def probe(path: Path) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
        capture_output=True, text=True, timeout=60,
    )
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip() or "ffprobe failed")
    data = json.loads(out.stdout)
    video = next((s for s in data["streams"] if s["codec_type"] == "video"), {})
    audio = [s for s in data["streams"] if s["codec_type"] == "audio"]
    fps = 0.0
    if "/" in video.get("avg_frame_rate", ""):
        n, d = video["avg_frame_rate"].split("/")
        fps = float(n) / float(d) if float(d) else 0.0
    return {
        "duration": float(data["format"].get("duration", 0) or 0),
        "size": int(data["format"].get("size", 0) or 0),
        "width": int(video.get("width", 0)),
        "height": int(video.get("height", 0)),
        "fps": round(fps, 2),
        "audio_tracks": len(audio),
    }


def _run(args: list[str], timeout: int = 600) -> None:
    out = subprocess.run(LOW + ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"] + args,
                         capture_output=True, text=True, timeout=timeout)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip()[-500:] or "ffmpeg failed")


def thumbnail(src: Path, dst: Path, at: float) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    _run(["-ss", f"{max(at, 0):.2f}", "-i", str(src), "-frames:v", "1",
          "-vf", "scale=640:-2", "-q:v", "4", *THREADS, str(dst)])


def preview(src: Path, dst: Path, start: float, length: float = 4.0) -> None:
    """Short silent low-res loop shown when hovering a clip card."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    _run(["-ss", f"{max(start, 0):.2f}", "-t", f"{length:.2f}", "-i", str(src), "-an",
          "-vf", "scale=400:-2,fps=24", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30",
          "-movflags", "+faststart", *THREADS, str(dst)])


def cut(src: Path, dst: Path, start: float, end: float, exact: bool = False) -> None:
    """Copy [start, end) into a new file.

    Without `exact`, streams are copied (instant, starts on the nearest
    keyframe, which is at most 2 s away). With `exact`, it re-encodes so the
    cut lands on the exact frame.
    """
    dst.parent.mkdir(parents=True, exist_ok=True)
    common = ["-ss", f"{max(start, 0):.3f}", "-to", f"{end:.3f}", "-i", str(src), "-map", "0"]
    if exact:
        _run(common + ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-c:a", "copy",
                       "-movflags", "+faststart", *THREADS, str(dst)], timeout=3600)
    else:
        _run(common[:4] + ["-i", str(src), "-map", "0", "-c", "copy", "-avoid_negative_ts", "make_zero",
                           "-movflags", "+faststart", str(dst)])


def last_seconds(src: Path, dst: Path, seconds: float) -> None:
    """Keep only the last `seconds` of a clip (stream copy)."""
    _run(["-sseof", f"-{seconds:.2f}", "-i", str(src), "-map", "0", "-c", "copy",
          "-avoid_negative_ts", "make_zero", "-movflags", "+faststart", str(dst)])


def audio_track(src: Path, dst: Path, index: int) -> None:
    """Pull one audio track out as .m4a (no re-encode), so the player can mix game and mic."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    _run(["-i", str(src), "-map", f"0:a:{index}", "-c", "copy", "-vn", "-movflags", "+faststart", str(dst)])


def strip(src: Path, dst: Path, duration: float, frames: int = 10) -> None:
    """One wide image of `frames` evenly spaced frames, for the trim timeline."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    step = max(duration / frames, 0.1)
    _run(["-i", str(src), "-vf", f"fps=1/{step:.3f},scale=192:-2,tile={frames}x1", "-frames:v", "1",
          "-q:v", "5", *THREADS, str(dst)])


def faststart(src: Path, dst: Path) -> None:
    """Move the index to the front so phones can start playing before it fully loads."""
    _run(["-i", str(src), "-map", "0", "-c", "copy", "-movflags", "+faststart", str(dst)])


def mixdown(src: Path, dst: Path, start: float, end: float, mic_volume: float, game_volume: float,
            max_mb: float | None = None, duration: float | None = None) -> None:
    """One-audio-track copy for sharing (most apps only play the first track).

    If max_mb is given, the video bitrate is picked so the file fits.
    """
    info = probe(src)
    tracks = info["audio_tracks"]
    length = max(end - start, 0.5)
    args = ["-ss", f"{start:.3f}", "-to", f"{end:.3f}", "-i", str(src)]
    if tracks >= 2:
        fc = (f"[0:a:0]volume={game_volume}[g];[0:a:1]volume={mic_volume}[m];"
              "[g][m]amix=inputs=2:normalize=0[a]")
        args += ["-filter_complex", fc, "-map", "0:v:0", "-map", "[a]"]
    elif tracks == 1:
        args += ["-map", "0:v:0", "-map", "0:a:0", "-af", f"volume={game_volume}"]
    else:
        args += ["-map", "0:v:0"]
    if max_mb:
        total_kbit = max_mb * 8 * 1024 * 0.92
        v_kbps = max(int(total_kbit / length) - 128, 300)
        vf = "scale=-2:720" if v_kbps < 2500 else "scale=-2:1080"
        args += ["-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-b:v", f"{v_kbps}k",
                 "-maxrate", f"{v_kbps}k", "-bufsize", f"{v_kbps * 2}k"]
    else:
        args += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]
    args += ["-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", *THREADS, str(dst)]
    _run(args, timeout=3600)
