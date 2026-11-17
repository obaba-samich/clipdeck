import { useEffect, useRef, useState } from "react";
import { Upload } from "lucide-react";
import { useToast } from "./ui";

function send(file: File, onProgress: (p: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append("file", file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status < 300) resolve();
      else {
        let msg = xhr.statusText;
        try {
          msg = JSON.parse(xhr.responseText).detail || msg;
        } catch {
          /* not json */
        }
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error("Connection lost"));
    xhr.send(fd);
  });
}

/** Drag videos anywhere onto the window, or call open() to pick files. */
export function useImporter() {
  const toast = useToast();
  const input = useRef<HTMLInputElement | null>(null);
  const [drag, setDrag] = useState(false);
  const [job, setJob] = useState<{ name: string; i: number; n: number; p: number } | null>(null);

  const run = async (files: File[]) => {
    const vids = files.filter((f) => f.type.startsWith("video/") || /\.(mp4|mov|mkv|webm|m4v)$/i.test(f.name));
    if (!vids.length) return toast({ title: "No videos there", body: "Drop MP4, MOV, MKV or WebM files.", error: true });
    let ok = 0;
    for (const [i, f] of vids.entries()) {
      setJob({ name: f.name, i, n: vids.length, p: 0 });
      try {
        await send(f, (p) => setJob({ name: f.name, i, n: vids.length, p }));
        ok++;
      } catch (e) {
        toast({ title: `Couldn't import ${f.name}`, body: (e as Error).message, error: true });
      }
    }
    setJob(null);
    if (ok) toast({ title: ok > 1 ? `Imported ${ok} videos` : "Imported video", body: "They're in the “Imported” game.", icon: <Upload /> });
  };

  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types || []).includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDrag(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDrag(false);
    };
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDrag(false);
      run(Array.from(e.dataTransfer?.files || []));
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const node = (
    <>
      <input
        ref={input}
        type="file"
        accept="video/*,.mkv"
        multiple
        hidden
        onChange={(e) => {
          run(Array.from(e.target.files || []));
          e.target.value = "";
        }}
      />
      {drag && (
        <div className="dropzone">
          <div><Upload /><b>Drop videos to import</b><span>They'll be added to your library.</span></div>
        </div>
      )}
      {job && (
        <div className="upload-pill">
          <Upload size={16} />
          <span>Importing {job.n > 1 ? `${job.i + 1}/${job.n}` : job.name}</span>
          <div className="bar"><i style={{ width: `${Math.round(job.p * 100)}%` }} /></div>
        </div>
      )}
    </>
  );
  return { open: () => input.current?.click(), node };
}
