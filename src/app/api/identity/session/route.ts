import { NextRequest, NextResponse } from 'next/server'
import { apiErrorResponse } from '@/lib/api-errors'
import { isNextResponse, requireRidgitsAuthAndAppCheck } from '@/lib/ridgits-auth'
import { createIdentityVerificationSession } from '@/lib/trust-safety/stripe-identity'
import { identitySessionBodySchema } from '@/lib/schemas/ridgits-bodies'
import { parseJsonBody } from '@/lib/schemas/parse-body'

export async function POST(request: NextRequest) {
  const auth = await requireRidgitsAuthAndAppCheck(request)
  if (isNextResponse(auth)) return auth

  try {
    let rawBody: unknown = {}
    try {
      rawBody = await request.json()
    } catch {
      rawBody = {}
    }

    const body = parseJsonBody(identitySessionBodySchema, rawBody)
    if (body instanceof NextResponse) return body

    const session = await createIdentityVerificationSession(auth.uid, {
      phone: body.phone,
    }, auth.email)
    return NextResponse.json({
      verificationUrl: session.url,
      sessionId: session.sessionId,
    })
  } catch (error) {
    const { message, status, code } = apiErrorResponse(error)
    return NextResponse.json({ error: message, code }, { status })
  }
}
