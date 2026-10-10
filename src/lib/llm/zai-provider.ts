/**
 * z.ai GLM Flash provider (keyless).
 *
 * Uses the platform-provided z-ai-web-dev-sdk — no API key required.
 * The SDK is server-side only; this module must never be imported from client code.
 */

import type { ChatMessage, ChatOptions, LLMProvider, ProviderStats } from './types'
import { emptyStats } from './types'

const CHAT_TIMEOUT_MS = 240_000

type ZAIChatMessage = { role: 'assistant' | 'user'; content: string }

class ZaiProvider implements LLMProvider {
  name = 'glm-flash'
  label = 'GLM Flash (z.ai)'
  description = 'Keyless z.ai GLM Flash model via the platform SDK — always-on fallback'

  private stats: ProviderStats = emptyStats()
  private zaiInstance: { chat: { completions: { create: (args: unknown) => Promise<unknown> } } } | null = null
  private initPromise: Promise<void> | null = null

  private async getZai() {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const mod = await import('z-ai-web-dev-sdk')
        const ZAI = (mod as { default?: { create: () => Promise<unknown> } }).default ?? (mod as unknown as { create: () => Promise<unknown> })
        this.zaiInstance = (await ZAI.create()) as typeof this.zaiInstance
      })().catch((err) => {
        this.initPromise = null
        throw err
      })
    }
    await this.initPromise
    return this.zaiInstance!
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.getZai()
      return true
    } catch {
      return false
    }
  }

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string> {
    const started = Date.now()
    this.stats.calls++
    try {
      const zai = await this.getZai()
      // z.ai SDK convention: system prompts are passed with the 'assistant' role
      const sdkMessages: ZAIChatMessage[] = messages.map((m) => ({
        role: m.role === 'system' || m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      }))
      const completion = (await Promise.race([
        zai.chat.completions.create({
          messages: sdkMessages,
          thinking: { type: 'disabled' },
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('z.ai chat timeout')), opts?.timeoutMs || CHAT_TIMEOUT_MS)
        ),
      ])) as { choices?: { message?: { content?: string } }[] }

      const text = completion.choices?.[0]?.message?.content
      if (!text || !text.trim()) throw new Error('z.ai returned an empty completion')
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
}

const globalForZai = globalThis as unknown as { __zaiProvider?: ZaiProvider }

export const zaiProvider: ZaiProvider = globalForZai.__zaiProvider ?? new ZaiProvider()
globalForZai.__zaiProvider = zaiProvider
