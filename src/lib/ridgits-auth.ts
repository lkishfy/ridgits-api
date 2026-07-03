import { NextRequest, NextResponse } from 'next/server'
import { verifyIdToken } from '@/lib/firebase-admin'

export interface RidgitsAuthContext {
  uid: string
  email: string | null
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
    }
  } catch {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
  }
}

export function isNextResponse(value: unknown): value is NextResponse {
  return value instanceof NextResponse
}
