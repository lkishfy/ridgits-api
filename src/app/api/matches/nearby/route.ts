import { NextRequest, NextResponse } from 'next/server'
import { apiErrorResponse } from '@/lib/api-errors'
import { isNextResponse, requireRidgitsAuth } from '@/lib/ridgits-auth'
import { findNearbyMatches } from '@/lib/matching/nearby'
import { getNearbyAccess } from '@/lib/ridgits-subscription'
import { repairStaleMembershipTier } from '@/lib/subscription-badge'
import {
  CLOSE_MATCHES_THRESHOLD_MILES,
  MAX_NEARBY_RADIUS_MILES,
  UNSUBSCRIBED_MIN_RADIUS_MILES,
  canAccessMetroSearch,
  isMetroRadiusPreset,
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
    await repairStaleMembershipTier(auth.uid)
    const access = await getNearbyAccess(auth.uid, auth.email)
    const requested =
      typeof body.maxDistance === 'number'
        ? body.maxDistance
        : 50

    if (access.hasNearbyAccess) {
      const tier = access.subscriptionTier ?? 'free'
      const minRadius = nearbySearchMinRadiusMiles(tier)
      const floor = nearbyCloseMatchFloorMiles(tier, true)
      const metroSearch = isMetroRadiusPreset(requested)
      if (metroSearch && !canAccessMetroSearch(tier, true)) {
        return NextResponse.json(
          { error: 'Metro area search requires Ridgits Premium or Ultra.' },
          { status: 403 },
        )
      }
      const maxDistance = metroSearch
        ? 0
        : Math.min(Math.max(requested, minRadius), MAX_NEARBY_RADIUS_MILES)
      const includeCloseInResults = floor === 0
      const { matches, closeMatchCount, closeMatches } = await findNearbyMatches(
        auth.uid,
        maxDistance,
        minCompatibility,
        {
          includeCloseCount: floor > 0,
          includeCloseMatchesInResults: includeCloseInResults,
          closeMatchMetroOnly: tier === 'plus',
        },
      )
      const filtered =
        floor > 0
          ? matches.filter((match) => {
              const miles = readDistanceMiles(match as Record<string, unknown>)
              return miles >= floor
            })
          : matches
      return NextResponse.json({ matches: filtered, closeMatchCount, closeMatches })
    }

    if (body.previewCloseMatches) {
      const previewRadius =
        typeof body.maxDistance === 'number'
          ? Math.min(Math.max(body.maxDistance, 0), MAX_NEARBY_RADIUS_MILES)
          : CLOSE_MATCHES_THRESHOLD_MILES
      const { closeMatchCount, closeMatches } = await findNearbyMatches(
        auth.uid,
        previewRadius,
        minCompatibility,
        { closeCountOnly: true },
      )
      return NextResponse.json({ matches: [], closeMatchCount, closeMatches })
    }

    const maxDistance = Math.min(
      Math.max(requested, UNSUBSCRIBED_MIN_RADIUS_MILES),
      MAX_NEARBY_RADIUS_MILES,
    )
    const { matches: allMatches, closeMatchCount, closeMatches } = await findNearbyMatches(
      auth.uid,
      maxDistance,
      minCompatibility,
      { includeCloseCount: true },
    )
    const matches = allMatches.filter((match) => {
      const miles = readDistanceMiles(match as Record<string, unknown>)
      return miles >= CLOSE_MATCHES_THRESHOLD_MILES
    })

    return NextResponse.json({ matches, closeMatchCount, closeMatches })
  } catch (error) {
    const { message, status } = apiErrorResponse(error)
    console.error('[matches/nearby]', auth.uid, message)
    return NextResponse.json({ error: message }, { status })
  }
}
