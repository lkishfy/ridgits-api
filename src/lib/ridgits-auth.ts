import { NextRequest, NextResponse } from 'next/server'
import { ApiError } from '@/lib/api-errors'
import { verifyIdToken } from '@/lib/firebase-admin'
import { isAppCheckRequired, verifyAppCheckToken } from '@/lib/ridgits-app-check'

export interface RidgitsAuthContext {
  uid: string
  email: string | null
  /**
   * From the verified Firebase ID token's `email_verified` claim — authoritative because
   * the token is Admin-SDK-verified server-side, not a client-supplied Firestore field.
   * OAuth providers (Google/Apple) set this to true automatically.
   */
  emailVerified: boolean
}

export async function requireRidgitsAuth(
  request: NextRequest,
): Promise<RidgitsAuthContext | NextResponse> {
  const authHeader = request.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Missing Authorization header' }, { status: 401 })
  }

  const token = authHeader.slice(7).trim()
  if (!token) {
    return NextResponse.json({ error: 'Empty token' }, { status: 401 })
  }

  try {
    const decoded = await verifyIdToken(token)
    return {
      uid: decoded.uid,
      email: typeof decoded.email === 'string' ? decoded.email : null,
      emailVerified: decoded.email_verified === true,
    }
  } catch {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
  }
}

export function isNextResponse(value: unknown): value is NextResponse {
  return value instanceof NextResponse
}

export async function requireRidgitsAuthAndAppCheck(
  request: NextRequest,
): Promise<RidgitsAuthContext | NextResponse> {
  if (isAppCheckRequired()) {
    const appCheckToken = request.headers.get('X-Firebase-AppCheck')
    if (!appCheckToken?.trim()) {
      return NextResponse.json({ error: 'Missing App Check token', code: 'APP_CHECK_REQUIRED' }, { status: 401 })
    }
    try {
      await verifyAppCheckToken(appCheckToken)
    } catch (error) {
      if (error instanceof ApiError) {
        return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
      }
      return NextResponse.json({ error: 'Invalid App Check token', code: 'APP_CHECK_INVALID' }, { status: 401 })
    }
  }

  return requireRidgitsAuth(request)
}
