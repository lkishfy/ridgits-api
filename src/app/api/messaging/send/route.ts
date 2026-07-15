import { NextRequest, NextResponse } from 'next/server'
import { apiErrorResponse } from '@/lib/api-errors'
import { isNextResponse, requireRidgitsAuthAndAppCheck } from '@/lib/ridgits-auth'
import { sendMessage } from '@/lib/messaging/handlers'
import { enforceRateLimit, getClientIp } from '@/lib/trust-safety/rate-limit'

export async function POST(request: NextRequest) {
  const auth = await requireRidgitsAuthAndAppCheck(request)
  if (isNextResponse(auth)) return auth

  let body: { conversationId?: string; message?: string } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.conversationId?.trim()) {
    return NextResponse.json({ error: 'conversationId is required' }, { status: 400 })
  }

  try {
    await enforceRateLimit({
      bucket: 'messaging-send-uid',
      identifier: auth.uid,
      limit: 120,
      windowSeconds: 60 * 60,
      message: 'You are sending messages too quickly. Please slow down.',
    })
    await enforceRateLimit({
      bucket: 'messaging-send-ip',
      identifier: getClientIp(request),
      limit: 240,
      windowSeconds: 60 * 60,
    })

    const result = await sendMessage(auth.uid, body.conversationId.trim(), body.message ?? '')
    return NextResponse.json(result)
  } catch (error) {
    const { message, status, code, retryAfterSeconds } = apiErrorResponse(error)
    console.error('[messaging/send]', auth.uid, message)
    return NextResponse.json(
      { error: message, code },
      { status, headers: retryAfterSeconds ? { 'Retry-After': String(retryAfterSeconds) } : undefined },
    )
  }
}
