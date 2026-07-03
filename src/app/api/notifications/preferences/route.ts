import { NextRequest, NextResponse } from 'next/server'
import { apiErrorResponse } from '@/lib/api-errors'
import { isNextResponse, requireRidgitsAuth } from '@/lib/ridgits-auth'
import {
  getNotificationPreferences,
  updateNotificationPreferences,
  recordPushOpened,
} from '@/lib/push-notifications'
import type { NotificationPreferences } from '@/lib/engagement/types'

export async function GET(request: NextRequest) {
  const auth = await requireRidgitsAuth(request)
  if (isNextResponse(auth)) return auth

  try {
    const preferences = await getNotificationPreferences(auth.uid)
    return NextResponse.json({ preferences })
  } catch (error) {
    const { message, status } = apiErrorResponse(error)
    return NextResponse.json({ error: message }, { status })
  }
}

export async function PATCH(request: NextRequest) {
  const auth = await requireRidgitsAuth(request)
  if (isNextResponse(auth)) return auth

  let body: Partial<NotificationPreferences> = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  try {
    const preferences = await updateNotificationPreferences(auth.uid, body)
    return NextResponse.json({ preferences })
  } catch (error) {
    const { message, status } = apiErrorResponse(error)
    return NextResponse.json({ error: message }, { status })
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireRidgitsAuth(request)
  if (isNextResponse(auth)) return auth

  let body: { type?: string; metadata?: Record<string, string> } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.type?.trim()) {
    return NextResponse.json({ error: 'type is required' }, { status: 400 })
  }

  try {
    await recordPushOpened(auth.uid, body.type.trim(), body.metadata)
    return NextResponse.json({ recorded: true })
  } catch (error) {
    const { message, status } = apiErrorResponse(error)
    return NextResponse.json({ error: message }, { status })
  }
}
