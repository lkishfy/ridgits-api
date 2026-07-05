export type NormalizedUSLocation = {
  city: string
  stateCode: string
  display: string
  geocodeQuery: string
}

export const US_STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA',
  'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM',
  'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA',
  'WV', 'WI', 'WY',
])

const US_STATE_NAME_TO_CODE: Record<string, string> = {
  alabama: 'AL',
  alaska: 'AK',
  arizona: 'AZ',
  arkansas: 'AR',
  california: 'CA',
  colorado: 'CO',
  connecticut: 'CT',
  delaware: 'DE',
  'district of columbia': 'DC',
  florida: 'FL',
  georgia: 'GA',
  hawaii: 'HI',
  idaho: 'ID',
  illinois: 'IL',
  indiana: 'IN',
  iowa: 'IA',
  kansas: 'KS',
  kentucky: 'KY',
  louisiana: 'LA',
  maine: 'ME',
  maryland: 'MD',
  massachusetts: 'MA',
  michigan: 'MI',
  minnesota: 'MN',
  mississippi: 'MS',
  missouri: 'MO',
  montana: 'MT',
  nebraska: 'NE',
  nevada: 'NV',
  'new hampshire': 'NH',
  'new jersey': 'NJ',
  'new mexico': 'NM',
  'new york': 'NY',
  'north carolina': 'NC',
  'north dakota': 'ND',
  ohio: 'OH',
  oklahoma: 'OK',
  oregon: 'OR',
  pennsylvania: 'PA',
  'rhode island': 'RI',
  'south carolina': 'SC',
  'south dakota': 'SD',
  tennessee: 'TN',
  texas: 'TX',
  utah: 'UT',
  vermont: 'VT',
  virginia: 'VA',
  washington: 'WA',
  'west virginia': 'WV',
  wisconsin: 'WI',
  wyoming: 'WY',
}

export const US_STATES = Object.entries(US_STATE_NAME_TO_CODE)
  .map(([name, code]) => ({ code, name: titleCaseWords(name) }))
  .sort((a, b) => a.name.localeCompare(b.name))

function titleCaseWords(value: string): string {
  return value
    .split(' ')
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(' ')
}

function titleCaseCity(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .map((part) => {
      if (!part) return part
      if (part.length <= 3 && part === part.toUpperCase()) return part
      return part[0]!.toUpperCase() + part.slice(1).toLowerCase()
    })
    .join(' ')
}

export function resolveStateCode(token: string): string | null {
  const trimmed = token.trim()
  if (!trimmed) return null

  if (/^[A-Za-z]{2}$/.test(trimmed)) {
    const code = trimmed.toUpperCase()
    return US_STATE_CODES.has(code) ? code : null
  }

  return US_STATE_NAME_TO_CODE[trimmed.toLowerCase()] ?? null
}

function buildNormalized(city: string, stateCode: string): NormalizedUSLocation {
  const normalizedCity = titleCaseCity(city)
  const normalizedState = stateCode.toUpperCase()
  const display = `${normalizedCity}, ${normalizedState}`
  return {
    city: normalizedCity,
    stateCode: normalizedState,
    display,
    geocodeQuery: `${display}, United States`,
  }
}

const US_COUNTRY_TOKENS = new Set([
  'usa',
  'u.s.a.',
  'u.s.a',
  'us',
  'united states',
  'united states of america',
  'america',
])

/** Bare city names that uniquely resolve to a US state when no comma/state is present. */
const STANDALONE_US_CITIES: Record<string, string> = {
  'new york': 'NY',
  'new york city': 'NY',
  nyc: 'NY',
  brooklyn: 'NY',
  manhattan: 'NY',
  queens: 'NY',
  bronx: 'NY',
  'staten island': 'NY',
  'long island': 'NY',
}

/** Strip trailing country suffixes from comma-separated location parts. */
export function stripTrailingCountryParts(parts: string[]): string[] {
  if (parts.length === 0) return parts
  const last = parts[parts.length - 1]!.trim().toLowerCase()
  if (US_COUNTRY_TOKENS.has(last)) {
    return stripTrailingCountryParts(parts.slice(0, -1))
  }
  return parts
}

function dedupeCityParts(parts: string[]): string {
  if (parts.length === 0) return ''
  if (parts.length === 1) return parts[0]!
  const first = parts[0]!.trim()
  const allSame = parts.every((part) => part.trim().toLowerCase() === first.toLowerCase())
  return allSame ? first : parts[0]!.trim()
}

export function normalizeUSLocation(
  input: string,
  structured?: { city?: string | null; stateCode?: string | null },
): NormalizedUSLocation | null {
  const structuredCity = String(structured?.city ?? '').trim()
  const structuredState = String(structured?.stateCode ?? '').trim()
  if (structuredCity && structuredState) {
    const stateCode = resolveStateCode(structuredState)
    if (!stateCode) return null
    return buildNormalized(structuredCity, stateCode)
  }

  const trimmed = input.trim()
  if (!trimmed) return null

  const commaParts = stripTrailingCountryParts(
    trimmed.split(',').map((part) => part.trim()).filter(Boolean),
  )
  if (commaParts.length >= 2) {
    const stateCode = resolveStateCode(commaParts[commaParts.length - 1]!)
    if (stateCode) {
      const city = dedupeCityParts(commaParts.slice(0, -1))
      if (city) return buildNormalized(city, stateCode)
    }
  }

  const trailingStateCode = trimmed.match(/^(.+?)[,\s]+([A-Za-z]{2})$/i)
  if (trailingStateCode) {
    const stateCode = resolveStateCode(trailingStateCode[2]!)
    if (stateCode) {
      const city = trailingStateCode[1]!.replace(/,\s*$/, '').trim()
      if (city) return buildNormalized(city, stateCode)
    }
  }

  const trailingStateName = trimmed.match(/^(.+?)[,\s]+([A-Za-z][A-Za-z\s.'-]+)$/i)
  if (trailingStateName) {
    const stateCode = resolveStateCode(trailingStateName[2]!)
    if (stateCode) {
      const city = trailingStateName[1]!.replace(/,\s*$/, '').trim()
      if (city) return buildNormalized(city, stateCode)
    }
  }

  const standaloneState = STANDALONE_US_CITIES[trimmed.toLowerCase()]
  if (standaloneState) {
    return buildNormalized(trimmed, standaloneState)
  }

  return null
}

export function readProfileLocationFields(profile: Record<string, unknown>): {
  location: string
  city: string
  stateCode: string
} {
  return {
    location: String(profile.location ?? '').trim(),
    city: String(profile.locationCity ?? '').trim(),
    stateCode: String(profile.locationStateCode ?? '').trim(),
  }
}

export function resolveProfileLocation(profile: Record<string, unknown>): NormalizedUSLocation | null {
  const fields = readProfileLocationFields(profile)
  return normalizeUSLocation(fields.location, {
    city: fields.city,
    stateCode: fields.stateCode,
  })
}

export function locationCacheKey(profile: Record<string, unknown>): string {
  const normalized = resolveProfileLocation(profile)
  if (normalized) return normalized.display
  return readProfileLocationFields(profile).location
}
