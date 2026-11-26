import { useEffect, useRef, type RefObject } from "react";

// Smooth scrubbing in Clipdeck's own window (WebKitGTK on Wayland). There a seeking <video>
// paints black, and our clips only have a keyframe every 2 s, so every seek is slow. So:
//  - While dragging, don't seek at all: paint the nearest frame from the clip's storyboard
//    (a grid of small frames, /media/storyboard/<id>) onto a canvas over the video. That's
//    instant and never black. The real seek happens once, when the drag stops or rests.
//  - softSeek never stacks seeks: while one is decoding, only the newest target is kept.
//  - The canvas keeps the last finished frame while paused or seeking, and a grab that comes
//    back all black (frame not decoded yet) is retried instead of shown.

const next = new WeakMap<HTMLMediaElement, number>();
const hooked = new WeakSet<HTMLMediaElement>();

export function softSeek(v: HTMLMediaElement, t: number) {
  if (!hooked.has(v)) {
    hooked.add(v);
    v.addEventListener("seeked", () => {
      const n = next.get(v);
      if (n === undefined) return;
      next.delete(v);
      softSeek(v, n);
    });
    v.addEventListener("emptied", () => next.delete(v));
  }
  if (v.seeking) {
    next.set(v, t);
    return;
  }
  next.delete(v);
  // Seeking to the frame already shown still blanks it for a moment in some browsers.
  if (Math.abs(v.currentTime - t) > 0.004) v.currentTime = t;
}

/* ---------- storyboards ---------- */

// Same grid as media.storyboard_grid on the server.
function grid(duration: number) {
  const fps = Math.min(10, 300 / Math.max(duration, 0.1));
  const frames = Math.max(1, Math.floor(duration * fps));
  const cols = Math.min(frames, 20);
  return { fps, frames, cols, rows: Math.ceil(frames / cols) };
}

const boards = new Map<string, HTMLImageElement>();

/** Start loading a clip's storyboard so it's ready by the time the user drags. */
export function loadStoryboard(clipId: string) {
  let img = boards.get(clipId);
  if (!img) {
    img = new Image();
    img.decoding = "async";
    img.src = `/media/storyboard/${clipId}`;
    boards.set(clipId, img);
    if (boards.size > 40) boards.delete(boards.keys().next().value!);
  }
  return img;
}

/* ---------- the hold canvas ---------- */

export type FrameHold = {
  /** Paint clip `clipId` at source time `t` from its storyboard. False if it isn't loaded yet. */
  scrub: (clipId: string, duration: number, t: number) => boolean;
  /** Scrubbing is over: show the real video frame again once it's ready. */
  release: () => void;
};

export function useFrameHold(video: RefObject<HTMLVideoElement | null>, canvas: RefObject<HTMLCanvasElement | null>, ready = true): FrameHold {
  const api = useRef<FrameHold>({ scrub: () => false, release: () => {} });

  useEffect(() => {
    const v = video.current;
    const c = canvas.current;
    if (!v || !c) return;
    const ctx = c.getContext("2d");
    const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    let has = false;
    let scrubbing = false;
    let raf = 0;
    let tries = 0;

    const show = () => {
      const hold = has && (scrubbing || v.seeking || v.paused || v.readyState < 2);
      c.style.visibility = hold ? "visible" : "hidden";
    };
    const size = (w: number, h: number) => {
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
    };
    // A frame grabbed before it's decoded comes back black. Check a tiny copy first.
    const blank = () => {
      if (!probe) return false;
      try {
        probe.canvas.width = 8;
        probe.canvas.height = 8;
        probe.drawImage(v, 0, 0, 8, 8);
        const d = probe.getImageData(0, 0, 8, 8).data;
        for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 6) return false;
        return true;
      } catch {
        return false;
      }
    };
    const grab = () => {
      if (!ctx || scrubbing || v.seeking || v.readyState < 2 || !v.videoWidth) return;
      if (blank() && tries++ < 4) {
        raf = requestAnimationFrame(grab);
        return;
      }
      tries = 0;
      size(v.videoWidth, v.videoHeight);
      try {
        ctx.drawImage(v, 0, 0, c.width, c.height);
        has = true;
      } catch {
        has = false;
      }
      show();
    };
    const settle = () => {
      cancelAnimationFrame(raf);
      tries = 0;
      grab();
    };

    api.current = {
      scrub(clipId, duration, t) {
        const img = loadStoryboard(clipId);
        if (!ctx || !img.complete || !img.naturalWidth) return false;
        const g = grid(duration);
        const k = Math.max(0, Math.min(g.frames - 1, Math.round(t * g.fps)));
        const tw = img.naturalWidth / g.cols;
        const th = img.naturalHeight / g.rows;
        cancelAnimationFrame(raf);
        scrubbing = true;
        size(v.videoWidth || Math.round(tw * 8), v.videoHeight || Math.round(th * 8));
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, (k % g.cols) * tw, Math.floor(k / g.cols) * th, tw, th, 0, 0, c.width, c.height);
        has = true;
        show();
        return true;
      },
      release() {
        if (!scrubbing) return;
        scrubbing = false;
        // If a seek is under way its "seeked" grabs the frame; otherwise grab it now.
        if (!v.seeking) settle();
        show();
      },
    };

    const grabs = ["seeked", "loadeddata", "pause"];
    const shows = ["seeking", "play", "playing", "waiting", "emptied"];
    grabs.forEach((e) => v.addEventListener(e, settle));
    shows.forEach((e) => v.addEventListener(e, show));
    settle();
    return () => {
      cancelAnimationFrame(raf);
      grabs.forEach((e) => v.removeEventListener(e, settle));
      shows.forEach((e) => v.removeEventListener(e, show));
      api.current = { scrub: () => false, release: () => {} };
    };
  }, [video, canvas, ready]);

  return {
    scrub: (id, d, t) => api.current.scrub(id, d, t),
    release: () => api.current.release(),
  };
}
