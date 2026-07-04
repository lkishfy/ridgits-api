import { NextRequest, NextResponse } from 'next/server'
import { apiErrorResponse } from '@/lib/api-errors'
import { isNextResponse, requireRidgitsAuth } from '@/lib/ridgits-auth'
import { getPokeCredits } from '@/lib/pokes/handlers'

export async function GET(request: NextRequest) {
  const auth = await requireRidgitsAuth(request)
  if (isNextResponse(auth)) return auth

  try {
    const credits = await getPokeCredits(auth.uid)
    return NextResponse.json({ credits })
  } catch (error) {
    const { message, status, code } = apiErrorResponse(error)
    console.error('[pokes/quota]', auth.uid, message)
    return NextResponse.json({ error: message, code }, { status })
  }
}
