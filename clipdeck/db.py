"""SQLite store for clips and albums."""

from __future__ import annotations

import secrets
import sqlite3
import threading
import time
from pathlib import Path

from .config import DATA_DIR

SCHEMA = """
CREATE TABLE IF NOT EXISTS clips (
    id          TEXT PRIMARY KEY,
    path        TEXT NOT NULL UNIQUE,
    title       TEXT NOT NULL,
    game        TEXT NOT NULL DEFAULT 'Desktop',
    steam_appid TEXT,
    source      TEXT NOT NULL DEFAULT 'hotkey',
    created_at  REAL NOT NULL,
    duration    REAL NOT NULL DEFAULT 0,
    width       INTEGER NOT NULL DEFAULT 0,
    height      INTEGER NOT NULL DEFAULT 0,
    fps         REAL NOT NULL DEFAULT 0,
    size        INTEGER NOT NULL DEFAULT 0,
    audio_tracks INTEGER NOT NULL DEFAULT 0,
    favorite    INTEGER NOT NULL DEFAULT 0,
    trim_start  REAL,
    trim_end    REAL,
    share_token TEXT UNIQUE,
    views       INTEGER NOT NULL DEFAULT 0,
    deleted_at  REAL
);
CREATE INDEX IF NOT EXISTS clips_created ON clips(created_at);
CREATE INDEX IF NOT EXISTS clips_game ON clips(game);

CREATE TABLE IF NOT EXISTS albums (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS album_clips (
    album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    clip_id  TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    added_at REAL NOT NULL,
    PRIMARY KEY (album_id, clip_id)
);
"""

EDITABLE = {"title", "game", "favorite", "trim_start", "trim_end"}
SORTS = {
    "newest": "created_at DESC",
    "oldest": "created_at ASC",
    "longest": "duration DESC",
    "largest": "size DESC",
    "views": "views DESC, created_at DESC",
}


def new_id() -> str:
    return secrets.token_urlsafe(6).replace("-", "x").replace("_", "y")


class DB:
    def __init__(self, path: Path = DATA_DIR / "clipdeck.db"):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.executescript(SCHEMA)
        self.lock = threading.Lock()

    def _q(self, sql: str, args=()) -> list[dict]:
        with self.lock:
            return [dict(r) for r in self.conn.execute(sql, args).fetchall()]

    def _x(self, sql: str, args=()) -> int:
        with self.lock:
            cur = self.conn.execute(sql, args)
            self.conn.commit()
            return cur.rowcount

    # clips -----------------------------------------------------------------

    def add_clip(self, **fields) -> dict:
        fields.setdefault("id", new_id())
        fields.setdefault("created_at", time.time())
        cols = ",".join(fields)
        marks = ",".join("?" * len(fields))
        self._x(f"INSERT INTO clips ({cols}) VALUES ({marks})", tuple(fields.values()))
        return self.get_clip(fields["id"])

    def get_clip(self, clip_id: str) -> dict | None:
        rows = self._q("SELECT * FROM clips WHERE id=?", (clip_id,))
        return rows[0] if rows else None

    def by_path(self, path: str) -> dict | None:
        rows = self._q("SELECT * FROM clips WHERE path=?", (path,))
        return rows[0] if rows else None

    def by_share(self, token: str) -> dict | None:
        rows = self._q("SELECT * FROM clips WHERE share_token=? AND deleted_at IS NULL", (token,))
        return rows[0] if rows else None

    def list_clips(self, q: str = "", game: str = "", favorite: bool = False,
                   album: str = "", trash: bool = False, sort: str = "newest",
                   limit: int = 200, offset: int = 0) -> list[dict]:
        where = ["deleted_at IS NOT NULL" if trash else "deleted_at IS NULL"]
        args: list = []
        if q:
            where.append("(title LIKE ? OR game LIKE ?)")
            args += [f"%{q}%", f"%{q}%"]
        if game:
            where.append("game = ?")
            args.append(game)
        if favorite:
            where.append("favorite = 1")
        if album:
            where.append("id IN (SELECT clip_id FROM album_clips WHERE album_id = ?)")
            args.append(album)
        order = SORTS.get(sort, SORTS["newest"])
        sql = f"SELECT * FROM clips WHERE {' AND '.join(where)} ORDER BY {order} LIMIT ? OFFSET ?"
        return self._q(sql, (*args, limit, offset))

    def update_clip(self, clip_id: str, **fields) -> dict | None:
        fields = {k: v for k, v in fields.items() if k in EDITABLE | {"path", "share_token", "deleted_at", "size", "duration"}}
        if fields:
            sets = ",".join(f"{k}=?" for k in fields)
            self._x(f"UPDATE clips SET {sets} WHERE id=?", (*fields.values(), clip_id))
        return self.get_clip(clip_id)

    def add_view(self, clip_id: str) -> None:
        self._x("UPDATE clips SET views = views + 1 WHERE id=?", (clip_id,))

    def delete_clip(self, clip_id: str) -> None:
        self._x("DELETE FROM clips WHERE id=?", (clip_id,))

    def games(self) -> list[dict]:
        return self._q(
            """SELECT game, MAX(steam_appid) AS steam_appid, COUNT(*) AS count,
                      SUM(size) AS size, MAX(created_at) AS last_at
               FROM clips WHERE deleted_at IS NULL GROUP BY game ORDER BY last_at DESC"""
        )

    def stats(self) -> dict:
        row = self._q(
            """SELECT COUNT(*) AS clips, COALESCE(SUM(size),0) AS size,
                      COALESCE(SUM(duration),0) AS duration,
                      COALESCE(SUM(favorite),0) AS favorites
               FROM clips WHERE deleted_at IS NULL"""
        )[0]
        row["trash"] = self._q("SELECT COUNT(*) AS n FROM clips WHERE deleted_at IS NOT NULL")[0]["n"]
        row["trash_size"] = self._q("SELECT COALESCE(SUM(size),0) AS n FROM clips WHERE deleted_at IS NOT NULL")[0]["n"]
        return row

    # albums ----------------------------------------------------------------

    def albums(self) -> list[dict]:
        return self._q(
            """SELECT a.*, COUNT(c.id) AS count,
                      (SELECT ac2.clip_id FROM album_clips ac2 JOIN clips c2 ON c2.id = ac2.clip_id
                       WHERE ac2.album_id = a.id AND c2.deleted_at IS NULL
                       ORDER BY ac2.added_at DESC LIMIT 1) AS cover_id
               FROM albums a
               LEFT JOIN album_clips ac ON ac.album_id = a.id
               LEFT JOIN clips c ON c.id = ac.clip_id AND c.deleted_at IS NULL
               GROUP BY a.id ORDER BY a.created_at DESC"""
        )

    def create_album(self, name: str) -> dict:
        aid = new_id()
        self._x("INSERT INTO albums (id, name, created_at) VALUES (?,?,?)", (aid, name, time.time()))
        return self._q("SELECT * FROM albums WHERE id=?", (aid,))[0]

    def rename_album(self, album_id: str, name: str) -> None:
        self._x("UPDATE albums SET name=? WHERE id=?", (name, album_id))

    def delete_album(self, album_id: str) -> None:
        self._x("DELETE FROM albums WHERE id=?", (album_id,))

    def album_add(self, album_id: str, clip_ids: list[str]) -> None:
        now = time.time()
        with self.lock:
            self.conn.executemany(
                "INSERT OR IGNORE INTO album_clips (album_id, clip_id, added_at) VALUES (?,?,?)",
                [(album_id, c, now) for c in clip_ids],
            )
            self.conn.commit()

    def album_remove(self, album_id: str, clip_ids: list[str]) -> None:
        with self.lock:
            self.conn.executemany(
                "DELETE FROM album_clips WHERE album_id=? AND clip_id=?",
                [(album_id, c) for c in clip_ids],
            )
            self.conn.commit()

    def clip_albums(self, clip_id: str) -> list[str]:
        return [r["album_id"] for r in self._q("SELECT album_id FROM album_clips WHERE clip_id=?", (clip_id,))]
