export const RIDGITS_BUNDLE_ID = process.env.APP_STORE_BUNDLE_ID ?? 'com.ridgits.app'

/** Non-renewing yearly nearby access — $29.99 */
export const NEARBY_YEARLY_PRODUCT_ID = 'RidgitsNearbyYear2999'

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

/** Auto-renewable membership subscriptions — single App Store subscription group */
export const SUBSCRIPTION_PRODUCT_IDS: Record<
  string,
  { tier: 'plus' | 'premium' | 'ultra'; billing: 'monthly' | 'yearly' }
> = {
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

export const SUPPORTED_IAP_PRODUCT_IDS = new Set([
  NEARBY_YEARLY_PRODUCT_ID,
  ARCHETYPE_BUNDLE_PRODUCT_ID,
  ...Object.values(ARCHETYPE_PACK_PRODUCT_IDS),
  ...MEMBERSHIP_PRODUCT_IDS,
])
