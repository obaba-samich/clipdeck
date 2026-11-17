import { createContext, ReactNode, useContext, useEffect, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Clapperboard, Film, FolderOpen, Gamepad2, Home, Mic, Search, Settings, Star, Trash2, Scissors } from "lucide-react";
import { api, fmtSize, Game, media, Status, useLive } from "../api";
import { GameIcon } from "./ClipGrid";
import { useImporter } from "./Importer";
import { useToast } from "./ui";

type AppState = { status: Status | null; games: Game[]; refresh: () => void; importFiles: () => void };
const AppCtx = createContext<AppState>({ status: null, games: [], refresh: () => {}, importFiles: () => {} });
export const useApp = () => useContext(AppCtx);

export function Layout({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [games, setGames] = useState<Game[]>([]);
  const [scrolled, setScrolled] = useState(false);
  const toast = useToast();
  const nav = useNavigate();
  const loc = useLocation();
  const scroller = useRef<HTMLDivElement>(null);
  const importer = useImporter();

  const refresh = () => {
    api<Status>("/api/status").then(setStatus).catch(() => {});
    api<Game[]>("/api/games").then(setGames).catch(() => {});
  };

  useEffect(() => {
    refresh();
    const t = setInterval(() => api<Status>("/api/status").then(setStatus).catch(() => {}), 5000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [loc.pathname]);

  useLive((e) => {
    if (e.type === "clip") {
      refresh();
      if (e.clip.source !== "import" && e.clip.source !== "trim") {
        const label = e.clip.source === "voice" ? "Voice clip saved" : e.clip.source === "hype" ? "Auto clip saved" : "Clip saved";
        setTimeout(
          () => toast({ title: label, body: `${e.clip.game} · ${Math.round(e.clip.duration)}s`, img: media.thumb(e.clip.id, Date.now()), onClick: () => nav(`/clip/${e.clip.id}`) }),
          1200,
        );
      }
    }
    if (e.type === "removed" || e.type === "bulk" || e.type === "updated") refresh();
    if (e.type === "heard") toast({ title: `Heard “${e.phrase}”`, body: "Saving clip…", icon: <Mic /> });
  });

  return (
    <AppCtx.Provider value={{ status, games, refresh, importFiles: importer.open }}>
      <div className="shell">
        <Sidebar status={status} games={games} />
        <div className="main">
          <TopBar status={status} scrolled={scrolled} />
          <div className="scroll" ref={scroller} onScroll={(e) => setScrolled((e.target as HTMLDivElement).scrollTop > 4)}>
            {children}
          </div>
        </div>
        <TabBar />
        {importer.node}
      </div>
    </AppCtx.Provider>
  );
}

function Sidebar({ status, games }: { status: Status | null; games: Game[] }) {
  const s = status?.stats;
  const disk = status?.disk;
  const used = s?.size ?? 0;
  const pct = disk ? Math.min(100, (used / (used + disk.free)) * 100) : 0;
  return (
    <aside className="sidebar">
      <div className="brand">
        <img src="/icons/icon.svg" alt="" />
        Clipdeck
      </div>
      <NavLink to="/" end className="nav-item"><Home /><span className="label">Home</span></NavLink>
      <NavLink to="/clips" className="nav-item"><Film /><span className="label">All clips</span><span className="count">{s?.clips ?? ""}</span></NavLink>
      <NavLink to="/favorites" className="nav-item"><Star /><span className="label">Favorites</span><span className="count">{s?.favorites || ""}</span></NavLink>
      <NavLink to="/albums" className="nav-item"><FolderOpen /><span className="label">Albums</span></NavLink>
      <NavLink to="/games" end className="nav-item"><Gamepad2 /><span className="label">Games</span></NavLink>
      <div className="nav-label">Your games</div>
      <div className="nav-games">
        {games.map((g) => (
          <NavLink key={g.game} to={`/games/${encodeURIComponent(g.game)}`} className="nav-item nav-game">
            <GameIcon game={g.game} appid={g.steam_appid} className="nav-gi" />
            <span className="label">{g.game}</span>
            <span className="count">{g.count}</span>
          </NavLink>
        ))}
        {!games.length && <div style={{ padding: "4px 12px", color: "var(--muted)", fontSize: 12.5 }}>Games show up here once you clip them.</div>}
      </div>
      <NavLink to="/trash" className="nav-item"><Trash2 /><span className="label">Trash</span><span className="count">{s?.trash || ""}</span></NavLink>
      <NavLink to="/settings" className="nav-item"><Settings /><span className="label">Settings</span></NavLink>
      {s && (
        <div className="storage">
          <div className="row">
            <span>Clips {fmtSize(used)}</span>
            <span>{disk ? `${fmtSize(disk.free)} free` : ""}</span>
          </div>
          <div className="bar"><i style={{ width: `${Math.max(pct, 1.5)}%` }} /></div>
        </div>
      )}
    </aside>
  );
}

export function RecPill({ status }: { status: Status | null }) {
  const r = status?.recorder;
  const state = r?.state ?? "stopped";
  const cls = state === "recording" ? "on" : state === "error" ? "err" : "";
  const label = state === "recording" ? "Replay on" : state === "starting" ? "Starting…" : state === "error" ? "Replay error" : "Replay off";
  return (
    <NavLink to="/settings#recording" className={`rec ${cls}`} title={r?.error || "Replay buffer"}>
      <span className="dot" />
      <span className="lbl">{label}</span>
      {state === "recording" && <span className="sub">{r!.buffer_seconds}s</span>}
      {status?.listener.state === "listening" && <Mic size={14} style={{ color: "var(--muted)" }} aria-label="Listening for voice command" />}
    </NavLink>
  );
}

function TopBar({ status, scrolled }: { status: Status | null; scrolled: boolean }) {
  const nav = useNavigate();
  const loc = useLocation();
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get("q") || "");
  const input = useRef<HTMLInputElement>(null);
  const toast = useToast();

  useEffect(() => {
    if (!loc.pathname.startsWith("/clips")) setQ("");
  }, [loc.pathname]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if ((e.key === "/" && !typing) || ((e.ctrlKey || e.metaKey) && e.key === "k")) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  const submit = (v: string) => {
    setQ(v);
    nav(v ? `/clips?q=${encodeURIComponent(v)}` : "/clips", { replace: loc.pathname === "/clips" });
  };

  const clipNow = async () => {
    try {
      const r = await api<{ ok: boolean; reason?: string }>("/api/clip", { method: "POST", json: { source: "web" } });
      if (!r.ok) toast({ title: "Couldn't clip", body: r.reason, error: true });
    } catch (e) {
      toast({ title: "Couldn't clip", body: String((e as Error).message), error: true });
    }
  };

  return (
    <header className={`topbar${scrolled ? " scrolled" : ""}`}>
      <div className="brand-sm mobile-only">
        <img src="/icons/icon.svg" alt="" />
      </div>
      <label className="search">
        <Search />
        <input ref={input} value={q} placeholder="Search clips and games" onChange={(e) => submit(e.target.value)} />
        <kbd>/</kbd>
      </label>
      <div className="spacer" />
      <RecPill status={status} />
      <button className="btn primary desktop-only" onClick={clipNow} disabled={status?.recorder.state !== "recording"} title="Save the replay buffer now">
        <Scissors />
        Clip now
      </button>
    </header>
  );
}

function TabBar() {
  const toast = useToast();
  const clip = async () => {
    try {
      const r = await api<{ ok: boolean; reason?: string }>("/api/clip", { method: "POST", json: { source: "phone" } });
      toast(r.ok ? { title: "Clipping…", body: "It'll show up in a few seconds.", icon: <Clapperboard /> } : { title: "Couldn't clip", body: r.reason, error: true });
    } catch (e) {
      toast({ title: "Couldn't clip", body: String((e as Error).message), error: true });
    }
  };
  return (
    <nav className="tabbar">
      <NavLink to="/" end><Home />Home</NavLink>
      <NavLink to="/games"><Gamepad2 />Games</NavLink>
      <button className="clip-btn" onClick={clip}><span className="c"><Scissors /></span>Clip</button>
      <NavLink to="/albums"><FolderOpen />Albums</NavLink>
      <NavLink to="/settings"><Settings />Settings</NavLink>
    </nav>
  );
}
