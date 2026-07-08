import { NextRequest, NextResponse } from 'next/server'
import { isNextResponse, requireRidgitsAuth } from '@/lib/ridgits-auth'
import { purgeLockedPackQuizData } from '@/lib/ridgits-pack-access'
import { isRidgitsBypassEmail } from '@/lib/ridgits-bypass'
import { isManualProfilePhotoVerifiedForUser } from '@/lib/ridgits-manual-verification'
import { getNearbyAccess } from '@/lib/ridgits-subscription'
import { revokeSubscriptionBadgeIfInactive, repairStaleMembershipTier } from '@/lib/subscription-badge'
import { getIdentityStatus } from '@/lib/trust-safety/stripe-identity'

export async function GET(request: NextRequest) {
  const auth = await requireRidgitsAuth(request)
  if (isNextResponse(auth)) return auth

  await revokeSubscriptionBadgeIfInactive(auth.uid)
  await repairStaleMembershipTier(auth.uid)
  await purgeLockedPackQuizData(auth.uid)
  const reviewBypass = isRidgitsBypassEmail(auth.email)
  const manualPhotoBypass = await isManualProfilePhotoVerifiedForUser(auth.uid, auth.email)
  const access = await getNearbyAccess(auth.uid, auth.email)
  const identity = await getIdentityStatus(auth.uid, auth.email)

  const photoMatchStatus = reviewBypass || manualPhotoBypass
    ? 'verified'
    : identity.profilePhotoIdentityMatchStatus

  return NextResponse.json({
    hasNearbyAccess: access.hasNearbyAccess,
    subscriptionExpiresAt: access.subscriptionExpiresAt,
    subscriptionSource: access.subscriptionSource,
    subscriptionTier: access.subscriptionTier,
    skipOnboarding: reviewBypass,
    identityVerificationStatus: reviewBypass ? 'verified' : identity.identityVerificationStatus,
    identityVerifiedAt: reviewBypass ? new Date().toISOString() : identity.identityVerifiedAt,
    phoneVerificationStatus: reviewBypass ? 'verified' : identity.phoneVerificationStatus,
    phoneVerifiedAt: reviewBypass ? new Date().toISOString() : identity.phoneVerifiedAt,
    profilePhotoIdentityMatchStatus: photoMatchStatus,
    profilePhotoIdentityMatchAt: reviewBypass || manualPhotoBypass
      ? new Date().toISOString()
      : identity.profilePhotoIdentityMatchAt,
    profilePhotoIdentityMatchScore: reviewBypass ? 1 : identity.profilePhotoIdentityMatchScore,
    canSubscribe: reviewBypass ? true : identity.canSubscribe,
    canMessage: reviewBypass ? true : identity.canMessage,
    manualProfilePhotoVerified: manualPhotoBypass,
  })
}
