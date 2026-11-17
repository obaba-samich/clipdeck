import { useEffect, useState } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { api } from "./api";
import { Layout } from "./components/Layout";
import { ToastProvider } from "./components/ui";
import { AlbumPage, Albums, GamePage, Games, Home } from "./pages/Browse";
import { AllClips, Favorites, Trash } from "./pages/Clips";
import { ClipView } from "./pages/ClipView";
import { Editor } from "./pages/Editor";
import { Edits } from "./pages/Edits";
import { Login } from "./pages/Login";
import { Settings } from "./pages/Settings";

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const check = () => api<{ authed: boolean }>("/api/me").then((r) => setAuthed(r.authed)).catch(() => setAuthed(false));

  useEffect(() => {
    check();
    const out = () => setAuthed(false);
    window.addEventListener("clipdeck:logout", out);
    return () => window.removeEventListener("clipdeck:logout", out);
  }, []);

  if (authed === null) return null;
  if (!authed) return <Login onDone={check} />;

  return (
    <BrowserRouter>
      <ToastProvider>
        <Layout>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/clips" element={<AllClips />} />
            <Route path="/favorites" element={<Favorites />} />
            <Route path="/games" element={<Games />} />
            <Route path="/games/:name" element={<GamePage />} />
            <Route path="/albums" element={<Albums />} />
            <Route path="/albums/:id" element={<AlbumPage />} />
            <Route path="/trash" element={<Trash />} />
            <Route path="/clip/:id" element={<ClipView />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/edits" element={<Edits />} />
            <Route path="/edit" element={<Editor key="new" />} />
            <Route path="/edit/:pid" element={<Editor />} />
            <Route path="*" element={<Home />} />
          </Routes>
        </Layout>
      </ToastProvider>
    </BrowserRouter>
  );
}
