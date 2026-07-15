import { NextRequest, NextResponse } from 'next/server'
import { apiErrorResponse } from '@/lib/api-errors'
import { isNextResponse, requireRidgitsAuthAndAppCheck } from '@/lib/ridgits-auth'
import { unarchiveConversation } from '@/lib/messaging/handlers'

export async function POST(request: NextRequest) {
  const auth = await requireRidgitsAuthAndAppCheck(request)
  if (isNextResponse(auth)) return auth

  let body: { conversationId?: string } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.conversationId?.trim()) {
    return NextResponse.json({ error: 'conversationId is required' }, { status: 400 })
  }

  try {
    const result = await unarchiveConversation(auth.uid, body.conversationId.trim())
    return NextResponse.json(result)
  } catch (error) {
    const { message, status, code, retryAfterSeconds } = apiErrorResponse(error)
    console.error('[messaging/unarchive]', auth.uid, message)
    return NextResponse.json(
      { error: message, code },
      { status, headers: retryAfterSeconds ? { 'Retry-After': String(retryAfterSeconds) } : undefined },
    )
  }
}
