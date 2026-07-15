import { NextRequest, NextResponse } from 'next/server'
import { getStripe } from '@/lib/stripe-client'
import { handleStripeIdentityWebhookEvent } from '@/lib/trust-safety/stripe-identity'

export async function GET() {
  return NextResponse.json({ ok: true, endpoint: 'stripe-identity-webhook' })
}

export async function POST(request: NextRequest) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim()
  if (!webhookSecret) {
    console.error('[stripe-identity webhook] STRIPE_WEBHOOK_SECRET is not configured')
    return NextResponse.json({ error: 'Webhook secret not configured' }, { status: 500 })
  }

  const signature = request.headers.get('stripe-signature')
  if (!signature) {
    return NextResponse.json({ error: 'Missing stripe-signature header' }, { status: 400 })
  }

  const body = await request.text()

  try {
    const stripe = getStripe()
    const event = stripe.webhooks.constructEvent(body, signature, webhookSecret)
    await handleStripeIdentityWebhookEvent(event)
    return NextResponse.json({ received: true })
  } catch (error) {
    console.error('[stripe-identity webhook]', error)
    return NextResponse.json({ error: 'Webhook verification failed' }, { status: 400 })
  }
}
