import { readProfileLocationFields, resolveProfileLocation } from '@/lib/location/normalize'

/** Lowercase tokens that indicate the NYC metro (city, boroughs, and inner suburbs). */
const NYC_METRO_TOKENS = [
  'new york city',
  'nyc',
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
  'nyack',
]

/** NY cities outside the NYC metro — avoid matching trailing state name "New York". */
const UPSTATE_NY_CITIES = new Set([
  'rochester',
  'buffalo',
  'albany',
  'syracuse',
  'ithaca',
  'binghamton',
  'poughkeepsie',
  'utica',
  'schenectady',
  'troy',
  'kingston',
  'watertown',
  'oswego',
  'auburn',
  'elmira',
])

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

function haystackIncludesMetroToken(haystack: string, token: string): boolean {
  if (token.includes(' ')) {
    return haystack.includes(token)
  }
  const pattern = new RegExp(`(?:^|[\\s,])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[\\s,])`)
  return pattern.test(` ${haystack} `)
}

function isStandaloneNewYork(haystack: string): boolean {
  if (!/(?:^|[,\s])new york(?:[,\s]|$)/.test(haystack)) return false
  return !/(?:^|[,\s])(?:rochester|buffalo|albany|syracuse|ithaca|binghamton)[,\s]+new york(?:[,\s]|$)/.test(
    haystack,
  )
}

/** True when a profile location is in the NYC metro area. */
export function isNYMetroArea(profile: Record<string, unknown>): boolean {
  const normalized = resolveProfileLocation(profile)
  const fields = readProfileLocationFields(profile)
  const state = (normalized?.stateCode ?? fields.stateCode).toUpperCase()
  const city = (normalized?.city ?? fields.city).toLowerCase()

  if (normalized && state === 'NY' && UPSTATE_NY_CITIES.has(city)) {
    return false
  }

  if (normalized && (state === 'NY' || state === 'NJ' || state === 'CT')) {
    if (city === 'new york' || city === 'nyc') return true
    if (NYC_METRO_TOKENS.some((token) => city === token || city.startsWith(`${token} `))) {
      return true
    }
  }

  const haystack = locationHaystack(profile)
  if (NYC_METRO_TOKENS.some((token) => haystackIncludesMetroToken(haystack, token))) {
    return true
  }

  return isStandaloneNewYork(haystack)
}

/** When both profiles share a metro, treat distance as 0 for matching/teaser counts. */
export function sharedMetroArea(
  profileA: Record<string, unknown>,
  profileB: Record<string, unknown>,
): boolean {
  if (isNYMetroArea(profileA) && isNYMetroArea(profileB)) return true
  return false
}
