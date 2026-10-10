/**
 * burstConfetti — a single tasteful burst: ~80 small paper motes in the
 * brand palette, one canvas, self-removing. No React lifecycle, no globals
 * left behind. Reduced-motion users get nothing (by design).
 *
 * Used sparingly: when a research run completes with a strong self-grade —
 * the moment you waited forty minutes for.
 */

interface Mote {
  x: number;
  y: number;
  vx: number;
  vy: number;
  w: number;
  h: number;
  rot: number;
  vr: number;
  color: string;
  shape: "rect" | "dot";
  life: number;
  maxLife: number;
}

const DEFAULT_COLORS = ["#8b5cf6", "#a78bfa", "#64a7ff", "#c4b5fd", "#f4f4f6", "#7c3aed"];

export function burstConfetti({
  x,
  y,
  count = 84,
  colors = DEFAULT_COLORS,
  duration = 1500,
}: {
  x?: number;
  y?: number;
  count?: number;
  colors?: string[];
  duration?: number;
} = {}): void {
  if (typeof window === "undefined") return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

  const ox = x ?? window.innerWidth / 2;
  const oy = y ?? window.innerHeight * 0.38;

  const cvs = document.createElement("canvas");
  cvs.setAttribute("aria-hidden", "true");
  cvs.style.cssText =
    "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:9999";
  const ctx = cvs.getContext("2d");
  if (!ctx) return;
  document.body.appendChild(cvs);

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cvs.width = window.innerWidth * dpr;
  cvs.height = window.innerHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const motes: Mote[] = [];
  for (let i = 0; i < count; i++) {
    // fan upward, slight bias outward from center
    const ang = -Math.PI / 2 + (Math.random() - 0.5) * (Math.PI * 0.85);
    const sp = 4.5 + Math.random() * 6.5;
    motes.push({
      x: ox + (Math.random() - 0.5) * 14,
      y: oy + (Math.random() - 0.5) * 10,
      vx: Math.cos(ang) * sp * (Math.random() < 0.5 ? 1 : 1.15),
      vy: Math.sin(ang) * sp,
      w: 4 + Math.random() * 4,
      h: 2.5 + Math.random() * 3,
      rot: Math.random() * Math.PI * 2,
      vr: (Math.random() - 0.5) * 0.3,
      color: colors[(Math.random() * colors.length) | 0],
      shape: Math.random() < 0.72 ? "rect" : "dot",
      life: 0,
      maxLife: (duration * (0.72 + Math.random() * 0.4)) / 16.7,
    });
  }

  const t0 = performance.now();
  let raf = 0;
  const frame = (t: number) => {
    const elapsed = t - t0;
    let alive = false;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    for (const m of motes) {
      if (m.life >= m.maxLife) continue;
      alive = true;
      m.life += 1;
      m.vy += 0.16; // gravity
      m.vx *= 0.986; // drag
      m.vy *= 0.985;
      m.x += m.vx;
      m.y += m.vy;
      m.rot += m.vr;
      const lifeLeft = 1 - m.life / m.maxLife;
      const a = lifeLeft < 0.35 ? lifeLeft / 0.35 : 1;
      if (a <= 0.02) continue;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.translate(m.x, m.y);
      ctx.rotate(m.rot);
      ctx.fillStyle = m.color;
      if (m.shape === "rect") {
        ctx.fillRect(-m.w / 2, -m.h / 2, m.w, m.h);
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, m.w / 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    if (alive && elapsed < duration * 1.6) {
      raf = requestAnimationFrame(frame);
    } else {
      cvs.remove();
    }
  };
  raf = requestAnimationFrame(frame);

  // hard fail-safe: never leave the canvas on screen
  window.setTimeout(() => cvs.remove(), duration * 2 + 400);
}
