import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import PDFDocument from "pdfkit";

export const dynamic = "force-dynamic";

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "research";
}

/** Inline formatter: **bold**, *italic*, `code`, [n] citations -> pdf text runs */
function runs(text: string): { text: string; bold?: boolean; italic?: boolean; code?: boolean; sup?: boolean; link?: boolean }[] {
  const out: { text: string; bold?: boolean; italic?: boolean; code?: boolean; sup?: boolean; link?: boolean }[] = [];
  const re = /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[(\d+)\]|((?:https?:\/\/)[^\s)]+))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    if (m[2] !== undefined) out.push({ text: m[2], bold: true });
    else if (m[3] !== undefined) out.push({ text: m[3], italic: true });
    else if (m[4] !== undefined) out.push({ text: m[4], code: true });
    else if (m[5] !== undefined) out.push({ text: `[${m[5]}]`, sup: true });
    else if (m[6] !== undefined) out.push({ text: m[6], link: true });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const format = req.nextUrl.searchParams.get("format") ?? "md";
  const job = await db.researchJob.findUnique({ where: { id } });
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const base = `deepresearch-${slug(job.query)}`;

  if (format === "json") {
    const [events, sources, sections] = await Promise.all([
      db.activityEvent.findMany({ where: { jobId: id }, orderBy: { seq: "asc" } }),
      db.source.findMany({ where: { jobId: id } }),
      db.researchSection.findMany({ where: { jobId: id }, orderBy: { order: "asc" } }),
    ]);
    const payload = {
      job: { id: job.id, query: job.query, status: job.status, preset: job.preset, language: job.language, modelPref: job.modelPref, breadth: job.breadth, depth: job.depth, maxSources: job.maxSources, maxMinutes: job.maxMinutes, createdAt: job.createdAt, completedAt: job.completedAt, stats: job.stats ? JSON.parse(job.stats) : null },
      plan: job.plan ? JSON.parse(job.plan) : null,
      sections,
      sources,
      events,
      reportMarkdown: job.reportMd,
    };
    return new NextResponse(JSON.stringify(payload, null, 2), {
      headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${base}.json"` },
    });
  }

  if (!job.reportMd) return NextResponse.json({ error: "Report not ready yet" }, { status: 400 });

  if (format === "pdf") {
    // pdfkit streams synchronously into buffers; wrap properly
    const doc = new PDFDocument({ size: "A4", margins: { top: 56, bottom: 64, left: 56, right: 56 }, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    const doneP = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));
    const W = doc.page.width - 112;
    const writeRuns = (text: string, size: number, color = "#222", indent = 0) => {
      for (const r of runs(text)) {
        doc.font(r.code ? "Courier" : r.bold ? "Helvetica-Bold" : r.italic ? "Helvetica-Oblique" : "Helvetica");
        doc.fontSize(r.sup ? Math.max(7, size - 3) : size);
        doc.fillColor(r.sup ? "#20808D" : r.link ? "#20808D" : color);
        doc.text(r.text, indent > 0 ? 56 + indent : undefined, undefined, { width: indent > 0 ? W - indent : W, underline: r.link, link: r.link ? r.text : undefined });
      }
    };
    const lines = job.reportMd.split("\n");
    let inCode = false;
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, "");
      if (doc.y > doc.page.height - 100) doc.addPage();
      if (line.startsWith("```")) { inCode = !inCode; continue; }
      if (inCode) { doc.font("Courier").fontSize(8.5).fillColor("#444").text(line, { width: W }); continue; }
      if (!line.trim()) { doc.moveDown(0.5); continue; }
      if (line.startsWith("# ")) { doc.font("Helvetica-Bold").fontSize(21).fillColor("#111").text(line.slice(2), { width: W }); doc.moveDown(0.6); }
      else if (line.startsWith("## ")) { doc.moveDown(0.8); doc.font("Helvetica-Bold").fontSize(14.5).fillColor("#111").text(line.slice(3), { width: W }); doc.moveDown(0.35); }
      else if (line.startsWith("### ")) { doc.moveDown(0.5); doc.font("Helvetica-Bold").fontSize(11.5).fillColor("#20808D").text(line.slice(4), { width: W }); doc.moveDown(0.25); }
      else if (/^>\s?/.test(line)) { writeRuns(line.replace(/^>\s?/, ""), 9.5, "#555"); doc.moveDown(0.3); }
      else if (/^([-*•]|\d+\.)\s/.test(line)) {
        const bm = line.match(/^([-*•]|\d+\.)\s+(.*)$/)!;
        const marker = /^[-*•]$/.test(bm[1]) ? "•" : bm[1];
        doc.font("Helvetica").fontSize(10).fillColor("#20808D").text(marker, 62, undefined, { width: 14 });
        writeRuns(bm[2], 10, "#222", 20);
        doc.moveDown(0.15);
      } else if (line.trim() === "---") { doc.moveDown(0.4); doc.moveTo(56, doc.y).lineTo(doc.page.width - 56, doc.y).strokeColor("#ddd").stroke(); doc.moveDown(0.6); }
      else { writeRuns(line, 10); doc.moveDown(0.25); }
    }
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.font("Helvetica").fontSize(8).fillColor("#999").text(`DeepResearch · ${job.query.slice(0, 60)} · ${i + 1}`, 56, doc.page.height - 40, { width: W, align: "center" });
    }
    doc.end();
    const buf = await doneP;
    return new NextResponse(new Uint8Array(buf), {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${base}.pdf"` },
    });
  }

  // default: markdown
  return new NextResponse(job.reportMd, {
    headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="${base}.md"` },
  });
}
