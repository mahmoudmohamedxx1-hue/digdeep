export const dynamic = "force-static";

/** P0-2: the site-wide OG card (1200×630 SVG) — /api/og-card */
export function GET() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0a0f0e"/>
      <stop offset="100%" stop-color="#04110f"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect x="3" y="3" width="1194" height="624" rx="24" fill="none" stroke="#0d9488" stroke-opacity="0.4" stroke-width="2"/>
  <text x="72" y="110" font-family="Georgia, 'Times New Roman', serif" font-size="40" fill="#e6fffa" font-weight="bold">DigDeep</text>
  <text x="72" y="146" font-family="system-ui, -apple-system, sans-serif" font-size="20" fill="#7dd3c8">deep research that shows its work</text>
  <line x1="72" y1="176" x2="1128" y2="176" stroke="#0d9488" stroke-opacity="0.4" stroke-width="1"/>
  <text x="72" y="268" font-family="Georgia, serif" font-size="48" fill="#f0fdfa" font-weight="600">The research tool that puts</text>
  <text x="72" y="328" font-family="Georgia, serif" font-size="48" fill="#f0fdfa" font-weight="600">its own answer on trial.</text>
  <rect x="72" y="378" rx="14" width="612" height="52" fill="#0d9488" fill-opacity="0.16"/>
  <text x="96" y="412" font-family="system-ui, sans-serif" font-size="24" fill="#5eead4" font-weight="700">PROSECUTOR · DEFENSE · JURY OF 12 · JUDGE</text>
  <text x="72" y="500" font-family="system-ui, sans-serif" font-size="21" fill="#94a3b8">Every claim checked · every citation audited · honest WITHHELD verdicts</text>
  <text x="72" y="556" font-family="system-ui, sans-serif" font-size="21" fill="#5eead4">Free · no API key · no account · exports to PDF / Word / Excel</text>
</svg>`;
  return new Response(svg, {
    headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400, s-maxage=604800" },
  });
}
