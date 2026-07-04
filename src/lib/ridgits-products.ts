export const RIDGITS_BUNDLE_ID = process.env.APP_STORE_BUNDLE_ID ?? 'com.ridgits.app'

/** Non-renewing yearly nearby access — $29.99 */
export const NEARBY_YEARLY_PRODUCT_ID = 'RidgitsNearbyYear2999'

/** Matches closer than this are hidden for free users. */
export const CLOSE_MATCHES_THRESHOLD_MILES = 30

/** Ridgits+ minimum search radius (mi). */
export const PLUS_MIN_RADIUS_MILES = 25

/** Unsubscribed users can search between 30 and 150 miles. */
export const UNSUBSCRIBED_MIN_RADIUS_MILES = 30

export const MAX_NEARBY_RADIUS_MILES = 150

/** Quick-select radius chips (mi). Tier rules gate which values are selectable. */
export const RADIUS_PRESET_MILES = [0, 10, 25, 50, 150] as const

export function nearbySearchMinRadiusMiles(tier: string | null | undefined): number {
  switch (tier) {
    case 'plus':
      return PLUS_MIN_RADIUS_MILES
    case 'premium':
    case 'ultra':
      return 0
    default:
      return UNSUBSCRIBED_MIN_RADIUS_MILES
  }
}

export function nearbySearchMinRadiusMilesForAccess(
  tier: string | null | undefined,
  hasNearbyAccess: boolean,
): number {
  if (!hasNearbyAccess) return UNSUBSCRIBED_MIN_RADIUS_MILES
  return nearbySearchMinRadiusMiles(tier)
}

export function isRadiusLockedForAccess(
  radiusMiles: number,
  tier: string | null | undefined,
  hasNearbyAccess: boolean,
): boolean {
  return radiusMiles < nearbySearchMinRadiusMilesForAccess(tier, hasNearbyAccess)
}

export function nearbyCloseMatchFloorMiles(
  tier: string | null | undefined,
  hasNearbyAccess: boolean,
): number {
  if (!hasNearbyAccess) return CLOSE_MATCHES_THRESHOLD_MILES
  switch (tier) {
    case 'plus':
      return PLUS_MIN_RADIUS_MILES
    case 'premium':
    case 'ultra':
      return 0
    default:
      return CLOSE_MATCHES_THRESHOLD_MILES
  }
}

/** @deprecated Use CLOSE_MATCHES_THRESHOLD_MILES */
export const FREE_NEARBY_RADIUS_MILES = CLOSE_MATCHES_THRESHOLD_MILES

/** @deprecated */
export const NEARBY_PREVIEW_RADIUS_MILES = CLOSE_MATCHES_THRESHOLD_MILES

/** All 10 archetype packs — $49.99 */
export const ARCHETYPE_BUNDLE_PRODUCT_ID = 'RidgitsArchetypeBundle5000'

export const ARCHETYPE_PACK_PRODUCT_IDS: Record<string, string> = {
  situationship: 'RidgitsPackSituationship999',
  'self-sabotage': 'RidgitsPackSelfSabotage999',
  'social-battery': 'RidgitsPackSocialBattery999',
  messaging: 'RidgitsPackMessaging999',
  boundaries: 'RidgitsPackBoundaries999',
  attraction: 'RidgitsPackAttraction999',
  'desire-logic': 'RidgitsPackDesireLogic999',
  'dealbreaker-map': 'RidgitsPackDealbreakerMap999',
  'identity-performance': 'RidgitsPackIdentityPerformance999',
}

export const ARCHETYPE_PACK_IDS = new Set(Object.keys(ARCHETYPE_PACK_PRODUCT_IDS))

export const PRODUCT_TO_PACK_ID = Object.fromEntries(
  Object.entries(ARCHETYPE_PACK_PRODUCT_IDS).map(([packId, productId]) => [productId, packId]),
) as Record<string, string>

/** Auto-renewable membership subscriptions — App Store "Yearly" group + legacy SKUs */
export const SUBSCRIPTION_PRODUCT_IDS: Record<
  string,
  { tier: 'plus' | 'premium' | 'ultra'; billing: 'monthly' | 'yearly' }
> = {
  Plus: { tier: 'plus', billing: 'yearly' },
  Premium: { tier: 'premium', billing: 'yearly' },
  Ultra: { tier: 'ultra', billing: 'yearly' },
  RidgitsPlusMonthly999: { tier: 'plus', billing: 'monthly' },
  RidgitsPlusYearly6000: { tier: 'plus', billing: 'yearly' },
  RidgitsPremiumMonthly1499: { tier: 'premium', billing: 'monthly' },
  RidgitsPremiumYearly9900: { tier: 'premium', billing: 'yearly' },
  RidgitsUltraMonthly1999: { tier: 'ultra', billing: 'monthly' },
  RidgitsUltraYearly9900: { tier: 'ultra', billing: 'yearly' },
  RidgitsUltraYearly14900: { tier: 'ultra', billing: 'yearly' },
}

export const MEMBERSHIP_PRODUCT_IDS = new Set(Object.keys(SUBSCRIPTION_PRODUCT_IDS))

export const TIER_RANK: Record<string, number> = {
  free: 0,
  plus: 1,
  premium: 2,
  ultra: 3,
}

export const NEARBY_PRODUCT_IDS = new Set([NEARBY_YEARLY_PRODUCT_ID])

/** Consumable poke packs — credits added to `users.pokeCreditBalance`. */
export const POKE_PACK_PRODUCT_IDS: Record<string, number> = {
  RidgitsPokes5Pack: 5,
  RidgitsPokes10Pack: 10,
  RidgitsPokes25Pack: 25,
}

export const POKE_PACK_PRODUCT_ID_SET = new Set(Object.keys(POKE_PACK_PRODUCT_IDS))

export const SUPPORTED_IAP_PRODUCT_IDS = new Set([
  NEARBY_YEARLY_PRODUCT_ID,
  ARCHETYPE_BUNDLE_PRODUCT_ID,
  ...Object.values(ARCHETYPE_PACK_PRODUCT_IDS),
  ...MEMBERSHIP_PRODUCT_IDS,
  ...POKE_PACK_PRODUCT_ID_SET,
])
