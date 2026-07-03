import { NextRequest, NextResponse } from 'next/server'
import { apiErrorResponse } from '@/lib/api-errors'
import { isNextResponse, requireRidgitsAuth } from '@/lib/ridgits-auth'
import { sendMessage } from '@/lib/messaging/handlers'

export async function POST(request: NextRequest) {
  const auth = await requireRidgitsAuth(request)
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
    const result = await sendMessage(auth.uid, body.conversationId.trim(), body.message ?? '')
    return NextResponse.json(result)
  } catch (error) {
    const { message, status } = apiErrorResponse(error)
    console.error('[messaging/send]', auth.uid, message)
    return NextResponse.json({ error: message }, { status })
  }
}
