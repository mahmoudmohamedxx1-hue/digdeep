'use client'

import { useEffect, useState } from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { ProviderInfo } from '@/lib/research-client'

export function ProviderChips() {
  const [providers, setProviders] = useState<ProviderInfo[]>([])

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const res = await fetch('/api/providers')
        if (res.ok) {
          const data = (await res.json()) as { providers: ProviderInfo[] }
          if (alive) setProviders(data.providers || [])
        }
      } catch {
        // keep last known state
      }
    }
    load()
    const t = setInterval(load, 30000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  if (!providers.length) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-zinc-500">
        <span className="h-2 w-2 animate-pulse rounded-full bg-zinc-600" />
        probing LLM providers…
      </div>
    )
  }

  return (
    <TooltipProvider delayDuration={100}>
      <div className="flex flex-wrap items-center gap-1.5" aria-label="LLM provider status">
        {providers.map((p) => (
          <Tooltip key={p.name}>
            <TooltipTrigger asChild>
              <span
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${
                  p.available
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                    : 'border-zinc-700/60 bg-zinc-800/50 text-zinc-500'
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    p.available ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]' : 'bg-zinc-600'
                  }`}
                />
                {p.label}
                {p.stats.calls > 0 && (
                  <span className="text-[10px] opacity-70">{p.stats.calls} calls</span>
                )}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs border-zinc-700 bg-zinc-900 text-zinc-300">
              <p className="font-semibold text-zinc-100">{p.label}</p>
              <p className="mt-1 text-xs leading-relaxed">{p.description}</p>
              <p className="mt-1.5 text-xs text-zinc-400">{p.detail.reason}</p>
              {p.name === 'freellmpool' && !p.available && (
                <p className="mt-1.5 font-mono text-[11px] text-emerald-400">
                  pip install freellmpool && freellmpool proxy
                </p>
              )}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  )
}
