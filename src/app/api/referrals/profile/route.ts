import { NextRequest, NextResponse } from 'next/server'
import { isNextResponse, requireRidgitsAuthAndAppCheck } from '@/lib/ridgits-auth'
import { getRidgitsReferralProfile } from '@/lib/ridgits-referrals'
import { apiErrorResponse } from '@/lib/api-errors'
import { enforceRateLimit } from '@/lib/trust-safety/rate-limit'

export async function GET(request: NextRequest) {
  const auth = await requireRidgitsAuthAndAppCheck(request)
  if (isNextResponse(auth)) return auth

  try {
    await enforceRateLimit({
      bucket: 'referrals-profile',
      identifier: auth.uid,
      limit: 30,
      windowSeconds: 60 * 60,
    })

    const profile = await getRidgitsReferralProfile({
      uid: auth.uid,
      email: auth.email,
    })
    return NextResponse.json({ referral: profile })
  } catch (error) {
    const { message, status, code } = apiErrorResponse(error)
    return NextResponse.json({ error: message, code }, { status })
  }
}
