import { NextRequest, NextResponse } from 'next/server'
import { isDisposableEmail, assertValidEmailFormat } from '@/lib/trust-safety/disposable-email'
import { isValidBirthYear, computeAge, MINIMUM_AGE_YEARS, minimumAgeErrorMessage } from '@/lib/trust-safety/age'
import { enforceRateLimit, getClientIp } from '@/lib/trust-safety/rate-limit'
import { publicApiCorsHeaders } from '@/lib/trust-safety/cors'
import { apiErrorResponse } from '@/lib/api-errors'

/**
 * Pre-signup gate the client calls *before* creating a Firebase Auth account (email/password
 * or OAuth) and also after OAuth sign-in to confirm a birth year, so disposable emails /
 * underage birth years / signup abuse are rejected server-side rather than relying solely
 * on client-side validation that a modified app binary could bypass. `email` and
 * `birthYear` are each optional (only what's supplied is checked), so the same endpoint
 * covers "pre-account-creation email check" and "post-OAuth birth-year confirmation".
 * This is unauthenticated by design (the account may not exist yet), so it's IP
 * rate-limited aggressively.
 */
export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: publicApiCorsHeaders(request),
  })
}

export async function POST(request: NextRequest) {
  const cors = publicApiCorsHeaders(request)

  let body: { email?: string; birthYear?: number } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors })
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

    if (body.email !== undefined) {
      const email = body.email.trim()
      if (!assertValidEmailFormat(email)) {
        return NextResponse.json(
          { ok: false, error: 'Please enter a valid email address.', code: 'INVALID_EMAIL' },
          { headers: cors },
        )
      }

      if (isDisposableEmail(email)) {
        return NextResponse.json(
          {
            ok: false,
            error: 'Please use a valid, permanent email address.',
            code: 'DISPOSABLE_EMAIL',
          },
          { headers: cors },
        )
      }
    }

    if (body.birthYear !== undefined) {
      if (!isValidBirthYear(body.birthYear)) {
        return NextResponse.json(
          { ok: false, error: 'Please enter a valid birth year.', code: 'INVALID_BIRTH_YEAR' },
          { headers: cors },
        )
      }
      if (computeAge(body.birthYear) < MINIMUM_AGE_YEARS) {
        return NextResponse.json(
          {
            ok: false,
            error: minimumAgeErrorMessage(),
            code: 'UNDERAGE',
          },
          { headers: cors },
        )
      }
    }

    return NextResponse.json({ ok: true }, { headers: cors })
  } catch (error) {
    const { message, status, code, retryAfterSeconds } = apiErrorResponse(error)
    return NextResponse.json(
      { ok: false, error: message, code },
      {
        status,
        headers: {
          ...cors,
          ...(retryAfterSeconds ? { 'Retry-After': String(retryAfterSeconds) } : {}),
        },
      },
    )
  }
}
