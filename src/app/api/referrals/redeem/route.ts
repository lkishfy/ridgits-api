import { NextRequest, NextResponse } from 'next/server'
import { isNextResponse, requireRidgitsAuth } from '@/lib/ridgits-auth'
import { redeemRidgitsReferralCode } from '@/lib/ridgits-referrals'
import { apiErrorResponse } from '@/lib/api-errors'

export async function POST(request: NextRequest) {
  const auth = await requireRidgitsAuth(request)
  if (isNextResponse(auth)) return auth

  let body: { referralCode?: string } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const referralCode = body.referralCode?.trim()
  if (!referralCode) {
    return NextResponse.json({ error: 'Referral code is required', code: 'invalid_referral_code' }, { status: 400 })
  }

  try {
    const result = await redeemRidgitsReferralCode({
      referredUid: auth.uid,
      referredEmail: auth.email,
      referralCode,
    })
    return NextResponse.json(result)
  } catch (error) {
    const { message, status, code, retryAfterSeconds } = apiErrorResponse(error)
    return NextResponse.json(
      { error: message, code },
      { status, headers: retryAfterSeconds ? { 'Retry-After': String(retryAfterSeconds) } : undefined },
    )
  }
}
