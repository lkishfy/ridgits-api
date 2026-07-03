import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '@/lib/firebase-admin'
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
  if (key.startsWith('legacy_')) {
    const index = parseInt(key.slice('legacy_'.length), 10)
    if (!Number.isNaN(index)) return questionIdForIndex(index)
  }
  if (isIdBasedKey(key)) return key
  const index = parseInt(key, 10)
  if (Number.isNaN(index)) return key
  return questionIdForIndex(index)
}

function migrateStringKeyedMap<T>(map: Record<string, T>): Record<string, T> {
  const migrated: Record<string, T> = {}
  const entries = Object.entries(map).sort(([a], [b]) => {
    const aIsId = isIdBasedKey(a)
    const bIsId = isIdBasedKey(b)
    if (aIsId !== bIsId) return aIsId ? 1 : -1
    return a.localeCompare(b)
  })
  for (const [key, value] of entries) {
    migrated[migrateQuestionKey(key)] = value
  }
  return migrated
}

function isDemographicQuestionKey(key: string): boolean {
  if (key.startsWith('demo_')) return true
  const num = parseInt(key, 10)
  return !Number.isNaN(num) && num < 3
}

export const QUIZ_COMPLETION_ANSWER_THRESHOLD = 50

export function personalityAnswerCount(answers: Record<string, unknown>): number {
  return Object.keys(answers).filter((key) => {
    if (isDemographicQuestionKey(key)) return false
    const value = answers[key]
    if (value === undefined || value === null) return false
    if (Array.isArray(value)) return value.length > 0
    if (typeof value === 'string') return value.trim() !== ''
    return true
  }).length
}

export function hasEnoughPersonalityAnswers(answers: Record<string, unknown>): boolean {
  return personalityAnswerCount(answers) >= QUIZ_COMPLETION_ANSWER_THRESHOLD
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
  if (raw.questionRatings && typeof raw.questionRatings === 'object') {
    const ratings = migrateStringKeyedMap(raw.questionRatings as Record<string, number>)
    for (const [key, value] of Object.entries(ratings)) {
      if (importance[key] === undefined && typeof value === 'number') {
        importance[key] = value
      }
    }
  }
  if (raw.dealbreakers && typeof raw.dealbreakers === 'object') {
    Object.assign(dealbreakers, raw.dealbreakers as Record<string, boolean>)
  }

  const migratedAnswers = migrateStringKeyedMap(answers)
  const migratedPreferred = migrateStringKeyedMap(preferredAnswers)
  const migratedImportance = migrateStringKeyedMap(importance)
  const migratedDealbreakers = migrateStringKeyedMap(dealbreakers)

  return {
    answers: migratedAnswers,
    preferredAnswers: migratedPreferred,
    importance: migratedImportance,
    dealbreakers: migratedDealbreakers,
    completed: raw.completed === true || hasEnoughPersonalityAnswers(migratedAnswers),
    archetype: raw.archetype,
  }
}

/** Persist migrated answer keys + completed flag when user has enough answers. */
export async function syncQuizProgressForMatching(
  uid: string,
  raw: Record<string, unknown>,
): Promise<NormalizedQuizProgress> {
  const normalized = normalizeQuizProgress(raw)
  const db = getDb()

  const shouldMarkComplete =
    raw.completed === true || hasEnoughPersonalityAnswers(normalized.answers)
  const keysNeedMigration = Object.keys((raw.answers as Record<string, unknown>) ?? {}).some(
    (key) => migrateQuestionKey(key) !== key,
  )

  if (shouldMarkComplete && (raw.completed !== true || keysNeedMigration)) {
    await db.collection('quizProgress').doc(uid).set(
      {
        answers: normalized.answers,
        preferredAnswers: normalized.preferredAnswers,
        importance: normalized.importance,
        dealbreakers: normalized.dealbreakers,
        completed: true,
        completedAt: FieldValue.serverTimestamp(),
        questionsAnswered: personalityAnswerCount(normalized.answers),
      },
      { merge: true },
    )
    await db.collection('topNationwideMatches').doc(uid).delete().catch(() => undefined)
  }

  return { ...normalized, completed: shouldMarkComplete }
}
