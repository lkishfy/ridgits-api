import type { NormalizedQuizProgress } from '@/lib/matching/quiz-normalize'

function matchesPreference(answer: unknown, preference: unknown): boolean {
  if (Array.isArray(preference)) return preference.includes(answer)
  return answer === preference
}

function isDemographicQuestionKey(key: string): boolean {
  if (key.startsWith('demo_')) return true
  const num = parseInt(key, 10)
  return !Number.isNaN(num) && num < 3
}

function getQuestionCategory(questionId: string): string | null {
  if (questionId.startsWith('comm_')) return 'communication'
  if (questionId.startsWith('intm_')) return 'intimacy'
  if (questionId.startsWith('vals_')) return 'values'
  if (questionId.startsWith('socl_')) return 'social'
  if (questionId.startsWith('comt_')) return 'commitment'
  return null
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
    const pref1 = preferred1[q] !== undefined ? preferred1[q] : ans1
    const pref2 = preferred2[q] !== undefined ? preferred2[q] : ans2
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

export function formatMatchForClient(match: Record<string, unknown>) {
  const compat = match.compatibility as Record<string, number> | undefined
  return {
    ...match,
    compatibility: compat ?? {
      overall: match.overall ?? 0,
      communication: match.communication ?? 0,
      intimacy: match.intimacy ?? 0,
      values: match.values ?? 0,
      social: match.social ?? 0,
      commitment: match.commitment ?? 0,
    },
    compatibilityScore: compat?.overall ?? match.overall ?? 0,
  }
}
