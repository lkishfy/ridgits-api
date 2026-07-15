import { NextRequest, NextResponse } from 'next/server'
import { apiErrorResponse } from '@/lib/api-errors'
import { isNextResponse, requireRidgitsAuthAndAppCheck } from '@/lib/ridgits-auth'
import { sendPoke } from '@/lib/pokes/handlers'
import { enforceRateLimit, getClientIp } from '@/lib/trust-safety/rate-limit'
import { pokeSendBodySchema } from '@/lib/schemas/ridgits-bodies'
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

  const body = parseJsonBody(pokeSendBodySchema, rawBody)
  if (body instanceof NextResponse) return body

  try {
    await enforceRateLimit({
      bucket: 'pokes-send-uid',
      identifier: auth.uid,
      limit: 60,
      windowSeconds: 60 * 60,
      message: 'You are sending pokes too quickly. Please try again later.',
    })
    await enforceRateLimit({
      bucket: 'pokes-send-ip',
      identifier: getClientIp(request),
      limit: 120,
      windowSeconds: 60 * 60,
    })

    const result = await sendPoke(auth.uid, body.toUserId)
    return NextResponse.json(result)
  } catch (error) {
    const { message, status, code, retryAfterSeconds } = apiErrorResponse(error)
    console.error('[pokes/send]', auth.uid, message)
    return NextResponse.json(
      { error: message, code },
      { status, headers: retryAfterSeconds ? { 'Retry-After': String(retryAfterSeconds) } : undefined },
    )
  }
}
