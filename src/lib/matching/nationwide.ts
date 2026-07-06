import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { getDb } from '@/lib/firebase-admin'
import {
  calculateCompatibility,
  toArrayOrEmpty,
  arraysOverlap,
  formatMatchForClient,
  isVisibleInCommunity,
  readMatchOverallScore,
  haversineMiles,
} from '@/lib/matching/compatibility'
import {
  areDemographicsCompatible,
  readDemoAnswer,
  viewerHasDemographics,
} from '@/lib/matching/demographics'
import { readStoredCoords } from '@/lib/matching/geocode-cache'
import { sharedMetroArea } from '@/lib/location/metro-areas'
import { isProfileInUnitedStates } from '@/lib/location/normalize'
import { normalizeQuizProgress, syncQuizProgressForMatching } from '@/lib/matching/quiz-normalize'
import { effectiveSubscriptionTier } from '@/lib/subscription-badge'
import { isProfilePhotoIdentityVerified } from '@/lib/trust-safety/profile-identity-match'

export const NATIONWIDE_CACHE_TTL_MS = 24 * 60 * 60 * 1000
export const NATIONWIDE_CACHE_VERSION = 20

function cachedMatchesNeedRecompute(matches: Record<string, unknown>[]): boolean {
  if (matches.length === 0) return true
  return matches.every((match) => readMatchOverallScore(match) === 0)
}

function resolveNationwideDistanceMiles(
  viewerProfile: Record<string, unknown>,
  otherProfile: Record<string, unknown>,
): number | null {
  const viewerCoords = readStoredCoords(viewerProfile)
  const otherCoords = readStoredCoords(otherProfile)
  if (viewerCoords && otherCoords) {
    return Math.round(
      haversineMiles(viewerCoords.lat, viewerCoords.lng, otherCoords.lat, otherCoords.lng),
    )
  }
  if (sharedMetroArea(viewerProfile, otherProfile)) return 0
  return null
}

async function validateNationwideMatches(matches: Record<string, unknown>[]) {
  const db = getDb()
  const valid: Record<string, unknown>[] = []

  for (const match of matches) {
    const userId = String(match.userId ?? '').trim()
    if (!userId) continue

    const [publicProfileSnap, userSnap] = await Promise.all([
      db.collection('publicProfiles').doc(userId).get(),
      db.collection('users').doc(userId).get(),
    ])
    if (!publicProfileSnap.exists || !userSnap.exists) continue

    const profile = publicProfileSnap.data() ?? {}
    const userData = userSnap.data() ?? {}
    if (!isVisibleInCommunity(profile) || !isVisibleInCommunity(userData)) continue

    const merged = { ...userData, ...profile }
    if (!isProfileInUnitedStates(merged)) continue

    const name = String(profile.name ?? match.name ?? '').trim()
    const image = String(profile.image ?? match.image ?? '').trim()
    const about = String(profile.about ?? match.about ?? '').trim()
    if (!name || name.toLowerCase() === 'anonymous' || !image || !about) continue

    valid.push({
      ...match,
      name,
      image,
      about,
      location: profile.location ?? match.location ?? null,
      interests: Array.isArray(profile.interests) ? profile.interests : match.interests ?? [],
    })
  }

  return valid
}

function demoAnswer(quiz: ReturnType<typeof normalizeQuizProgress>, key: string, fallbackIndex: number) {
  return readDemoAnswer(quiz.answers, key, fallbackIndex, quiz.preferredAnswers)
}

async function filterNationwideMatchesForViewer(
  matches: Record<string, unknown>[],
  viewerQuiz: ReturnType<typeof normalizeQuizProgress>,
): Promise<Record<string, unknown>[]> {
  const myGender = demoAnswer(viewerQuiz, 'demo_000', 0)
  const myInterestedIn = demoAnswer(viewerQuiz, 'demo_001', 1)
  if (!viewerHasDemographics(myGender, myInterestedIn)) return []

  const db = getDb()
  const filtered: Record<string, unknown>[] = []

  for (const match of matches) {
    const userId = String(match.userId ?? '').trim()
    if (!userId) continue

    const otherSnap = await db.collection('quizProgress').doc(userId).get()
    if (!otherSnap.exists) continue

    const other = normalizeQuizProgress(otherSnap.data() ?? {})
    const otherGender = demoAnswer(other, 'demo_000', 0)
    const otherInterestedIn = demoAnswer(other, 'demo_001', 1)

    if (
      areDemographicsCompatible(myGender, myInterestedIn, otherGender, otherInterestedIn)
    ) {
      filtered.push(match)
    }
  }

  return filtered
}

export async function getTopNationwideMatches(uid: string, limit = 50, forceRefresh = false) {
  const db = getDb()
  const cacheRef = db.collection('topNationwideMatches').doc(uid)
  const cacheSnap = await cacheRef.get()

  if (!forceRefresh && cacheSnap.exists) {
    const cache = cacheSnap.data() ?? {}
    const updatedAt = cache.updatedAt as Timestamp | undefined
    const age = updatedAt ? Date.now() - updatedAt.toMillis() : Infinity
    if (age < NATIONWIDE_CACHE_TTL_MS && cache.version === NATIONWIDE_CACHE_VERSION) {
      const cached = (cache.matches as Record<string, unknown>[]) ?? []
      if (!cachedMatchesNeedRecompute(cached)) {
        const validated = await validateNationwideMatches(cached)
        const userQuizSnap = await getDb().collection('quizProgress').doc(uid).get()
        const userProfileSnap = await getDb().collection('users').doc(uid).get()
        const userProfile = userProfileSnap.exists ? (userProfileSnap.data() ?? {}) : {}
        const viewerQuiz = userQuizSnap.exists
          ? await syncQuizProgressForMatching(uid, userQuizSnap.data() ?? {}, userProfile)
          : normalizeQuizProgress({})
        const demographicFiltered = await filterNationwideMatchesForViewer(validated, viewerQuiz)
        return demographicFiltered.slice(0, limit).map(formatMatchForClient)
      }
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

  const userProfile = userProfileSnap.exists ? (userProfileSnap.data() ?? {}) : {}
  const userQuiz = await syncQuizProgressForMatching(uid, userQuizSnap.data() ?? {}, userProfile)
  const [userPublicSnap] = await Promise.all([
    getDb().collection('publicProfiles').doc(uid).get(),
  ])
  const userPublic = userPublicSnap.exists ? (userPublicSnap.data() ?? {}) : {}
  const viewerProfile = { ...userProfile, ...userPublic }
  if (!isProfileInUnitedStates(viewerProfile)) {
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

  const myGender = demoAnswer(userQuiz, 'demo_000', 0)
  const myInterestedIn = demoAnswer(userQuiz, 'demo_001', 1)
  const myIntent = toArrayOrEmpty(demoAnswer(userQuiz, 'demo_002', 2))
  const viewerDemographicsSet = viewerHasDemographics(myGender, myInterestedIn)
  if (!viewerDemographicsSet) {
    await db.collection('topNationwideMatches').doc(uid).delete().catch(() => undefined)
    return []
  }

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

    if (viewerDemographicsSet) {
      const otherGender = demoAnswer(other, 'demo_000', 0)
      const otherInterestedIn = demoAnswer(other, 'demo_001', 1)
      if (
        !areDemographicsCompatible(myGender, myInterestedIn, otherGender, otherInterestedIn)
      ) {
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
    if (!publicProfileSnap.exists || !otherProfileSnap.exists) continue

    const p = publicProfileSnap.data() ?? {}
    const otherUserProfile = otherProfileSnap.exists ? (otherProfileSnap.data() ?? {}) : {}
    if (!isVisibleInCommunity(p) || !isVisibleInCommunity(otherUserProfile)) continue

    const name = String(p.name ?? '').trim()
    const image = String(p.image ?? '').trim()
    const about = String(p.about ?? '').trim()
    if (!name || name.toLowerCase() === 'anonymous' || !image || !about) continue

    if (hasAgeRange) {
      const otherAge = otherUserProfile.age ? parseInt(String(otherUserProfile.age), 10) : null
      if (otherAge === null || Number.isNaN(otherAge)) continue
      if (otherAge < ageRangeMin! || otherAge > ageRangeMax!) continue
    }

    const otherProfile = { ...otherUserProfile, ...p }
    if (!isProfileInUnitedStates(otherProfile)) continue

    const distance = resolveNationwideDistanceMiles(viewerProfile, otherProfile)

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
      subscriptionTier: effectiveSubscriptionTier(otherProfile),
      profilePhotoVerified: isProfilePhotoIdentityVerified(otherUserProfile, p),
      distance,
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
