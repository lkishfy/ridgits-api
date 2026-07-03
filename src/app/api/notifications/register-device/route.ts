import { NextRequest, NextResponse } from 'next/server'
import { apiErrorResponse } from '@/lib/api-errors'
import { isNextResponse, requireRidgitsAuth } from '@/lib/ridgits-auth'
import { registerDeviceToken, unregisterDeviceToken } from '@/lib/push-notifications'

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
    const result = await registerDeviceToken({
      uid: auth.uid,
      deviceId: body.deviceId.trim(),
      fcmToken: body.fcmToken.trim(),
      platform: body.platform ?? 'ios',
      appVersion: body.appVersion,
      deviceModel: body.deviceModel,
    })
    return NextResponse.json(result)
  } catch (error) {
    const { message, status } = apiErrorResponse(error)
    console.error('[notifications/register-device]', auth.uid, message)
    return NextResponse.json({ error: message }, { status })
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
