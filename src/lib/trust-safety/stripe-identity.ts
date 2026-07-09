import { FieldValue } from 'firebase-admin/firestore'
import type Stripe from 'stripe'
import { ApiError } from '@/lib/api-errors'
import { getDb } from '@/lib/firebase-admin'
import { getStripe, getStripeIdentityRestricted, isStripeConfigured, isStripeIdentityRestrictedConfigured } from '@/lib/stripe-client'
import { hasActiveSubscriptionAccess } from '@/lib/ridgits-subscription'
import {
  assertIdentityDocumentNotAlreadyClaimed,
  claimIdentityDocumentForUser,
  resolveIdentityDocumentFingerprint,
} from '@/lib/trust-safety/identity-document-safety'
import { isRidgitsBypassEmail } from '@/lib/ridgits-bypass'
import { isManualProfilePhotoVerified, isManualProfilePhotoVerifiedForUser } from '@/lib/ridgits-manual-verification'
import { validateProfilePhotoUrl } from '@/lib/trust-safety/profile-photo'
import { matchProfilePhotoToIdentity, approveProfilePhotoWithoutFaceMatch, requiresProfilePhotoFaceMatch, isProfilePhotoIdentityVerified } from '@/lib/trust-safety/profile-identity-match'
import { registerProfilePhotoForUser } from '@/lib/trust-safety/profile-photo'
import {
  assertPhoneNotAlreadyClaimed,
  claimPhoneForUser,
  normalizeE164Phone,
} from '@/lib/trust-safety/phone-safety'
import {
  computeAgeFromDateOfBirth,
  MINIMUM_AGE_YEARS,
  requireUserBirthYearOnFile,
} from '@/lib/trust-safety/age'

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
  phoneVerificationRequired: boolean
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
async function findVerifiedSessionForUid(
  stripe: Stripe,
  uid: string,
): Promise<Stripe.Identity.VerificationSession | null> {
  const byRef = await stripe.identity.verificationSessions.list({
    client_reference_id: uid,
    limit: 20,
  })
  const fromRef = byRef.data.find((s) => s.status === 'verified')
  if (fromRef) return fromRef

  let startingAfter: string | undefined
  for (let page = 0; page < 5; page++) {
    const list = await stripe.identity.verificationSessions.list({
      limit: 100,
      starting_after: startingAfter,
    })
    const match = list.data.find(
      (s) => s.metadata?.ridgitsUid === uid && s.status === 'verified',
    )
    if (match) return match
    if (!list.has_more || list.data.length === 0) break
    startingAfter = list.data[list.data.length - 1]?.id
  }

  return null
}

async function retrieveSessionWithDetails(
  stripe: Stripe,
  sessionId: string,
): Promise<Stripe.Identity.VerificationSession> {
  return stripe.identity.verificationSessions.retrieve(sessionId, {
    expand: ['verified_outputs', 'last_verification_report'],
  })
}

/** Phone may live on verified_outputs, the verification report, or provided_details. */
async function resolveVerifiedPhone(
  stripe: Stripe,
  session: Stripe.Identity.VerificationSession,
): Promise<string | null> {
  const fromOutputs = session.verified_outputs?.phone?.trim()
  if (fromOutputs) return fromOutputs

  let report = session.last_verification_report
  if (typeof report === 'string' && report.trim()) {
    report = await stripe.identity.verificationReports.retrieve(report.trim())
  }
  if (report && typeof report === 'object' && 'phone' in report) {
    const reportPhone = (report as Stripe.Identity.VerificationReport).phone
    if (reportPhone?.status === 'verified') {
      const normalized = reportPhone.phone?.trim()
      if (normalized) return normalized
    }
  }

  const provided = session.provided_details?.phone?.trim()
  if (provided && session.status === 'verified') return provided

  return null
}

async function syncIdentityStatusFromStripeIfNeeded(
  uid: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!isStripeConfigured()) return data

  const identityOk = data.identityVerificationStatus === 'verified'
  const phoneOk =
    !identityRequiresPhoneVerification() || data.phoneVerificationStatus === 'verified'
  if (identityOk && phoneOk) return data

  const stripe = getStripe()
  let bestData = data

  const isFullyVerified = (userData: Record<string, unknown>) => {
    const idOk = userData.identityVerificationStatus === 'verified'
    const phOk =
      !identityRequiresPhoneVerification() || userData.phoneVerificationStatus === 'verified'
    return idOk && phOk
  }

  try {
    const verifiedSession = await findVerifiedSessionForUid(stripe, uid)
    if (verifiedSession) {
      const fullSession = await retrieveSessionWithDetails(stripe, verifiedSession.id)
      await applyVerificationSessionUpdate(fullSession)
      const refreshed = await getDb().collection('users').doc(uid).get()
      bestData = refreshed.data() ?? bestData
      if (isFullyVerified(bestData)) return bestData
    }
  } catch (error) {
    console.error('[stripe-identity] find verified session failed', uid, error)
  }

  const sessionId = String(data.stripeVerificationSessionId ?? '').trim()
  if (sessionId && (data.identityVerificationStatus !== 'verified' || data.phoneVerificationStatus !== 'verified')) {
    try {
      const session = await retrieveSessionWithDetails(stripe, sessionId)
      if (session.status === 'verified') {
        await applyVerificationSessionUpdate(session)
        const refreshed = await getDb().collection('users').doc(uid).get()
        bestData = refreshed.data() ?? bestData
        if (isFullyVerified(bestData)) return bestData
      } else if (['requires_input', 'processing'].includes(session.status)) {
        await applyVerificationSessionUpdate(session)
        const refreshed = await getDb().collection('users').doc(uid).get()
        bestData = refreshed.data() ?? bestData
      }
    } catch (error) {
      console.error('[stripe-identity] sync stored session failed', uid, sessionId, error)
    }
  }

  return bestData
}

/** Re-run profile ↔ ID selfie match when Stripe is verified but Firestore never got a result. */
async function tryAutoMatchProfilePhotoIfNeeded(
  uid: string,
  email: string | null | undefined,
  data: Record<string, unknown>,
): Promise<void> {
  if (await isManualProfilePhotoVerifiedForUser(uid, email)) return

  const identityOk = data.identityVerificationStatus === 'verified'
  const phoneOk =
    !identityRequiresPhoneVerification() || data.phoneVerificationStatus === 'verified'
  if (!identityOk || !phoneOk) return

  const matchStatus = String(data.profilePhotoIdentityMatchStatus ?? '')
  if (matchStatus === 'verified' || matchStatus === 'failed') return

  const profileSnap = await getDb().collection('publicProfiles').doc(uid).get()
  const profileImage = String(profileSnap.get('image') ?? '').trim()
  if (!profileImage) return

  try {
    await matchProfilePhotoToIdentity(uid, email)
  } catch (error) {
    console.error('[stripe-identity] auto profile photo match on status', uid, error)
  }
}

export async function getIdentityStatus(
  uid: string,
  email?: string | null,
): Promise<IdentityStatusPayload> {
  const snap = await getDb().collection('users').doc(uid).get()
  const data = await syncIdentityStatusFromStripeIfNeeded(uid, snap.data() ?? {})

  await tryAutoMatchProfilePhotoIfNeeded(uid, email, data)
  const refreshedSnap = await getDb().collection('users').doc(uid).get()
  const refreshedData = refreshedSnap.data() ?? data

  const identityVerificationStatus = (refreshedData.identityVerificationStatus as IdentityVerificationStatus | undefined) ?? 'none'
  const phoneVerificationStatus = (refreshedData.phoneVerificationStatus as PhoneVerificationStatus | undefined) ?? 'none'
  const profilePhotoIdentityMatchStatus =
    (refreshedData.profilePhotoIdentityMatchStatus as ProfilePhotoIdentityMatchStatus | undefined) ?? 'none'

  const identityOk = identityVerificationStatus === 'verified'
  const phoneOk = !identityRequiresPhoneVerification() || phoneVerificationStatus === 'verified'
  const manualPhotoBypass = await isManualProfilePhotoVerifiedForUser(uid, email)
  const photoOk = manualPhotoBypass || profilePhotoIdentityMatchStatus === 'verified'

  return {
    identityVerificationStatus,
    identityVerifiedAt: timestampToIso(refreshedData.identityVerifiedAt),
    phoneVerificationStatus,
    phoneVerifiedAt: timestampToIso(refreshedData.phoneVerifiedAt),
    phoneVerificationRequired: identityRequiresPhoneVerification(),
    profilePhotoIdentityMatchStatus: manualPhotoBypass ? 'verified' : profilePhotoIdentityMatchStatus,
    profilePhotoIdentityMatchAt: timestampToIso(refreshedData.profilePhotoIdentityMatchAt),
    profilePhotoIdentityMatchScore:
      typeof refreshedData.profilePhotoIdentityMatchScore === 'number'
        ? refreshedData.profilePhotoIdentityMatchScore
        : null,
    canSubscribe: true,
    canMessage: identityOk && phoneOk && photoOk,
  }
}

export async function requireIdentityVerified(uid: string, email?: string | null): Promise<void> {
  if (isRidgitsBypassEmail(email)) return
  if (isManualProfilePhotoVerified(email)) {
    const snap = await getDb().collection('users').doc(uid).get()
    const identityStatus = String(snap.get('identityVerificationStatus') ?? '')
    if (identityStatus !== 'verified') {
      throw new ApiError(
        'Identity verification required before messaging.',
        403,
        'IDENTITY_VERIFICATION_REQUIRED',
      )
    }
    if (identityRequiresPhoneVerification()) {
      const phoneStatus = String(snap.get('phoneVerificationStatus') ?? '')
      if (phoneStatus !== 'verified') {
        throw new ApiError(
          'Phone verification required before messaging.',
          403,
          'PHONE_VERIFICATION_REQUIRED',
        )
      }
    }
    return
  }
  const status = await getIdentityStatus(uid, email)
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

  if (status.profilePhotoIdentityMatchStatus !== 'verified') {
    throw new ApiError(
      'Your profile photo must match your verified ID selfie to message.',
      412,
      'PROFILE_PHOTO_IDENTITY_MISMATCH',
    )
  }
}

export async function requireProfilePhotoIdentityMatch(
  uid: string,
  email?: string | null,
): Promise<void> {
  if (await isManualProfilePhotoVerifiedForUser(uid, email)) return

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
  email?: string | null,
): Promise<{ url: string; sessionId: string }> {
  if (!isStripeConfigured()) {
    throw new ApiError('Identity verification is not configured.', 503, 'IDENTITY_UNAVAILABLE')
  }

  const userRef = getDb().collection('users').doc(uid)
  const userSnap = await userRef.get()
  const userData = userSnap.data() ?? {}
  if (!hasActiveSubscriptionAccess(userData)) {
    throw new ApiError(
      'Subscribe first to unlock identity verification.',
      403,
      'SUBSCRIPTION_REQUIRED',
    )
  }

  await requireUserBirthYearOnFile(uid)

  if (!(await isManualProfilePhotoVerifiedForUser(uid, email))) {
    const profileSnap = await getDb().collection('publicProfiles').doc(uid).get()
    const profileImage = String(profileSnap.get('image') ?? '').trim()
    const photoCheck = await validateProfilePhotoUrl(profileImage)
    if (!photoCheck.ok) {
      throw new ApiError(
        'Add a profile photo before starting identity verification. Your photo must match your ID selfie within 48 hours of verifying.',
        412,
        'PROFILE_PHOTO_REQUIRED',
      )
    }
  }

  const currentStatus = await getIdentityStatus(uid, email)
  if (currentStatus.identityVerificationStatus === 'verified') {
    const phoneOk =
      !identityRequiresPhoneVerification() || currentStatus.phoneVerificationStatus === 'verified'
    if (phoneOk) {
      throw new ApiError('Identity verification is already complete.', 400, 'IDENTITY_ALREADY_VERIFIED')
    }
  }

  const stripe = getStripe()
  const existingSessionId = userSnap.get('stripeVerificationSessionId') as string | undefined

  if (existingSessionId) {
    try {
      const existing = await retrieveSessionWithDetails(stripe, existingSessionId)
      if (existing.status === 'verified') {
        await applyVerificationSessionUpdate(existing)
        const after = await getIdentityStatus(uid, email)
        const phoneOk =
          !identityRequiresPhoneVerification() || after.phoneVerificationStatus === 'verified'
        if (phoneOk) {
          throw new ApiError('Identity verification is already complete.', 400, 'IDENTITY_ALREADY_VERIFIED')
        }
      }
      if (['requires_input', 'processing'].includes(existing.status) && existing.url) {
        return { url: existing.url, sessionId: existing.id }
      }
    } catch (error) {
      if (error instanceof ApiError) throw error
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
    client_reference_id: uid,
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

  const userRef = getDb().collection('users').doc(uid)
  const existingSnap = await userRef.get()
  const existingIdentity = String(existingSnap.get('identityVerificationStatus') ?? '')
  if (existingIdentity === 'verified' && session.status !== 'verified') {
    return
  }

  const mappedStatus = mapSessionStatus(session.status)
  const update: Record<string, unknown> = {
    stripeVerificationSessionId: session.id,
    identityVerificationStatus: mappedStatus,
  }

  if (session.status === 'verified') {
    const stripe = getStripe()
    const identityStripe = isStripeIdentityRestrictedConfigured()
      ? getStripeIdentityRestricted()
      : stripe
    let allowVerified = true

    const documentHash = await resolveIdentityDocumentFingerprint(identityStripe, session)
    if (documentHash) {
      try {
        await assertIdentityDocumentNotAlreadyClaimed(documentHash, uid)
      } catch (error) {
        console.error('[stripe-identity] duplicate government ID blocked', uid, error)
        allowVerified = false
        update.identityVerificationStatus = 'failed'
        update.trustSafetyFlags = FieldValue.arrayUnion('duplicate_identity_document')
      }
    }

    if (allowVerified) {
      const dob = session.verified_outputs?.dob
      if (dob?.year) {
        const verifiedAge = computeAgeFromDateOfBirth({
          year: dob.year,
          month: dob.month ?? undefined,
          day: dob.day ?? undefined,
        })
        if (verifiedAge < MINIMUM_AGE_YEARS) {
          allowVerified = false
          update.identityVerificationStatus = 'failed'
          update.trustSafetyFlags = FieldValue.arrayUnion('underage_identity_document')
          console.warn('[stripe-identity] underage identity verification blocked', uid, verifiedAge)
        } else {
          update.identityVerifiedBirthYear = dob.year
        }
      }

      if (allowVerified) {
        update.identityVerifiedAt = FieldValue.serverTimestamp()
        update.identityVerificationImagesRedacted = false
        update.identityImagesRedactedAt = FieldValue.delete()

        if (documentHash) {
          await claimIdentityDocumentForUser(uid, documentHash)
        }

        if (identityRequiresPhoneVerification()) {
          const verifiedPhone = await resolveVerifiedPhone(stripe, session)
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
          }
        }
      }
    }
  }

  await userRef.set(update, { merge: true })

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
          const registered = await registerProfilePhotoForUser(uid, profileImage)
          const userSnap = await getDb().collection('users').doc(uid).get()
          const userData = userSnap.data() ?? {}
          const alreadyPhotoVerified = isProfilePhotoIdentityVerified(
            userData,
            profileSnap.data(),
          )
          if (!registered.photoChanged && alreadyPhotoVerified) {
            return
          }

          if (requiresProfilePhotoFaceMatch(userData)) {
            await matchProfilePhotoToIdentity(uid)
          } else {
            await approveProfilePhotoWithoutFaceMatch(uid)
          }
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
