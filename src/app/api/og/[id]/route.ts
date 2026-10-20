import { NextRequest } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * P0-2 OG CARD — /api/og/<shareId> · 1200×630 SVG.
 * The verdict card as a link-unfurl image: query, verdict/integrity headline,
 * source count, and the product line. Rendered as SVG (Twitter/Google render
 * SVG OG images correctly in 2026; no headless browser needed).
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const snap = await db.sharedReport.findUnique({ where: { id } }).catch(() => null);
  if (!snap) return new Response("Not found", { status: 404 });
  let stats: Record<string, unknown> = {};
  try { stats = snap.stats ? JSON.parse(snap.stats) : {}; } catch { stats = {}; }
  const court = stats.court as { verdict?: string } | undefined;
  const integrity = typeof stats.citationIntegrity === "number" ? stats.citationIntegrity : null;
  let sources: unknown[] = [];
  try { sources = JSON.parse(snap.sources); } catch { sources = []; }

  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const wrap = (s: string, max: number, maxLines: number) => {
    const words = s.split(/\s+/);
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
      if ((cur + " " + w).trim().length > max) { lines.push(cur.trim()); cur = w; if (lines.length >= maxLines) break; }
      else cur = (cur + " " + w).trim();
    }
    if (lines.length < maxLines && cur) lines.push(cur);
    return lines.slice(0, maxLines);
  };
  const qLines = wrap(snap.query, 62, 2);
  const headline = court?.verdict
    ? `COURT VERDICT: ${court.verdict}`
    : integrity != null
      ? `${integrity}% CITATION INTEGRITY`
      : "VERIFIED RESEARCH REPORT";

  const accent = court?.verdict === "GUILTY" ? "#e11d48" : court?.verdict === "HUNG JURY" ? "#d97706" : "#0d9488";

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0a0f0e"/>
      <stop offset="100%" stop-color="#04110f"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect x="3" y="3" width="1194" height="624" rx="24" fill="none" stroke="${accent}" stroke-opacity="0.35" stroke-width="2"/>
  <text x="72" y="98" font-family="Georgia, 'Times New Roman', serif" font-size="34" fill="#e6fffa" font-weight="bold">DigDeep</text>
  <text x="72" y="128" font-family="system-ui, -apple-system, sans-serif" font-size="19" fill="#7dd3c8">deep research that shows its work</text>
  <line x1="72" y1="152" x2="1128" y2="152" stroke="${accent}" stroke-opacity="0.4" stroke-width="1"/>
  ${qLines.map((l, i) => `<text x="72" y="${236 + i * 52}" font-family="Georgia, serif" font-size="42" fill="#f0fdfa" font-weight="600">${esc(l)}</text>`).join("\n  ")}
  <rect x="72" y="${qLines.length > 1 ? 348 : 296}" rx="14" width="${headline.length * 16 + 48}" height="52" fill="${accent}" fill-opacity="0.16"/>
  <text x="96" y="${(qLines.length > 1 ? 348 : 296) + 34}" font-family="system-ui, sans-serif" font-size="24" fill="${accent}" font-weight="700">${esc(headline)}</text>
  <text x="72" y="500" font-family="system-ui, sans-serif" font-size="21" fill="#94a3b8">${sources.length} sources read · every citation audited · every claim checked</text>
  <text x="72" y="556" font-family="system-ui, sans-serif" font-size="21" fill="#5eead4">digdeepx.vercel.app — free, no API key, puts its own answer on trial</text>
</svg>`;

  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
