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

function identityRequiresPhoneVerification(): boolean {
  const raw = process.env.RIDGITS_IDENTITY_REQUIRE_PHONE?.trim()
  if (raw === 'false') return false
  return true
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

export async function getIdentityStatus(uid: string): Promise<IdentityStatusPayload> {
  const snap = await getDb().collection('users').doc(uid).get()
  const data = snap.data() ?? {}

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
    canSubscribe: identityOk && phoneOk,
    canMessage: identityOk && phoneOk && profilePhotoIdentityMatchStatus === 'verified',
  }
}

export async function requireIdentityVerified(uid: string): Promise<void> {
  const snap = await getDb().collection('users').doc(uid).get()
  const status = String(snap.get('identityVerificationStatus') ?? '')
  if (status !== 'verified') {
    throw new ApiError(
      'Identity verification required before subscribing.',
      403,
      'IDENTITY_VERIFICATION_REQUIRED',
    )
  }

  if (identityRequiresPhoneVerification()) {
    const phoneStatus = String(snap.get('phoneVerificationStatus') ?? '')
    if (phoneStatus !== 'verified') {
      throw new ApiError(
        'Phone verification required before subscribing.',
        403,
        'PHONE_VERIFICATION_REQUIRED',
      )
    }
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
  const normalizedPhone = input?.phone?.trim() ? normalizeE164Phone(input.phone) : null
  if (normalizedPhone) {
    await assertPhoneNotAlreadyClaimed(normalizedPhone, uid)
  }

  const session = await stripe.identity.verificationSessions.create({
    type: 'document',
    metadata: { ridgitsUid: uid },
    ...(normalizedPhone
      ? {
          provided_details: {
            phone: normalizedPhone,
          },
        }
      : {}),
    options: {
      document: {
        require_matching_selfie: true,
        require_live_capture: true,
      },
      ...(requirePhone
        ? {
            phone: {
              require_verification: true,
            },
          }
        : {}),
    },
    return_url: IDENTITY_RETURN_URL,
  })

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
