import { ReactNode, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowDownUp, Clapperboard, Film, Mic, Scissors, Search, Sparkles, Star, Trash2, Upload, Video } from "lucide-react";
import { api, Clip, fmtSize, useLive } from "../api";
import { ClipGrid, GameIcon, SkeletonGrid } from "../components/ClipGrid";
import { useApp } from "../components/Layout";
import { Empty, Menu, useConfirm, useToast } from "../components/ui";

const SORTS = [
  { v: "newest", label: "Newest" },
  { v: "oldest", label: "Oldest" },
  { v: "longest", label: "Longest" },
  { v: "largest", label: "Largest" },
  { v: "views", label: "Most watched" },
];

export function useClips(query: Record<string, string | boolean | undefined>) {
  const [clips, setClips] = useState<Clip[] | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [art, setArt] = useState<Record<string, number>>({});
  const qs = useMemo(() => {
    const p = new URLSearchParams();
    Object.entries(query).forEach(([k, v]) => v !== undefined && v !== "" && v !== false && p.set(k, String(v)));
    return p.toString();
  }, [JSON.stringify(query)]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = () => api<Clip[]>(`/api/clips?${qs}`).then(setClips).catch(() => setClips([]));
  useEffect(() => {
    setClips(null);
    load();
  }, [qs]); // eslint-disable-line react-hooks/exhaustive-deps

  useLive((e) => {
    if (e.type === "clip") {
      setFresh(e.clip.id);
      load();
    } else if (e.type === "art") {
      setArt((a) => ({ ...a, [e.id]: Date.now() }));
    } else if (e.type === "removed" || e.type === "updated" || e.type === "bulk") {
      load();
    }
  });
  return { clips, reload: load, fresh, art };
}

type Props = {
  title: ReactNode;
  sub?: ReactNode;
  query?: Record<string, string | boolean | undefined>;
  header?: ReactNode;
  showGames?: boolean;
  trash?: boolean;
  albumId?: string;
  empty?: ReactNode;
  actions?: ReactNode;
};

export function ClipsView({ title, sub, query = {}, header, showGames, trash, albumId, empty, actions }: Props) {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") || "";
  const sort = params.get("sort") || "newest";
  const source = params.get("source") || "";
  const game = params.get("game") || "";
  const { games } = useApp();
  const [sortMenu, setSortMenu] = useState<{ x: number; y: number } | null>(null);
  const { clips, reload, fresh, art } = useClips({ ...query, q, sort, game: (query.game as string) || game, trash });

  const shown = useMemo(() => (clips && source ? clips.filter((c) => c.source === source) : clips), [clips, source]);
  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p, { replace: true });
  };
  const total = shown?.reduce((n, c) => n + c.size, 0) ?? 0;

  return (
    <div className="page">
      {header ?? (
        <div className="head">
          <div>
            <h1>{title}</h1>
            <div className="sub">{sub ?? (shown ? `${shown.length} ${shown.length === 1 ? "clip" : "clips"} · ${fmtSize(total)}` : " ")}</div>
          </div>
          <div className="actions">
            {actions}
            <button className="btn" onClick={(e) => setSortMenu({ x: e.clientX - 160, y: e.clientY + 14 })}>
              <ArrowDownUp />
              {SORTS.find((s) => s.v === sort)?.label}
            </button>
          </div>
        </div>
      )}
      {!trash && (
        <div className="filters">
          <button className={`chip${!source ? " on" : ""}`} onClick={() => set("source", "")}>All</button>
          <button className={`chip${source === "voice" ? " on" : ""}`} onClick={() => set("source", source === "voice" ? "" : "voice")}><Mic size={14} />Voice</button>
          <button className={`chip${source === "hype" ? " on" : ""}`} onClick={() => set("source", source === "hype" ? "" : "hype")}><Sparkles size={14} />Auto</button>
          <button className={`chip${source === "trim" ? " on" : ""}`} onClick={() => set("source", source === "trim" ? "" : "trim")}><Scissors size={14} />Trimmed</button>
          <button className={`chip${source === "record" ? " on" : ""}`} onClick={() => set("source", source === "record" ? "" : "record")}><Video size={14} />Recordings</button>
          <button className={`chip${source === "edit" ? " on" : ""}`} onClick={() => set("source", source === "edit" ? "" : "edit")}><Clapperboard size={14} />Edits</button>
          {showGames &&
            games.map((g) => (
              <button key={g.game} className={`chip${game === g.game ? " on" : ""}`} onClick={() => set("game", game === g.game ? "" : g.game)}>
                {g.steam_appid && <GameIcon game={g.game} appid={g.steam_appid} className="chip-gi" />}
                {g.game}
              </button>
            ))}
        </div>
      )}
      {shown === null ? (
        <SkeletonGrid />
      ) : shown.length === 0 ? (
        q ? (
          <Empty icon={<Search />} title={`Nothing for “${q}”`} body="Try a game name or part of a clip title." />
        ) : (
          empty ?? <Empty icon={<Film />} title="No clips here" />
        )
      ) : (
        <ClipGrid clips={shown} trash={trash} albumId={albumId} freshId={fresh} art={art} onChanged={reload} />
      )}
      {sortMenu && (
        <Menu x={sortMenu.x} y={sortMenu.y} onClose={() => setSortMenu(null)} items={SORTS.map((s) => ({ label: s.label, onClick: () => set("sort", s.v === "newest" ? "" : s.v) }))} />
      )}
    </div>
  );
}

export function AllClips() {
  const [params] = useSearchParams();
  const q = params.get("q");
  const { importFiles } = useApp();
  return (
    <ClipsView
      title={q ? `Results for “${q}”` : "All clips"}
      showGames={!q}
      actions={<button className="btn" onClick={importFiles} title="Import videos (or drag them onto the window)"><Upload /><span className="hide-sm">Import</span></button>}
      empty={<NoClipsYet />}
    />
  );
}

export function Favorites() {
  return (
    <ClipsView
      title="Favorites"
      query={{ favorite: true }}
      showGames
      empty={<Empty icon={<Star />} title="No favorites yet" body="Star your best clips to keep them here. Favorites are never cleaned up automatically." />}
    />
  );
}

export function Trash() {
  const [confirm, node] = useConfirm();
  const toast = useToast();
  const { status, refresh } = useApp();
  const empty = async () => {
    const ok = await confirm({
      title: "Empty trash?",
      body: `${status?.stats.trash ?? 0} clips (${fmtSize(status?.stats.trash_size ?? 0)}) will be deleted from your PC for good.`,
      ok: "Empty trash",
      danger: true,
    });
    if (!ok) return;
    const r = await api<{ deleted: number }>("/api/trash", { method: "DELETE" });
    toast({ title: `Deleted ${r.deleted} clips`, icon: <Trash2 /> });
    refresh();
    location.reload();
  };
  return (
    <>
      <ClipsView
        title="Trash"
        trash
        sub="Clips here are deleted for good after the number of days set in Settings."
        actions={
          <button className="btn danger" onClick={empty} disabled={!status?.stats.trash}>
            <Trash2 />
            Empty trash
          </button>
        }
        empty={<Empty icon={<Trash2 />} title="Trash is empty" body="Clips you delete go here first, so you can get them back." />}
      />
      {node}
    </>
  );
}

export function NoClipsYet() {
  const { status } = useApp();
  return (
    <Empty
      icon={<Scissors />}
      title="No clips yet"
      body={
        <>
          Press <span className="kbd">F8</span> in game or say <b>“clip that”</b> to save the last 30 seconds.
          {status?.recorder.state !== "recording" && <> Replay isn't running right now, so turn it on first.</>}
        </>
      }
      action={
        status?.recorder.state !== "recording" ? (
          <Link className="btn primary" to="/settings#recording">Open recording settings</Link>
        ) : undefined
      }
    />
  );
}
