"""Clip editor: turns an edit project into one ffmpeg render.

A project is a list of segments (any clips, any order, each with its own
in/out points and speed) plus canvas, text, colour, audio and fade settings.
Renders run one at a time at the lowest CPU priority. The thread count is a
setting, so exports don't lag games unless you ask for speed.
"""

from __future__ import annotations

import logging
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from .config import CACHE_DIR

log = logging.getLogger("clipdeck.editor")

RENDERS = CACHE_DIR / "renders"

FONTS = {
    "bold": ("Noto Sans:bold", "Bold"),
    "clean": ("Noto Sans:regular", "Clean"),
    "impact": ("Fira Sans Compressed:heavy", "Impact"),
    "serif": ("Noto Serif:bold", "Serif"),
    "mono": ("DejaVu Sans Mono:bold", "Mono"),
}

# The text fonts have no emoji (colour emoji can't be drawn by ffmpeg), so they'd show as boxes.
EMOJI = re.compile("[\U0001F000-\U0001FAFF\u2600-\u27BF\uFE0F\u200D]")

ASPECTS = {"16:9": (16, 9), "9:16": (9, 16), "1:1": (1, 1), "4:5": (4, 5)}


def font_file(key: str) -> str:
    pattern = FONTS.get(key, FONTS["bold"])[0]
    out = subprocess.run(["fc-match", "-f", "%{file}", pattern], capture_output=True, text=True)
    return out.stdout.strip() or "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def _num(v, lo, hi, default):
    try:
        return max(lo, min(hi, float(v)))
    except (TypeError, ValueError):
        return default


def _color(v: str, default: str = "#ffffff") -> str:
    v = str(v or "")
    return v if re.fullmatch(r"#[0-9a-fA-F]{6}", v) else default


def normalize(p: dict, clip_lookup) -> dict:
    """Clamp everything to safe values; drop segments whose clip is gone."""
    segs = []
    for s in p.get("segments", []):
        c = clip_lookup(s.get("clip", ""))
        if not c:
            continue
        d = c["duration"]
        start = _num(s.get("start"), 0, d, 0)
        end = _num(s.get("end"), start + 0.1, d, d)
        segs.append({
            "id": str(s.get("id") or uuid.uuid4().hex[:8]),
            "clip": c["id"],
            "start": round(start, 3),
            "end": round(end, 3),
            "speed": _num(s.get("speed"), 0.25, 4, 1),
            "mute": bool(s.get("mute", False)),
        })
    texts = []
    for t in p.get("texts", [])[:30]:
        txt = str(t.get("text", ""))[:300]
        if not txt.strip():
            continue
        texts.append({
            "id": str(t.get("id") or uuid.uuid4().hex[:8]),
            "text": txt,
            "start": _num(t.get("start"), 0, 36000, 0),
            "end": _num(t.get("end"), 0, 36000, 3),
            "x": _num(t.get("x"), 0, 1, 0.5),
            "y": _num(t.get("y"), 0, 1, 0.85),
            "size": _num(t.get("size"), 0.02, 0.25, 0.07),
            "color": _color(t.get("color")),
            "style": t.get("style") if t.get("style") in ("none", "outline", "box", "shadow") else "outline",
            "font": t.get("font") if t.get("font") in FONTS else "bold",
            "anim": t.get("anim") if t.get("anim") in ("none", "fade", "pop") else "fade",
        })
    adj = p.get("adjust", {})
    aud = p.get("audio", {})
    out = p.get("output", {})
    return {
        "name": str(p.get("name") or "Edit")[:120],
        "segments": segs,
        "texts": texts,
        "aspect": p.get("aspect") if p.get("aspect") in ASPECTS else "16:9",
        "fit": p.get("fit") if p.get("fit") in ("fill", "blur", "bars") else "fill",
        "pan": _num(p.get("pan"), 0, 1, 0.5),
        "zoom": _num(p.get("zoom"), 1, 3, 1),
        "transition": p.get("transition") if p.get("transition") in ("cut", "fade") else "cut",
        "fade_in": _num(p.get("fade_in"), 0, 5, 0),
        "fade_out": _num(p.get("fade_out"), 0, 5, 0),
        "adjust": {
            "brightness": _num(adj.get("brightness"), -0.5, 0.5, 0),
            "contrast": _num(adj.get("contrast"), 0.5, 2, 1),
            "saturation": _num(adj.get("saturation"), 0, 3, 1),
            "vignette": bool(adj.get("vignette", False)),
            "sharpen": bool(adj.get("sharpen", False)),
        },
        "audio": {
            "game": _num(aud.get("game"), 0, 2, 1),
            "mic": _num(aud.get("mic"), 0, 2, 1),
            "fade_in": _num(aud.get("fade_in"), 0, 5, 0),
            "fade_out": _num(aud.get("fade_out"), 0, 5, 0),
        },
        "output": {
            "format": out.get("format") if out.get("format") in ("mp4", "gif") else "mp4",
            "height": int(out.get("height")) if out.get("height") in (480, 720, 1080, 1440) else 1080,
            "fps": int(out.get("fps")) if out.get("fps") in (24, 30, 60) else 60,
            "quality": out.get("quality") if out.get("quality") in ("high", "medium", "small") else "high",
            "fast": bool(out.get("fast", False)),
        },
    }


def seg_len(s: dict) -> float:
    return (s["end"] - s["start"]) / s["speed"]


def total_len(p: dict) -> float:
    return sum(seg_len(s) for s in p["segments"])


def canvas(p: dict) -> tuple[int, int]:
    aw, ah = ASPECTS[p["aspect"]]
    short = p["output"]["height"]
    if p["output"]["format"] == "gif":
        short = min(short, 480)
    if aw >= ah:
        h = short
        w = short * aw / ah
    else:
        w = short
        h = short * ah / aw
    return int(w) // 2 * 2, int(h) // 2 * 2


def _atempo(speed: float) -> list[str]:
    out = []
    while speed > 2.0:
        out.append("atempo=2.0")
        speed /= 2.0
    while speed < 0.5:
        out.append("atempo=0.5")
        speed /= 0.5
    out.append(f"atempo={speed:.4f}")
    return out


def build(p: dict, clip_lookup, out: Path, workdir: Path) -> list[str]:
    """ffmpeg arguments for the whole project."""
    W, H = canvas(p)
    fps = 15 if p["output"]["format"] == "gif" else p["output"]["fps"]
    a = p["adjust"]
    au = p["audio"]
    inputs: list[str] = []
    graph: list[str] = []
    n = len(p["segments"])
    tr = 0.25 if p["transition"] == "fade" else 0

    for i, s in enumerate(p["segments"]):
        c = clip_lookup(s["clip"])
        inputs += ["-ss", f"{s['start']:.3f}", "-to", f"{s['end']:.3f}", "-i", c["path"]]
        L = seg_len(s)
        v = f"[{i}:v:0]setpts=(PTS-STARTPTS)/{s['speed']:.4f},fps={fps}"
        z = p["zoom"]
        if p["fit"] == "fill":
            v += (f",scale={int(W * z)}:{int(H * z)}:force_original_aspect_ratio=increase,"
                  f"crop={W}:{H}:(iw-{W})*{p['pan']:.3f}:(ih-{H})/2")
            graph.append(v + f",setsar=1[v{i}r]")
        elif p["fit"] == "blur":
            graph.append(v + f",split[bg{i}][fg{i}]")
            graph.append(f"[bg{i}]scale={W // 4}:{H // 4}:force_original_aspect_ratio=increase,crop={W // 4}:{H // 4},"
                         f"boxblur=10:2,scale={W}:{H},eq=brightness=-0.06[bgb{i}]")
            graph.append(f"[fg{i}]scale={int(W * z)}:{int(H * z)}:force_original_aspect_ratio=decrease,"
                         f"crop=min(iw\\,{W}):min(ih\\,{H}):(iw-min(iw\\,{W}))*{p['pan']:.3f}:(ih-min(ih\\,{H}))/2[fgs{i}]")
            graph.append(f"[bgb{i}][fgs{i}]overlay=(W-w)/2:(H-h)/2,setsar=1[v{i}r]")
        else:  # bars
            graph.append(v + f",scale={W}:{H}:force_original_aspect_ratio=decrease,"
                         f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1[v{i}r]")
        fx = []
        if tr and i > 0:
            fx.append(f"fade=t=in:st=0:d={tr}")
        if tr and i < n - 1:
            fx.append(f"fade=t=out:st={max(L - tr, 0):.3f}:d={tr}")
        graph.append(f"[v{i}r]{','.join(fx) or 'null'},format=yuv420p[v{i}]")

        tracks = c["audio_tracks"]
        if s["mute"] or tracks == 0 or p["output"]["format"] == "gif":
            graph.append(f"anullsrc=r=48000:cl=stereo,atrim=duration={L:.3f}[a{i}]")
            continue
        if tracks >= 2:
            graph.append(f"[{i}:a:0]volume={au['game']:.2f}[g{i}];[{i}:a:1]volume={au['mic']:.2f}[m{i}];"
                         f"[g{i}][m{i}]amix=inputs=2:normalize=0:duration=first[am{i}]")
        else:
            graph.append(f"[{i}:a:0]volume={au['game']:.2f}[am{i}]")
        chain = ["asetpts=PTS-STARTPTS", *_atempo(s["speed"]), "aresample=48000",
                 "aformat=sample_fmts=fltp:channel_layouts=stereo", f"apad=whole_dur={L:.3f}", f"atrim=duration={L:.3f}"]
        if tr and i > 0:
            chain.append(f"afade=t=in:st=0:d={tr}")
        if tr and i < n - 1:
            chain.append(f"afade=t=out:st={max(L - tr, 0):.3f}:d={tr}")
        graph.append(f"[am{i}]{','.join(chain)}[a{i}]")

    pairs = "".join(f"[v{i}][a{i}]" for i in range(n))
    graph.append(f"{pairs}concat=n={n}:v=1:a=1[cv][ca]")

    # colour, text, fades over the whole timeline
    total = total_len(p)
    post = []
    if a["brightness"] or a["contrast"] != 1 or a["saturation"] != 1:
        post.append(f"eq=brightness={a['brightness']:.3f}:contrast={a['contrast']:.3f}:saturation={a['saturation']:.3f}")
    if a["sharpen"]:
        post.append("unsharp=5:5:0.8")
    if a["vignette"]:
        post.append("vignette=PI/5")
    for k, t in enumerate(p["texts"]):
        tf = workdir / f"text{k}.txt"
        tf.write_text(EMOJI.sub("", t["text"]).strip() or " ")
        fs = max(8, int(H * t["size"]))
        s0, s1 = t["start"], max(t["end"], t["start"] + 0.1)
        d = [f"fontfile='{font_file(t['font'])}'", f"textfile='{tf}'", f"fontsize={fs}",
             f"fontcolor={t['color']}", f"x=(w-text_w)*{t['x']:.4f}", f"y=(h-text_h)*{t['y']:.4f}",
             f"enable='between(t,{s0:.3f},{s1:.3f})'", "line_spacing=4",
             "text_align=" + ("L" if t["x"] < 0.34 else "R" if t["x"] > 0.66 else "C")]
        if t["style"] == "outline":
            d += [f"borderw={max(2, fs // 14)}", "bordercolor=black@0.9"]
        elif t["style"] == "box":
            d += ["box=1", "boxcolor=black@0.6", f"boxborderw={max(6, fs // 3)}"]
        elif t["style"] == "shadow":
            d += [f"shadowx={max(2, fs // 18)}", f"shadowy={max(2, fs // 18)}", "shadowcolor=black@0.7"]
        if t["anim"] in ("fade", "pop"):
            d.append(f"alpha='if(lt(t,{s0:.3f}+0.2),(t-{s0:.3f})/0.2,if(gt(t,{s1:.3f}-0.2),({s1:.3f}-t)/0.2,1))'")
        if t["anim"] == "pop":
            # drawtext can't scale, so "pop" slides up a little while fading in
            d[5] = f"y='(h-text_h)*{t['y']:.4f}+if(lt(t,{s0:.3f}+0.25),(1-(t-{s0:.3f})/0.25)*{fs * 0.4:.0f},0)'"
        post.append("drawtext=" + ":".join(d))
    if p["fade_in"]:
        post.append(f"fade=t=in:st=0:d={p['fade_in']:.2f}")
    if p["fade_out"]:
        post.append(f"fade=t=out:st={max(total - p['fade_out'], 0):.3f}:d={p['fade_out']:.2f}")

    apost = []
    if au["fade_in"]:
        apost.append(f"afade=t=in:st=0:d={au['fade_in']:.2f}")
    if au["fade_out"]:
        apost.append(f"afade=t=out:st={max(total - au['fade_out'], 0):.3f}:d={au['fade_out']:.2f}")

    threads = "6" if p["output"]["fast"] else "2"
    if p["output"]["format"] == "gif":
        graph.append("[ca]anullsink")
        graph.append(f"[cv]{','.join(post) or 'null'},split[g1][g2];[g1]palettegen=stats_mode=diff[pal];"
                     "[g2][pal]paletteuse=dither=bayer:bayer_scale=4[vout]")
        return [*inputs, "-filter_complex", ";".join(graph), "-map", "[vout]", "-loop", "0",
                "-threads", threads, str(out)]

    graph.append(f"[cv]{','.join(post) or 'null'}[vout]")
    graph.append(f"[ca]{','.join(apost) or 'anull'}[aout]")
    crf = {"high": "18", "medium": "22", "small": "27"}[p["output"]["quality"]]
    return [*inputs, "-filter_complex", ";".join(graph), "-map", "[vout]", "-map", "[aout]",
            "-c:v", "libx264", "-preset", "veryfast" if p["output"]["fast"] else "faster", "-crf", crf,
            "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart",
            "-threads", threads, "-filter_complex_threads", threads, str(out)]


@dataclass
class Job:
    id: str
    project_id: str
    name: str
    total: float
    state: str = "queued"  # queued | running | done | error | canceled
    progress: float = 0.0
    error: str = ""
    clip_id: str | None = None
    file: str | None = None
    format: str = "mp4"
    created: float = field(default_factory=time.time)
    proc: subprocess.Popen | None = None

    def public(self) -> dict:
        return {k: v for k, v in self.__dict__.items() if k != "proc"}


class Renderer:
    def __init__(self, db, library, events, clip_lookup):
        self.db = db
        self.library = library
        self.events = events
        self.lookup = clip_lookup
        self.jobs: dict[str, Job] = {}
        self._queue: list[Job] = []
        self._cv = threading.Condition()
        threading.Thread(target=self._worker, daemon=True).start()

    def submit(self, project_id: str, project: dict) -> Job:
        p = normalize(project, self.lookup)
        if not p["segments"]:
            raise ValueError("Add at least one clip to the timeline")
        job = Job(id=uuid.uuid4().hex[:10], project_id=project_id, name=p["name"],
                  total=total_len(p), format=p["output"]["format"])
        job._project = p  # type: ignore[attr-defined]
        with self._cv:
            self.jobs[job.id] = job
            self._queue.append(job)
            self._cv.notify()
        self._emit(job)
        return job

    def cancel(self, job_id: str) -> None:
        job = self.jobs.get(job_id)
        if not job:
            return
        with self._cv:
            if job in self._queue:
                self._queue.remove(job)
        job.state = "canceled"
        if job.proc and job.proc.poll() is None:
            job.proc.terminate()
        self._emit(job)

    def _emit(self, job: Job) -> None:
        self.events.emit("render", job=job.public())

    def _worker(self) -> None:
        while True:
            with self._cv:
                while not self._queue:
                    self._cv.wait()
                job = self._queue.pop(0)
            if job.state == "canceled":
                continue
            try:
                self._run(job)
            except Exception as e:
                log.exception("render failed")
                job.state = "error"
                job.error = str(e)[-400:]
                self._emit(job)

    def _run(self, job: Job) -> None:
        p = job._project  # type: ignore[attr-defined]
        RENDERS.mkdir(parents=True, exist_ok=True)
        work = Path(tempfile.mkdtemp(prefix="render-", dir=RENDERS))
        ext = "gif" if p["output"]["format"] == "gif" else "mp4"
        out = work / f"out.{ext}"
        args = build(p, self.lookup, out, work)
        cmd = ["nice", "-n", "19", "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
               "-progress", "pipe:1", "-nostats", *args]
        log.info("render %s: %s", job.id, " ".join(cmd)[:2000])
        job.state = "running"
        self._emit(job)
        job.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        last = 0.0
        assert job.proc.stdout
        for line in job.proc.stdout:
            if line.startswith("out_time_us=") or line.startswith("out_time_ms="):
                try:
                    us = int(line.split("=")[1])
                except ValueError:
                    continue
                job.progress = max(0.0, min(0.99, us / 1e6 / max(job.total, 0.1)))
                if time.monotonic() - last > 0.4:
                    last = time.monotonic()
                    self._emit(job)
        code = job.proc.wait()
        err = job.proc.stderr.read() if job.proc.stderr else ""
        if job.state == "canceled":
            shutil.rmtree(work, ignore_errors=True)
            return
        if code != 0 or not out.exists():
            job.state = "error"
            job.error = (err.strip() or f"ffmpeg exited with {code}")[-600:]
            shutil.rmtree(work, ignore_errors=True)
            self._emit(job)
            return
        if ext == "gif":
            final = RENDERS / f"{job.id}.gif"
            shutil.move(out, final)
            job.file = str(final)
        else:
            first = self.lookup(p["segments"][0]["clip"])
            clip = self.library.ingest(out, game=first["game"], steam_appid=first["steam_appid"],
                                       source="edit", title=p["name"])
            job.clip_id = clip["id"]
        shutil.rmtree(work, ignore_errors=True)
        job.state = "done"
        job.progress = 1.0
        self._emit(job)
