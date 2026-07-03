import { NextRequest, NextResponse } from 'next/server'
import { apiErrorResponse } from '@/lib/api-errors'
import { isNextResponse, requireRidgitsAuth } from '@/lib/ridgits-auth'
import { registerDeviceToken, unregisterDeviceToken } from '@/lib/push-notifications'
import { enforceRateLimit, getClientIp } from '@/lib/trust-safety/rate-limit'
import { recordDeviceFingerprint } from '@/lib/trust-safety/phone-safety'

export async function POST(request: NextRequest) {
  const auth = await requireRidgitsAuth(request)
  if (isNextResponse(auth)) return auth

  let body: {
    deviceId?: string
    fcmToken?: string
    platform?: 'ios' | 'android' | 'web'
    appVersion?: string
    deviceModel?: string
  } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.deviceId?.trim() || !body.fcmToken?.trim()) {
    return NextResponse.json({ error: 'deviceId and fcmToken are required' }, { status: 400 })
  }

  try {
    await enforceRateLimit({
      bucket: 'register-device-ip',
      identifier: getClientIp(request),
      limit: 30,
      windowSeconds: 60 * 60,
    })

    const deviceId = body.deviceId.trim()
    const result = await registerDeviceToken({
      uid: auth.uid,
      deviceId,
      fcmToken: body.fcmToken.trim(),
      platform: body.platform ?? 'ios',
      appVersion: body.appVersion,
      deviceModel: body.deviceModel,
    })

    // Device-fingerprint reuse across many accounts is a strong fake-account signal —
    // reuses the deviceId iOS already sends here (no new client work required).
    await recordDeviceFingerprint(auth.uid, deviceId)

    return NextResponse.json(result)
  } catch (error) {
    const { message, status, code, retryAfterSeconds } = apiErrorResponse(error)
    console.error('[notifications/register-device]', auth.uid, message)
    return NextResponse.json(
      { error: message, code },
      { status, headers: retryAfterSeconds ? { 'Retry-After': String(retryAfterSeconds) } : undefined },
    )
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireRidgitsAuth(request)
  if (isNextResponse(auth)) return auth

  let body: { deviceId?: string } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.deviceId?.trim()) {
    return NextResponse.json({ error: 'deviceId is required' }, { status: 400 })
  }

  try {
    const result = await unregisterDeviceToken(auth.uid, body.deviceId.trim())
    return NextResponse.json(result)
  } catch (error) {
    const { message, status } = apiErrorResponse(error)
    return NextResponse.json({ error: message }, { status })
  }
}
