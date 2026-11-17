import { createContext, ReactNode, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AlertTriangle, Check } from "lucide-react";

/* ---------- toasts ---------- */

type Toast = { id: number; title: string; body?: string; img?: string; icon?: ReactNode; error?: boolean; onClick?: () => void };
type ToastCtx = { push: (t: Omit<Toast, "id">) => void };
const Ctx = createContext<ToastCtx>({ push: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs.slice(-2), { ...t, id }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), t.error ? 6000 : 4200);
  }, []);
  return (
    <Ctx.Provider value={{ push }}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast${t.error ? " err" : ""}`} onClick={t.onClick} style={{ cursor: t.onClick ? "pointer" : undefined }}>
            {t.img ? <img src={t.img} alt="" /> : <div className="ic">{t.icon || (t.error ? <AlertTriangle /> : <Check />)}</div>}
            <div>
              <b>{t.title}</b>
              {t.body && <span>{t.body}</span>}
            </div>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx).push;

/* ---------- modal & confirm ---------- */

export function Modal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">
        {children}
      </div>
    </div>
  );
}

type ConfirmOpts = { title: string; body?: string; ok?: string; danger?: boolean };

export function useConfirm() {
  const [state, setState] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const ask = (o: ConfirmOpts) => new Promise<boolean>((resolve) => setState({ ...o, resolve }));
  const close = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  const node = state ? (
    <Modal onClose={() => close(false)}>
      <h3>{state.title}</h3>
      {state.body && <p>{state.body}</p>}
      <div className="acts">
        <button className="btn ghost" onClick={() => close(false)}>Cancel</button>
        <button className={`btn ${state.danger ? "danger solid" : "primary"}`} autoFocus onClick={() => close(true)}>
          {state.ok || "OK"}
        </button>
      </div>
    </Modal>
  ) : null;
  return [ask, node] as const;
}

export function usePrompt() {
  const [state, setState] = useState<{ title: string; value: string; ok: string; resolve: (v: string | null) => void } | null>(null);
  const ask = (title: string, value = "", ok = "Save") =>
    new Promise<string | null>((resolve) => setState({ title, value, ok, resolve }));
  const close = (v: string | null) => {
    state?.resolve(v);
    setState(null);
  };
  const node = state ? (
    <Modal onClose={() => close(null)}>
      <h3>{state.title}</h3>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          close(state.value.trim() || null);
        }}
      >
        <input className="input" autoFocus value={state.value} onChange={(e) => setState({ ...state, value: e.target.value })} style={{ marginTop: 10 }} />
        <div className="acts">
          <button type="button" className="btn ghost" onClick={() => close(null)}>Cancel</button>
          <button className="btn primary" disabled={!state.value.trim()}>{state.ok}</button>
        </div>
      </form>
    </Modal>
  ) : null;
  return [ask, node] as const;
}

/* ---------- context menu ---------- */

export type MenuItem = { label: string; icon?: ReactNode; onClick: () => void; danger?: boolean } | "sep";

export function Menu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.min(x, window.innerWidth - r.width - 8), y: Math.min(y, window.innerHeight - r.height - 8) });
  }, [x, y]);
  useEffect(() => {
    const close = () => onClose();
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", k);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", k);
    };
  }, [onClose]);
  return (
    <div className="menu" ref={ref} style={{ left: pos.x, top: pos.y }} onMouseDown={(e) => e.stopPropagation()} role="menu">
      {items.map((it, i) =>
        it === "sep" ? (
          <hr key={i} />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={it.danger ? "danger" : ""}
            onClick={() => {
              onClose();
              it.onClick();
            }}
          >
            {it.icon}
            {it.label}
          </button>
        ),
      )}
    </div>
  );
}

/* ---------- small controls ---------- */

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} aria-label={label} onChange={(e) => onChange(e.target.checked)} />
      <i />
    </label>
  );
}

export function Range({ value, min, max, step = 1, onChange, label }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; label?: string }) {
  const p = ((value - min) / (max - min)) * 100;
  return (
    <input
      type="range"
      aria-label={label}
      min={min}
      max={max}
      step={step}
      value={value}
      style={{ ["--p" as string]: `${p}%` }}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}

export function Seg<T extends string | number>({ value, options, onChange }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="radiogroup">
      {options.map((o) => (
        <button key={String(o.v)} role="radio" aria-checked={o.v === value} className={o.v === value ? "on" : ""} onClick={() => onChange(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Empty({ icon, title, body, action }: { icon: ReactNode; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="ic">{icon}</div>
      <h3>{title}</h3>
      {body && <p>{body}</p>}
      {action}
    </div>
  );
}
