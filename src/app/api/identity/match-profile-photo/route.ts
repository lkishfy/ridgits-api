import { NextRequest, NextResponse } from 'next/server'
import { apiErrorResponse } from '@/lib/api-errors'
import { isNextResponse, requireRidgitsAuth } from '@/lib/ridgits-auth'
import { matchProfilePhotoToIdentity } from '@/lib/trust-safety/profile-identity-match'

export async function POST(request: NextRequest) {
  const auth = await requireRidgitsAuth(request)
  if (isNextResponse(auth)) return auth

  try {
    const result = await matchProfilePhotoToIdentity(auth.uid)
    return NextResponse.json(result)
  } catch (error) {
    const { message, status, code } = apiErrorResponse(error)
    return NextResponse.json({ error: message, code }, { status })
  }
}
