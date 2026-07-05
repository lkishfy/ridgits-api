import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '@/lib/firebase-admin'
import { geocodeLocation } from '@/lib/matching/compatibility'
import { locationCacheKey, readProfileLocationFields } from '@/lib/location/normalize'

export type Coords = { lat: number; lng: number }

const MAX_GEOCODES_PER_SCAN = 40
const GEOCODE_CONCURRENCY = 4

function cacheDocId(location: string): string {
  return encodeURIComponent(location.trim().toLowerCase())
}

export async function readLocationCache(location: string): Promise<Coords | null> {
  const key = cacheDocId(location)
  if (!key) return null
  try {
    const snap = await getDb().collection('locationCache').doc(key).get()
    if (!snap.exists) return null
    const data = snap.data() ?? {}
    const lat = typeof data.lat === 'number' ? data.lat : null
    const lng = typeof data.lng === 'number' ? data.lng : null
    if (lat == null || lng == null) return null
    return { lat, lng }
  } catch {
    return null
  }
}

async function writeLocationCache(location: string, coords: Coords): Promise<void> {
  const key = cacheDocId(location)
  if (!key) return
  try {
    await getDb()
      .collection('locationCache')
      .doc(key)
      .set(
        {
          lat: coords.lat,
          lng: coords.lng,
          updatedAt: FieldValue.serverTimestamp(),
          source: 'nominatim',
        },
        { merge: true },
      )
  } catch {
    // Non-fatal.
  }
}

export async function geocodeLocationCached(
  location: string,
  structured?: { city?: string | null; stateCode?: string | null },
): Promise<Coords | null> {
  const trimmed = location.trim()
  if (!trimmed && !structured?.city) return null

  const cached = await readLocationCache(trimmed || `${structured?.city}, ${structured?.stateCode}`)
  if (cached) return cached

  const coords = await geocodeLocation(trimmed, structured)
  if (!coords) return null

  await writeLocationCache(trimmed || locationCacheKey({ location: trimmed, ...structured }), coords)
  return coords
}

/** Deduplicated batch geocode for nearby scans. Returns map keyed by lowercase location string. */
export async function batchGeocodeLocations(
  entries: Array<{ userId: string; location: string; city?: string; stateCode?: string }>,
): Promise<Map<string, Coords>> {
  const unique: Array<{ location: string; city?: string; stateCode?: string }> = []
  const seen = new Set<string>()

  for (const entry of entries) {
    const key = entry.location.trim().toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    unique.push(entry)
  }

  const toProcess = unique.slice(0, MAX_GEOCODES_PER_SCAN)
  const results = new Map<string, Coords>()

  for (let i = 0; i < toProcess.length; i += GEOCODE_CONCURRENCY) {
    const batch = toProcess.slice(i, i + GEOCODE_CONCURRENCY)
    await Promise.all(
      batch.map(async (entry) => {
        const key = entry.location.trim().toLowerCase()
        if (results.has(key)) return
        const cached = await readLocationCache(entry.location)
        if (cached) {
          results.set(key, cached)
          return
        }
        const coords = await geocodeLocation(entry.location, {
          city: entry.city,
          stateCode: entry.stateCode,
        })
        if (!coords) return
        results.set(key, coords)
        await writeLocationCache(entry.location, coords)
      }),
    )
  }

  return results
}

export function readStoredCoords(profile: Record<string, unknown>): Coords | null {
  const coords = profile.coordinates as { lat?: unknown; lng?: unknown } | undefined
  if (typeof coords?.lat !== 'number' || typeof coords?.lng !== 'number') return null
  if (Number.isNaN(coords.lat) || Number.isNaN(coords.lng)) return null
  return { lat: coords.lat, lng: coords.lng }
}

export function coordsNeedRefresh(profile: Record<string, unknown>): boolean {
  const fields = readProfileLocationFields(profile)
  const cacheKey = locationCacheKey(profile)
  const geocodedFrom = String(profile.geocodedFromLocation ?? '').trim()
  if (!fields.location && !fields.city) return false
  if (!readStoredCoords(profile)) return true
  return geocodedFrom !== cacheKey
}
