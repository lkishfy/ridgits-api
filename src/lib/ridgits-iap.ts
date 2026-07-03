import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '@/lib/firebase-admin'
import {
  decodeAppleJwsPayload,
  resolveExpiresIso,
  resolveOriginalTransactionId,
  resolveTransactionId,
} from '@/lib/apple-jws'
import {
  NEARBY_PRODUCT_IDS,
  NEARBY_YEARLY_PRODUCT_ID,
  RIDGITS_BUNDLE_ID,
} from '@/lib/ridgits-products'

export interface LinkPurchaseInput {
  uid: string
  transactionId?: string
  productId?: string
  signedTransactionInfo?: string
}

export interface LinkPurchaseResult {
  linked: boolean
  idempotent: boolean
}

function assertBundleId(bundleId: string | undefined) {
  const actual = String(bundleId ?? RIDGITS_BUNDLE_ID).trim()
  if (actual !== RIDGITS_BUNDLE_ID) {
    throw new Error('Purchase is for a different app bundle')
  }
}

function parseTransactionInput(input: LinkPurchaseInput): {
  transactionId: string
  productId: string
  originalTransactionId: string
  subscriptionExpiration: string | null
} {
  let transactionId = input.transactionId?.trim() ?? ''
  let productId = input.productId?.trim() ?? ''
  let subscriptionExpiration: string | null = null

  const signed = input.signedTransactionInfo?.trim() ?? ''
  if (!signed) {
    throw new Error('signedTransactionInfo is required')
  }

  if (!signed.startsWith('{') && signed.includes('.')) {
    const payload = decodeAppleJwsPayload(signed)
    transactionId = resolveTransactionId(payload, transactionId)
    productId = String(payload.productId || productId).trim()
    assertBundleId(payload.bundleId)
    subscriptionExpiration = resolveExpiresIso(payload)
    return {
      transactionId,
      productId,
      originalTransactionId: resolveOriginalTransactionId(payload, transactionId),
      subscriptionExpiration,
    }
  }

  throw new Error('Invalid signedTransactionInfo payload')
}

export async function linkPurchase(input: LinkPurchaseInput): Promise<LinkPurchaseResult> {
  const parsed = parseTransactionInput(input)
  const { transactionId, productId, originalTransactionId, subscriptionExpiration } = parsed

  if (!NEARBY_PRODUCT_IDS.has(productId)) {
    throw new Error('Unsupported product')
  }

  const db = getDb()
  const userRef = db.collection('users').doc(input.uid)

  return db.runTransaction(async (transaction) => {
    const userSnap = await transaction.get(userRef)
    const isNewUser = !userSnap.exists

    const processed: string[] = isNewUser ? [] : (userSnap.get('processedTransactions') ?? [])
    if (processed.includes(transactionId)) {
      return { linked: true, idempotent: true }
    }

    const expiration =
      subscriptionExpiration ??
      new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()

    const update: Record<string, unknown> = {
      processedTransactions: FieldValue.arrayUnion(transactionId),
      originalTransactionId,
      currentTransactionId: transactionId,
      subscriptionProductId: productId,
      isSubscribed: true,
      subscriptionTier: 'nearby_yearly',
      subscriptionSource: 'app_store',
      subscriptionExpiresAt: expiration,
      subscriptionExpiration: expiration,
      lastValidatedAt: FieldValue.serverTimestamp(),
    }

    if (isNewUser) {
      update.accountCreationDate = FieldValue.serverTimestamp()
      update.createdAt = FieldValue.serverTimestamp()
    }

    if (productId === NEARBY_YEARLY_PRODUCT_ID) {
      update.nearbyAccessGrantedAt = FieldValue.serverTimestamp()
    }

    transaction.set(userRef, update, { merge: true })
    return { linked: true, idempotent: false }
  })
}

export async function applyAppStoreNotification(input: {
  notificationType: string
  subtype?: string
  signedTransactionInfo?: string
}): Promise<void> {
  const { notificationType, subtype, signedTransactionInfo } = input
  if (!signedTransactionInfo) return

  const payload = decodeAppleJwsPayload(signedTransactionInfo)
  const originalTransactionId = resolveOriginalTransactionId(
    payload,
    resolveTransactionId(payload),
  )

  const db = getDb()
  const usersSnap = await db
    .collection('users')
    .where('originalTransactionId', '==', originalTransactionId)
    .limit(1)
    .get()

  if (usersSnap.empty) {
    console.warn('[app-store] unmapped originalTransactionId', originalTransactionId)
    return
  }

  const userRef = usersSnap.docs[0]!.ref
  const expiresIso = resolveExpiresIso(payload)
  const productId = String(payload.productId ?? '').trim()
  const isNearbyProduct = NEARBY_PRODUCT_IDS.has(productId)

  const activeTypes = new Set(['SUBSCRIBED', 'DID_RENEW', 'OFFER_REDEEMED'])
  const inactiveTypes = new Set(['EXPIRED', 'GRACE_PERIOD_EXPIRED', 'REFUND', 'REVOKE'])

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
    return
  }

  if (inactiveTypes.has(notificationType) || subtype === 'VOLUNTARY') {
    await userRef.set(
      {
        isSubscribed: false,
        subscriptionStatus: 'canceled',
        subscriptionExpiresAt: expiresIso ?? FieldValue.delete(),
        subscriptionExpiration: expiresIso ?? FieldValue.delete(),
      },
      { merge: true },
    )
  }
}
