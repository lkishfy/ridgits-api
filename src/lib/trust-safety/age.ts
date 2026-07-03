import { ApiError } from '@/lib/api-errors'

export const MINIMUM_AGE_YEARS = 18

export function computeAge(birthYear: number, referenceDate: Date = new Date()): number {
  return referenceDate.getFullYear() - birthYear
}

export function isValidBirthYear(birthYear: unknown): birthYear is number {
  if (typeof birthYear !== 'number' || !Number.isInteger(birthYear)) return false
  const currentYear = new Date().getFullYear()
  return birthYear >= 1900 && birthYear <= currentYear
}

/**
 * Server-side 18+ gate. Intended for any ridgits-api route that accepts a birth year
 * (profile save, onboarding) so the API stays the source of truth even though today the
 * iOS/web clients also run this same check before submitting.
 */
export function requireAdultBirthYear(birthYear: unknown): number {
  if (!isValidBirthYear(birthYear)) {
    throw new ApiError('Please provide a valid birth year.', 400, 'INVALID_BIRTH_YEAR')
  }
  const age = computeAge(birthYear)
  if (age < MINIMUM_AGE_YEARS) {
    throw new ApiError('You must be at least 18 years old to use Ridgits.', 403, 'UNDERAGE')
  }
  if (age > 120) {
    throw new ApiError('Please provide a valid birth year.', 400, 'INVALID_BIRTH_YEAR')
  }
  return age
}
