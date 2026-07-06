import { ApiError } from '@/lib/api-errors'
import { getDb } from '@/lib/firebase-admin'

export const MINIMUM_AGE_YEARS = 21
/** Lowest age users can set when filtering matches in profile preferences. */
export const MINIMUM_MATCH_AGE_YEARS = 21

export function minimumAgeErrorMessage(): string {
  return `You must be at least ${MINIMUM_AGE_YEARS} years old to use Ridgits.`
}

export function computeAge(birthYear: number, referenceDate: Date = new Date()): number {
  return referenceDate.getFullYear() - birthYear
}

export function computeAgeFromDateOfBirth(
  dob: { year: number; month?: number; day?: number },
  referenceDate: Date = new Date(),
): number {
  let age = referenceDate.getFullYear() - dob.year
  const month = (dob.month ?? 1) - 1
  const day = dob.day ?? 1
  const birthdayThisYear = new Date(referenceDate.getFullYear(), month, day)
  if (referenceDate < birthdayThisYear) age -= 1
  return age
}

export function clampMatchAgeRangeMin(raw: number | null): number | null {
  if (raw === null || Number.isNaN(raw)) return null
  return Math.max(MINIMUM_MATCH_AGE_YEARS, raw)
}

export function isValidBirthYear(birthYear: unknown): birthYear is number {
  if (typeof birthYear !== 'number' || !Number.isInteger(birthYear)) return false
  const currentYear = new Date().getFullYear()
  return birthYear >= 1900 && birthYear <= currentYear
}

/**
 * Server-side minimum-age gate. Intended for any ridgits-api route that accepts a birth year
 * (profile save, onboarding) so the API stays the source of truth even though today the
 * iOS/web clients also run this same check before submitting.
 */
export function requireAdultBirthYear(birthYear: unknown): number {
  if (!isValidBirthYear(birthYear)) {
    throw new ApiError('Please provide a valid birth year.', 400, 'INVALID_BIRTH_YEAR')
  }
  const age = computeAge(birthYear)
  if (age < MINIMUM_AGE_YEARS) {
    throw new ApiError(minimumAgeErrorMessage(), 403, 'UNDERAGE')
  }
  if (age > 120) {
    throw new ApiError('Please provide a valid birth year.', 400, 'INVALID_BIRTH_YEAR')
  }
  return age
}

function parseBirthYearFromUserData(data: Record<string, unknown> | undefined): number | null {
  if (!data) return null
  const raw = data.birthYear
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw
  if (typeof raw === 'string') {
    const parsed = Number.parseInt(raw, 10)
    return Number.isInteger(parsed) ? parsed : null
  }
  return null
}

/**
 * Requires a verified minimum-age birth year stored on `users/{uid}`.
 * Used on authenticated routes so a modified client can't skip onboarding gates.
 */
export async function requireUserBirthYearOnFile(uid: string): Promise<number> {
  const snap = await getDb().collection('users').doc(uid).get()
  if (!snap.exists) {
    throw new ApiError(
      `Please confirm your birth year to continue. ${minimumAgeErrorMessage()}`,
      403,
      'AGE_VERIFICATION_REQUIRED',
    )
  }
  const birthYear = parseBirthYearFromUserData(snap.data())
  if (birthYear === null) {
    throw new ApiError(
      `Please confirm your birth year to continue. ${minimumAgeErrorMessage()}`,
      403,
      'AGE_VERIFICATION_REQUIRED',
    )
  }
  return requireAdultBirthYear(birthYear)
}
