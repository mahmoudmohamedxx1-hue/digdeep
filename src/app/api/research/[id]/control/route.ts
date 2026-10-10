import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { researchRunner } from '@/lib/research/runner'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const body = (await req.json().catch(() => ({}))) as { action?: string }
  const action = body.action

  const job = await db.researchJob.findUnique({ where: { id }, select: { id: true, status: true } })
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  if (action === 'pause') {
    if (job.status !== 'running' || !researchRunner.isActive(id)) {
      return NextResponse.json({ error: 'Job is not running.' }, { status: 400 })
    }
    researchRunner.pause(id)
    return NextResponse.json({ ok: true, message: 'Pause requested — engine will halt at the next checkpoint.' })
  }

  if (action === 'resume') {
    if (job.status === 'completed') {
      return NextResponse.json({ error: 'Job already completed.' }, { status: 400 })
    }
    if (researchRunner.isActive(id)) {
      return NextResponse.json({ ok: true, message: 'Already running.' })
    }
    if (job.status === 'running') {
      // stale "running" flag without an active loop (e.g. after a crash)
      await db.researchJob.update({ where: { id }, data: { status: 'paused' } })
    }
    researchRunner.start(id)
    return NextResponse.json({ ok: true, message: 'Resuming from the last checkpoint.' })
  }

  if (action === 'stop') {
    if (researchRunner.isActive(id)) {
      researchRunner.stop(id)
      return NextResponse.json({ ok: true, message: 'Stop requested.' })
    }
    await db.researchJob.update({
      where: { id },
      data: { status: 'stopped', completedAt: new Date() },
    })
    return NextResponse.json({ ok: true, message: 'Job stopped.' })
  }

  return NextResponse.json({ error: 'Unknown action. Use pause|resume|stop.' }, { status: 400 })
}
