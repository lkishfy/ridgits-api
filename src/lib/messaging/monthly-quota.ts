import { FieldValue, type Transaction } from 'firebase-admin/firestore'
import { ApiError } from '@/lib/api-errors'
import { getDb } from '@/lib/firebase-admin'
import { effectiveSubscriptionTier } from '@/lib/subscription-badge'

/** Monthly outbound message caps by membership tier (UTC calendar month, no rollover). */
export const MONTHLY_MESSAGE_LIMITS = {
  plus: 48,
  premium: 128,
  ultra: null,
} as const

export type MonthlyMessageQuota = {
  periodKey: string
  sentCount: number
  limit: number | null
  remaining: number | null
  unlimited: boolean
  resetsAt: string
  tier: string
}

export function currentMessageUsagePeriodKey(now = new Date()): string {
  const year = now.getUTCFullYear()
  const month = String(now.getUTCMonth() + 1).padStart(2, '0')
  return `${year}-${month}`
}

export function nextMessageUsagePeriodStartISO(now = new Date()): string {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0))
  return next.toISOString()
}

export function monthlyMessageLimitForTier(tier: string): number | null {
  const normalized = String(tier ?? 'free').trim().toLowerCase()
  if (normalized === 'ultra') return null
  if (normalized === 'premium') return MONTHLY_MESSAGE_LIMITS.premium
  if (normalized === 'plus' || normalized === 'nearby_yearly') return MONTHLY_MESSAGE_LIMITS.plus
  return MONTHLY_MESSAGE_LIMITS.plus
}

function usageRef(uid: string, periodKey: string) {
  return getDb().collection('users').doc(uid).collection('messageUsage').doc(periodKey)
}

export async function getMonthlyMessageQuota(
  uid: string,
  userData: Record<string, unknown>,
): Promise<MonthlyMessageQuota> {
  const tier = effectiveSubscriptionTier(userData)
  const limit = monthlyMessageLimitForTier(tier)
  const periodKey = currentMessageUsagePeriodKey()
  const snap = await usageRef(uid, periodKey).get()
  const sentCount = typeof snap.data()?.sentCount === 'number' ? snap.data()!.sentCount : 0

  return {
    periodKey,
    sentCount,
    limit,
    remaining: limit === null ? null : Math.max(0, limit - sentCount),
    unlimited: limit === null,
    resetsAt: nextMessageUsagePeriodStartISO(),
    tier,
  }
}

/** Atomically reserve one outbound message against the sender's monthly quota inside a transaction. */
export async function reserveMonthlyMessageWithTransaction(
  tx: Transaction,
  uid: string,
  tier: string,
): Promise<{ sentCount: number; limit: number | null; periodKey: string }> {
  const limit = monthlyMessageLimitForTier(tier)
  const periodKey = currentMessageUsagePeriodKey()

  if (limit === null) {
    return { sentCount: 0, limit: null, periodKey }
  }

  const ref = usageRef(uid, periodKey)
  const usageSnap = await tx.get(ref)
  const sentCount =
    typeof usageSnap.data()?.sentCount === 'number' ? usageSnap.data()!.sentCount : 0

  if (sentCount >= limit) {
    throw new ApiError(
      `You've used all ${limit} messages for this month. Your limit resets on the 1st (UTC). Upgrade for more monthly messages.`,
      412,
      'MONTHLY_MESSAGE_LIMIT_REACHED',
    )
  }

  tx.set(
    ref,
    {
      periodKey,
      sentCount: sentCount + 1,
      limit,
      tierAtLastSend: tier,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  )

  return { sentCount: sentCount + 1, limit, periodKey }
}
