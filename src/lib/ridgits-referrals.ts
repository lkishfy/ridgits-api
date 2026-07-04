import { randomBytes } from 'crypto'
import { FieldValue, Timestamp, type DocumentData } from 'firebase-admin/firestore'
import { getDb } from '@/lib/firebase-admin'
import { ApiError } from '@/lib/api-errors'
import { isDisposableEmail } from '@/lib/trust-safety/disposable-email'

export const RIDGITS_REFERRAL_CODE_PREFIX = 'RIDGITS-'
const REFERRAL_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export const RIDGITS_MAX_REFERRALS = 3
export const RIDGITS_REFERRAL_BONUS_PACKS = 1
export const RIDGITS_REFERRAL_PENDING_EXPIRY_DAYS = 14
export const RIDGITS_REFERRAL_REDEMPTION_WINDOW_HOURS = 24
export const RIDGITS_REFERRAL_MAX_REDEMPTIONS_PER_WINDOW = 3
export const RIDGITS_REFERRAL_BONUS_GRANT_COOLDOWN_HOURS = 24

/** Referral-exclusive quizzes granted in order — not sold via IAP. */
export const RIDGITS_REFERRAL_PACK_IDS = [
  'referral-first-spark',
  'referral-slow-burn',
  'referral-trust-line',
] as const

export const RIDGITS_REFERRAL_PACK_ID_SET = new Set<string>(RIDGITS_REFERRAL_PACK_IDS)

const REDEMPTION_WINDOW_MS = RIDGITS_REFERRAL_REDEMPTION_WINDOW_HOURS * 60 * 60 * 1000
const BONUS_GRANT_COOLDOWN_MS = RIDGITS_REFERRAL_BONUS_GRANT_COOLDOWN_HOURS * 60 * 60 * 1000
const PENDING_EXPIRY_MS = RIDGITS_REFERRAL_PENDING_EXPIRY_DAYS * 24 * 60 * 60 * 1000

type ReferralStatus = 'pending' | 'granted' | 'expired'

type ReferralDoc = {
  id: string
  referrerUid: string
  referredUid: string
  referralCode: string
  status: ReferralStatus
  createdAt: Timestamp
  grantedAt?: Timestamp | null
  grantedPackId?: string | null
  referredGrantedPackId?: string | null
}

export interface RidgitsReferralProfile {
  code: string
  shareMessage: string
  referralsCompleted: number
  maxReferrals: number
  bonusPacksPerFriend: number
  canEarnMoreReferrals: boolean
  hasRedeemedReferralCode: boolean
  redeemedReferralCode: string | null
  redeemedReferralStatus: ReferralStatus | null
}

function normalizeReferralCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '')
}

function generateReferralCodeCandidate(): string {
  let suffix = ''
  const bytes = randomBytes(6)
  for (let i = 0; i < 6; i += 1) {
    suffix += REFERRAL_CODE_ALPHABET[bytes[i]! % REFERRAL_CODE_ALPHABET.length]
  }
  return `${RIDGITS_REFERRAL_CODE_PREFIX}${suffix}`
}

function referralPendingExpired(createdAt: Timestamp | Date | string): boolean {
  const createdMs =
    createdAt instanceof Timestamp
      ? createdAt.toMillis()
      : createdAt instanceof Date
        ? createdAt.getTime()
        : Date.parse(String(createdAt))
  if (Number.isNaN(createdMs)) return false
  return Date.now() - createdMs > PENDING_EXPIRY_MS
}

function effectiveReferralStatus(
  status: string,
  createdAt: Timestamp | Date | string,
): ReferralStatus {
  if (status === 'granted') return 'granted'
  if (status === 'expired') return 'expired'
  if (referralPendingExpired(createdAt)) return 'expired'
  return 'pending'
}

export function buildReferralShareMessage(code: string): string {
  return `Join me on Ridgits — use my code ${code} when you sign up. Finish your personality quiz within ${RIDGITS_REFERRAL_PENDING_EXPIRY_DAYS} days and you'll both unlock a free special quiz. https://ridgits.com/invite?ref=${encodeURIComponent(code)}`
}

async function ensureReferralCodeForUser(uid: string): Promise<string> {
  const db = getDb()
  const userRef = db.collection('users').doc(uid)
  const userSnap = await userRef.get()

  const existing = userSnap.data()?.referralCode
  if (typeof existing === 'string' && existing.trim()) {
    return normalizeReferralCode(existing)
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = generateReferralCodeCandidate()
    const codeRef = db.collection('referralCodes').doc(code)

    try {
      await db.runTransaction(async (tx) => {
        const codeSnap = await tx.get(codeRef)
        if (codeSnap.exists) {
          throw new Error('collision')
        }
        tx.set(codeRef, { uid, code, createdAt: FieldValue.serverTimestamp() })
        tx.set(userRef, { referralCode: code }, { merge: true })
      })
      return code
    } catch (error) {
      if (error instanceof Error && error.message === 'collision') continue
      throw error
    }
  }

  throw new ApiError('Could not generate referral code', 500, 'referral_code_create_failed')
}

async function listReferrerReferrals(referrerUid: string): Promise<
  Array<{ status: string; createdAt: Timestamp; grantedAt?: Timestamp | null }>
> {
  const db = getDb()
  const snap = await db.collection('referrals').where('referrerUid', '==', referrerUid).get()
  return snap.docs.map((doc) => {
    const data = doc.data()
    return {
      status: String(data.status ?? ''),
      createdAt: (data.createdAt as Timestamp | undefined) ?? Timestamp.now(),
      grantedAt: (data.grantedAt as Timestamp | null | undefined) ?? null,
    }
  })
}

async function countReferrerRedemptionsInWindow(referrerUid: string): Promise<number> {
  const sinceMs = Date.now() - REDEMPTION_WINDOW_MS
  const rows = await listReferrerReferrals(referrerUid)
  return rows.filter((row) => {
    if (row.status === 'expired') return false
    return row.createdAt.toMillis() >= sinceMs
  }).length
}

async function countReferrerGrantedBonuses(referrerUid: string): Promise<number> {
  const rows = await listReferrerReferrals(referrerUid)
  return rows.filter((row) => row.status === 'granted').length
}

async function referrerBonusGrantedRecently(referrerUid: string): Promise<boolean> {
  const sinceMs = Date.now() - BONUS_GRANT_COOLDOWN_MS
  const rows = await listReferrerReferrals(referrerUid)
  return rows.some((row) => {
    if (row.status !== 'granted' || !row.grantedAt) return false
    return row.grantedAt.toMillis() >= sinceMs
  })
}

async function markReferralExpired(referralId: string): Promise<void> {
  const db = getDb()
  await db.collection('referrals').doc(referralId).update({ status: 'expired' })
}

async function getReferredUserRedemption(referredUid: string): Promise<{
  referralCode: string
  status: ReferralStatus
} | null> {
  const db = getDb()
  const snap = await db
    .collection('referrals')
    .where('referredUid', '==', referredUid)
    .limit(1)
    .get()

  if (snap.empty) return null
  const doc = snap.docs[0]!
  const data = doc.data()
  const createdAt = data.createdAt ?? Timestamp.now()
  const rawStatus = String(data.status ?? 'pending')
  const hasReferredBonus =
    typeof data.referredGrantedPackId === 'string' && data.referredGrantedPackId.trim().length > 0
  const status =
    rawStatus === 'granted' || hasReferredBonus
      ? 'granted'
      : effectiveReferralStatus(rawStatus, createdAt)
  return {
    referralCode: String(data.referralCode ?? ''),
    status,
  }
}

async function resolveReferrerUidForCode(normalizedCode: string): Promise<string> {
  const db = getDb()
  const codeSnap = await db.collection('referralCodes').doc(normalizedCode).get()
  if (!codeSnap.exists) {
    throw new ApiError('Referral code not found', 400, 'referral_code_not_found')
  }
  const uid = codeSnap.data()?.uid
  if (typeof uid !== 'string' || !uid.trim()) {
    throw new ApiError('Referral code not found', 400, 'referral_code_not_found')
  }
  return uid
}

async function assertReferrerCanAcceptRedemption(referrerUid: string, referredUid: string): Promise<void> {
  if (referrerUid === referredUid) {
    throw new ApiError('You cannot use your own referral code', 400, 'self_referral_not_allowed')
  }

  const grantedBonuses = await countReferrerGrantedBonuses(referrerUid)
  if (grantedBonuses >= RIDGITS_MAX_REFERRALS) {
    throw new ApiError(
      'This referral code has reached its maximum bonuses',
      400,
      'referrer_bonus_cap_reached',
    )
  }

  const recentRedemptions = await countReferrerRedemptionsInWindow(referrerUid)
  if (recentRedemptions >= RIDGITS_REFERRAL_MAX_REDEMPTIONS_PER_WINDOW) {
    throw new ApiError(
      'This referral code cannot accept new signups right now. Try again later.',
      429,
      'referrer_rate_limited',
    )
  }
}

function userHasPackAccess(
  userData: DocumentData | undefined,
  packId: string,
): boolean {
  if (!userData) return false
  if (RIDGITS_REFERRAL_PACK_ID_SET.has(packId)) {
    const unlocked = Array.isArray(userData.unlockedPacks) ? userData.unlockedPacks : []
    return unlocked.includes(packId)
  }
  const tier = String(userData.subscriptionTier ?? 'free')
  if (tier === 'premium' || tier === 'ultra') return true
  const unlocked = Array.isArray(userData.unlockedPacks) ? userData.unlockedPacks : []
  const purchased = Array.isArray(userData.purchasedPacks) ? userData.purchasedPacks : []
  return unlocked.includes(packId) || purchased.includes(packId)
}

function pickReferralBonusPack(userData: DocumentData | undefined): string | null {
  for (const packId of RIDGITS_REFERRAL_PACK_IDS) {
    if (!userHasPackAccess(userData, packId)) return packId
  }
  return null
}

async function referredUserMeetsQualification(referredUid: string): Promise<boolean> {
  const db = getDb()
  const userSnap = await db.collection('users').doc(referredUid).get()
  const data = userSnap.data()
  if (!data) return false
  return data.onboardingCompleted === true || data.quizCompletedAt != null
}

async function grantReferralBonuses(referral: ReferralDoc): Promise<{
  referrerPackId: string | null
  referredPackId: string | null
}> {
  const db = getDb()
  const referralRef = db.collection('referrals').doc(referral.id)
  const referrerRef = db.collection('users').doc(referral.referrerUid)
  const referredRef = db.collection('users').doc(referral.referredUid)

  const existingSnap = await referralRef.get()
  if (!existingSnap.exists) {
    return { referrerPackId: null, referredPackId: null }
  }

  const existing = existingSnap.data() ?? {}
  const existingStatus = String(existing.status ?? 'pending')
  const existingReferrerPackId =
    typeof existing.grantedPackId === 'string' ? existing.grantedPackId : null
  const existingReferredPackId =
    typeof existing.referredGrantedPackId === 'string' ? existing.referredGrantedPackId : null

  if (existingStatus === 'granted') {
    return {
      referrerPackId: existingReferrerPackId,
      referredPackId: existingReferredPackId,
    }
  }
  if (existingStatus === 'expired') {
    return { referrerPackId: null, referredPackId: null }
  }

  const referredSnap = await referredRef.get()
  const referredPackId =
    existingReferredPackId ?? pickReferralBonusPack(referredSnap.data())

  let referrerPackId: string | null = existingReferrerPackId
  let referrerBlockedByCooldown = false
  if (!referrerPackId) {
    const grantedCount = await countReferrerGrantedBonuses(referral.referrerUid)
    if (grantedCount >= RIDGITS_MAX_REFERRALS) {
      referrerPackId = null
    } else if (await referrerBonusGrantedRecently(referral.referrerUid)) {
      referrerBlockedByCooldown = true
      referrerPackId = null
    } else {
      const referrerSnap = await referrerRef.get()
      referrerPackId = pickReferralBonusPack(referrerSnap.data())
    }
  }

  if (!referredPackId && !referrerPackId && !existingReferredPackId && !existingReferrerPackId) {
    if (!referrerBlockedByCooldown) {
      await markReferralExpired(referral.id)
    }
    return { referrerPackId: null, referredPackId: null }
  }

  const nextReferrerPackId = referrerPackId
  const nextReferredPackId = referredPackId
  const shouldMarkGranted =
    Boolean(nextReferredPackId || existingReferredPackId) &&
    Boolean(nextReferrerPackId || existingReferrerPackId || !referrerBlockedByCooldown)

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(referralRef)
    if (!snap.exists) {
      return { referrerPackId: null as string | null, referredPackId: null as string | null }
    }

    const data = snap.data() ?? {}
    const status = String(data.status ?? 'pending')
    if (status === 'granted') {
      return {
        referrerPackId:
          typeof data.grantedPackId === 'string' ? data.grantedPackId : null,
        referredPackId:
          typeof data.referredGrantedPackId === 'string' ? data.referredGrantedPackId : null,
      }
    }
    if (status === 'expired') {
      return { referrerPackId: null, referredPackId: null }
    }

    const updates: Record<string, unknown> = {}

    if (nextReferrerPackId) {
      updates.grantedPackId = nextReferrerPackId
      updates.bonusGranted = RIDGITS_REFERRAL_BONUS_PACKS
      tx.set(
        referrerRef,
        {
          unlockedPacks: FieldValue.arrayUnion(nextReferrerPackId),
          referralsCompleted: FieldValue.increment(1),
        },
        { merge: true },
      )
    }

    if (nextReferredPackId && !data.referredGrantedPackId) {
      updates.referredGrantedPackId = nextReferredPackId
      tx.set(
        referredRef,
        {
          unlockedPacks: FieldValue.arrayUnion(nextReferredPackId),
        },
        { merge: true },
      )
    }

    if (shouldMarkGranted) {
      updates.status = 'granted'
      updates.grantedAt = FieldValue.serverTimestamp()
    }

    if (Object.keys(updates).length > 0) {
      tx.update(referralRef, updates)
    }

    return {
      referrerPackId: nextReferrerPackId ?? existingReferrerPackId,
      referredPackId: nextReferredPackId ?? existingReferredPackId,
    }
  })

  return result
}

export async function maybeGrantRidgitsReferralBonusForReferredUser(
  referredUid: string,
): Promise<{
  granted: boolean
  grantedPackId: string | null
  referrerGrantedPackId: string | null
}> {
  const db = getDb()
  const snap = await db
    .collection('referrals')
    .where('referredUid', '==', referredUid)
    .limit(1)
    .get()

  if (snap.empty) {
    return { granted: false, grantedPackId: null, referrerGrantedPackId: null }
  }

  const doc = snap.docs[0]!
  const data = doc.data()
  const status = String(data.status ?? '')
  const existingReferredPackId =
    typeof data.referredGrantedPackId === 'string' ? data.referredGrantedPackId : null
  const existingReferrerPackId =
    typeof data.grantedPackId === 'string' ? data.grantedPackId : null

  if (status === 'granted') {
    return {
      granted: existingReferredPackId != null,
      grantedPackId: existingReferredPackId,
      referrerGrantedPackId: existingReferrerPackId,
    }
  }
  if (status === 'expired') {
    return { granted: false, grantedPackId: null, referrerGrantedPackId: null }
  }

  const createdAt = data.createdAt ?? Timestamp.now()
  if (referralPendingExpired(createdAt)) {
    await markReferralExpired(doc.id)
    return { granted: false, grantedPackId: null, referrerGrantedPackId: null }
  }

  if (!(await referredUserMeetsQualification(referredUid))) {
    return { granted: false, grantedPackId: null, referrerGrantedPackId: null }
  }

  const referral: ReferralDoc = {
    id: doc.id,
    referrerUid: String(data.referrerUid),
    referredUid: String(data.referredUid),
    referralCode: String(data.referralCode),
    status: 'pending',
    createdAt,
    referredGrantedPackId: existingReferredPackId,
    grantedPackId: existingReferrerPackId,
  }

  const { referrerPackId, referredPackId } = await grantReferralBonuses(referral)
  return {
    granted: referredPackId != null,
    grantedPackId: referredPackId,
    referrerGrantedPackId: referrerPackId,
  }
}

export async function getRidgitsReferralProfile(input: {
  uid: string
  email?: string | null
}): Promise<RidgitsReferralProfile> {
  const code = await ensureReferralCodeForUser(input.uid)
  const referralsCompleted = await countReferrerGrantedBonuses(input.uid)
  const referredRedemption = await getReferredUserRedemption(input.uid)

  return {
    code,
    shareMessage: buildReferralShareMessage(code),
    referralsCompleted,
    maxReferrals: RIDGITS_MAX_REFERRALS,
    bonusPacksPerFriend: RIDGITS_REFERRAL_BONUS_PACKS,
    canEarnMoreReferrals: referralsCompleted < RIDGITS_MAX_REFERRALS,
    hasRedeemedReferralCode:
      referredRedemption != null &&
      (referredRedemption.status === 'pending' || referredRedemption.status === 'granted'),
    redeemedReferralCode: referredRedemption?.referralCode ?? null,
    redeemedReferralStatus: referredRedemption?.status ?? null,
  }
}

export async function redeemRidgitsReferralCode(input: {
  referredUid: string
  referredEmail?: string | null
  referralCode: string
  source?: string
}): Promise<{
  redeemed: boolean
  alreadyRedeemed: boolean
  referrerUid?: string
  grantedPackId: string | null
  bonusPending: boolean
}> {
  const referredEmail = input.referredEmail?.trim()
  if (!referredEmail) {
    throw new ApiError('Email is required to redeem a referral code', 400, 'email_required')
  }

  if (isDisposableEmail(referredEmail)) {
    throw new ApiError(
      'Disposable email addresses cannot redeem referral codes',
      400,
      'disposable_email_not_allowed',
    )
  }

  const normalizedCode = normalizeReferralCode(input.referralCode)
  if (
    !normalizedCode.startsWith(RIDGITS_REFERRAL_CODE_PREFIX) ||
    normalizedCode.length < RIDGITS_REFERRAL_CODE_PREFIX.length + 4
  ) {
    throw new ApiError('Invalid referral code', 400, 'invalid_referral_code')
  }

  const db = getDb()
  const existingSnap = await db
    .collection('referrals')
    .where('referredUid', '==', input.referredUid)
    .limit(1)
    .get()

  let reactivateReferralId: string | null = null

  if (!existingSnap.empty) {
    const existing = existingSnap.docs[0]!
    const data = existing.data()
    const createdAt = data.createdAt ?? Timestamp.now()
    const status = effectiveReferralStatus(String(data.status ?? 'pending'), createdAt)
    const existingCode = normalizeReferralCode(String(data.referralCode ?? ''))

    if (status === 'granted') {
      const referredGrantedPackId =
        typeof data.referredGrantedPackId === 'string' ? data.referredGrantedPackId : null
      return {
        redeemed: false,
        alreadyRedeemed: true,
        referrerUid: typeof data.referrerUid === 'string' ? data.referrerUid : undefined,
        grantedPackId: referredGrantedPackId,
        bonusPending: false,
      }
    }

    if (status === 'pending') {
      if (existingCode && existingCode !== normalizedCode) {
        throw new ApiError(
          'You can only redeem one referral code per account',
          400,
          'referral_already_redeemed',
        )
      }

      return {
        redeemed: false,
        alreadyRedeemed: true,
        referrerUid: typeof data.referrerUid === 'string' ? data.referrerUid : undefined,
        grantedPackId: null,
        bonusPending: true,
      }
    }

    reactivateReferralId = existing.id
  }

  const referrerUid = await resolveReferrerUidForCode(normalizedCode)
  await assertReferrerCanAcceptRedemption(referrerUid, input.referredUid)

  if (reactivateReferralId) {
    await db.collection('referrals').doc(reactivateReferralId).update({
      referrerUid,
      referredUid: input.referredUid,
      referredEmail,
      referralCode: normalizedCode,
      redeemSource: input.source ?? null,
      status: 'pending',
      grantedAt: null,
      grantedPackId: null,
      referredGrantedPackId: null,
      bonusGranted: 0,
      createdAt: FieldValue.serverTimestamp(),
    })
  } else {
    await db.collection('referrals').add({
      referrerUid,
      referredUid: input.referredUid,
      referredEmail,
      referralCode: normalizedCode,
      redeemSource: input.source ?? null,
      status: 'pending',
      bonusGranted: 0,
      createdAt: FieldValue.serverTimestamp(),
    })
  }

  await db.collection('users').doc(input.referredUid).set(
    {
      referredByUid: referrerUid,
      redeemedReferralCode: normalizedCode,
      referralRedeemSource: input.source ?? null,
    },
    { merge: true },
  )

  const qualification = await maybeGrantRidgitsReferralBonusForReferredUser(input.referredUid)

  return {
    redeemed: true,
    alreadyRedeemed: false,
    referrerUid,
    grantedPackId: qualification.grantedPackId,
    bonusPending: !qualification.granted,
  }
}
