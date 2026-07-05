import { NextRequest, NextResponse } from 'next/server'
import { apiErrorResponse } from '@/lib/api-errors'
import { isNextResponse, requireRidgitsAuth } from '@/lib/ridgits-auth'
import { syncRenewalPreference } from '@/lib/ridgits-iap'

export async function POST(request: NextRequest) {
  const auth = await requireRidgitsAuth(request)
  if (isNextResponse(auth)) return auth

  let body: {
    renewalProductId?: string
    signedRenewalInfo?: string
  } = {}

  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const renewalProductId = typeof body.renewalProductId === 'string' ? body.renewalProductId.trim() : ''
  if (!renewalProductId) {
    return NextResponse.json({ error: 'renewalProductId is required' }, { status: 400 })
  }

  try {
    const result = await syncRenewalPreference({
      uid: auth.uid,
      renewalProductId,
      signedRenewalInfo: body.signedRenewalInfo,
    })
    return NextResponse.json(result)
  } catch (error) {
    const { message, status, code } = apiErrorResponse(error)
    console.error('[iap/sync-renewal]', auth.uid, message)
    return NextResponse.json({ error: message, code }, { status: status >= 400 && status < 600 ? status : 400 })
  }
}
