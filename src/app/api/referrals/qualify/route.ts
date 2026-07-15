import { NextRequest, NextResponse } from 'next/server'
import { isNextResponse, requireRidgitsAuthAndAppCheck } from '@/lib/ridgits-auth'
import { maybeGrantRidgitsReferralBonusForReferredUser } from '@/lib/ridgits-referrals'
import { apiErrorResponse } from '@/lib/api-errors'
import { enforceRateLimit } from '@/lib/trust-safety/rate-limit'

/** Called after a referred user completes onboarding quiz to grant both referral bonuses. */
export async function POST(request: NextRequest) {
  const auth = await requireRidgitsAuthAndAppCheck(request)
  if (isNextResponse(auth)) return auth

  try {
    await enforceRateLimit({
      bucket: 'referrals-qualify',
      identifier: auth.uid,
      limit: 30,
      windowSeconds: 60 * 60,
    })

    const result = await maybeGrantRidgitsReferralBonusForReferredUser(auth.uid)
    return NextResponse.json(result)
  } catch (error) {
    const { message, status, code } = apiErrorResponse(error)
    return NextResponse.json({ error: message, code }, { status })
  }
}
