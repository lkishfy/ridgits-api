import { createHash } from 'node:crypto'
import { FieldValue } from 'firebase-admin/firestore'
import { ApiError } from '@/lib/api-errors'
import { getDb } from '@/lib/firebase-admin'

const PROFILE_PHOTO_HASH_SALT =
  process.env.RIDGITS_PROFILE_PHOTO_HASH_SALT ?? 'ridgits-profile-photo-salt-v1'

export interface PhotoValidationResult {
  ok: boolean
  reason?: string
}

/**
 * Structural checks for a profile photo URL: must be present, must be a real HTTPS URL
 * (not a data: URI blob that never actually got uploaded), and optionally must resolve
 * (HEAD request) when `RIDGITS_PHOTO_HEAD_CHECK=true`. This does not inspect image
 * *content* — see `moderateProfilePhoto` for the NSFW/stock-photo hook.
 */
export async function validateProfilePhotoUrl(url: string | null | undefined): Promise<PhotoValidationResult> {
  const trimmed = (url ?? '').trim()
  if (!trimmed) return { ok: false, reason: 'A profile photo is required.' }
  if (trimmed.startsWith('data:')) {
    return { ok: false, reason: 'Profile photo must be uploaded, not an inline data URI.' }
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, reason: 'Profile photo URL is invalid.' }
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'Profile photo URL must use https.' }
  }

  if (process.env.RIDGITS_PHOTO_HEAD_CHECK === 'true') {
    try {
      const response = await fetch(parsed.toString(), { method: 'HEAD', signal: AbortSignal.timeout(4000) })
      if (!response.ok) {
        return { ok: false, reason: 'Profile photo URL could not be reached.' }
      }
      const contentType = response.headers.get('content-type') ?? ''
      if (contentType && !contentType.startsWith('image/')) {
        return { ok: false, reason: 'Profile photo URL does not point to an image.' }
      }
    } catch {
      // Network hiccups shouldn't hard-block profile saves; log and allow.
      console.warn('[trust-safety] profile photo HEAD check failed for', parsed.toString())
    }
  }

  return { ok: true }
}

export async function requireValidProfilePhoto(url: string | null | undefined): Promise<void> {
  const result = await validateProfilePhotoUrl(url)
  if (!result.ok) {
    throw new ApiError(result.reason ?? 'A valid profile photo is required.', 412, 'INVALID_PROFILE_PHOTO')
  }
}

export async function hashProfilePhotoFromUrl(url: string): Promise<string> {
  const trimmed = url.trim()
  const response = await fetch(trimmed, { signal: AbortSignal.timeout(12000) })
  if (!response.ok) {
    throw new ApiError('Profile photo could not be downloaded for verification.', 412, 'INVALID_PROFILE_PHOTO')
  }
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType && !contentType.startsWith('image/')) {
    throw new ApiError('Profile photo URL does not point to an image.', 412, 'INVALID_PROFILE_PHOTO')
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  return createHash('sha256').update(`${PROFILE_PHOTO_HASH_SALT}:${bytes}`).digest('hex')
}

export async function findExistingProfilePhotoOwner(photoHash: string): Promise<string | null> {
  const snap = await getDb().collection('profilePhotoHashes').doc(photoHash).get()
  if (!snap.exists) return null
  const uid = snap.data()?.uid
  return typeof uid === 'string' ? uid : null
}

export async function assertProfilePhotoNotAlreadyClaimed(photoHash: string, uid: string): Promise<void> {
  const existing = await findExistingProfilePhotoOwner(photoHash)
  if (existing && existing !== uid) {
    throw new ApiError(
      'This profile photo is already linked to another Ridgits account.',
      409,
      'PROFILE_PHOTO_ALREADY_CLAIMED',
    )
  }
}

export async function claimProfilePhotoForUser(uid: string, photoHash: string): Promise<void> {
  const db = getDb()
  await db.collection('profilePhotoHashes').doc(photoHash).set(
    { uid, claimedAt: FieldValue.serverTimestamp() },
    { merge: true },
  )
  await db.collection('users').doc(uid).set({ profilePhotoHash: photoHash }, { merge: true })
}

/** Validates URL, hashes image bytes, and claims the photo for this user. */
export async function registerProfilePhotoForUser(uid: string, imageUrl: string): Promise<void> {
  await requireValidProfilePhoto(imageUrl)
  const photoHash = await hashProfilePhotoFromUrl(imageUrl)
  await assertProfilePhotoNotAlreadyClaimed(photoHash, uid)
  await claimProfilePhotoForUser(uid, photoHash)
}

export interface ModerationResult {
  approved: boolean
  reason?: string
  provider: 'sightengine' | 'none'
}

/**
 * Placeholder NSFW/stock-photo moderation hook. Wire a real provider (Sightengine, AWS
 * Rekognition, Google Vision SafeSearch) by setting `RIDGITS_MODERATION_PROVIDER=sightengine`
 * plus `SIGHTENGINE_API_USER` / `SIGHTENGINE_API_SECRET`. When no provider is configured this
 * is a pass-through no-op so it's safe to call unconditionally from profile-save flows.
 */
export async function moderateProfilePhoto(url: string): Promise<ModerationResult> {
  const provider = process.env.RIDGITS_MODERATION_PROVIDER
  if (provider !== 'sightengine') {
    return { approved: true, provider: 'none' }
  }

  const apiUser = process.env.SIGHTENGINE_API_USER
  const apiSecret = process.env.SIGHTENGINE_API_SECRET
  if (!apiUser || !apiSecret) {
    console.warn('[trust-safety] RIDGITS_MODERATION_PROVIDER=sightengine but API credentials are missing')
    return { approved: true, provider: 'none' }
  }

  try {
    const params = new URLSearchParams({
      url,
      models: 'nudity-2.1,offensive,scam',
      api_user: apiUser,
      api_secret: apiSecret,
    })
    const response = await fetch(`https://api.sightengine.com/1.0/check.json?${params.toString()}`, {
      signal: AbortSignal.timeout(6000),
    })
    if (!response.ok) return { approved: true, provider: 'sightengine' }

    const data = (await response.json()) as {
      nudity?: { sexual_activity?: number; sexual_display?: number; erotica?: number }
      offensive?: { prob?: number }
    }
    const nudityScore = Math.max(
      data.nudity?.sexual_activity ?? 0,
      data.nudity?.sexual_display ?? 0,
      data.nudity?.erotica ?? 0,
    )
    const offensiveScore = data.offensive?.prob ?? 0

    if (nudityScore > 0.5 || offensiveScore > 0.5) {
      return { approved: false, reason: 'Profile photo did not pass content moderation.', provider: 'sightengine' }
    }
    return { approved: true, provider: 'sightengine' }
  } catch (error) {
    console.warn('[trust-safety] moderation provider call failed', error)
    return { approved: true, provider: 'sightengine' }
  }
}
