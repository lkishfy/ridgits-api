import { NextRequest, NextResponse } from 'next/server'
import { apiErrorResponse } from '@/lib/api-errors'
import { isNextResponse, requireRidgitsAuth } from '@/lib/ridgits-auth'
import { findNearbyMatches } from '@/lib/matching/nearby'

export const maxDuration = 300

export async function POST(request: NextRequest) {
  const auth = await requireRidgitsAuth(request)
  if (isNextResponse(auth)) return auth

  let body: { maxDistance?: number; minCompatibility?: number } = {}
  try {
    body = await request.json()
  } catch {
    body = {}
  }

  try {
    const matches = await findNearbyMatches(
      auth.uid,
      typeof body.maxDistance === 'number' ? body.maxDistance : 50,
      typeof body.minCompatibility === 'number' ? body.minCompatibility : 5,
    )
    return NextResponse.json({ matches })
  } catch (error) {
    const { message, status } = apiErrorResponse(error)
    console.error('[matches/nearby]', auth.uid, message)
    return NextResponse.json({ error: message }, { status })
  }
}
