import { NextRequest, NextResponse } from 'next/server'
import { apiErrorResponse } from '@/lib/api-errors'
import { isNextResponse, requireRidgitsAuthAndAppCheck } from '@/lib/ridgits-auth'
import { getDb } from '@/lib/firebase-admin'
import { registerProfilePhotoForUser } from '@/lib/trust-safety/profile-photo'
import { registerPhotoBodySchema } from '@/lib/schemas/ridgits-bodies'
import { parseJsonBody } from '@/lib/schemas/parse-body'
import {
  approveProfilePhotoWithoutFaceMatch,
  matchProfilePhotoToIdentity,
  requiresProfilePhotoFaceMatch,
} from '@/lib/trust-safety/profile-identity-match'

export async function POST(request: NextRequest) {
  const auth = await requireRidgitsAuthAndAppCheck(request)
  if (isNextResponse(auth)) return auth

  try {
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    const body = parseJsonBody(registerPhotoBodySchema, rawBody)
    if (body instanceof NextResponse) return body

    const registered = await registerProfilePhotoForUser(auth.uid, body.imageUrl)

    const userSnap = await getDb().collection('users').doc(auth.uid).get()
    const userData = userSnap.data() ?? {}
    if (String(userData.identityVerificationStatus ?? '') === 'verified') {
      const needsFaceMatch = requiresProfilePhotoFaceMatch(userData)
      const matchStatus = String(userData.profilePhotoIdentityMatchStatus ?? '')
      const needsInitialMatch = matchStatus !== 'verified' && matchStatus !== 'pending'

      if (!registered.photoChanged && !needsInitialMatch) {
        return NextResponse.json({ ok: true })
      }

      try {
        const identityMatch = needsFaceMatch
          ? await matchProfilePhotoToIdentity(auth.uid, auth.email)
          : await approveProfilePhotoWithoutFaceMatch(auth.uid)
        return NextResponse.json({ ok: true, identityMatch })
      } catch (error) {
        const { message, code } = apiErrorResponse(error)
        console.error('[profile/register-photo] identity face match failed', auth.uid, error)
        return NextResponse.json({
          ok: true,
          identityMatchError: { error: message, code },
        })
      }
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    const { message, status, code } = apiErrorResponse(error)
    return NextResponse.json({ error: message, code }, { status })
  }
}
