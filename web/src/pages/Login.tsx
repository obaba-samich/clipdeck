import { useRef, useState } from "react";
import { api } from "../api";

export function Login({ onDone }: { onDone: () => void }) {
  const [digits, setDigits] = useState(["", "", "", "", "", ""]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  const submit = async (code: string) => {
    setBusy(true);
    setErr("");
    try {
      await api("/api/login", { method: "POST", json: { passcode: code } });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
      setDigits(["", "", "", "", "", ""]);
      refs.current[0]?.focus();
    } finally {
      setBusy(false);
    }
  };

  const put = (i: number, v: string) => {
    const clean = v.replace(/\D/g, "");
    if (clean.length > 1) {
      // pasted the whole code
      const next = clean.slice(0, 6).split("");
      while (next.length < 6) next.push("");
      setDigits(next);
      if (clean.length >= 6) submit(clean.slice(0, 6));
      return;
    }
    const next = [...digits];
    next[i] = clean;
    setDigits(next);
    if (clean && i < 5) refs.current[i + 1]?.focus();
    if (next.every(Boolean)) submit(next.join(""));
  };

  return (
    <div className="login">
      <div className="box">
        <img src="/icons/icon.svg" alt="" />
        <h1>Clipdeck</h1>
        <p>Enter the passcode from Settings → Phone on your PC.</p>
        <div className="pin">
          {digits.map((d, i) => (
            <input
              key={i}
              ref={(el) => (refs.current[i] = el)}
              value={d}
              inputMode="numeric"
              autoComplete={i === 0 ? "one-time-code" : "off"}
              aria-label={`Digit ${i + 1}`}
              autoFocus={i === 0}
              disabled={busy}
              onChange={(e) => put(i, e.target.value)}
              onKeyDown={(e) => e.key === "Backspace" && !d && i > 0 && refs.current[i - 1]?.focus()}
            />
          ))}
        </div>
        <div className="err">{err}</div>
      </div>
    </div>
  );
}
