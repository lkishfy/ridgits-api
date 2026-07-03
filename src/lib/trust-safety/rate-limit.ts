import type { NextRequest } from 'next/server'
import { FieldValue } from 'firebase-admin/firestore'
import { ApiError } from '@/lib/api-errors'
import { getDb } from '@/lib/firebase-admin'

/**
 * Fixed-window rate limiter backed by Firestore so counts are correct across Vercel's
 * stateless/multi-region serverless instances (an in-memory counter would reset on every
 * cold start and wouldn't be shared across concurrent instances).
 *
 * For coarse, pre-request IP/ASN blocking (bots, known abusive ranges, geographic rules)
 * pair this with Vercel Firewall rules — see TRUST_SAFETY.md.
 */
export interface RateLimitResult {
  allowed: boolean
  retryAfterSeconds: number
  remaining: number
  limit: number
}

function sanitizeKeyPart(value: string): string {
  return value.replace(/[/\s]+/g, '_').slice(0, 200)
}

export async function checkRateLimit(options: {
  bucket: string
  identifier: string
  limit: number
  windowSeconds: number
}): Promise<RateLimitResult> {
  const { bucket, identifier, limit, windowSeconds } = options
  const db = getDb()
  const key = `${sanitizeKeyPart(bucket)}__${sanitizeKeyPart(identifier)}`
  const ref = db.collection('rateLimits').doc(key)
  const windowMs = windowSeconds * 1000
  const now = Date.now()

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    const data = snap.exists ? (snap.data() as { windowStart?: number; count?: number }) : undefined
    const windowStart = typeof data?.windowStart === 'number' ? data.windowStart : 0
    const count = typeof data?.count === 'number' ? data.count : 0
    const windowExpired = !snap.exists || now - windowStart >= windowMs

    if (windowExpired) {
      tx.set(ref, { windowStart: now, count: 1, updatedAt: FieldValue.serverTimestamp() })
      return { allowed: true, retryAfterSeconds: 0, remaining: Math.max(0, limit - 1), limit }
    }

    if (count >= limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000))
      return { allowed: false, retryAfterSeconds, remaining: 0, limit }
    }

    tx.update(ref, { count: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() })
    return { allowed: true, retryAfterSeconds: 0, remaining: Math.max(0, limit - count - 1), limit }
  })
}

/** Throws a 429 ApiError (with `retryAfterSeconds`) when the bucket/identifier is over budget. */
export async function enforceRateLimit(options: {
  bucket: string
  identifier: string
  limit: number
  windowSeconds: number
  message?: string
}): Promise<void> {
  const result = await checkRateLimit(options)
  if (!result.allowed) {
    throw new ApiError(
      options.message ?? 'Too many requests. Please try again shortly.',
      429,
      'RATE_LIMITED',
      result.retryAfterSeconds,
    )
  }
}

export function getClientIp(request: NextRequest): string {
  const forwardedFor = request.headers.get('x-forwarded-for')
  if (forwardedFor) {
    const first = forwardedFor.split(',')[0]?.trim()
    if (first) return first
  }
  const realIp = request.headers.get('x-real-ip')
  if (realIp) return realIp.trim()
  return 'unknown'
}

/** Best-effort ASN/network signal from Vercel's edge geo headers, for logging/analytics. */
export function getClientNetworkInfo(request: NextRequest): {
  ip: string
  country: string | null
  city: string | null
} {
  return {
    ip: getClientIp(request),
    country: request.headers.get('x-vercel-ip-country'),
    city: request.headers.get('x-vercel-ip-city'),
  }
}
