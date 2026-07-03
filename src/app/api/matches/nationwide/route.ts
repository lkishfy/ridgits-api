import { NextRequest, NextResponse } from 'next/server'
import { apiErrorResponse } from '@/lib/api-errors'
import { isNextResponse, requireRidgitsAuth } from '@/lib/ridgits-auth'
import { getTopNationwideMatches } from '@/lib/matching/nationwide'

export const maxDuration = 300

export async function POST(request: NextRequest) {
  const auth = await requireRidgitsAuth(request)
  if (isNextResponse(auth)) return auth

  let body: { limit?: number } = {}
  try {
    body = await request.json()
  } catch {
    body = {}
  }

  try {
    const matches = await getTopNationwideMatches(
      auth.uid,
      typeof body.limit === 'number' ? body.limit : 10,
    )
    return NextResponse.json({ matches })
  } catch (error) {
    const { message, status } = apiErrorResponse(error)
    console.error('[matches/nationwide]', auth.uid, message)
    return NextResponse.json({ error: message }, { status })
  }
}
