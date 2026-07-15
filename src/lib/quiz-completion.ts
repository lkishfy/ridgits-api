import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '@/lib/firebase-admin'
import {
  hasEnoughPersonalityAnswers,
  isQuizCompleteForMatching,
  normalizeQuizProgress,
} from '@/lib/matching/quiz-normalize'

/** Server-authoritative quiz completion — clients cannot self-grant via Firestore rules. */
export async function markQuizCompleteForUser(uid: string): Promise<{ completed: boolean }> {
  const ref = getDb().collection('quizProgress').doc(uid)
  const snap = await ref.get()
  const raw = snap.data() ?? {}

  if (!isQuizCompleteForMatching(raw)) {
    const normalized = normalizeQuizProgress(raw)
    if (!hasEnoughPersonalityAnswers(normalized.answers)) {
      return { completed: false }
    }
  }

  await ref.set(
    {
      completed: true,
      eligibleForMatching: true,
      completedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  )

  await getDb().collection('users').doc(uid).set(
    {
      onboardingCompleted: true,
      quizCompletedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  )

  return { completed: true }
}
