import { NextRequest, NextResponse } from 'next/server'
import { verifyAppleNotificationJws } from '@/lib/apple-jws-verifier'
import { apiErrorResponse } from '@/lib/api-errors'
import { applyAppStoreNotification } from '@/lib/ridgits-iap'

export async function GET() {
  return NextResponse.json({ ok: true, endpoint: 'app-store-webhook' })
}

export async function POST(request: NextRequest) {
  let body: { signedPayload?: string } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const signedPayload = typeof body.signedPayload === 'string' ? body.signedPayload : ''
  if (!signedPayload.trim()) {
    return NextResponse.json({ error: 'signedPayload is required' }, { status: 400 })
  }

  try {
    const outer = await verifyAppleNotificationJws(signedPayload)
    const data = outer.data as { signedTransactionInfo?: string } | undefined

    await applyAppStoreNotification({
      notificationType: String(outer.notificationType ?? ''),
      subtype: typeof outer.subtype === 'string' ? outer.subtype : undefined,
      signedTransactionInfo: data?.signedTransactionInfo,
    })

    return NextResponse.json({ ok: true })
  } catch (error) {
    const { message, status } = apiErrorResponse(error)
    console.error('[app-store webhook]', message)
    return NextResponse.json({ error: message }, { status: status >= 400 && status < 600 ? status : 400 })
  }
}
