import { NextRequest, NextResponse } from 'next/server'
import { apiErrorResponse } from '@/lib/api-errors'
import { isNextResponse, requireRidgitsAuthAndAppCheck } from '@/lib/ridgits-auth'
import { linkPurchase } from '@/lib/ridgits-iap'
import { linkPurchaseBodySchema } from '@/lib/schemas/ridgits-bodies'
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

  const body = parseJsonBody(linkPurchaseBodySchema, rawBody)
  if (body instanceof NextResponse) return body

  try {
    const result = await linkPurchase({
      uid: auth.uid,
      transactionId: body.transactionId,
      productId: body.productId,
      signedTransactionInfo: body.signedTransactionInfo,
      restoring: body.restoring === true,
    })
    return NextResponse.json(result)
  } catch (error) {
    const { message, status, code } = apiErrorResponse(error)
    console.error('[iap/link-purchase]', auth.uid, message)
    return NextResponse.json({ error: message, code }, { status: status >= 400 && status < 600 ? status : 400 })
  }
}
