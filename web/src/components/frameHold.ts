import { useEffect, type RefObject } from "react";

// Scrubbing fix for Clipdeck's own window (WebKitGTK/GStreamer): while a <video> is seeking it
// paints black, and our clips only have a keyframe every 2 s, so each seek takes a moment.
// Dragging a timeline used to start a new seek on every mouse move, so the preview was black
// most of the time. Two parts fix it:
//  - softSeek: never stack seeks. While one is still decoding, only remember the newest target
//    and go there when it finishes.
//  - useFrameHold: a canvas over the video holding the last finished frame, shown whenever the
//    video is paused or seeking, so a seek never shows black.

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

export function useFrameHold(video: RefObject<HTMLVideoElement | null>, canvas: RefObject<HTMLCanvasElement | null>, ready = true) {
  useEffect(() => {
    const v = video.current;
    const c = canvas.current;
    if (!v || !c) return;
    const ctx = c.getContext("2d");
    let has = false;
    let raf = 0;

    const show = () => {
      const hold = has && (v.seeking || v.paused || v.readyState < 2);
      c.style.visibility = hold ? "visible" : "hidden";
    };
    const grab = () => {
      if (!ctx || v.seeking || v.readyState < 2 || !v.videoWidth) return;
      if (c.width !== v.videoWidth || c.height !== v.videoHeight) {
        c.width = v.videoWidth;
        c.height = v.videoHeight;
      }
      try {
        ctx.drawImage(v, 0, 0, c.width, c.height);
        has = true;
      } catch {
        has = false;
      }
      show();
    };
    // Grab now and once more on the next frame, in case the decoded picture lands a frame late.
    const settle = () => {
      grab();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(grab);
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
    };
  }, [video, canvas, ready]);
}
