import { NextRequest, NextResponse } from 'next/server'
import { backfillQuizCompletion } from '@/lib/admin/backfill-quiz-completion'

export const maxDuration = 300

function authorize(request: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'CRON_SECRET is not configured' }, { status: 503 })
  }

  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return null
}

function readOptions(request: NextRequest) {
  const { searchParams } = request.nextUrl
  const dryRun =
    searchParams.get('dryRun') === '1' ||
    searchParams.get('dryRun') === 'true' ||
    searchParams.get('dry-run') === '1'
  const limitRaw = searchParams.get('limit')
  const limit = limitRaw ? parseInt(limitRaw, 10) : null
  const uid = searchParams.get('uid')?.trim() || null

  return {
    dryRun,
    limit: limit != null && !Number.isNaN(limit) ? limit : null,
    uid,
  }
}

export async function GET(request: NextRequest) {
  const denied = authorize(request)
  if (denied) return denied

  try {
    const result = await backfillQuizCompletion(readOptions(request))
    return NextResponse.json({ ok: true, result })
  } catch (error) {
    console.error('[admin/backfill-quiz-completion]', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Backfill failed' },
      { status: 500 },
    )
  }
}

export async function POST(request: NextRequest) {
  return GET(request)
}
