import { ApiError } from '@/lib/api-errors'
import { getDb } from '@/lib/firebase-admin'
import { resolveProfileLocation } from '@/lib/location/normalize'

export function isProfileCompleteForMatching(profile: Record<string, unknown>): boolean {
  const name = String(profile.name ?? '').trim()
  if (!name) return false

  const hasLocation =
    resolveProfileLocation(profile) != null || String(profile.location ?? '').trim().length > 0
  if (!hasLocation) return false

  const ageRaw = profile.age
  const age = ageRaw != null ? parseInt(String(ageRaw), 10) : NaN
  if (!Number.isFinite(age)) return false

  const image = String(profile.image ?? '').trim()
  if (!image) return false

  const about = String(profile.about ?? '').trim()
  if (!about) return false

  const interests = Array.isArray(profile.interests) ? profile.interests : []
  if (interests.length === 0) return false

  const aspirations = String(profile.aspirations ?? '').trim()
  if (!aspirations) return false

  return true
}

export async function assertProfileCompleteForPurchase(uid: string): Promise<void> {
  const db = getDb()
  const [userSnap, publicSnap] = await Promise.all([
    db.collection('users').doc(uid).get(),
    db.collection('publicProfiles').doc(uid).get(),
  ])
  const merged = { ...(userSnap.data() ?? {}), ...(publicSnap.data() ?? {}) }
  if (!isProfileCompleteForMatching(merged)) {
    throw new ApiError(
      'Complete your profile (photo, bio, interests, and location) before purchasing.',
      412,
      'PROFILE_INCOMPLETE',
    )
  }
}
