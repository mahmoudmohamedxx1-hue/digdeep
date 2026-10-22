import { NextRequest } from "next/server";
import { ImageResponse } from "next/og";
import { db } from "@/lib/db";
import type { ReactElement } from "react";

export const dynamic = "force-dynamic";

/**
 * P0-2 OG CARD — /api/og/<shareId> · 1200×630 PNG.
 * The verdict card as a link-unfurl image: query, verdict/integrity headline,
 * source count, and the product line.
 *
 * PNG via next/og (satori + resvg, no headless browser, no new deps). The
 * bundled Noto fonts cover Latin and CJK — verified by VLM on rendered
 * output. PNG (not SVG) because the platforms that account for nearly all
 * shares — X ("SVG is not supported", per Twitter Cards docs), Meta/WhatsApp,
 * LinkedIn — only fetch JPG/PNG/WEBP og:images; an SVG og:image renders
 * imageless cards there.
 *
 * SCRIPT DEGRADATION LADDER: satori's shaper throws on Arabic GSUB lookups
 * (lookupType 5 substFormat 3 — character-dependent, both bundled and custom
 * fonts). Arabic-script queries therefore render the card WITHOUT the query
 * text (the query still reaches platforms via og:title/og:description, which
 * they render themselves); any other un anticipated shaping failure gets the
 * same treatment via try/catch; a final SVG fallback guarantees a 200.
 */
const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

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

  const headline = court?.verdict
    ? `COURT VERDICT: ${court.verdict}`
    : integrity != null
      ? `${integrity}% CITATION INTEGRITY`
      : "VERIFIED RESEARCH REPORT";

  const accent = court?.verdict === "GUILTY" ? "#e11d48" : court?.verdict === "HUNG JURY" ? "#d97706" : "#0d9488";
  const hasArabic = ARABIC_RE.test(snap.query);

  const card = (showQuery: boolean): ReactElement => (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        padding: "56px 72px",
        backgroundImage: "linear-gradient(135deg, #0a0f0e 0%, #04110f 100%)",
        border: `3px solid ${accent}59`,
        borderRadius: 24,
        justifyContent: "space-between",
      }}
    >
      {/* header */}
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 18 }}>
          <span style={{ fontSize: 40, fontWeight: 700, color: "#e6fffa" }}>DigDeep</span>
          <span style={{ fontSize: 21, color: "#7dd3c8" }}>deep research that shows its work</span>
        </div>
        <div style={{ marginTop: 18, height: 2, width: "100%", backgroundColor: `${accent}66` }} />
      </div>

      {/* the question — or, when the script cannot be shaped (Arabic), the headline as the big line */}
      {showQuery ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            fontSize: 46,
            fontWeight: 600,
            color: "#f0fdfa",
            lineHeight: 1.25,
            maxHeight: 240,
            overflow: "hidden",
          }}
        >
          {snap.query}
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            fontSize: 56,
            fontWeight: 700,
            color: "#f0fdfa",
            lineHeight: 1.2,
          }}
        >
          {court?.verdict ?? "VERIFIED RESEARCH REPORT"}
        </div>
      )}

      {/* verdict pill + stats */}
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <div
          style={{
            display: "flex",
            alignSelf: "flex-start",
            padding: "12px 24px",
            borderRadius: 14,
            backgroundColor: `${accent}29`,
            color: accent,
            fontSize: 25,
            fontWeight: 700,
          }}
        >
          {showQuery ? headline : integrity != null ? `${integrity}% CITATION INTEGRITY` : "EVERY CLAIM CHECKED"}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={{ fontSize: 22, color: "#94a3b8" }}>
            {sources.length} sources read · every citation audited · every claim checked
          </span>
          <span style={{ fontSize: 22, color: "#5eead4" }}>
            digdeepx.vercel.app — free, no LLM keys, puts its own answer on trial
          </span>
        </div>
      </div>
    </div>
  );

  const renderPng = async (showQuery: boolean): Promise<Response> => {
    const r = new ImageResponse(card(showQuery), { width: 1200, height: 630 });
    const buf = await r.arrayBuffer(); // forces the render — shaping errors throw here, not in the constructor
    return new Response(buf, {
      headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600, s-maxage=86400" },
    });
  };

  try {
    return await renderPng(!hasArabic);
  } catch {
    try {
      return await renderPng(false);
    } catch {
      // absolute last resort: the SVG variant (browsers render it; scrapers that
      // demand raster simply show no image) — never a 500 on a share URL.
      const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      return new Response(
        `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="#04110f"/><rect x="3" y="3" width="1194" height="624" rx="24" fill="none" stroke="${accent}" stroke-opacity="0.35" stroke-width="2"/><text x="72" y="98" font-family="Georgia, serif" font-size="34" fill="#e6fffa" font-weight="bold">DigDeep</text><text x="72" y="330" font-family="Georgia, serif" font-size="42" fill="#f0fdfa" font-weight="600">${esc(snap.query.slice(0, 60))}</text><text x="72" y="420" font-family="system-ui, sans-serif" font-size="26" fill="${accent}" font-weight="700">${esc(headline)}</text><text x="72" y="500" font-family="system-ui, sans-serif" font-size="21" fill="#94a3b8">${sources.length} sources read · every citation audited · every claim checked</text></svg>`,
        { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=3600, s-maxage=86400" } },
      );
    }
  }
}
