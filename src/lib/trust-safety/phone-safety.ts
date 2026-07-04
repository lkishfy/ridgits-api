import { createHash } from 'node:crypto'
import { FieldValue } from 'firebase-admin/firestore'
import { ApiError } from '@/lib/api-errors'
import { getDb } from '@/lib/firebase-admin'

/**
 * Phone verification is not fully wired yet (no Twilio/Firebase Phone Auth flow in the
 * app today). These helpers establish the structure so that when phone verification is
 * added, VOIP blocking + one-account-per-phone can be enforced immediately:
 *
 *  1. Call `lookupPhoneIntelligence(phone)` right after the user enters a phone number,
 *     before sending an OTP. Reject/flag VOIP or landline numbers per product policy.
 *  2. Call `assertPhoneNotAlreadyClaimed` + `claimPhoneForUser` once the OTP is verified,
 *     so a phone number can only ever be linked to one account.
 *
 * VOIP detection uses Twilio Lookup v2 `line_type_intelligence` when
 * `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` are configured; otherwise it no-ops so this
 * module is safe to import even before Twilio is provisioned.
 */

const PHONE_HASH_SALT = process.env.RIDGITS_PHONE_HASH_SALT ?? 'ridgits-phone-salt-v1'

export function hashPhoneNumber(e164Phone: string): string {
  const normalized = e164Phone.trim().replace(/[^\d+]/g, '')
  return createHash('sha256').update(`${PHONE_HASH_SALT}:${normalized}`).digest('hex')
}

export interface PhoneLineIntelligence {
  type: 'mobile' | 'landline' | 'voip' | 'unknown'
  isVoip: boolean
  carrierName?: string
}

/** Twilio Lookup v2 line-type check. No-ops (returns `unknown`) when Twilio isn't configured. */
export async function lookupPhoneIntelligence(e164Phone: string): Promise<PhoneLineIntelligence> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID
  const authToken = process.env.TWILIO_AUTH_TOKEN
  if (!accountSid || !authToken) {
    return { type: 'unknown', isVoip: false }
  }

  try {
    const url = `https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(e164Phone)}?Fields=line_type_intelligence`
    const response = await fetch(url, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
      },
      signal: AbortSignal.timeout(6000),
    })
    if (!response.ok) return { type: 'unknown', isVoip: false }

    const data = (await response.json()) as {
      line_type_intelligence?: { type?: string; carrier_name?: string }
    }
    const type = (data.line_type_intelligence?.type ?? 'unknown').toLowerCase()
    return {
      type: type === 'mobile' || type === 'landline' || type === 'voip' ? (type as 'mobile' | 'landline' | 'voip') : 'unknown',
      isVoip: type === 'voip' || type === 'personalVoip' || type === 'nontixedVoip',
      carrierName: data.line_type_intelligence?.carrier_name,
    }
  } catch (error) {
    console.warn('[trust-safety] Twilio Lookup failed', error)
    return { type: 'unknown', isVoip: false }
  }
}

export function normalizeE164Phone(raw: string): string {
  const trimmed = raw.trim()
  const digits = trimmed.replace(/[^\d+]/g, '')
  if (digits.startsWith('+')) return digits
  const onlyDigits = digits.replace(/\D/g, '')
  if (onlyDigits.length === 10) return `+1${onlyDigits}`
  if (onlyDigits.length === 11 && onlyDigits.startsWith('1')) return `+${onlyDigits}`
  return trimmed.startsWith('+') ? trimmed : `+${onlyDigits}`
}

/** Throws-free check — returns the uid already holding this phone number, if any. */
export async function findExistingPhoneOwner(e164Phone: string): Promise<string | null> {
  const hash = hashPhoneNumber(e164Phone)
  const snap = await getDb().collection('phoneHashes').doc(hash).get()
  if (!snap.exists) return null
  const uid = snap.data()?.uid
  return typeof uid === 'string' ? uid : null
}

export async function assertPhoneNotAlreadyClaimed(e164Phone: string, uid: string): Promise<void> {
  const existing = await findExistingPhoneOwner(e164Phone)
  if (existing && existing !== uid) {
    throw new ApiError(
      'This phone number is already linked to another Ridgits account.',
      409,
      'PHONE_ALREADY_CLAIMED',
    )
  }
}

/** Claims a phone number for a user, storing only the hash (never the raw number). */
export async function claimPhoneForUser(uid: string, e164Phone: string): Promise<void> {
  const hash = hashPhoneNumber(e164Phone)
  const db = getDb()
  await db.collection('phoneHashes').doc(hash).set(
    { uid, claimedAt: FieldValue.serverTimestamp() },
    { merge: true },
  )
  await db.collection('users').doc(uid).set({ phoneHash: hash }, { merge: true })
}

const MULTI_ACCOUNT_DEVICE_THRESHOLD = Number(process.env.RIDGITS_DEVICE_MULTI_ACCOUNT_THRESHOLD ?? 3)

/**
 * Records that `deviceId` was used to register push notifications for `uid`, and flags
 * the account when the same device fingerprint has been used to register an unusually
 * high number of distinct accounts (a common signal for ban-evasion / fake-account farms).
 */
export async function recordDeviceFingerprint(uid: string, deviceId: string): Promise<{ flagged: boolean; uidCount: number }> {
  const db = getDb()
  const ref = db.collection('deviceFingerprints').doc(deviceId)

  const uidCount = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    const existingUids: string[] = snap.exists && Array.isArray(snap.data()?.uids) ? snap.data()!.uids : []
    const uids = existingUids.includes(uid) ? existingUids : [...existingUids, uid]
    tx.set(
      ref,
      {
        uids,
        uidCount: uids.length,
        lastSeenAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    )
    return uids.length
  })

  const flagged = uidCount >= MULTI_ACCOUNT_DEVICE_THRESHOLD
  if (flagged) {
    await db.collection('users').doc(uid).set(
      {
        trustSafetyFlags: FieldValue.arrayUnion('multi_account_device'),
      },
      { merge: true },
    )
    await db.collection('trustSafetyFlags').add({
      uid,
      deviceId,
      type: 'multi_account_device',
      uidCount,
      createdAt: FieldValue.serverTimestamp(),
    })
  }

  return { flagged, uidCount }
}
