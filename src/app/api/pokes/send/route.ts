import { NextRequest, NextResponse } from 'next/server'
import { apiErrorResponse } from '@/lib/api-errors'
import { isNextResponse, requireRidgitsAuth } from '@/lib/ridgits-auth'
import { sendPoke } from '@/lib/pokes/handlers'

export async function POST(request: NextRequest) {
  const auth = await requireRidgitsAuth(request)
  if (isNextResponse(auth)) return auth

  let body: { toUserId?: string } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.toUserId?.trim()) {
    return NextResponse.json({ error: 'toUserId is required' }, { status: 400 })
  }

  try {
    const result = await sendPoke(auth.uid, body.toUserId.trim())
    return NextResponse.json(result)
  } catch (error) {
    const { message, status } = apiErrorResponse(error)
    console.error('[pokes/send]', auth.uid, message)
    return NextResponse.json({ error: message }, { status })
  }
}
