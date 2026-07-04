import { NextRequest, NextResponse } from 'next/server'
import { isNextResponse, requireRidgitsAuth } from '@/lib/ridgits-auth'
import { purgeLockedPackQuizData } from '@/lib/ridgits-pack-access'
import { getNearbyAccess } from '@/lib/ridgits-subscription'
import { revokeSubscriptionBadgeIfInactive } from '@/lib/subscription-badge'

export async function GET(request: NextRequest) {
  const auth = await requireRidgitsAuth(request)
  if (isNextResponse(auth)) return auth

  await revokeSubscriptionBadgeIfInactive(auth.uid)
  await purgeLockedPackQuizData(auth.uid)
  const access = await getNearbyAccess(auth.uid, auth.email)

  return NextResponse.json({
    hasNearbyAccess: access.hasNearbyAccess,
    subscriptionExpiresAt: access.subscriptionExpiresAt,
    subscriptionSource: access.subscriptionSource,
    subscriptionTier: access.subscriptionTier,
  })
}
