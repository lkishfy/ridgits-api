import { NextRequest, NextResponse } from 'next/server'
import { apiErrorResponse } from '@/lib/api-errors'
import { isNextResponse, requireRidgitsAuth } from '@/lib/ridgits-auth'
import { flagConversation } from '@/lib/messaging/handlers'
import { enforceRateLimit, getClientIp } from '@/lib/trust-safety/rate-limit'

export async function POST(request: NextRequest) {
  const auth = await requireRidgitsAuth(request)
  if (isNextResponse(auth)) return auth

  let body: { conversationId?: string; reason?: string } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.conversationId?.trim()) {
    return NextResponse.json({ error: 'conversationId is required' }, { status: 400 })
  }
  if (!body.reason?.trim()) {
    return NextResponse.json({ error: 'reason is required' }, { status: 400 })
  }

  try {
    await enforceRateLimit({
      bucket: 'messaging-flag-uid',
      identifier: auth.uid,
      limit: 20,
      windowSeconds: 60 * 60,
      message: 'You are submitting reports too quickly. Please try again later.',
    })
    await enforceRateLimit({
      bucket: 'messaging-flag-ip',
      identifier: getClientIp(request),
      limit: 40,
      windowSeconds: 60 * 60,
    })

    const result = await flagConversation(auth.uid, body.conversationId.trim(), body.reason.trim())
    return NextResponse.json(result)
  } catch (error) {
    const { message, status, code, retryAfterSeconds } = apiErrorResponse(error)
    console.error('[messaging/flag]', auth.uid, message)
    return NextResponse.json(
      { error: message, code },
      { status, headers: retryAfterSeconds ? { 'Retry-After': String(retryAfterSeconds) } : undefined },
    )
  }
}
