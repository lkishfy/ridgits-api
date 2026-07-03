import { Timestamp } from 'firebase-admin/firestore'
import { ApiError } from '@/lib/api-errors'

/** New accounts must wait this long before poking or messaging (anti-bot / anti-spam). */
export const MIN_ACCOUNT_AGE_HOURS = Number(process.env.RIDGITS_MIN_ACCOUNT_AGE_HOURS ?? 24)

function toDate(value: unknown): Date | null {
  if (!value) return null
  if (value instanceof Timestamp) return value.toDate()
  if (value instanceof Date) return value
  if (typeof value === 'object' && value !== null && 'toDate' in value) {
    const maybeDate = (value as { toDate?: () => Date }).toDate?.()
    if (maybeDate instanceof Date) return maybeDate
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : new Date(parsed)
  }
  if (typeof value === 'number') {
    const ms = value > 1_000_000_000_000 ? value : value * 1000
    const parsed = new Date(ms)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }
  return null
}

/** Reads whichever creation-date field is populated on the user doc. */
export function getAccountCreatedAt(userData: Record<string, unknown> | undefined): Date | null {
  if (!userData) return null
  return (
    toDate(userData.accountCreationDate) ??
    toDate(userData.createdAt) ??
    toDate(userData.createdAtISO) ??
    null
  )
}

export function getAccountAgeHours(userData: Record<string, unknown> | undefined): number | null {
  const createdAt = getAccountCreatedAt(userData)
  if (!createdAt) return null
  return (Date.now() - createdAt.getTime()) / (60 * 60 * 1000)
}

function formatTimeRemaining(hoursRemaining: number): string {
  if (hoursRemaining >= 1) {
    const rounded = Math.ceil(hoursRemaining)
    return `${rounded} hour${rounded === 1 ? '' : 's'}`
  }
  const minutes = Math.max(1, Math.ceil(hoursRemaining * 60))
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
}

/**
 * Blocks the very first pokes/messages from brand-new accounts. If we have no creation
 * date on file (legacy accounts predating this field), we don't penalize the user.
 */
export function requireAccountCooldownElapsed(
  userData: Record<string, unknown> | undefined,
  minHours: number = MIN_ACCOUNT_AGE_HOURS,
): void {
  const ageHours = getAccountAgeHours(userData)
  if (ageHours === null) return
  if (ageHours >= minHours) return

  const remaining = minHours - ageHours
  throw new ApiError(
    `Your account needs to be active for ${minHours} hours before you can do this. Time remaining: ${formatTimeRemaining(remaining)}.`,
    403,
    'ACCOUNT_TOO_NEW',
  )
}
