import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const report = await db.report.findUnique({ where: { jobId: id } })
  if (!report) return NextResponse.json({ error: 'Report not ready yet' }, { status: 404 })

  let references: { n: number; title: string; domain: string; url: string }[] = []
  let sections: { title: string; words: number }[] = []
  try {
    references = report.references ? JSON.parse(report.references) : []
    sections = report.sections ? JSON.parse(report.sections) : []
  } catch {
    // keep defaults
  }

  return NextResponse.json({
    report: {
      jobId: id,
      title: report.title,
      markdown: report.markdown,
      wordCount: report.wordCount,
      sections,
      references,
      createdAt: report.createdAt,
    },
  })
}
