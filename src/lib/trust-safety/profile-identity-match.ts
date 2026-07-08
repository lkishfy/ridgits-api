import { FieldValue } from 'firebase-admin/firestore'
import { ApiError } from '@/lib/api-errors'
import { getDb } from '@/lib/firebase-admin'
import {
  getStripe,
  getStripeIdentityRestricted,
  isStripeConfigured,
  isStripeIdentityRestrictedConfigured,
} from '@/lib/stripe-client'
import {
  compareFacesWithRekognition,
  downloadImageBytes,
  isRekognitionConfigured,
  secureClearBuffer,
} from '@/lib/trust-safety/rekognition-face-compare'
import { validateProfilePhotoUrl, hashProfilePhotoFromUrl, assertProfilePhotoNotAlreadyClaimed, claimProfilePhotoForUser } from '@/lib/trust-safety/profile-photo'

const DEFAULT_MATCH_THRESHOLD = 0.9

/** True until the user passes their one-time profile photo ↔ ID selfie face match. */
export function requiresProfilePhotoFaceMatch(userData?: Record<string, unknown> | null): boolean {
  return String(userData?.profilePhotoIdentityMatchStatus ?? '') !== 'verified'
}

function matchThreshold(): number {
  const raw = process.env.RIDGITS_IDENTITY_FACE_MATCH_THRESHOLD?.trim()
  const parsed = raw ? Number(raw) : DEFAULT_MATCH_THRESHOLD
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : DEFAULT_MATCH_THRESHOLD
}

function isStripeSensitiveVerificationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return message.includes('sensitive verification results')
    || message.includes('restricted API key')
}

function throwIdentitySelfieAccessError(error?: unknown): never {
  if (error && isStripeSensitiveVerificationError(error)) {
    console.error('[profile-identity-match] Stripe restricted key required for selfie access', error)
  }
  throw new ApiError(
    'Profile photo verification is temporarily unavailable. Try again in a few minutes.',
    503,
    'IDENTITY_SELFIE_UNAVAILABLE',
  )
}

async function createTemporarySelfieUrl(selfieFileId: string): Promise<string> {
  if (!isStripeIdentityRestrictedConfigured()) {
    throwIdentitySelfieAccessError()
  }

  const stripe = getStripeIdentityRestricted()
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

  if (!isStripeIdentityRestrictedConfigured()) {
    throwIdentitySelfieAccessError()
  }

  const stripe = getStripeIdentityRestricted()
  let session: Awaited<ReturnType<typeof stripe.identity.verificationSessions.retrieve>>
  try {
    session = await stripe.identity.verificationSessions.retrieve(sessionId, {
      expand: ['last_verification_report'],
    })
  } catch (error) {
    if (isStripeSensitiveVerificationError(error)) {
      throwIdentitySelfieAccessError(error)
    }
    throw error
  }

  if (session.status !== 'verified') {
    throw new ApiError('Identity verification is not complete.', 412, 'IDENTITY_VERIFICATION_REQUIRED')
  }

  let report = session.last_verification_report
  if (typeof report === 'string' && report.trim()) {
    try {
      report = await stripe.identity.verificationReports.retrieve(report.trim())
    } catch (error) {
      if (isStripeSensitiveVerificationError(error)) {
        throwIdentitySelfieAccessError(error)
      }
      throw error
    }
  }

  const selfieFileId =
    report && typeof report === 'object' && 'selfie' in report
      ? (report as { selfie?: { selfie?: string | null } }).selfie?.selfie
      : null
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
    const stripe = isStripeIdentityRestrictedConfigured()
      ? getStripeIdentityRestricted()
      : getStripe()
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
  message?: string
  reason?: ProfilePhotoMatchFailureReason
  skippedFaceMatch?: boolean
}

export type ProfilePhotoMatchFailureReason =
  | 'LOW_SIMILARITY'
  | 'NO_MATCH'
  | 'NO_FACE_IN_PROFILE_PHOTO'
  | 'NO_FACE_IN_ID_SELFIE'
  | 'IMAGE_TOO_LARGE'
  | 'DOWNLOAD_FAILED'
  | 'UNAVAILABLE'

function formatPercent(value: number): number {
  return Math.round(value * 100)
}

export function buildFailedProfilePhotoMatchMessage(
  score: number | null,
  threshold: number,
  reason?: ProfilePhotoMatchFailureReason,
): string {
  const thresholdPct = formatPercent(threshold)

  switch (reason) {
    case 'NO_FACE_IN_PROFILE_PHOTO':
      return 'We could not detect a face in your profile photo. Use a clear, front-facing photo with only your face visible.'
    case 'NO_FACE_IN_ID_SELFIE':
      return 'We could not access a clear face from your verified ID selfie. Complete identity verification again, then retry.'
    case 'IMAGE_TOO_LARGE':
      return 'Your profile photo is too large to verify. Choose a smaller image under 5 MB.'
    case 'DOWNLOAD_FAILED':
      return 'We could not download your profile photo for verification. Save your profile and try again.'
    case 'UNAVAILABLE':
      return 'Profile photo verification is temporarily unavailable. Try again in a few minutes.'
    case 'LOW_SIMILARITY': {
      const scorePct = score == null ? null : formatPercent(score)
      if (scorePct != null && scorePct > 0) {
        return `Your profile photo only matched your ID selfie at ${scorePct}% (we require at least ${thresholdPct}%). Use a clearer, front-facing photo similar to your verification selfie.`
      }
      break
    }
    default:
      break
  }

  const scorePct = score == null ? null : formatPercent(score)
  if (scorePct != null && scorePct > 0) {
    return `Your profile photo only matched your ID selfie at ${scorePct}% (we require at least ${thresholdPct}%). Use a clearer, front-facing photo similar to your verification selfie.`
  }

  return 'Your profile photo did not match your verified ID selfie. Use a clear photo of your face, similar to your ID verification selfie, then try again.'
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

/** After the one-time face match passes, later photo updates skip Rekognition. */
export async function approveProfilePhotoWithoutFaceMatch(uid: string): Promise<ProfileIdentityMatchResult> {
  const profileSnap = await getDb().collection('publicProfiles').doc(uid).get()
  const profileImage = String(profileSnap.get('image') ?? '').trim()

  const photoCheck = await validateProfilePhotoUrl(profileImage)
  if (!photoCheck.ok) {
    throw new ApiError(photoCheck.reason ?? 'A valid profile photo is required.', 412, 'INVALID_PROFILE_PHOTO')
  }

  const photoHash = await hashProfilePhotoFromUrl(profileImage)
  await assertProfilePhotoNotAlreadyClaimed(photoHash, uid)
  await claimProfilePhotoForUser(uid, photoHash)

  const threshold = matchThreshold()
  await getDb().collection('users').doc(uid).set(
    {
      profilePhotoIdentityMatchStatus: 'verified',
      profilePhotoIdentityMatchAt: FieldValue.serverTimestamp(),
      profilePhotoIdentityMatchScore: FieldValue.delete(),
    },
    { merge: true },
  )
  await syncPublicProfilePhotoVerified(uid, true)

  return {
    status: 'verified',
    score: null,
    threshold,
    skippedFaceMatch: true,
  }
}

export async function matchProfilePhotoToIdentity(uid: string): Promise<ProfileIdentityMatchResult> {
  const userSnap = await getDb().collection('users').doc(uid).get()
  const userData = userSnap.data() ?? {}
  if (!requiresProfilePhotoFaceMatch(userData)) {
    return approveProfilePhotoWithoutFaceMatch(uid)
  }

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
      downloadImageBytes(profileImage).catch(() => {
        throw new ApiError(
          'We could not download your profile photo for verification. Save your profile and try again.',
          412,
          'INVALID_PROFILE_PHOTO',
        )
      }),
      downloadImageBytes(selfieUrl).catch(() => {
        throw new ApiError(
          'We could not download your verified ID selfie for comparison. Try again in a few minutes.',
          502,
          'IDENTITY_SELFIE_UNAVAILABLE',
        )
      }),
    ])

    const threshold = matchThreshold()
    const { match, score, failureReason } = await compareFacesWithRekognition(
      profileBytes,
      selfieBytes,
      threshold,
    )
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
      return { status, score, threshold }
    }

    const reason = failureReason ?? (score > 0 ? 'LOW_SIMILARITY' : 'NO_MATCH')
    return {
      status,
      score,
      threshold,
      reason,
      message: buildFailedProfilePhotoMatchMessage(score, threshold, reason),
    }
  } finally {
    secureClearBuffer(profileBytes)
    secureClearBuffer(selfieBytes)
  }
}
