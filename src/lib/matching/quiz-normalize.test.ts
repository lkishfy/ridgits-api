import { describe, expect, it } from 'vitest'
import {
  hasEnoughPersonalityAnswers,
  isQuizCompleteForMatching,
  QUIZ_COMPLETION_ANSWER_THRESHOLD,
} from '@/lib/matching/quiz-normalize'

function makeAnswers(count: number): Record<string, number> {
  const answers: Record<string, number> = {}
  for (let i = 0; i < count; i++) {
    answers[`sit_${String(i).padStart(3, '0')}`] = 1
  }
  return answers
}

describe('isQuizCompleteForMatching', () => {
  it('rejects eligibleForMatching without enough answers', () => {
    expect(
      isQuizCompleteForMatching({
        eligibleForMatching: true,
        questionsAnswered: 99,
        answers: makeAnswers(5),
      }),
    ).toBe(false)
  })

  it('accepts when personality answer count meets threshold', () => {
    expect(
      isQuizCompleteForMatching({
        completed: true,
        answers: makeAnswers(QUIZ_COMPLETION_ANSWER_THRESHOLD),
      }),
    ).toBe(true)
  })

  it('ignores inflated questionsAnswered when answers are insufficient', () => {
    expect(
      isQuizCompleteForMatching({
        completed: true,
        questionsAnswered: QUIZ_COMPLETION_ANSWER_THRESHOLD,
        answers: makeAnswers(10),
      }),
    ).toBe(false)
  })
})

describe('hasEnoughPersonalityAnswers', () => {
  it('excludes demographic keys from count', () => {
    const answers = {
      ...makeAnswers(QUIZ_COMPLETION_ANSWER_THRESHOLD - 1),
      demo_000: 'woman',
    }
    expect(hasEnoughPersonalityAnswers(answers)).toBe(false)
  })
})
