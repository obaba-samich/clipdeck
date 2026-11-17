import { useEffect, useState } from "react";
import { ChevronLeft, Folder, FolderPlus, HardDrive, Home } from "lucide-react";
import { api, fmtSize } from "../api";
import { Modal, usePrompt } from "./ui";

type Listing = {
  path: string;
  parent: string | null;
  dirs: { name: string; path: string }[];
  writable: boolean;
  free: number;
  places: { name: string; path: string }[];
};

export function FolderPicker({ start, title = "Choose a folder", onPick, onClose, moveOption }: {
  start: string;
  title?: string;
  moveOption?: boolean;
  onPick: (path: string, move: boolean) => void;
  onClose: () => void;
}) {
  const [cur, setCur] = useState(start);
  const [ls, setLs] = useState<Listing | null>(null);
  const [move, setMove] = useState(true);
  const [prompt, promptNode] = usePrompt();

  useEffect(() => {
    api<Listing>(`/api/fs?path=${encodeURIComponent(cur)}`).then(setLs);
  }, [cur]);

  const newFolder = async () => {
    if (!ls) return;
    const name = await prompt("New folder", "", "Create");
    if (!name) return;
    const r = await api<{ path: string }>("/api/fs/mkdir", { method: "POST", json: { path: ls.path, name } });
    setCur(r.path);
  };

  return (
    <Modal onClose={onClose}>
      <h3>{title}</h3>
      <div className="fp-places">
        {ls?.places.map((p) => (
          <button key={p.path} className={`chip${ls.path === p.path ? " on" : ""}`} onClick={() => setCur(p.path)}>
            {p.name === "Home" ? <Home size={14} /> : p.path.startsWith("/media") || p.path.startsWith("/mnt") || p.path.startsWith("/run") ? <HardDrive size={14} /> : <Folder size={14} />}
            {p.name}
          </button>
        ))}
      </div>
      <div className="fp-path">
        <button className="btn sm icon ghost" disabled={!ls?.parent} onClick={() => ls?.parent && setCur(ls.parent)} aria-label="Up one folder"><ChevronLeft /></button>
        <span title={ls?.path}>{ls?.path}</span>
        <button className="btn sm icon ghost" onClick={newFolder} aria-label="New folder"><FolderPlus /></button>
      </div>
      <div className="fp-list">
        {ls?.dirs.length === 0 && <div className="fp-empty">No folders inside. You can pick this one.</div>}
        {ls?.dirs.map((d) => (
          <button key={d.path} onClick={() => setCur(d.path)}>
            <Folder size={16} />
            <span>{d.name}</span>
          </button>
        ))}
      </div>
      {ls && <div className="fp-free">{fmtSize(ls.free)} free here{!ls.writable && " · can't save here"}{moveOption && ls.dirs.length > 0 && !/clipdeck$/i.test(ls.path) && " · clips will go in a new “Clipdeck” folder inside"}</div>}
      {moveOption && (
        <label className="fp-move">
          <input type="checkbox" checked={move} onChange={(e) => setMove(e.target.checked)} />
          Move my existing clips there too
        </label>
      )}
      <div className="acts">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!ls?.writable} onClick={() => ls && onPick(ls.path, move)}>Use this folder</button>
      </div>
      {promptNode}
    </Modal>
  );
}
