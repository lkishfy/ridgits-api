import { getDb } from '@/lib/firebase-admin'
import {
  isQuizCompleteForMatching,
  syncQuizProgressForMatching,
} from '@/lib/matching/quiz-normalize'

export type BackfillQuizCompletionOptions = {
  dryRun?: boolean
  limit?: number | null
  uid?: string | null
}

export type BackfillQuizCompletionResult = {
  dryRun: boolean
  candidates: number
  updated: number
  skipped: number
  failed: number
  candidateUids: string[]
}

async function backfillOne(
  uid: string,
  dryRun: boolean,
): Promise<'updated' | 'skipped' | 'failed'> {
  const db = getDb()
  const [quizSnap, userSnap] = await Promise.all([
    db.collection('quizProgress').doc(uid).get(),
    db.collection('users').doc(uid).get(),
  ])

  if (!quizSnap.exists) return 'skipped'

  const raw = quizSnap.data() ?? {}
  if (raw.completed === true) return 'skipped'

  const userProfile = userSnap.exists ? (userSnap.data() ?? {}) : {}
  if (!isQuizCompleteForMatching(raw, userProfile)) return 'skipped'

  if (dryRun) return 'updated'

  try {
    await syncQuizProgressForMatching(uid, raw, userProfile)
    return 'updated'
  } catch {
    return 'failed'
  }
}

export async function backfillQuizCompletion(
  options: BackfillQuizCompletionOptions = {},
): Promise<BackfillQuizCompletionResult> {
  const dryRun = options.dryRun === true
  const limit = options.limit ?? null
  const db = getDb()

  let uids: string[] = []
  if (options.uid) {
    uids = [options.uid]
  } else {
    const snap = await db.collection('quizProgress').get()
    uids = snap.docs.filter((doc) => doc.data()?.completed !== true).map((doc) => doc.id)
  }

  const candidates: string[] = []
  for (const uid of uids) {
    const quizSnap = await db.collection('quizProgress').doc(uid).get()
    if (!quizSnap.exists) continue
    const raw = quizSnap.data() ?? {}
    if (raw.completed === true) continue

    const userSnap = await db.collection('users').doc(uid).get()
    const userProfile = userSnap.exists ? (userSnap.data() ?? {}) : {}
    if (isQuizCompleteForMatching(raw, userProfile)) {
      candidates.push(uid)
    }
    if (limit != null && candidates.length >= limit) break
  }

  let updated = 0
  let skipped = 0
  let failed = 0

  for (const uid of candidates) {
    const result = await backfillOne(uid, dryRun)
    if (result === 'updated') updated += 1
    else if (result === 'failed') failed += 1
    else skipped += 1
  }

  return {
    dryRun,
    candidates: candidates.length,
    updated,
    skipped,
    failed,
    candidateUids: dryRun ? candidates : [],
  }
}
