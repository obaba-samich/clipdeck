"""Web API, media streaming and the clip library site (PC + phone)."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import html
import ipaddress
import json
import logging
import mimetypes
import os
import queue
import secrets
import shutil
import socket
import subprocess
import time
import urllib.request
import uuid
from collections import defaultdict
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import Body, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response, StreamingResponse

from . import editor, hotkeys, media
from .config import CACHE_DIR
from .feedback import saved_sound
from .core import Core
from .games import steam_cover, steam_hero
from .recorder import list_options

log = logging.getLogger("clipdeck.server")

STATIC = Path(__file__).parent / "static"
EXPORTS = CACHE_DIR / "exports"
COOKIE = "clipdeck_session"
PUBLIC_PREFIXES = ("/s/", "/assets/", "/icons/", "/manifest.webmanifest", "/sw.js", "/favicon")
LOCAL = {"127.0.0.1", "::1", "localhost"}


def lan_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"


def allowed_host(host: str) -> bool:
    """IP addresses, localhost, this PC's name, .local and Tailscale (.ts.net) names."""
    name = urlsplit(f"//{host}").hostname or ""
    if not name:
        return False
    try:
        ipaddress.ip_address(name)
        return True
    except ValueError:
        pass
    me = socket.gethostname().lower()
    return name in ("localhost", me, f"{me}.local") or name.endswith((".local", ".ts.net", ".localhost"))


def create_app(core: Core | None = None) -> FastAPI:
    core = core or Core()
    cfg = core.config
    db = core.db
    lib = core.library
    failed_logins: dict[str, list[float]] = defaultdict(list)
    options_cache: dict = {}

    @asynccontextmanager
    async def lifespan(_app):
        core.start()
        yield
        core.stop()

    app = FastAPI(title="Clipdeck", lifespan=lifespan, docs_url=None, redoc_url=None)

    # auth ------------------------------------------------------------------

    def token() -> str:
        # Tied to the passcode, so "New passcode" really signs every phone out.
        msg = f"session-v2:{cfg['server']['passcode']}".encode()
        return hmac.new(cfg["server"]["secret"].encode(), msg, hashlib.sha256).hexdigest()

    def is_local(req: Request) -> bool:
        return bool(req.client and req.client.host in LOCAL)

    def authed(req: Request) -> bool:
        if is_local(req):
            return True
        got = req.cookies.get(COOKIE, "")
        return bool(got) and hmac.compare_digest(got, token())

    @app.middleware("http")
    async def guard(req: Request, call_next):
        # 1. Only answer to addresses Clipdeck is really reached by. A website can point its own
        #    domain at 127.0.0.1 (DNS rebinding) to read a local app; its Host header gives it away.
        if not allowed_host(req.headers.get("host", "")):
            return JSONResponse({"error": "unknown host"}, status_code=421)
        # 2. "Allow other devices" off: refuse everything not from this PC, right away.
        if not cfg["server"]["lan"] and not is_local(req):
            return JSONResponse({"error": "Clipdeck only accepts this PC right now"}, status_code=403)
        # 3. Changes must come from Clipdeck's own pages, not from another website in your browser.
        if req.method not in ("GET", "HEAD", "OPTIONS"):
            origin = req.headers.get("origin")
            site = req.headers.get("sec-fetch-site", "")
            if (origin and urlsplit(origin).netloc != req.headers.get("host", "")) or site == "cross-site":
                return JSONResponse({"error": "cross-site request blocked"}, status_code=403)
        p = req.url.path
        open_path = p in ("/", "/login", "/api/login", "/api/me") or p.startswith(PUBLIC_PREFIXES) \
            or not (p.startswith("/api/") or p.startswith("/media/"))
        if not open_path and not authed(req):
            return JSONResponse({"error": "login"}, status_code=401)
        resp = await call_next(req)
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("Referrer-Policy", "same-origin")
        return resp

    @app.get("/api/me")
    def me(req: Request):
        return {"authed": authed(req), "local": is_local(req)}

    @app.post("/api/login")
    def login(req: Request, body: dict = Body(...)):
        ip = req.client.host if req.client else "?"
        now = time.time()
        failed_logins[ip] = [t for t in failed_logins[ip] if now - t < 300]
        if len(failed_logins[ip]) >= 8:
            raise HTTPException(429, "Too many tries. Wait a few minutes.")
        if not hmac.compare_digest(str(body.get("passcode", "")).strip(), cfg["server"]["passcode"]):
            failed_logins[ip].append(now)
            raise HTTPException(401, "Wrong passcode")
        resp = JSONResponse({"ok": True})
        resp.set_cookie(COOKIE, token(), max_age=60 * 60 * 24 * 400, httponly=True, samesite="lax")
        return resp

    @app.post("/api/logout")
    def logout():
        resp = JSONResponse({"ok": True})
        resp.delete_cookie(COOKIE)
        return resp

    # status / control ------------------------------------------------------

    @app.get("/api/status")
    def status():
        s = core.status()
        s["lan_url"] = f"http://{lan_ip()}:{cfg['server']['port']}"
        s["clips_dir"] = str(cfg.clips_dir)
        try:
            du = shutil.disk_usage(cfg.clips_dir)
            s["disk"] = {"free": du.free, "total": du.total}
        except OSError:
            s["disk"] = None
        return s

    @app.post("/api/clip")
    def clip_now(body: dict = Body(default={})):
        source = body.get("source", "web")
        if source not in ("web", "phone", "hotkey", "hotkey_long", "cli"):
            source = "web"
        seconds = body.get("seconds")
        if source == "hotkey_long":
            source, seconds = "hotkey", 10**9
        return core.clip(source=source, seconds=float(seconds) if seconds else None)

    @app.post("/api/record")
    def record(body: dict = Body(default={})):
        return core.toggle_recording(source=str(body.get("source", "web")))

    @app.post("/api/recorder/{action}")
    def recorder(action: str):
        if action == "start":
            core.recorder.start()
        elif action == "stop":
            core.recorder.stop()
        elif action == "restart":
            core.recorder.restart()
        else:
            raise HTTPException(404)
        return core.recorder.status()

    @app.get("/api/events")
    async def events(req: Request):
        q = core.events.subscribe()

        async def stream():
            try:
                yield "retry: 3000\n\n"
                while not await req.is_disconnected():
                    try:
                        ev = await asyncio.to_thread(q.get, True, 15)
                        yield f"data: {json.dumps(ev)}\n\n"
                    except queue.Empty:
                        yield ": ping\n\n"
            finally:
                core.events.unsubscribe(q)

        return StreamingResponse(stream(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    # settings ----------------------------------------------------------------

    @app.get("/api/settings")
    def get_settings():
        return cfg.public()

    @app.put("/api/settings")
    def put_settings(body: dict = Body(...)):
        r = body.get("recorder", {})
        # Never let the UI switch to GPU encoding; it crashes this PC.
        r.pop("encoder", None)
        if "replay_seconds" in r:
            r["replay_seconds"] = int(min(max(int(r["replay_seconds"]), 10), 600))
        if "fps" in r:
            r["fps"] = int(min(max(int(r["fps"]), 15), 144))
        return cfg.update(body)

    @app.post("/api/settings/passcode")
    def new_passcode():
        return cfg.update({"server": {"passcode": f"{secrets.randbelow(10**6):06d}"}})

    @app.get("/api/level")
    def level():
        return {"level_db": round(core.listener.level_db, 1), "state": core.listener.state}

    @app.get("/api/voice/check")
    def voice_check(phrase: str):
        return {"unknown": core.listener.unknown_words(phrase)}

    @app.post("/api/test-sound")
    def test_sound():
        core.feedback._play(saved_sound())
        return {"ok": True}

    @app.post("/api/hotkeys/apply")
    def hotkeys_apply():
        try:
            return {"ok": True, "set": hotkeys.apply(cfg["hotkeys"])}
        except OSError as e:
            raise HTTPException(500, f"Couldn't write COSMIC shortcuts: {e}")

    # folders -----------------------------------------------------------------

    @app.get("/api/fs")
    def browse(path: str = ""):
        p = Path(path).expanduser() if path else cfg.clips_dir
        while not p.is_dir() and p != p.parent:
            p = p.parent
        try:
            dirs = sorted((d for d in p.iterdir() if d.is_dir() and not d.name.startswith(".")), key=lambda d: d.name.lower())
        except PermissionError:
            dirs = []
        home = Path.home()
        places = [{"name": "Home", "path": str(home)}]
        for name in ("Videos", "Desktop", "Documents", "Downloads"):
            if (home / name).is_dir():
                places.append({"name": name, "path": str(home / name)})
        for mount in ("/media", "/mnt", f"/media/{home.name}", f"/run/media/{home.name}"):
            mp = Path(mount)
            if mp.is_dir():
                for d in mp.iterdir():
                    if d.is_dir() and os.path.ismount(d):
                        places.append({"name": d.name, "path": str(d)})
        free = shutil.disk_usage(p).free if p.exists() else 0
        return {
            "path": str(p),
            "parent": str(p.parent) if p != p.parent else None,
            "dirs": [{"name": d.name, "path": str(d)} for d in dirs[:500]],
            "writable": os.access(p, os.W_OK),
            "free": free,
            "places": places,
        }

    @app.post("/api/fs/mkdir")
    def mkdir(body: dict = Body(...)):
        parent = Path(str(body.get("path", ""))).expanduser()
        name = str(body.get("name", "")).strip().replace("/", "")
        if not name or not parent.is_dir():
            raise HTTPException(400, "Pick a folder and a name")
        d = parent / name
        d.mkdir(exist_ok=True)
        return {"path": str(d)}

    @app.post("/api/clips-dir")
    async def set_clips_dir(body: dict = Body(...)):
        new = Path(str(body.get("path", ""))).expanduser()
        if not new.is_absolute():
            raise HTTPException(400, "Pick a folder")
        new.mkdir(parents=True, exist_ok=True)
        if not os.access(new, os.W_OK):
            raise HTTPException(400, "Clipdeck can't write to that folder")
        old = cfg.clips_dir
        # Picking a busy folder (Home, Videos, a drive) puts clips in a "Clipdeck" folder inside it,
        # so Clipdeck never mixes with or imports your other files.
        if new.resolve() != old.resolve() and new.name.lower() != "clipdeck" \
                and any(not c.name.startswith(".") for c in new.iterdir()):
            new = new / "Clipdeck"
            new.mkdir(exist_ok=True)
        if new.resolve() == old.resolve():
            return {"ok": True, "moved": 0, "path": str(new)}
        moved = 0
        if body.get("move"):
            moved = await asyncio.to_thread(lib.move_root, old, new)
        cfg.update({"clips_dir": str(new)})
        return {"ok": True, "moved": moved, "path": str(new)}

    def _reveal(path: Path) -> None:
        # Opens the file manager with the file selected; falls back to opening the folder.
        uri = path.as_uri()
        r = subprocess.run(["gdbus", "call", "--session", "--dest", "org.freedesktop.FileManager1",
                            "--object-path", "/org/freedesktop/FileManager1",
                            "--method", "org.freedesktop.FileManager1.ShowItems", f"['{uri}']", ""],
                           capture_output=True, timeout=5)
        if r.returncode != 0:
            subprocess.Popen(["xdg-open", str(path.parent if path.is_file() else path)],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    @app.post("/api/reveal")
    def reveal(req: Request, body: dict = Body(default={})):
        if not (req.client and req.client.host in LOCAL):
            raise HTTPException(400, "Only works on the PC itself")
        if body.get("clip"):
            p = Path(get(body["clip"])["path"])
        else:
            p = cfg.clips_dir
        _reveal(p)
        return {"ok": True}

    @app.get("/api/options")
    def options(refresh: bool = False):
        if refresh or not options_cache:
            options_cache.clear()
            options_cache.update(list_options())
        return options_cache

    # clips -------------------------------------------------------------------

    def get(clip_id: str) -> dict:
        c = db.get_clip(clip_id)
        if not c:
            raise HTTPException(404, "No such clip")
        return c

    def public_clip(c: dict) -> dict:
        c = dict(c)
        c["albums"] = db.clip_albums(c["id"])
        c["filename"] = Path(c["path"]).name
        return c

    @app.get("/api/clips")
    def clips(q: str = "", game: str = "", favorite: bool = False, album: str = "", source: str = "",
              trash: bool = False, sort: str = "newest", limit: int = 120, offset: int = 0):
        rows = db.list_clips(q=q, game=game, favorite=favorite, album=album, trash=trash, source=source,
                             sort=sort, limit=min(limit, 5000), offset=offset)
        return [public_clip(c) for c in rows]

    @app.get("/api/clips/{clip_id}")
    def clip(clip_id: str):
        return public_clip(get(clip_id))

    @app.patch("/api/clips/{clip_id}")
    def edit(clip_id: str, body: dict = Body(...)):
        c = get(clip_id)
        if "game" in body and body["game"] and body["game"] != c["game"]:
            lib.rename_game(clip_id, str(body.pop("game"))[:80])
        fields = {}
        if "title" in body:
            fields["title"] = str(body["title"]).strip()[:120] or c["title"]
        if "favorite" in body:
            fields["favorite"] = 1 if body["favorite"] else 0
        for k in ("trim_start", "trim_end"):
            if k in body:
                v = body[k]
                fields[k] = None if v is None else max(0.0, min(float(v), c["duration"]))
        new = db.update_clip(clip_id, **fields)
        if "trim_start" in fields or "trim_end" in fields:
            lib.refresh_art(clip_id)
        core.events.emit("updated", clip=public_clip(new))
        return public_clip(new)

    @app.post("/api/upload")
    async def upload(file: UploadFile = File(...), game: str = Form("Imported")):
        name = Path(file.filename or "video.mp4").name
        ext = Path(name).suffix.lower()
        if ext not in (".mp4", ".mov", ".mkv", ".webm", ".m4v"):
            raise HTTPException(400, "That isn't a video file Clipdeck can import")
        dst = core.recorder.incoming / f"upload-{secrets.token_hex(4)}{ext}"
        with dst.open("wb") as out:
            while chunk := await file.read(4 * 1024 * 1024):
                out.write(chunk)
        try:
            clip = await asyncio.to_thread(lib.ingest, dst, game=(game.strip() or "Imported")[:80],
                                           source="import", title=Path(name).stem[:120])
        except Exception as e:
            dst.unlink(missing_ok=True)
            raise HTTPException(400, f"Couldn't import {name}: {e}")
        return public_clip(clip)

    @app.post("/api/clips/{clip_id}/view")
    def viewed(clip_id: str):
        db.add_view(clip_id)
        return {"ok": True}

    @app.delete("/api/clips/{clip_id}")
    def remove(clip_id: str):
        lib.trash(get(clip_id)["id"])
        return {"ok": True}

    @app.post("/api/clips/bulk")
    def bulk(body: dict = Body(...)):
        ids = [i for i in body.get("ids", []) if db.get_clip(i)]
        action = body.get("action")
        for i in ids:
            if action == "trash":
                lib.trash(i)
            elif action == "restore":
                lib.restore(i)
            elif action == "purge":
                lib.purge(i)
            elif action == "favorite":
                db.update_clip(i, favorite=1)
            elif action == "unfavorite":
                db.update_clip(i, favorite=0)
        if action == "album" and body.get("album"):
            db.album_add(body["album"], ids)
        if action == "unalbum" and body.get("album"):
            db.album_remove(body["album"], ids)
        core.events.emit("bulk")
        return {"ok": True, "count": len(ids)}

    @app.post("/api/clips/{clip_id}/restore")
    def restore(clip_id: str):
        lib.restore(get(clip_id)["id"])
        return {"ok": True}

    @app.delete("/api/trash")
    def empty_trash():
        return {"ok": True, "deleted": lib.empty_trash()}

    @app.post("/api/clips/{clip_id}/export")
    async def export(clip_id: str, body: dict = Body(default={})):
        get(clip_id)
        new = await asyncio.to_thread(lib.export_trim, clip_id, bool(body.get("exact", True)))
        return public_clip(new)

    @app.post("/api/clips/{clip_id}/share")
    def share(clip_id: str):
        c = get(clip_id)
        tok = c["share_token"] or secrets.token_urlsafe(9)
        db.update_clip(clip_id, share_token=tok)
        return {"token": tok, "path": f"/s/{tok}"}

    @app.delete("/api/clips/{clip_id}/share")
    def unshare(clip_id: str):
        get(clip_id)
        db.update_clip(clip_id, share_token=None)
        return {"ok": True}

    @app.post("/api/clips/{clip_id}/discord")
    async def discord(clip_id: str, body: dict = Body(default={})):
        c = get(clip_id)
        hook = cfg["share"]["discord_webhook"].strip()
        if not hook.startswith(("https://discord.com/api/webhooks/", "https://discordapp.com/api/webhooks/")):
            raise HTTPException(400, "Add a Discord webhook in Settings first")
        out = await asyncio.to_thread(_export_file, c, float(body.get("mic", 1.0)), float(body.get("game", 1.0)), 9.5)
        msg = str(body.get("message") or c["title"])[:1900]
        await asyncio.to_thread(_post_discord, hook, out, msg, c)
        return {"ok": True}

    def _export_file(c: dict, mic: float, game: float, max_mb: float | None) -> Path:
        start = c["trim_start"] or 0
        end = c["trim_end"] or c["duration"]
        key = f"{c['id']}-{start:.2f}-{end:.2f}-{mic:.2f}-{game:.2f}-{max_mb}"
        out = EXPORTS / f"{hashlib.sha1(key.encode()).hexdigest()[:16]}.mp4"
        if not out.exists():
            EXPORTS.mkdir(parents=True, exist_ok=True)
            tmp = out.with_suffix(".part.mp4")
            media.mixdown(Path(c["path"]), tmp, start, end, mic, game, max_mb=max_mb)
            tmp.replace(out)
        return out

    def _post_discord(hook: str, path: Path, msg: str, c: dict) -> None:
        boundary = uuid.uuid4().hex
        fname = f"{c['title'][:60]}.mp4".replace('"', "")
        payload = json.dumps({"content": msg, "username": "Clipdeck"})
        parts = [
            f'--{boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\n'
            f"Content-Type: application/json\r\n\r\n{payload}\r\n".encode(),
            f'--{boundary}\r\nContent-Disposition: form-data; name="files[0]"; filename="{fname}"\r\n'
            "Content-Type: video/mp4\r\n\r\n".encode(),
            path.read_bytes(),
            f"\r\n--{boundary}--\r\n".encode(),
        ]
        req = urllib.request.Request(hook, data=b"".join(parts), method="POST", headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}", "User-Agent": "Clipdeck"})
        try:
            urllib.request.urlopen(req, timeout=120).read()
        except Exception as e:
            raise HTTPException(502, f"Discord didn't accept it: {e}")

    # editor ------------------------------------------------------------------

    @app.get("/api/projects")
    def projects():
        out = []
        for pr in db.projects():
            segs = pr["data"].get("segments", [])
            out.append({"id": pr["id"], "name": pr["name"], "updated_at": pr["updated_at"],
                        "clips": len(segs), "cover": segs[0]["clip"] if segs else None})
        return out

    @app.get("/api/projects/{pid}")
    def project(pid: str):
        pr = db.get_project(pid)
        if not pr:
            raise HTTPException(404, "No such edit")
        return pr

    @app.put("/api/projects/{pid}")
    def save_project(pid: str, body: dict = Body(...)):
        data = editor.normalize(body, db.get_clip)
        return db.save_project(pid, data["name"], data)

    @app.delete("/api/projects/{pid}")
    def delete_project(pid: str):
        db.delete_project(pid)
        return {"ok": True}

    @app.post("/api/projects/{pid}/render")
    def render(pid: str, body: dict = Body(...)):
        data = editor.normalize(body, db.get_clip)
        db.save_project(pid, data["name"], data)
        try:
            return core.renderer.submit(pid, data).public()
        except ValueError as e:
            raise HTTPException(400, str(e))

    @app.get("/api/renders")
    def renders():
        return [j.public() for j in sorted(core.renderer.jobs.values(), key=lambda j: -j.created)][:20]

    @app.delete("/api/renders/{job_id}")
    def cancel_render(job_id: str):
        core.renderer.cancel(job_id)
        return {"ok": True}

    @app.get("/media/render/{job_id}")
    def render_file(job_id: str):
        j = core.renderer.jobs.get(job_id)
        if not j or not j.file or not Path(j.file).exists():
            raise HTTPException(404)
        name = "".join(ch for ch in j.name if ch not in '\\/:*?"<>|')[:80] or "edit"
        return FileResponse(j.file, media_type="image/gif", filename=f"{name}.gif")

    @app.get("/api/editor/fonts")
    def fonts():
        return [{"key": k, "label": v[1]} for k, v in editor.FONTS.items()]

    @app.get("/media/font/{key}")
    def font(key: str):
        if key not in editor.FONTS:
            raise HTTPException(404)
        f = Path(editor.font_file(key))
        mt = "font/otf" if f.suffix == ".otf" else "font/ttf"
        return FileResponse(f, media_type=mt, headers=cache_forever)

    # games / albums ----------------------------------------------------------

    @app.get("/api/games")
    def games():
        return db.games()

    @app.get("/api/albums")
    def albums():
        return db.albums()

    @app.post("/api/albums")
    def new_album(body: dict = Body(...)):
        name = str(body.get("name", "")).strip()[:60]
        if not name:
            raise HTTPException(400, "Name it first")
        a = db.create_album(name)
        if body.get("clips"):
            db.album_add(a["id"], list(body["clips"]))
        return a

    @app.patch("/api/albums/{album_id}")
    def rename_album(album_id: str, body: dict = Body(...)):
        db.rename_album(album_id, str(body.get("name", "")).strip()[:60] or "Album")
        return {"ok": True}

    @app.delete("/api/albums/{album_id}")
    def delete_album(album_id: str):
        db.delete_album(album_id)  # clips stay in the library
        return {"ok": True}

    # media -------------------------------------------------------------------

    cache_forever = {"Cache-Control": "private, max-age=31536000, immutable"}

    @app.get("/media/clip/{clip_id}")
    def video(clip_id: str):
        c = get(clip_id)
        return FileResponse(c["path"], media_type="video/mp4", headers={"Cache-Control": "private, max-age=3600"})

    @app.get("/media/thumb/{clip_id}")
    def thumb(clip_id: str):
        p = lib.thumb(clip_id)
        if not p.exists():
            return Response(status_code=404, headers={"Cache-Control": "no-store"})
        return FileResponse(p, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=60"})

    @app.get("/media/preview/{clip_id}")
    def preview(clip_id: str):
        p = lib.preview(clip_id)
        if not p.exists():
            raise HTTPException(404)
        return FileResponse(p, media_type="video/mp4", headers={"Cache-Control": "private, max-age=60"})

    @app.get("/media/audio/{clip_id}/{n}")
    async def audio(clip_id: str, n: int):
        c = get(clip_id)
        if not 0 <= n < c["audio_tracks"]:
            raise HTTPException(404)
        out = CACHE_DIR / "audio" / f"{clip_id}-{n}-{int(c['size'])}.m4a"
        if not out.exists():
            tmp = out.with_suffix(".part.m4a")
            await asyncio.to_thread(media.audio_track, Path(c["path"]), tmp, n)
            tmp.replace(out)
        return FileResponse(out, media_type="audio/mp4", headers={"Cache-Control": "private, max-age=3600"})

    @app.get("/media/strip/{clip_id}")
    async def strip(clip_id: str):
        c = get(clip_id)
        out = CACHE_DIR / "strips" / f"{clip_id}-{int(c['size'])}.jpg"
        if not out.exists():
            tmp = out.with_suffix(".part.jpg")
            await asyncio.to_thread(media.strip, Path(c["path"]), tmp, c["duration"])
            tmp.replace(out)
        return FileResponse(out, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400"})

    @app.get("/media/frame/{clip_id}")
    async def frame(clip_id: str, t: float = 0.0):
        c = get(clip_id)
        t = max(0.0, min(t, max(c["duration"] - 0.05, 0)))
        out = EXPORTS / f"frame-{clip_id}-{t:.3f}.png"
        if not out.exists():
            EXPORTS.mkdir(parents=True, exist_ok=True)
            await asyncio.to_thread(media.frame, Path(c["path"]), out, t)
        name = "".join(ch for ch in c["title"] if ch not in '\\/:*?"<>|')[:60] or "frame"
        return FileResponse(out, media_type="image/png", filename=f"{name} {t:.1f}s.png")

    @app.get("/media/cover/{appid}")
    def cover(appid: str):
        p = steam_cover(appid) if appid.isdigit() else None
        if not p:
            raise HTTPException(404)
        return FileResponse(p, media_type=mimetypes.guess_type(p.name)[0] or "image/jpeg", headers=cache_forever)

    @app.get("/media/hero/{appid}")
    def hero(appid: str):
        p = steam_hero(appid) if appid.isdigit() else None
        if not p:
            raise HTTPException(404)
        return FileResponse(p, media_type="image/jpeg", headers=cache_forever)

    @app.get("/media/download/{clip_id}")
    async def download(clip_id: str, mode: str = "original", mic: float = 1.0, game: float = 1.0):
        c = get(clip_id)
        name = "".join(ch for ch in c["title"] if ch not in '\\/:*?"<>|')[:80] or "clip"
        if mode == "original":
            path = Path(c["path"])
        else:  # "share": one audio track, trimmed, plays everywhere
            path = await asyncio.to_thread(_export_file, c, mic, game, None)
        return FileResponse(path, media_type="video/mp4", filename=f"{name}.mp4")

    # public share pages ------------------------------------------------------

    @app.get("/s/{tok}")
    def shared_page(tok: str):
        c = db.by_share(tok)
        if not c:
            return HTMLResponse(_share_html(None, tok), status_code=404)
        db.add_view(c["id"])
        return HTMLResponse(_share_html(c, tok))

    @app.get("/s/{tok}/video")
    def shared_video(tok: str):
        c = db.by_share(tok)
        if not c:
            raise HTTPException(404)
        return FileResponse(c["path"], media_type="video/mp4")

    @app.get("/s/{tok}/download")
    async def shared_download(tok: str):
        c = db.by_share(tok)
        if not c:
            raise HTTPException(404)
        path = await asyncio.to_thread(_export_file, c, 1.0, 1.0, None)
        name = "".join(ch for ch in c["title"] if ch not in '\\/:*?"<>|')[:80] or "clip"
        return FileResponse(path, media_type="video/mp4", filename=f"{name}.mp4")

    @app.get("/s/{tok}/thumb")
    def shared_thumb(tok: str):
        c = db.by_share(tok)
        if not c or not lib.thumb(c["id"]).exists():
            raise HTTPException(404)
        return FileResponse(lib.thumb(c["id"]), media_type="image/jpeg")

    # the web app -------------------------------------------------------------

    @app.get("/{path:path}")
    def spa(path: str):
        f = (STATIC / path).resolve()
        if path and f.is_file() and STATIC.resolve() in f.parents:
            headers = cache_forever if path.startswith("assets/") else {"Cache-Control": "no-cache"}
            return FileResponse(f, headers=headers)
        index = STATIC / "index.html"
        if not index.exists():
            return HTMLResponse("<p>Web app isn't built. Run <code>./install.sh</code>.</p>", status_code=503)
        return FileResponse(index, headers={"Cache-Control": "no-cache"})

    return app


def _share_html(c: dict | None, tok: str) -> str:
    if not c:
        body = '<div class="gone"><h1>This clip isn\'t shared anymore</h1><p>The link was turned off or the clip was deleted.</p></div>'
        title = "Clip not found"
        meta = ""
    else:
        t = html.escape(c["title"])
        g = html.escape(c["game"])
        secs = int(round((c["trim_end"] or c["duration"]) - (c["trim_start"] or 0)))
        frag = ""
        if c["trim_start"] or c["trim_end"]:
            frag = f"#t={c['trim_start'] or 0:.2f},{c['trim_end'] or c['duration']:.2f}"
        title = t
        meta = (f'<meta property="og:title" content="{t}"><meta property="og:type" content="video.other">'
                f'<meta property="og:image" content="/s/{tok}/thumb"><meta property="og:video" content="/s/{tok}/video">')
        body = f"""
<main>
  <video src="/s/{tok}/video{frag}" poster="/s/{tok}/thumb" controls autoplay playsinline></video>
  <div class="info">
    <h1>{t}</h1>
    <p><span class="game">{g}</span><span class="dot">·</span>{secs}s</p>
  </div>
  <a class="dl" href="/s/{tok}/download">Download</a>
</main>"""
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title} · Clipdeck</title>{meta}
<link rel="icon" href="/icons/icon.svg">
<style>
:root{{color-scheme:dark;--bg:#0b0c0f;--panel:#14161b;--line:#23262e;--text:#eef0f4;--muted:#8a90a0;--accent:#ff5a36}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 Inter,system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px}}
main{{width:min(1100px,100%)}}video{{width:100%;border-radius:14px;background:#000;display:block;aspect-ratio:16/9}}
.info{{margin:18px 2px 0}}h1{{font-size:22px;margin:0 0 4px;font-weight:650;letter-spacing:-.01em}}p{{margin:0;color:var(--muted)}}
.game{{color:var(--text)}}.dot{{margin:0 8px}}.dl{{display:inline-block;margin-top:16px;padding:10px 16px;border-radius:10px;background:var(--panel);border:1px solid var(--line);color:var(--text);text-decoration:none;font-weight:600}}
.dl:hover{{border-color:var(--accent)}}.gone{{text-align:center}}.gone h1{{font-size:20px}}
</style></head><body>{body}</body></html>"""
