import { NextRequest, NextResponse } from 'next/server'
import { isNextResponse, requireRidgitsAuth } from '@/lib/ridgits-auth'
import { getRidgitsReferralProfile } from '@/lib/ridgits-referrals'
import { apiErrorResponse } from '@/lib/api-errors'

export async function GET(request: NextRequest) {
  const auth = await requireRidgitsAuth(request)
  if (isNextResponse(auth)) return auth

  try {
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
