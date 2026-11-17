import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Film, FolderOpen, Gamepad2, MoreHorizontal, Pencil, Plus, Star, Trash2 } from "lucide-react";
import { Album, api, fmtAgo, fmtDuration, fmtSize, Game, initials, media, useFetch } from "../api";
import { ClipGrid, SkeletonGrid } from "../components/ClipGrid";
import { useApp } from "../components/Layout";
import { Empty, Menu, useConfirm, usePrompt } from "../components/ui";
import { ClipsView, NoClipsYet, useClips } from "./Clips";

/* ---------- home ---------- */

export function Home() {
  const { status, games } = useApp();
  const { clips, reload, fresh, art } = useClips({ limit: "60" });
  const favs = useClips({ favorite: true, limit: "8" });
  const hour = new Date().getHours();
  const hello = hour < 5 ? "Late night session" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  const today = clips?.filter((c) => Date.now() / 1000 - c.created_at < 86400 * 0.75) ?? [];
  const earlier = clips?.filter((c) => !today.includes(c)).slice(0, 24) ?? [];
  const s = status?.stats;

  return (
    <div className="page">
      <div className="head">
        <div>
          <h1>{hello}</h1>
          <div className="sub">
            {s ? `${s.clips} clips · ${fmtDuration(s.duration)} of gameplay · ${fmtSize(s.size)}` : " "}
            {status && status.game !== "Desktop" && <> · Playing <b style={{ color: "var(--text)" }}>{status.game}</b></>}
          </div>
        </div>
      </div>

      <div className="filters mobile-only-flex">
        <Link className="chip" to="/clips"><Film size={14} />All clips</Link>
        <Link className="chip" to="/favorites"><Star size={14} />Favorites</Link>
        <Link className="chip" to="/albums"><FolderOpen size={14} />Albums</Link>
        <Link className="chip" to="/trash"><Trash2 size={14} />Trash</Link>
      </div>
      {clips === null ? (
        <SkeletonGrid />
      ) : clips.length === 0 ? (
        <NoClipsYet />
      ) : (
        <>
          {today.length > 0 && (
            <>
              <h2 className="section" style={{ marginTop: 6 }}>Today <Link to="/clips">See all</Link></h2>
              <ClipGrid clips={today} freshId={fresh} art={art} onChanged={reload} toolbar={false} />
            </>
          )}
          {games.length > 1 && (
            <>
              <h2 className="section">Your games <Link to="/games">See all</Link></h2>
              <GameShelf games={games.slice(0, 8)} />
            </>
          )}
          {favs.clips && favs.clips.length > 0 && (
            <>
              <h2 className="section">Favorites <Link to="/favorites">See all</Link></h2>
              <ClipGrid clips={favs.clips} art={favs.art} onChanged={favs.reload} toolbar={false} />
            </>
          )}
          {earlier.length > 0 && (
            <>
              <h2 className="section">{today.length ? "Earlier" : "Recent clips"} <Link to="/clips">See all</Link></h2>
              <ClipGrid clips={earlier} freshId={fresh} art={art} onChanged={reload} toolbar={false} />
            </>
          )}
        </>
      )}
    </div>
  );
}

/* ---------- games ---------- */

function GameCover({ g }: { g: Game }) {
  const [bad, setBad] = useState(false);
  const [wide, setWide] = useState(false);
  if (g.steam_appid && !bad) {
    const src = media.cover(g.steam_appid);
    return wide ? (
      <>
        <img className="blurbg" src={src} alt="" />
        <img className="mid" src={src} alt="" />
      </>
    ) : (
      <img src={src} alt="" loading="lazy" onError={() => setBad(true)} onLoad={(e) => setWide(e.currentTarget.naturalWidth > e.currentTarget.naturalHeight)} />
    );
  }
  return <div className="letter">{initials(g.game)}</div>;
}

function GameShelf({ games }: { games: Game[] }) {
  return (
    <div className="games-grid">
      {games.map((g) => (
        <Link key={g.game} to={`/games/${encodeURIComponent(g.game)}`} className="game-tile">
          <div className="cover"><GameCover g={g} /></div>
          <div className="n">{g.game}</div>
          <div className="c">{g.count} {g.count === 1 ? "clip" : "clips"} · {fmtAgo(g.last_at)}</div>
        </Link>
      ))}
    </div>
  );
}

export function Games() {
  const { games } = useApp();
  return (
    <div className="page">
      <div className="head">
        <div>
          <h1>Games</h1>
          <div className="sub">{games.length} {games.length === 1 ? "game" : "games"} clipped</div>
        </div>
      </div>
      {games.length ? (
        <GameShelf games={games} />
      ) : (
        <Empty icon={<Gamepad2 />} title="No games yet" body="Clipdeck spots Steam games, Roblox and Minecraft by itself, and sorts their clips here." />
      )}
    </div>
  );
}

export function GamePage() {
  const { name = "" } = useParams();
  const { games } = useApp();
  const g = games.find((x) => x.game === name);
  const [heroOk, setHeroOk] = useState(true);
  const header = (
    <div className={`hero${g?.steam_appid && heroOk ? "" : " plain"}`}>
      {g?.steam_appid && heroOk && <img className="bg" src={media.hero(g.steam_appid)} alt="" onError={() => setHeroOk(false)} />}
      {g?.steam_appid && heroOk && <div className="fade" />}
      <div className="inner">
        {g?.steam_appid && <img className="poster" src={media.cover(g.steam_appid)} alt="" onError={(e) => (e.currentTarget.style.display = "none")} />}
        <div>
          <h1>{name}</h1>
          {g && (
            <div className="stats">
              <span>{g.count} {g.count === 1 ? "clip" : "clips"}</span>
              <span>{fmtSize(g.size)}</span>
              <span>Last clip {fmtAgo(g.last_at)}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
  return <ClipsView title={name} query={{ game: name }} header={header} />;
}

/* ---------- albums ---------- */

export function Albums() {
  const { data: albums, reload } = useFetch<Album[]>("/api/albums");
  const [prompt, node] = usePrompt();
  const nav = useNavigate();
  const create = async () => {
    const name = await prompt("New album", "", "Create");
    if (!name) return;
    const a = await api<Album>("/api/albums", { method: "POST", json: { name } });
    reload();
    nav(`/albums/${a.id}`);
  };
  return (
    <div className="page">
      <div className="head">
        <div>
          <h1>Albums</h1>
          <div className="sub">Group clips however you like: montages, funny moments, a night with friends.</div>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={create}><Plus />New album</button>
        </div>
      </div>
      {albums === null ? null : albums.length === 0 ? (
        <Empty icon={<FolderOpen />} title="No albums yet" body="Make one here, or right-click clips and pick “Add to album”." />
      ) : (
        <div className="albums-grid">
          {albums.map((a) => (
            <Link key={a.id} to={`/albums/${a.id}`} className="album game-tile">
              <div className="stack">
                <div className="b2" />
                <div className="b1" />
                <div className="b0">
                  {a.cover_id ? <img src={media.thumb(a.cover_id)} alt="" loading="lazy" /> : <div className="empty-ic"><FolderOpen /></div>}
                </div>
              </div>
              <div className="n">{a.name}</div>
              <div className="c">{a.count} {a.count === 1 ? "clip" : "clips"}</div>
            </Link>
          ))}
        </div>
      )}
      {node}
    </div>
  );
}

export function AlbumPage() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const [album, setAlbum] = useState<Album | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [prompt, promptNode] = usePrompt();
  const [confirm, confirmNode] = useConfirm();
  const load = () => api<Album[]>("/api/albums").then((as) => setAlbum(as.find((a) => a.id === id) ?? null));
  useEffect(() => {
    load();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const rename = async () => {
    const name = await prompt("Rename album", album?.name, "Rename");
    if (name) {
      await api(`/api/albums/${id}`, { method: "PATCH", json: { name } });
      load();
    }
  };
  const remove = async () => {
    if (await confirm({ title: `Delete “${album?.name}”?`, body: "Only the album goes. The clips stay in your library.", ok: "Delete album", danger: true })) {
      await api(`/api/albums/${id}`, { method: "DELETE" });
      nav("/albums");
    }
  };

  return (
    <>
      <ClipsView
        title={album?.name ?? " "}
        query={{ album: id }}
        albumId={id}
        actions={
          <button className="btn icon" aria-label="Album options" onClick={(e) => setMenu({ x: e.clientX - 180, y: e.clientY + 14 })}>
            <MoreHorizontal />
          </button>
        }
        empty={<Empty icon={<FolderOpen />} title="This album is empty" body="Right-click clips anywhere and pick “Add to album”." />}
      />
      {menu && (
        <Menu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: "Rename", icon: <Pencil />, onClick: rename },
            "sep",
            { label: "Delete album", icon: <Trash2 />, danger: true, onClick: remove },
          ]}
        />
      )}
      {promptNode}
      {confirmNode}
    </>
  );
}
