import { ApiError } from '@/lib/api-errors'
import { getNearbyAccess } from '@/lib/ridgits-subscription'

/**
 * Pokes and messaging require an active paid subscription (Ridgits+, Premium, or Ultra).
 * Free users can still browse/match — this only gates the two actions explicitly called
 * out by product: sending a poke and starting/sending a message.
 */
export async function requireActiveSubscription(uid: string, email?: string | null): Promise<void> {
  const access = await getNearbyAccess(uid, email)
  if (!access.hasNearbyAccess) {
    throw new ApiError(
      'A Ridgits+ subscription is required to do this. Upgrade to start connecting.',
      402,
      'SUBSCRIPTION_REQUIRED',
    )
  }
}
