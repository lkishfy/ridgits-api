import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '@/lib/firebase-admin'
import { SUBSCRIPTION_PRODUCT_IDS, TIER_RANK } from '@/lib/ridgits-products'
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

function normalizeTier(value: unknown): string {
  return String(value ?? 'free').trim().toLowerCase()
}

/** Infer tier from the active App Store product id when Firestore tier is stale after an upgrade. */
export function tierFromSubscriptionProductId(productId: unknown): string | null {
  const id = String(productId ?? '').trim()
  if (!id) return null
  return SUBSCRIPTION_PRODUCT_IDS[id]?.tier ?? null
}

function highestTier(storedTier: string, productTier: string | null): string {
  const stored = normalizeTier(storedTier)
  if (!productTier) return stored
  const storedRank = TIER_RANK[stored] ?? 0
  const productRank = TIER_RANK[productTier] ?? 0
  return productRank > storedRank ? productTier : stored
}

/** Tier shown on profiles and in match payloads — never badges inactive subscribers. */
export function effectiveSubscriptionTier(
  userData: Record<string, unknown> | null | undefined,
): string {
  if (!userData) return 'free'
  if (!hasActiveSubscriptionAccess(userData)) return 'free'

  const productTier = tierFromSubscriptionProductId(userData.subscriptionProductId)
  let tier = highestTier(String(userData.subscriptionTier ?? 'free'), productTier)

  if (tier === 'free') {
    if (userData.isSubscribed === true || userData.subscriptionStatus === 'active') {
      return productTier ?? 'plus'
    }
    return 'free'
  }

  return tier
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

/** Writes the correct tier when `subscriptionProductId` outranks stored `subscriptionTier`. */
export async function repairStaleMembershipTier(uid: string): Promise<string | null> {
  const db = getDb()
  const userRef = db.collection('users').doc(uid)
  const snap = await userRef.get()
  if (!snap.exists) return null

  const data = snap.data() ?? {}
  if (!hasActiveSubscriptionAccess(data)) return null

  const productTier = tierFromSubscriptionProductId(data.subscriptionProductId)
  if (!productTier) return null

  const storedTier = normalizeTier(data.subscriptionTier)
  const storedRank = TIER_RANK[storedTier] ?? 0
  const productRank = TIER_RANK[productTier] ?? 0
  if (productRank <= storedRank) return null

  const membership = SUBSCRIPTION_PRODUCT_IDS[String(data.subscriptionProductId ?? '').trim()]
  await userRef.set(
    {
      subscriptionTier: productTier,
      ...(membership?.billing ? { subscriptionBillingPeriod: membership.billing } : {}),
      lastValidatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  )
  await syncSubscriptionBadge({
    uid,
    tier: productTier,
    status: String(data.subscriptionStatus ?? 'active'),
  })

  return productTier
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
