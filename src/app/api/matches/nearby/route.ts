import { NextRequest, NextResponse } from 'next/server'
import { apiErrorResponse } from '@/lib/api-errors'
import { isNextResponse, requireRidgitsAuth } from '@/lib/ridgits-auth'
import { findNearbyMatches } from '@/lib/matching/nearby'
import { getNearbyAccess } from '@/lib/ridgits-subscription'
import {
  CLOSE_MATCHES_THRESHOLD_MILES,
  MAX_NEARBY_RADIUS_MILES,
  UNSUBSCRIBED_MIN_RADIUS_MILES,
  nearbyCloseMatchFloorMiles,
  nearbySearchMinRadiusMiles,
} from '@/lib/ridgits-products'

export const maxDuration = 300

function readDistanceMiles(match: Record<string, unknown>): number {
  if (typeof match.distance === 'number') return match.distance
  if (typeof match.distanceMiles === 'number') return match.distanceMiles
  return 0
}

export async function POST(request: NextRequest) {
  const auth = await requireRidgitsAuth(request)
  if (isNextResponse(auth)) return auth

  let body: {
    maxDistance?: number
    minCompatibility?: number
    previewCloseMatches?: boolean
  } = {}
  try {
    body = await request.json()
  } catch {
    body = {}
  }

  const minCompatibility =
    typeof body.minCompatibility === 'number' ? body.minCompatibility : 5

  try {
    const access = await getNearbyAccess(auth.uid, auth.email)
    const requested =
      typeof body.maxDistance === 'number'
        ? body.maxDistance
        : UNSUBSCRIBED_MIN_RADIUS_MILES

    if (access.hasNearbyAccess) {
      const tier = access.subscriptionTier ?? 'free'
      const minRadius = nearbySearchMinRadiusMiles(tier)
      const floor = nearbyCloseMatchFloorMiles(tier, true)
      const maxDistance = Math.min(Math.max(requested, minRadius), MAX_NEARBY_RADIUS_MILES)
      const { matches } = await findNearbyMatches(auth.uid, maxDistance, minCompatibility)
      const filtered =
        floor > 0
          ? matches.filter((match) => {
              const miles = readDistanceMiles(match as Record<string, unknown>)
              return miles === 0 || miles >= floor
            })
          : matches
      return NextResponse.json({ matches: filtered })
    }

    if (body.previewCloseMatches) {
      const { closeMatchCount } = await findNearbyMatches(
        auth.uid,
        CLOSE_MATCHES_THRESHOLD_MILES,
        minCompatibility,
        { closeCountOnly: true },
      )
      return NextResponse.json({ matches: [], closeMatchCount })
    }

    const maxDistance = Math.min(
      Math.max(requested, UNSUBSCRIBED_MIN_RADIUS_MILES),
      MAX_NEARBY_RADIUS_MILES,
    )
    const { matches: allMatches, closeMatchCount } = await findNearbyMatches(
      auth.uid,
      maxDistance,
      minCompatibility,
      { includeCloseCount: true },
    )
    const matches = allMatches.filter((match) => {
      const miles = readDistanceMiles(match as Record<string, unknown>)
      return miles === 0 || miles >= CLOSE_MATCHES_THRESHOLD_MILES
    })

    return NextResponse.json({ matches, closeMatchCount })
  } catch (error) {
    const { message, status } = apiErrorResponse(error)
    console.error('[matches/nearby]', auth.uid, message)
    return NextResponse.json({ error: message }, { status })
  }
}
