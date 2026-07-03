import { getDb } from '@/lib/firebase-admin'
import { Timestamp } from 'firebase-admin/firestore'
import { effectiveSubscriptionTier } from '@/lib/subscription-badge'

function parseExpiration(value: unknown): Date | null {
  if (!value) return null
  if (value instanceof Timestamp) return value.toDate()
  if (value instanceof Date) return value
  if (typeof value === 'object' && value !== null && 'toDate' in value) {
    const maybeDate = (value as { toDate?: () => Date }).toDate?.()
    if (maybeDate instanceof Date) return maybeDate
  }
  if (typeof value === 'number') {
    const ms = value > 1_000_000_000_000 ? value : value * 1000
    const parsed = new Date(ms)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : new Date(parsed)
  }
  return null
}

function isBypassEmail(email?: string | null): boolean {
  if (!email) return false
  const list = (process.env.RIDGITS_BYPASS_EMAILS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
  return list.includes(email.toLowerCase())
}

/** Active paid access — canceled subscriptions lose access immediately. */
export function hasActiveSubscriptionAccess(
  userData: Record<string, unknown> | undefined,
): boolean {
  if (!userData) return false

  if (userData.subscriptionStatus === 'canceled') {
    return false
  }

  if (userData.isSubscribed === false) {
    return false
  }

  return (
    userData.isSubscribed === true ||
    userData.subscriptionStatus === 'active' ||
    userData.subscriptionStatus === 'trialing'
  )
}

export async function getNearbyAccess(
  uid: string,
  email?: string | null,
): Promise<{
  hasNearbyAccess: boolean
  subscriptionExpiresAt: string | null
  subscriptionSource: 'stripe' | 'app_store' | 'bypass' | null
  subscriptionTier: string | null
}> {
  if (isBypassEmail(email)) {
    return {
      hasNearbyAccess: true,
      subscriptionExpiresAt: null,
      subscriptionSource: 'bypass',
      subscriptionTier: 'premium',
    }
  }

  const snap = await getDb().collection('users').doc(uid).get()
  if (!snap.exists) {
    return {
      hasNearbyAccess: false,
      subscriptionExpiresAt: null,
      subscriptionSource: null,
      subscriptionTier: null,
    }
  }

  const data = snap.data() ?? {}
  const active = hasActiveSubscriptionAccess(data)
  const tier = active ? effectiveSubscriptionTier(data) : 'free'
  const sourceRaw = String(data.subscriptionSource ?? '').trim()
  const subscriptionSource: 'stripe' | 'app_store' | null =
    sourceRaw === 'app_store'
      ? 'app_store'
      : data.stripeCustomerId || data.subscriptionId
        ? 'stripe'
        : null

  const expiration =
    parseExpiration(data.subscriptionExpiresAt) ??
    parseExpiration(data.subscriptionExpiration) ??
    parseExpiration(data.subscriptionCurrentPeriodEnd) ??
    parseExpiration(data.subscriptionEndDate)

  // LinkedIn-style: any active Ridgits subscription (web Stripe or App Store) unlocks nearby.
  if (!active) {
    return {
      hasNearbyAccess: false,
      subscriptionExpiresAt: expiration?.toISOString() ?? null,
      subscriptionSource,
      subscriptionTier: 'free',
    }
  }

  if (expiration && expiration.getTime() <= Date.now()) {
    return {
      hasNearbyAccess: false,
      subscriptionExpiresAt: expiration.toISOString(),
      subscriptionSource,
      subscriptionTier: 'free',
    }
  }

  return {
    hasNearbyAccess: true,
    subscriptionExpiresAt: expiration?.toISOString() ?? null,
    subscriptionSource: subscriptionSource ?? (sourceRaw === 'app_store' ? 'app_store' : 'stripe'),
    subscriptionTier: tier,
  }
}
