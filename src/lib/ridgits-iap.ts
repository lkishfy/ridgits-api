import { FieldValue } from 'firebase-admin/firestore'
import { ApiError } from '@/lib/api-errors'
import { getDb } from '@/lib/firebase-admin'
import {
  resolveExpiresIso,
  resolveOriginalTransactionId,
  resolveTransactionId,
} from '@/lib/apple-jws'
import {
  verifyAppleRenewalJws,
  verifyAppleTransactionJws,
} from '@/lib/apple-jws-verifier'
import {
  ARCHETYPE_BUNDLE_PRODUCT_ID,
  ARCHETYPE_PACK_IDS,
  NEARBY_PRODUCT_IDS,
  NEARBY_YEARLY_PRODUCT_ID,
  POKE_PACK_PRODUCT_IDS,
  PRODUCT_TO_PACK_ID,
  RIDGITS_BUNDLE_ID,
  SUBSCRIPTION_PRODUCT_IDS,
  SUPPORTED_IAP_PRODUCT_IDS,
  TIER_RANK,
} from '@/lib/ridgits-products'
import { hasActiveSubscriptionAccess } from '@/lib/ridgits-subscription'
import { purgeLockedPackQuizData } from '@/lib/ridgits-pack-access'
import { assertProfileCompleteForPurchase } from '@/lib/profile-complete'
import { revokeSubscriptionBadge, syncSubscriptionBadge } from '@/lib/subscription-badge'

export interface LinkPurchaseInput {
  uid: string
  transactionId?: string
  productId?: string
  signedTransactionInfo?: string
  /** When true, skip profile completion check (restore / entitlement sync). */
  restoring?: boolean
}

export interface LinkPurchaseResult {
  linked: boolean
  idempotent: boolean
}

const IAP_OWNERSHIP_COLLECTION = 'iapOwnership'

/** Resolves the uid that owns an App Store transaction (global claim, not per-user list). */
export async function findIapOwnerUid(transactionId: string): Promise<string | null> {
  const snap = await getDb().collection(IAP_OWNERSHIP_COLLECTION).doc(transactionId).get()
  if (!snap.exists) return null
  const uid = snap.get('uid')
  return typeof uid === 'string' && uid.trim() ? uid.trim() : null
}

function assertBundleId(bundleId: string | undefined) {
  const actual = String(bundleId ?? RIDGITS_BUNDLE_ID).trim()
  if (actual !== RIDGITS_BUNDLE_ID) {
    throw new Error('Purchase is for a different app bundle')
  }
}

function parseTransactionInput(input: LinkPurchaseInput): Promise<{
  transactionId: string
  productId: string
  originalTransactionId: string
  subscriptionExpiration: string | null
}> {
  const signed = input.signedTransactionInfo?.trim() ?? ''
  if (!signed) {
    throw new Error('signedTransactionInfo is required')
  }

  if (!signed.startsWith('{') && signed.includes('.')) {
    return verifyAppleTransactionJws(signed).then((payload) => {
      const transactionId = resolveTransactionId(payload, input.transactionId?.trim() ?? '')
      const productId = String(payload.productId || input.productId?.trim() || '').trim()
      assertBundleId(String(payload.bundleId ?? ''))
      const subscriptionExpiration = resolveExpiresIso(payload)
      return {
        transactionId,
        productId,
        originalTransactionId: resolveOriginalTransactionId(payload, transactionId),
        subscriptionExpiration,
      }
    })
  }

  throw new Error('Invalid signedTransactionInfo payload')
}

export async function linkPurchase(input: LinkPurchaseInput): Promise<LinkPurchaseResult> {
  const parsed = await parseTransactionInput(input)
  const { transactionId, productId, originalTransactionId, subscriptionExpiration } = parsed

  if (!SUPPORTED_IAP_PRODUCT_IDS.has(productId)) {
    throw new Error('Unsupported product')
  }

  if (!input.restoring) {
    await assertProfileCompleteForPurchase(input.uid)
  }

  const packId = PRODUCT_TO_PACK_ID[productId]
  const isBundle = productId === ARCHETYPE_BUNDLE_PRODUCT_ID
  const isNearbyProduct = NEARBY_PRODUCT_IDS.has(productId)
  const membership = SUBSCRIPTION_PRODUCT_IDS[productId]
  const pokeCredits = POKE_PACK_PRODUCT_IDS[productId]

  const db = getDb()
  const userRef = db.collection('users').doc(input.uid)
  const ownershipRef = db.collection(IAP_OWNERSHIP_COLLECTION).doc(transactionId)

  const result = await db.runTransaction(async (transaction) => {
    const [userSnap, ownershipSnap] = await Promise.all([
      transaction.get(userRef),
      transaction.get(ownershipRef),
    ])
    const isNewUser = !userSnap.exists

    if (ownershipSnap.exists) {
      const existingUid = String(ownershipSnap.get('uid') ?? '').trim()
      if (existingUid && existingUid !== input.uid) {
        throw new ApiError(
          'This purchase is already linked to another Ridgits account.',
          409,
          'IAP_ALREADY_CLAIMED',
        )
      }
    }

    const processed: string[] = isNewUser ? [] : (userSnap.get('processedTransactions') ?? [])
    if (processed.includes(transactionId)) {
      if (membership) {
        const staleTier = String(userSnap.get('subscriptionTier') ?? 'free')
        const staleRank = TIER_RANK[staleTier] ?? 0
        if (staleRank < TIER_RANK[membership.tier]) {
          const expiration = subscriptionExpiration ?? null
          transaction.set(
            userRef,
            {
              ...membershipUpdateFields({ productId, membership, expiresIso: expiration }),
              processedTransactions: FieldValue.arrayUnion(transactionId),
            },
            { merge: true },
          )
          return { linked: true, idempotent: false }
        }
      }
      return { linked: true, idempotent: true }
    }

    const currentTier = String(userSnap.get('subscriptionTier') ?? 'free')
    const currentRank = TIER_RANK[currentTier] ?? 0

    if (membership && currentRank > TIER_RANK[membership.tier]) {
      throw new Error('Downgrades are not supported. Cancel in Apple Subscriptions first.')
    }

    const update: Record<string, unknown> = {
      processedTransactions: FieldValue.arrayUnion(transactionId),
      originalTransactionId,
      currentTransactionId: transactionId,
      lastValidatedAt: FieldValue.serverTimestamp(),
    }

    if (isNewUser) {
      update.accountCreationDate = FieldValue.serverTimestamp()
      update.createdAt = FieldValue.serverTimestamp()
    }

    if (isNearbyProduct) {
      const expiration =
        subscriptionExpiration ??
        new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()

      Object.assign(update, {
        subscriptionProductId: productId,
        isSubscribed: true,
        subscriptionTier: 'nearby_yearly',
        subscriptionSource: 'app_store',
        subscriptionExpiresAt: expiration,
        subscriptionExpiration: expiration,
      })

      if (productId === NEARBY_YEARLY_PRODUCT_ID) {
        update.nearbyAccessGrantedAt = FieldValue.serverTimestamp()
      }
    }

    if (membership) {
      const expiration = subscriptionExpiration ?? null
      Object.assign(update, {
        subscriptionProductId: productId,
        isSubscribed: true,
        subscriptionTier: membership.tier,
        subscriptionBillingPeriod: membership.billing,
        subscriptionSource: 'app_store',
        subscriptionStatus: 'active',
        hasEverBeenSubscribed: true,
        subscriptionExpiresAt: expiration,
        subscriptionExpiration: expiration,
        subscriptionCurrentPeriodEnd: expiration,
      })
    }

    if (packId) {
      update.unlockedPacks = FieldValue.arrayUnion(packId)
      update.purchasedPacks = FieldValue.arrayUnion(packId)
      update.lastQuizPurchaseAt = FieldValue.serverTimestamp()
    }

    if (isBundle) {
      const allPackIds = [...ARCHETYPE_PACK_IDS]
      update.unlockedPacks = FieldValue.arrayUnion(...allPackIds)
      update.purchasedPacks = FieldValue.arrayUnion(...allPackIds)
      update.archetypeBundlePurchasedAt = FieldValue.serverTimestamp()
      update.lastQuizPurchaseAt = FieldValue.serverTimestamp()
    }

    if (pokeCredits) {
      if (!hasActiveSubscriptionAccess(userSnap.data())) {
        throw new ApiError(
          'A Ridgits+ subscription is required to purchase poke packs.',
          402,
          'SUBSCRIPTION_REQUIRED',
        )
      }
      update.pokeCreditBalance = FieldValue.increment(pokeCredits)
      update.lastPokePackPurchaseAt = FieldValue.serverTimestamp()
    }

    transaction.set(userRef, update, { merge: true })
    if (!ownershipSnap.exists) {
      transaction.set(ownershipRef, {
        uid: input.uid,
        originalTransactionId,
        productId,
        claimedAt: FieldValue.serverTimestamp(),
      })
    }
    return { linked: true, idempotent: false }
  })

  if (membership && result.linked) {
    await syncSubscriptionBadge({
      uid: input.uid,
      tier: membership.tier,
      status: 'active',
    })
  }

  return result
}

/** Applies a pending App Store renewal upgrade (autoRenewPreference) before the new period starts. */
export async function syncRenewalPreference(input: {
  uid: string
  renewalProductId: string
  signedRenewalInfo?: string
}): Promise<{ synced: boolean }> {
  const productId = input.renewalProductId.trim()
  const membership = SUBSCRIPTION_PRODUCT_IDS[productId]
  if (!membership) {
    throw new Error('Unsupported renewal product')
  }

  const signed = input.signedRenewalInfo?.trim() ?? ''
  if (!signed) {
    throw new ApiError('signedRenewalInfo is required.', 400, 'INVALID_IAP_SIGNATURE')
  }

  const payload = await verifyAppleRenewalJws(signed)
  const renewId = String(payload.autoRenewProductId ?? payload.productId ?? '').trim()
  if (renewId && renewId !== productId) {
    throw new ApiError('Renewal product mismatch.', 400, 'INVALID_IAP_SIGNATURE')
  }

  const db = getDb()
  const userRef = db.collection('users').doc(input.uid)
  const snap = await userRef.get()
  if (!snap.exists || !hasActiveSubscriptionAccess(snap.data())) {
    throw new ApiError('No active subscription to update.', 412, 'SUBSCRIPTION_REQUIRED')
  }

  const storedTier = String(snap.get('subscriptionTier') ?? 'free')
  const storedRank = TIER_RANK[storedTier] ?? 0
  const renewalRank = TIER_RANK[membership.tier] ?? 0
  if (renewalRank <= storedRank) {
    return { synced: false }
  }

  await userRef.set(
    {
      subscriptionProductId: productId,
      subscriptionTier: membership.tier,
      subscriptionBillingPeriod: membership.billing,
      subscriptionSource: 'app_store',
      subscriptionStatus: 'active',
      lastValidatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  )
  await syncSubscriptionBadge({
    uid: input.uid,
    tier: membership.tier,
    status: 'active',
  })

  return { synced: true }
}

function membershipUpdateFields(input: {
  productId: string
  membership: { tier: 'plus' | 'premium' | 'ultra'; billing: 'monthly' | 'yearly' }
  expiresIso: string | null
}): Record<string, unknown> {
  return {
    isSubscribed: true,
    subscriptionSource: 'app_store',
    subscriptionTier: input.membership.tier,
    subscriptionBillingPeriod: input.membership.billing,
    subscriptionStatus: 'active',
    subscriptionExpiresAt: input.expiresIso,
    subscriptionExpiration: input.expiresIso,
    subscriptionCurrentPeriodEnd: input.expiresIso,
    subscriptionProductId: input.productId,
    hasEverBeenSubscribed: true,
    lastValidatedAt: FieldValue.serverTimestamp(),
  }
}

export async function applyAppStoreNotification(input: {
  notificationType: string
  subtype?: string
  signedTransactionInfo?: string
}): Promise<void> {
  const { notificationType, subtype, signedTransactionInfo } = input
  if (!signedTransactionInfo) return

  const payload = await verifyAppleTransactionJws(signedTransactionInfo)
  const originalTransactionId = resolveOriginalTransactionId(
    payload,
    resolveTransactionId(payload),
  )

  const db = getDb()
  const transactionId = resolveTransactionId(payload)
  let ownerUid = await findIapOwnerUid(transactionId)

  if (!ownerUid) {
    const usersSnap = await db
      .collection('users')
      .where('originalTransactionId', '==', originalTransactionId)
      .limit(1)
      .get()
    if (!usersSnap.empty) {
      ownerUid = usersSnap.docs[0]!.id
    }
  }

  if (!ownerUid) {
    console.warn('[app-store] unmapped transaction', transactionId, originalTransactionId)
    return
  }

  const userRef = db.collection('users').doc(ownerUid)
  const expiresIso = resolveExpiresIso(payload)
  const productId = String(payload.productId ?? '').trim()
  const isNearbyProduct = NEARBY_PRODUCT_IDS.has(productId)
  const membership = SUBSCRIPTION_PRODUCT_IDS[productId]

  const activeTypes = new Set(['SUBSCRIBED', 'DID_RENEW', 'OFFER_REDEEMED'])
  const inactiveTypes = new Set(['EXPIRED', 'GRACE_PERIOD_EXPIRED', 'REFUND', 'REVOKE'])

  if (notificationType === 'DID_CHANGE_RENEWAL_PREF' && membership) {
    if (subtype === 'UPGRADE') {
      await userRef.set(membershipUpdateFields({ productId, membership, expiresIso }), { merge: true })
      await syncSubscriptionBadge({
        uid: userRef.id,
        tier: membership.tier,
        status: 'active',
      })
      await purgeLockedPackQuizData(userRef.id)
      return
    }
    if (subtype === 'DOWNGRADE') {
      // Downgrade takes effect at renewal — keep current tier until expiration.
      return
    }
  }

  if (notificationType === 'DID_CHANGE_RENEWAL_STATUS' && (isNearbyProduct || membership)) {
    if (subtype === 'AUTO_RENEW_DISABLED') {
      await userRef.set(
        {
          isSubscribed: false,
          subscriptionStatus: 'canceled',
          subscriptionExpiresAt: expiresIso ?? FieldValue.delete(),
          subscriptionExpiration: expiresIso ?? FieldValue.delete(),
          subscriptionCurrentPeriodEnd: expiresIso ?? FieldValue.delete(),
          lastValidatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      )
      await revokeSubscriptionBadge({
        uid: userRef.id,
        reason: 'app_store_auto_renew_disabled',
        source: 'app_store',
        metadata: { notificationType, subtype, productId },
      })
    } else if (subtype === 'AUTO_RENEW_ENABLED') {
      await userRef.set(
        {
          isSubscribed: true,
          subscriptionStatus: 'active',
          subscriptionExpiresAt: expiresIso,
          subscriptionExpiration: expiresIso,
          subscriptionCurrentPeriodEnd: expiresIso,
          lastValidatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      )
    }
    return
  }

  if (activeTypes.has(notificationType) && isNearbyProduct) {
    await userRef.set(
      {
        isSubscribed: true,
        subscriptionSource: 'app_store',
        subscriptionTier: 'nearby_yearly',
        subscriptionExpiresAt: expiresIso,
        subscriptionExpiration: expiresIso,
        subscriptionProductId: productId,
        lastValidatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    )
    await purgeLockedPackQuizData(userRef.id)
    return
  }

  if (activeTypes.has(notificationType) && membership) {
    await userRef.set(membershipUpdateFields({ productId, membership, expiresIso }), { merge: true })
    await syncSubscriptionBadge({
      uid: userRef.id,
      tier: membership.tier,
      status: 'active',
    })
    await purgeLockedPackQuizData(userRef.id)
    return
  }

  if ((inactiveTypes.has(notificationType) || subtype === 'VOLUNTARY') && (isNearbyProduct || membership)) {
    await userRef.set(
      {
        isSubscribed: false,
        subscriptionStatus: 'canceled',
        subscriptionExpiresAt: expiresIso ?? FieldValue.delete(),
        subscriptionExpiration: expiresIso ?? FieldValue.delete(),
        subscriptionCurrentPeriodEnd: expiresIso ?? FieldValue.delete(),
        lastValidatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    )
    await revokeSubscriptionBadge({
      uid: userRef.id,
      reason: 'app_store_subscription_inactive',
      source: 'app_store',
      metadata: { notificationType, subtype, productId },
    })
  }
}
