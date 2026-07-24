#!/usr/bin/env tsx
/**
 * One-time / admin backfill: recompute platformStats/community including
 * archetypeDistribution from completed quizProgress documents.
 *
 *   npx tsx scripts/reconcile-community-quiz-stats.ts
 */
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { getDb } from '../src/lib/firebase-admin'
import { assertFirebaseAdminEnv, loadEnvFile } from '../src/lib/load-env-file'

loadEnvFile('.env.local')
loadEnvFile('.env')
assertFirebaseAdminEnv()

const STATS_DOC_PATH = 'platformStats/community'

const ARCHETYPE_CANONICAL = [
  'The Deep Connector',
  'The Enthusiast',
  'The Independent Spirit',
  'The Explorer',
  'The Steady Builder',
  'The Pragmatist',
  'The Free Spirit',
  'The Well-Rounded',
] as const

const LEGACY_ARCHETYPE_NAME_MAP: Record<string, string> = {
  'The Hopeless Romantic': 'The Deep Connector',
  'The Thoughtful Partner': 'The Enthusiast',
  'The Adventure Seeker': 'The Explorer',
  'The Slow Burn': 'The Steady Builder',
  'The Practical Partner': 'The Pragmatist',
  'The Balanced One': 'The Well-Rounded',
}

function emptyArchetypeDistribution(): Record<string, number> {
  return Object.fromEntries(ARCHETYPE_CANONICAL.map((name) => [name, 0]))
}

function normalizedArchetypeName(data: Record<string, unknown> | undefined): string | null {
  if (!data) return null
  const archetype = data.archetype
  if (!archetype) return null

  let rawName = ''
  if (typeof archetype === 'string') {
    rawName = archetype
  } else if (typeof archetype === 'object' && archetype !== null) {
    const obj = archetype as Record<string, unknown>
    rawName = String(obj.name || obj.title || '')
  }
  if (!rawName) return null

  const mapped = LEGACY_ARCHETYPE_NAME_MAP[rawName] || rawName
  return (ARCHETYPE_CANONICAL as readonly string[]).includes(mapped) ? mapped : null
}

function getMonthStartDate(date = new Date()): Date {
  const monthStart = new Date(date)
  monthStart.setHours(0, 0, 0, 0)
  monthStart.setDate(1)
  return monthStart
}

function getMonthKey(date = new Date()): string {
  const monthStart = getMonthStartDate(date)
  const year = monthStart.getFullYear()
  const month = String(monthStart.getMonth() + 1).padStart(2, '0')
  return `${year}-${month}`
}

function parseActivityAt(data: Record<string, unknown> | undefined): Date | null {
  if (!data) return null
  const value = data.updatedAt || data.lastUpdated || data.completedAt
  if (!value) return null
  if (value instanceof Timestamp) return value.toDate()
  if (value instanceof Date) return value
  const parsed = new Date(String(value))
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function isQuizActivityThisMonth(data: Record<string, unknown>): boolean {
  const activityAt = parseActivityAt(data)
  if (!activityAt) return true
  return activityAt.getTime() >= getMonthStartDate().getTime()
}

async function computeArchetypeDistribution() {
  const db = getDb()
  const distribution = emptyArchetypeDistribution()
  const completedSnap = await db.collection('quizProgress').where('completed', '==', true).get()
  completedSnap.forEach((doc) => {
    const name = normalizedArchetypeName(doc.data())
    if (name) distribution[name] += 1
  })
  return distribution
}

async function backfillStatsCompletionCounted() {
  const db = getDb()
  const completedSnap = await db.collection('quizProgress').where('completed', '==', true).get()
  const batchSize = 400
  let batch = db.batch()
  let pending = 0
  let updated = 0

  for (const doc of completedSnap.docs) {
    if (doc.data()?.statsCompletionCounted === true) continue
    batch.set(doc.ref, { statsCompletionCounted: true }, { merge: true })
    pending += 1
    updated += 1
    if (pending >= batchSize) {
      await batch.commit()
      batch = db.batch()
      pending = 0
    }
  }

  if (pending > 0) {
    await batch.commit()
  }

  return updated
}

async function main() {
  const db = getDb()
  const statsRef = db.doc(STATS_DOC_PATH)

  const completedQuery = db.collection('quizProgress').where('completed', '==', true)
  const totalSnap = await completedQuery.count().get()
  const totalCompleted = totalSnap.data().count

  const monthStart = Timestamp.fromDate(getMonthStartDate())
  let completedThisMonth = 0
  try {
    const monthSnap = await db
      .collection('quizProgress')
      .where('completed', '==', true)
      .where('completedAt', '>=', monthStart)
      .count()
      .get()
    completedThisMonth = monthSnap.data().count
  } catch {
    const monthDocs = await completedQuery.get()
    monthDocs.forEach((doc) => {
      if (isQuizActivityThisMonth(doc.data())) completedThisMonth += 1
    })
  }

  const archetypeDistribution = await computeArchetypeDistribution()
  const archetypeTotal = Object.values(archetypeDistribution).reduce((sum, count) => sum + count, 0)

  const payload = {
    totalCompleted,
    completedThisMonth,
    monthKey: getMonthKey(),
    archetypeDistribution,
    updatedAt: FieldValue.serverTimestamp(),
    reconciledAt: FieldValue.serverTimestamp(),
  }

  await statsRef.set(payload, { merge: true })
  const backfilledFlags = await backfillStatsCompletionCounted()

  console.log('Reconciled platformStats/community')
  console.log(`  totalCompleted: ${totalCompleted}`)
  console.log(`  completedThisMonth: ${completedThisMonth}`)
  console.log(`  archetypeDistribution total mapped: ${archetypeTotal}`)
  console.log(`  statsCompletionCounted backfilled: ${backfilledFlags}`)
  console.log('  archetypeDistribution:', JSON.stringify(archetypeDistribution, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
