import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { Info, Keyboard, LogOut, RefreshCw, ShieldAlert, Volume2 } from "lucide-react";
import qrcode from "qrcode-generator";
import { api, fmtSize, Options, Settings as S, useFetch } from "../api";
import { RecPill, useApp } from "../components/Layout";
import { Range, Seg, Toggle, useToast } from "../components/ui";

type Patch = { [K in keyof S]?: Partial<S[K]> } | Partial<S>;

const NAV = [
  ["recording", "Recording"],
  ["audio", "Audio"],
  ["hotkeys", "Hotkeys"],
  ["voice", "Voice clipping"],
  ["auto", "Auto clips"],
  ["feedback", "Sounds & alerts"],
  ["storage", "Storage"],
  ["phone", "Phone"],
  ["sharing", "Sharing"],
] as const;

function Row({ title, desc, children, wide }: { title: string; desc?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className="srow">
      <div className="txt">
        <b>{title}</b>
        {desc && <span>{desc}</span>}
      </div>
      <div className={`ctl${wide ? " wide" : ""}`}>{children}</div>
    </div>
  );
}

function Group({ id, title, lead, children }: { id: string; title: string; lead?: ReactNode; children: ReactNode }) {
  return (
    <section className="group" id={id}>
      <h2>{title}</h2>
      {lead && <p className="lead">{lead}</p>}
      {children}
    </section>
  );
}

function TextSetting({ value, onSave, placeholder, type = "text" }: { value: string; onSave: (v: string) => void; placeholder?: string; type?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      className="input"
      type={type}
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onSave(v)}
      onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
    />
  );
}

export function Settings() {
  const { status } = useApp();
  const toast = useToast();
  const loc = useLocation();
  const { data: s, setData } = useFetch<S>("/api/settings");
  const { data: opts, reload: reloadOpts } = useFetch<Options>("/api/options");
  const [level, setLevel] = useState(-90);
  const saveTimer = useRef<number>();
  const pending = useRef<Patch>({});

  useEffect(() => {
    if (!s || !loc.hash) return;
    document.getElementById(loc.hash.slice(1))?.scrollIntoView({ block: "start" });
  }, [s, loc.hash]);

  // Live mic level for the voice/auto-clip meters.
  useEffect(() => {
    const t = setInterval(() => api<{ level_db: number }>("/api/level").then((r) => setLevel(r.level_db)).catch(() => {}), 250);
    return () => clearInterval(t);
  }, []);

  const set = (patch: Patch) => {
    if (!s) return;
    const next = structuredClone(s) as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(patch)) {
      next[k] = typeof v === "object" && v !== null ? { ...(next[k] as object), ...v } : v;
      const p = pending.current as Record<string, unknown>;
      p[k] = typeof v === "object" && v !== null ? { ...((p[k] as object) || {}), ...v } : v;
    }
    setData(next as unknown as S);
    clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      const body = pending.current;
      pending.current = {};
      try {
        setData(await api<S>("/api/settings", { method: "PUT", json: body }));
        if ("hotkeys" in body) {
          await api("/api/hotkeys/apply", { method: "POST" }).then(
            () => toast({ title: "Hotkeys updated", icon: <Keyboard /> }),
            (e) => toast({ title: "Couldn't set hotkeys", body: String(e.message), error: true }),
          );
        }
      } catch (e) {
        toast({ title: "Couldn't save setting", body: String((e as Error).message), error: true });
      }
    }, 450);
  };

  const qr = useMemo(() => {
    if (!status?.lan_url) return "";
    const q = qrcode(0, "M");
    q.addData(status.lan_url);
    q.make();
    return q.createDataURL(4, 0);
  }, [status?.lan_url]);

  if (!s) return <div className="page"><div className="head"><h1>Settings</h1></div></div>;
  const r = s.recorder;
  const rec = status?.recorder;
  const lis = status?.listener;
  const meterPct = Math.max(0, Math.min(100, ((level + 60) / 60) * 100));
  const thrPct = Math.max(0, Math.min(100, ((s.hype.threshold_db + 60) / 60) * 100));
  // RAM use of the buffer: roughly the video bitrate times the buffer length.
  const mbps = { low: 4, medium: 7, high: 12, very_high: 20 }[r.quality] ?? 12;
  const bufMb = Math.round((mbps / 8) * r.replay_seconds * (r.fps / 60) * (r.resolution === "native" ? 1 : 0.5));

  return (
    <div className="page">
      <div className="head">
        <div>
          <h1>Settings</h1>
          <div className="sub">Changes save as you go.</div>
        </div>
        <div className="actions mobile-only"><RecPill status={status} /></div>
      </div>
      <div className="settings">
        <nav className="settings-nav">
          {NAV.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}
        </nav>
        <div>
          <Group id="recording" title="Recording" lead="Clipdeck keeps the last few minutes in a buffer and only saves when you clip.">
            {rec?.state === "error" && (
              <div className="note"><ShieldAlert /><div><b>Replay stopped.</b> {rec.error}</div></div>
            )}
            <div className="note info"><Info /><div>Video is encoded on the CPU (x264). The graphics card's own encoder froze this PC, so it's never used.</div></div>
            <div className="rows">
              <Row title="Replay buffer" desc={rec?.state === "recording" ? "Recording into memory now." : rec?.state === "starting" ? "Starting…" : "Off. Nothing is being recorded."}>
                <button className="btn sm ghost" onClick={() => api("/api/recorder/restart", { method: "POST" })} title="Restart recorder"><RefreshCw /></button>
                <Toggle label="Replay buffer" checked={r.enabled} onChange={(v) => set({ recorder: { enabled: v } })} />
              </Row>
              <Row title="Only while playing" desc="Turns the buffer on when a game starts and off when it closes. Saves CPU on the desktop.">
                <Toggle label="Only while playing" checked={r.only_while_gaming} onChange={(v) => set({ recorder: { only_while_gaming: v } })} />
              </Row>
              <Row title="Buffer length" desc={`How far back you can save. About ${bufMb >= 1000 ? (bufMb / 1000).toFixed(1) + " GB" : bufMb + " MB"} of RAM.`} wide>
                <Range label="Buffer length" value={r.replay_seconds} min={15} max={300} step={15} onChange={(v) => set({ recorder: { replay_seconds: v, default_clip_seconds: Math.min(r.default_clip_seconds, v) } })} />
                <span className="val">{r.replay_seconds < 60 ? `${r.replay_seconds}s` : `${(r.replay_seconds / 60).toFixed(r.replay_seconds % 60 ? 1 : 0)} min`}</span>
              </Row>
              <Row title="Clip length" desc="What a normal clip saves. The long-clip hotkey saves the whole buffer." wide>
                <Range label="Clip length" value={r.default_clip_seconds} min={5} max={r.replay_seconds} step={5} onChange={(v) => set({ recorder: { default_clip_seconds: v } })} />
                <span className="val">{r.default_clip_seconds}s</span>
              </Row>
              <Row title="Screen">
                <select className="select" value={r.monitor} onChange={(e) => set({ recorder: { monitor: e.target.value } })}>
                  {(opts?.monitors.length ? opts.monitors : [{ id: r.monitor, label: r.monitor }]).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
              </Row>
              <Row title="Resolution">
                <Seg value={r.resolution} onChange={(v) => set({ recorder: { resolution: v } })} options={[{ v: "native", label: "Native" }, { v: "1280x720", label: "720p" }]} />
              </Row>
              <Row title="Frame rate">
                <Seg value={r.fps} onChange={(v) => set({ recorder: { fps: v } })} options={[30, 60].map((v) => ({ v, label: `${v} fps` }))} />
              </Row>
              <Row title="Quality" desc="Higher looks better and makes bigger files. Same CPU cost.">
                <Seg value={r.quality} onChange={(v) => set({ recorder: { quality: v } })} options={[{ v: "medium", label: "Medium" }, { v: "high", label: "High" }, { v: "very_high", label: "Max" }]} />
              </Row>
              <Row title="Show mouse cursor">
                <Toggle label="Show mouse cursor" checked={r.show_cursor} onChange={(v) => set({ recorder: { show_cursor: v } })} />
              </Row>
              <Row title="Keep buffer in" desc="Memory is fastest. Disk uses less RAM but writes constantly.">
                <Seg value={r.replay_storage} onChange={(v) => set({ recorder: { replay_storage: v } })} options={[{ v: "ram", label: "Memory" }, { v: "disk", label: "Disk" }]} />
              </Row>
              <Row title="Recorder priority" desc="Higher numbers give games more CPU and can drop recording frames when the CPU is maxed." wide>
                <Range label="Recorder priority" value={r.nice} min={0} max={15} onChange={(v) => set({ recorder: { nice: v } })} />
                <span className="val">{r.nice}</span>
              </Row>
            </div>
          </Group>

          <Group id="audio" title="Audio" lead="Game sound and your mic are saved as separate tracks, so you can turn your voice down later.">
            <div className="rows">
              <Row title="Record game audio">
                <Toggle label="Record game audio" checked={r.record_game_audio} onChange={(v) => set({ recorder: { record_game_audio: v } })} />
              </Row>
              <Row title="Game audio from" wide>
                <select className="select" value={r.game_audio_device} onChange={(e) => set({ recorder: { game_audio_device: e.target.value } })}>
                  {(opts?.outputs ?? [{ id: r.game_audio_device, label: r.game_audio_device }]).map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                </select>
              </Row>
              <Row title="Record mic">
                <Toggle label="Record mic" checked={r.record_mic} onChange={(v) => set({ recorder: { record_mic: v } })} />
              </Row>
              <Row title="Microphone" wide>
                <select className="select" value={r.mic_device} onChange={(e) => set({ recorder: { mic_device: e.target.value } })}>
                  {(opts?.inputs ?? [{ id: r.mic_device, label: r.mic_device }]).map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                </select>
                <button className="btn sm icon ghost" onClick={() => reloadOpts()} title="Refresh devices"><RefreshCw /></button>
              </Row>
            </div>
          </Group>

          <Group id="hotkeys" title="Hotkeys" lead="Work everywhere, even in fullscreen games. Set through COSMIC's keyboard shortcuts.">
            <div className="rows">
              <Row title="Save clip" desc={`Saves the last ${r.default_clip_seconds} seconds.`}>
                <HotkeyInput value={s.hotkeys.clip} onChange={(v) => set({ hotkeys: { clip: v } })} />
              </Row>
              <Row title="Save long clip" desc={`Saves the whole ${r.replay_seconds}s buffer.`}>
                <HotkeyInput value={s.hotkeys.clip_long} onChange={(v) => set({ hotkeys: { clip_long: v } })} />
              </Row>
            </div>
          </Group>

          <Group id="voice" title="Voice clipping" lead={<>Say the phrase and Clipdeck saves a clip. Runs fully offline; audio never leaves your PC.</>}>
            {lis?.state === "error" && <div className="note"><ShieldAlert /><div>{lis.error}</div></div>}
            <div className="rows">
              <Row title="Voice clipping" desc={lis?.state === "listening" ? (lis.last_heard ? `Listening. Last heard “${lis.last_heard}”.` : "Listening.") : "Off."}>
                <Toggle label="Voice clipping" checked={s.voice.enabled} onChange={(v) => set({ voice: { enabled: v } })} />
              </Row>
              <Row title="Phrase" desc="Separate a few with commas, e.g. “clip that, clip it”. Common English words work best." wide>
                <TextSetting value={s.voice.phrase} onSave={(v) => set({ voice: { phrase: v } })} placeholder="clip that" />
              </Row>
              <Row title="Strictness" desc="Raise it if it clips when you didn't say it. Lower it if it misses you." wide>
                <Range label="Strictness" value={s.voice.confidence} min={0.4} max={0.98} step={0.02} onChange={(v) => set({ voice: { confidence: v } })} />
                <span className="val">{Math.round(s.voice.confidence * 100)}%</span>
              </Row>
              <Row title="Mic level" wide>
                <div className="meter"><i style={{ width: `${meterPct}%` }} /></div>
              </Row>
            </div>
          </Group>

          <Group id="auto" title="Auto clips" lead="Saves a clip a few seconds after you get loud: yelling, cheering, losing it at something.">
            <div className="rows">
              <Row title="Auto clip loud moments">
                <Toggle label="Auto clip loud moments" checked={s.hype.enabled} onChange={(v) => set({ hype: { enabled: v } })} />
              </Row>
              <Row title="How loud" desc="Clips when your mic goes past the orange line. Talk normally and keep the green bar under it." wide>
                <div style={{ width: "100%" }}>
                  <div className="meter" style={{ marginBottom: 8 }}><i style={{ width: `${meterPct}%`, background: level >= s.hype.threshold_db ? "var(--accent)" : undefined }} /><b style={{ left: `${thrPct}%` }} /></div>
                  <Range label="Loudness threshold" value={s.hype.threshold_db} min={-45} max={-3} step={1} onChange={(v) => set({ hype: { threshold_db: v } })} />
                </div>
                <span className="val">{s.hype.threshold_db} dB</span>
              </Row>
              <Row title="For at least" wide>
                <Range label="Minimum loud time" value={s.hype.min_ms} min={100} max={2000} step={50} onChange={(v) => set({ hype: { min_ms: v } })} />
                <span className="val">{(s.hype.min_ms / 1000).toFixed(2)}s</span>
              </Row>
              <Row title="Wait between auto clips" wide>
                <Range label="Cooldown" value={s.hype.cooldown_s} min={5} max={180} step={5} onChange={(v) => set({ hype: { cooldown_s: v } })} />
                <span className="val">{s.hype.cooldown_s}s</span>
              </Row>
            </div>
          </Group>

          <Group id="feedback" title="Sounds & alerts">
            <div className="rows">
              <Row title="Play a sound when a clip saves">
                <button className="btn sm ghost" onClick={() => api("/api/test-sound", { method: "POST" })}><Volume2 />Test</button>
                <Toggle label="Clip sound" checked={s.feedback.sound} onChange={(v) => set({ feedback: { sound: v } })} />
              </Row>
              <Row title="Sound volume" wide>
                <Range label="Sound volume" value={s.feedback.volume} min={0.1} max={1} step={0.05} onChange={(v) => set({ feedback: { volume: v } })} />
                <span className="val">{Math.round(s.feedback.volume * 100)}%</span>
              </Row>
              <Row title="Desktop notification" desc="Shows the clip's thumbnail when it's saved.">
                <Toggle label="Desktop notification" checked={s.feedback.notification} onChange={(v) => set({ feedback: { notification: v } })} />
              </Row>
            </div>
          </Group>

          <Group id="storage" title="Storage" lead={status ? `${status.stats.clips} clips using ${fmtSize(status.stats.size)}${status.disk ? `, ${fmtSize(status.disk.free)} free on the drive` : ""}.` : undefined}>
            <div className="rows">
              <Row title="Clips folder" desc="Clips are sorted into a folder per game." wide>
                <TextSetting value={s.clips_dir} onSave={(v) => set({ clips_dir: v })} />
              </Row>
              <Row title="Limit library size" desc="0 means no limit." wide>
                <Range label="Library size limit" value={s.storage.max_gb} min={0} max={500} step={5} onChange={(v) => set({ storage: { max_gb: v } })} />
                <span className="val">{s.storage.max_gb ? `${s.storage.max_gb} GB` : "None"}</span>
              </Row>
              <Row title="Clean up automatically" desc="When over the limit, the oldest clips go to trash. Favorites are never touched.">
                <Toggle label="Clean up automatically" checked={s.storage.auto_clean} onChange={(v) => set({ storage: { auto_clean: v } })} />
              </Row>
              <Row title="Empty trash after" wide>
                <Range label="Trash days" value={s.storage.trash_days} min={0} max={90} step={1} onChange={(v) => set({ storage: { trash_days: v } })} />
                <span className="val">{s.storage.trash_days ? `${s.storage.trash_days} days` : "Never"}</span>
              </Row>
            </div>
          </Group>

          <Group id="phone" title="Phone" lead="Open your library on your phone while it's on the same Wi-Fi. Add it to your home screen and it works like an app.">
            <div className="rows">
              <Row title="Allow other devices" desc="Off = only this PC can open the library. Takes effect after a restart of Clipdeck.">
                <Toggle label="Allow other devices" checked={s.server.lan} onChange={(v) => set({ server: { lan: v } })} />
              </Row>
              {s.server.lan && status && (
                <div className="srow" style={{ alignItems: "flex-start" }}>
                  {qr && <img className="qr" src={qr} alt="QR code for the phone address" />}
                  <div className="txt">
                    <b>Scan with your phone camera</b>
                    <span style={{ marginTop: 6 }}>or open <b style={{ display: "inline", userSelect: "all" }}>{status.lan_url}</b></span>
                    <span style={{ marginTop: 14 }}>Passcode</span>
                    <div className="code" style={{ marginTop: 2 }}>{s.server.passcode}</div>
                    <span style={{ marginTop: 12 }}>iPhone: tap Share, then “Add to Home Screen”. Android: menu, then “Install app”.</span>
                  </div>
                </div>
              )}
              <Row title="New passcode" desc="Signs every phone out.">
                <button className="btn sm" onClick={async () => setData(await api<S>("/api/settings/passcode", { method: "POST" }))}>Change passcode</button>
              </Row>
              <Row title="Sign out this device">
                <button className="btn sm ghost" onClick={async () => { await api("/api/logout", { method: "POST" }); location.reload(); }}><LogOut />Sign out</button>
              </Row>
            </div>
          </Group>

          <Group id="sharing" title="Sharing" lead="Share links work on your Wi-Fi only. To send a clip to friends anywhere, use Discord or your phone's share button.">
            <div className="rows">
              <Row title="Discord webhook" desc="Channel settings → Integrations → Webhooks → New Webhook → Copy URL." wide>
                <TextSetting type="password" value={s.share.discord_webhook} onSave={(v) => set({ share: { discord_webhook: v.trim() } })} placeholder="https://discord.com/api/webhooks/…" />
              </Row>
            </div>
          </Group>
        </div>
      </div>
    </div>
  );
}

const MODS = ["Control", "Shift", "Alt", "Super"];

function HotkeyInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [listening, setListening] = useState(false);
  useEffect(() => {
    if (!listening) return;
    const k = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return setListening(false);
      if (e.key === "Backspace" || e.key === "Delete") {
        onChange("");
        return setListening(false);
      }
      if (["Control", "Shift", "Alt", "Meta", "OS"].includes(e.key)) return;
      const mods = [e.ctrlKey && "Control", e.shiftKey && "Shift", e.altKey && "Alt", e.metaKey && "Super"].filter(Boolean) as string[];
      const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      onChange([...mods, key].join("+"));
      setListening(false);
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [listening, onChange]);
  return (
    <button className="btn" onClick={() => setListening(true)} onBlur={() => setListening(false)} style={{ minWidth: 150 }}>
      {listening ? "Press a key…" : value ? value.split("+").map((p) => <span key={p} className="kbd">{MODS.includes(p) ? p.replace("Control", "Ctrl") : p}</span>) : "Not set"}
    </button>
  );
}
