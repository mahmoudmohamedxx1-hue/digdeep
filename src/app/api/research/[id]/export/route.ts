import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import PDFDocument from "pdfkit";
import {
  AlignmentType, Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow,
  TextRun, WidthType, ExternalHyperlink, BorderStyle, type IRunOptions,
} from "docx";
import ExcelJS from "exceljs";
import { canAccessJob } from "@/lib/research/access";

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
  // v3.4.1 AUDIT FIX: exports carry the full report (format=json adds plan,
  // events, sections) — owned runs need the owner (session or Bearer key with
  // research:read, matching the OpenAPI spec's security claim) or an explicit
  // share. Anonymous runs stay keyless-open. Fixes a silent ownership bypass
  // that contradicted v1's 404 isolation.
  if (!(await canAccessJob(req, job))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const base = `deepresearch-${slug(job.query)}`;

  if (format === "json") {
    const [events, sources, sections] = await Promise.all([
      db.activityEvent.findMany({ where: { jobId: id }, orderBy: { seq: "asc" } }),
      db.source.findMany({ where: { jobId: id }, orderBy: { createdAt: "asc" } }),
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

  if (format === "docx") {
    /* v3.2 — Word export: full report with headings, inline formatting,
       citation chips as superscripts, verdict + quality tables, source table. */
    const stats = job.stats ? (JSON.parse(job.stats) as NonNullable<import("@/components/research/types").JobItem["stats"]>) : null;
    const [srcRows, secRows] = await Promise.all([
      db.source.findMany({ where: { jobId: id }, orderBy: { createdAt: "asc" } }),
      db.researchSection.findMany({ where: { jobId: id }, orderBy: { order: "asc" } }),
    ]);

    // inline markdown → docx TextRun children (**bold**, *italic*, `code`, [n] → superscript)
    const docxRuns = (text: string, base: IRunOptions = { size: 22 }): (TextRun | ExternalHyperlink)[] => {
      const out: (TextRun | ExternalHyperlink)[] = [];
      const re = /(\*\*([^*]+)\*\*|\*([^*\n]+)\*|`([^`]+)`|\[(\d+)\]|((?:https?:\/\/)[^\s)]+))/g;
      let last = 0;
      let m: RegExpExecArray | null;
      const push = (t: string, extra: IRunOptions = {}) => {
        if (t) out.push(new TextRun({ text: t, ...base, ...extra }));
      };
      while ((m = re.exec(text))) {
        push(text.slice(last, m.index));
        if (m[2] !== undefined) push(m[2], { bold: true });
        else if (m[3] !== undefined) push(m[3], { italics: true });
        else if (m[4] !== undefined) push(m[4], { font: "Consolas", color: "444444", size: 20 });
        else if (m[5] !== undefined) push(`[${m[5]}]`, { superScript: true, color: "0F766E", bold: true });
        else if (m[6] !== undefined)
          out.push(new ExternalHyperlink({ link: m[6], children: [new TextRun({ text: m[6], ...base, style: "Hyperlink" })] }));
        last = re.lastIndex;
      }
      push(text.slice(last));
      return out;
    };

    const children: (Paragraph | Table)[] = [];
    children.push(new Paragraph({ text: job.query, heading: HeadingLevel.TITLE, spacing: { after: 120 } }));
    const metaBits = [
      new Date(job.createdAt).toLocaleDateString(),
      stats?.court ? "Court trial" : job.mode === "chat" ? "Chat" : "Deep research",
      `${srcRows.length} sources`,
      stats?.reportWords ? `${stats.reportWords.toLocaleString()} words` : null,
      stats?.quality ? `self-scored ${stats.quality.overall}/10` : null,
    ].filter(Boolean);
    children.push(new Paragraph({ children: [new TextRun({ text: metaBits.join(" · "), color: "666666", size: 19 })], spacing: { after: 240 } }));

    if (stats?.court) {
      const c = stats.court;
      children.push(new Paragraph({ children: [new TextRun({ text: `VERDICT: ${c.verdict} (${c.guilty}–${c.notGuilty})`, bold: true, size: 26, color: "0F766E" })], spacing: { after: 60 } }));
      children.push(new Paragraph({ children: docxRuns(c.judgeSummary || "", { size: 20, italics: true, color: "444444" }), spacing: { after: 240 } }));
    }

    let inCode = false;
    for (const raw of job.reportMd.split("\n")) {
      const line = raw.replace(/\s+$/, "");
      if (line.startsWith("```")) { inCode = !inCode; continue; }
      if (inCode) { children.push(new Paragraph({ children: [new TextRun({ text: line || " ", font: "Consolas", size: 18, color: "333333" })], spacing: { after: 40 } })); continue; }
      if (!line.trim()) { children.push(new Paragraph({ text: "", spacing: { after: 100 } })); continue; }
      if (line.startsWith("# ")) children.push(new Paragraph({ text: line.slice(2), heading: HeadingLevel.HEADING_1, spacing: { before: 280, after: 120 } }));
      else if (line.startsWith("## ")) children.push(new Paragraph({ text: line.slice(3), heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 100 } }));
      else if (line.startsWith("### ")) children.push(new Paragraph({ text: line.slice(4), heading: HeadingLevel.HEADING_3, spacing: { before: 200, after: 80 } }));
      else if (/^>\s?/.test(line)) children.push(new Paragraph({ children: docxRuns(line.replace(/^>\s?/, ""), { size: 20, italics: true, color: "555555" }), indent: { left: 360 }, spacing: { after: 80 } }));
      else if (/^([-*•]|\d+\.)\s/.test(line)) {
        const bm = line.match(/^([-*•]|\d+\.)\s+(.*)$/)!;
        children.push(new Paragraph({ children: docxRuns(bm[2]), bullet: { level: 0 }, spacing: { after: 60 } }));
      }
      else if (line.trim() === "---") children.push(new Paragraph({ text: "", border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "DDDDDD" } }, spacing: { after: 160 } }));
      else children.push(new Paragraph({ children: docxRuns(line), spacing: { after: 100 } }));
    }

    if (stats?.quality?.dims?.length) {
      children.push(new Paragraph({ text: "Quality self-assessment", heading: HeadingLevel.HEADING_2, spacing: { before: 320, after: 120 } }));
      children.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({ children: [new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "Dimension", bold: true })] })] }), new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "Score", bold: true })] })] }), new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "Note", bold: true })] })] })] }),
          ...stats.quality.dims.map((d) => new TableRow({ children: [
            new TableCell({ children: [new Paragraph({ text: d.name })] }),
            new TableCell({ children: [new Paragraph({ text: String(d.score) })] }),
            new TableCell({ children: [new Paragraph({ text: d.note })] }),
          ] })),
        ],
      }));
    }

    if (srcRows.length > 0) {
      children.push(new Paragraph({ text: "Sources", heading: HeadingLevel.HEADING_1, spacing: { before: 360, after: 120 } }));
      children.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({ children: [new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "#", bold: true })] })] }), new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "Title", bold: true })] })] }), new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "Domain", bold: true })] })] }), new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "URL", bold: true })] })] })] }),
          ...srcRows.map((s, i) => new TableRow({ children: [
            new TableCell({ children: [new Paragraph({ text: String(i + 1) })] }),
            new TableCell({ children: [new Paragraph({ text: s.title })] }),
            new TableCell({ children: [new Paragraph({ text: s.domain })] }),
            new TableCell({ children: [new Paragraph({ children: [new ExternalHyperlink({ link: s.url, children: [new TextRun({ text: s.url, style: "Hyperlink", size: 16 })] })] })] }),
          ] })),
        ],
      }));
    }

    const doc = new Document({ sections: [{ children }] });
    const buf = await Packer.toBuffer(doc);
    return new NextResponse(new Uint8Array(buf), {
      headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "Content-Disposition": `attachment; filename="${base}.docx"` },
    });
  }

  if (format === "xlsx") {
    /* v3.2 — Excel export: Report sheet (metadata + per-section findings),
       Sources sheet, Claims sheet (the verification ledger). */
    const stats = job.stats ? (JSON.parse(job.stats) as NonNullable<import("@/components/research/types").JobItem["stats"]>) : null;
    const [srcRows, secRows] = await Promise.all([
      db.source.findMany({ where: { jobId: id }, orderBy: { createdAt: "asc" } }),
      db.researchSection.findMany({ where: { jobId: id }, orderBy: { order: "asc" } }),
    ]);
    const wb = new ExcelJS.Workbook();
    wb.creator = "DigDeep";
    wb.created = new Date();

    const rep = wb.addWorksheet("Report", { views: [{ state: "frozen", ySplit: 1 }] });
    rep.columns = [
      { header: "Field", key: "k", width: 22 },
      { header: "Value", key: "v", width: 100 },
    ];
    rep.getRow(1).font = { bold: true };
    const meta: [string, string | number][] = [
      ["Question", job.query],
      ["Date", new Date(job.createdAt).toLocaleString()],
      ["Mode", stats?.court ? "Court trial" : job.mode === "chat" ? "Chat" : "Deep research"],
      ["Status", job.status],
      ["Preset", job.preset],
      ["Breadth / Depth", `${job.breadth} / ${job.depth}`],
      ["Sources consulted", stats?.sourcesConsulted ?? srcRows.length],
      ["Report words", stats?.reportWords ?? 0],
      ["Citation integrity", stats?.citationIntegrity != null ? `${Math.round(stats.citationIntegrity * 100)}%` : "—"],
      ["Self-scored quality", stats?.quality ? `${stats.quality.overall}/10` : "—"],
      ["Biggest weakness", stats?.quality?.biggestWeakness ?? "—"],
    ];
    if (stats?.court) meta.push(["Verdict", `${stats.court.verdict} (${stats.court.guilty}–${stats.court.notGuilty})`], ["Judge's summary", stats.court.judgeSummary]);
    meta.forEach(([k, v]) => rep.addRow({ k, v }));
    for (const s of secRows) {
      rep.addRow({ k: `Section: ${s.title}`, v: s.findings });
    }

    const src = wb.addWorksheet("Sources", { views: [{ state: "frozen", ySplit: 1 }] });
    src.columns = [
      { header: "#", key: "n", width: 5 },
      { header: "Title", key: "title", width: 52 },
      { header: "Domain", key: "domain", width: 22 },
      { header: "URL", key: "url", width: 60 },
      { header: "Words read", key: "words", width: 11 },
      { header: "Quality", key: "quality", width: 9 },
      { header: "Audit", key: "audit", width: 24 },
    ];
    src.getRow(1).font = { bold: true };
    srcRows.forEach((s, i) => {
      const flags: string[] = [];
      if (stats?.citationAudit?.reanchoredTo?.includes(i + 1)) flags.push("re-anchored");
      if (stats?.citationAudit?.dropped?.includes(i + 1)) flags.push("dropped");
      if (stats?.citationAudit?.flagged?.includes(i + 1)) flags.push("flagged");
      src.addRow({ n: i + 1, title: s.title, domain: s.domain, url: s.url, words: s.words, quality: s.quality, audit: flags.join(", ") || "clean" });
    });
    src.getColumn("url").eachCell((c) => { if (typeof c.value === "string" && c.value.startsWith("http")) { const v = c.value as string; c.value = { text: v, hyperlink: v }; } });

    if (stats?.claimChecks?.length) {
      const cl = wb.addWorksheet("Claims", { views: [{ state: "frozen", ySplit: 1 }] });
      cl.columns = [
        { header: "Claim", key: "claim", width: 70 },
        { header: "Verdict", key: "verdict", width: 14 },
        { header: "Support", key: "support", width: 9 },
        { header: "Closeness", key: "close", width: 11 },
        { header: "Source", key: "source", width: 40 },
        { header: "Section", key: "section", width: 26 },
      ];
      cl.getRow(1).font = { bold: true };
      stats.claimChecks.forEach((c) => {
        cl.addRow({ claim: c.text, verdict: c.verdict, support: `${Math.round(c.support * 100)}%`, close: c.closeness, source: c.sourceTitle, section: c.section });
      });
    }

    const buf = await wb.xlsx.writeBuffer();
    return new NextResponse(new Uint8Array(buf as ArrayBuffer), {
      headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="${base}.xlsx"` },
    });
  }

  // default: markdown
  return new NextResponse(job.reportMd, {
    headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="${base}.md"` },
  });
}
