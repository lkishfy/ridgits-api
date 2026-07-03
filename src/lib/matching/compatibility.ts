import type { NormalizedQuizProgress } from '@/lib/matching/quiz-normalize'

function normalizeCompareValue(value: unknown): unknown {
  if (typeof value === 'string') {
    const parsed = parseInt(value, 10)
    if (!Number.isNaN(parsed)) return parsed
  }
  return value
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  return normalizeCompareValue(a) === normalizeCompareValue(b)
}

function matchesPreference(answer: unknown, preference: unknown): boolean {
  if (Array.isArray(preference)) {
    if (Array.isArray(answer)) {
      return answer.some((item) => preference.some((pref) => valuesEqual(item, pref)))
    }
    return preference.some((pref) => valuesEqual(answer, pref))
  }
  if (Array.isArray(answer)) {
    return answer.some((item) => valuesEqual(item, preference))
  }
  return valuesEqual(answer, preference)
}

function isDemographicQuestionKey(key: string): boolean {
  if (key.startsWith('demo_')) return true
  const num = parseInt(key, 10)
  return !Number.isNaN(num) && num < 3
}

function getQuestionCategory(questionId: string): string | null {
  const id = questionId.replace(/^ll_/, '')
  if (id.startsWith('comm_') || id.startsWith('spicy_comm_')) return 'communication'
  if (id.startsWith('intim_') || id.startsWith('intm_') || id.startsWith('msg_') || id.startsWith('bnd_')) {
    return 'intimacy'
  }
  if (id.startsWith('vals_') || id.startsWith('spicy_vals_')) return 'values'
  if (id.startsWith('socl_') || id.startsWith('social_')) return 'social'
  if (id.startsWith('comt_')) return 'commitment'
  return null
}

function effectivePreference(
  preferred: unknown,
  fallback: unknown,
): unknown {
  if (preferred === undefined || preferred === null) return fallback
  if (Array.isArray(preferred) && preferred.length === 0) return fallback
  return preferred
}

export function readScore(value: unknown): number | undefined {
  if (typeof value === 'number' && !Number.isNaN(value)) return Math.round(value)
  if (typeof value === 'string') {
    const parsed = parseInt(value, 10)
    if (!Number.isNaN(parsed)) return parsed
  }
  return undefined
}

export function readMatchOverallScore(match: Record<string, unknown>): number {
  const rawCompat = match.compatibility
  if (typeof rawCompat === 'number' || typeof rawCompat === 'string') {
    return readScore(rawCompat) ?? 0
  }
  if (rawCompat && typeof rawCompat === 'object') {
    const nested = readScore((rawCompat as Record<string, unknown>).overall)
    if (nested !== undefined) return nested
  }
  return readScore(match.overall) ?? readScore(match.compatibilityScore) ?? 0
}

export interface CompatibilityResult {
  communication: number
  intimacy: number
  values: number
  social: number
  commitment: number
  overall: number
}

export function calculateCompatibility(
  user1: NormalizedQuizProgress,
  user2: NormalizedQuizProgress,
): CompatibilityResult {
  const { answers: answers1, preferredAnswers: preferred1, importance: importance1, dealbreakers: dealbreakers1 } = user1
  const { answers: answers2, preferredAnswers: preferred2, importance: importance2, dealbreakers: dealbreakers2 } = user2

  const categories = {
    communication: { questions: 0, user1Points: 0, user1MaxPoints: 0, user2Points: 0, user2MaxPoints: 0 },
    intimacy: { questions: 0, user1Points: 0, user1MaxPoints: 0, user2Points: 0, user2MaxPoints: 0 },
    values: { questions: 0, user1Points: 0, user1MaxPoints: 0, user2Points: 0, user2MaxPoints: 0 },
    social: { questions: 0, user1Points: 0, user1MaxPoints: 0, user2Points: 0, user2MaxPoints: 0 },
    commitment: { questions: 0, user1Points: 0, user1MaxPoints: 0, user2Points: 0, user2MaxPoints: 0 },
  }

  let totalQuestions = 0
  let dealbreakerViolations = 0

  const commonQuestions = Object.keys(answers1).filter(
    (q) => answers2[q] !== undefined && !isDemographicQuestionKey(q),
  )

  for (const q of commonQuestions) {
    const category = getQuestionCategory(q)
    if (!category || !(category in categories)) continue

    const ans1 = answers1[q]
    const ans2 = answers2[q]
    const pref1 = effectivePreference(preferred1[q], ans1)
    const pref2 = effectivePreference(preferred2[q], ans2)
    const imp1 = typeof importance1[q] === 'number' ? importance1[q] : 50
    const imp2 = typeof importance2[q] === 'number' ? importance2[q] : 50
    const isDealbreaker1 = dealbreakers1[q] === true
    const isDealbreaker2 = dealbreakers2[q] === true

    const cat = categories[category as keyof typeof categories]
    cat.questions++
    totalQuestions++

    if (matchesPreference(ans2, pref1)) cat.user1Points += imp1
    cat.user1MaxPoints += imp1
    if (matchesPreference(ans1, pref2)) cat.user2Points += imp2
    cat.user2MaxPoints += imp2

    if (isDealbreaker1 && !matchesPreference(ans2, pref1)) dealbreakerViolations++
    if (isDealbreaker2 && !matchesPreference(ans1, pref2)) dealbreakerViolations++
  }

  const scoreCategory = (cat: (typeof categories)['communication']) => {
    if (cat.questions === 0) return 0
    const user1Satisfaction = cat.user1MaxPoints > 0 ? (cat.user1Points / cat.user1MaxPoints) * 100 : 0
    const user2Satisfaction = cat.user2MaxPoints > 0 ? (cat.user2Points / cat.user2MaxPoints) * 100 : 0
    return Math.round(Math.sqrt(user1Satisfaction * user2Satisfaction))
  }

  const communication = scoreCategory(categories.communication)
  const intimacy = scoreCategory(categories.intimacy)
  const values = scoreCategory(categories.values)
  const social = scoreCategory(categories.social)
  const commitment = scoreCategory(categories.commitment)

  const weightedSum = communication + intimacy + values + social + commitment
  const overallScore = totalQuestions > 0 ? Math.round(weightedSum / 5) : 0
  const dealbreakerPenalty = Math.min(20, dealbreakerViolations * 5)
  const overall = Math.max(0, overallScore - dealbreakerPenalty)

  return { communication, intimacy, values, social, commitment, overall }
}

export function toArrayOrEmpty(value: unknown): unknown[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

export function arraysOverlap(a: unknown[], b: unknown[]): boolean {
  return a.some((item) => b.includes(item))
}

export function checkGenderMatch(userGender: unknown, lookingForPreference: unknown): boolean {
  const userGenderArray = Array.isArray(userGender) ? userGender : [userGender]
  const lookingForArray = Array.isArray(lookingForPreference) ? lookingForPreference : [lookingForPreference]

  if (lookingForArray.includes(4)) return true

  for (const gender of userGenderArray) {
    if (lookingForArray.includes(gender)) return true
    if (gender === 0 && lookingForArray.includes(0)) return true
    if (gender === 1 && lookingForArray.includes(1)) return true
    if (gender === 2 && lookingForArray.includes(2)) return true
    if (gender === 3 && lookingForArray.includes(3)) return true
    if (gender === 4 && lookingForArray.length > 0) return true
  }
  return false
}

export function haversineMiles(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 3959
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

export async function geocodeLocation(locationString: string): Promise<{ lat: number; lng: number } | null> {
  if (!locationString.trim()) return null
  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(locationString)}&limit=1`,
      { headers: { 'User-Agent': 'Ridgits API' } },
    )
    if (!response.ok) return null
    const data = (await response.json()) as Array<{ lat: string; lon: string }>
    if (!data.length) return null
    return { lat: parseFloat(data[0]!.lat), lng: parseFloat(data[0]!.lon) }
  } catch {
    return null
  }
}

export function isVisibleInCommunity(profile: Record<string, unknown> | null | undefined): boolean {
  return profile?.visibleInCommunity !== false
}

function deriveOverallFromDimensions(compatibility: {
  overall: number
  communication: number
  intimacy: number
  values: number
  social: number
  commitment: number
}) {
  if (compatibility.overall > 0) return compatibility.overall
  const topLevelSum =
    compatibility.communication +
    compatibility.intimacy +
    compatibility.values +
    compatibility.social +
    compatibility.commitment
  if (topLevelSum > 0) return Math.round(topLevelSum / 5)
  return 0
}

export function formatMatchForClient(match: Record<string, unknown>) {
  const rawCompat = match.compatibility
  const compatObject =
    rawCompat && typeof rawCompat === 'object' && !Array.isArray(rawCompat)
      ? (rawCompat as Record<string, unknown>)
      : undefined
  const legacyOverall =
    typeof rawCompat === 'number' || typeof rawCompat === 'string' ? readScore(rawCompat) : undefined
  const nestedOverall = readScore(compatObject?.overall)
  const nestedCommunication = readScore(compatObject?.communication)
  const topOverall = readScore(match.overall) ?? readScore(match.compatibilityScore)

  const compatibility = {
    overall: 0,
    communication:
      nestedCommunication ?? readScore(match.communication) ?? readScore(compatObject?.communication) ?? 0,
    intimacy: readScore(compatObject?.intimacy) ?? readScore(match.intimacy) ?? 0,
    values: readScore(compatObject?.values) ?? readScore(match.values) ?? 0,
    social: readScore(compatObject?.social) ?? readScore(match.social) ?? 0,
    commitment: readScore(compatObject?.commitment) ?? readScore(match.commitment) ?? 0,
  }

  if (legacyOverall !== undefined && legacyOverall > 0) {
    compatibility.overall = legacyOverall
  } else if (nestedOverall !== undefined && nestedOverall > 0) {
    compatibility.overall = nestedOverall
  } else if (topOverall !== undefined && topOverall > 0) {
    compatibility.overall = topOverall
  } else {
    compatibility.overall = deriveOverallFromDimensions(compatibility)
  }

  return {
    ...match,
    compatibility,
    compatibilityScore: compatibility.overall,
    overall: compatibility.overall,
  }
}
