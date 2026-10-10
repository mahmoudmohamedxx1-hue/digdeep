// Research engine shared types & depth configurations

export type Depth = 'standard' | 'deep' | 'exhaustive'

export interface DepthConfig {
  maxSubQuestions: number
  maxIterations: number
  maxSources: number
  critiqueRounds: number
  targetWords: number
  sectionsTarget: number
  questionsPerIteration: number
  fetchPerIteration: number
  estimate: string
}

export const DEPTH_CONFIGS: Record<Depth, DepthConfig> = {
  standard: {
    maxSubQuestions: 12,
    maxIterations: 3,
    maxSources: 25,
    critiqueRounds: 1,
    targetWords: 2200,
    sectionsTarget: 5,
    questionsPerIteration: 3,
    fetchPerIteration: 5,
    estimate: '~15–30 min',
  },
  deep: {
    maxSubQuestions: 18,
    maxIterations: 6,
    maxSources: 60,
    critiqueRounds: 2,
    targetWords: 4200,
    sectionsTarget: 7,
    questionsPerIteration: 3,
    fetchPerIteration: 6,
    estimate: '~1–3 h',
  },
  exhaustive: {
    maxSubQuestions: 30,
    maxIterations: 12,
    maxSources: 120,
    critiqueRounds: 4,
    targetWords: 6500,
    sectionsTarget: 9,
    questionsPerIteration: 4,
    fetchPerIteration: 7,
    estimate: 'many hours — built for it',
  },
}

export interface EngineConfig {
  engines: {
    web: boolean
    wikipedia: boolean
    arxiv: boolean
    hn: boolean
  }
  concurrency: number
}

export interface OutlineSection {
  title: string
  description: string
}

export interface LearningItem {
  questionId: string | null
  text: string
}

export interface SearchResultItem {
  url: string
  title: string
  snippet: string
  domain: string
  engine: 'web' | 'wikipedia' | 'arxiv' | 'hn'
  rank: number
  date?: string
}

export interface JobStats {
  llmCalls: number
  searches: number
  fetches: number
  fetchFailures: number
  learnings: number
  providerMix: Record<string, number>
  engineMix: Record<string, number>
  pausedCount: number
}

export function emptyStats(): JobStats {
  return {
    llmCalls: 0,
    searches: 0,
    fetches: 0,
    fetchFailures: 0,
    learnings: 0,
    providerMix: {},
    engineMix: {},
    pausedCount: 0,
  }
}

export const PHASES = ['planning', 'research', 'critique', 'synthesis', 'done'] as const
export type Phase = (typeof PHASES)[number]

export const PHASE_LABELS: Record<Phase, string> = {
  planning: 'Planning',
  research: 'Research Loop',
  critique: 'Critique & Gaps',
  synthesis: 'Synthesis',
  done: 'Done',
}
