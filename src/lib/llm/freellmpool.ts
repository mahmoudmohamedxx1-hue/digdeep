/**
 * FreeLLMPool provider adapter (keyless free LLM gateway).
 *
 * freellmpool (https://github.com/0xzr/freellmpool) pools 22 free LLM providers
 * (Pollinations, LLM7, OVHcloud, Kilo Gateway, ... keyless) behind one
 * OpenAI-compatible endpoint. Run it locally with:
 *
 *   pip install freellmpool && freellmpool proxy      # -> http://localhost:8080
 *
 * This adapter speaks to that proxy's OpenAI-compatible API with model="auto"
 * (freellmpool routes to whichever free provider is healthy right now).
 * Configure via env vars:
 *   FREELLPOOL_URL      base URL incl. /v1   (default http://127.0.0.1:8080/v1)
 *   FREELLPOOL_API_KEY  optional bearer key  (default "unused" — loopback needs none)
 *   FREELLPOOL_MODEL    model/routing alias  (default "auto"; also: fast|quality|spread)
 *   FREELLPOOL_ENABLED  set "0" to disable this provider entirely
 */

import type { ChatMessage, ChatOptions, LLMProvider, ProviderStats } from './types'
import { emptyStats } from './types'

const BASE_URL = (process.env.FREELLPOOL_URL || 'http://127.0.0.1:8080/v1').replace(/\/+$/, '')
const API_KEY = process.env.FREELLPOOL_API_KEY || 'unused'
const MODEL = process.env.FREELLPOOL_MODEL || 'auto'
const ENABLED = process.env.FREELLPOOL_ENABLED !== '0'

const HEALTH_TTL_MS = 30_000
const CHAT_TIMEOUT_MS = 180_000

class FreeLLMPoolProvider implements LLMProvider {
  name = 'freellmpool'
  label = 'FreeLLMPool'
  description = 'Free LLM gateway — 22 providers pooled behind an OpenAI-compatible proxy (keyless)'

  private stats: ProviderStats = emptyStats()
  private healthCache: { available: boolean; checkedAt: number; reason: string } = {
    available: false,
    checkedAt: 0,
    reason: 'not probed yet',
  }

  async isAvailable(): Promise<boolean> {
    if (!ENABLED) {
      this.healthCache = { available: false, checkedAt: Date.now(), reason: 'disabled via FREELLPOOL_ENABLED=0' }
      return false
    }
    const fresh = Date.now() - this.healthCache.checkedAt < HEALTH_TTL_MS
    if (fresh) return this.healthCache.available
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 2500)
      const res = await fetch(`${BASE_URL}/models`, {
        signal: controller.signal,
        headers: { Authorization: `Bearer ${API_KEY}` },
        cache: 'no-store',
      })
      clearTimeout(timer)
      this.healthCache = {
        available: res.ok,
        checkedAt: Date.now(),
        reason: res.ok ? `proxy reachable at ${BASE_URL}` : `health check returned HTTP ${res.status}`,
      }
    } catch (err) {
      this.healthCache = {
        available: false,
        checkedAt: Date.now(),
        reason: `proxy not reachable at ${BASE_URL} — start it with "freellmpool proxy" to enable`,
      }
    }
    return this.healthCache.available
  }

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string> {
    const started = Date.now()
    this.stats.calls++
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), opts?.timeoutMs || CHAT_TIMEOUT_MS)
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          model: MODEL,
          messages,
          temperature: opts?.temperature ?? 0.4,
          max_tokens: opts?.maxTokens ?? 4096,
          stream: false,
        }),
      })
      clearTimeout(timer)
      if (!res.ok) {
        throw new Error(`FreeLLMPool HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
      }
      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[]
      }
      const text = data.choices?.[0]?.message?.content
      if (!text || !text.trim()) throw new Error('FreeLLMPool returned an empty completion')
      this.stats.lastLatencyMs = Date.now() - started
      this.stats.avgLatencyMs = Math.round(
        (this.stats.avgLatencyMs * (this.stats.calls - 1) + this.stats.lastLatencyMs) / this.stats.calls
      )
      return text
    } catch (err) {
      this.stats.errors++
      this.stats.lastError = err instanceof Error ? err.message : String(err)
      throw err
    }
  }

  getStats(): ProviderStats {
    return { ...this.stats }
  }

  getStatusDetail(): { available: boolean; reason: string; url: string; model: string } {
    return {
      available: this.healthCache.available,
      reason: this.healthCache.reason,
      url: BASE_URL,
      model: MODEL,
    }
  }
}

const globalForPool = globalThis as unknown as { __freellmpoolProvider?: FreeLLMPoolProvider }

export const freellmpool: FreeLLMPoolProvider =
  globalForPool.__freellmpoolProvider ?? new FreeLLMPoolProvider()

globalForPool.__freellmpoolProvider = freellmpool
