import { NextRequest, NextResponse } from 'next/server'
import { apiErrorResponse } from '@/lib/api-errors'
import { isNextResponse, requireRidgitsAuth } from '@/lib/ridgits-auth'
import { createIdentityVerificationSession } from '@/lib/trust-safety/stripe-identity'

export async function POST(request: NextRequest) {
  const auth = await requireRidgitsAuth(request)
  if (isNextResponse(auth)) return auth

  try {
    let body: { phone?: string } = {}
    try {
      body = await request.json()
    } catch {
      body = {}
    }

    const session = await createIdentityVerificationSession(auth.uid, {
      phone: typeof body.phone === 'string' ? body.phone : undefined,
    })
    return NextResponse.json({
      verificationUrl: session.url,
      sessionId: session.sessionId,
    })
  } catch (error) {
    const { message, status, code } = apiErrorResponse(error)
    return NextResponse.json({ error: message, code }, { status })
  }
}
