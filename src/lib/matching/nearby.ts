import { FieldValue } from 'firebase-admin/firestore'
import { ApiError } from '@/lib/api-errors'
import { getDb } from '@/lib/firebase-admin'
import {
  calculateCompatibility,
  toArrayOrEmpty,
  arraysOverlap,
  haversineMiles,
  geocodeLocation,
  formatMatchForClient,
  isVisibleInCommunity,
} from '@/lib/matching/compatibility'
import {
  areDemographicsCompatible,
  readDemoAnswer,
  viewerHasDemographics,
} from '@/lib/matching/demographics'
import {
  locationCacheKey,
  readProfileLocationFields,
  resolveProfileLocation,
} from '@/lib/location/normalize'
import {
  isQuizCompleteForMatching,
  normalizeQuizProgress,
  syncQuizProgressForMatching,
} from '@/lib/matching/quiz-normalize'
import { getVerifiedEmailMap } from '@/lib/trust-safety/email-verification'
import { CLOSE_MATCHES_THRESHOLD_MILES } from '@/lib/ridgits-products'

export type NearbyMatchScanOptions = {
  /** Only count people within (0, CLOSE_MATCHES_THRESHOLD_MILES); do not return match payloads. */
  closeCountOnly?: boolean
  /** When true, track closeMatchCount while building the full match list in one pass. */
  includeCloseCount?: boolean
  /** When true with includeCloseCount, close matches are still returned in the match list. */
  includeCloseMatchesInResults?: boolean
}

export type NearbyMatchScanResult = {
  matches: Record<string, unknown>[]
  closeMatchCount: number
}

function demoAnswer(quiz: ReturnType<typeof normalizeQuizProgress>, key: string, fallbackIndex: number) {
  return readDemoAnswer(quiz.answers, key, fallbackIndex, quiz.preferredAnswers)
}

type Coords = { lat: number; lng: number }

async function resolveCoords(
  uid: string,
  profile: Record<string, unknown>,
  collection: 'users' | 'publicProfiles',
): Promise<Coords | null> {
  const fields = readProfileLocationFields(profile)
  const normalized = resolveProfileLocation(profile)
  const cacheKey = locationCacheKey(profile)

  const cached = profile.coordinates as Coords | undefined
  const updatedAt = profile.coordinatesUpdatedAt
  const geocodedFrom = String(profile.geocodedFromLocation ?? '').trim()
  if (cached?.lat != null && cached?.lng != null && updatedAt && geocodedFrom === cacheKey) {
    const age =
      updatedAt instanceof Object && 'toMillis' in updatedAt
        ? Date.now() - (updatedAt as { toMillis: () => number }).toMillis()
        : Date.now()
    if (age < 30 * 24 * 60 * 60 * 1000) return cached
  }

  if (!fields.location && !normalized) return null

  const coords = await geocodeLocation(fields.location, {
    city: fields.city,
    stateCode: fields.stateCode,
  })
  if (!coords) return null

  const db = getDb()
  const payload: Record<string, unknown> = {
    coordinates: coords,
    coordinatesUpdatedAt: FieldValue.serverTimestamp(),
    geocodedFromLocation: cacheKey,
  }

  if (normalized) {
    payload.location = normalized.display
    payload.locationCity = normalized.city
    payload.locationStateCode = normalized.stateCode
  }

  await db.collection(collection).doc(uid).set(payload, { merge: true })
  if (collection === 'users') {
    await db.collection('publicProfiles').doc(uid).set(payload, { merge: true })
  }
  return coords
}

export async function distanceMilesBetweenUsers(
  userAId: string,
  userAProfile: Record<string, unknown>,
  userBId: string,
  userBProfile: Record<string, unknown>,
): Promise<number | null> {
  const coordsA = await resolveCoords(userAId, userAProfile, 'users')
  const coordsB = await resolveCoords(userBId, userBProfile, 'publicProfiles')
  if (!coordsA || !coordsB) return null
  return Math.round(haversineMiles(coordsA.lat, coordsA.lng, coordsB.lat, coordsB.lng))
}

export async function findNearbyMatches(
  uid: string,
  maxDistance = 50,
  minCompatibility = 5,
  options: NearbyMatchScanOptions = {},
): Promise<NearbyMatchScanResult> {
  const { closeCountOnly = false, includeCloseCount = false, includeCloseMatchesInResults = false } =
    options
  const db = getDb()
  const [userQuizSnap, userProfileSnap, userPublicSnap] = await Promise.all([
    db.collection('quizProgress').doc(uid).get(),
    db.collection('users').doc(uid).get(),
    db.collection('publicProfiles').doc(uid).get(),
  ])

  const userProfile = userProfileSnap.exists ? (userProfileSnap.data() ?? {}) : {}

  if (!userQuizSnap.exists) {
    if (isQuizCompleteForMatching({}, userProfile)) {
      return { matches: [], closeMatchCount: 0 }
    }
    throw new ApiError('Complete the quiz before matching.', 412)
  }

  const rawQuiz = userQuizSnap.data() ?? {}
  const userQuiz = await syncQuizProgressForMatching(uid, rawQuiz, userProfile)
  if (!isQuizCompleteForMatching(rawQuiz, userProfile)) {
    throw new ApiError('Complete the quiz before matching.', 412)
  }

  const userPublic = userPublicSnap.exists ? (userPublicSnap.data() ?? {}) : {}
  const mergedProfile = { ...userProfile, ...userPublic }

  const myCoords = await resolveCoords(uid, mergedProfile, 'users')
  if (!myCoords) {
    throw new ApiError('Add a location to your profile to find nearby matches.', 412)
  }

  const myGender = demoAnswer(userQuiz, 'demo_000', 0)
  const myInterestedIn = demoAnswer(userQuiz, 'demo_001', 1)
  const myIntent = toArrayOrEmpty(demoAnswer(userQuiz, 'demo_002', 2))
  const viewerDemographicsSet = viewerHasDemographics(myGender, myInterestedIn)

  const ageRangeMin = userProfile.ageRangeMin ? parseInt(String(userProfile.ageRangeMin), 10) : null
  const ageRangeMax = userProfile.ageRangeMax ? parseInt(String(userProfile.ageRangeMax), 10) : null
  const hasAgeRange =
    ageRangeMin !== null &&
    ageRangeMax !== null &&
    !Number.isNaN(ageRangeMin) &&
    !Number.isNaN(ageRangeMax)

  const completedSnap = await db.collection('quizProgress').where('completed', '==', true).get()
  const matches: Record<string, unknown>[] = []
  let closeMatchCount = 0

  const candidateUids = completedSnap.docs.map((doc) => doc.id).filter((id) => id !== uid)
  const verifiedEmailMap = await getVerifiedEmailMap(candidateUids)

  for (const doc of completedSnap.docs) {
    if (doc.id === uid) continue
    // Profiles with an unverified email never surface in community/matching, even if
    // `visibleInCommunity` is true (trust & safety requirement).
    if (verifiedEmailMap.get(doc.id) !== true) continue
    const otherQuiz = normalizeQuizProgress(doc.data())

    if (viewerDemographicsSet) {
      const otherGender = demoAnswer(otherQuiz, 'demo_000', 0)
      const otherInterestedIn = demoAnswer(otherQuiz, 'demo_001', 1)
      if (
        !areDemographicsCompatible(myGender, myInterestedIn, otherGender, otherInterestedIn)
      ) {
        continue
      }
    }

    const otherIntent = toArrayOrEmpty(demoAnswer(otherQuiz, 'demo_002', 2))
    if (myIntent.length > 0 && otherIntent.length > 0 && !arraysOverlap(myIntent, otherIntent)) continue

    const compat = calculateCompatibility(userQuiz, otherQuiz)
    if (compat.overall < minCompatibility) continue

    const [publicSnap, userSnap] = await Promise.all([
      db.collection('publicProfiles').doc(doc.id).get(),
      db.collection('users').doc(doc.id).get(),
    ])
    if (!publicSnap.exists || !userSnap.exists) continue

    const p = publicSnap.data() ?? {}
    const otherUser = userSnap.exists ? (userSnap.data() ?? {}) : {}
    if (!isVisibleInCommunity(p) || !isVisibleInCommunity(otherUser)) continue

    const name = String(p.name ?? '').trim()
    const image = String(p.image ?? '').trim()
    const about = String(p.about ?? '').trim()
    const location = String(p.location ?? '').trim()
    if (!name || name.toLowerCase() === 'anonymous' || !image || !about || !location) continue

    if (hasAgeRange) {
      const otherAge = otherUser.age ? parseInt(String(otherUser.age), 10) : null
      if (otherAge === null || Number.isNaN(otherAge)) continue
      if (otherAge < ageRangeMin! || otherAge > ageRangeMax!) continue
    }

    const otherCoords = await resolveCoords(doc.id, { ...otherUser, ...p }, 'publicProfiles')
    if (!otherCoords) continue

    const distance = haversineMiles(myCoords.lat, myCoords.lng, otherCoords.lat, otherCoords.lng)

    const isCloseMatch =
      distance > 0 && distance < CLOSE_MATCHES_THRESHOLD_MILES
    if (isCloseMatch) {
      closeMatchCount += 1
    }

    if (closeCountOnly) {
      continue
    }

    if (isCloseMatch && includeCloseCount && !includeCloseMatchesInResults) {
      continue
    }

    if (distance > maxDistance) continue

    matches.push({
      userId: doc.id,
      name,
      location,
      image,
      about,
      interests: Array.isArray(p.interests) ? p.interests : [],
      communication: compat.communication,
      intimacy: compat.intimacy,
      values: compat.values,
      social: compat.social,
      commitment: compat.commitment,
      overall: compat.overall,
      compatibility: compat,
      distance: Math.round(distance),
      archetype: doc.data().archetype ?? null,
    })
  }

  if (closeCountOnly) {
    return { matches: [], closeMatchCount }
  }

  matches.sort((a, b) => (b.overall as number) - (a.overall as number))
  return {
    matches: matches.map(formatMatchForClient),
    closeMatchCount: includeCloseCount ? closeMatchCount : 0,
  }
}
