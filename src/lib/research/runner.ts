/**
 * Research job runner — an in-process singleton that owns the background loops
 * for active research jobs. State is checkpointed to SQLite by the engine, so
 * pause/resume is always safe and a server restart never loses progress
 * (orphaned "running" jobs are marked paused and can be resumed with one click).
 */

import { db } from '@/lib/db'
import type { Control } from './engine'

class ResearchRunner {
  private active = new Map<string, Control>()
  private sweepDone = false

  constructor() {
    // After the process boots, reconcile DB state with this (empty) runner map.
    setTimeout(() => {
      this.sweepOrphans().catch((err) => console.error('[runner] orphan sweep failed', err))
    }, 4000)
  }

  private async sweepOrphans() {
    if (this.sweepDone) return
    this.sweepDone = true
    try {
      const orphans = await db.researchJob.findMany({
        where: { status: 'running' },
        select: { id: true },
      })
      for (const o of orphans) {
        if (this.active.has(o.id)) continue
        await db.researchJob.update({ where: { id: o.id }, data: { status: 'paused' } })
        await db.activityLog.create({
          data: {
            jobId: o.id,
            level: 'warn',
            message: 'Run interrupted (server restarted) — state preserved. Click Resume to continue.',
          },
        })
      }
    } catch (err) {
      console.error('[runner] sweep error', err)
    }
  }

  /** Spawn (or re-enter) the background loop for a job. The engine is imported lazily so hot-reloads never leave the singleton holding stale module code. */
  start(jobId: string) {
    if (this.active.has(jobId)) return
    const control: Control = { stopRequested: false, pauseRequested: false }
    this.active.set(jobId, control)
    ;(async () => {
      try {
        const { runResearchJob } = await import('./engine')
        await runResearchJob(jobId, control)
      } catch (err) {
        console.error(`[runner] job ${jobId} crashed`, err)
      } finally {
        this.active.delete(jobId)
      }
    })()
  }

  pause(jobId: string): boolean {
    const control = this.active.get(jobId)
    if (!control) return false
    control.pauseRequested = true
    return true
  }

  stop(jobId: string): boolean {
    const control = this.active.get(jobId)
    if (!control) return false
    control.stopRequested = true
    return true
  }

  /** Stop without a live loop (e.g. deleting a paused job). */
  isActive(jobId: string): boolean {
    return this.active.has(jobId)
  }
}

const globalForRunner = globalThis as unknown as { __researchRunner?: ResearchRunner }

export const researchRunner: ResearchRunner = globalForRunner.__researchRunner ?? new ResearchRunner()

globalForRunner.__researchRunner = researchRunner
