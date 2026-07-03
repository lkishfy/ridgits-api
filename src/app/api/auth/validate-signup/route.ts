import { NextRequest, NextResponse } from 'next/server'
import { isDisposableEmail, assertValidEmailFormat } from '@/lib/trust-safety/disposable-email'
import { isValidBirthYear, computeAge, MINIMUM_AGE_YEARS } from '@/lib/trust-safety/age'
import { enforceRateLimit, getClientIp } from '@/lib/trust-safety/rate-limit'
import { apiErrorResponse } from '@/lib/api-errors'

/**
 * Pre-signup gate the client calls *before* creating a Firebase Auth account (email/password
 * or OAuth), so disposable emails / underage birth years / signup abuse are rejected
 * server-side rather than relying solely on client-side validation that a modified app
 * binary could bypass. This is unauthenticated by design (the account doesn't exist yet),
 * so it's IP rate-limited aggressively.
 */
export async function POST(request: NextRequest) {
  let body: { email?: string; birthYear?: number } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const ip = getClientIp(request)

  try {
    await enforceRateLimit({
      bucket: 'validate-signup-ip',
      identifier: ip,
      limit: 20,
      windowSeconds: 60 * 60,
      message: 'Too many signup attempts from this network. Please try again later.',
    })

    const email = (body.email ?? '').trim()
    if (!assertValidEmailFormat(email)) {
      return NextResponse.json({ ok: false, error: 'Please enter a valid email address.', code: 'INVALID_EMAIL' })
    }

    if (isDisposableEmail(email)) {
      return NextResponse.json({
        ok: false,
        error: 'Please use a valid, permanent email address.',
        code: 'DISPOSABLE_EMAIL',
      })
    }

    if (body.birthYear !== undefined) {
      if (!isValidBirthYear(body.birthYear)) {
        return NextResponse.json({ ok: false, error: 'Please enter a valid birth year.', code: 'INVALID_BIRTH_YEAR' })
      }
      if (computeAge(body.birthYear) < MINIMUM_AGE_YEARS) {
        return NextResponse.json({
          ok: false,
          error: 'You must be at least 18 years old to use Ridgits.',
          code: 'UNDERAGE',
        })
      }
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    const { message, status, code, retryAfterSeconds } = apiErrorResponse(error)
    return NextResponse.json(
      { ok: false, error: message, code },
      { status, headers: retryAfterSeconds ? { 'Retry-After': String(retryAfterSeconds) } : undefined },
    )
  }
}
