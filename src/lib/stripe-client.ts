import Stripe from 'stripe'

const STRIPE_API_VERSION: Stripe.LatestApiVersion = '2025-02-24.acacia'

let stripeClient: Stripe | null = null
let stripeIdentityRestrictedClient: Stripe | null = null

function createStripeClient(secretKey: string): Stripe {
  return new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION })
}

export function getStripe(): Stripe {
  if (stripeClient) return stripeClient
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim()
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY is not configured')
  }
  stripeClient = createStripeClient(secretKey)
  return stripeClient
}

/**
 * Restricted key for Stripe Identity selfie/document images and other sensitive fields.
 * https://docs.stripe.com/identity/access-verification-results
 */
export function getStripeIdentityRestricted(): Stripe {
  if (stripeIdentityRestrictedClient) return stripeIdentityRestrictedClient
  const restrictedKey = process.env.STRIPE_IDENTITY_RESTRICTED_KEY?.trim()
  if (!restrictedKey) {
    throw new Error('STRIPE_IDENTITY_RESTRICTED_KEY is not configured')
  }
  stripeIdentityRestrictedClient = createStripeClient(restrictedKey)
  return stripeIdentityRestrictedClient
}

export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY?.trim())
}

export function isStripeIdentityRestrictedConfigured(): boolean {
  return Boolean(process.env.STRIPE_IDENTITY_RESTRICTED_KEY?.trim())
}
