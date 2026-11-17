import { memo, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, Download, FolderPlus, Link2, Mic, Pencil, RotateCcw, Smartphone, Sparkles, Star, Trash2, X } from "lucide-react";
import { Album, api, Clip, clipLength, fmtAgo, fmtDuration, initials, media } from "../api";
import { Menu, MenuItem, Modal, useConfirm, usePrompt, useToast } from "./ui";

const SRC_ICON: Record<string, JSX.Element> = {
  voice: <Mic />,
  hype: <Sparkles />,
  phone: <Smartphone />,
};

export function GameIcon({ game, appid, className = "gicon" }: { game: string; appid: string | null; className?: string }) {
  const [bad, setBad] = useState(false);
  if (appid && !bad) return <img className={className} src={media.cover(appid)} alt="" loading="lazy" onError={() => setBad(true)} />;
  return <div className={className === "gicon" ? "gph" : "ph"}>{initials(game)}</div>;
}

type CardProps = {
  clip: Clip;
  selected: boolean;
  selecting: boolean;
  fresh: boolean;
  artVersion?: number;
  onSelect: (id: string, range: boolean) => void;
  onMenu: (clip: Clip, x: number, y: number) => void;
};

const ClipCard = memo(function ClipCard({ clip, selected, selecting, fresh, artVersion, onSelect, onMenu }: CardProps) {
  const nav = useNavigate();
  const vid = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [thumbOk, setThumbOk] = useState(true);
  const hoverTimer = useRef<number>();

  useEffect(() => setThumbOk(true), [artVersion]);

  const enter = () => {
    hoverTimer.current = window.setTimeout(() => {
      const v = vid.current;
      if (!v) return;
      if (!v.src) v.src = media.preview(clip.id, artVersion);
      v.currentTime = 0;
      v.play().then(() => setPlaying(true)).catch(() => {});
    }, 260);
  };
  const leave = () => {
    clearTimeout(hoverTimer.current);
    vid.current?.pause();
    setPlaying(false);
  };

  const open = (e: React.MouseEvent) => {
    if (selecting || e.shiftKey || e.ctrlKey || e.metaKey) {
      e.preventDefault();
      onSelect(clip.id, e.shiftKey);
      return;
    }
    nav(`/clip/${clip.id}`);
  };

  return (
    <a
      href={`/clip/${clip.id}`}
      className={`card${selected ? " selected" : ""}${fresh ? " new-flash" : ""}`}
      onClick={open}
      onMouseEnter={enter}
      onMouseLeave={leave}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(clip, e.clientX, e.clientY);
      }}
    >
      <div className="thumb">
        {thumbOk ? (
          <img src={media.thumb(clip.id, artVersion)} alt="" loading="lazy" onError={() => setThumbOk(false)} />
        ) : (
          <div className="processing skeleton">Processing…</div>
        )}
        <video ref={vid} muted loop playsInline preload="none" className={playing ? "playing" : ""} />
        <div className="shade" />
        {SRC_ICON[clip.source] && <span className={`badge left src-${clip.source}`}>{SRC_ICON[clip.source]}</span>}
        <span className="badge">{fmtDuration(clipLength(clip))}</span>
        {!!clip.favorite && !selecting && (
          <span className="fav-dot">
            <Star />
          </span>
        )}
        <span
          className="check"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onSelect(clip.id, e.shiftKey);
          }}
        >
          <Check strokeWidth={3} />
        </span>
      </div>
      <div className="meta">
        <GameIcon game={clip.game} appid={clip.steam_appid} />
        <div>
          <div className="t">{clip.title}</div>
          <div className="s">
            {clip.game} · {fmtAgo(clip.created_at)}
          </div>
        </div>
      </div>
    </a>
  );
});

export function SkeletonGrid({ n = 8 }: { n?: number }) {
  return (
    <div className="grid">
      {Array.from({ length: n }, (_, i) => (
        <div key={i}>
          <div className="thumb skeleton" />
          <div className="sk-line skeleton" style={{ width: "70%" }} />
          <div className="sk-line skeleton" style={{ width: "40%", marginTop: 6 }} />
        </div>
      ))}
    </div>
  );
}

type GridProps = {
  clips: Clip[];
  trash?: boolean;
  albumId?: string;
  freshId?: string | null;
  art?: Record<string, number>;
  onChanged: () => void;
};

export function ClipGrid({ clips, trash, albumId, freshId, art = {}, onChanged }: GridProps) {
  const toast = useToast();
  const nav = useNavigate();
  const [sel, setSel] = useState<string[]>([]);
  const [last, setLast] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ clip: Clip; x: number; y: number } | null>(null);
  const [albumPick, setAlbumPick] = useState<string[] | null>(null);
  const [confirm, confirmNode] = useConfirm();
  const [prompt, promptNode] = usePrompt();

  useEffect(() => {
    setSel((s) => s.filter((id) => clips.some((c) => c.id === id)));
  }, [clips]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSel([]);
      if ((e.ctrlKey || e.metaKey) && e.key === "a" && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        setSel(clips.map((c) => c.id));
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [clips]);

  const select = (id: string, range: boolean) => {
    setSel((s) => {
      if (range && last) {
        const a = clips.findIndex((c) => c.id === last);
        const b = clips.findIndex((c) => c.id === id);
        const ids = clips.slice(Math.min(a, b), Math.max(a, b) + 1).map((c) => c.id);
        return Array.from(new Set([...s, ...ids]));
      }
      return s.includes(id) ? s.filter((x) => x !== id) : [...s, id];
    });
    setLast(id);
  };

  const bulk = async (action: string, ids: string[], extra: Record<string, unknown> = {}) => {
    await api("/api/clips/bulk", { method: "POST", json: { action, ids, ...extra } });
    setSel([]);
    onChanged();
  };

  const trashIt = async (ids: string[]) => {
    await bulk("trash", ids);
    toast({ title: ids.length > 1 ? `${ids.length} clips moved to trash` : "Moved to trash", body: "You can restore them from Trash.", icon: <Trash2 /> });
  };

  const purge = async (ids: string[]) => {
    const ok = await confirm({
      title: ids.length > 1 ? `Delete ${ids.length} clips forever?` : "Delete this clip forever?",
      body: "The video files are removed from your PC. This can't be undone.",
      ok: "Delete forever",
      danger: true,
    });
    if (ok) await bulk("purge", ids);
  };

  const share = async (c: Clip) => {
    const r = await api<{ path: string }>(`/api/clips/${c.id}/share`, { method: "POST" });
    const url = `${location.origin}${r.path}`;
    await navigator.clipboard?.writeText(url).catch(() => {});
    toast({ title: "Share link copied", body: url, icon: <Link2 /> });
    onChanged();
  };

  const rename = async (c: Clip) => {
    const t = await prompt("Rename clip", c.title, "Rename");
    if (t) {
      await api(`/api/clips/${c.id}`, { method: "PATCH", json: { title: t } });
      onChanged();
    }
  };

  const menuItems = (c: Clip): MenuItem[] => {
    const ids = sel.includes(c.id) && sel.length > 1 ? sel : [c.id];
    if (trash)
      return [
        { label: ids.length > 1 ? `Restore ${ids.length} clips` : "Restore", icon: <RotateCcw />, onClick: () => bulk("restore", ids) },
        "sep",
        { label: "Delete forever", icon: <Trash2 />, danger: true, onClick: () => purge(ids) },
      ];
    const items: MenuItem[] = [];
    if (ids.length === 1) {
      items.push(
        { label: c.favorite ? "Remove from favorites" : "Add to favorites", icon: <Star />, onClick: () => bulk(c.favorite ? "unfavorite" : "favorite", ids) },
        { label: "Rename", icon: <Pencil />, onClick: () => rename(c) },
        { label: c.share_token ? "Copy share link" : "Get share link", icon: <Link2 />, onClick: () => share(c) },
        { label: "Download", icon: <Download />, onClick: () => (location.href = media.download(c.id)) },
      );
    } else {
      items.push({ label: `Favorite ${ids.length} clips`, icon: <Star />, onClick: () => bulk("favorite", ids) });
    }
    items.push({ label: "Add to album…", icon: <FolderPlus />, onClick: () => setAlbumPick(ids) });
    if (albumId) items.push({ label: "Remove from this album", icon: <X />, onClick: () => bulk("unalbum", ids, { album: albumId }) });
    items.push("sep", { label: ids.length > 1 ? `Move ${ids.length} to trash` : "Move to trash", icon: <Trash2 />, danger: true, onClick: () => trashIt(ids) });
    return items;
  };

  const selecting = sel.length > 0;

  return (
    <>
      <div className={`grid${selecting ? " selecting" : ""}`}>
        {clips.map((c) => (
          <ClipCard
            key={c.id}
            clip={c}
            selected={sel.includes(c.id)}
            selecting={selecting}
            fresh={c.id === freshId}
            artVersion={art[c.id]}
            onSelect={select}
            onMenu={(clip, x, y) => setMenu({ clip, x, y })}
          />
        ))}
      </div>

      <div className={`selbar${selecting ? " show" : ""}`}>
        <span className="n">{sel.length} selected</span>
        {trash ? (
          <>
            <button className="btn sm" onClick={() => bulk("restore", sel)}><RotateCcw />Restore</button>
            <button className="btn sm danger" onClick={() => purge(sel)}><Trash2 />Delete forever</button>
          </>
        ) : (
          <>
            <button className="btn sm" onClick={() => bulk("favorite", sel)}><Star />Favorite</button>
            <button className="btn sm" onClick={() => setAlbumPick(sel)}><FolderPlus />Album</button>
            {albumId && <button className="btn sm" onClick={() => bulk("unalbum", sel, { album: albumId })}><X />Remove</button>}
            <button className="btn sm danger" onClick={() => trashIt(sel)}><Trash2 />Trash</button>
          </>
        )}
        <button className="btn sm ghost icon" aria-label="Clear selection" onClick={() => setSel([])}><X /></button>
      </div>

      {menu && <Menu x={menu.x} y={menu.y} items={menuItems(menu.clip)} onClose={() => setMenu(null)} />}
      {albumPick && (
        <AlbumPicker
          ids={albumPick}
          onClose={() => setAlbumPick(null)}
          onDone={(name, id) => {
            setAlbumPick(null);
            setSel([]);
            onChanged();
            toast({ title: `Added to ${name}`, icon: <FolderPlus />, onClick: () => nav(`/albums/${id}`) });
          }}
        />
      )}
      {confirmNode}
      {promptNode}
    </>
  );
}

function AlbumPicker({ ids, onClose, onDone }: { ids: string[]; onClose: () => void; onDone: (name: string, id: string) => void }) {
  const [albums, setAlbums] = useState<Album[] | null>(null);
  const [name, setName] = useState("");
  useEffect(() => {
    api<Album[]>("/api/albums").then(setAlbums);
  }, []);
  const add = async (a: Album) => {
    await api("/api/clips/bulk", { method: "POST", json: { action: "album", album: a.id, ids } });
    onDone(a.name, a.id);
  };
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const a = await api<Album>("/api/albums", { method: "POST", json: { name, clips: ids } });
    onDone(a.name, a.id);
  };
  return (
    <Modal onClose={onClose}>
      <h3>Add to album</h3>
      <p>{ids.length > 1 ? `${ids.length} clips` : "1 clip"}</p>
      <div className="stack-btns" style={{ maxHeight: 260, overflowY: "auto" }}>
        {albums?.map((a) => (
          <button key={a.id} className="btn" onClick={() => add(a)}>
            <FolderPlus />
            {a.name}
            <span style={{ marginLeft: "auto", color: "var(--muted)", fontWeight: 500 }}>{a.count}</span>
          </button>
        ))}
      </div>
      <form onSubmit={create} style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <input className="input" placeholder="New album name" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn primary" disabled={!name.trim()}>Create</button>
      </form>
    </Modal>
  );
}
