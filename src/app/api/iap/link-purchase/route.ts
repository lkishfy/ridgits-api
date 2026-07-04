import { NextRequest, NextResponse } from 'next/server'
import { apiErrorResponse } from '@/lib/api-errors'
import { isNextResponse, requireRidgitsAuth } from '@/lib/ridgits-auth'
import { linkPurchase } from '@/lib/ridgits-iap'

export async function POST(request: NextRequest) {
  const auth = await requireRidgitsAuth(request)
  if (isNextResponse(auth)) return auth

  let body: {
    transactionId?: string
    productId?: string
    signedTransactionInfo?: string
  } = {}

  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  try {
    const result = await linkPurchase({
      uid: auth.uid,
      transactionId: body.transactionId,
      productId: body.productId,
      signedTransactionInfo: body.signedTransactionInfo,
    })
    return NextResponse.json(result)
  } catch (error) {
    const { message, status, code } = apiErrorResponse(error)
    console.error('[iap/link-purchase]', auth.uid, message)
    return NextResponse.json({ error: message, code }, { status: status >= 400 && status < 600 ? status : 400 })
  }
}
