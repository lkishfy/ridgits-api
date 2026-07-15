import { NextRequest, NextResponse } from 'next/server'
import { apiErrorResponse } from '@/lib/api-errors'
import { isNextResponse, requireRidgitsAuthAndAppCheck } from '@/lib/ridgits-auth'
import { redeemRidgitsReferralCode } from '@/lib/ridgits-referrals'
import { enforceRateLimit } from '@/lib/trust-safety/rate-limit'
import { referralRedeemBodySchema } from '@/lib/schemas/ridgits-bodies'
import { parseJsonBody } from '@/lib/schemas/parse-body'

export async function POST(request: NextRequest) {
  const auth = await requireRidgitsAuthAndAppCheck(request)
  if (isNextResponse(auth)) return auth

  let rawBody: unknown
  try {
    rawBody = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const body = parseJsonBody(referralRedeemBodySchema, rawBody)
  if (body instanceof NextResponse) return body

  try {
    await enforceRateLimit({
      bucket: 'referrals-redeem',
      identifier: auth.uid,
      limit: 10,
      windowSeconds: 60 * 60,
      message: 'Too many referral redemption attempts. Please try again later.',
    })

    const result = await redeemRidgitsReferralCode({
      referredUid: auth.uid,
      referredEmail: auth.email,
      referralCode: body.referralCode,
      source: body.source,
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
