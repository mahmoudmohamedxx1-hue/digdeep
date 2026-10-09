"use client";

/**
 * Favicon state manager — Claude-style page-level status in the tab icon:
 *  - working: green dot FLASHING (bright <-> dim, 550ms) while a research run is live
 *  - done:    fixed blue dot once it finishes (until you focus the tab)
 *  - idle:    the plain brand badge (the /icon.png Next.js emits)
 *
 * Frames are canvas-drawn PNG data URLs — the tight transparent emblem is
 * composited onto a dark rounded badge so it stays legible on any tab strip.
 * The badge/emblem geometry mirrors scripts/gen_tight_logo.py (make_badge)
 * so idle, working and done all look like the same icon.
 */

type FaviconState = "idle" | "working" | "done";

let originalHref: string | null = null;
let currentState: FaviconState = "idle";
let pulseTimer: ReturnType<typeof setInterval> | null = null;
let pulseFrame = 0;

const WORK_COLOR = "#30d158"; // system green
const DONE_COLOR = "#0a84ff"; // system blue

const CANVAS_PX = 64; // retina-crisp favicon frames
const BADGE_R = 14; // rounded-corner radius (22%)
const EMBLEM_PX = 58; // bold favicon emblem fills 91% of the badge
const EMBLEM_OFF = (CANVAS_PX - EMBLEM_PX) / 2;
const DOT_C = 49; // dot center = bottom-right corner-arc center
const DOT_BACKING_R = 13; // dark disc so the dot reads over emblem lines
const DOT_R = 10;
const RING_W = 3;
const FLASH_INTERVAL = 550; // ms per flash step
const FLASH_DIM = 0.15; // dimmed alpha of the "off" flash phase

const MARK_SRC = "/brand/mark-favicon.png";

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** The tight transparent emblem, loaded once. `null` until decoded (or forever if it fails). */
let markImg: HTMLImageElement | null = null;
let markRequested = false;

function requestMark() {
  if (markRequested || typeof window === "undefined") return;
  markRequested = true;
  const img = new Image();
  img.decoding = "async";
  img.onload = () => {
    markImg = img;
    framesReady = false; // rebuild frames with the real emblem
    if (initialized) ensureFrames();
    // re-assert the current state so an in-flight flash picks up the new frames
    if (currentState === "working") {
      apply(pulseFrame === 1 ? frameWorkOn : frameWorkOff);
    } else if (currentState === "done") {
      apply(frameDone);
    }
  };
  img.src = MARK_SRC;
}

/** Draw the brand badge (+ optional status dot), return as PNG data URL. */
function drawIcon(opts: { dotColor?: string; dotAlpha?: number } = {}): string {
  const c = document.createElement("canvas");
  c.width = CANVAS_PX;
  c.height = CANVAS_PX;
  const ctx = c.getContext("2d");
  if (!ctx) return "";

  // dark rounded badge — same gradient as src/app/icon.png
  const g = ctx.createLinearGradient(0, 0, CANVAS_PX, CANVAS_PX);
  g.addColorStop(0, "#2A2930");
  g.addColorStop(1, "#1B1A1F");
  ctx.fillStyle = g;
  roundRect(ctx, 1, 1, CANVAS_PX - 2, CANVAS_PX - 2, BADGE_R);
  ctx.fill();

  // the tight emblem (transparent PNG, drawn to fill 86% of the badge)
  if (markImg && markImg.naturalWidth > 0) {
    ctx.drawImage(markImg, EMBLEM_OFF, EMBLEM_OFF, EMBLEM_PX, EMBLEM_PX);
  } else {
    // stand-in until the emblem loads: dark tile + concentric topographic arcs
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 4.5;
    for (const r of [24, 17, 10]) {
      ctx.beginPath();
      ctx.arc(32, 34, r, Math.PI * 0.15, Math.PI * 1.55);
      ctx.stroke();
    }
    ctx.fillStyle = "#8B5CF6";
    ctx.beginPath();
    ctx.arc(26, 48, 8, 0, Math.PI * 2);
    ctx.fill();
  }

  // status dot — dark backing disc, colored dot, white ring
  if (opts.dotColor) {
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(DOT_C, DOT_C, DOT_BACKING_R, 0, Math.PI * 2);
    ctx.fillStyle = "#1B1A1F";
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

/** FLASHING green: bright <-> dim, flipping every FLASH_INTERVAL ms. */
function startPulse() {
  stopPulse();
  pulseTimer = setInterval(() => {
    pulseFrame = 1 - pulseFrame;
    apply(pulseFrame === 1 ? frameWorkOn : frameWorkOff);
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
  if (next === "working") {
    ensureFrames();
    apply(frameWorkOn);
    pulseFrame = 1;
    startPulse();
  } else if (next === "done") {
    ensureFrames();
    apply(frameDone);
  } else {
    apply(originalHref ?? "/icon.png");
  }
}
