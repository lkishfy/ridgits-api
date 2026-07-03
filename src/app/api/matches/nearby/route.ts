import { NextRequest, NextResponse } from 'next/server'
import { apiErrorResponse } from '@/lib/api-errors'
import { isNextResponse, requireRidgitsAuth } from '@/lib/ridgits-auth'
import { findNearbyMatches } from '@/lib/matching/nearby'
import { getNearbyAccess } from '@/lib/ridgits-subscription'
import {
  CLOSE_MATCHES_THRESHOLD_MILES,
  MAX_NEARBY_RADIUS_MILES,
  UNSUBSCRIBED_MIN_RADIUS_MILES,
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
      const maxDistance = Math.min(Math.max(requested, 5), MAX_NEARBY_RADIUS_MILES)
      const matches = await findNearbyMatches(auth.uid, maxDistance, minCompatibility)
      return NextResponse.json({ matches })
    }

    if (body.previewCloseMatches) {
      const previewMatches = await findNearbyMatches(
        auth.uid,
        CLOSE_MATCHES_THRESHOLD_MILES,
        minCompatibility,
      )
      const closeMatches = previewMatches.filter((match) => {
        const miles = readDistanceMiles(match as Record<string, unknown>)
        return miles > 0 && miles < CLOSE_MATCHES_THRESHOLD_MILES
      })
      return NextResponse.json({
        matches: closeMatches,
        closeMatchCount: closeMatches.length,
      })
    }

    const maxDistance = Math.min(
      Math.max(requested, UNSUBSCRIBED_MIN_RADIUS_MILES),
      MAX_NEARBY_RADIUS_MILES,
    )
    const allMatches = await findNearbyMatches(auth.uid, maxDistance, minCompatibility)
    const matches = allMatches.filter((match) => {
      const miles = readDistanceMiles(match as Record<string, unknown>)
      return miles === 0 || miles >= CLOSE_MATCHES_THRESHOLD_MILES
    })

    const closePreview = await findNearbyMatches(
      auth.uid,
      CLOSE_MATCHES_THRESHOLD_MILES,
      minCompatibility,
    )
    const closeMatchCount = closePreview.filter((match) => {
      const miles = readDistanceMiles(match as Record<string, unknown>)
      return miles > 0 && miles < CLOSE_MATCHES_THRESHOLD_MILES
    }).length

    return NextResponse.json({ matches, closeMatchCount })
  } catch (error) {
    const { message, status } = apiErrorResponse(error)
    console.error('[matches/nearby]', auth.uid, message)
    return NextResponse.json({ error: message }, { status })
  }
}
