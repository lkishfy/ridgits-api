import { NextRequest, NextResponse } from 'next/server'
import { decodeAppleJwsPayload } from '@/lib/apple-jws'
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
    const outer = decodeAppleJwsPayload(signedPayload) as {
      notificationType?: string
      subtype?: string
      data?: { signedTransactionInfo?: string }
    }

    await applyAppStoreNotification({
      notificationType: String(outer.notificationType ?? ''),
      subtype: outer.subtype,
      signedTransactionInfo: outer.data?.signedTransactionInfo,
    })

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[app-store webhook]', error)
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 })
  }
}
