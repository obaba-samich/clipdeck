import { useEffect, useRef, useState } from "react";

export type Clip = {
  id: string;
  path: string;
  filename: string;
  title: string;
  game: string;
  steam_appid: string | null;
  source: "hotkey" | "voice" | "hype" | "phone" | "web" | "cli" | "import" | "trim" | string;
  created_at: number;
  duration: number;
  width: number;
  height: number;
  fps: number;
  size: number;
  audio_tracks: number;
  favorite: number;
  trim_start: number | null;
  trim_end: number | null;
  share_token: string | null;
  views: number;
  deleted_at: number | null;
  albums: string[];
};

export type Game = { game: string; steam_appid: string | null; count: number; size: number; last_at: number };
export type Album = { id: string; name: string; created_at: number; count: number; cover_id: string | null };

export type Status = {
  recorder: { state: "stopped" | "starting" | "recording" | "error"; error: string; since: number | null; session_since: number | null; buffer_seconds: number; encoder?: { used: "gpu" | "cpu"; why: string }; encoder_locked?: boolean; log: string[] };
  listener: { state: "off" | "listening" | "error"; error: string; level_db: number; last_heard: string; model: boolean };
  game: string;
  steam_appid: string | null;
  stats: { clips: number; size: number; duration: number; favorites: number; trash: number; trash_size: number };
  lan_url: string;
  clips_dir: string;
  disk: { free: number; total: number } | null;
};

export type Settings = {
  clips_dir: string;
  recorder: {
    enabled: boolean; replay_seconds: number; encoder: "gpu" | "cpu"; monitor: string; fps: number;
    quality: string; resolution: string; record_game_audio: boolean; record_mic: boolean;
    game_audio_device: string; mic_device: string; replay_storage: string; only_while_gaming: boolean;
    show_cursor: boolean; nice: number;
  };
  voice: { enabled: boolean; phrase: string; confidence: number; mic_device: string };
  hype: { enabled: boolean; threshold_db: number; min_ms: number; cooldown_s: number };
  feedback: { sound: boolean; notification: boolean; volume: number };
  storage: { max_gb: number; auto_clean: boolean; trash_days: number };
  hotkeys: { clip: string; record: string };
  server: { port: number; lan: boolean; passcode: string };
  share: { discord_webhook: string };
};

export type Options = {
  monitors: { id: string; label: string }[];
  outputs: { id: string; label: string }[];
  inputs: { id: string; label: string }[];
};

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(path, {
    credentials: "same-origin",
    ...rest,
    headers: json !== undefined ? { "Content-Type": "application/json", ...(rest.headers || {}) } : rest.headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (res.status === 401 && !path.startsWith("/api/login")) {
    window.dispatchEvent(new Event("clipdeck:logout"));
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = await res.json();
      msg = body.detail || body.error || msg;
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, msg);
  }
  return res.json() as Promise<T>;
}

export const media = {
  clip: (id: string) => `/media/clip/${id}`,
  thumb: (id: string, v?: number | string) => `/media/thumb/${id}${v ? `?v=${v}` : ""}`,
  preview: (id: string, v?: number | string) => `/media/preview/${id}${v ? `?v=${v}` : ""}`,
  cover: (appid: string) => `/media/cover/${appid}`,
  hero: (appid: string) => `/media/hero/${appid}`,
  download: (id: string, mode: "original" | "share" = "original", mic = 1, game = 1) =>
    `/media/download/${id}?mode=${mode}&mic=${mic}&game=${game}`,
};

/* ---------- live events (server-sent) ---------- */

export type LiveEvent =
  | { type: "clip"; clip: Clip }
  | { type: "updated"; clip: Clip }
  | { type: "art"; id: string }
  | { type: "removed"; id: string }
  | { type: "saving"; source: string; game: string }
  | { type: "heard"; phrase: string }
  | { type: "game"; game: string }
  | { type: "settings" }
  | { type: "bulk" }
  | { type: "render"; job: RenderJob }
  | { type: "recording"; on: boolean };

type Handler = (e: LiveEvent) => void;
const handlers = new Set<Handler>();
let source: EventSource | null = null;

function connect() {
  if (source) return;
  source = new EventSource("/api/events");
  source.onmessage = (m) => {
    try {
      const ev = JSON.parse(m.data) as LiveEvent;
      handlers.forEach((h) => h(ev));
    } catch {
      /* ignore */
    }
  };
}

export function useLive(handler: Handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    connect();
    const h: Handler = (e) => ref.current(e);
    handlers.add(h);
    return () => {
      handlers.delete(h);
    };
  }, []);
}

/** Fetch JSON and refetch when `deps` change. `reload()` refetches on demand. */
export function useFetch<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    api<T>(path)
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e) => alive && setError(String(e.message || e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, tick, ...deps]);
  return { data, setData, error, reload: () => setTick((t) => t + 1) };
}

/* ---------- formatting ---------- */

export function fmtDuration(s: number) {
  s = Math.max(0, Math.round(s));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${m}:${String(r).padStart(2, "0")}`;
}

export function fmtTime(s: number) {
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, "0")}`;
}

export function fmtSize(b: number) {
  if (b < 1024 ** 2) return `${Math.max(1, Math.round(b / 1024))} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(b < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(b / 1024 ** 3).toFixed(1)} GB`;
}

export function fmtAgo(ts: number) {
  const d = Date.now() / 1000 - ts;
  if (d < 45) return "just now";
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  if (d < 86400 * 7) return `${Math.round(d / 86400)} d ago`;
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: d > 86400 * 300 ? "numeric" : undefined });
}

export function fmtDate(ts: number) {
  return new Date(ts * 1000).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

export function clipLength(c: Clip) {
  return (c.trim_end ?? c.duration) - (c.trim_start ?? 0);
}

export function initials(name: string) {
  const w = name.replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).filter(Boolean);
  return ((w[0]?.[0] || "?") + (w[1]?.[0] || "")).toUpperCase();
}

export const SOURCE_LABEL: Record<string, string> = {
  hotkey: "Hotkey",
  voice: "Voice",
  hype: "Auto",
  phone: "Phone",
  web: "Web",
  cli: "Command",
  import: "Imported",
  trim: "Trimmed",
  edit: "Editor",
  record: "Full recording",
};

/* ---------- editor ---------- */

export type Segment = { id: string; clip: string; start: number; end: number; speed: number; mute: boolean };
export type TextItem = {
  id: string; text: string; start: number; end: number; x: number; y: number; size: number;
  color: string; style: "none" | "outline" | "box" | "shadow"; font: string; anim: "none" | "fade" | "pop";
};
export type Project = {
  name: string;
  segments: Segment[];
  texts: TextItem[];
  aspect: "16:9" | "9:16" | "1:1" | "4:5";
  fit: "fill" | "blur" | "bars";
  pan: number;
  zoom: number;
  transition: "cut" | "fade";
  fade_in: number;
  fade_out: number;
  adjust: { brightness: number; contrast: number; saturation: number; vignette: boolean; sharpen: boolean };
  audio: { game: number; mic: number; fade_in: number; fade_out: number };
  output: { format: "mp4" | "gif"; height: number; fps: number; quality: "high" | "medium" | "small"; fast: boolean };
};
export type ProjectRow = { id: string; name: string; updated_at: number; clips: number; cover: string | null };
export type RenderJob = {
  id: string; project_id: string; name: string; total: number; state: "queued" | "running" | "done" | "error" | "canceled";
  progress: number; error: string; clip_id: string | null; file: string | null; format: string; created: number;
};

export function newId() {
  return Math.random().toString(36).slice(2, 10);
}

export function blankProject(name: string): Project {
  return {
    name,
    segments: [],
    texts: [],
    aspect: "16:9",
    fit: "fill",
    pan: 0.5,
    zoom: 1,
    transition: "cut",
    fade_in: 0,
    fade_out: 0,
    adjust: { brightness: 0, contrast: 1, saturation: 1, vignette: false, sharpen: false },
    audio: { game: 1, mic: 1, fade_in: 0, fade_out: 0 },
    output: { format: "mp4", height: 1080, fps: 60, quality: "high", fast: false },
  };
}
