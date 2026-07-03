import { NextRequest, NextResponse } from 'next/server'
import { apiErrorResponse } from '@/lib/api-errors'
import { isNextResponse, requireRidgitsAuth } from '@/lib/ridgits-auth'
import { getMonthlyMessageQuota } from '@/lib/messaging/handlers'
import { getDb } from '@/lib/firebase-admin'

export async function GET(request: NextRequest) {
  const auth = await requireRidgitsAuth(request)
  if (isNextResponse(auth)) return auth

  try {
    const userSnap = await getDb().collection('users').doc(auth.uid).get()
    const userData = userSnap.data() ?? {}
    const quota = await getMonthlyMessageQuota(auth.uid, userData)
    return NextResponse.json({ quota })
  } catch (error) {
    const { message, status, code } = apiErrorResponse(error)
    return NextResponse.json({ error: message, code }, { status })
  }
}
