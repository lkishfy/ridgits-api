import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '@/lib/firebase-admin'
import { hasActiveSubscriptionAccess } from '@/lib/ridgits-subscription'

type PackMembershipTier = 'free' | 'premium' | 'ultra'

type PackAccessRule = {
  id: string
  requiredTier: PackMembershipTier
  answersKey: string
  resultKey: string
  completedAtKey: string
}

const SUBSCRIPTION_GATED_PACKS: PackAccessRule[] = [
  {
    id: 'situationship',
    requiredTier: 'premium',
    answersKey: 'situationshipAnswers',
    resultKey: 'situationshipResult',
    completedAtKey: 'situationshipCompletedAt',
  },
  {
    id: 'self-sabotage',
    requiredTier: 'premium',
    answersKey: 'self-sabotageAnswers',
    resultKey: 'selfSabotageResult',
    completedAtKey: 'self-sabotageCompletedAt',
  },
  {
    id: 'social-battery',
    requiredTier: 'premium',
    answersKey: 'social-batteryAnswers',
    resultKey: 'socialBatteryResult',
    completedAtKey: 'social-batteryCompletedAt',
  },
  {
    id: 'messaging',
    requiredTier: 'premium',
    answersKey: 'messagingAnswers',
    resultKey: 'messagingResult',
    completedAtKey: 'messagingCompletedAt',
  },
  {
    id: 'boundaries',
    requiredTier: 'premium',
    answersKey: 'boundariesAnswers',
    resultKey: 'boundaryResult',
    completedAtKey: 'boundariesCompletedAt',
  },
  {
    id: 'attraction',
    requiredTier: 'premium',
    answersKey: 'attractionAnswers',
    resultKey: 'attractionResult',
    completedAtKey: 'attractionCompletedAt',
  },
  {
    id: 'desire-logic',
    requiredTier: 'ultra',
    answersKey: 'desire-logicAnswers',
    resultKey: 'desireLogicResult',
    completedAtKey: 'desire-logicCompletedAt',
  },
  {
    id: 'dealbreaker-map',
    requiredTier: 'ultra',
    answersKey: 'dealbreaker-mapAnswers',
    resultKey: 'dealbreakerMapResult',
    completedAtKey: 'dealbreaker-mapCompletedAt',
  },
  {
    id: 'identity-performance',
    requiredTier: 'ultra',
    answersKey: 'identity-performanceAnswers',
    resultKey: 'identityPerformanceResult',
    completedAtKey: 'identity-performanceCompletedAt',
  },
]

const TIER_RANK: Record<PackMembershipTier, number> = {
  free: 0,
  premium: 1,
  ultra: 2,
}

function activeMembershipTier(userData: Record<string, unknown>): PackMembershipTier {
  if (!hasActiveSubscriptionAccess(userData)) return 'free'

  const tier = String(userData.subscriptionTier ?? 'free').trim().toLowerCase()
  if (tier === 'ultra') return 'ultra'
  if (tier === 'premium') return 'premium'
  return 'free'
}

function stringSet(value: unknown): Set<string> {
  return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])
}

function hasPermanentPackUnlock(userData: Record<string, unknown>, packId: string): boolean {
  const purchasedPacks = stringSet(userData.purchasedPacks)
  const unlockedPacks = stringSet(userData.unlockedPacks)
  return purchasedPacks.has(packId) || unlockedPacks.has(packId)
}

export async function purgeLockedPackQuizData(uid: string): Promise<string[]> {
  const db = getDb()
  const userRef = db.collection('users').doc(uid)
  const userSnap = await userRef.get()
  if (!userSnap.exists) return []

  const userData = userSnap.data() ?? {}
  const tier = activeMembershipTier(userData)
  const update: Record<string, FieldValue> = {}
  const purgedPackIds: string[] = []

  for (const pack of SUBSCRIPTION_GATED_PACKS) {
    if (hasPermanentPackUnlock(userData, pack.id)) continue
    if (TIER_RANK[tier] >= TIER_RANK[pack.requiredTier]) continue

    const hasSavedData =
      userData[pack.answersKey] != null ||
      userData[pack.resultKey] != null ||
      userData[pack.completedAtKey] != null

    if (!hasSavedData) continue

    update[pack.answersKey] = FieldValue.delete()
    update[pack.resultKey] = FieldValue.delete()
    update[pack.completedAtKey] = FieldValue.delete()
    purgedPackIds.push(pack.id)
  }

  if (purgedPackIds.length === 0) return []

  await userRef.set(update, { merge: true })
  console.info(
    `[pack-access] Purged subscription-gated quiz data for user ${uid}: ${purgedPackIds.join(', ')}`,
  )
  return purgedPackIds
}
