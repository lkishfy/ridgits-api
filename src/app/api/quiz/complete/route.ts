import { NextRequest, NextResponse } from 'next/server'
import { apiErrorResponse } from '@/lib/api-errors'
import { markQuizCompleteForUser } from '@/lib/quiz-completion'
import { isNextResponse, requireRidgitsAuthAndAppCheck } from '@/lib/ridgits-auth'

export async function POST(request: NextRequest) {
  const auth = await requireRidgitsAuthAndAppCheck(request)
  if (isNextResponse(auth)) return auth

  try {
    const result = await markQuizCompleteForUser(auth.uid)
    if (!result.completed) {
      return NextResponse.json(
        { error: 'Complete the personality quiz before marking complete.', code: 'QUIZ_INCOMPLETE' },
        { status: 412 },
      )
    }
    return NextResponse.json(result)
  } catch (error) {
    const { message, status, code } = apiErrorResponse(error)
    return NextResponse.json({ error: message, code }, { status })
  }
}
