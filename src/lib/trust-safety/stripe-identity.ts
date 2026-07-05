import { FieldValue } from 'firebase-admin/firestore'
import type Stripe from 'stripe'
import { ApiError } from '@/lib/api-errors'
import { getDb } from '@/lib/firebase-admin'
import { getStripe, isStripeConfigured } from '@/lib/stripe-client'
import { matchProfilePhotoToIdentity } from '@/lib/trust-safety/profile-identity-match'
import {
  assertPhoneNotAlreadyClaimed,
  claimPhoneForUser,
  normalizeE164Phone,
} from '@/lib/trust-safety/phone-safety'

export const IDENTITY_APP_DEEP_LINK = 'ridgits://identity/complete'
export const IDENTITY_RETURN_URL =
  process.env.STRIPE_IDENTITY_RETURN_URL?.trim() || 'https://ridgits.com/identity/complete'

/** Stripe Identity phone OTP is enabled by default; set RIDGITS_IDENTITY_REQUIRE_PHONE=false to disable. */
function identityRequiresPhoneVerification(): boolean {
  const raw = process.env.RIDGITS_IDENTITY_REQUIRE_PHONE?.trim().toLowerCase()
  if (raw === 'false' || raw === '0' || raw === 'no') return false
  return true
}

function getVerificationFlowId(): string | null {
  const flowId = process.env.STRIPE_IDENTITY_VERIFICATION_FLOW_ID?.trim()
  return flowId || null
}

export type IdentityVerificationStatus =
  | 'none'
  | 'pending'
  | 'verified'
  | 'failed'
  | 'requires_input'
  | 'canceled'

export type ProfilePhotoIdentityMatchStatus = 'none' | 'pending' | 'verified' | 'failed'
export type PhoneVerificationStatus = 'none' | 'pending' | 'verified' | 'failed'

export interface IdentityStatusPayload {
  identityVerificationStatus: IdentityVerificationStatus
  identityVerifiedAt: string | null
  phoneVerificationStatus: PhoneVerificationStatus
  phoneVerifiedAt: string | null
  profilePhotoIdentityMatchStatus: ProfilePhotoIdentityMatchStatus
  profilePhotoIdentityMatchAt: string | null
  profilePhotoIdentityMatchScore: number | null
  canSubscribe: boolean
  canMessage: boolean
}

function mapSessionStatus(status: Stripe.Identity.VerificationSession.Status): IdentityVerificationStatus {
  switch (status) {
    case 'verified':
      return 'verified'
    case 'processing':
      return 'pending'
    case 'requires_input':
      return 'requires_input'
    case 'canceled':
      return 'canceled'
    default:
      return 'failed'
  }
}

function timestampToIso(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const maybe = value as { toDate?: () => Date }
  if (typeof maybe.toDate === 'function') {
    return maybe.toDate().toISOString()
  }
  return null
}

/** Pull latest verification state from Stripe when Firestore is stale (e.g. webhook missed). */
async function syncIdentityStatusFromStripeIfNeeded(
  uid: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const sessionId = String(data.stripeVerificationSessionId ?? '').trim()
  if (!sessionId || !isStripeConfigured()) return data

  const identityOk = data.identityVerificationStatus === 'verified'
  const phoneOk =
    !identityRequiresPhoneVerification() || data.phoneVerificationStatus === 'verified'
  if (identityOk && phoneOk) return data

  try {
    const stripe = getStripe()
    const session = await stripe.identity.verificationSessions.retrieve(sessionId)
    await applyVerificationSessionUpdate(session)
    const refreshed = await getDb().collection('users').doc(uid).get()
    return refreshed.data() ?? data
  } catch (error) {
    console.error('[stripe-identity] sync from Stripe failed', uid, sessionId, error)
  }

  return data
}

export async function getIdentityStatus(uid: string): Promise<IdentityStatusPayload> {
  const snap = await getDb().collection('users').doc(uid).get()
  const data = await syncIdentityStatusFromStripeIfNeeded(uid, snap.data() ?? {})

  const identityVerificationStatus = (data.identityVerificationStatus as IdentityVerificationStatus | undefined) ?? 'none'
  const phoneVerificationStatus = (data.phoneVerificationStatus as PhoneVerificationStatus | undefined) ?? 'none'
  const profilePhotoIdentityMatchStatus =
    (data.profilePhotoIdentityMatchStatus as ProfilePhotoIdentityMatchStatus | undefined) ?? 'none'

  const identityOk = identityVerificationStatus === 'verified'
  const phoneOk = !identityRequiresPhoneVerification() || phoneVerificationStatus === 'verified'

  return {
    identityVerificationStatus,
    identityVerifiedAt: timestampToIso(data.identityVerifiedAt),
    phoneVerificationStatus,
    phoneVerifiedAt: timestampToIso(data.phoneVerifiedAt),
    profilePhotoIdentityMatchStatus,
    profilePhotoIdentityMatchAt: timestampToIso(data.profilePhotoIdentityMatchAt),
    profilePhotoIdentityMatchScore:
      typeof data.profilePhotoIdentityMatchScore === 'number' ? data.profilePhotoIdentityMatchScore : null,
    canSubscribe: true,
    canMessage: identityOk && phoneOk,
  }
}

export async function requireIdentityVerified(uid: string): Promise<void> {
  const status = await getIdentityStatus(uid)
  if (status.identityVerificationStatus !== 'verified') {
    throw new ApiError(
      'Identity verification required before messaging.',
      403,
      'IDENTITY_VERIFICATION_REQUIRED',
    )
  }

  if (identityRequiresPhoneVerification() && status.phoneVerificationStatus !== 'verified') {
    throw new ApiError(
      'Phone verification required before messaging.',
      403,
      'PHONE_VERIFICATION_REQUIRED',
    )
  }
}

export async function requireProfilePhotoIdentityMatch(uid: string): Promise<void> {
  const snap = await getDb().collection('users').doc(uid).get()
  const identityStatus = String(snap.get('identityVerificationStatus') ?? '')
  if (identityStatus !== 'verified') {
    throw new ApiError(
      'Verify with a government ID to message.',
      403,
      'IDENTITY_VERIFICATION_REQUIRED',
    )
  }

  if (identityRequiresPhoneVerification()) {
    const phoneStatus = String(snap.get('phoneVerificationStatus') ?? '')
    if (phoneStatus !== 'verified') {
      throw new ApiError(
        'Verify your phone number to message.',
        403,
        'PHONE_VERIFICATION_REQUIRED',
      )
    }
  }

  const matchStatus = String(snap.get('profilePhotoIdentityMatchStatus') ?? '')
  if (matchStatus !== 'verified') {
    throw new ApiError(
      'Your profile photo must match your verified ID selfie to message.',
      412,
      'PROFILE_PHOTO_IDENTITY_MISMATCH',
    )
  }
}

export async function createIdentityVerificationSession(
  uid: string,
  input?: { phone?: string },
): Promise<{ url: string; sessionId: string }> {
  if (!isStripeConfigured()) {
    throw new ApiError('Identity verification is not configured.', 503, 'IDENTITY_UNAVAILABLE')
  }

  const stripe = getStripe()
  const userRef = getDb().collection('users').doc(uid)
  const userSnap = await userRef.get()
  const existingSessionId = userSnap.get('stripeVerificationSessionId') as string | undefined

  if (existingSessionId) {
    try {
      const existing = await stripe.identity.verificationSessions.retrieve(existingSessionId)
      if (['requires_input', 'processing'].includes(existing.status) && existing.url) {
        return { url: existing.url, sessionId: existing.id }
      }
    } catch {
      // Fall through and create a new session.
    }
  }

  const requirePhone = identityRequiresPhoneVerification()
  const flowId = getVerificationFlowId()
  const normalizedPhone = input?.phone?.trim() ? normalizeE164Phone(input.phone) : null

  if (requirePhone && !flowId) {
    throw new ApiError(
      'Phone verification is not configured. Set STRIPE_IDENTITY_VERIFICATION_FLOW_ID to a Stripe Dashboard verification flow with phone OTP enabled.',
      503,
      'IDENTITY_PHONE_FLOW_NOT_CONFIGURED',
    )
  }

  if (normalizedPhone) {
    await assertPhoneNotAlreadyClaimed(normalizedPhone, uid)
  }

  const sessionParams: Stripe.Identity.VerificationSessionCreateParams = {
    metadata: { ridgitsUid: uid },
    return_url: IDENTITY_RETURN_URL,
    ...(normalizedPhone
      ? {
          provided_details: {
            phone: normalizedPhone,
          },
        }
      : {}),
  }

  if (flowId) {
    sessionParams.verification_flow = flowId
  } else {
    sessionParams.type = 'document'
    sessionParams.options = {
      document: {
        require_matching_selfie: true,
        require_live_capture: true,
      },
    }
  }

  const session = await stripe.identity.verificationSessions.create(sessionParams)

  await userRef.set(
    {
      stripeVerificationSessionId: session.id,
      identityVerificationStatus: mapSessionStatus(session.status),
    },
    { merge: true },
  )

  if (!session.url) {
    throw new ApiError('Could not start identity verification.', 500, 'IDENTITY_SESSION_FAILED')
  }

  return { url: session.url, sessionId: session.id }
}

export async function applyVerificationSessionUpdate(session: Stripe.Identity.VerificationSession): Promise<void> {
  const uid = session.metadata?.ridgitsUid?.trim()
  if (!uid) {
    console.warn('[stripe-identity] verification session missing ridgitsUid metadata', session.id)
    return
  }

  const mappedStatus = mapSessionStatus(session.status)
  const update: Record<string, unknown> = {
    stripeVerificationSessionId: session.id,
    identityVerificationStatus: mappedStatus,
  }

  if (session.status === 'verified') {
    update.identityVerifiedAt = FieldValue.serverTimestamp()

    const dob = session.verified_outputs?.dob
    if (dob?.year) {
      update.identityVerifiedBirthYear = dob.year
    }

    const verifiedPhone = session.verified_outputs?.phone?.trim()
    if (identityRequiresPhoneVerification()) {
      if (verifiedPhone) {
        try {
          const e164 = normalizeE164Phone(verifiedPhone)
          await assertPhoneNotAlreadyClaimed(e164, uid)
          await claimPhoneForUser(uid, e164)
          update.phoneVerificationStatus = 'verified'
          update.phoneVerifiedAt = FieldValue.serverTimestamp()
        } catch (error) {
          console.error('[stripe-identity] phone claim failed after verification', uid, error)
          update.phoneVerificationStatus = 'failed'
        }
      } else {
        update.phoneVerificationStatus = 'failed'
      }
    }
  }

  await getDb().collection('users').doc(uid).set(update, { merge: true })

  if (session.status === 'verified') {
    const phoneOk =
      !identityRequiresPhoneVerification() ||
      String((await getDb().collection('users').doc(uid).get()).get('phoneVerificationStatus') ?? '') ===
        'verified'

    if (phoneOk) {
      const profileSnap = await getDb().collection('publicProfiles').doc(uid).get()
      const profileImage = String(profileSnap.get('image') ?? '').trim()
      if (profileImage) {
        try {
          await matchProfilePhotoToIdentity(uid)
        } catch (error) {
          console.error('[stripe-identity] auto profile match failed after verification', uid, error)
        }
      }
    }
  }
}

export async function handleStripeIdentityWebhookEvent(event: Stripe.Event): Promise<void> {
  if (!event.type.startsWith('identity.verification_session.')) return

  const session = event.data.object as Stripe.Identity.VerificationSession
  await applyVerificationSessionUpdate(session)
}
