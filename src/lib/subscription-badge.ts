import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '@/lib/firebase-admin'
import { purgeLockedPackQuizData } from '@/lib/ridgits-pack-access'
import { hasActiveSubscriptionAccess } from '@/lib/ridgits-subscription'

const PAID_TIERS = new Set(['plus', 'premium', 'ultra', 'nearby_yearly'])

export type SubscriptionBadgeRevokeReason =
  | 'app_store_auto_renew_disabled'
  | 'app_store_subscription_inactive'
  | 'stripe_subscription_deleted'
  | 'inactive_subscription_cleanup'

export type SubscriptionBadgeRevokeSource = 'app_store' | 'stripe' | 'system'

function isPaidTier(tier: unknown): boolean {
  const normalized = String(tier ?? 'free').trim().toLowerCase()
  return PAID_TIERS.has(normalized)
}

/** Tier shown on profiles and in match payloads — never badges inactive subscribers. */
export function effectiveSubscriptionTier(
  userData: Record<string, unknown> | null | undefined,
): string {
  if (!userData) return 'free'
  if (!hasActiveSubscriptionAccess(userData)) return 'free'

  const tier = String(userData.subscriptionTier ?? 'free').trim().toLowerCase()
  if (tier === 'free') {
    if (userData.isSubscribed === true || userData.subscriptionStatus === 'active') {
      return 'plus'
    }
    return 'free'
  }

  return tier
}

export async function logSubscriptionBadgeRevoked(input: {
  uid: string
  previousTier: string
  reason: SubscriptionBadgeRevokeReason
  source: SubscriptionBadgeRevokeSource
  metadata?: Record<string, unknown>
}) {
  const db = getDb()
  await db
    .collection('users')
    .doc(input.uid)
    .collection('subscriptionEvents')
    .add({
      type: 'badge_revoked',
      reason: input.reason,
      source: input.source,
      previousTier: input.previousTier,
      newTier: 'free',
      metadata: input.metadata ?? null,
      createdAt: FieldValue.serverTimestamp(),
    })

  console.info(
    `[subscription-badge] Revoked badge for user ${input.uid}: ${input.previousTier} -> free (${input.reason}, source=${input.source})`,
  )
}

export async function revokeSubscriptionBadge(input: {
  uid: string
  reason: SubscriptionBadgeRevokeReason
  source: SubscriptionBadgeRevokeSource
  previousTier?: string | null
  metadata?: Record<string, unknown>
}): Promise<{ revoked: boolean; previousTier: string | null }> {
  const db = getDb()
  const userRef = db.collection('users').doc(input.uid)
  const publicProfileRef = db.collection('publicProfiles').doc(input.uid)

  const [userSnap, publicSnap] = await Promise.all([userRef.get(), publicProfileRef.get()])
  const userData = userSnap.data() ?? {}
  const publicData = publicSnap.data() ?? {}

  const previousTier =
    input.previousTier ??
    (String(userData.subscriptionTier ?? publicData.subscriptionTier ?? 'free').trim() ||
      'free')

  const userNeedsRevoke = isPaidTier(userData.subscriptionTier)
  const publicNeedsRevoke = isPaidTier(publicData.subscriptionTier)
  const inactive = !hasActiveSubscriptionAccess(userData)

  if (!inactive && !userNeedsRevoke && !publicNeedsRevoke) {
    return { revoked: false, previousTier: isPaidTier(previousTier) ? previousTier : null }
  }

  if (!userNeedsRevoke && !publicNeedsRevoke && !isPaidTier(previousTier)) {
    return { revoked: false, previousTier: null }
  }

  const update = {
    subscriptionTier: 'free',
    subscriptionStatus: 'canceled',
    isSubscribed: false,
    badgeRevokedAt: FieldValue.serverTimestamp(),
    lastValidatedAt: FieldValue.serverTimestamp(),
  }

  await Promise.all([
    userRef.set(update, { merge: true }),
    publicProfileRef.set(
      {
        subscriptionTier: 'free',
        subscriptionStatus: 'canceled',
      },
      { merge: true },
    ),
  ])

  await logSubscriptionBadgeRevoked({
    uid: input.uid,
    previousTier: isPaidTier(previousTier) ? previousTier : String(userData.subscriptionTier ?? 'free'),
    reason: input.reason,
    source: input.source,
    metadata: input.metadata,
  })

  await purgeLockedPackQuizData(input.uid)

  return {
    revoked: true,
    previousTier: isPaidTier(previousTier) ? previousTier : String(userData.subscriptionTier ?? 'free'),
  }
}

/** Keeps `publicProfiles` badge tier in sync with active membership on `users`. */
export async function syncSubscriptionBadge(input: {
  uid: string
  tier: string
  status?: string
}): Promise<void> {
  const tier = String(input.tier ?? 'free').trim().toLowerCase()
  if (!isPaidTier(tier)) return

  const db = getDb()
  await db.collection('publicProfiles').doc(input.uid).set(
    {
      subscriptionTier: tier,
      ...(input.status ? { subscriptionStatus: input.status } : {}),
    },
    { merge: true },
  )
}

/** Clears stale paid tiers when Firestore still shows a badge but access is inactive. */
export async function revokeSubscriptionBadgeIfInactive(uid: string): Promise<boolean> {
  const db = getDb()
  const userSnap = await db.collection('users').doc(uid).get()
  if (!userSnap.exists) return false

  const userData = userSnap.data() ?? {}
  if (hasActiveSubscriptionAccess(userData)) return false

  const publicSnap = await db.collection('publicProfiles').doc(uid).get()
  const publicData = publicSnap.data() ?? {}
  const staleUserTier = isPaidTier(userData.subscriptionTier)
  const stalePublicTier = isPaidTier(publicData.subscriptionTier)

  if (!staleUserTier && !stalePublicTier) return false

  const result = await revokeSubscriptionBadge({
    uid,
    reason: 'inactive_subscription_cleanup',
    source: 'system',
    previousTier: String(userData.subscriptionTier ?? publicData.subscriptionTier ?? 'free'),
    metadata: {
      staleUserTier: userData.subscriptionTier ?? null,
      stalePublicTier: publicData.subscriptionTier ?? null,
      subscriptionStatus: userData.subscriptionStatus ?? null,
    },
  })

  return result.revoked
}
