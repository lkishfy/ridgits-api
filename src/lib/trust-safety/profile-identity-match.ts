import { FieldValue } from 'firebase-admin/firestore'
import { ApiError } from '@/lib/api-errors'
import { getDb } from '@/lib/firebase-admin'
import { getStripe, isStripeConfigured } from '@/lib/stripe-client'
import { validateProfilePhotoUrl } from '@/lib/trust-safety/profile-photo'

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
    expires_at: Math.floor(Date.now() / 1000) + 3600,
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

async function compareFacesWithSightengine(
  profilePhotoUrl: string,
  selfieUrl: string,
): Promise<{ match: boolean; score: number }> {
  const apiUser = process.env.SIGHTENGINE_API_USER?.trim()
  const apiSecret = process.env.SIGHTENGINE_API_SECRET?.trim()
  if (!apiUser || !apiSecret) {
    throw new ApiError('Face match is not configured.', 503, 'FACE_MATCH_UNAVAILABLE')
  }

  const params = new URLSearchParams({
    url: profilePhotoUrl,
    url2: selfieUrl,
    models: 'face-compare',
    api_user: apiUser,
    api_secret: apiSecret,
  })

  const response = await fetch(`https://api.sightengine.com/1.0/check.json?${params.toString()}`, {
    signal: AbortSignal.timeout(15000),
  })

  if (!response.ok) {
    throw new ApiError('Face comparison failed.', 502, 'FACE_MATCH_FAILED')
  }

  const data = (await response.json()) as {
    status?: string
    face?: { similarity?: number }
    similarity?: number
    error?: { message?: string }
  }

  if (data.status === 'failure') {
    throw new ApiError(data.error?.message ?? 'Face comparison could not be completed.', 412, 'FACE_MATCH_FAILED')
  }

  const score = data.face?.similarity ?? data.similarity ?? 0
  const threshold = matchThreshold()
  return { match: score >= threshold, score }
}

export interface ProfileIdentityMatchResult {
  status: 'verified' | 'failed'
  score: number | null
  threshold: number
}

export async function matchProfilePhotoToIdentity(uid: string): Promise<ProfileIdentityMatchResult> {
  const profileSnap = await getDb().collection('publicProfiles').doc(uid).get()
  const profileImage = String(profileSnap.get('image') ?? '').trim()

  const photoCheck = await validateProfilePhotoUrl(profileImage)
  if (!photoCheck.ok) {
    throw new ApiError(photoCheck.reason ?? 'A valid profile photo is required.', 412, 'INVALID_PROFILE_PHOTO')
  }

  await getDb().collection('users').doc(uid).set(
    { profilePhotoIdentityMatchStatus: 'pending' },
    { merge: true },
  )

  const selfieFileId = await resolveVerifiedSelfieFileId(uid)
  const selfieUrl = await createTemporarySelfieUrl(selfieFileId)

  const { match, score } = await compareFacesWithSightengine(profileImage, selfieUrl)
  const threshold = matchThreshold()
  const status = match ? 'verified' : 'failed'

  await getDb().collection('users').doc(uid).set(
    {
      profilePhotoIdentityMatchStatus: status,
      profilePhotoIdentityMatchAt: FieldValue.serverTimestamp(),
      profilePhotoIdentityMatchScore: score,
    },
    { merge: true },
  )

  return { status, score, threshold }
}
