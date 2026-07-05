import { NextRequest, NextResponse } from 'next/server'
import { apiErrorResponse } from '@/lib/api-errors'
import { isNextResponse, requireRidgitsAuth } from '@/lib/ridgits-auth'
import { getDb } from '@/lib/firebase-admin'
import { registerProfilePhotoForUser } from '@/lib/trust-safety/profile-photo'
import { matchProfilePhotoToIdentity } from '@/lib/trust-safety/profile-identity-match'

export async function POST(request: NextRequest) {
  const auth = await requireRidgitsAuth(request)
  if (isNextResponse(auth)) return auth

  try {
    const body = (await request.json()) as { imageUrl?: string }
    const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl.trim() : ''
    if (!imageUrl) {
      return NextResponse.json({ error: 'imageUrl is required' }, { status: 400 })
    }

    await registerProfilePhotoForUser(auth.uid, imageUrl)

    const userSnap = await getDb().collection('users').doc(auth.uid).get()
    if (String(userSnap.get('identityVerificationStatus') ?? '') === 'verified') {
      try {
        await matchProfilePhotoToIdentity(auth.uid)
      } catch (error) {
        console.error('[profile/register-photo] identity face match failed', auth.uid, error)
      }
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    const { message, status, code } = apiErrorResponse(error)
    return NextResponse.json({ error: message, code }, { status })
  }
}
