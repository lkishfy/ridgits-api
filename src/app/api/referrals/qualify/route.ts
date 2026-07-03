import { NextRequest, NextResponse } from 'next/server'
import { isNextResponse, requireRidgitsAuth } from '@/lib/ridgits-auth'
import { maybeGrantRidgitsReferralBonusForReferredUser } from '@/lib/ridgits-referrals'
import { apiErrorResponse } from '@/lib/api-errors'

/** Called after a referred user completes onboarding quiz to grant referrer bonus. */
export async function POST(request: NextRequest) {
  const auth = await requireRidgitsAuth(request)
  if (isNextResponse(auth)) return auth

  try {
    const result = await maybeGrantRidgitsReferralBonusForReferredUser(auth.uid)
    return NextResponse.json(result)
  } catch (error) {
    const { message, status, code } = apiErrorResponse(error)
    return NextResponse.json({ error: message, code }, { status })
  }
}
