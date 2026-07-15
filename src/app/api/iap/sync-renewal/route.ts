import { NextRequest, NextResponse } from 'next/server'
import { apiErrorResponse } from '@/lib/api-errors'
import { isNextResponse, requireRidgitsAuthAndAppCheck } from '@/lib/ridgits-auth'
import { syncRenewalPreference } from '@/lib/ridgits-iap'
import { syncRenewalBodySchema } from '@/lib/schemas/ridgits-bodies'
import { parseJsonBody } from '@/lib/schemas/parse-body'

export async function POST(request: NextRequest) {
  const auth = await requireRidgitsAuthAndAppCheck(request)
  if (isNextResponse(auth)) return auth

  let rawBody: unknown
  try {
    rawBody = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const body = parseJsonBody(syncRenewalBodySchema, rawBody)
  if (body instanceof NextResponse) return body

  try {
    const result = await syncRenewalPreference({
      uid: auth.uid,
      renewalProductId: body.renewalProductId,
      signedRenewalInfo: body.signedRenewalInfo,
    })
    return NextResponse.json(result)
  } catch (error) {
    const { message, status, code } = apiErrorResponse(error)
    console.error('[iap/sync-renewal]', auth.uid, message)
    return NextResponse.json({ error: message, code }, { status: status >= 400 && status < 600 ? status : 400 })
  }
}
