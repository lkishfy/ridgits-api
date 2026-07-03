import { NextRequest, NextResponse } from 'next/server'
import { isNextResponse, requireRidgitsAuth } from '@/lib/ridgits-auth'
import { getNearbyAccess } from '@/lib/ridgits-subscription'

export async function GET(request: NextRequest) {
  const auth = await requireRidgitsAuth(request)
  if (isNextResponse(auth)) return auth

  const access = await getNearbyAccess(auth.uid, auth.email)

  return NextResponse.json({
    hasNearbyAccess: access.hasNearbyAccess,
    subscriptionExpiresAt: access.subscriptionExpiresAt,
    subscriptionSource: access.subscriptionSource,
    subscriptionTier: access.subscriptionTier,
  })
}
