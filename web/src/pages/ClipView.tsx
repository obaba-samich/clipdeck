import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft, Camera, Check, Copy, Download, ExternalLink, FolderOpen, FolderPlus, Link2, Maximize, Pause, Play, Repeat,
  RotateCcw, Scissors, Send, SkipBack, SkipForward, Star, Trash2, Volume2, VolumeX, Wand2, X,
} from "lucide-react";
import { Album, api, Clip, fmtDate, fmtSize, fmtTime, media, SOURCE_LABEL, useLive } from "../api";
import { GameIcon } from "../components/ClipGrid";
import { useApp } from "../components/Layout";
import { Empty, Menu, Modal, Range, useConfirm, useToast } from "../components/ui";
import { softSeek, useFrameHold } from "../components/frameHold";

const STRIP = 10;
const SPEEDS = [0.25, 0.5, 1, 1.5, 2];

export function ClipView() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { games, refresh } = useApp();
  const [clip, setClip] = useState<Clip | null>(null);
  const [missing, setMissing] = useState(false);
  const [confirm, confirmNode] = useConfirm();

  const video = useRef<HTMLVideoElement>(null);
  const hold = useRef<HTMLCanvasElement>(null);
  const tracks = useRef<HTMLAudioElement[]>([]);
  const [paused, setPaused] = useState(true);
  const [t, setT] = useState(0);
  const [loop, setLoop] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [vol, setVol] = useState({ game: 1, mic: 1 });
  const [muted, setMuted] = useState(false);
  const [trim, setTrim] = useState<{ a: number; b: number } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState("");
  const [title, setTitle] = useState("");
  const [gameMenu, setGameMenu] = useState<{ x: number; y: number } | null>(null);
  const [albumsOpen, setAlbumsOpen] = useState(false);
  const [discordOpen, setDiscordOpen] = useState(false);

  const load = useCallback(() => {
    api<Clip>(`/api/clips/${id}`)
      .then((c) => {
        setClip(c);
        setTitle(c.title);
        setTrim({ a: c.trim_start ?? 0, b: c.trim_end ?? c.duration });
        setDirty(false);
      })
      .catch(() => setMissing(true));
  }, [id]);

  useEffect(() => {
    setClip(null);
    setMissing(false);
    load();
    api(`/api/clips/${id}/view`, { method: "POST" }).catch(() => {});
  }, [id, load]);

  useLive((e) => {
    if ((e.type === "updated" && e.clip.id === id) || (e.type === "removed" && e.id === id)) load();
  });

  const multi = (clip?.audio_tracks ?? 0) >= 2;
  const dur = clip?.duration ?? 0;

  /* --- separate game/mic tracks play through <audio> elements kept in sync with the video --- */
  const syncAudio = useCallback(
    (force = false) => {
      const v = video.current;
      if (!v || !multi) return;
      tracks.current.forEach((a) => {
        if (!a) return;
        if (force || Math.abs(a.currentTime - v.currentTime) > 0.08) a.currentTime = v.currentTime;
        a.playbackRate = v.playbackRate;
        if (v.paused !== a.paused) (v.paused ? a.pause() : a.play().catch(() => {}));
      });
    },
    [multi],
  );

  useEffect(() => {
    if (!multi) return;
    const [g, m] = tracks.current;
    if (g) g.volume = muted ? 0 : vol.game;
    if (m) m.volume = muted ? 0 : vol.mic;
  }, [vol, muted, multi]);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    let raf = 0;
    const tick = () => {
      setT(v.currentTime);
      if (trim && !v.paused && v.currentTime >= trim.b - 0.03) {
        if (loop) v.currentTime = trim.a;
        else v.pause();
        syncAudio(true);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const drift = setInterval(() => syncAudio(), 500);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(drift);
    };
  }, [trim, loop, syncAudio]);

  const toggle = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) {
      if (trim && (v.currentTime < trim.a || v.currentTime >= trim.b - 0.05)) v.currentTime = trim.a;
      v.play();
    } else v.pause();
  };
  const seek = (s: number) => {
    const v = video.current;
    if (!v) return;
    const to = Math.max(0, Math.min(dur, s));
    softSeek(v, to);
    setT(to);
    syncAudio(true);
  };

  const setIn = () => trim && (setTrim({ a: Math.min(t, trim.b - 0.5), b: trim.b }), setDirty(true));
  const setOut = () => trim && (setTrim({ a: trim.a, b: Math.max(t, trim.a + 0.5) }), setDirty(true));

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.ctrlKey || e.metaKey || e.altKey) return;
      const v = video.current;
      if (!v) return;
      const fps = clip?.fps || 60;
      switch (e.key) {
        case " ": case "k": e.preventDefault(); toggle(); break;
        case "ArrowLeft": case "j": seek(v.currentTime - (e.shiftKey ? 1 : 5)); break;
        case "ArrowRight": case "l": seek(v.currentTime + (e.shiftKey ? 1 : 5)); break;
        case ",": v.pause(); seek(v.currentTime - 1 / fps); break;
        case ".": v.pause(); seek(v.currentTime + 1 / fps); break;
        case "i": setIn(); break;
        case "o": setOut(); break;
        case "m": setMuted((m) => !m); break;
        case "f": fullscreen(); break;
        case "Escape": nav(-1); break;
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  const fullscreen = () => {
    const el = video.current?.parentElement;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else {
      // iPhone: element fullscreen may be missing or refused; fall back to the native video player.
      const native = () => (video.current as HTMLVideoElement & { webkitEnterFullscreen?: () => void })?.webkitEnterFullscreen?.();
      if (el.requestFullscreen) el.requestFullscreen().catch(native);
      else native();
    }
  };

  /* --- actions --- */

  const patch = async (body: Partial<Clip>) => {
    const c = await api<Clip>(`/api/clips/${id}`, { method: "PATCH", json: body });
    setClip(c);
    return c;
  };
  const saveTitle = () => clip && title.trim() && title !== clip.title && patch({ title: title.trim() });
  const saveTrim = async () => {
    if (!trim) return;
    const full = trim.a <= 0.05 && trim.b >= dur - 0.05;
    await patch({ trim_start: full ? null : trim.a, trim_end: full ? null : trim.b });
    setDirty(false);
    toast({ title: full ? "Trim removed" : "Trim saved", body: "The original video is kept. Share links, Discord and “Download for sharing” use the trim." });
  };
  const resetTrim = () => {
    setTrim({ a: 0, b: dur });
    setDirty(true);
  };
  const exportTrim = async () => {
    setBusy("export");
    try {
      if (dirty) await saveTrim();
      const c = await api<Clip>(`/api/clips/${id}/export`, { method: "POST", json: { exact: true } });
      toast({ title: "Saved trimmed copy", body: c.title, onClick: () => nav(`/clip/${c.id}`) });
    } catch (e) {
      toast({ title: "Couldn't save copy", body: String((e as Error).message), error: true });
    } finally {
      setBusy("");
    }
  };
  const share = async () => {
    const r = await api<{ path: string }>(`/api/clips/${id}/share`, { method: "POST" });
    const url = `${location.origin}${r.path}`;
    await navigator.clipboard?.writeText(url).catch(() => {});
    toast({ title: "Share link copied", body: url, icon: <Link2 /> });
    load();
  };
  const unshare = async () => {
    await api(`/api/clips/${id}/share`, { method: "DELETE" });
    load();
  };
  const nativeShare = async () => {
    // Phone share sheet (Messages, TikTok, Discord…): send the actual file, one audio track.
    if (!clip) return;
    if (navigator.userAgent.includes("ClipdeckApp")) {
      // The iPhone app catches downloads and opens the share sheet itself.
      location.href = media.download(id, "share", vol.mic, vol.game);
      return;
    }
    setBusy("share");
    try {
      const res = await fetch(media.download(id, "share", vol.mic, vol.game));
      const blob = await res.blob();
      const file = new File([blob], `${clip.title}.mp4`, { type: "video/mp4" });
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: clip.title });
      else location.href = media.download(id, "share", vol.mic, vol.game);
    } catch {
      /* user closed the sheet */
    } finally {
      setBusy("");
    }
  };
  const del = async () => {
    if (!clip) return;
    if (clip.deleted_at) {
      const ok = await confirm({ title: "Delete this clip forever?", body: "The video file is removed from your PC. This can't be undone.", ok: "Delete forever", danger: true });
      if (!ok) return;
      await api("/api/clips/bulk", { method: "POST", json: { action: "purge", ids: [id] } });
      nav("/trash");
      return;
    }
    await api(`/api/clips/${id}`, { method: "DELETE" });
    toast({ title: "Moved to trash", icon: <Trash2 /> });
    refresh();
    nav(-1);
  };
  const restore = async () => {
    await api(`/api/clips/${id}/restore`, { method: "POST" });
    load();
    refresh();
  };
  const setGame = async (game: string) => {
    await patch({ game });
    refresh();
  };

  useFrameHold(video, hold, !!clip && !!trim);

  if (missing) return <Empty icon={<X />} title="Clip not found" body="It may have been deleted." action={<Link className="btn" to="/">Back to library</Link>} />;
  if (!clip || !trim) return <div className="viewer"><div className="player skeleton" /></div>;

  const len = trim.b - trim.a;
  const trimmed = trim.a > 0.05 || trim.b < dur - 0.05;
  const shareUrl = clip.share_token ? `${location.origin}/s/${clip.share_token}` : "";

  return (
    <div className="viewer">
      <div style={{ minWidth: 0 }}>
        <div className="head desktop-only" style={{ paddingTop: 0, paddingBottom: 12 }}>
          <button className="btn ghost" onClick={() => nav(-1)}><ArrowLeft />Back</button>
        </div>
        <div className={`player${paused ? " paused" : ""}`} onClick={toggle} onDoubleClick={fullscreen}>
          <video
            ref={video}
            src={media.clip(id)}
            poster={media.thumb(id)}
            playsInline
            preload="auto"
            muted={multi || muted}
            onPlay={() => { setPaused(false); syncAudio(true); }}
            onPause={() => { setPaused(true); syncAudio(true); }}
            onSeeked={() => syncAudio(true)}
            onRateChange={() => syncAudio(true)}
            onLoadedMetadata={(e) => { if (trim.a > 0) e.currentTarget.currentTime = trim.a; }}
          />
          <canvas ref={hold} className="frame-hold" />
          {multi && [0, 1].map((n) => (
            <audio key={n} ref={(el) => { if (el) tracks.current[n] = el; }} src={`/media/audio/${id}/${n}`} preload="auto" />
          ))}
          <div className="overlay"><div className="big-play"><Play /></div></div>
        </div>

        <Timeline id={id} dur={dur} t={t} trim={trim} onSeek={seek} onTrim={(a, b) => { setTrim({ a, b }); setDirty(true); }} />

        <div className="controls">
          <button className="btn icon" onClick={toggle} aria-label={paused ? "Play" : "Pause"}>{paused ? <Play /> : <Pause />}</button>
          <button className="btn icon ghost" onClick={() => seek(t - 5)} aria-label="Back 5 seconds"><SkipBack /></button>
          <button className="btn icon ghost" onClick={() => seek(t + 5)} aria-label="Forward 5 seconds"><SkipForward /></button>
          <span className="time">{fmtTime(t)} / {fmtTime(dur)}</span>
          <div className="grow" />
          <button className={`btn sm ${loop ? "" : "ghost"}`} onClick={() => setLoop(!loop)} title="Loop the trimmed part"><Repeat />Loop</button>
          <button className="btn sm ghost" onClick={() => { const i = (SPEEDS.indexOf(speed) + 1) % SPEEDS.length; setSpeed(SPEEDS[i]); if (video.current) video.current.playbackRate = SPEEDS[i]; }} title="Playback speed">{speed}×</button>
          <button className="btn sm icon ghost" onClick={() => setMuted(!muted)} aria-label="Mute">{muted ? <VolumeX /> : <Volume2 />}</button>
          <a className="btn sm icon ghost" href={`/media/frame/${id}?t=${t.toFixed(3)}`} aria-label="Save this frame as an image" title="Save frame as image"><Camera /></a>
          <button className="btn sm" onClick={() => nav(`/edit?clips=${id}`)} title="Open in the editor"><Wand2 />Edit</button>
          <button className="btn sm icon ghost" onClick={fullscreen} aria-label="Fullscreen"><Maximize /></button>
        </div>

        <div className="trim-row">
          <Scissors size={16} />
          <span>Trim <b>{fmtTime(trim.a)}</b> – <b>{fmtTime(trim.b)}</b> · {len.toFixed(1)}s</span>
          <button className="btn sm ghost desktop-only" onClick={setIn} title="Start here (I)">Set start <span className="kbd" style={{ height: 20, padding: "0 6px" }}>I</span></button>
          <button className="btn sm ghost desktop-only" onClick={setOut} title="End here (O)">Set end <span className="kbd" style={{ height: 20, padding: "0 6px" }}>O</span></button>
          <div style={{ flex: 1 }} />
          {trimmed && <button className="btn sm ghost" onClick={resetTrim}><RotateCcw />Reset</button>}
          {dirty && <button className="btn sm primary" onClick={saveTrim}><Check />Save trim</button>}
          {trimmed && !dirty && (
            <button className="btn sm" onClick={exportTrim} disabled={busy === "export"}>
              <Scissors />{busy === "export" ? "Saving…" : "Save as new clip"}
            </button>
          )}
        </div>
      </div>

      <div className="side">
        <div className="panel">
          <input className="title-input" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={saveTitle} onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()} aria-label="Clip title" />
          <button className="chip" style={{ marginTop: 4 }} onClick={(e) => setGameMenu({ x: e.clientX, y: e.clientY + 12 })} title="Change game">
            <GameIcon game={clip.game} appid={clip.steam_appid} className="chip-gi" />
            {clip.game}
          </button>
          <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
            {clip.deleted_at ? (
              <button className="btn" onClick={restore}><RotateCcw />Restore</button>
            ) : (
              <button className={`btn${clip.favorite ? " fav-on" : ""}`} onClick={() => patch({ favorite: clip.favorite ? 0 : 1 })}>
                <Star />{clip.favorite ? "Favorited" : "Favorite"}
              </button>
            )}
            <button className="btn" onClick={() => setAlbumsOpen(true)}><FolderPlus />Album</button>
            <button className="btn danger" onClick={del} aria-label="Delete"><Trash2 />{clip.deleted_at ? "Delete forever" : ""}</button>
          </div>
        </div>

        {multi && (
          <div className="panel">
            <h3>Audio</h3>
            <div className="mix"><span>Game</span><Range label="Game volume" value={vol.game} min={0} max={1.5} step={0.05} onChange={(v) => setVol({ ...vol, game: v })} /><span>{Math.round(vol.game * 100)}%</span></div>
            <div className="mix"><span>Mic</span><Range label="Mic volume" value={vol.mic} min={0} max={1.5} step={0.05} onChange={(v) => setVol({ ...vol, mic: v })} /><span>{Math.round(vol.mic * 100)}%</span></div>
            <p style={{ color: "var(--muted)", fontSize: 12.5, margin: "10px 0 0" }}>Downloads “for sharing” and Discord use this mix.</p>
          </div>
        )}

        <div className="panel">
          <h3>Share</h3>
          <div className="stack-btns">
            <button className="btn mobile-only" onClick={nativeShare} disabled={busy === "share"}><Send />{busy === "share" ? "Preparing…" : "Share…"}</button>
            {shareUrl ? (
              <>
                <div className="share-link">
                  <input className="input" readOnly value={shareUrl} onFocus={(e) => e.currentTarget.select()} />
                  <button className="btn icon" aria-label="Copy link" onClick={() => { navigator.clipboard?.writeText(shareUrl); toast({ title: "Link copied", icon: <Copy /> }); }}><Copy /></button>
                  <a className="btn icon" href={shareUrl} target="_blank" rel="noreferrer" aria-label="Open share page"><ExternalLink /></a>
                </div>
                <button className="btn ghost sm" onClick={unshare} style={{ justifySelf: "start" }}>Turn off link</button>
              </>
            ) : (
              <button className="btn" onClick={share} disabled={!!clip.deleted_at}><Link2 />Get share link</button>
            )}
            <button className="btn" onClick={() => setDiscordOpen(true)} disabled={!!clip.deleted_at}><Send />Send to Discord</button>
            <a className="btn" href={media.download(id, "share", vol.mic, vol.game)}><Download />Download for sharing</a>
            <a className="btn ghost" href={media.download(id)}><Download />Download original</a>
            {["localhost", "127.0.0.1"].includes(location.hostname) && (
              <button className="btn ghost" onClick={() => api("/api/reveal", { method: "POST", json: { clip: id } })}><FolderOpen />Show in folder</button>
            )}
          </div>
        </div>

        <div className="panel">
          <h3>Details</h3>
          <dl className="kv">
            <dt>Recorded</dt><dd>{fmtDate(clip.created_at)}</dd>
            <dt>Length</dt><dd>{fmtTime(clip.duration)}{trimmed ? ` (trim ${len.toFixed(1)}s)` : ""}</dd>
            <dt>Video</dt><dd>{clip.height}p · {Math.round(clip.fps)} fps</dd>
            <dt>Audio</dt><dd>{clip.audio_tracks >= 2 ? "Game + mic (separate)" : clip.audio_tracks ? "1 track" : "None"}</dd>
            <dt>Size</dt><dd>{fmtSize(clip.size)}</dd>
            <dt>Clipped by</dt><dd>{SOURCE_LABEL[clip.source] ?? clip.source}</dd>
            <dt>Views</dt><dd>{clip.views}</dd>
            <dt>File</dt><dd title={clip.path}>{clip.filename}</dd>
          </dl>
        </div>
      </div>

      {gameMenu && (
        <Menu
          x={gameMenu.x}
          y={gameMenu.y}
          onClose={() => setGameMenu(null)}
          items={[
            ...games.filter((g) => g.game !== clip.game).slice(0, 10).map((g) => ({ label: g.game, onClick: () => setGame(g.game) })),
            "sep" as const,
            { label: "Other game…", onClick: async () => { const g = window.prompt("Game name", clip.game); if (g?.trim()) setGame(g.trim()); } },
          ]}
        />
      )}
      {albumsOpen && <AlbumsModal clip={clip} onClose={() => { setAlbumsOpen(false); load(); }} />}
      {discordOpen && <DiscordModal clip={clip} vol={vol} onClose={() => setDiscordOpen(false)} />}
      {confirmNode}
    </div>
  );
}

/* ---------- timeline with trim handles and a frame strip ---------- */

function Timeline({ id, dur, t, trim, onSeek, onTrim }: { id: string; dur: number; t: number; trim: { a: number; b: number }; onSeek: (s: number) => void; onTrim: (a: number, b: number) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const drag = useRef<"a" | "b" | "seek" | null>(null);
  const [stripOk, setStripOk] = useState(true);
  const pct = (s: number) => `${(s / (dur || 1)) * 100}%`;

  const at = (clientX: number) => {
    const r = el.current!.getBoundingClientRect();
    return Math.max(0, Math.min(dur, ((clientX - r.left) / r.width) * dur));
  };
  const down = (e: React.PointerEvent, what: "a" | "b" | "seek") => {
    e.stopPropagation();
    drag.current = what;
    el.current?.setPointerCapture(e.pointerId);
    if (what === "seek") onSeek(at(e.clientX));
  };
  const move = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const s = at(e.clientX);
    if (drag.current === "a") onTrim(Math.min(s, trim.b - 0.5), trim.b);
    else if (drag.current === "b") onTrim(trim.a, Math.max(s, trim.a + 0.5));
    else onSeek(s);
    if (drag.current !== "seek") onSeek(s);
  };
  const up = () => (drag.current = null);

  return (
    <div className="timeline" ref={el} onPointerDown={(e) => down(e, "seek")} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      {stripOk && (
        <div className="strip">
          {Array.from({ length: STRIP }, (_, i) => (
            <div key={i} style={{ flex: 1, backgroundImage: `url(/media/strip/${id})`, backgroundSize: `${STRIP * 100}% 100%`, backgroundPosition: `${(i / (STRIP - 1)) * 100}% 0` }} />
          ))}
          <img src={`/media/strip/${id}`} alt="" style={{ display: "none" }} onError={() => setStripOk(false)} />
        </div>
      )}
      <div className="dim" style={{ left: 0, width: pct(trim.a) }} />
      <div className="dim" style={{ left: pct(trim.b), right: 0 }} />
      <div className="range" style={{ left: pct(trim.a), width: `calc(${pct(trim.b - trim.a)})` }} />
      <div className="handle" style={{ left: pct(trim.a) }} onPointerDown={(e) => down(e, "a")} role="slider" aria-label="Trim start" aria-valuenow={trim.a}><i /></div>
      <div className="handle" style={{ left: pct(trim.b) }} onPointerDown={(e) => down(e, "b")} role="slider" aria-label="Trim end" aria-valuenow={trim.b}><i /></div>
      <div className="head-line" style={{ left: pct(t) }} />
    </div>
  );
}

function AlbumsModal({ clip, onClose }: { clip: Clip; onClose: () => void }) {
  const [albums, setAlbums] = useState<Album[] | null>(null);
  const [inAlbums, setIn] = useState<string[]>(clip.albums);
  const [name, setName] = useState("");
  useEffect(() => {
    api<Album[]>("/api/albums").then(setAlbums);
  }, []);
  const flip = async (a: Album) => {
    const has = inAlbums.includes(a.id);
    await api("/api/clips/bulk", { method: "POST", json: { action: has ? "unalbum" : "album", album: a.id, ids: [clip.id] } });
    setIn(has ? inAlbums.filter((x) => x !== a.id) : [...inAlbums, a.id]);
  };
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const a = await api<Album>("/api/albums", { method: "POST", json: { name, clips: [clip.id] } });
    setAlbums([a, ...(albums || [])]);
    setIn([...inAlbums, a.id]);
    setName("");
  };
  return (
    <Modal onClose={onClose}>
      <h3>Albums</h3>
      <div className="stack-btns" style={{ maxHeight: 280, overflowY: "auto", marginTop: 12 }}>
        {albums?.map((a) => (
          <button key={a.id} className="btn" onClick={() => flip(a)}>
            {inAlbums.includes(a.id) ? <Check style={{ color: "var(--accent)" }} /> : <FolderPlus />}
            {a.name}
          </button>
        ))}
      </div>
      <form onSubmit={create} style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <input className="input" placeholder="New album name" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn primary" disabled={!name.trim()}>Create</button>
      </form>
      <div className="acts"><button className="btn" onClick={onClose}>Done</button></div>
    </Modal>
  );
}

function DiscordModal({ clip, vol, onClose }: { clip: Clip; vol: { game: number; mic: number }; onClose: () => void }) {
  const toast = useToast();
  const [msg, setMsg] = useState(clip.title);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      await api(`/api/clips/${clip.id}/discord`, { method: "POST", json: { message: msg, mic: vol.mic, game: vol.game } });
      toast({ title: "Sent to Discord", icon: <Send /> });
      onClose();
    } catch (e) {
      toast({ title: "Discord didn't take it", body: String((e as Error).message), error: true });
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose}>
      <h3>Send to Discord</h3>
      <p>Posts the clip to the channel from your webhook in Settings. It's squeezed under Discord's 10 MB limit, so long clips lose some quality.</p>
      <textarea className="input" rows={3} value={msg} onChange={(e) => setMsg(e.target.value)} />
      <div className="acts">
        <Link className="btn ghost" to="/settings#sharing" onClick={onClose}>Webhook settings</Link>
        <button className="btn primary" onClick={send} disabled={busy}><Send />{busy ? "Sending…" : "Send"}</button>
      </div>
    </Modal>
  );
}
