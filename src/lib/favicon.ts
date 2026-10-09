"use client";

/**
 * Favicon state manager — Claude-style page-level status in the tab icon:
 *  - working: green dot pulsing while a research run is live
 *  - done:    fixed blue dot once it finishes (until you focus the tab)
 *  - idle:    the plain app mark
 * Frames are canvas-drawn PNG data URLs (works in every browser, unlike
 * animated SVG favicons), swapped on the <link rel="icon"> Next.js emits.
 */

type FaviconState = "idle" | "working" | "done";

let originalHref: string | null = null;
let currentState: FaviconState = "idle";
let pulseTimer: ReturnType<typeof setInterval> | null = null;
let pulseFrame = 0;
let doneResetTimer: ReturnType<typeof setTimeout> | null = null;

const WORK_COLOR = "#30d158"; // system green
const DONE_COLOR = "#0a84ff"; // system blue

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Draw the app mark + optional status dot, return as PNG data URL. */
function drawIcon(opts: { dotColor?: string; dotAlpha?: number } = {}): string {
  const c = document.createElement("canvas");
  c.width = 32;
  c.height = 32;
  const ctx = c.getContext("2d");
  if (!ctx) return "";
  // mark background — violet gradient, 23% radius
  const g = ctx.createLinearGradient(0, 0, 32, 32);
  g.addColorStop(0, "#C4B5FD");
  g.addColorStop(0.5, "#7C3AED");
  g.addColorStop(1, "#5B21B6");
  ctx.fillStyle = g;
  roundRect(ctx, 0.5, 0.5, 31, 31, 7.5);
  ctx.fill();
  // the strata
  ctx.fillStyle = "rgba(255,255,255,0.94)";
  roundRect(ctx, 8, 8.5, 16, 3.2, 1.6);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.72)";
  roundRect(ctx, 8, 14.4, 11, 3.2, 1.6);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.96)";
  ctx.beginPath();
  ctx.arc(10.4, 23.4, 2.6, 0, Math.PI * 2);
  ctx.fill();
  // status dot — top-right badge with a white ring
  if (opts.dotColor) {
    ctx.globalAlpha = opts.dotAlpha ?? 1;
    ctx.beginPath();
    ctx.arc(25.5, 25.5, 4.6, 0, Math.PI * 2);
    ctx.fillStyle = opts.dotColor;
    ctx.fill();
    ctx.lineWidth = 1.6;
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
    apply(originalHref ?? "/icon.svg");
  }
}
