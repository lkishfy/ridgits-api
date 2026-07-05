import { FieldValue } from 'firebase-admin/firestore'
import { ApiError } from '@/lib/api-errors'
import { getDb } from '@/lib/firebase-admin'
import {
  calculateCompatibility,
  toArrayOrEmpty,
  arraysOverlap,
  haversineMiles,
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
import { sharedMetroArea } from '@/lib/location/metro-areas'
import {
  batchGeocodeLocations,
  coordsNeedRefresh,
  geocodeLocationCached,
  readStoredCoords,
  type Coords,
} from '@/lib/matching/geocode-cache'
import { isProfilePhotoIdentityVerified } from '@/lib/trust-safety/profile-identity-match'
import { effectiveSubscriptionTier } from '@/lib/subscription-badge'
import {
  isQuizCompleteForMatching,
  normalizeQuizProgress,
  syncQuizProgressForMatching,
} from '@/lib/matching/quiz-normalize'
import { getVerifiedEmailMap } from '@/lib/trust-safety/email-verification'
import { CLOSE_MATCHES_THRESHOLD_MILES } from '@/lib/ridgits-products'

export type NearbyMatchScanOptions = {
  closeCountOnly?: boolean
  includeCloseCount?: boolean
  includeCloseMatchesInResults?: boolean
  /** Count matches closer than this (exclusive). Defaults to CLOSE_MATCHES_THRESHOLD_MILES. */
  closeMatchThresholdMiles?: number
  /** When true, only count same-metro matches (distance 0) for the close-match teaser. */
  closeMatchMetroOnly?: boolean
}

export type CloseMatchPreview = {
  userId: string
  name: string
  image: string
}

export type CloseMatchScanResult = {
  count: number
  previews: CloseMatchPreview[]
  /** All compatible user ids within the close-match radius (not only top previews). */
  userIds: string[]
}

export type NearbyMatchScanResult = {
  matches: Record<string, unknown>[]
  closeMatchCount: number
  closeMatches: CloseMatchPreview[]
}

const MAX_CANDIDATES = 120
const MAX_CLOSE_MATCH_PREVIEWS = 5
const PROFILE_BATCH_SIZE = 10

function demoAnswer(quiz: ReturnType<typeof normalizeQuizProgress>, key: string, fallbackIndex: number) {
  return readDemoAnswer(quiz.answers, key, fallbackIndex, quiz.preferredAnswers)
}

function isInContinentalUS(lat: number, lng: number): boolean {
  return lat >= 24.5 && lat <= 49.0 && lng >= -125.0 && lng <= -66.9
}

function isWithinCoordinateBox(
  lat: number,
  lng: number,
  centerLat: number,
  centerLng: number,
  maxMiles: number,
): boolean {
  const latDelta = maxMiles / 69
  const lngDelta = maxMiles / Math.max(69 * Math.cos((centerLat * Math.PI) / 180), 0.01)
  return Math.abs(lat - centerLat) <= latDelta && Math.abs(lng - centerLng) <= lngDelta
}

function isCloseDistance(
  distance: number | null,
  thresholdMiles: number,
  metroOnly = false,
): boolean {
  if (distance == null) return false
  if (metroOnly) return distance === 0
  return distance >= 0 && distance < thresholdMiles
}

async function resolveCoords(
  uid: string,
  profile: Record<string, unknown>,
  collection: 'users' | 'publicProfiles',
): Promise<Coords | null> {
  const stored = readStoredCoords(profile)
  if (stored && isInContinentalUS(stored.lat, stored.lng) && !coordsNeedRefresh(profile)) {
    return stored
  }

  const fields = readProfileLocationFields(profile)
  const normalized = resolveProfileLocation(profile)
  const cacheKey = locationCacheKey(profile)
  if (!fields.location && !normalized) {
    return stored && isInContinentalUS(stored.lat, stored.lng) ? stored : null
  }

  const coords =
    (await geocodeLocationCached(fields.location, {
      city: fields.city || normalized?.city,
      stateCode: fields.stateCode || normalized?.stateCode,
    })) ??
    stored ??
    null

  if (!coords || !isInContinentalUS(coords.lat, coords.lng)) return null

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
  if (sharedMetroArea(userAProfile, userBProfile)) return 0
  const coordsA = await resolveCoords(userAId, userAProfile, 'users')
  const coordsB = await resolveCoords(userBId, userBProfile, 'publicProfiles')
  if (!coordsA || !coordsB) return null
  return Math.round(haversineMiles(coordsA.lat, coordsA.lng, coordsB.lat, coordsB.lng))
}

type ScoredCandidate = {
  userId: string
  compat: ReturnType<typeof calculateCompatibility>
}

function resolveCloseDistanceMiles(
  myCoords: Coords,
  myProfile: Record<string, unknown>,
  otherProfile: Record<string, unknown>,
): number | null {
  if (sharedMetroArea(myProfile, otherProfile)) return 0

  const otherCoords = readStoredCoords(otherProfile)
  if (!otherCoords) return null

  return haversineMiles(myCoords.lat, myCoords.lng, otherCoords.lat, otherCoords.lng)
}

async function loadProfileMaps(
  candidateIds: string[],
): Promise<{
  profileById: Map<string, Record<string, unknown>>
  userById: Map<string, Record<string, unknown>>
}> {
  const db = getDb()
  const profileById = new Map<string, Record<string, unknown>>()
  const userById = new Map<string, Record<string, unknown>>()

  for (let i = 0; i < candidateIds.length; i += PROFILE_BATCH_SIZE) {
    const batch = candidateIds.slice(i, i + PROFILE_BATCH_SIZE)
    const [publicSnaps, userSnaps] = await Promise.all([
      Promise.all(batch.map((id) => db.collection('publicProfiles').doc(id).get())),
      Promise.all(batch.map((id) => db.collection('users').doc(id).get())),
    ])
    for (let j = 0; j < batch.length; j += 1) {
      const id = batch[j]!
      if (publicSnaps[j]?.exists) profileById.set(id, publicSnaps[j]!.data() ?? {})
      if (userSnaps[j]?.exists) userById.set(id, userSnaps[j]!.data() ?? {})
    }
  }

  return { profileById, userById }
}

function passesProfileFilters(
  candidateId: string,
  publicProfile: Record<string, unknown>,
  privateProfile: Record<string, unknown>,
  verifiedEmailMap: Map<string, boolean>,
  hasAgeRange: boolean,
  ageRangeMin: number | null,
  ageRangeMax: number | null,
): boolean {
  if (verifiedEmailMap.get(candidateId) !== true) return false
  if (!isVisibleInCommunity(publicProfile) || !isVisibleInCommunity(privateProfile)) return false

  const name = String(publicProfile.name ?? '').trim()
  const image = String(publicProfile.image ?? '').trim()
  const about = String(publicProfile.about ?? '').trim()
  const location = String(publicProfile.location ?? '').trim()
  if (!name || name.toLowerCase() === 'anonymous' || !image || !about || !location) return false

  if (hasAgeRange) {
    const otherAge = privateProfile.age ? parseInt(String(privateProfile.age), 10) : null
    if (otherAge === null || Number.isNaN(otherAge)) return false
    if (otherAge < ageRangeMin! || otherAge > ageRangeMax!) return false
  }

  return true
}

/** Count close matches and pick top previews from the full scored pool (metro + stored coords). */
async function computeCloseMatches(
  scored: ScoredCandidate[],
  mergedProfile: Record<string, unknown>,
  myCoords: Coords,
  hasAgeRange: boolean,
  ageRangeMin: number | null,
  ageRangeMax: number | null,
  closeMatchThresholdMiles: number,
  closeMatchMetroOnly: boolean,
): Promise<CloseMatchScanResult> {
  if (scored.length === 0) return { count: 0, previews: [], userIds: [] }

  const allIds = scored.map((entry) => entry.userId)
  const verifiedEmailMap = await getVerifiedEmailMap(allIds)
  const { profileById, userById } = await loadProfileMaps(allIds)

  let count = 0
  const previews: CloseMatchPreview[] = []
  const userIds: string[] = []

  for (const { userId } of scored) {
    const publicProfile = profileById.get(userId)
    const privateProfile = userById.get(userId)
    if (!publicProfile || !privateProfile) continue
    if (
      !passesProfileFilters(
        userId,
        publicProfile,
        privateProfile,
        verifiedEmailMap,
        hasAgeRange,
        ageRangeMin,
        ageRangeMax,
      )
    ) {
      continue
    }

    const mergedOther = { ...privateProfile, ...publicProfile }
    const distance = resolveCloseDistanceMiles(myCoords, mergedProfile, mergedOther)
    if (!isCloseDistance(distance, closeMatchThresholdMiles, closeMatchMetroOnly)) continue

    count += 1
    userIds.push(userId)

    if (previews.length >= MAX_CLOSE_MATCH_PREVIEWS) continue

    const name = String(publicProfile.name ?? '').trim()
    const image = String(publicProfile.image ?? '').trim()
    if (!name || name.toLowerCase() === 'anonymous' || !image) continue

    previews.push({ userId, name, image })
  }

  return { count, previews, userIds }
}

function resolveDistanceMiles(
  myCoords: Coords,
  myProfile: Record<string, unknown>,
  otherProfile: Record<string, unknown>,
  otherCoords: Coords | null,
  geocodeByLocation: Map<string, Coords>,
): number | null {
  if (sharedMetroArea(myProfile, otherProfile)) return 0

  let coords = otherCoords
  if (!coords) {
    const locationKey = String(otherProfile.location ?? '').trim().toLowerCase()
    coords = geocodeByLocation.get(locationKey) ?? null
  }
  if (!coords || !isInContinentalUS(coords.lat, coords.lng)) return null

  return haversineMiles(myCoords.lat, myCoords.lng, coords.lat, coords.lng)
}

export async function findNearbyMatches(
  uid: string,
  maxDistance = 50,
  minCompatibility = 5,
  options: NearbyMatchScanOptions = {},
): Promise<NearbyMatchScanResult> {
  const {
    closeCountOnly = false,
    includeCloseCount = false,
    includeCloseMatchesInResults = false,
    closeMatchThresholdMiles = CLOSE_MATCHES_THRESHOLD_MILES,
    closeMatchMetroOnly = false,
  } = options
  const db = getDb()
  const [userQuizSnap, userProfileSnap, userPublicSnap] = await Promise.all([
    db.collection('quizProgress').doc(uid).get(),
    db.collection('users').doc(uid).get(),
    db.collection('publicProfiles').doc(uid).get(),
  ])

  const userProfile = userProfileSnap.exists ? (userProfileSnap.data() ?? {}) : {}

  if (!userQuizSnap.exists) {
    if (isQuizCompleteForMatching({}, userProfile)) {
      return { matches: [], closeMatchCount: 0, closeMatches: [] }
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
  const scored: ScoredCandidate[] = []

  for (const doc of completedSnap.docs) {
    if (doc.id === uid) continue
    const otherQuiz = normalizeQuizProgress(doc.data())

    if (viewerDemographicsSet) {
      const otherGender = demoAnswer(otherQuiz, 'demo_000', 0)
      const otherInterestedIn = demoAnswer(otherQuiz, 'demo_001', 1)
      if (!areDemographicsCompatible(myGender, myInterestedIn, otherGender, otherInterestedIn)) {
        continue
      }
    }

    const otherIntent = toArrayOrEmpty(demoAnswer(otherQuiz, 'demo_002', 2))
    if (myIntent.length > 0 && otherIntent.length > 0 && !arraysOverlap(myIntent, otherIntent)) continue

    const compat = calculateCompatibility(userQuiz, otherQuiz)
    if (compat.overall < minCompatibility) continue

    scored.push({ userId: doc.id, compat })
  }

  scored.sort((a, b) => b.compat.overall - a.compat.overall)

  const shouldComputeCloseCount = closeCountOnly || includeCloseCount
  const closeScan = shouldComputeCloseCount
    ? await computeCloseMatches(
        scored,
        mergedProfile,
        myCoords,
        hasAgeRange,
        ageRangeMin,
        ageRangeMax,
        closeMatchThresholdMiles,
        closeMatchMetroOnly,
      )
    : { count: 0, previews: [], userIds: [] }

  if (closeCountOnly) {
    return { matches: [], closeMatchCount: closeScan.count, closeMatches: closeScan.previews }
  }

  const topCandidateIds = scored.slice(0, MAX_CANDIDATES).map((entry) => entry.userId)
  const topSet = new Set(topCandidateIds)
  const extraCloseIds = closeScan.userIds.filter((id) => !topSet.has(id))
  const candidateIds = [...topCandidateIds, ...extraCloseIds]
  const compatById = new Map(scored.map((entry) => [entry.userId, entry.compat]))

  const verifiedEmailMap = await getVerifiedEmailMap(candidateIds)
  const { profileById, userById } = await loadProfileMaps(candidateIds)

  const geocodeRequests: Array<{ userId: string; location: string; city?: string; stateCode?: string }> =
    []

  for (const candidateId of candidateIds) {
    if (verifiedEmailMap.get(candidateId) !== true) continue
    const publicProfile = profileById.get(candidateId)
    const privateProfile = userById.get(candidateId)
    if (!publicProfile || !privateProfile) continue
    if (!isVisibleInCommunity(publicProfile) || !isVisibleInCommunity(privateProfile)) continue

    const merged = { ...privateProfile, ...publicProfile }
    const location = String(publicProfile.location ?? '').trim()
    if (!location) continue

    if (sharedMetroArea(mergedProfile, merged)) continue
    if (readStoredCoords(merged) && !coordsNeedRefresh(merged)) continue

    const fields = readProfileLocationFields(merged)
    const normalized = resolveProfileLocation(merged)
    geocodeRequests.push({
      userId: candidateId,
      location,
      city: fields.city || normalized?.city,
      stateCode: fields.stateCode || normalized?.stateCode,
    })
  }

  const geocodeByLocation = await batchGeocodeLocations(geocodeRequests)

  const matches: Record<string, unknown>[] = []

  for (const candidateId of candidateIds) {
    if (verifiedEmailMap.get(candidateId) !== true) continue

    const publicProfile = profileById.get(candidateId)
    const privateProfile = userById.get(candidateId)
    if (!publicProfile || !privateProfile) continue

    const p = publicProfile
    const otherUser = privateProfile
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

    const mergedOther = { ...otherUser, ...p }
    const compat = compatById.get(candidateId)
    if (!compat) continue

    let distance = resolveDistanceMiles(
      myCoords,
      mergedProfile,
      mergedOther,
      readStoredCoords(mergedOther),
      geocodeByLocation,
    )

    if (distance == null) continue

    if (distance > 0) {
      const otherCoords =
        readStoredCoords(mergedOther) ??
        geocodeByLocation.get(location.trim().toLowerCase()) ??
        null
      if (
        !otherCoords ||
        !isWithinCoordinateBox(
          otherCoords.lat,
          otherCoords.lng,
          myCoords.lat,
          myCoords.lng,
          Math.max(maxDistance, CLOSE_MATCHES_THRESHOLD_MILES),
        )
      ) {
        continue
      }
    }

    if (
      isCloseDistance(distance, closeMatchThresholdMiles, closeMatchMetroOnly) &&
      includeCloseCount &&
      !includeCloseMatchesInResults
    ) {
      continue
    }

    if (distance > maxDistance) continue

    matches.push({
      userId: candidateId,
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
      archetype: completedSnap.docs.find((doc) => doc.id === candidateId)?.data()?.archetype ?? null,
      subscriptionTier: effectiveSubscriptionTier(otherUser),
      profilePhotoVerified: isProfilePhotoIdentityVerified(otherUser, p),
    })
  }

  matches.sort((a, b) => (b.overall as number) - (a.overall as number))
  return {
    matches: matches.map(formatMatchForClient),
    closeMatchCount: includeCloseCount ? closeScan.count : 0,
    closeMatches: includeCloseCount ? closeScan.previews : [],
  }
}
