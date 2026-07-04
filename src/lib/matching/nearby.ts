import { FieldValue } from 'firebase-admin/firestore'
import { ApiError } from '@/lib/api-errors'
import { getDb } from '@/lib/firebase-admin'
import {
  calculateCompatibility,
  checkGenderMatch,
  toArrayOrEmpty,
  arraysOverlap,
  haversineMiles,
  geocodeLocation,
  formatMatchForClient,
  isVisibleInCommunity,
} from '@/lib/matching/compatibility'
import { normalizeQuizProgress } from '@/lib/matching/quiz-normalize'
import { getVerifiedEmailMap } from '@/lib/trust-safety/email-verification'
import { CLOSE_MATCHES_THRESHOLD_MILES } from '@/lib/ridgits-products'

export type NearbyMatchScanOptions = {
  /** Only count people within (0, CLOSE_MATCHES_THRESHOLD_MILES); do not return match payloads. */
  closeCountOnly?: boolean
  /** When true, track closeMatchCount while building the full match list in one pass. */
  includeCloseCount?: boolean
}

export type NearbyMatchScanResult = {
  matches: Record<string, unknown>[]
  closeMatchCount: number
}

function demoAnswer(quiz: ReturnType<typeof normalizeQuizProgress>, key: string, fallbackIndex: number) {
  return quiz.answers[key] ?? quiz.answers[String(fallbackIndex)]
}

type Coords = { lat: number; lng: number }

async function resolveCoords(
  uid: string,
  profile: Record<string, unknown>,
  collection: 'users' | 'publicProfiles',
): Promise<Coords | null> {
  const cached = profile.coordinates as Coords | undefined
  const updatedAt = profile.coordinatesUpdatedAt
  if (cached?.lat != null && cached?.lng != null && updatedAt) {
    const age =
      updatedAt instanceof Object && 'toMillis' in updatedAt
        ? Date.now() - (updatedAt as { toMillis: () => number }).toMillis()
        : Date.now()
    if (age < 30 * 24 * 60 * 60 * 1000) return cached
  }

  const location = String(profile.location ?? '').trim()
  if (!location) return null

  const coords = await geocodeLocation(location)
  if (!coords) return null

  const db = getDb()
  const payload = {
    coordinates: coords,
    coordinatesUpdatedAt: FieldValue.serverTimestamp(),
    geocodedFromLocation: location,
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
  const { closeCountOnly = false, includeCloseCount = false } = options
  const db = getDb()
  const [userQuizSnap, userProfileSnap, userPublicSnap] = await Promise.all([
    db.collection('quizProgress').doc(uid).get(),
    db.collection('users').doc(uid).get(),
    db.collection('publicProfiles').doc(uid).get(),
  ])

  if (!userQuizSnap.exists) {
    throw new ApiError('Complete the quiz before matching.', 412)
  }

  const userQuiz = normalizeQuizProgress(userQuizSnap.data() ?? {})
  if (!userQuiz.completed || Object.keys(userQuiz.answers).length === 0) {
    throw new ApiError('Complete the quiz before matching.', 412)
  }

  const userProfile = userProfileSnap.exists ? (userProfileSnap.data() ?? {}) : {}
  const userPublic = userPublicSnap.exists ? (userPublicSnap.data() ?? {}) : {}
  const mergedProfile = { ...userProfile, ...userPublic }

  const myCoords = await resolveCoords(uid, mergedProfile, 'users')
  if (!myCoords) {
    throw new ApiError('Add a location to your profile to find nearby matches.', 412)
  }

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

    if (myGender !== undefined && myLookingFor !== undefined) {
      const otherGender = demoAnswer(otherQuiz, 'demo_000', 0)
      const otherLookingFor = demoAnswer(otherQuiz, 'demo_001', 1)
      if (otherGender === undefined || otherLookingFor === undefined) continue
      if (!checkGenderMatch(myGender, otherLookingFor) || !checkGenderMatch(otherGender, myLookingFor)) {
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

    if (isCloseMatch && includeCloseCount) {
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
