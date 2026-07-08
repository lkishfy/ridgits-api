import { FieldValue } from 'firebase-admin/firestore'
import { ApiError } from '@/lib/api-errors'
import { getDb } from '@/lib/firebase-admin'
import { getStripe, isStripeConfigured } from '@/lib/stripe-client'
import {
  compareFacesWithRekognition,
  downloadImageBytes,
  isRekognitionConfigured,
  secureClearBuffer,
} from '@/lib/trust-safety/rekognition-face-compare'
import { validateProfilePhotoUrl, hashProfilePhotoFromUrl, assertProfilePhotoNotAlreadyClaimed, claimProfilePhotoForUser } from '@/lib/trust-safety/profile-photo'

const DEFAULT_MATCH_THRESHOLD = 0.9

function matchThreshold(): number {
  const raw = process.env.RIDGITS_IDENTITY_FACE_MATCH_THRESHOLD?.trim()
  const parsed = raw ? Number(raw) : DEFAULT_MATCH_THRESHOLD
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : DEFAULT_MATCH_THRESHOLD
}

async function createTemporarySelfieUrl(selfieFileId: string): Promise<string> {
  const stripe = getStripe()
  const fileLink = await stripe.fileLinks.create({
    file: selfieFileId,
    expires_at: Math.floor(Date.now() / 1000) + 30,
  })
  if (!fileLink.url) {
    throw new ApiError('Could not access verified selfie for comparison.', 502, 'IDENTITY_SELFIE_UNAVAILABLE')
  }
  return fileLink.url
}

async function resolveVerifiedSelfieFileId(uid: string): Promise<string> {
  if (!isStripeConfigured()) {
    throw new ApiError('Identity verification is not configured.', 503, 'IDENTITY_UNAVAILABLE')
  }

  const userSnap = await getDb().collection('users').doc(uid).get()
  if (userSnap.get('identityVerificationImagesRedacted') === true) {
    throw new ApiError(
      'Re-verify your identity before matching a new profile photo.',
      412,
      'IDENTITY_REVERIFICATION_REQUIRED',
    )
  }

  if (String(userSnap.get('identityVerificationStatus') ?? '') !== 'verified') {
    throw new ApiError('Complete identity verification before matching your profile photo.', 412, 'IDENTITY_VERIFICATION_REQUIRED')
  }

  const sessionId = String(userSnap.get('stripeVerificationSessionId') ?? '').trim()
  if (!sessionId) {
    throw new ApiError('No verified identity session found.', 412, 'IDENTITY_VERIFICATION_REQUIRED')
  }

  const stripe = getStripe()
  const session = await stripe.identity.verificationSessions.retrieve(sessionId)
  if (session.status !== 'verified') {
    throw new ApiError('Identity verification is not complete.', 412, 'IDENTITY_VERIFICATION_REQUIRED')
  }

  const reportId =
    typeof session.last_verification_report === 'string'
      ? session.last_verification_report
      : session.last_verification_report?.id

  if (!reportId) {
    throw new ApiError('Verified identity report is unavailable.', 502, 'IDENTITY_SELFIE_UNAVAILABLE')
  }

  const report = await stripe.identity.verificationReports.retrieve(reportId)
  const selfieFileId = report.selfie?.selfie
  if (!selfieFileId) {
    throw new ApiError('Verified selfie is unavailable.', 502, 'IDENTITY_SELFIE_UNAVAILABLE')
  }

  return selfieFileId
}

/**
 * After a successful profile-to-ID match, redact the Stripe Identity session so
 * selfie and document images are deleted from Stripe per their retention guidance.
 * https://docs.stripe.com/identity/access-verification-results
 */
async function redactVerifiedIdentityImages(uid: string): Promise<void> {
  const userSnap = await getDb().collection('users').doc(uid).get()
  if (userSnap.get('identityVerificationImagesRedacted') === true) return

  const sessionId = String(userSnap.get('stripeVerificationSessionId') ?? '').trim()
  if (!sessionId || !isStripeConfigured()) return

  try {
    const stripe = getStripe()
    await stripe.identity.verificationSessions.redact(sessionId)
    await getDb().collection('users').doc(uid).set(
      {
        identityVerificationImagesRedacted: true,
        identityImagesRedactedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    )
  } catch (error) {
    console.error('[profile-identity-match] failed to redact Stripe identity images', uid, error)
  }
}

export interface ProfileIdentityMatchResult {
  status: 'verified' | 'failed'
  score: number | null
  threshold: number
}

export function isProfilePhotoIdentityVerified(
  userData?: Record<string, unknown> | null,
  publicProfile?: Record<string, unknown> | null,
): boolean {
  if (publicProfile?.profilePhotoVerified === true) return true
  return String(userData?.profilePhotoIdentityMatchStatus ?? '') === 'verified'
}

async function syncPublicProfilePhotoVerified(uid: string, verified: boolean): Promise<void> {
  await getDb().collection('publicProfiles').doc(uid).set({ profilePhotoVerified: verified }, { merge: true })
}

export async function matchProfilePhotoToIdentity(uid: string): Promise<ProfileIdentityMatchResult> {
  if (!isRekognitionConfigured()) {
    throw new ApiError('Face match is not configured.', 503, 'FACE_MATCH_UNAVAILABLE')
  }

  const profileSnap = await getDb().collection('publicProfiles').doc(uid).get()
  const profileImage = String(profileSnap.get('image') ?? '').trim()

  const photoCheck = await validateProfilePhotoUrl(profileImage)
  if (!photoCheck.ok) {
    throw new ApiError(photoCheck.reason ?? 'A valid profile photo is required.', 412, 'INVALID_PROFILE_PHOTO')
  }

  const photoHash = await hashProfilePhotoFromUrl(profileImage)
  await assertProfilePhotoNotAlreadyClaimed(photoHash, uid)

  await getDb().collection('users').doc(uid).set(
    { profilePhotoIdentityMatchStatus: 'pending' },
    { merge: true },
  )

  const selfieFileId = await resolveVerifiedSelfieFileId(uid)
  const selfieUrl = await createTemporarySelfieUrl(selfieFileId)

  let profileBytes: Buffer | null = null
  let selfieBytes: Buffer | null = null

  try {
    ;[profileBytes, selfieBytes] = await Promise.all([
      downloadImageBytes(profileImage),
      downloadImageBytes(selfieUrl),
    ])

    const threshold = matchThreshold()
    const { match, score } = await compareFacesWithRekognition(profileBytes, selfieBytes, threshold)
    const status = match ? 'verified' : 'failed'

    await getDb().collection('users').doc(uid).set(
      {
        profilePhotoIdentityMatchStatus: status,
        profilePhotoIdentityMatchAt: FieldValue.serverTimestamp(),
        profilePhotoIdentityMatchScore: score,
      },
      { merge: true },
    )

    await syncPublicProfilePhotoVerified(uid, match)

    if (match) {
      await claimProfilePhotoForUser(uid, photoHash)
      await redactVerifiedIdentityImages(uid)
    }

    return { status, score, threshold }
  } finally {
    secureClearBuffer(profileBytes)
    secureClearBuffer(selfieBytes)
  }
}
