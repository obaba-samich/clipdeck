"""Turns saved replays into library clips, and handles trash, storage and edits."""

from __future__ import annotations

import logging
import queue
import shutil
import threading
import time
from datetime import datetime
from pathlib import Path

from . import media
from .config import CACHE_DIR
from .games import safe_folder

log = logging.getLogger("clipdeck.library")

THUMBS = CACHE_DIR / "thumbs"
PREVIEWS = CACHE_DIR / "previews"
VIDEO_EXT = {".mp4", ".mkv", ".mov", ".webm"}


class Events:
    """Tiny pub/sub so the web UI can update live (server-sent events)."""

    def __init__(self):
        self._subs: list[queue.Queue] = []
        self._lock = threading.Lock()

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=100)
        with self._lock:
            self._subs.append(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._lock:
            if q in self._subs:
                self._subs.remove(q)

    def emit(self, kind: str, **data) -> None:
        with self._lock:
            for q in list(self._subs):
                try:
                    q.put_nowait({"type": kind, **data})
                except queue.Full:
                    pass


class Library:
    def __init__(self, config, db, events: Events):
        self.config = config
        self.db = db
        self.events = events
        self._work: queue.Queue = queue.Queue()
        threading.Thread(target=self._worker, daemon=True).start()

    # paths -----------------------------------------------------------------

    @property
    def root(self) -> Path:
        p = self.config.clips_dir
        p.mkdir(parents=True, exist_ok=True)
        return p

    @property
    def trash_dir(self) -> Path:
        p = self.root / ".trash"
        p.mkdir(parents=True, exist_ok=True)
        return p

    @staticmethod
    def thumb(clip_id: str) -> Path:
        return THUMBS / f"{clip_id}.jpg"

    @staticmethod
    def preview(clip_id: str) -> Path:
        return PREVIEWS / f"{clip_id}.mp4"

    def _unique(self, folder: Path, stem: str, ext: str = ".mp4") -> Path:
        folder.mkdir(parents=True, exist_ok=True)
        p = folder / f"{stem}{ext}"
        n = 2
        while p.exists():
            p = folder / f"{stem} ({n}){ext}"
            n += 1
        return p

    # new clips ---------------------------------------------------------------

    def ingest(self, src: Path, game: str = "Desktop", steam_appid: str | None = None,
               source: str = "hotkey", seconds: float | None = None, created: float | None = None,
               title: str | None = None, move: bool = True) -> dict:
        """Add a recording to the library. Trims to the last `seconds` if asked."""
        created = created or time.time()
        when = datetime.fromtimestamp(created)
        folder = self.root / safe_folder(game)
        dst = self._unique(folder, f"{safe_folder(game)} {when:%Y-%m-%d %H-%M-%S}")
        info = media.probe(src)
        if move:
            if seconds and info["duration"] > seconds + 1:
                media.last_seconds(src, dst, seconds)
            else:
                media.faststart(src, dst)
            src.unlink(missing_ok=True)
        else:
            dst = src
        info = media.probe(dst)
        clip = self.db.add_clip(
            path=str(dst), title=title or f"{game} · {when:%b %-d, %-I:%M %p}", game=game,
            steam_appid=steam_appid, source=source, created_at=created, **info,
        )
        self.events.emit("clip", clip=clip)
        self._work.put(("art", clip["id"]))
        self._work.put(("storage", None))
        return clip

    def make_art(self, clip_id: str) -> None:
        clip = self.db.get_clip(clip_id)
        if not clip:
            return
        src = Path(clip["path"])
        d = clip["duration"] or 1
        start = clip["trim_start"] or 0
        end = clip["trim_end"] or d
        try:
            # The interesting bit is usually near the end of a replay.
            media.thumbnail(src, self.thumb(clip_id), start + (end - start) * 0.7)
            media.preview(src, self.preview(clip_id), max(start, end - 6), min(4.0, end - start))
        except Exception:
            log.exception("art for %s failed", clip_id)
        self.events.emit("art", id=clip_id)

    def _worker(self) -> None:
        while True:
            kind, arg = self._work.get()
            try:
                if kind == "art":
                    self.make_art(arg)
                elif kind == "storage":
                    self.enforce_storage()
            except Exception:
                log.exception("job %s failed", kind)

    def scan(self) -> int:
        """Import video files dropped into the clips folder by hand, drop missing ones."""
        added = 0
        for clip in self.db.list_clips(limit=100000) + self.db.list_clips(trash=True, limit=100000):
            if not Path(clip["path"]).exists():
                self.db.delete_clip(clip["id"])
        # Only the clips folder and one level of game folders: never sweep a whole drive.
        files = [*self.root.glob("*"), *self.root.glob("*/*")]
        for f in sorted(files):
            if not f.is_file() or f.suffix.lower() not in VIDEO_EXT \
                    or any(p.startswith(".") for p in f.relative_to(self.root).parts):
                continue
            if self.db.by_path(str(f)):
                continue
            game = f.parent.name if f.parent != self.root else "Desktop"
            try:
                self.ingest(f, game=game, source="import", created=f.stat().st_mtime, title=f.stem, move=False)
                added += 1
            except Exception:
                log.exception("import %s failed", f)
        for clip in self.db.list_clips(limit=100000):
            if not self.thumb(clip["id"]).exists():
                self._work.put(("art", clip["id"]))
        return added

    # trash -----------------------------------------------------------------

    def trash(self, clip_id: str) -> None:
        clip = self.db.get_clip(clip_id)
        if not clip or clip["deleted_at"]:
            return
        src = Path(clip["path"])
        dst = self._unique(self.trash_dir, src.stem, src.suffix)
        if src.exists():
            shutil.move(src, dst)
        self.db.update_clip(clip_id, path=str(dst), deleted_at=time.time(), share_token=None)
        self.events.emit("removed", id=clip_id)

    def restore(self, clip_id: str) -> None:
        clip = self.db.get_clip(clip_id)
        if not clip or not clip["deleted_at"]:
            return
        src = Path(clip["path"])
        dst = self._unique(self.root / safe_folder(clip["game"]), src.stem, src.suffix)
        if src.exists():
            shutil.move(src, dst)
        self.db.update_clip(clip_id, path=str(dst), deleted_at=None)
        self.events.emit("clip", clip=self.db.get_clip(clip_id))

    def purge(self, clip_id: str) -> None:
        """Permanently delete one clip that's already in the trash."""
        clip = self.db.get_clip(clip_id)
        if not clip or not clip["deleted_at"]:
            return
        Path(clip["path"]).unlink(missing_ok=True)
        self.thumb(clip_id).unlink(missing_ok=True)
        self.preview(clip_id).unlink(missing_ok=True)
        self.db.delete_clip(clip_id)

    def empty_trash(self, older_than_days: float = 0) -> int:
        cutoff = time.time() - older_than_days * 86400
        n = 0
        for clip in self.db.list_clips(trash=True, limit=100000):
            if clip["deleted_at"] <= cutoff:
                self.purge(clip["id"])
                n += 1
        return n

    def enforce_storage(self) -> None:
        s = self.config["storage"]
        if s["trash_days"]:
            self.empty_trash(s["trash_days"])
        max_bytes = float(s["max_gb"] or 0) * 1024**3
        if not s["auto_clean"] or not max_bytes:
            return
        used = self.db.stats()["size"]
        for clip in self.db.list_clips(sort="oldest", limit=100000):
            if used <= max_bytes:
                break
            if clip["favorite"]:
                continue
            self.trash(clip["id"])
            used -= clip["size"]

    # edits -----------------------------------------------------------------

    def rename_game(self, clip_id: str, game: str) -> dict:
        clip = self.db.get_clip(clip_id)
        src = Path(clip["path"])
        if not clip["deleted_at"] and src.exists():
            dst = self._unique(self.root / safe_folder(game), src.stem, src.suffix)
            shutil.move(src, dst)
            self.db.update_clip(clip_id, path=str(dst))
        return self.db.update_clip(clip_id, game=game)

    def export_trim(self, clip_id: str, exact: bool = True) -> dict:
        """Save the trimmed part of a clip as a new clip (the original stays)."""
        clip = self.db.get_clip(clip_id)
        start = clip["trim_start"] or 0
        end = clip["trim_end"] or clip["duration"]
        src = Path(clip["path"])
        dst = self._unique(src.parent, f"{src.stem} (trimmed)")
        media.cut(src, dst, start, end, exact=exact)
        info = media.probe(dst)
        new = self.db.add_clip(
            path=str(dst), title=f"{clip['title']} (trimmed)", game=clip["game"],
            steam_appid=clip["steam_appid"], source="trim", created_at=time.time(), **info,
        )
        self.events.emit("clip", clip=new)
        self._work.put(("art", new["id"]))
        return new

    def move_root(self, old: Path, new: Path) -> int:
        """Move every clip under `old` to the same place under `new` (game folders, trash)."""
        new.mkdir(parents=True, exist_ok=True)
        moved = 0
        for clip in self.db.list_clips(limit=1_000_000) + self.db.list_clips(trash=True, limit=1_000_000):
            src = Path(clip["path"])
            try:
                rel = src.relative_to(old)
            except ValueError:
                continue
            dst = new / rel
            if dst.exists():
                dst = self._unique(dst.parent, dst.stem, dst.suffix)
            dst.parent.mkdir(parents=True, exist_ok=True)
            if src.exists():
                shutil.move(src, dst)
            self.db.update_clip(clip["id"], path=str(dst))
            moved += 1
        # Tidy up game folders left empty.
        for d in sorted((p for p in old.rglob("*") if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
            try:
                d.rmdir()
            except OSError:
                pass
        self.events.emit("bulk")
        return moved

    def refresh_art(self, clip_id: str) -> None:
        self._work.put(("art", clip_id))
