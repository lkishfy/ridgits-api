import { getAuthInstance } from '@/lib/firebase-admin'

/** Account emails manually approved for profile photo ↔ ID match (comma-separated, Vercel env). */
function parseManualPhotoVerifiedEmails(): Set<string> {
  const raw = process.env.RIDGITS_MANUAL_PHOTO_VERIFIED_EMAILS ?? ''
  return new Set(
    raw
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  )
}

/** Ops allowlist: skip automated face match after manual review in Stripe Dashboard. */
export function isManualProfilePhotoVerified(email: string | null | undefined): boolean {
  if (!email?.trim()) return false
  return parseManualPhotoVerifiedEmails().has(email.trim().toLowerCase())
}

async function lookupEmailForUid(uid: string): Promise<string | null> {
  try {
    const user = await getAuthInstance().getUser(uid)
    return typeof user.email === 'string' ? user.email : null
  } catch {
    return null
  }
}

/** Resolve email from auth context or Firebase Auth when only uid is available (e.g. webhooks). */
export async function isManualProfilePhotoVerifiedForUser(
  uid: string,
  email?: string | null,
): Promise<boolean> {
  const resolved = email?.trim() || (await lookupEmailForUid(uid))
  return isManualProfilePhotoVerified(resolved)
}
