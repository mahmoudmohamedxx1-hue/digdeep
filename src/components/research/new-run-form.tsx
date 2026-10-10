'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { toast } from '@/hooks/use-toast'
import { api } from '@/lib/research-client'
import { Zap, Layers, Telescope, Loader2, Radar, BookOpen, FlaskConical, MessagesSquare, Lock } from 'lucide-react'

const DEPTHS = [
  {
    id: 'standard',
    icon: Zap,
    name: 'Standard',
    estimate: '~15–30 min',
    desc: '6–10 sub-questions, 2–3 loops, ~25 sources, 1 critique pass',
  },
  {
    id: 'deep',
    icon: Layers,
    name: 'Deep',
    estimate: '~1–3 h',
    desc: 'Up to 18 questions, 6 loops, ~60 sources, 2 critique passes',
  },
  {
    id: 'exhaustive',
    icon: Telescope,
    name: 'Exhaustive',
    estimate: 'many hours — built for it',
    desc: 'Up to 30 questions, 12 loops, 120 sources, 4 critique passes, 6500+ words',
  },
] as const

const LANGUAGES = ['English', 'Arabic (العربية)', 'French', 'German', 'Spanish', 'Chinese (中文)', 'Japanese', 'Russian']

export function NewRunForm({ onCreated }: { onCreated: (id: string) => void }) {
  const [topic, setTopic] = useState('')
  const [depth, setDepth] = useState<'standard' | 'deep' | 'exhaustive'>('exhaustive')
  const [language, setLanguage] = useState('English')
  const [wikipedia, setWikipedia] = useState(true)
  const [arxiv, setArxiv] = useState(false)
  const [hn, setHn] = useState(false)
  const [starting, setStarting] = useState(false)

  const start = async () => {
    if (topic.trim().length < 8) {
      toast({ title: 'Topic too short', description: 'Give the agent something meaty to research (8+ characters).', variant: 'destructive' })
      return
    }
    setStarting(true)
    try {
      const { id } = await api<{ id: string }>('/api/research', {
        method: 'POST',
        body: JSON.stringify({
          topic: topic.trim(),
          depth,
          language,
          engines: { web: true, wikipedia, arxiv, hn },
        }),
      })
      toast({ title: 'Research launched', description: 'The agent is planning its strategy. Live view opening…' })
      onCreated(id)
    } catch (err) {
      toast({
        title: 'Could not start research',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      })
    } finally {
      setStarting(false)
    }
  }

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 sm:p-6" aria-label="Start new research">
      <h2 className="text-lg font-semibold text-zinc-100">New research mission</h2>
      <p className="mt-1 text-sm text-zinc-400">
        The agent plans, searches, reads, reflects, critiques itself and writes a cited report — autonomously, on free keyless models.
      </p>

      <div className="mt-4">
        <Label htmlFor="topic" className="text-sm font-medium text-zinc-300">
          Research topic or question
        </Label>
        <Textarea
          id="topic"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="e.g. The state of solid-state battery commercialization: which companies will mass-produce first, and what are the remaining technical barriers?"
          className="mt-2 min-h-24 border-zinc-700 bg-zinc-950/60 text-zinc-200 placeholder:text-zinc-600 focus-visible:ring-emerald-500/40"
          maxLength={500}
        />
        <div className="mt-1 text-right text-xs text-zinc-600">{topic.length}/500</div>
      </div>

      <div className="mt-3">
        <Label className="text-sm font-medium text-zinc-300">Depth</Label>
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Research depth">
          {DEPTHS.map((d) => {
            const Icon = d.icon
            const selected = depth === d.id
            return (
              <button
                key={d.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setDepth(d.id)}
                className={`rounded-lg border p-3 text-left transition-all ${
                  selected
                    ? 'border-emerald-500/60 bg-emerald-500/10 ring-1 ring-emerald-500/30'
                    : 'border-zinc-700/70 bg-zinc-950/40 hover:border-zinc-600'
                }`}
              >
                <div className="flex items-center gap-2">
                  <Icon className={`h-4 w-4 ${selected ? 'text-emerald-400' : 'text-zinc-400'}`} />
                  <span className={`text-sm font-semibold ${selected ? 'text-emerald-300' : 'text-zinc-200'}`}>{d.name}</span>
                </div>
                <div className="mt-1 text-[11px] text-emerald-500/80">{d.estimate}</div>
                <div className="mt-1 text-[11px] leading-snug text-zinc-500">{d.desc}</div>
              </button>
            )
          })}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <Label className="text-sm font-medium text-zinc-300">Report language</Label>
          <Select value={language} onValueChange={setLanguage}>
            <SelectTrigger className="mt-2 border-zinc-700 bg-zinc-950/60 text-zinc-200" aria-label="Report language">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border-zinc-700 bg-zinc-900 text-zinc-200">
              {LANGUAGES.map((l) => (
                <SelectItem key={l} value={l}>
                  {l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-sm font-medium text-zinc-300">Keyless search engines</Label>
          <div className="mt-2 space-y-2 rounded-lg border border-zinc-700/70 bg-zinc-950/40 p-3">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-sm text-zinc-300">
                <Radar className="h-4 w-4 text-emerald-400" /> Web (primary)
              </span>
              <span className="flex items-center gap-1.5 text-xs text-zinc-500">
                always on <Lock className="h-3 w-3" />
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-sm text-zinc-300">
                <BookOpen className="h-4 w-4 text-zinc-400" /> Wikipedia
              </span>
              <Switch checked={wikipedia} onCheckedChange={setWikipedia} aria-label="Toggle Wikipedia" />
            </div>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-sm text-zinc-300">
                <FlaskConical className="h-4 w-4 text-zinc-400" /> arXiv papers
              </span>
              <Switch checked={arxiv} onCheckedChange={setArxiv} aria-label="Toggle arXiv" />
            </div>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-sm text-zinc-300">
                <MessagesSquare className="h-4 w-4 text-zinc-400" /> Hacker News
              </span>
              <Switch checked={hn} onCheckedChange={setHn} aria-label="Toggle Hacker News" />
            </div>
          </div>
        </div>
      </div>

      <Button
        onClick={start}
        disabled={starting}
        className="mt-5 w-full bg-emerald-500 text-zinc-950 hover:bg-emerald-400 disabled:opacity-60 sm:w-auto sm:px-8"
        size="lg"
      >
        {starting ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Launching…
          </>
        ) : (
          <>
            <Radar className="mr-2 h-4 w-4" /> Launch deep research
          </>
        )}
      </Button>
    </section>
  )
}
