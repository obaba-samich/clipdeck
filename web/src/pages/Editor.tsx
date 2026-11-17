import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowDown, ArrowLeft, ArrowUp, Copy, Crop, Film, Gauge, Music, Pause, Play, Plus, Redo2, Scissors,
  SlidersHorizontal, Split, Trash2, Type, Undo2, Upload, Volume2, VolumeX,
} from "lucide-react";
import { api, blankProject, Clip, fmtTime, media, newId, Project, RenderJob, Segment, TextItem, useLive } from "../api";
import { Modal, Range, Seg, Toggle, useToast } from "../components/ui";

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const COLORS = ["#ffffff", "#ffd23d", "#ff5a36", "#3ddc97", "#4cc3ff", "#b07cff", "#ff6fb5", "#111111"];
const FONTS: { key: string; label: string; css: string }[] = [
  { key: "bold", label: "Bold", css: "cd-bold" },
  { key: "clean", label: "Clean", css: "cd-clean" },
  { key: "impact", label: "Impact", css: "cd-impact" },
  { key: "serif", label: "Serif", css: "cd-serif" },
  { key: "mono", label: "Mono", css: "cd-mono" },
];
const LOOKS: { name: string; adjust: Project["adjust"] }[] = [
  { name: "None", adjust: { brightness: 0, contrast: 1, saturation: 1, vignette: false, sharpen: false } },
  { name: "Vivid", adjust: { brightness: 0.02, contrast: 1.12, saturation: 1.45, vignette: false, sharpen: true } },
  { name: "Cinematic", adjust: { brightness: -0.04, contrast: 1.2, saturation: 0.85, vignette: true, sharpen: false } },
  { name: "Bright", adjust: { brightness: 0.1, contrast: 1.05, saturation: 1.15, vignette: false, sharpen: false } },
  { name: "Black & white", adjust: { brightness: 0, contrast: 1.25, saturation: 0, vignette: true, sharpen: false } },
];
const ASPECT_RATIO: Record<Project["aspect"], number> = { "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1, "4:5": 4 / 5 };

type Tab = "clips" | "text" | "canvas" | "color" | "audio";

const segLen = (s: Segment) => (s.end - s.start) / s.speed;

/** Where each segment sits on the output timeline. */
function layout(p: Project) {
  let t = 0;
  return p.segments.map((s) => {
    const r = { seg: s, at: t, len: segLen(s) };
    t += r.len;
    return r;
  });
}

function locate(p: Project, T: number) {
  const lay = layout(p);
  for (let i = 0; i < lay.length; i++) {
    const l = lay[i];
    if (T < l.at + l.len || i === lay.length - 1) {
      const local = Math.min(Math.max(T - l.at, 0), l.len);
      return { i, seg: l.seg, src: l.seg.start + local * l.seg.speed, at: l.at };
    }
  }
  return null;
}

export function Editor() {
  const { pid } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const toast = useToast();
  const [id] = useState(() => pid || newId());
  const [p, setP] = useState<Project | null>(null);
  const [clips, setClips] = useState<Record<string, Clip>>({});
  const [tab, setTab] = useState<Tab>("clips");
  const [sel, setSel] = useState<{ kind: "seg" | "text"; id: string } | null>(null);
  const [T, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [saved, setSaved] = useState<"saved" | "saving" | "dirty">("saved");
  const [job, setJob] = useState<RenderJob | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const history = useRef<{ past: Project[]; future: Project[] }>({ past: [], future: [] });

  const video = useRef<HTMLVideoElement>(null);
  const mic = useRef<HTMLAudioElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [stageH, setStageH] = useState(360);
  const curSeg = useRef<string | null>(null);

  /* ---------- load ---------- */

  const loadClips = useCallback(async (ids: string[]) => {
    const missing = ids.filter((c) => !clips[c]);
    if (!missing.length) return;
    const got = await Promise.all(missing.map((c) => api<Clip>(`/api/clips/${c}`).catch(() => null)));
    setClips((m) => ({ ...m, ...Object.fromEntries(got.filter(Boolean).map((c) => [c!.id, c!])) }));
  }, [clips]);

  useEffect(() => {
    (async () => {
      if (pid) {
        const r = await api<{ data: Project }>(`/api/projects/${pid}`).catch(() => null);
        if (!r) return nav("/edits", { replace: true });
        await loadClips(r.data.segments.map((s) => s.clip));
        setP({ ...blankProject(r.data.name), ...r.data });
        return;
      }
      const ids = (params.get("clips") || "").split(",").filter(Boolean);
      const got = (await Promise.all(ids.map((c) => api<Clip>(`/api/clips/${c}`).catch(() => null)))).filter(Boolean) as Clip[];
      setClips(Object.fromEntries(got.map((c) => [c.id, c])));
      const proj = blankProject(got.length === 1 ? got[0].title : got.length ? `${got[0].game} montage` : "New edit");
      proj.segments = got.map((c) => ({ id: newId(), clip: c.id, start: c.trim_start ?? 0, end: c.trim_end ?? c.duration, speed: 1, mute: false }));
      setP(proj);
      await api(`/api/projects/${id}`, { method: "PUT", json: proj });
      nav(`/edit/${id}`, { replace: true });
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- edits, undo, autosave ---------- */

  const update = useCallback((fn: (d: Project) => Project, record = true) => {
    setP((cur) => {
      if (!cur) return cur;
      const next = fn(structuredClone(cur));
      if (record) {
        history.current.past = [...history.current.past.slice(-80), cur];
        history.current.future = [];
      }
      return next;
    });
    setSaved("dirty");
  }, []);

  const undo = () => {
    const h = history.current;
    const prev = h.past.pop();
    if (!prev || !p) return;
    h.future.push(p);
    setP(prev);
    setSaved("dirty");
  };
  const redo = () => {
    const h = history.current;
    const nxt = h.future.pop();
    if (!nxt || !p) return;
    h.past.push(p);
    setP(nxt);
    setSaved("dirty");
  };

  useEffect(() => {
    if (saved !== "dirty" || !p) return;
    const t = setTimeout(async () => {
      setSaved("saving");
      try {
        await api(`/api/projects/${id}`, { method: "PUT", json: p });
        setSaved("saved");
      } catch {
        setSaved("dirty");
      }
    }, 900);
    return () => clearTimeout(t);
  }, [p, saved, id]);

  useLive((e) => {
    if (e.type === "render" && e.job.project_id === id) setJob(e.job);
  });

  const lay = useMemo(() => (p ? layout(p) : []), [p]);
  const total = lay.length ? lay[lay.length - 1].at + lay[lay.length - 1].len : 0;

  /* ---------- preview playback ---------- */

  const showFrame = useCallback((t: number, play = false) => {
    if (!p) return;
    const loc = locate(p, t);
    const v = video.current;
    const m = mic.current;
    if (!loc || !v) return;
    const c = clips[loc.seg.clip];
    if (!c) return;
    if (curSeg.current !== loc.seg.id || !v.src.includes(c.id)) {
      curSeg.current = loc.seg.id;
      const want = media.clip(c.id);
      if (!v.src.endsWith(want)) v.src = want;
      if (m) {
        if (c.audio_tracks >= 2) {
          const ms = `/media/audio/${c.id}/1`;
          if (!m.src.endsWith(ms)) m.src = ms;
        } else m.removeAttribute("src");
      }
    }
    const seek = () => {
      v.currentTime = loc.src;
      if (m && m.src) m.currentTime = loc.src;
    };
    if (v.readyState >= 1) seek();
    else v.addEventListener("loadedmetadata", seek, { once: true });
    v.playbackRate = loc.seg.speed;
    if (m) m.playbackRate = loc.seg.speed;
    v.muted = loc.seg.mute;
    v.volume = Math.min(1, p.audio.game);
    if (m) {
      m.muted = loc.seg.mute;
      m.volume = Math.min(1, p.audio.mic);
    }
    if (play) {
      v.play().catch(() => {});
      if (m?.src) m.play().catch(() => {});
    }
  }, [p, clips]);

  const play = () => {
    if (!p || !total) return;
    const start = T >= total - 0.05 ? 0 : T;
    setT(start);
    setPlaying(true);
    showFrame(start, true);
  };
  const pause = () => {
    setPlaying(false);
    video.current?.pause();
    mic.current?.pause();
  };

  useEffect(() => {
    if (!playing || !p) return;
    let raf = 0;
    const tick = () => {
      const v = video.current;
      const loc = locate(p, T);
      if (v && loc) {
        const t = loc.at + (v.currentTime - loc.seg.start) / loc.seg.speed;
        if (v.currentTime >= loc.seg.end - 0.02 || v.ended) {
          const nextT = loc.at + segLen(loc.seg) + 0.001;
          if (nextT >= total - 0.01) {
            pause();
            setT(total);
            return;
          }
          setT(nextT);
          showFrame(nextT, true);
        } else {
          setT(Math.max(loc.at, t));
          const m = mic.current;
          if (m?.src && Math.abs(m.currentTime - v.currentTime) > 0.1) m.currentTime = v.currentTime;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!playing) showFrame(T);
  }, [p?.segments, clips]); // eslint-disable-line react-hooks/exhaustive-deps

  const seek = (t: number) => {
    const nt = Math.max(0, Math.min(total, t));
    setT(nt);
    showFrame(nt, playing);
  };

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStageH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [p?.aspect]);

  /* ---------- keyboard ---------- */

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        if (typing) return;
        e.preventDefault();
        e.shiftKey ? redo() : undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") return (e.preventDefault(), redo());
      if (typing) return;
      if (e.key === " ") {
        e.preventDefault();
        playing ? pause() : play();
      } else if (e.key === "s") splitAt();
      else if (e.key === "t") addText();
      else if (e.key === "ArrowLeft") seek(T - (e.shiftKey ? 1 : 1 / 30));
      else if (e.key === "ArrowRight") seek(T + (e.shiftKey ? 1 : 1 / 30));
      else if ((e.key === "Delete" || e.key === "Backspace") && sel) removeSelected();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  /* ---------- actions ---------- */

  const splitAt = () => {
    if (!p) return;
    const loc = locate(p, T);
    if (!loc) return;
    const s = loc.seg;
    if (loc.src - s.start < 0.2 || s.end - loc.src < 0.2) return toast({ title: "Move the playhead inside a clip to split", error: true });
    update((d) => {
      const i = d.segments.findIndex((x) => x.id === s.id);
      const a = { ...d.segments[i], end: loc.src };
      const b = { ...d.segments[i], id: newId(), start: loc.src };
      d.segments.splice(i, 1, a, b);
      return d;
    });
  };

  const addText = () => {
    if (!p) return;
    const t: TextItem = {
      id: newId(), text: "Text", start: Math.min(T, Math.max(total - 0.5, 0)), end: Math.min(T + 3, total || 3),
      x: 0.5, y: 0.82, size: 0.08, color: "#ffffff", style: "outline", font: "bold", anim: "pop",
    };
    update((d) => ((d.texts = [...d.texts, t]), d));
    setSel({ kind: "text", id: t.id });
    setTab("text");
  };

  const removeSelected = () => {
    if (!sel) return;
    update((d) => {
      if (sel.kind === "seg") d.segments = d.segments.filter((s) => s.id !== sel.id);
      else d.texts = d.texts.filter((t) => t.id !== sel.id);
      return d;
    });
    setSel(null);
  };

  const exportIt = async () => {
    if (!p) return;
    setExportOpen(false);
    try {
      setJob(await api<RenderJob>(`/api/projects/${id}/render`, { method: "POST", json: p }));
      setSaved("saved");
    } catch (e) {
      toast({ title: "Can't export", body: (e as Error).message, error: true });
    }
  };

  if (!p) return <div className="editor"><div className="ed-stage-wrap"><div className="ed-stage skeleton" style={{ aspectRatio: "16/9" }} /></div></div>;

  const selSeg = sel?.kind === "seg" ? p.segments.find((s) => s.id === sel.id) : undefined;
  const selText = sel?.kind === "text" ? p.texts.find((t) => t.id === sel.id) : undefined;
  const loc = locate(p, T);
  const curClip = loc ? clips[loc.seg.clip] : undefined;
  const a = p.adjust;
  const filter = `brightness(${1 + a.brightness * 1.6}) contrast(${a.contrast}) saturate(${a.saturation})`;
  const fadeOpacity = Math.max(
    p.fade_in && T < p.fade_in ? 1 - T / p.fade_in : 0,
    p.fade_out && T > total - p.fade_out ? (T - (total - p.fade_out)) / p.fade_out : 0,
  );
  const ratio = ASPECT_RATIO[p.aspect];

  return (
    <div className="editor">
      <header className="ed-top">
        <button className="btn ghost icon" onClick={() => nav(-1)} aria-label="Back"><ArrowLeft /></button>
        <input className="ed-name" value={p.name} onChange={(e) => update((d) => ((d.name = e.target.value), d), false)} aria-label="Edit name" />
        <span className="ed-saved">{saved === "saved" ? "Saved" : saved === "saving" ? "Saving…" : "Edited"}</span>
        <div className="grow" />
        <button className="btn icon ghost" onClick={undo} disabled={!history.current.past.length} aria-label="Undo" title="Undo (Ctrl+Z)"><Undo2 /></button>
        <button className="btn icon ghost" onClick={redo} disabled={!history.current.future.length} aria-label="Redo" title="Redo (Ctrl+Shift+Z)"><Redo2 /></button>
        <button className="btn primary" onClick={() => setExportOpen(true)} disabled={!p.segments.length || job?.state === "running" || job?.state === "queued"}>
          <Upload />Export
        </button>
      </header>

      {job && job.state !== "canceled" && (
        <div className={`ed-job ${job.state}`}>
          {job.state === "done" ? (
            <>
              <b>Export finished</b>
              {job.clip_id && <button className="btn sm" onClick={() => nav(`/clip/${job.clip_id}`)}>Open clip</button>}
              {job.file && <a className="btn sm" href={`/media/render/${job.id}`}>Download GIF</a>}
              <button className="btn sm ghost" onClick={() => setJob(null)}>Close</button>
            </>
          ) : job.state === "error" ? (
            <>
              <b>Export failed</b><span className="err">{job.error.split("\n").slice(-1)[0]}</span>
              <button className="btn sm ghost" onClick={() => setJob(null)}>Close</button>
            </>
          ) : (
            <>
              <b>{job.state === "queued" ? "Waiting…" : `Exporting ${Math.round(job.progress * 100)}%`}</b>
              <div className="bar"><i style={{ width: `${Math.max(2, job.progress * 100)}%` }} /></div>
              <button className="btn sm ghost" onClick={() => api(`/api/renders/${job.id}`, { method: "DELETE" })}>Cancel</button>
            </>
          )}
        </div>
      )}

      <div className="ed-body">
        <div className="ed-main">
          <div className="ed-stage-wrap" onClick={() => setSel(null)}>
            <div ref={stage} className={`ed-stage fit-${p.fit}`} style={{ aspectRatio: String(ratio) }}>
              {p.fit === "blur" && curClip && <img className="ed-blurbg" src={media.thumb(curClip.id)} alt="" style={{ filter: `blur(24px) brightness(.75) ${filter}` }} />}
              <video
                ref={video}
                playsInline
                preload="auto"
                className="ed-video"
                style={{
                  filter,
                  objectFit: p.fit === "fill" ? "cover" : "contain",
                  objectPosition: `${p.pan * 100}% 50%`,
                  transform: `scale(${p.zoom})`,
                  transformOrigin: `${p.pan * 100}% 50%`,
                }}
              />
              <audio ref={mic} preload="auto" />
              {a.vignette && <div className="ed-vignette" />}
              {p.texts.map((t) => (
                <TextOverlay
                  key={t.id}
                  t={t}
                  T={T}
                  stageH={stageH}
                  stage={stage}
                  selected={sel?.id === t.id}
                  onSelect={() => {
                    setSel({ kind: "text", id: t.id });
                    setTab("text");
                  }}
                  onMove={(x, y, done) => update((d) => {
                    const it = d.texts.find((q) => q.id === t.id)!;
                    it.x = x;
                    it.y = y;
                    return d;
                  }, done)}
                />
              ))}
              {fadeOpacity > 0 && <div className="ed-fade" style={{ opacity: fadeOpacity }} />}
              {!p.segments.length && <div className="ed-empty">Add a clip to start</div>}
            </div>
          </div>

          <div className="ed-transport">
            <button className="btn icon" onClick={playing ? pause : play} aria-label={playing ? "Pause" : "Play"}>{playing ? <Pause /> : <Play />}</button>
            <span className="time">{fmtTime(T)} / {fmtTime(total)}</span>
            <div className="grow" />
            <button className="btn sm" onClick={splitAt} title="Split at playhead (S)"><Split />Split</button>
            <button className="btn sm" onClick={addText} title="Add text (T)"><Type />Text</button>
            <button className="btn sm" onClick={() => setAdding(true)}><Plus />Clip</button>
          </div>

          <Timeline
            p={p}
            clips={clips}
            T={T}
            total={total}
            sel={sel}
            onSeek={seek}
            onSelect={(s) => {
              setSel(s);
              setTab(s.kind === "seg" ? "clips" : "text");
            }}
            onTrimSeg={(sid, start, end, done) => update((d) => {
              const s = d.segments.find((x) => x.id === sid)!;
              s.start = start;
              s.end = end;
              return d;
            }, done)}
            onMoveText={(tid, start, end, done) => update((d) => {
              const t = d.texts.find((x) => x.id === tid)!;
              t.start = start;
              t.end = end;
              return d;
            }, done)}
          />
        </div>

        <aside className="ed-panel">
          <div className="ed-tabs" role="tablist">
            {([
              ["clips", <Film key="i" />, "Clips"],
              ["text", <Type key="i" />, "Text"],
              ["canvas", <Crop key="i" />, "Canvas"],
              ["color", <SlidersHorizontal key="i" />, "Color"],
              ["audio", <Music key="i" />, "Audio"],
            ] as const).map(([k, icon, label]) => (
              <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{icon}<span>{label}</span></button>
            ))}
          </div>

          <div className="ed-tabbody">
            {tab === "clips" && (
              <>
                {p.segments.map((s, i) => {
                  const c = clips[s.clip];
                  const on = sel?.id === s.id;
                  return (
                    <div key={s.id} className={`ed-seg${on ? " on" : ""}`} onClick={() => { setSel({ kind: "seg", id: s.id }); seek(lay[i].at + 0.001); }}>
                      <img src={media.thumb(s.clip)} alt="" />
                      <div className="info">
                        <b>{c?.title ?? "Clip"}</b>
                        <span>{fmtTime(s.start)}–{fmtTime(s.end)}{s.speed !== 1 && ` · ${s.speed}×`}{s.mute && " · muted"}</span>
                      </div>
                      <div className="ed-seg-btns" onClick={(e) => e.stopPropagation()}>
                        <button className="btn sm icon ghost" disabled={i === 0} onClick={() => update((d) => (d.segments.splice(i - 1, 0, d.segments.splice(i, 1)[0]), d))} aria-label="Move earlier"><ArrowUp /></button>
                        <button className="btn sm icon ghost" disabled={i === p.segments.length - 1} onClick={() => update((d) => (d.segments.splice(i + 1, 0, d.segments.splice(i, 1)[0]), d))} aria-label="Move later"><ArrowDown /></button>
                      </div>
                    </div>
                  );
                })}
                <button className="btn" style={{ width: "100%" }} onClick={() => setAdding(true)}><Plus />Add clips</button>

                {selSeg && (
                  <div className="ed-section">
                    <h4><Gauge size={15} />Speed</h4>
                    <div className="ed-speeds">
                      {SPEEDS.map((v) => (
                        <button key={v} className={`chip${selSeg.speed === v ? " on" : ""}`} onClick={() => update((d) => ((d.segments.find((x) => x.id === selSeg.id)!.speed = v), d))}>{v}×</button>
                      ))}
                    </div>
                    <div className="ed-row">
                      <span>Mute this clip</span>
                      <Toggle checked={selSeg.mute} onChange={(v) => update((d) => ((d.segments.find((x) => x.id === selSeg.id)!.mute = v), d))} />
                    </div>
                    <div className="ed-btnrow">
                      <button className="btn sm" onClick={splitAt}><Scissors />Split here</button>
                      <button className="btn sm" onClick={() => update((d) => {
                        const i = d.segments.findIndex((x) => x.id === selSeg.id);
                        d.segments.splice(i + 1, 0, { ...d.segments[i], id: newId() });
                        return d;
                      })}><Copy />Duplicate</button>
                      <button className="btn sm danger" onClick={removeSelected}><Trash2 />Remove</button>
                    </div>
                  </div>
                )}
                <div className="ed-section">
                  <h4>Between clips</h4>
                  <Seg value={p.transition} onChange={(v) => update((d) => ((d.transition = v), d))} options={[{ v: "cut", label: "Cut" }, { v: "fade", label: "Fade" }]} />
                  <Slider label="Fade in from black" value={p.fade_in} min={0} max={3} step={0.1} unit="s" onChange={(v, done) => update((d) => ((d.fade_in = v), d), done)} />
                  <Slider label="Fade out to black" value={p.fade_out} min={0} max={3} step={0.1} unit="s" onChange={(v, done) => update((d) => ((d.fade_out = v), d), done)} />
                </div>
              </>
            )}

            {tab === "text" && (
              <>
                <button className="btn primary" style={{ width: "100%" }} onClick={addText}><Plus />Add text at playhead</button>
                <div className="ed-textlist">
                  {p.texts.map((t) => (
                    <button key={t.id} className={`ed-textitem${sel?.id === t.id ? " on" : ""}`} onClick={() => { setSel({ kind: "text", id: t.id }); seek(t.start + 0.01); }}>
                      <Type size={15} /><span>{t.text || "Empty"}</span><em>{fmtTime(t.start)}</em>
                    </button>
                  ))}
                </div>
                {selText && <TextEditor t={selText} T={T} total={total} change={(fn, done = true) => update((d) => (fn(d.texts.find((x) => x.id === selText.id)!), d), done)} remove={removeSelected} />}
                {!p.texts.length && <p className="ed-hint">Add a caption, then drag it on the video to place it.</p>}
              </>
            )}

            {tab === "canvas" && (
              <>
                <div className="ed-section">
                  <h4>Shape</h4>
                  <div className="ed-aspects">
                    {(["16:9", "9:16", "1:1", "4:5"] as const).map((r) => (
                      <button key={r} className={p.aspect === r ? "on" : ""} onClick={() => update((d) => ((d.aspect = r), r === "9:16" && d.fit === "fill" && (d.fit = "blur"), d))}>
                        <i style={{ aspectRatio: String(ASPECT_RATIO[r]) }} />
                        <span>{r}</span>
                        <em>{{ "16:9": "YouTube", "9:16": "TikTok · Shorts", "1:1": "Square", "4:5": "Instagram" }[r]}</em>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="ed-section">
                  <h4>Fit</h4>
                  <Seg value={p.fit} onChange={(v) => update((d) => ((d.fit = v), d))} options={[{ v: "fill", label: "Crop to fill" }, { v: "blur", label: "Blur behind" }, { v: "bars", label: "Black bars" }]} />
                  <Slider label="Zoom" value={p.zoom} min={1} max={3} step={0.05} unit="×" onChange={(v, done) => update((d) => ((d.zoom = v), d), done)} />
                  <Slider label="Left ↔ right" value={p.pan} min={0} max={1} step={0.01} fmt={(v) => (v < 0.4 ? "Left" : v > 0.6 ? "Right" : "Center")} onChange={(v, done) => update((d) => ((d.pan = v), d), done)} />
                </div>
              </>
            )}

            {tab === "color" && (
              <>
                <div className="ed-section">
                  <h4>Looks</h4>
                  <div className="ed-looks">
                    {LOOKS.map((l) => (
                      <button key={l.name} className={JSON.stringify(l.adjust) === JSON.stringify(p.adjust) ? "on" : ""} onClick={() => update((d) => ((d.adjust = { ...l.adjust }), d))}>
                        <span style={{ filter: `brightness(${1 + l.adjust.brightness * 1.6}) contrast(${l.adjust.contrast}) saturate(${l.adjust.saturation})`, backgroundImage: curClip ? `url(${media.thumb(curClip.id)})` : undefined }} />
                        {l.name}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="ed-section">
                  <h4>Adjust</h4>
                  <Slider label="Brightness" value={a.brightness} min={-0.5} max={0.5} step={0.01} fmt={(v) => `${v > 0 ? "+" : ""}${Math.round(v * 100)}`} onChange={(v, done) => update((d) => ((d.adjust.brightness = v), d), done)} />
                  <Slider label="Contrast" value={a.contrast} min={0.5} max={2} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v, done) => update((d) => ((d.adjust.contrast = v), d), done)} />
                  <Slider label="Saturation" value={a.saturation} min={0} max={3} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v, done) => update((d) => ((d.adjust.saturation = v), d), done)} />
                  <div className="ed-row"><span>Vignette</span><Toggle checked={a.vignette} onChange={(v) => update((d) => ((d.adjust.vignette = v), d))} /></div>
                  <div className="ed-row"><span>Sharpen</span><Toggle checked={a.sharpen} onChange={(v) => update((d) => ((d.adjust.sharpen = v), d))} /></div>
                </div>
              </>
            )}

            {tab === "audio" && (
              <div className="ed-section">
                <h4><Volume2 size={15} />Mix</h4>
                <Slider label="Game" value={p.audio.game} min={0} max={2} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v, done) => update((d) => ((d.audio.game = v), d), done)} />
                <Slider label="Mic" value={p.audio.mic} min={0} max={2} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v, done) => update((d) => ((d.audio.mic = v), d), done)} />
                <Slider label="Fade in" value={p.audio.fade_in} min={0} max={5} step={0.1} unit="s" onChange={(v, done) => update((d) => ((d.audio.fade_in = v), d), done)} />
                <Slider label="Fade out" value={p.audio.fade_out} min={0} max={5} step={0.1} unit="s" onChange={(v, done) => update((d) => ((d.audio.fade_out = v), d), done)} />
                <p className="ed-hint"><VolumeX size={13} /> To silence one clip, pick it in Clips and turn on Mute.</p>
              </div>
            )}
          </div>
        </aside>
      </div>

      {adding && (
        <ClipPicker
          onClose={() => setAdding(false)}
          onPick={async (picked) => {
            setAdding(false);
            setClips((m) => ({ ...m, ...Object.fromEntries(picked.map((c) => [c.id, c])) }));
            update((d) => {
              d.segments.push(...picked.map((c) => ({ id: newId(), clip: c.id, start: c.trim_start ?? 0, end: c.trim_end ?? c.duration, speed: 1, mute: false })));
              return d;
            });
          }}
        />
      )}
      {exportOpen && <ExportModal p={p} total={total} onChange={(o) => update((d) => ((d.output = { ...d.output, ...o }), d))} onClose={() => setExportOpen(false)} onExport={exportIt} />}
    </div>
  );
}

/* ---------- pieces ---------- */

function Slider({ label, value, min, max, step, unit, fmt, onChange }: {
  label: string; value: number; min: number; max: number; step: number; unit?: string;
  fmt?: (v: number) => string; onChange: (v: number, done: boolean) => void;
}) {
  const start = useRef<number | null>(null);
  return (
    <div className="ed-slider"
      onPointerDown={() => (start.current = value)}
      onPointerUp={() => { if (start.current !== null && start.current !== value) onChange(value, true); start.current = null; }}>
      <div className="lbl"><span>{label}</span><b>{fmt ? fmt(value) : `${Number(value.toFixed(2))}${unit ?? ""}`}</b></div>
      <Range label={label} value={value} min={min} max={max} step={step} onChange={(v) => onChange(v, start.current === null)} />
    </div>
  );
}

function TextOverlay({ t, T, stageH, stage, selected, onSelect, onMove }: {
  t: TextItem; T: number; stageH: number; stage: React.RefObject<HTMLDivElement>; selected: boolean;
  onSelect: () => void; onMove: (x: number, y: number, done: boolean) => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const drag = useRef<{ dx: number; dy: number; moved: boolean } | null>(null);
  const visible = T >= t.start && T <= t.end;
  if (!visible && !selected) return null;
  let opacity = visible ? 1 : 0.35;
  let lift = 0;
  if (visible && t.anim !== "none") {
    opacity = Math.min(1, (T - t.start) / 0.2, (t.end - T) / 0.2);
    if (t.anim === "pop" && T - t.start < 0.25) lift = (1 - (T - t.start) / 0.25) * t.size * stageH * 0.4;
  }
  const fs = t.size * stageH;
  const style: React.CSSProperties = {
    left: `${t.x * 100}%`,
    top: `${t.y * 100}%`,
    transform: `translate(${-t.x * 100}%, calc(${-t.y * 100}% + ${lift}px))`,
    fontSize: fs,
    color: t.color,
    opacity: Math.max(0, opacity),
    textAlign: t.x < 0.34 ? "left" : t.x > 0.66 ? "right" : "center",
  };
  if (t.style === "outline") style.WebkitTextStroke = `${Math.max(2, fs / 14) * 2}px rgba(0,0,0,.9)`;
  if (t.style === "shadow") style.textShadow = `${Math.max(2, fs / 18)}px ${Math.max(2, fs / 18)}px 0 rgba(0,0,0,.7)`;
  if (t.style === "box") Object.assign(style, { background: "rgba(0,0,0,.6)", padding: `${Math.max(6, fs / 3) * 0.5}px ${Math.max(6, fs / 3)}px` });

  const down = (e: React.PointerEvent) => {
    e.stopPropagation();
    onSelect();
    const r = el.current!.getBoundingClientRect();
    drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false };
    el.current!.setPointerCapture(e.pointerId);
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !stage.current || !el.current) return;
    const s = stage.current.getBoundingClientRect();
    const w = el.current.offsetWidth;
    const h = el.current.offsetHeight;
    const x = (e.clientX - d.dx - s.left) / Math.max(1, s.width - w);
    const y = (e.clientY - d.dy - s.top) / Math.max(1, s.height - h);
    onMove(Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y)), !d.moved);
    d.moved = true;
  };
  return (
    <div
      ref={el}
      className={`ed-text f-${t.font}${selected ? " sel" : ""}${t.style === "outline" ? " outline" : ""}`}
      style={style}
      data-text={t.text}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={() => (drag.current = null)}
      onClick={(e) => e.stopPropagation()}
    >
      {t.text}
    </div>
  );
}

function TextEditor({ t, T, total, change, remove }: { t: TextItem; T: number; total: number; change: (fn: (x: TextItem) => void, done?: boolean) => void; remove: () => void }) {
  return (
    <div className="ed-section">
      <textarea className="input" rows={2} value={t.text} onChange={(e) => change((x) => (x.text = e.target.value), false)} placeholder="Type something" />
      <p className="ed-hint">Emoji aren't drawn in exports.</p>
      <h4>Font</h4>
      <div className="ed-fonts">
        {FONTS.map((f) => (
          <button key={f.key} className={`f-${f.key}${t.font === f.key ? " on" : ""}`} onClick={() => change((x) => (x.font = f.key))}>{f.label}</button>
        ))}
      </div>
      <h4>Color</h4>
      <div className="ed-colors">
        {COLORS.map((c) => (
          <button key={c} className={t.color === c ? "on" : ""} style={{ background: c }} onClick={() => change((x) => (x.color = c))} aria-label={c} />
        ))}
        <label className="ed-colorpick" style={{ background: COLORS.includes(t.color) ? undefined : t.color }}>
          <input type="color" value={t.color} onChange={(e) => change((x) => (x.color = e.target.value), false)} />
        </label>
      </div>
      <h4>Style</h4>
      <Seg value={t.style} onChange={(v) => change((x) => (x.style = v))} options={[{ v: "outline", label: "Outline" }, { v: "box", label: "Box" }, { v: "shadow", label: "Shadow" }, { v: "none", label: "Plain" }]} />
      <h4>Animation</h4>
      <Seg value={t.anim} onChange={(v) => change((x) => (x.anim = v))} options={[{ v: "pop", label: "Pop up" }, { v: "fade", label: "Fade" }, { v: "none", label: "None" }]} />
      <Slider label="Size" value={t.size} min={0.03} max={0.2} step={0.005} fmt={(v) => `${Math.round(v * 100)}`} onChange={(v, done) => change((x) => (x.size = v), done)} />
      <div className="ed-btnrow">
        <button className="btn sm" onClick={() => change((x) => (x.start = Math.min(T, x.end - 0.2)))}>Start at playhead</button>
        <button className="btn sm" onClick={() => change((x) => (x.end = Math.max(T, x.start + 0.2)))}>End at playhead</button>
      </div>
      <div className="ed-btnrow">
        <button className="btn sm" onClick={() => change((x) => { x.start = 0; x.end = total; })}>Whole video</button>
        <button className="btn sm" onClick={() => change((x) => { x.x = 0.5; x.y = 0.5; })}>Center</button>
        <button className="btn sm danger" onClick={remove}><Trash2 />Delete</button>
      </div>
      <p className="ed-hint">{fmtTime(t.start)} – {fmtTime(t.end)} · drag the text on the video to move it, or its bar on the timeline to retime it.</p>
    </div>
  );
}

function Timeline({ p, clips, T, total, sel, onSeek, onSelect, onTrimSeg, onMoveText }: {
  p: Project; clips: Record<string, Clip>; T: number; total: number; sel: { kind: "seg" | "text"; id: string } | null;
  onSeek: (t: number) => void; onSelect: (s: { kind: "seg" | "text"; id: string }) => void;
  onTrimSeg: (id: string, start: number, end: number, done: boolean) => void;
  onMoveText: (id: string, start: number, end: number, done: boolean) => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const drag = useRef<null | { kind: string; id: string; x0: number; a: number; b: number; first: boolean }>(null);
  const lay = layout(p);
  const pxPerSec = () => (el.current ? (el.current.clientWidth * zoom) / Math.max(total, 1) : 50);
  const timeAt = (clientX: number) => {
    const r = el.current!.getBoundingClientRect();
    return ((clientX - r.left + el.current!.scrollLeft) / (r.width * zoom)) * total;
  };
  const pct = (t: number) => `${(t / Math.max(total, 0.001)) * 100}%`;

  const begin = (e: React.PointerEvent, kind: string, id: string, a: number, b: number) => {
    e.stopPropagation();
    drag.current = { kind, id, x0: e.clientX, a, b, first: true };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const moveDrag = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dt = (e.clientX - d.x0) / pxPerSec();
    const first = d.first;
    d.first = false;
    if (d.kind === "segL" || d.kind === "segR") {
      const s = p.segments.find((x) => x.id === d.id)!;
      const c = clips[s.clip];
      const max = c?.duration ?? s.end;
      if (d.kind === "segL") onTrimSeg(d.id, Math.max(0, Math.min(d.a + dt * s.speed, s.end - 0.2)), s.end, first);
      else onTrimSeg(d.id, s.start, Math.min(max, Math.max(d.b + dt * s.speed, s.start + 0.2)), first);
    } else if (d.kind === "text") {
      const len = d.b - d.a;
      const a = Math.max(0, Math.min(total - len, d.a + dt));
      onMoveText(d.id, a, a + len, first);
    } else if (d.kind === "textL") {
      onMoveText(d.id, Math.max(0, Math.min(d.a + dt, d.b - 0.2)), d.b, first);
    } else if (d.kind === "textR") {
      onMoveText(d.id, d.a, Math.min(total, Math.max(d.b + dt, d.a + 0.2)), first);
    } else if (d.kind === "seek") {
      onSeek(timeAt(e.clientX));
    }
  };
  const end = () => (drag.current = null);

  return (
    <div className="ed-timeline-wrap">
      <div className="ed-zoom">
        <button className="btn sm ghost" onClick={() => setZoom((z) => Math.max(1, z / 1.5))} aria-label="Zoom out">−</button>
        <button className="btn sm ghost" onClick={() => setZoom((z) => Math.min(12, z * 1.5))} aria-label="Zoom in">+</button>
      </div>
      <div
        ref={el}
        className="ed-timeline"
        onPointerDown={(e) => { drag.current = { kind: "seek", id: "", x0: e.clientX, a: 0, b: 0, first: true }; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); onSeek(timeAt(e.clientX)); }}
        onPointerMove={moveDrag}
        onPointerUp={end}
        onPointerCancel={end}
      >
        <div className="ed-tracks" style={{ width: `${zoom * 100}%` }}>
          <div className="ed-ruler">
            {Array.from({ length: Math.ceil(total) + 1 }, (_, i) => i).filter((i) => i % Math.max(1, Math.round(4 / zoom)) === 0).map((i) => (
              <span key={i} style={{ left: pct(i) }}>{i}s</span>
            ))}
          </div>
          <div className="ed-track segs">
            {lay.map(({ seg, at, len }) => (
              <div
                key={seg.id}
                className={`ed-block${sel?.id === seg.id ? " on" : ""}`}
                style={{ left: pct(at), width: pct(len), backgroundImage: `url(/media/strip/${seg.clip})` }}
                onPointerDown={(e) => { e.stopPropagation(); onSelect({ kind: "seg", id: seg.id }); onSeek(timeAt(e.clientX)); }}
              >
                {seg.speed !== 1 && <span className="ed-speedtag">{seg.speed}×</span>}
                <i className="h l" onPointerDown={(e) => { onSelect({ kind: "seg", id: seg.id }); begin(e, "segL", seg.id, seg.start, seg.end); }} />
                <i className="h r" onPointerDown={(e) => { onSelect({ kind: "seg", id: seg.id }); begin(e, "segR", seg.id, seg.start, seg.end); }} />
              </div>
            ))}
          </div>
          <div className="ed-track texts">
            {p.texts.map((t) => (
              <div
                key={t.id}
                className={`ed-tbar${sel?.id === t.id ? " on" : ""}`}
                style={{ left: pct(t.start), width: pct(Math.max(0.1, t.end - t.start)) }}
                onPointerDown={(e) => { onSelect({ kind: "text", id: t.id }); begin(e, "text", t.id, t.start, t.end); }}
              >
                <i className="h l" onPointerDown={(e) => { onSelect({ kind: "text", id: t.id }); begin(e, "textL", t.id, t.start, t.end); }} />
                <span>{t.text}</span>
                <i className="h r" onPointerDown={(e) => { onSelect({ kind: "text", id: t.id }); begin(e, "textR", t.id, t.start, t.end); }} />
              </div>
            ))}
          </div>
          <div className="ed-playhead" style={{ left: pct(T) }} />
        </div>
      </div>
    </div>
  );
}

function ClipPicker({ onPick, onClose }: { onPick: (c: Clip[]) => void; onClose: () => void }) {
  const [list, setList] = useState<Clip[] | null>(null);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => {
    api<Clip[]>(`/api/clips?limit=300${q ? `&q=${encodeURIComponent(q)}` : ""}`).then(setList);
  }, [q]);
  return (
    <Modal onClose={onClose}>
      <h3>Add clips</h3>
      <input className="input" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} style={{ margin: "10px 0" }} />
      <div className="ed-picker">
        {list?.map((c) => (
          <button key={c.id} className={picked.includes(c.id) ? "on" : ""} onClick={() => setPicked((p) => (p.includes(c.id) ? p.filter((x) => x !== c.id) : [...p, c.id]))}>
            <img src={media.thumb(c.id)} alt="" loading="lazy" />
            <span>{c.title}</span>
            {picked.includes(c.id) && <b>{picked.indexOf(c.id) + 1}</b>}
          </button>
        ))}
      </div>
      <div className="acts">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!picked.length} onClick={() => onPick(picked.map((id) => list!.find((c) => c.id === id)!))}>Add {picked.length || ""}</button>
      </div>
    </Modal>
  );
}

function ExportModal({ p, total, onChange, onClose, onExport }: {
  p: Project; total: number; onChange: (o: Partial<Project["output"]>) => void; onClose: () => void; onExport: () => void;
}) {
  const o = p.output;
  const mbps = o.format === "gif" ? 8 : { high: 10, medium: 6, small: 3 }[o.quality] * (o.height / 1080) * (o.fps / 60 + 0.4);
  const est = (mbps / 8) * total;
  return (
    <Modal onClose={onClose}>
      <h3>Export</h3>
      <p>{fmtTime(total)} long. Saved as a new clip in your library{o.format === "gif" ? " (GIFs download instead)" : ""}.</p>
      <div className="ed-export">
        <label>Format</label>
        <Seg value={o.format} onChange={(v) => onChange({ format: v })} options={[{ v: "mp4", label: "Video" }, { v: "gif", label: "GIF" }]} />
        {o.format === "mp4" && (
          <>
            <label>Resolution</label>
            <Seg value={o.height} onChange={(v) => onChange({ height: v })} options={[{ v: 1440, label: "1440p" }, { v: 1080, label: "1080p" }, { v: 720, label: "720p" }, { v: 480, label: "480p" }]} />
            <label>Frame rate</label>
            <Seg value={o.fps} onChange={(v) => onChange({ fps: v })} options={[{ v: 60, label: "60" }, { v: 30, label: "30" }, { v: 24, label: "24" }]} />
            <label>Quality</label>
            <Seg value={o.quality} onChange={(v) => onChange({ quality: v })} options={[{ v: "high", label: "High" }, { v: "medium", label: "Medium" }, { v: "small", label: "Small file" }]} />
          </>
        )}
        <label>Speed</label>
        <div className="ed-row" style={{ margin: 0 }}>
          <span style={{ fontSize: 13, color: "var(--text-2)" }}>Faster export (uses more CPU, can lag games)</span>
          <Toggle checked={o.fast} onChange={(v) => onChange({ fast: v })} />
        </div>
      </div>
      <p className="ed-hint" style={{ marginTop: 14 }}>About {est < 1 ? "<1" : Math.round(est)} MB.</p>
      <div className="acts">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={onExport}><Upload />Export</button>
      </div>
    </Modal>
  );
}
