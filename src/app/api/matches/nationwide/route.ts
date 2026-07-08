import { NextRequest, NextResponse } from 'next/server'
import { apiErrorResponse } from '@/lib/api-errors'
import { isNextResponse, requireRidgitsAuth } from '@/lib/ridgits-auth'
import { getTopNationwideMatches } from '@/lib/matching/nationwide'
import { isRidgitsBypassEmail } from '@/lib/ridgits-bypass'
import { requireVerifiedEmail } from '@/lib/trust-safety/email-verification'
import { applyWebCors, publicApiCorsHeaders, webCorsJson } from '@/lib/trust-safety/cors'

export const maxDuration = 300

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: publicApiCorsHeaders(request),
  })
}

export async function POST(request: NextRequest) {
  const auth = await requireRidgitsAuth(request)
  if (isNextResponse(auth)) return applyWebCors(auth, request)

  let body: { limit?: number; forceRefresh?: boolean } = {}
  try {
    body = await request.json()
  } catch {
    body = {}
  }

  try {
    if (!isRidgitsBypassEmail(auth.email)) {
      await requireVerifiedEmail(auth.uid)
    }
    const matches = await getTopNationwideMatches(
      auth.uid,
      typeof body.limit === 'number' ? body.limit : 50,
      body.forceRefresh === true,
    )
    return webCorsJson(request, { matches })
  } catch (error) {
    const { message, status } = apiErrorResponse(error)
    console.error('[matches/nationwide]', auth.uid, message)
    return webCorsJson(request, { error: message }, { status })
  }
}
