import { NextRequest, NextResponse } from 'next/server'
import { apiErrorResponse } from '@/lib/api-errors'
import { isNextResponse, requireRidgitsAuth } from '@/lib/ridgits-auth'
import { unpoke } from '@/lib/pokes/handlers'

export async function POST(request: NextRequest) {
  const auth = await requireRidgitsAuth(request)
  if (isNextResponse(auth)) return auth

  let body: { pokeId?: string } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.pokeId?.trim()) {
    return NextResponse.json({ error: 'pokeId is required' }, { status: 400 })
  }

  try {
    const result = await unpoke(auth.uid, body.pokeId.trim())
    return NextResponse.json(result)
  } catch (error) {
    const { message, status } = apiErrorResponse(error)
    return NextResponse.json({ error: message }, { status })
  }
}
