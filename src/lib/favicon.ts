"use client";

/**
 * Favicon state manager — Claude-style page-level status in the tab icon:
 *  - working: green dot pulsing while a research run is live
 *  - done:    fixed blue dot once it finishes (until you focus the tab)
 *  - idle:    the plain brand emblem
 * Frames are canvas-drawn PNG data URLs (works in every browser, unlike
 * animated SVG favicons), swapped on the <link rel="icon"> Next.js emits.
 * The idle icon is the real /brand/mark.png whenever it has loaded; before
 * that (or if it fails) a simple canvas-drawn emblem stands in.
 */

type FaviconState = "idle" | "working" | "done";

let originalHref: string | null = null;
let currentState: FaviconState = "idle";
let pulseTimer: ReturnType<typeof setInterval> | null = null;
let pulseFrame = 0;
let doneResetTimer: ReturnType<typeof setTimeout> | null = null;

const WORK_COLOR = "#30d158"; // system green
const DONE_COLOR = "#0a84ff"; // system blue

const CANVAS_PX = 64; // retina-crisp favicon frames
const MARK_SRC = "/brand/mark.png";

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** The brand emblem image, loaded once. `null` until decoded (or forever if it fails). */
let markImg: HTMLImageElement | null = null;
let markRequested = false;

function requestMark() {
  if (markRequested || typeof window === "undefined") return;
  markRequested = true;
  const img = new Image();
  img.decoding = "async";
  img.onload = () => {
    markImg = img;
    framesReady = false; // rebuild frames with the real emblem on next use
    if (initialized) ensureFrames();
    // re-assert current state so an in-flight pulse picks up the new frames
    if (currentState === "working") {
      apply(pulseFrame === 1 ? frameWorkOn : frameWorkOff);
    } else if (currentState === "done") {
      apply(frameDone);
    }
  };
  img.src = MARK_SRC;
}

/** Draw the app mark + optional status dot, return as PNG data URL. */
function drawIcon(opts: { dotColor?: string; dotAlpha?: number } = {}): string {
  const c = document.createElement("canvas");
  c.width = CANVAS_PX;
  c.height = CANVAS_PX;
  const ctx = c.getContext("2d");
  if (!ctx) return "";

  if (markImg && markImg.naturalWidth > 0) {
    // the real brand emblem (rounded corners baked into the PNG)
    ctx.drawImage(markImg, 0, 0, CANVAS_PX, CANVAS_PX);
  } else {
    // stand-in until the emblem loads: dark tile + concentric topographic arcs
    ctx.fillStyle = "#232227";
    roundRect(ctx, 0.5, 0.5, CANVAS_PX - 1, CANVAS_PX - 1, 15);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 3;
    for (const r of [26, 19, 12]) {
      ctx.beginPath();
      ctx.arc(30, 32, r, Math.PI * 0.15, Math.PI * 1.55);
      ctx.stroke();
    }
    ctx.fillStyle = "#8B5CF6";
    ctx.beginPath();
    ctx.arc(24, 44, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  // status dot — bottom-right badge with a white ring
  if (opts.dotColor) {
    ctx.globalAlpha = opts.dotAlpha ?? 1;
    ctx.beginPath();
    ctx.arc(51, 51, 9.2, 0, Math.PI * 2);
    ctx.fillStyle = opts.dotColor;
    ctx.fill();
    ctx.lineWidth = 3.2;
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  return c.toDataURL("image/png");
}

function iconLinks(): HTMLLinkElement[] {
  return Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]'));
}

function apply(href: string) {
  for (const link of iconLinks()) link.href = href;
}

function stopPulse() {
  if (pulseTimer != null) {
    clearInterval(pulseTimer);
    pulseTimer = null;
  }
}

function startPulse() {
  stopPulse();
  pulseTimer = setInterval(() => {
    pulseFrame = 1 - pulseFrame;
    apply(pulseFrame === 1 ? frameWorkOn : frameWorkOff);
  }, 650);
}

let frameWorkOn = "";
let frameWorkOff = "";
let frameDone = "";
let framesReady = false;
let initialized = false;

function ensureFrames() {
  if (framesReady) return;
  frameWorkOn = drawIcon({ dotColor: WORK_COLOR, dotAlpha: 1 });
  frameWorkOff = drawIcon({ dotColor: WORK_COLOR, dotAlpha: 0.3 });
  frameDone = drawIcon({ dotColor: DONE_COLOR, dotAlpha: 1 });
  framesReady = true;
}

/** Call once on app mount. Focus/visibility return the icon to idle after "done". */
export function initFaviconManager() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  requestMark();
  const first = iconLinks()[0];
  if (first) originalHref = first.href;
  ensureFrames();

  const resetIfDone = () => {
    if (currentState === "done") setFaviconState("idle");
  };
  window.addEventListener("focus", resetIfDone);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) resetIfDone();
  });
  // safety: done state never outstays 90s even without focus
  setInterval(() => resetIfDone(), 90_000);
}

/** Set the tab's state. Re-asserting the current state is a no-op. */
export function setFaviconState(next: FaviconState) {
  if (!initialized) initFaviconManager();
  if (next === currentState) return;
  currentState = next;
  stopPulse();
  if (doneResetTimer) {
    clearTimeout(doneResetTimer);
    doneResetTimer = null;
  }
  if (next === "working") {
    ensureFrames();
    apply(frameWorkOn);
    pulseFrame = 1;
    startPulse();
  } else if (next === "done") {
    ensureFrames();
    apply(frameDone);
  } else {
    apply(originalHref ?? MARK_SRC);
  }
}
