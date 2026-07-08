import { NextRequest, NextResponse } from 'next/server'
import { apiErrorResponse } from '@/lib/api-errors'
import { isNextResponse, requireRidgitsAuth } from '@/lib/ridgits-auth'
import { getDb } from '@/lib/firebase-admin'
import { isQuizCompleteForMatching } from '@/lib/matching/quiz-normalize'

export async function GET(request: NextRequest) {
  const auth = await requireRidgitsAuth(request)
  if (isNextResponse(auth)) return auth

  const userId = request.nextUrl.searchParams.get('userId')?.trim() ?? ''
  if (!userId) {
    return NextResponse.json({ error: 'userId is required' }, { status: 400 })
  }

  try {
    const db = getDb()
    const [viewerQuizSnap, viewerUserSnap] = await Promise.all([
      db.collection('quizProgress').doc(auth.uid).get(),
      db.collection('users').doc(auth.uid).get(),
    ])

    const viewerQuiz = viewerQuizSnap.data() ?? {}
    const viewerUser = viewerUserSnap.data() ?? {}
    if (!isQuizCompleteForMatching(viewerQuiz, viewerUser)) {
      return NextResponse.json(
        { error: 'Complete the Ridgits quiz to unlock social info.', code: 'QUIZ_REQUIRED' },
        { status: 403 },
      )
    }

    const targetSnap = await db.collection('users').doc(userId).get()
    if (!targetSnap.exists) {
      return NextResponse.json({ socialHandle: null, socialPlatform: null })
    }

    const socialHandle = String(targetSnap.get('socialHandle') ?? '').trim()
    const socialPlatform = String(targetSnap.get('socialPlatform') ?? '').trim().toLowerCase()
    const allowedPlatforms = new Set(['instagram', 'tiktok'])
    return NextResponse.json({
      socialHandle: socialHandle || null,
      socialPlatform: allowedPlatforms.has(socialPlatform) ? socialPlatform : null,
    })
  } catch (error) {
    const { message, status, code } = apiErrorResponse(error)
    return NextResponse.json({ error: message, code }, { status })
  }
}
