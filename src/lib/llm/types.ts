// Shared types for the keyless LLM provider layer

export type ChatRole = 'system' | 'user' | 'assistant'

export interface ChatMessage {
  role: ChatRole
  content: string
}

export interface ChatOptions {
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
}

export interface ChatResult {
  text: string
  provider: string
  latencyMs: number
}

export interface ProviderStats {
  calls: number
  errors: number
  lastLatencyMs: number
  avgLatencyMs: number
  lastError?: string
}

export interface LLMProvider {
  /** Short machine name */
  name: string
  /** Human label for UI */
  label: string
  /** Description for UI */
  description: string
  /** Whether the provider is currently usable (cached health probe) */
  isAvailable(): Promise<boolean>
  /** Perform a chat completion */
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string>
  /** Get live stats */
  getStats(): ProviderStats
}

export function emptyStats(): ProviderStats {
  return { calls: 0, errors: 0, lastLatencyMs: 0, avgLatencyMs: 0 }
}
