import { NextRequest, NextResponse } from 'next/server'
import { apiErrorResponse } from '@/lib/api-errors'
import { isNextResponse, requireRidgitsAuthAndAppCheck } from '@/lib/ridgits-auth'
import { startConversation } from '@/lib/messaging/handlers'
import { enforceRateLimit, getClientIp } from '@/lib/trust-safety/rate-limit'

export async function POST(request: NextRequest) {
  const auth = await requireRidgitsAuthAndAppCheck(request)
  if (isNextResponse(auth)) return auth

  let body: { toUserId?: string; message?: string } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.toUserId?.trim()) {
    return NextResponse.json({ error: 'toUserId is required' }, { status: 400 })
  }

  try {
    await enforceRateLimit({
      bucket: 'messaging-start-uid',
      identifier: auth.uid,
      limit: 20,
      windowSeconds: 60 * 60,
      message: 'Too many new conversations started. Please try again later.',
    })
    await enforceRateLimit({
      bucket: 'messaging-start-ip',
      identifier: getClientIp(request),
      limit: 40,
      windowSeconds: 60 * 60,
    })

    const result = await startConversation(auth.uid, body.toUserId.trim(), body.message ?? '')
    return NextResponse.json(result)
  } catch (error) {
    const { message, status, code, retryAfterSeconds } = apiErrorResponse(error)
    console.error('[messaging/start]', auth.uid, message)
    return NextResponse.json(
      { error: message, code },
      { status, headers: retryAfterSeconds ? { 'Retry-After': String(retryAfterSeconds) } : undefined },
    )
  }
}
