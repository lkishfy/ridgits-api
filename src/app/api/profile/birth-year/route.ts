import { NextRequest, NextResponse } from 'next/server'
import { FieldValue } from 'firebase-admin/firestore'
import { apiErrorResponse } from '@/lib/api-errors'
import { isNextResponse, requireRidgitsAuth } from '@/lib/ridgits-auth'
import { getDb } from '@/lib/firebase-admin'
import { computeAge, isValidBirthYear, MINIMUM_AGE_YEARS, minimumAgeErrorMessage } from '@/lib/trust-safety/age'

export async function POST(request: NextRequest) {
  const auth = await requireRidgitsAuth(request)
  if (isNextResponse(auth)) return auth

  let body: { birthYear?: number } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const birthYear = body.birthYear
  if (!isValidBirthYear(birthYear)) {
    return NextResponse.json({ error: 'Please enter a valid birth year.', code: 'INVALID_BIRTH_YEAR' }, { status: 400 })
  }
  if (computeAge(birthYear!) < MINIMUM_AGE_YEARS) {
    return NextResponse.json({ error: minimumAgeErrorMessage(), code: 'UNDERAGE' }, { status: 400 })
  }

  try {
    const age = computeAge(birthYear!)
    await getDb()
      .collection('users')
      .doc(auth.uid)
      .set(
        {
          birthYear,
          age,
          ageVerificationConfirmed: true,
          ageVerifiedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      )
    return NextResponse.json({ ok: true })
  } catch (error) {
    const { message, status, code } = apiErrorResponse(error)
    return NextResponse.json({ error: message, code }, { status })
  }
}
