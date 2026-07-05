/**
 * Read-only funnel diagnostic for nearby match undercount.
 *
 * Usage (from ridgits-api/):
 *   npm run diagnose:nearby -- --uid YOUR_FIREBASE_UID
 *   npm run diagnose:nearby -- --uid YOUR_FIREBASE_UID --metro-only
 *
 * Requires Firebase Admin credentials in .env.local (same as `npm run dev`).
 */

import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { getDb } from '../src/lib/firebase-admin'
import {
  calculateCompatibility,
  toArrayOrEmpty,
  arraysOverlap,
  haversineMiles,
  isVisibleInCommunity,
} from '../src/lib/matching/compatibility'
import {
  areDemographicsCompatible,
  readDemoAnswer,
  viewerHasDemographics,
} from '../src/lib/matching/demographics'
import { readStoredCoords } from '../src/lib/matching/geocode-cache'
import {
  isQuizCompleteForMatching,
  normalizeQuizProgress,
} from '../src/lib/matching/quiz-normalize'
import { getVerifiedEmailMap } from '../src/lib/trust-safety/email-verification'
import { isNYMetroArea, sharedMetroArea } from '../src/lib/location/metro-areas'
import { resolveProfileLocation } from '../src/lib/location/normalize'
import { CLOSE_MATCHES_THRESHOLD_MILES } from '../src/lib/ridgits-products'

function loadEnvFile(filename: string): void {
  const path = resolve(process.cwd(), filename)
  if (!existsSync(path)) return

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue

    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) {
      process.env[key] = value
    }
  }
}

loadEnvFile('.env.local')
loadEnvFile('.env')

const MAX_CANDIDATES = 120
const MIN_COMPATIBILITY = 5

type DropReason =
  | 'self'
  | 'not_in_completed_query'
  | 'eligible_via_fallback_only'
  | 'demographics'
  | 'intent'
  | 'low_compatibility'
  | 'outside_top_120'
  | 'email_unverified'
  | 'not_visible'
  | 'incomplete_profile'
  | 'age_range'
  | 'no_distance'
  | 'outside_radius_box'
  | 'included'

type CandidateReport = {
  userId: string
  name: string
  location: string
  normalizedLocation: string | null
  inMetro: boolean
  completedFlag: boolean
  eligibleViaFallback: boolean
  compatScore: number | null
  rank: number | null
  dropReason: DropReason
  distance: number | null
}

function demoAnswer(
  quiz: ReturnType<typeof normalizeQuizProgress>,
  key: string,
  fallbackIndex: number,
) {
  return readDemoAnswer(quiz.answers, key, fallbackIndex, quiz.preferredAnswers)
}

function parseArgs(argv: string[]): { uid: string | null; metroOnly: boolean } {
  let uid: string | null = null
  let metroOnly = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--uid') {
      uid = String(argv[i + 1] ?? '').trim() || null
      i += 1
      continue
    }
    if (arg === '--metro-only') {
      metroOnly = true
    }
  }

  return { uid, metroOnly }
}

function isCloseDistance(distance: number | null): boolean {
  return distance != null && distance >= 0 && distance < CLOSE_MATCHES_THRESHOLD_MILES
}

function resolveCloseDistanceMiles(
  viewerProfile: Record<string, unknown>,
  viewerCoords: { lat: number; lng: number } | null,
  otherProfile: Record<string, unknown>,
): number | null {
  if (sharedMetroArea(viewerProfile, otherProfile)) return 0

  const otherCoords = readStoredCoords(otherProfile)
  if (!viewerCoords || !otherCoords) return null

  return haversineMiles(viewerCoords.lat, viewerCoords.lng, otherCoords.lat, otherCoords.lng)
}

async function main(): Promise<void> {
  const { uid, metroOnly } = parseArgs(process.argv.slice(2))
  if (!uid) {
    console.error('Usage: npm run diagnose:nearby -- --uid YOUR_FIREBASE_UID [--metro-only]')
    process.exit(1)
  }

  const db = getDb()

  const [userQuizSnap, userProfileSnap, userPublicSnap, completedSnap, allQuizSnap] =
    await Promise.all([
      db.collection('quizProgress').doc(uid).get(),
      db.collection('users').doc(uid).get(),
      db.collection('publicProfiles').doc(uid).get(),
      db.collection('quizProgress').where('completed', '==', true).get(),
      db.collection('quizProgress').get(),
    ])

  const userProfile = userProfileSnap.exists ? (userProfileSnap.data() ?? {}) : {}
  const userPublic = userPublicSnap.exists ? (userPublicSnap.data() ?? {}) : {}
  const mergedViewer = { ...userProfile, ...userPublic }
  const viewerCoords = readStoredCoords(mergedViewer)
  const viewerInMetro = isNYMetroArea(mergedViewer)
  const viewerLocation = String(mergedViewer.location ?? '').trim()

  console.log('\n=== Viewer ===')
  console.log(`uid: ${uid}`)
  console.log(`location: ${viewerLocation || '(none)'}`)
  console.log(`in_nyc_metro: ${viewerInMetro}`)
  console.log(`stored_coords: ${viewerCoords ? `${viewerCoords.lat}, ${viewerCoords.lng}` : 'none'}`)

  if (!userQuizSnap.exists) {
    console.error('Viewer has no quizProgress doc.')
    process.exit(1)
  }

  const rawViewerQuiz = userQuizSnap.data() ?? {}
  const userQuiz = normalizeQuizProgress(rawViewerQuiz)
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

  const completedIds = new Set(completedSnap.docs.map((doc) => doc.id))

  type Scored = { userId: string; compat: number }
  const scored: Scored[] = []
  const fallbackEligibleNotInQuery: string[] = []

  for (const doc of allQuizSnap.docs) {
    if (doc.id === uid) continue
    const raw = doc.data() ?? {}
    const otherUserSnap = await db.collection('users').doc(doc.id).get()
    const otherUserProfile = otherUserSnap.exists ? (otherUserSnap.data() ?? {}) : {}
    const inCompletedQuery = completedIds.has(doc.id)
    const eligibleViaFallback = isQuizCompleteForMatching(raw, otherUserProfile)

    if (!inCompletedQuery && eligibleViaFallback) {
      fallbackEligibleNotInQuery.push(doc.id)
    }
    if (!inCompletedQuery) continue

    const otherQuiz = normalizeQuizProgress(raw)

    if (viewerDemographicsSet) {
      const otherGender = demoAnswer(otherQuiz, 'demo_000', 0)
      const otherInterestedIn = demoAnswer(otherQuiz, 'demo_001', 1)
      if (!areDemographicsCompatible(myGender, myInterestedIn, otherGender, otherInterestedIn)) {
        continue
      }
    }

    const otherIntent = toArrayOrEmpty(demoAnswer(otherQuiz, 'demo_002', 2))
    if (myIntent.length > 0 && otherIntent.length > 0 && !arraysOverlap(myIntent, otherIntent)) {
      continue
    }

    const compat = calculateCompatibility(userQuiz, otherQuiz)
    if (compat.overall < MIN_COMPATIBILITY) continue

    scored.push({ userId: doc.id, compat: compat.overall })
  }

  scored.sort((a, b) => b.compat - a.compat)
  const rankById = new Map(scored.map((entry, index) => [entry.userId, index + 1]))

  const allCandidateIds = scored.map((entry) => entry.userId)
  const top120Ids = new Set(allCandidateIds.slice(0, MAX_CANDIDATES))
  const verifiedEmailMap = await getVerifiedEmailMap(allCandidateIds)

  const reports: CandidateReport[] = []

  for (const doc of allQuizSnap.docs) {
    if (doc.id === uid) continue

    const raw = doc.data() ?? {}
    const otherUserSnap = await db.collection('users').doc(doc.id).get()
    const otherPublicSnap = await db.collection('publicProfiles').doc(doc.id).get()
    const otherUser = otherUserSnap.exists ? (otherUserSnap.data() ?? {}) : {}
    const otherPublic = otherPublicSnap.exists ? (otherPublicSnap.data() ?? {}) : {}
    const mergedOther = { ...otherUser, ...otherPublic }

    const inMetro = isNYMetroArea(mergedOther)
    if (metroOnly && !inMetro) continue

    const completedFlag = completedIds.has(doc.id)
    const eligibleViaFallback = isQuizCompleteForMatching(raw, otherUser)
    const normalized = resolveProfileLocation(mergedOther)
    const name = String(otherPublic.name ?? '').trim()
    const location = String(otherPublic.location ?? '').trim()

    let dropReason: DropReason = 'included'
    let compatScore: number | null = null
    let rank: number | null = rankById.get(doc.id) ?? null
    let distance: number | null = null

    if (!completedFlag) {
      dropReason = eligibleViaFallback ? 'eligible_via_fallback_only' : 'not_in_completed_query'
    } else {
      const otherQuiz = normalizeQuizProgress(raw)

      if (viewerDemographicsSet) {
        const otherGender = demoAnswer(otherQuiz, 'demo_000', 0)
        const otherInterestedIn = demoAnswer(otherQuiz, 'demo_001', 1)
        if (!areDemographicsCompatible(myGender, myInterestedIn, otherGender, otherInterestedIn)) {
          dropReason = 'demographics'
        }
      }

      if (dropReason === 'included') {
        const otherIntent = toArrayOrEmpty(demoAnswer(otherQuiz, 'demo_002', 2))
        if (myIntent.length > 0 && otherIntent.length > 0 && !arraysOverlap(myIntent, otherIntent)) {
          dropReason = 'intent'
        }
      }

      if (dropReason === 'included') {
        const compat = calculateCompatibility(userQuiz, otherQuiz)
        compatScore = compat.overall
        if (compat.overall < MIN_COMPATIBILITY) {
          dropReason = 'low_compatibility'
        }
      }

      if (dropReason === 'included' && !top120Ids.has(doc.id)) {
        dropReason = 'outside_top_120'
      }

      if (dropReason === 'included' && verifiedEmailMap.get(doc.id) !== true) {
        dropReason = 'email_unverified'
      }

      if (dropReason === 'included' && (!isVisibleInCommunity(otherPublic) || !isVisibleInCommunity(otherUser))) {
        dropReason = 'not_visible'
      }

      if (dropReason === 'included') {
        const image = String(otherPublic.image ?? '').trim()
        const about = String(otherPublic.about ?? '').trim()
        if (!name || name.toLowerCase() === 'anonymous' || !image || !about || !location) {
          dropReason = 'incomplete_profile'
        }
      }

      if (dropReason === 'included' && hasAgeRange) {
        const otherAge = otherUser.age ? parseInt(String(otherUser.age), 10) : null
        if (otherAge === null || Number.isNaN(otherAge)) {
          dropReason = 'age_range'
        } else if (otherAge < ageRangeMin! || otherAge > ageRangeMax!) {
          dropReason = 'age_range'
        }
      }

      if (dropReason === 'included') {
        distance = resolveCloseDistanceMiles(mergedViewer, viewerCoords, mergedOther)
        if (distance == null) {
          dropReason = 'no_distance'
        }
      }
    }

    if (dropReason === 'included' && distance == null && completedFlag) {
      distance = resolveCloseDistanceMiles(mergedViewer, viewerCoords, mergedOther)
    }

    reports.push({
      userId: doc.id,
      name: name || '(no name)',
      location: location || '(no location)',
      normalizedLocation: normalized?.display ?? null,
      inMetro,
      completedFlag,
      eligibleViaFallback,
      compatScore,
      rank,
      dropReason,
      distance: distance != null ? Math.round(distance) : null,
    })
  }

  const reasonCounts = new Map<DropReason, number>()
  for (const report of reports) {
    reasonCounts.set(report.dropReason, (reasonCounts.get(report.dropReason) ?? 0) + 1)
  }

  const closeInTop120 = reports.filter(
    (r) => r.dropReason === 'included' && isCloseDistance(r.distance),
  ).length

  const closeAllScored = scored.filter((entry) => {
    const report = reports.find((r) => r.userId === entry.userId)
    if (!report) return false
    const dist = resolveCloseDistanceMiles(mergedViewer, viewerCoords, {
      location: report.location,
    })
    return isCloseDistance(dist)
  }).length

  console.log('\n=== Funnel summary ===')
  console.log(`completed=true in query: ${completedIds.size}`)
  console.log(`eligible via fallback but NOT in completed query: ${fallbackEligibleNotInQuery.length}`)
  console.log(`after demo/intent/compat filters (scored): ${scored.length}`)
  console.log(`top ${MAX_CANDIDATES} by compatibility: ${Math.min(scored.length, MAX_CANDIDATES)}`)
  console.log(`close matches (top-120 path, full filters): ${closeInTop120}`)
  console.log(`close matches (all scored, metro/coords only): ${closeAllScored}`)

  console.log('\n=== Drop reasons (metro filter: ' + (metroOnly ? 'on' : 'off') + ') ===')
  for (const [reason, count] of [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason}: ${count}`)
  }

  const metroReports = reports.filter((r) => r.inMetro)
  console.log(`\n=== NYC metro users (${metroReports.length}) ===`)
  const metroReasons = new Map<DropReason, number>()
  for (const report of metroReports) {
    metroReasons.set(report.dropReason, (metroReasons.get(report.dropReason) ?? 0) + 1)
  }
  for (const [reason, count] of [...metroReasons.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason}: ${count}`)
  }

  console.log('\n=== Sample metro users (first 40) ===')
  for (const report of metroReports.slice(0, 40)) {
    console.log(
      [
        report.userId.slice(0, 8),
        report.name.slice(0, 20),
        report.location.slice(0, 30),
        report.normalizedLocation ?? 'unparsed',
        `completed=${report.completedFlag}`,
        report.dropReason,
        report.compatScore != null ? `compat=${report.compatScore}` : '',
        report.rank != null ? `rank=${report.rank}` : '',
        report.distance != null ? `${report.distance}mi` : '',
      ]
        .filter(Boolean)
        .join(' | '),
    )
  }

  if (fallbackEligibleNotInQuery.length > 0) {
    console.log('\n=== Fallback-eligible but missing completed=true (first 20 uids) ===')
    console.log(fallbackEligibleNotInQuery.slice(0, 20).join('\n'))
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
