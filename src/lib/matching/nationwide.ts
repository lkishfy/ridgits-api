import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { getDb } from '@/lib/firebase-admin'
import {
  calculateCompatibility,
  checkGenderMatch,
  toArrayOrEmpty,
  arraysOverlap,
  formatMatchForClient,
} from '@/lib/matching/compatibility'
import { normalizeQuizProgress } from '@/lib/matching/quiz-normalize'

export const NATIONWIDE_CACHE_TTL_MS = 24 * 60 * 60 * 1000
export const NATIONWIDE_CACHE_VERSION = 6

function demoAnswer(quiz: ReturnType<typeof normalizeQuizProgress>, key: string, fallbackIndex: number) {
  return quiz.answers[key] ?? quiz.answers[String(fallbackIndex)]
}

export async function getTopNationwideMatches(uid: string, limit = 10) {
  const db = getDb()
  const cacheRef = db.collection('topNationwideMatches').doc(uid)
  const cacheSnap = await cacheRef.get()

  if (cacheSnap.exists) {
    const cache = cacheSnap.data() ?? {}
    const updatedAt = cache.updatedAt as Timestamp | undefined
    const age = updatedAt ? Date.now() - updatedAt.toMillis() : Infinity
    if (age < NATIONWIDE_CACHE_TTL_MS && cache.version === NATIONWIDE_CACHE_VERSION) {
      const cached = (cache.matches as Record<string, unknown>[]) ?? []
      return cached.slice(0, limit).map(formatMatchForClient)
    }
  }

  const results = await computeTopNationwideMatchesInternal(uid)
  return results.slice(0, limit).map(formatMatchForClient)
}

export async function computeTopNationwideMatchesInternal(uid: string) {
  const db = getDb()
  const [userQuizSnap, userProfileSnap] = await Promise.all([
    db.collection('quizProgress').doc(uid).get(),
    db.collection('users').doc(uid).get(),
  ])

  if (!userQuizSnap.exists) {
    await db.collection('topNationwideMatches').doc(uid).set(
      {
        matches: [],
        updatedAt: FieldValue.serverTimestamp(),
        userId: uid,
        version: NATIONWIDE_CACHE_VERSION,
      },
      { merge: true },
    )
    return []
  }

  const userQuiz = normalizeQuizProgress(userQuizSnap.data() ?? {})
  const userProfile = userProfileSnap.exists ? (userProfileSnap.data() ?? {}) : {}

  const myGender = demoAnswer(userQuiz, 'demo_000', 0)
  const myLookingFor = demoAnswer(userQuiz, 'demo_001', 1)
  const myIntent = toArrayOrEmpty(demoAnswer(userQuiz, 'demo_002', 2))

  const ageRangeMin = userProfile.ageRangeMin ? parseInt(String(userProfile.ageRangeMin), 10) : null
  const ageRangeMax = userProfile.ageRangeMax ? parseInt(String(userProfile.ageRangeMax), 10) : null
  const hasAgeRange =
    ageRangeMin !== null &&
    ageRangeMax !== null &&
    !Number.isNaN(ageRangeMin) &&
    !Number.isNaN(ageRangeMax)

  const completedSnap = await db.collection('quizProgress').where('completed', '==', true).get()
  const scored: Array<{ userId: string; overall: number; archetype: unknown; compat: ReturnType<typeof calculateCompatibility> }> = []

  for (const doc of completedSnap.docs) {
    if (doc.id === uid) continue
    const otherRaw = doc.data()
    const other = normalizeQuizProgress(otherRaw)

    if (myGender !== undefined && myLookingFor !== undefined) {
      const otherGender = demoAnswer(other, 'demo_000', 0)
      const otherLookingFor = demoAnswer(other, 'demo_001', 1)
      if (otherGender === undefined || otherLookingFor === undefined) continue
      if (!checkGenderMatch(myGender, otherLookingFor) || !checkGenderMatch(otherGender, myLookingFor)) {
        continue
      }
    }

    const otherIntent = toArrayOrEmpty(demoAnswer(other, 'demo_002', 2))
    if (myIntent.length > 0 && otherIntent.length > 0 && !arraysOverlap(myIntent, otherIntent)) continue

    const compat = calculateCompatibility(userQuiz, other)
    scored.push({ userId: doc.id, overall: compat.overall, archetype: otherRaw.archetype, compat })
  }

  scored.sort((a, b) => b.overall - a.overall)

  const results: Record<string, unknown>[] = []
  for (const candidate of scored) {
    if (results.length >= 5) break
    const [publicProfileSnap, otherProfileSnap] = await Promise.all([
      db.collection('publicProfiles').doc(candidate.userId).get(),
      db.collection('users').doc(candidate.userId).get(),
    ])
    if (!publicProfileSnap.exists) continue

    const p = publicProfileSnap.data() ?? {}
    const otherUserProfile = otherProfileSnap.exists ? (otherProfileSnap.data() ?? {}) : {}

    const name = String(p.name ?? '').trim()
    const image = String(p.image ?? '').trim()
    const about = String(p.about ?? '').trim()
    if (!name || name.toLowerCase() === 'anonymous' || !image || !about) continue

    if (hasAgeRange) {
      const otherAge = otherUserProfile.age ? parseInt(String(otherUserProfile.age), 10) : null
      if (otherAge === null || Number.isNaN(otherAge)) continue
      if (otherAge < ageRangeMin! || otherAge > ageRangeMax!) continue
    }

    results.push({
      userId: candidate.userId,
      name,
      image,
      about,
      interests: Array.isArray(p.interests) ? p.interests : [],
      location: p.location ?? null,
      overall: candidate.overall,
      communication: candidate.compat.communication,
      intimacy: candidate.compat.intimacy,
      values: candidate.compat.values,
      social: candidate.compat.social,
      commitment: candidate.compat.commitment,
      compatibility: candidate.compat,
      archetype: candidate.archetype ?? null,
      subscriptionStatus: p.subscriptionStatus ?? otherUserProfile.subscriptionStatus ?? null,
      subscriptionTier: p.subscriptionTier ?? otherUserProfile.subscriptionTier ?? 'free',
    })
  }

  await db.collection('topNationwideMatches').doc(uid).set(
    {
      matches: results,
      updatedAt: FieldValue.serverTimestamp(),
      userId: uid,
      version: NATIONWIDE_CACHE_VERSION,
    },
    { merge: true },
  )

  return results
}
