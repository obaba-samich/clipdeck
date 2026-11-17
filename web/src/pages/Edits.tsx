import { Link, useNavigate } from "react-router-dom";
import { Clapperboard, Plus, Trash2 } from "lucide-react";
import { api, fmtAgo, media, ProjectRow, RenderJob, useFetch, useLive } from "../api";
import { Empty, useConfirm } from "../components/ui";

export function Edits() {
  const { data: projects, reload } = useFetch<ProjectRow[]>("/api/projects");
  const { data: jobs, setData: setJobs } = useFetch<RenderJob[]>("/api/renders");
  const nav = useNavigate();
  const [confirm, node] = useConfirm();

  useLive((e) => {
    if (e.type !== "render") return;
    setJobs((js) => {
      const rest = (js || []).filter((j) => j.id !== e.job.id);
      return [e.job, ...rest];
    });
  });

  const remove = async (p: ProjectRow) => {
    if (!(await confirm({ title: `Delete “${p.name}”?`, body: "Only the edit goes. Its clips and anything you exported stay.", ok: "Delete edit", danger: true }))) return;
    await api(`/api/projects/${p.id}`, { method: "DELETE" });
    reload();
  };

  const active = (jobs || []).filter((j) => j.state === "queued" || j.state === "running" || Date.now() / 1000 - j.created < 3600);

  return (
    <div className="page">
      <div className="head">
        <div>
          <h1>Edits</h1>
          <div className="sub">Montages and edited clips. Exports land in your library.</div>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={() => nav("/edit")}><Plus />New edit</button>
        </div>
      </div>

      {active.length > 0 && (
        <>
          <h2 className="section" style={{ marginTop: 0 }}>Exports</h2>
          {active.map((j) => (
            <div key={j.id} className="render-row">
              <b style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{j.name}</b>
              {j.state === "running" || j.state === "queued" ? (
                <>
                  <div className="bar"><i style={{ width: `${Math.max(2, j.progress * 100)}%` }} /></div>
                  <span style={{ color: "var(--muted)" }}>{j.state === "queued" ? "Waiting" : `${Math.round(j.progress * 100)}%`}</span>
                  <button className="btn sm ghost" onClick={() => api(`/api/renders/${j.id}`, { method: "DELETE" })}>Cancel</button>
                </>
              ) : j.state === "done" ? (
                <>
                  <span style={{ flex: 1, color: "var(--good)" }}>Done</span>
                  {j.clip_id && <Link className="btn sm" to={`/clip/${j.clip_id}`}>Open</Link>}
                  {j.file && <a className="btn sm" href={`/media/render/${j.id}`}>Download GIF</a>}
                </>
              ) : (
                <span style={{ flex: 1, color: j.state === "error" ? "var(--danger)" : "var(--muted)" }}>{j.state === "error" ? "Failed" : "Canceled"}</span>
              )}
            </div>
          ))}
        </>
      )}

      {projects === null ? null : projects.length === 0 ? (
        <Empty
          icon={<Clapperboard />}
          title="No edits yet"
          body="Select clips in your library and pick “Edit together”, or hit Edit on any clip. Cut, speed up, add text, go vertical for TikTok."
          action={<Link className="btn" to="/clips">Go to clips</Link>}
        />
      ) : (
        <>
          <h2 className="section">Your edits</h2>
          <div className="edits-grid">
            {projects.map((p) => (
              <div key={p.id} className="card" style={{ cursor: "pointer" }} onClick={() => nav(`/edit/${p.id}`)}>
                <div className="thumb">
                  {p.cover ? <img src={media.thumb(p.cover)} alt="" loading="lazy" /> : <div className="processing">Empty</div>}
                  <div className="shade" />
                  <span className="badge">{p.clips} {p.clips === 1 ? "clip" : "clips"}</span>
                </div>
                <div className="meta" style={{ alignItems: "center" }}>
                  <div style={{ flex: 1 }}>
                    <div className="t">{p.name}</div>
                    <div className="s">Edited {fmtAgo(p.updated_at)}</div>
                  </div>
                  <button className="btn sm icon ghost" aria-label="Delete edit" onClick={(e) => { e.stopPropagation(); remove(p); }}><Trash2 /></button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {node}
    </div>
  );
}
