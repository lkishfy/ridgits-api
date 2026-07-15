import { NextRequest, NextResponse } from 'next/server'
import { apiErrorResponse } from '@/lib/api-errors'
import { isNextResponse, requireRidgitsAuthAndAppCheck } from '@/lib/ridgits-auth'
import { getIdentityStatus } from '@/lib/trust-safety/stripe-identity'

export async function GET(request: NextRequest) {
  const auth = await requireRidgitsAuthAndAppCheck(request)
  if (isNextResponse(auth)) return auth

  try {
    const status = await getIdentityStatus(auth.uid, auth.email)
    return NextResponse.json(status)
  } catch (error) {
    const { message, status, code } = apiErrorResponse(error)
    return NextResponse.json({ error: message, code }, { status })
  }
}
