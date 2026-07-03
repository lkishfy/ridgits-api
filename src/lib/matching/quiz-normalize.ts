import { questionIdForIndex } from '@/lib/matching/quiz-question-ids'

export interface NormalizedQuizProgress {
  answers: Record<string, unknown>
  preferredAnswers: Record<string, unknown>
  importance: Record<string, number>
  dealbreakers: Record<string, boolean>
  completed?: boolean
  archetype?: unknown
}

function isIdBasedKey(key: string): boolean {
  return /^[a-z]/i.test(key)
}

function migrateQuestionKey(key: string): string {
  if (isIdBasedKey(key)) return key
  const index = parseInt(key, 10)
  if (Number.isNaN(index)) return key
  return questionIdForIndex(index)
}

function migrateStringKeyedMap<T>(map: Record<string, T>): Record<string, T> {
  const migrated: Record<string, T> = {}
  for (const [key, value] of Object.entries(map)) {
    const id = migrateQuestionKey(key)
    if (migrated[id] === undefined) migrated[id] = value
  }
  return migrated
}

/** Supports web flat maps and iOS nested `answers[id].{answer,preferredAnswers,...}`. */
export function normalizeQuizProgress(raw: Record<string, unknown>): NormalizedQuizProgress {
  const answers: Record<string, unknown> = {}
  const preferredAnswers: Record<string, unknown> = {}
  const importance: Record<string, number> = {}
  const dealbreakers: Record<string, boolean> = {}

  const rawAnswers = raw.answers
  if (rawAnswers && typeof rawAnswers === 'object' && !Array.isArray(rawAnswers)) {
    for (const [key, value] of Object.entries(rawAnswers as Record<string, unknown>)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const record = value as Record<string, unknown>
        if ('answer' in record || 'answers' in record) {
          if (record.answer !== undefined) answers[key] = record.answer
          else if (Array.isArray(record.answers)) answers[key] = record.answers
          if (record.preferredAnswers !== undefined) {
            preferredAnswers[key] = record.preferredAnswers
          }
          if (typeof record.importance === 'number') importance[key] = record.importance
          if (record.dealbreaker === true) dealbreakers[key] = true
          continue
        }
      }
      answers[key] = value
    }
  }

  if (raw.preferredAnswers && typeof raw.preferredAnswers === 'object') {
    Object.assign(preferredAnswers, raw.preferredAnswers as Record<string, unknown>)
  }
  if (raw.importance && typeof raw.importance === 'object') {
    Object.assign(importance, raw.importance as Record<string, number>)
  }
  if (raw.dealbreakers && typeof raw.dealbreakers === 'object') {
    Object.assign(dealbreakers, raw.dealbreakers as Record<string, boolean>)
  }

  return {
    answers: migrateStringKeyedMap(answers),
    preferredAnswers: migrateStringKeyedMap(preferredAnswers),
    importance: migrateStringKeyedMap(importance),
    dealbreakers: migrateStringKeyedMap(dealbreakers),
    completed: raw.completed === true,
    archetype: raw.archetype,
  }
}
