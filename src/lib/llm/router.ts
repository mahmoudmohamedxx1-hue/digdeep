/**
 * Keyless LLM router with automatic provider fallback.
 *
 * Provider order (configurable via LLM_PROVIDER_ORDER, comma-separated):
 *   1. freellmpool — free multi-provider gateway (OpenAI-compatible, keyless)
 *   2. glm-flash   — z.ai GLM Flash via platform SDK (keyless, always available here)
 *
 * Behavior:
 *   - Tries providers in order; 2 attempts each with exponential backoff.
 *   - A provider that fails gets a 60s cooldown (skipped unless everything is cooling down).
 *   - If every provider fails, throws the last error.
 */

import type { ChatMessage, ChatOptions, ChatResult } from './types'
import { freellmpool } from './freellmpool'
import { zaiProvider } from './zai-provider'

const COOLDOWN_MS = 60_000
const ATTEMPTS_PER_PROVIDER = 2

const ORDER = (process.env.LLM_PROVIDER_ORDER || 'freellmpool,glm-flash')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const ALL_PROVIDERS = {
  freellmpool,
  'glm-flash': zaiProvider,
} as const

type ProviderName = keyof typeof ALL_PROVIDERS

class LLMRouter {
  private cooldowns = new Map<string, number>()

  private get providers(): ProviderName[] {
    const ordered = ORDER.filter((name): name is ProviderName => name in ALL_PROVIDERS)
    return ordered.length ? ordered : (Object.keys(ALL_PROVIDERS) as ProviderName[])
  }

  private coolingDown(name: string): boolean {
    const until = this.cooldowns.get(name) || 0
    return Date.now() < until
  }

  private markCooldown(name: string) {
    this.cooldowns.set(name, Date.now() + COOLDOWN_MS)
  }

  /** Run a chat completion through the provider chain. */
  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult> {
    const candidates = this.providers
    // Prefer providers that are not cooling down; fall back to all if every one is cooling.
    let ordered = candidates.filter((n) => !this.coolingDown(n))
    if (!ordered.length) ordered = candidates

    let lastError: unknown = new Error('No LLM provider configured')

    for (const name of ordered) {
      const provider = ALL_PROVIDERS[name]
      try {
        if (!(await provider.isAvailable())) {
          lastError = new Error(`${provider.label} is not available`)
          continue
        }
      } catch {
        lastError = new Error(`${provider.label} health check failed`)
        continue
      }

      for (let attempt = 1; attempt <= ATTEMPTS_PER_PROVIDER; attempt++) {
        const started = Date.now()
        try {
          const text = await provider.chat(messages, opts)
          return { text, provider: name, latencyMs: Date.now() - started }
        } catch (err) {
          lastError = err
          if (attempt < ATTEMPTS_PER_PROVIDER) {
            await new Promise((r) => setTimeout(r, 1500 * attempt))
          }
        }
      }
      this.markCooldown(name)
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  /** Provider status snapshot for the UI. */
  async status() {
    const entries = await Promise.all(
      this.providers.map(async (name) => {
        const p = ALL_PROVIDERS[name]
        let available = false
        try {
          available = await p.isAvailable()
        } catch {
          available = false
        }
        const stats = p.getStats()
        return {
          name,
          label: p.label,
          description: p.description,
          available,
          coolingDown: this.coolingDown(name),
          stats,
          detail:
            name === 'freellmpool'
              ? freellmpool.getStatusDetail()
              : { reason: available ? 'platform SDK ready' : 'SDK init failed' },
        }
      })
    )
    return { order: this.providers, providers: entries }
  }
}

const globalForRouter = globalThis as unknown as { __llmRouter?: LLMRouter }

export const llm: LLMRouter = globalForRouter.__llmRouter ?? new LLMRouter()
globalForRouter.__llmRouter = llm
