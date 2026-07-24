import { ApiError } from '@/lib/api-errors'
import { getAuthInstance } from '@/lib/firebase-admin'
import { isRidgitsBypassEmail } from '@/lib/ridgits-bypass'

/**
 * Authoritative verified-email check backed by Firebase Admin Auth (not client-supplied
 * Firestore fields, which a device could spoof). Google/Apple sign-in already sets
 * `emailVerified = true` on the Auth record, so this naturally passes OAuth users.
 * App Review / QA addresses in `RIDGITS_BYPASS_EMAILS` are treated as verified.
 */
export async function isEmailVerified(uid: string): Promise<boolean> {
  try {
    const user = await getAuthInstance().getUser(uid)
    if (isRidgitsBypassEmail(user.email)) return true
    return user.emailVerified === true
  } catch {
    return false
  }
}

/** Batched lookup for filtering lists of candidate profiles (e.g. nearby matches). */
export async function getVerifiedEmailMap(uids: string[]): Promise<Map<string, boolean>> {
  const map = new Map<string, boolean>()
  const unique = [...new Set(uids)].filter(Boolean)
  if (!unique.length) return map

  const auth = getAuthInstance()
  const chunkSize = 100
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize)
    try {
      const result = await auth.getUsers(chunk.map((uid) => ({ uid })))
      for (const user of result.users) {
        map.set(
          user.uid,
          isRidgitsBypassEmail(user.email) || user.emailVerified === true,
        )
      }
      for (const notFound of result.notFound) {
        if (notFound && typeof notFound === 'object' && 'uid' in notFound) {
          map.set(String((notFound as { uid: string }).uid), false)
        }
      }
    } catch {
      for (const uid of chunk) map.set(uid, false)
    }
  }
  return map
}

export async function requireVerifiedEmail(uid: string): Promise<void> {
  const verified = await isEmailVerified(uid)
  if (!verified) {
    throw new ApiError(
      'Please verify your email address before doing this. Check your inbox for the verification link, or resend it from Settings.',
      403,
      'EMAIL_NOT_VERIFIED',
    )
  }
}
