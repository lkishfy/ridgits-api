/**
 * One-time / periodic backfill: geocode profile locations and persist coordinates.
 *
 * Usage (from ridgits-api/):
 *   npm run backfill:locations
 *   npm run backfill:locations -- --dry-run
 *   npm run backfill:locations -- --limit 50
 *   npm run backfill:locations -- --uid YOUR_FIREBASE_UID
 *
 * Requires Firebase Admin credentials in .env.local (same as `npm run dev`).
 */

import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '../src/lib/firebase-admin'
import {
  coordsNeedRefresh,
  geocodeLocationCached,
  readStoredCoords,
} from '../src/lib/matching/geocode-cache'
import {
  locationCacheKey,
  readProfileLocationFields,
  resolveProfileLocation,
} from '../src/lib/location/normalize'

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

type Options = {
  dryRun: boolean
  limit: number | null
  uid: string | null
  concurrency: number
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    dryRun: false,
    limit: null,
    uid: null,
    concurrency: 4,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (arg === '--limit') {
      options.limit = parseInt(argv[i + 1] ?? '', 10)
      i += 1
      continue
    }
    if (arg === '--uid') {
      options.uid = String(argv[i + 1] ?? '').trim() || null
      i += 1
      continue
    }
    if (arg === '--concurrency') {
      options.concurrency = Math.max(1, parseInt(argv[i + 1] ?? '', 10) || 4)
      i += 1
    }
  }

  return options
}

function isInContinentalUS(lat: number, lng: number): boolean {
  return lat >= 24.5 && lat <= 49.0 && lng >= -125.0 && lng <= -66.9
}

function profileNeedsGeocode(profile: Record<string, unknown>): boolean {
  const fields = readProfileLocationFields(profile)
  const normalized = resolveProfileLocation(profile)
  if (!fields.location && !normalized) return false

  const stored = readStoredCoords(profile)
  if (!stored || !isInContinentalUS(stored.lat, stored.lng)) return true
  return coordsNeedRefresh(profile)
}

async function backfillProfile(uid: string, dryRun: boolean): Promise<'updated' | 'skipped' | 'failed'> {
  const db = getDb()
  const [userSnap, publicSnap] = await Promise.all([
    db.collection('users').doc(uid).get(),
    db.collection('publicProfiles').doc(uid).get(),
  ])

  if (!userSnap.exists && !publicSnap.exists) return 'skipped'

  const userProfile = userSnap.exists ? (userSnap.data() ?? {}) : {}
  const publicProfile = publicSnap.exists ? (publicSnap.data() ?? {}) : {}
  const merged = { ...userProfile, ...publicProfile }

  if (!profileNeedsGeocode(merged)) return 'skipped'

  const fields = readProfileLocationFields(merged)
  const normalized = resolveProfileLocation(merged)
  const cacheKey = locationCacheKey(merged)

  if (dryRun) {
    console.log(`[dry-run] would geocode ${uid}: ${cacheKey || fields.location || 'unknown'}`)
    return 'updated'
  }

  const coords = await geocodeLocationCached(fields.location, {
    city: fields.city || normalized?.city,
    stateCode: fields.stateCode || normalized?.stateCode,
  })

  if (!coords || !isInContinentalUS(coords.lat, coords.lng)) {
    console.warn(`[skip] ${uid}: geocode failed for ${cacheKey || fields.location}`)
    return 'failed'
  }

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

  await Promise.all([
    db.collection('users').doc(uid).set(payload, { merge: true }),
    db.collection('publicProfiles').doc(uid).set(payload, { merge: true }),
  ])

  console.log(`[ok] ${uid}: ${cacheKey} -> ${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}`)
  return 'updated'
}

async function runInBatches<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0

  async function next(): Promise<void> {
    while (index < items.length) {
      const current = items[index]
      index += 1
      await worker(current)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => next()))
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const db = getDb()

  console.log(
    `Backfill profile locations (dryRun=${options.dryRun}, limit=${options.limit ?? 'none'}, concurrency=${options.concurrency})`,
  )

  let uids: string[] = []

  if (options.uid) {
    uids = [options.uid]
  } else {
    const snap = await db.collection('publicProfiles').get()
    uids = snap.docs.map((doc) => doc.id)
  }

  const candidates: string[] = []
  for (const uid of uids) {
    const publicSnap = await db.collection('publicProfiles').doc(uid).get()
    const userSnap = await db.collection('users').doc(uid).get()
    const merged = {
      ...(userSnap.exists ? (userSnap.data() ?? {}) : {}),
      ...(publicSnap.exists ? (publicSnap.data() ?? {}) : {}),
    }
    if (profileNeedsGeocode(merged)) {
      candidates.push(uid)
    }
    if (options.limit != null && candidates.length >= options.limit) break
  }

  console.log(`Found ${candidates.length} profile(s) needing geocode.`)

  let updated = 0
  let skipped = 0
  let failed = 0

  await runInBatches(candidates, options.concurrency, async (uid) => {
    const result = await backfillProfile(uid, options.dryRun)
    if (result === 'updated') updated += 1
    else if (result === 'failed') failed += 1
    else skipped += 1
  })

  console.log(`Done. updated=${updated}, failed=${failed}, skipped=${skipped}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
