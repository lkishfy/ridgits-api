import { readProfileLocationFields, resolveProfileLocation } from '@/lib/location/normalize'

/** Lowercase tokens that indicate the NYC metro (city, boroughs, and inner suburbs). */
const NYC_METRO_TOKENS = [
  'new york',
  'manhattan',
  'brooklyn',
  'queens',
  'bronx',
  'staten island',
  'long island',
  'long island city',
  'astoria',
  'flushing',
  'jamaica',
  'yonkers',
  'white plains',
  'new rochelle',
  'mount vernon',
  'hoboken',
  'jersey city',
  'newark',
  'westchester',
  'garden city',
  'hempstead',
  'great neck',
]

function locationHaystack(profile: Record<string, unknown>): string {
  const fields = readProfileLocationFields(profile)
  const normalized = resolveProfileLocation(profile)
  return [
    fields.location,
    fields.city,
    fields.stateCode,
    normalized?.display ?? '',
    normalized?.city ?? '',
    normalized?.stateCode ?? '',
  ]
    .join(' ')
    .toLowerCase()
}

/** True when a profile location is in the NYC metro area. */
export function isNYMetroArea(profile: Record<string, unknown>): boolean {
  const haystack = locationHaystack(profile)
  if (NYC_METRO_TOKENS.some((token) => haystack.includes(token))) return true

  const normalized = resolveProfileLocation(profile)
  const state = normalized?.stateCode ?? readProfileLocationFields(profile).stateCode
  if (state !== 'NY' && state !== 'NJ' && state !== 'CT') return false

  // Structured NYC without the literal phrase "new york" (e.g. Brooklyn, NY).
  const city = (normalized?.city ?? readProfileLocationFields(profile).city).toLowerCase()
  return NYC_METRO_TOKENS.some((token) => city === token || city.startsWith(`${token} `))
}

/** When both profiles share a metro, treat distance as 0 for matching/teaser counts. */
export function sharedMetroArea(
  profileA: Record<string, unknown>,
  profileB: Record<string, unknown>,
): boolean {
  if (isNYMetroArea(profileA) && isNYMetroArea(profileB)) return true
  return false
}
