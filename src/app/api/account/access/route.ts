import { NextRequest, NextResponse } from 'next/server'
import { isNextResponse, requireRidgitsAuth } from '@/lib/ridgits-auth'
import { purgeLockedPackQuizData } from '@/lib/ridgits-pack-access'
import { getNearbyAccess } from '@/lib/ridgits-subscription'
import { revokeSubscriptionBadgeIfInactive, repairStaleMembershipTier } from '@/lib/subscription-badge'
import { getIdentityStatus } from '@/lib/trust-safety/stripe-identity'

export async function GET(request: NextRequest) {
  const auth = await requireRidgitsAuth(request)
  if (isNextResponse(auth)) return auth

  await revokeSubscriptionBadgeIfInactive(auth.uid)
  await repairStaleMembershipTier(auth.uid)
  await purgeLockedPackQuizData(auth.uid)
  const access = await getNearbyAccess(auth.uid, auth.email)
  const identity = await getIdentityStatus(auth.uid)

  return NextResponse.json({
    hasNearbyAccess: access.hasNearbyAccess,
    subscriptionExpiresAt: access.subscriptionExpiresAt,
    subscriptionSource: access.subscriptionSource,
    subscriptionTier: access.subscriptionTier,
    identityVerificationStatus: identity.identityVerificationStatus,
    identityVerifiedAt: identity.identityVerifiedAt,
    phoneVerificationStatus: identity.phoneVerificationStatus,
    phoneVerifiedAt: identity.phoneVerifiedAt,
    profilePhotoIdentityMatchStatus: identity.profilePhotoIdentityMatchStatus,
    profilePhotoIdentityMatchAt: identity.profilePhotoIdentityMatchAt,
    profilePhotoIdentityMatchScore: identity.profilePhotoIdentityMatchScore,
    canSubscribe: identity.canSubscribe,
    canMessage: identity.canMessage,
  })
}
