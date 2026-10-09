"use client";

/**
 * Favicon state manager — the tab mirrors the mark.
 *
 * The emblem is the SAME nested-contour-ring geometry the app logo draws
 * (src/components/pplx/logo.tsx): fixed outer ring, inner rings that stream
 * inward. In the favicon the inner rings sit at even spacing; while a run is
 * working they drift inward slowly (one redraw every 550ms — gentle, never
 * frantic) under the flashing status dot. Reduced motion: fully static.
 *
 * States:
 *  - working: green dot FLASHING (bright <-> dim, 550ms) + slow inward drift
 *  - done:    fixed blue dot (until you focus the tab)
 *  - idle:    the static ring badge
 *
 * Frames are canvas-drawn PNG data URLs — pure geometry, zero image fetches
 * (the first paint is instant, offline included).
 */

type FaviconState = "idle" | "working" | "done";

let originalHref: string | null = null;
let currentState: FaviconState = "idle";
let pulseTimer: ReturnType<typeof setInterval> | null = null;
let pulseFrame = 0;

const WORK_COLOR = "#30d158"; // system green
const DONE_COLOR = "#0a84ff"; // system blue
const RING_COLOR = "#5eead4"; // teal 300 — the verification accent
const CORE_COLOR = "#2dd4bf";

const CANVAS_PX = 64; // retina-crisp favicon frames
const BADGE_R = 14; // rounded-corner radius (22%)
const DOT_C = 49; // dot center = bottom-right corner-arc center
const DOT_BACKING_R = 13; // dark disc so the dot reads over the rings
const DOT_R = 10;
const RING_W = 3;
const FLASH_INTERVAL = 550; // ms per flash step
const FLASH_DIM = 0.15; // dimmed alpha of the "off" flash phase

// ring geometry, mirrored from the app mark (viewBox 0 0 64 64 → 64px canvas,
// nudged to (32, 33) to leave room for the status dot)
const CX = 32;
const CY = 33;
const RINGS = 8;

function drawRings(ctx: CanvasRenderingContext2D, t: number | null) {
  ctx.lineCap = "round";
  ctx.strokeStyle = RING_COLOR;
  // fixed outer outline (s = 1): spine x = CX-10, arc r = 20
  ctx.lineWidth = 3.4;
  ctx.beginPath();
  ctx.moveTo(CX - 10, CY - 20);
  ctx.lineTo(CX - 10, CY + 20);
  ctx.arc(CX - 10, CY, 20, Math.PI / 2, -Math.PI / 2, false);
  ctx.closePath();
  ctx.stroke();

  ctx.lineWidth = 2.6;
  for (let k = 0; k < RINGS; k++) {
    // t == null → static even spacing; else streaming inward
    const p = t == null ? 1 - (k + 1) / (RINGS + 1) : 1 - ((t / 2.8 + k / RINGS) % 1);
    const s = 0.16 + 0.84 * p;
    const x = CX - 10 * s;
    const r = 20 * s;
    // fade in at the edge, out at the core — same curve as the app mark
    const o = Math.min(Math.max((1 - p) / 0.12, 0), 1) * Math.min(Math.max(p / 0.16, 0), 1);
    ctx.globalAlpha = o;
    ctx.beginPath();
    ctx.moveTo(x, CY - 20 * s);
    ctx.lineTo(x, CY + 20 * s);
    ctx.arc(x, CY, r, Math.PI / 2, -Math.PI / 2, false);
    ctx.closePath();
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // core glow
  ctx.fillStyle = CORE_COLOR;
  ctx.beginPath();
  ctx.arc(CX, CY, 3.4, 0, Math.PI * 2);
  ctx.fill();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Draw the badge + rings (+ optional status dot), return as PNG data URL. */
function drawIcon(opts: { dotColor?: string; dotAlpha?: number; t?: number | null } = {}): string {
  const c = document.createElement("canvas");
  c.width = CANVAS_PX;
  c.height = CANVAS_PX;
  const ctx = c.getContext("2d");
  if (!ctx) return "";

  // dark rounded badge
  const g = ctx.createLinearGradient(0, 0, CANVAS_PX, CANVAS_PX);
  g.addColorStop(0, "#26262d");
  g.addColorStop(1, "#141419");
  ctx.fillStyle = g;
  roundRect(ctx, 1, 1, CANVAS_PX - 2, CANVAS_PX - 2, BADGE_R);
  ctx.fill();

  drawRings(ctx, opts.t ?? null);

  // status dot — dark backing disc, colored dot, white ring
  if (opts.dotColor) {
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(DOT_C, DOT_C, DOT_BACKING_R, 0, Math.PI * 2);
    ctx.fillStyle = "#141419";
    ctx.fill();
    ctx.globalAlpha = opts.dotAlpha ?? 1;
    ctx.beginPath();
    ctx.arc(DOT_C, DOT_C, DOT_R, 0, Math.PI * 2);
    ctx.fillStyle = opts.dotColor;
    ctx.fill();
    ctx.lineWidth = RING_W;
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

let workT = 0;
const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** FLASHING green + a slow inward drift of the rings (mirrors the logo's
 *  work speed at favicon scale: one redraw per flash step). */
function startPulse() {
  stopPulse();
  pulseTimer = setInterval(() => {
    pulseFrame = 1 - pulseFrame;
    if (reducedMotion()) {
      apply(pulseFrame === 1 ? frameWorkOn : frameWorkOff); // dot flash only — rings static
    } else {
      workT += FLASH_INTERVAL / 1000;
      apply(drawIcon({ dotColor: WORK_COLOR, dotAlpha: pulseFrame === 1 ? 1 : FLASH_DIM, t: workT }));
    }
  }, FLASH_INTERVAL);
}

let frameWorkOn = "";
let frameWorkOff = "";
let frameDone = "";
let framesReady = false;
let initialized = false;

function ensureFrames() {
  if (framesReady) return;
  frameWorkOn = drawIcon({ dotColor: WORK_COLOR, dotAlpha: 1 });
  frameWorkOff = drawIcon({ dotColor: WORK_COLOR, dotAlpha: FLASH_DIM });
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
  if (next === "working") {
    ensureFrames();
    workT = 0;
    if (reducedMotion()) {
      apply(frameWorkOn);
      pulseFrame = 1;
      startPulse(); // flash the dot only
    } else {
      apply(drawIcon({ dotColor: WORK_COLOR, dotAlpha: 1, t: 0 }));
      pulseFrame = 1;
      startPulse();
    }
  } else if (next === "done") {
    ensureFrames();
    apply(frameDone);
  } else {
    apply(originalHref ?? "/icon.png");
  }
}
