import { NextResponse } from 'next/server'
import type { ZodType } from 'zod'

export function parseJsonBody<T>(schema: ZodType<T>, body: unknown): T | NextResponse {
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0]
    const detail = firstIssue?.message ?? 'Invalid request body'
    return NextResponse.json({ error: detail, code: 'INVALID_BODY' }, { status: 400 })
  }
  return parsed.data
}
