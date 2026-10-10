'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { toast } from '@/hooks/use-toast'
import { api, formatDuration, timeAgo, type JobDetail } from '@/lib/research-client'
import { ReportView } from './report-view'
import {
  ArrowLeft, Pause, Play, Square, Trash2, Loader2, Compass, Search, ShieldCheck, PenLine,
  CheckCircle2, CircleDashed, CircleHelp, ListChecks, Globe, BookOpen, FlaskConical,
  MessagesSquare, Brain, FileWarning, ChevronDown, Activity as ActivityIcon, ExternalLink,
} from 'lucide-react'

const STATUS_STYLE: Record<string, string> = {
  queued: 'border-zinc-600/50 bg-zinc-800/60 text-zinc-300',
  running: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  paused: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  completed: 'border-emerald-500/60 bg-emerald-500/20 text-emerald-300',
  failed: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
  stopped: 'border-zinc-600/50 bg-zinc-800/60 text-zinc-400',
}

const ENGINE_ICON: Record<string, typeof Globe> = {
  web: Globe,
  wikipedia: BookOpen,
  arxiv: FlaskConical,
  hn: MessagesSquare,
}

const PHASE_STEPS = [
  { id: 'planning', label: 'Plan', icon: Compass },
  { id: 'research', label: 'Research', icon: Search },
  { id: 'critique', label: 'Critique', icon: ShieldCheck },
  { id: 'synthesis', label: 'Write', icon: PenLine },
]

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold capitalize ${
        STATUS_STYLE[status] || STATUS_STYLE.queued
      }`}
    >
      {status === 'running' && <Loader2 className="h-3 w-3 animate-spin" />}
      {status}
    </span>
  )
}

function StatCard({ label, value, sub, icon: Icon }: { label: string; value: string; sub?: string; icon: typeof Globe }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
        <Icon className="h-3.5 w-3.5" /> {label}
      </div>
      <div className="mt-1 text-lg font-bold text-zinc-100">{value}</div>
      {sub && <div className="text-[11px] text-zinc-500">{sub}</div>}
    </div>
  )
}

function QuestionRow({ q }: { q: JobDetail['subQuestions'][number] }) {
  const [open, setOpen] = useState(false)
  const icon =
    q.status === 'answered' ? (
      <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
    ) : q.status === 'researching' ? (
      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-emerald-400" />
    ) : q.status === 'skipped' ? (
      <CircleHelp className="h-4 w-4 shrink-0 text-zinc-600" />
    ) : (
      <CircleDashed className="h-4 w-4 shrink-0 text-zinc-500" />
    )
  return (
    <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2.5 p-3 text-left"
        aria-expanded={open}
      >
        {icon}
        <span className="flex-1 text-sm leading-snug text-zinc-200">{q.text}</span>
        <span className="flex shrink-0 items-center gap-1.5">
          {q.origin !== 'planner' && (
            <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-400">
              {q.origin}
            </Badge>
          )}
          {q.answer && <ChevronDown className={`h-4 w-4 text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`} />}
        </span>
      </button>
      {open && q.answer && (
        <div className="border-t border-zinc-800/80 p-3 text-sm leading-relaxed text-zinc-400">{q.answer}</div>
      )}
    </div>
  )
}

export function JobView({ jobId, onBack }: { jobId: string; onBack: () => void }) {
  const [data, setData] = useState<JobDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const statusRef = useRef<string>('queued')

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/research/${jobId}`)
      if (res.ok) {
        const d = (await res.json()) as JobDetail
        setData(d)
        statusRef.current = d.job.status
        setError(null)
        return d.job.status
      }
      if (res.status === 404) setError('This research job no longer exists.')
      return 'error'
    } catch {
      return 'error'
    }
  }, [jobId])

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const loop = async () => {
      const status = await poll()
      if (!alive) return
      if (status === 'running' || status === 'queued') timer = setTimeout(loop, 2500)
      else if (status === 'paused') timer = setTimeout(loop, 6000)
      // completed / stopped / failed / error → stop polling
    }
    loop()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [poll])

  const control = async (action: 'pause' | 'resume' | 'stop') => {
    setBusy(action)
    try {
      const res = await api<{ message?: string }>(`/api/research/${jobId}/control`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      })
      toast({ title: res.message || `Action "${action}" sent.` })
      setTimeout(poll, 800)
    } catch (err) {
      toast({ title: 'Action failed', description: err instanceof Error ? err.message : '', variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    setBusy('delete')
    try {
      await api(`/api/research/${jobId}`, { method: 'DELETE' })
      toast({ title: 'Research job deleted.' })
      onBack()
    } catch (err) {
      toast({ title: 'Delete failed', description: err instanceof Error ? err.message : '', variant: 'destructive' })
      setBusy(null)
    }
  }

  if (error) {
    return (
      <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-6 text-center">
        <FileWarning className="mx-auto h-8 w-8 text-rose-400" />
        <p className="mt-2 text-zinc-300">{error}</p>
        <Button onClick={onBack} variant="outline" className="mt-4 border-zinc-700 bg-transparent text-zinc-300 hover:bg-zinc-800">
          <ArrowLeft className="mr-2 h-4 w-4" /> Back to dashboard
        </Button>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900/60 p-16">
        <Loader2 className="h-6 w-6 animate-spin text-emerald-400" />
      </div>
    )
  }

  const { job, subQuestions, sources, logs, counters } = data
  const running = job.status === 'running'
  const stats = job.stats
  const phaseIdx = PHASE_STEPS.findIndex((p) => p.id === job.phase)
  const sections = job.outline?.sections || []
  const questionsBySection = sections.length
    ? sections.map((s) => ({ section: s.title, qs: subQuestions.filter((q) => q.section === s.title) }))
    : [{ section: 'Research questions', qs: subQuestions }]
  const activePhase = job.phase === 'done' ? 3 : phaseIdx

  return (
    <div className="space-y-4">
      {/* header */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <Button
              onClick={onBack}
              variant="outline"
              size="sm"
              className="mt-0.5 border-zinc-700 bg-transparent text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
              aria-label="Back to dashboard"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div className="min-w-0">
              <h1 className="text-lg font-bold leading-snug text-zinc-50 sm:text-xl">{job.topic}</h1>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                <StatusBadge status={job.status} />
                <span className="rounded-full border border-zinc-700/60 px-2 py-0.5 capitalize">{job.depth}</span>
                <span className="rounded-full border border-zinc-700/60 px-2 py-0.5">{job.language}</span>
                <span>started {timeAgo(job.createdAt)}</span>
                <span>·</span>
                <span>{formatDuration(job.startedAt, job.completedAt)} elapsed</span>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {running && (
              <>
                <Button size="sm" variant="outline" disabled={!!busy} onClick={() => control('pause')} className="border-amber-500/40 bg-transparent text-amber-300 hover:bg-amber-500/10">
                  {busy === 'pause' ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Pause className="mr-1.5 h-3.5 w-3.5" />}
                  Pause
                </Button>
                <Button size="sm" variant="outline" disabled={!!busy} onClick={() => control('stop')} className="border-rose-500/40 bg-transparent text-rose-300 hover:bg-rose-500/10">
                  {busy === 'stop' ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Square className="mr-1.5 h-3.5 w-3.5" />}
                  Stop
                </Button>
              </>
            )}
            {(job.status === 'paused' || job.status === 'stopped' || job.status === 'failed' || job.status === 'queued') && job.status !== 'completed' && (
              <>
                {job.status !== 'completed' && (
                  <Button size="sm" disabled={!!busy} onClick={() => control('resume')} className="bg-emerald-500 text-zinc-950 hover:bg-emerald-400">
                    {busy === 'resume' ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1.5 h-3.5 w-3.5" />}
                    {job.status === 'paused' ? 'Resume' : 'Start'}
                  </Button>
                )}
              </>
            )}
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="outline" disabled={!!busy} className="border-zinc-700 bg-transparent text-zinc-400 hover:bg-zinc-800 hover:text-rose-300" aria-label="Delete job">
                  {busy === 'delete' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent className="border-zinc-700 bg-zinc-900 text-zinc-200">
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this research job?</AlertDialogTitle>
                  <AlertDialogDescription className="text-zinc-400">
                    All findings, sources, logs and the report will be permanently removed. This cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel className="border-zinc-700 bg-transparent text-zinc-300 hover:bg-zinc-800">Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={remove} className="bg-rose-500 text-white hover:bg-rose-400">
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>

        {/* progress + phases */}
        <div className="mt-4">
          <div className="mb-1.5 flex items-center justify-between text-xs">
            <span className="font-medium text-zinc-400">
              {job.phase === 'done' ? 'Complete' : `Phase: ${job.phase}`} · iteration {job.iteration}
              {job.critiqueRound > 0 ? ` · critique round ${job.critiqueRound}` : ''}
            </span>
            <span className="font-mono text-emerald-400">{job.progress}%</span>
          </div>
          <Progress value={job.progress} className="h-2 bg-zinc-800 [&>div]:bg-gradient-to-r [&>div]:from-emerald-600 [&>div]:to-emerald-400" />
          <div className="mt-3 grid grid-cols-4 gap-1.5">
            {PHASE_STEPS.map((p, i) => {
              const Icon = p.icon
              const done = activePhase > i
              const current = activePhase === i && job.status !== 'completed'
              return (
                <div
                  key={p.id}
                  className={`flex items-center justify-center gap-1.5 rounded-md border px-1 py-1.5 text-[11px] font-medium sm:text-xs ${
                    current
                      ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300'
                      : done
                        ? 'border-emerald-500/20 bg-emerald-500/5 text-emerald-500/80'
                        : 'border-zinc-800 bg-zinc-950/40 text-zinc-600'
                  }`}
                >
                  {current ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
                  {p.label}
                </div>
              )
            })}
          </div>
        </div>

        {job.error && (
          <div className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">
            {job.error}
          </div>
        )}

        {/* stats */}
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <StatCard label="Questions" value={`${counters.questionsAnswered}/${counters.questionsTotal}`} sub="answered" icon={ListChecks} />
          <StatCard label="Sources" value={`${counters.found}`} sub={`${counters.summarized} digested`} icon={Globe} />
          <StatCard label="Page reads" value={`${stats?.fetches ?? 0}`} sub={`${stats?.fetchFailures ?? 0} failed`} icon={Search} />
          <StatCard label="Searches" value={`${stats?.searches ?? 0}`} sub={Object.entries(stats?.engineMix || {}).map(([k, v]) => `${k}:${v}`).join(' ') || '—'} icon={Globe} />
          <StatCard label="LLM calls" value={`${stats?.llmCalls ?? 0}`} sub={Object.entries(stats?.providerMix || {}).map(([k, v]) => `${k}×${v}`).join(' ') || 'keyless'} icon={Brain} />
          <StatCard label="Learnings" value={`${stats?.learnings ?? 0}`} sub="extracted facts" icon={CheckCircle2} />
        </div>
      </div>

      {/* tabs */}
      <Tabs defaultValue={job.reportExists ? 'report' : 'overview'} className="w-full">
        <TabsList className="bg-zinc-900/80 text-zinc-400">
          <TabsTrigger value="overview" className="data-[state=active]:bg-zinc-800 data-[state=active]:text-emerald-300">Questions</TabsTrigger>
          <TabsTrigger value="activity" className="data-[state=active]:bg-zinc-800 data-[state=active]:text-emerald-300">Activity</TabsTrigger>
          <TabsTrigger value="sources" className="data-[state=active]:bg-zinc-800 data-[state=active]:text-emerald-300">Sources</TabsTrigger>
          <TabsTrigger value="report" className="data-[state=active]:bg-zinc-800 data-[state=active]:text-emerald-300" disabled={!job.reportExists}>
            Report {job.reportExists ? `· ${job.reportWords ?? 0}w` : ''}
          </TabsTrigger>
        </TabsList>

        {/* questions board */}
        <TabsContent value="overview" className="mt-3">
          {job.brief && (
            <div className="mb-3 rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-emerald-500/80">Research brief</div>
              <p className="mt-1 text-sm leading-relaxed text-zinc-300">{job.brief}</p>
            </div>
          )}
          <div className="space-y-4">
            {questionsBySection.map(({ section, qs }) =>
              qs.length ? (
                <div key={section}>
                  <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-zinc-300">
                    <span className="h-3.5 w-1 rounded-full bg-emerald-500/70" /> {section}
                    <span className="text-xs font-normal text-zinc-500">
                      {qs.filter((q) => q.status === 'answered').length}/{qs.length} answered
                    </span>
                  </h3>
                  <div className="space-y-2">
                    {qs.map((q) => (
                      <QuestionRow key={q.id} q={q} />
                    ))}
                  </div>
                </div>
              ) : null
            )}
            {!subQuestions.length && (
              <p className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-6 text-center text-sm text-zinc-500">
                The planner is still decomposing the topic into research questions…
              </p>
            )}
          </div>
        </TabsContent>

        {/* activity feed */}
        <TabsContent value="activity" className="mt-3">
          <div className="max-h-[32rem] overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-950/70 p-4">
            <div className="space-y-1.5 font-mono text-xs">
              {logs.length === 0 && <p className="text-zinc-600">No activity yet…</p>}
              {logs.map((l) => (
                <div key={l.id} className="flex gap-2.5 leading-relaxed">
                  <span className="shrink-0 text-zinc-600">{new Date(l.createdAt).toLocaleTimeString()}</span>
                  <span
                    className={
                      l.level === 'success'
                        ? 'text-emerald-400'
                        : l.level === 'warn'
                          ? 'text-amber-400'
                          : l.level === 'error'
                            ? 'text-rose-400'
                            : l.level === 'phase'
                              ? 'font-semibold text-emerald-300'
                              : 'text-zinc-400'
                    }
                  >
                    {l.message}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </TabsContent>

        {/* sources */}
        <TabsContent value="sources" className="mt-3">
          <div className="overflow-hidden rounded-xl border border-zinc-800">
            {sources.length === 0 ? (
              <p className="bg-zinc-900/60 p-6 text-center text-sm text-zinc-500">No sources discovered yet.</p>
            ) : (
              <div className="divide-y divide-zinc-800/80">
                {sources.map((s) => {
                  const EngineIcon = ENGINE_ICON[s.engine] || Globe
                  return (
                    <div key={s.id} className="flex items-center gap-3 bg-zinc-900/40 px-3 py-2.5 hover:bg-zinc-900/70">
                      <EngineIcon className="h-4 w-4 shrink-0 text-zinc-500" />
                      <div className="min-w-0 flex-1">
                        <a
                          href={s.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 truncate text-sm font-medium text-zinc-200 hover:text-emerald-400"
                        >
                          {s.title}
                          <ExternalLink className="h-3 w-3 shrink-0 opacity-50" />
                        </a>
                        <div className="truncate text-xs text-zinc-500">{s.domain}</div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {s.usedInReport && (
                          <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-400">
                            cited [{s.refNumber}]
                          </Badge>
                        )}
                        <Badge
                          variant="outline"
                          className={`text-[10px] ${
                            s.status === 'summarized'
                              ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-400'
                              : s.status === 'failed'
                                ? 'border-rose-500/30 bg-rose-500/5 text-rose-400'
                                : 'border-zinc-700 bg-zinc-800/50 text-zinc-400'
                          }`}
                        >
                          {s.status}
                          {s.quality ? ` ${s.quality}/10` : ''}
                        </Badge>
                        <span className="hidden w-10 text-right font-mono text-[11px] text-zinc-500 sm:block">{s.score.toFixed(1)}</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
          <p className="mt-2 text-xs text-zinc-600">
            Showing the {sources.length} most recent of {counters.found} discovered sources. Full list in the JSON export.
          </p>
        </TabsContent>

        {/* report */}
        <TabsContent value="report" className="mt-3">
          {job.reportExists ? (
            <ReportView jobId={jobId} />
          ) : (
            <div className="flex flex-col items-center rounded-xl border border-zinc-800 bg-zinc-900/60 p-10 text-center">
              <ActivityIcon className="h-8 w-8 animate-pulse text-emerald-400/70" />
              <p className="mt-3 text-sm text-zinc-400">
                The report will be written here once research and critique complete ({job.progress}% done).
              </p>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
