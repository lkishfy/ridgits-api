import { ApiError } from '@/lib/api-errors'
import { getNearbyAccess } from '@/lib/ridgits-subscription'

/**
 * Messaging requires an active paid subscription (Ridgits+, Premium, or Ultra).
 * Poke packs (consumable IAP) also require an active subscription before purchase.
 */
export async function requireActiveSubscription(uid: string, email?: string | null): Promise<void> {
  const access = await getNearbyAccess(uid, email)
  if (!access.hasNearbyAccess) {
    throw new ApiError(
      'A Ridgits subscription (Ridgits+, Premium, or Ultra) is required to do this. Upgrade to start connecting.',
      402,
      'SUBSCRIPTION_REQUIRED',
    )
  }
}
